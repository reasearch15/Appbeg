import 'server-only';

import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';

import {
  evaluateArbEligibility,
  type ArbEligibilityDecision,
} from '@/lib/economy/automaticRechargeBonus/eligibility';
import {
  parseArbPlayerPreferenceState,
  planArbPlayerPreferenceToggle,
  resolveCooldownDurationMinutes,
  serializeArbPlayerPreferenceRawPatch,
  type ArbPlayerPreferenceState,
  type ArbPlayerToggleErrorCode,
} from '@/lib/economy/automaticRechargeBonus/playerPreference';
import {
  isArbGlobalKillActive,
  isArbGrantsEnabled,
  isArbPlayerModeEnabled,
} from '@/lib/server/automaticRechargeBonusFlags';
import { invalidateSessionMePlayerExtras } from '@/lib/server/sessionMeExtras';
import {
  claimAuthorityOperation,
  logAuthPayloadPreTxnRemoved,
  readAuthorityOperationPayloadWithClient,
} from '@/lib/sql/authorityLedger';
import {
  loadArbPublishedConfigurationInSql,
  loadArbSettingsInSql,
} from '@/lib/sql/authorityAutomaticBonusConfig';
import { updatePlayerBalancesInTxn } from '@/lib/sql/authorityGameRequestHelpers';
import {
  cleanText,
  getPlayerMirrorPool,
  toIsoString,
} from '@/lib/sql/playerMirrorCommon';

export type ArbPlayerPreferenceSnapshot = {
  playerUid: string;
  coadminUid: string;
  preference: ArbPlayerPreferenceState;
  mode: ArbEligibilityDecision['currentMode'];
  /** @deprecated Prefer eligibility.canEnable — kept for Phase 4 clients. */
  availability: {
    available: boolean;
    blockers: ArbPlayerToggleErrorCode[];
  };
  /** Authoritative multi-capability decision (Phase 4+). */
  eligibility: Pick<
    ArbEligibilityDecision,
    | 'canEnable'
    | 'canDisable'
    | 'canClaimBonusEvent'
    | 'canReceiveAutoBonus'
    | 'currentMode'
    | 'blockers'
  >;
  cooldownDurationMinutes: number;
  gates: {
    playerModeEnabled: boolean;
    globalKillActive: boolean;
    featureEnabled: boolean;
    emergencyDisable: boolean;
    playerOptInAllowed: boolean;
    riskBlocked: boolean;
    hasPublishedConfiguration: boolean;
    riskBlockedUntil: string | null;
  };
};

export type ArbPlayerToggleResult = {
  success: true;
  duplicate: boolean;
  changed: boolean;
  transition: 'on_to_off' | 'off_to_on' | null;
  startedCooldown: boolean;
  cancelledCooldown: boolean;
  snapshot: ArbPlayerPreferenceSnapshot;
};

export class ArbPlayerToggleError extends Error {
  code: ArbPlayerToggleErrorCode;
  blockers: ArbPlayerToggleErrorCode[];

  constructor(
    code: ArbPlayerToggleErrorCode,
    message: string,
    blockers: ArbPlayerToggleErrorCode[] = [code]
  ) {
    super(message);
    this.name = 'ArbPlayerToggleError';
    this.code = code;
    this.blockers = blockers;
  }
}

function readRawField(raw: unknown, field: string) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return (raw as Record<string, unknown>)[field];
}

function readBonusBlockedUntilMs(row: Record<string, unknown>, nowMs: number) {
  const direct = toIsoString(row.bonus_blocked_until);
  if (direct) {
    const ms = Date.parse(direct);
    return Number.isFinite(ms) ? ms : 0;
  }
  const raw = readRawField(row.raw_firestore_data, 'bonusBlockedUntil');
  if (!raw) return 0;
  if (typeof raw === 'string') return Date.parse(raw) || 0;
  if (typeof raw === 'object' && raw) {
    const maybe = raw as { toMillis?: () => number; seconds?: number };
    if (typeof maybe.toMillis === 'function') return maybe.toMillis() || 0;
    if (typeof maybe.seconds === 'number') return maybe.seconds * 1000;
  }
  // unused nowMs keeps signature stable for tests
  void nowMs;
  return 0;
}

async function loadPlayerRowForUpdate(client: PoolClient, playerUid: string) {
  const result = await client.query<Record<string, unknown>>(
    `
      SELECT
        uid,
        role,
        status,
        coadmin_uid,
        created_by,
        raw_firestore_data,
        (
          SELECT s.bonus_blocked_until
          FROM public.user_balance_snapshots_cache s
          WHERE s.firebase_id = p.uid
            AND s.deleted_at IS NULL
          LIMIT 1
        ) AS bonus_blocked_until
      FROM public.players_cache p
      WHERE p.uid = $1
        AND p.deleted_at IS NULL
      FOR UPDATE
    `,
    [playerUid]
  );
  return result.rows[0] || null;
}

