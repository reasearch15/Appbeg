import 'server-only';

import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';

import { getLockedPromoCoins } from '@/lib/economy/policy';
import { planArbRechargeCompletionGrant } from '@/lib/economy/automaticRechargeBonus/grantPlan';
import { parseArbPlayerPreferenceState } from '@/lib/economy/automaticRechargeBonus/playerPreference';
import {
  isArbGlobalKillActive,
  isArbGrantsEnabled,
  isArbPlayerModeEnabled,
  isArbShadowModeEnabled,
} from '@/lib/server/automaticRechargeBonusFlags';
import {
  loadArbPublishedConfigurationWithClient,
  loadArbSettingsWithClient,
} from '@/lib/sql/authorityAutomaticBonusConfig';
import {
  ttlAfterDaysIso,
  updatePlayerBalancesInTxn,
} from '@/lib/sql/authorityGameRequestHelpers';
import { insertAuthorityLedgerEvent } from '@/lib/sql/authorityLedger';
import { insertLiveOutboxEventsBatch } from '@/lib/sql/liveOutbox';
import { buildPlayerBalanceUpdatedOutboxRows } from '@/lib/sql/playerBalanceUpdatedEvent';
import { cleanText, toIsoString } from '@/lib/sql/playerMirrorCommon';

export type ArbRechargeGrantApplyResult = {
  ran: boolean;
  duplicate: boolean;
  mode: 'shadow' | 'grant' | null;
  writeFinances: boolean;
  evaluationResult: string | null;
  bonusCoins: number;
  evaluationId: string | null;
  financialEventId: string | null;
  skipReason: string | null;
  /** Request raw patch fields to merge when marking completed. */
  requestRawPatch: Record<string, unknown>;
  coinBalanceAfter: number | null;
};

function readRawField(raw: unknown, field: string) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return (raw as Record<string, unknown>)[field];
}

function readPlayerCoin(row: Record<string, unknown>) {
  const coin = Number(row.coin);
  if (Number.isFinite(coin)) return Math.max(0, coin);
  return Math.max(0, Number(readRawField(row.raw_firestore_data, 'coin') || 0));
}

function readPromoLockedCoins(row: Record<string, unknown>) {
  const direct = Number(row.promo_locked_coins);
  if (Number.isFinite(direct)) return Math.max(0, direct);
  return getLockedPromoCoins(
    row.raw_firestore_data &&
      typeof row.raw_firestore_data === 'object' &&
      !Array.isArray(row.raw_firestore_data)
      ? (row.raw_firestore_data as Record<string, unknown>).promoLockedCoins
      : 0
  );
}

function readPlayerCash(row: Record<string, unknown>) {
  const cash = Number(row.cash);
  if (Number.isFinite(cash)) return Math.max(0, cash);
  return Math.max(0, Number(readRawField(row.raw_firestore_data, 'cash') || 0));
}

function readBonusBlockedUntilMs(row: Record<string, unknown>) {
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
  return 0;
}

async function hasGrantEvaluationForRequest(
  client: PoolClient,
  requestId: string
) {
  const result = await client.query(
    `
      SELECT evaluation_id
      FROM public.automatic_recharge_bonus_evaluations
      WHERE request_id = $1 AND mode = 'grant'
      LIMIT 1
    `,
    [requestId]
  );
  return result.rows.length > 0;
}

async function insertEvaluationInTxn(
  client: PoolClient,
  input: {
    evaluationId: string;
    mode: 'shadow' | 'grant';
    coadminUid: string;
    playerUid: string;
    requestId: string;
    rechargeAmount: number;
    configVersionId: string | null;
    configVersionNumber: number | null;
    tierId: string | null;
    bonusCalculated: number;
    eligible: boolean;
    skipReason: string | null;
    evaluationResult: string;
    evaluatedAt: string;
    rawJson: Record<string, unknown>;
  }
) {
  await client.query(
    `
      INSERT INTO public.automatic_recharge_bonus_evaluations (
        evaluation_id, mode, coadmin_uid, player_uid, request_id,
        recharge_amount, config_version_id, config_version_number, tier_id,
        bonus_calculated, eligible, skip_reason, evaluation_result,
        evaluated_at, created_at, source, raw_json
      )
      VALUES (
        $1, $2, $3, $4, $5,
        $6, NULLIF($7, ''), $8, NULLIF($9, ''),
        $10, $11, NULLIF($12, ''), $13,
        $14::timestamptz, $14::timestamptz, 'appbeg', $15::jsonb
      )
      ON CONFLICT (evaluation_id) DO NOTHING
    `,
    [
      input.evaluationId,
      input.mode,
      input.coadminUid,
      input.playerUid,
      input.requestId,
      input.rechargeAmount,
      cleanText(input.configVersionId),
      input.configVersionNumber,
      cleanText(input.tierId),
      input.bonusCalculated,
      input.eligible,
      cleanText(input.skipReason),
      input.evaluationResult,
      input.evaluatedAt,
      JSON.stringify(input.rawJson),
    ]
  );
}