async function buildSnapshotFromParts(input: {
  playerUid: string;
  coadminUid: string;
  preference: ArbPlayerPreferenceState;
  nowMs: number;
  playerRow: Record<string, unknown>;
}): Promise<ArbPlayerPreferenceSnapshot> {
  const settings = await loadArbSettingsInSql({ coadminUid: input.coadminUid });
  const published = await loadArbPublishedConfigurationInSql({
    coadminUid: input.coadminUid,
  });
  const riskBlockedUntilMs = readBonusBlockedUntilMs(input.playerRow, input.nowMs);
  const riskBlocked = riskBlockedUntilMs > input.nowMs;
  const gates = {
    playerModeEnabled: isArbPlayerModeEnabled(),
    globalKillActive: isArbGlobalKillActive(),
    featureEnabled: settings?.operational.featureEnabled === true,
    emergencyDisable: settings?.operational.emergencyDisable === true,
    playerOptInAllowed: settings
      ? settings.operational.playerOptInAllowed !== false
      : false,
    riskBlocked,
    hasPublishedConfiguration: Boolean(published?.versionId),
  };
  const decision = evaluateArbEligibility({
    preference: input.preference,
    nowMs: input.nowMs,
    gates,
    grantsEnabled: isArbGrantsEnabled(),
  });
  const cooldownDurationMinutes = resolveCooldownDurationMinutes(
    published?.policy.cooldownDurationMinutes
  );

  return {
    playerUid: input.playerUid,
    coadminUid: input.coadminUid,
    preference: decision.preference,
    mode: decision.currentMode,
    availability: {
      available: decision.canEnable,
      blockers: decision.blockers.enable as ArbPlayerToggleErrorCode[],
    },
    eligibility: {
      canEnable: decision.canEnable,
      canDisable: decision.canDisable,
      canClaimBonusEvent: decision.canClaimBonusEvent,
      canReceiveAutoBonus: decision.canReceiveAutoBonus,
      currentMode: decision.currentMode,
      blockers: decision.blockers,
    },
    cooldownDurationMinutes,
    gates: {
      ...gates,
      riskBlockedUntil:
        riskBlocked && Number.isFinite(riskBlockedUntilMs)
          ? new Date(riskBlockedUntilMs).toISOString()
          : null,
    },
  };
}

/**
 * Read current preference + operational availability (no mutation).
 */
export async function loadArbPlayerPreferenceInSql(input: {
  playerUid: string;
  nowMs?: number;
}): Promise<ArbPlayerPreferenceSnapshot> {
  const playerUid = cleanText(input.playerUid);
  if (!playerUid) {
    throw new ArbPlayerToggleError('player_not_found', 'playerUid is required.');
  }
  const nowMs = input.nowMs ?? Date.now();
  const db = getPlayerMirrorPool();
  if (!db) throw new Error('SQL authority unavailable.');

  const result = await db.query<Record<string, unknown>>(
    `
      SELECT
        uid,
        role,
        status,
        coadmin_uid,
        created_by,
        raw_firestore_data,
        (
          SELECT s.bonus_blocked_until
          FROM public.user_balance_snapshots_cache s
          WHERE s.firebase_id = p.uid
            AND s.deleted_at IS NULL
          LIMIT 1
        ) AS bonus_blocked_until
      FROM public.players_cache p
      WHERE p.uid = $1
        AND p.deleted_at IS NULL
      LIMIT 1
    `,
    [playerUid]
  );
  if (!result.rows.length) {
    throw new ArbPlayerToggleError('player_not_found', 'Player not found.');
  }
  const row = result.rows[0];
  const coadminUid =
    cleanText(row.coadmin_uid) || cleanText(row.created_by) || '';
  if (!coadminUid) {
    throw new ArbPlayerToggleError(
      'invalid_request',
      'Player has no coadmin scope.'
    );
  }
  const preference = parseArbPlayerPreferenceState(row.raw_firestore_data);
  return buildSnapshotFromParts({
    playerUid,
    coadminUid,
    preference,
    nowMs,
    playerRow: row,
  });
}

export async function setArbPlayerPreferenceInSql(input: {
  playerUid: string;
  enabled: boolean;
  actorUid?: string | null;
  actorRole?: string | null;
  idempotencyKey?: string | null;
  /** Fixed clock for tests. */
  nowMs?: number;
}): Promise<ArbPlayerToggleResult> {
  const playerUid = cleanText(input.playerUid);
  if (!playerUid) {
    throw new ArbPlayerToggleError('player_not_found', 'playerUid is required.');
  }
  if (typeof input.enabled !== 'boolean') {
    throw new ArbPlayerToggleError(
      'invalid_request',
      'enabled must be a boolean.'
    );
  }

  const idempotencyKey =
    cleanText(input.idempotencyKey) || `toggle:${input.enabled}:${randomUUID()}`;
  const operationKey = `automatic_bonus_toggle:${playerUid}:${idempotencyKey}`;
  const nowMs = input.nowMs ?? Date.now();

  logAuthPayloadPreTxnRemoved('arb_player_toggle');
  const db = getPlayerMirrorPool();
  if (!db) throw new Error('SQL authority unavailable.');

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const claim = await claimAuthorityOperation(client, {
      operationKey,
      operationType: 'arb_player_toggle',
      userUid: playerUid,
      sourceId: playerUid,
      actorUid: cleanText(input.actorUid) || playerUid,
      actorRole: cleanText(input.actorRole) || 'player',
      payload: {},
    });

    if (!claim.claimed) {
      const payload = await readAuthorityOperationPayloadWithClient(
        client,
        operationKey,
        { flowName: 'arb_player_toggle' }
      );
      await client.query('ROLLBACK');
      if (payload?.snapshot) {
        return {
          success: true,
          duplicate: true,
          changed: Boolean(payload.changed),
          transition: (payload.transition as ArbPlayerToggleResult['transition']) || null,
          startedCooldown: Boolean(payload.startedCooldown),
          cancelledCooldown: Boolean(payload.cancelledCooldown),
          snapshot: payload.snapshot as ArbPlayerPreferenceSnapshot,
        };
      }
      throw new Error('Duplicate Automatic Recharge Bonus toggle in progress.');
    }

    const row = await loadPlayerRowForUpdate(client, playerUid);
    if (!row) {
      throw new ArbPlayerToggleError('player_not_found', 'Player not found.');
    }
    if (cleanText(row.role).toLowerCase() !== 'player') {
      throw new ArbPlayerToggleError('invalid_request', 'Only players can toggle.');
    }

    const coadminUid =
      cleanText(row.coadmin_uid) || cleanText(row.created_by) || '';
    if (!coadminUid) {
      throw new ArbPlayerToggleError(
        'invalid_request',
        'Player has no coadmin scope.'
      );
    }

    const current = parseArbPlayerPreferenceState(row.raw_firestore_data);

    // Platform gate: API requires player mode for any toggle mutation.
    if (!isArbPlayerModeEnabled()) {
      throw new ArbPlayerToggleError(
        'player_mode_disabled',
        'Automatic Recharge Bonus player mode is disabled.',
        ['player_mode_disabled']
      );
    }

    const settings = await loadArbSettingsInSql({ coadminUid });
    const published = await loadArbPublishedConfigurationInSql({ coadminUid });
    const riskBlockedUntilMs = readBonusBlockedUntilMs(row, nowMs);
    const riskBlocked = riskBlockedUntilMs > nowMs;
    const gates = {
      playerModeEnabled: true,
      globalKillActive: isArbGlobalKillActive(),
      featureEnabled: settings?.operational.featureEnabled === true,
      emergencyDisable: settings?.operational.emergencyDisable === true,
      playerOptInAllowed: settings
        ? settings.operational.playerOptInAllowed !== false
        : false,
      riskBlocked,
      hasPublishedConfiguration: Boolean(published?.versionId),
    };

    if (input.enabled === true) {
      const decision = evaluateArbEligibility({
        preference: current,
        nowMs,
        gates,
        grantsEnabled: isArbGrantsEnabled(),
      });
      if (!decision.canEnable) {
        const code =
          (decision.blockers.enable[0] as ArbPlayerToggleErrorCode) ||
          'invalid_request';
        throw new ArbPlayerToggleError(
          code,
          `Cannot enable Automatic Recharge Bonus (${decision.blockers.enable.join(',')}).`,
          decision.blockers.enable as ArbPlayerToggleErrorCode[]
        );
      }
    }

    const cooldownDurationMinutes = resolveCooldownDurationMinutes(
      published?.policy.cooldownDurationMinutes
    );
    const planned = planArbPlayerPreferenceToggle({
      current,
      requestedEnabled: input.enabled,
      nowMs,
      cooldownDurationMinutes,
    });

    if (planned.changed) {
      await updatePlayerBalancesInTxn(client, playerUid, {
        rawPatch: serializeArbPlayerPreferenceRawPatch(planned.next),
      });
    }

    const finalPreference = planned.changed ? planned.next : current;

    const snapshot = await buildSnapshotFromParts({
      playerUid,
      coadminUid,
      preference: finalPreference,
      nowMs,
      playerRow: row,
    });
    const result: ArbPlayerToggleResult = {
      success: true,
      duplicate: false,
      changed: planned.changed,
      transition: planned.changed ? planned.transition : null,
      startedCooldown: planned.changed ? planned.startedCooldown : false,
      cancelledCooldown: planned.changed ? planned.cancelledCooldown : false,
      snapshot,
    };

    await client.query(
      `UPDATE public.authority_operations SET payload = $2::jsonb WHERE operation_key = $1`,
      [
        operationKey,
        JSON.stringify({
          action: 'arb_player_preference_toggle',
          playerUid,
          coadminUid,
          requestedEnabled: input.enabled,
          changed: result.changed,
          transition: result.transition,
          startedCooldown: result.startedCooldown,
          cancelledCooldown: result.cancelledCooldown,
          before: current,
          after: finalPreference,
          snapshot,
          audit: {
            actorUid: cleanText(input.actorUid) || playerUid,
            actorRole: cleanText(input.actorRole) || 'player',
            at: new Date(nowMs).toISOString(),
          },
        }),
      ]
    );

    await client.query('COMMIT');
    invalidateSessionMePlayerExtras({ uid: playerUid, coadminUid });
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore
    }
    throw error;
  } finally {
    client.release();
  }
}