/**
 * Evaluate and optionally grant Automatic Recharge Bonus inside an open txn.
 * Must be called after the deposit financial event for the same recharge.
 *
 * FROZEN PIPELINE — sole supported writer of automatic_recharge_bonus finances.
 * Callers must go through planArbRechargeCompletionGrant (via this function).
 * Do not insert ARB financial events, ledger rows, or promo-locked credits elsewhere.
 * See lib/economy/automaticRechargeBonus/grantPipeline.ts.
 *
 * Financial safety:
 * - Evaluation row is inserted before any balance/FE/ledger writes (claims unique
 *   grant-per-request slot first).
 * - After any DB mutation, errors propagate so the outer completion txn rolls back.
 * - Pre-mutation skip/config failures stay fail-soft so carer completion is not blocked.
 */
export async function applyArbOnRechargeCompleteInTxn(
  client: PoolClient,
  input: {
    playerUid: string;
    playerRow: Record<string, unknown>;
    requestId: string;
    requestRow: Record<string, unknown>;
    rechargeAmount: number;
    requestCoadminUid: string;
    taskId: string;
    actorUid: string;
    actorRole: string;
    nowIso: string;
    nowMs?: number;
  }
): Promise<ArbRechargeGrantApplyResult> {
  const empty: ArbRechargeGrantApplyResult = {
    ran: false,
    duplicate: false,
    mode: null,
    writeFinances: false,
    evaluationResult: null,
    bonusCoins: 0,
    evaluationId: null,
    financialEventId: null,
    skipReason: null,
    requestRawPatch: {},
    coinBalanceAfter: null,
  };

  /** Once true, errors must escape so the outer completion txn rolls back. */
  let dbMutated = false;

  try {
    const grantsEnabled = isArbGrantsEnabled();
    const shadowModeEnabled = isArbShadowModeEnabled();
    if (!grantsEnabled && !shadowModeEnabled) {
      return empty;
    }

    const requestRaw =
      input.requestRow.raw_firestore_data &&
      typeof input.requestRow.raw_firestore_data === 'object' &&
      !Array.isArray(input.requestRow.raw_firestore_data)
        ? (input.requestRow.raw_firestore_data as Record<string, unknown>)
        : {};

    if (requestRaw.automaticRechargeBonusApplied === true) {
      return { ...empty, duplicate: true, ran: true, mode: 'grant' };
    }

    if (await hasGrantEvaluationForRequest(client, input.requestId)) {
      return { ...empty, duplicate: true, ran: true, mode: 'grant' };
    }

    const playerCoadminUid =
      cleanText(input.playerRow.coadmin_uid) ||
      cleanText(input.playerRow.created_by) ||
      cleanText(input.requestCoadminUid);
    if (!playerCoadminUid) {
      return { ...empty, skipReason: 'invalid_request' };
    }

    const settings = await loadArbSettingsWithClient(client, playerCoadminUid);
    const published = await loadArbPublishedConfigurationWithClient(client, {
      coadminUid: playerCoadminUid,
    });

    const nowMs = input.nowMs ?? Date.now();
    const riskBlocked = readBonusBlockedUntilMs(input.playerRow) > nowMs;

    const plan = planArbRechargeCompletionGrant({
      preference: parseArbPlayerPreferenceState(input.playerRow.raw_firestore_data),
      gates: {
        playerModeEnabled: isArbPlayerModeEnabled(),
        globalKillActive: isArbGlobalKillActive(),
        featureEnabled: settings?.operational.featureEnabled === true,
        emergencyDisable: settings?.operational.emergencyDisable === true,
        playerOptInAllowed: settings
          ? settings.operational.playerOptInAllowed !== false
          : false,
        riskBlocked,
        hasPublishedConfiguration: Boolean(published?.versionId),
      },
      published,
      rechargeAmount: input.rechargeAmount,
      nowMs,
      grantsEnabled,
      shadowModeEnabled,
    });

    if (!plan.run) {
      return empty;
    }

    const evaluationId = randomUUID();
    const financialEventId = plan.writeFinances ? randomUUID() : null;
    let coinBalanceAfter: number | null = null;
    const requestRawPatch: Record<string, unknown> = {};

    // Claim the grant-evaluation slot BEFORE any balance writes.
    try {
      await insertEvaluationInTxn(client, {
        evaluationId,
        mode: plan.mode,
        coadminUid: playerCoadminUid,
        playerUid: input.playerUid,
        requestId: input.requestId,
        rechargeAmount: input.rechargeAmount,
        configVersionId: plan.versionId,
        configVersionNumber: plan.versionNumber,
        tierId: plan.tierId,
        bonusCalculated: plan.writeFinances
          ? plan.bonusCoins
          : plan.resolve.bonusCoins,
        eligible: plan.eligible,
        skipReason: plan.skipReason,
        evaluationResult: plan.evaluationResult,
        evaluatedAt: input.nowIso,
        rawJson: {
          writeFinances: plan.writeFinances,
          grantsEnabled,
          shadowModeEnabled,
          eligibilityBlockers: plan.eligibility.blockers,
          resolveSkipReason: plan.resolve.skipReason,
          financialEventId,
          taskId: input.taskId,
        },
      });
      dbMutated = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || '');
      if (
        plan.mode === 'grant' &&
        /arb_evaluations_grant_request_uidx|duplicate key/i.test(message)
      ) {
        return {
          ...empty,
          ran: true,
          duplicate: true,
          mode: 'grant',
        };
      }
      throw error;
    }

    if (plan.writeFinances && plan.bonusCoins > 0) {
      const currentCoin = readPlayerCoin(input.playerRow);
      const currentLocked = readPromoLockedCoins(input.playerRow);
      const newCoin = currentCoin + plan.bonusCoins;
      const newLocked = currentLocked + plan.bonusCoins;
      coinBalanceAfter = newCoin;

      await updatePlayerBalancesInTxn(client, input.playerUid, {
        coin: newCoin,
        promoLockedCoins: newLocked,
        rawPatch: {
          automaticRechargeBonusLastGrantedAt: input.nowIso,
          automaticRechargeBonusLastRequestId: input.requestId,
          automaticRechargeBonusLastAmount: plan.bonusCoins,
        },
      });

      // Keep in-memory row consistent for any later reads in this txn.
      input.playerRow.coin = newCoin;
      input.playerRow.promo_locked_coins = newLocked;

      const feRaw = {
        playerUid: input.playerUid,
        coadminUid: playerCoadminUid,
        amountNpr: plan.bonusCoins,
        type: 'automatic_recharge_bonus',
        requestId: input.requestId,
        configVersionId: plan.versionId,
        configVersionNumber: plan.versionNumber,
        tierId: plan.tierId,
        createdAt: input.nowIso,
        ttlExpiresAt: ttlAfterDaysIso(90),
      };

      await client.query(
        `
          INSERT INTO public.financial_events_cache (
            firebase_id, player_uid, coadmin_uid, type, amount_npr, request_id,
            before_coin, after_coin,
            created_at, updated_at, ttl_expires_at, source, mirrored_at, deleted_at, raw_firestore_data
          )
          VALUES (
            $1, $2, $3, 'automatic_recharge_bonus', $4, $5,
            $6, $7,
            $8::timestamptz, $8::timestamptz, $9::timestamptz, 'authority_arb_grant', now(), NULL, $10::jsonb
          )
          ON CONFLICT (firebase_id) DO NOTHING
        `,
        [
          financialEventId,
          input.playerUid,
          playerCoadminUid,
          plan.bonusCoins,
          input.requestId,
          currentCoin,
          newCoin,
          input.nowIso,
          ttlAfterDaysIso(90),
          JSON.stringify(feRaw),
        ]
      );

      await insertAuthorityLedgerEvent(client, {
        eventKey: `financialEvents:${financialEventId}:${input.playerUid}:coin:automatic_recharge_bonus_coin_credit`,
        userUid: input.playerUid,
        username: cleanText(input.playerRow.username) || 'Player',
        role: 'player',
        coadminUid: playerCoadminUid,
        balanceType: 'coin',
        direction: 'credit',
        delta: plan.bonusCoins,
        absoluteAfter: newCoin,
        eventType: 'automatic_recharge_bonus_coin_credit',
        sourceCollection: 'financialEvents',
        sourceId: financialEventId || evaluationId,
        actorUid: input.actorUid,
        actorRole: input.actorRole,
        confidence: 'high',
        sourceCreatedAt: input.nowIso,
        rawSourceData: feRaw,
        sourceFields: {
          bonusCoins: plan.bonusCoins,
          requestId: input.requestId,
          tierId: plan.tierId,
          configVersionId: plan.versionId,
        },
      });

      await insertAuthorityLedgerEvent(client, {
        eventKey: `financialEvents:${financialEventId}:${input.playerUid}:promoLockedCoins:automatic_recharge_bonus_promo_locked_credit`,
        userUid: input.playerUid,
        username: cleanText(input.playerRow.username) || 'Player',
        role: 'player',
        coadminUid: playerCoadminUid,
        balanceType: 'promoLockedCoins',
        direction: 'credit',
        delta: plan.bonusCoins,
        absoluteAfter: newLocked,
        eventType: 'automatic_recharge_bonus_promo_locked_credit',
        sourceCollection: 'financialEvents',
        sourceId: financialEventId || evaluationId,
        actorUid: input.actorUid,
        actorRole: input.actorRole,
        confidence: 'high',
        sourceCreatedAt: input.nowIso,
        rawSourceData: feRaw,
        sourceFields: {
          bonusCoins: plan.bonusCoins,
          requestId: input.requestId,
          tierId: plan.tierId,
          configVersionId: plan.versionId,
        },
      });

      const outboxRows = buildPlayerBalanceUpdatedOutboxRows({
        playerUid: input.playerUid,
        cashBalance: readPlayerCash(input.playerRow),
        coinBalance: newCoin,
        reason: 'automatic_recharge_bonus_granted',
        taskId: input.taskId,
        requestId: input.requestId,
        eventId: financialEventId || evaluationId,
        occurredAt: input.nowIso,
        source: 'authority_arb_grant',
      });
      if (outboxRows.length) {
        await insertLiveOutboxEventsBatch(client, outboxRows);
      }

      requestRawPatch.automaticRechargeBonusApplied = true;
      requestRawPatch.automaticRechargeBonusAmount = plan.bonusCoins;
      requestRawPatch.automaticRechargeBonusEvaluationId = evaluationId;
      requestRawPatch.automaticRechargeBonusConfigVersionId = plan.versionId;
      requestRawPatch.automaticRechargeBonusTierId = plan.tierId;
      requestRawPatch.automaticRechargeBonusGrantedAt = input.nowIso;
    }

    return {
      ran: true,
      duplicate: false,
      mode: plan.mode,
      writeFinances: plan.writeFinances,
      evaluationResult: plan.evaluationResult,
      bonusCoins: plan.writeFinances ? plan.bonusCoins : 0,
      evaluationId,
      financialEventId,
      skipReason: plan.skipReason,
      requestRawPatch,
      coinBalanceAfter,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || '');
    if (/arb_evaluations_grant_request_uidx|duplicate key/i.test(message)) {
      return {
        ...empty,
        ran: true,
        duplicate: true,
        mode: 'grant',
      };
    }

    console.error('[ARB_GRANT_APPLY_FAILED]', {
      requestId: input.requestId,
      playerUid: input.playerUid,
      error,
    });

    // Never commit a partial grant: after DB mutation, force outer txn rollback.
    if (dbMutated) {
      throw error;
    }

    return { ...empty, skipReason: 'evaluation_error' };
  }
}
