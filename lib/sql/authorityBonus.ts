import 'server-only';

import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';

import {
  assertArbCanClaimBonusEvent,
  evaluateArbEligibility,
} from '@/lib/economy/automaticRechargeBonus/eligibility';
import { parseArbPlayerPreferenceState } from '@/lib/economy/automaticRechargeBonus/playerPreference';
import {
  requestLinkedCarerTaskId,
  type RequestLinkedGameCredential,
} from '@/lib/games/requestLinkedCarerTask';
import { getCoadminMaintenanceBreak } from '@/lib/maintenance/admin';
import {
  claimAuthorityOperation,
  insertAuthorityLedgerEvent,
  logAuthPayloadPreTxnRemoved,
  readAuthorityOperationPayloadWithClient,
} from '@/lib/sql/authorityLedger';
import { scheduleAutoClaimPendingTaskOnCreate } from '@/lib/sql/authorityAutoClaim';
import {
  buildGameRequestOutboxRows,
  normalizeGameName,
  ttlAfterDaysIso,
  updatePlayerBalancesInTxn,
  upsertGameRequestCacheInTxn,
  upsertLinkedCarerTaskInTxn,
} from '@/lib/sql/authorityGameRequestHelpers';
import { isBonusEventActive, type CachedBonusEvent } from '@/lib/sql/bonusEventsCache';
import {
  coadminTaskLiveChannel,
  insertLiveOutboxEventWithClient,
  insertLiveOutboxEventsBatch,
  playerRequestLiveChannel,
} from '@/lib/sql/liveOutbox';
import { readGameLoginsCacheByCoadminWithClient } from '@/lib/sql/gameLoginsCache';
import { readPlayerGameLoginsCacheByPlayerWithClient } from '@/lib/sql/playerGameLoginsCache';
import { cleanText, getPlayerMirrorPool, toIsoString } from '@/lib/sql/playerMirrorCommon';

export const MAX_ACTIVE_BONUS_EVENTS = 20;
const COADMIN_MIN_PERCENT = 5;
const COADMIN_MAX_PERCENT = 10;
const COADMIN_AUTO_BONUS_PERCENT_MIN = 5;
const COADMIN_AUTO_BONUS_PERCENT_MAX = 30;
const COADMIN_MIN_AMOUNT = 10;
const COADMIN_MAX_AMOUNT = 50;
const BONUS_ENSURE_LEASE_MS = 15_000;
const BONUS_ENSURE_COOLDOWN_MS = 20_000;
const BONUS_ENSURE_STATE_CACHE_MS = 45_000;
const UPDATE_BATCH_SIZE = 2;
const UPDATE_DELAY_MS = 1500;
const RANGE_LEASE_MS = 60_000;

const AUTO_BONUS_NAMES = [
  'Friday Fever',
  'Lucky Streak',
  'High Roller Rush',
  'Hotshot Bonus',
  'Dollar Dash',
  'Jackpot Sprint',
  'Neon Nights Bonus',
  'Power Play Bonus',
  'Golden Ticket Drop',
  'Vegas Vibes',
  'Pocket Payday',
  'Prime Time Bonus',
  'Rocket Reward',
  'Cashwave Bonus',
  'Flash Fortune',
  'Rapid Reward',
  'Double Up Drop',
  'Crown Club Bonus',
  'Big Win Boost',
  'Main Event Bonus',
];

export function getStaffBonusMultiplier(bonusPercent: number) {
  if (bonusPercent <= 8) return 1.0;
  if (bonusPercent <= 20) return 0.5;
  if (bonusPercent <= 30) return 0.2;
  return 0;
}

function readRawField(raw: unknown, field: string) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return (raw as Record<string, unknown>)[field];
}

function readPlayerCoin(row: Record<string, unknown>) {
  const coin = Number(row.coin);
  if (Number.isFinite(coin)) return Math.max(0, coin);
  return Math.max(0, Number(readRawField(row.raw_firestore_data, 'coin') || 0));
}

function readCashBoxNpr(row: Record<string, unknown>) {
  const fromSnapshot = Number(row.cash_box_npr);
  if (Number.isFinite(fromSnapshot)) return Math.max(0, fromSnapshot);
  return Math.max(0, Number(readRawField(row.raw_firestore_data, 'cashBoxNpr') || 0));
}

function readBonusBlockedUntilMs(row: Record<string, unknown>) {
  const direct = toIsoString(row.bonus_blocked_until);
  if (direct) return Date.parse(direct);
  const raw = readRawField(row.raw_firestore_data, 'bonusBlockedUntil');
  if (!raw) return 0;
  if (typeof raw === 'string') return Date.parse(raw) || 0;
  if (typeof raw === 'object' && raw) {
    const maybe = raw as { toMillis?: () => number; seconds?: number };
    if (typeof maybe.toMillis === 'function') return maybe.toMillis();
    if (typeof maybe.seconds === 'number') return maybe.seconds * 1000;
  }
  return 0;
}

function randomInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function randomPercentInRange(min: number, max: number) {
  const safeMin = Number.isFinite(min) ? min : COADMIN_MIN_PERCENT;
  const safeMax = Number.isFinite(max) ? max : COADMIN_MAX_PERCENT;
  const low = Math.min(safeMin, safeMax);
  const high = Math.max(safeMin, safeMax);
  if (low === high) return Number(low.toFixed(2));
  const raw = Math.random() * (high - low) + low;
  return Number(raw.toFixed(2));
}

export function normalizeAutoBonusPercentRange(values: {
  minPercent?: number | null;
  maxPercent?: number | null;
}) {
  const rawMin = Number(values.minPercent);
  const rawMax = Number(values.maxPercent);
  const minPercent = Number.isFinite(rawMin) ? Math.round(rawMin) : COADMIN_MIN_PERCENT;
  const maxPercent = Number.isFinite(rawMax) ? Math.round(rawMax) : COADMIN_MAX_PERCENT;
  const boundedMin = Math.min(
    COADMIN_AUTO_BONUS_PERCENT_MAX,
    Math.max(COADMIN_AUTO_BONUS_PERCENT_MIN, minPercent)
  );
  const boundedMax = Math.min(
    COADMIN_AUTO_BONUS_PERCENT_MAX,
    Math.max(COADMIN_AUTO_BONUS_PERCENT_MIN, maxPercent)
  );
  return {
    minPercent: Math.min(boundedMin, boundedMax),
    maxPercent: Math.max(boundedMin, boundedMax),
  };
}

function duplicateKey(values: {
  bonusName: string;
  gameName: string;
  amountNpr: number;
  bonusPercentage: number;
}) {
  return [
    values.bonusName.trim().toLowerCase(),
    values.gameName.trim().toLowerCase(),
    Math.round(values.amountNpr),
    Math.round(values.bonusPercentage),
  ].join('__');
}

function pickFunnyBonusName(usedNames: Set<string>, fallbackIndex: number) {
  const shuffled = [...AUTO_BONUS_NAMES].sort(() => Math.random() - 0.5);
  for (const candidate of shuffled) {
    const key = candidate.trim().toLowerCase();
    if (!usedNames.has(key)) {
      usedNames.add(key);
      return candidate;
    }
  }
  const fallback = `${AUTO_BONUS_NAMES[fallbackIndex % AUTO_BONUS_NAMES.length]} ${fallbackIndex}`;
  usedNames.add(fallback.toLowerCase());
  return fallback;
}

function mapBonusRow(row: Record<string, unknown>): CachedBonusEvent {
  const raw = row.raw_firestore_data;
  const id = cleanText(row.firebase_id);
  const bonusPercentage = Number(
    row.bonus_percentage ?? readRawField(raw, 'bonusPercentage') ?? 0
  );
  const amountNpr = Number(row.amount_npr ?? readRawField(raw, 'amountNpr') ?? 0);
  return {
    id,
    eventId: id,
    event_id: id,
    coadminUid: cleanText(row.coadmin_uid),
    bonusName: cleanText(row.bonus_name),
    gameName: cleanText(row.game_name),
    amountNpr,
    amount: amountNpr,
    description: cleanText(row.description),
    bonusPercentage,
    bonus_percentage: bonusPercentage,
    createdByUid: cleanText(row.created_by_uid),
    created_by: cleanText(row.created_by_uid),
    createdByUsername: cleanText(row.created_by_username) || 'User',
    createdByRole: cleanText(row.created_by_role),
    creator_role: cleanText(row.created_by_role),
    status: cleanText(row.status) || 'active',
    startDate: toIsoString(row.start_date),
    endDate: toIsoString(row.end_date),
    start_date: toIsoString(row.start_date),
    end_date: toIsoString(row.end_date),
    createdAt: toIsoString(row.created_at),
    created_at: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    updated_at: toIsoString(row.updated_at),
  };
}

function buildActiveStateHash(events: CachedBonusEvent[]) {
  return events
    .map((event) =>
      [
        event.id,
        event.bonusName.trim().toLowerCase(),
        event.gameName.trim().toLowerCase(),
        Math.round(event.amountNpr),
        Math.round(event.bonusPercentage),
      ].join('__')
    )
    .join('|');
}

async function insertFinancialEventInTxn(
  client: PoolClient,
  input: {
    eventId: string;
    playerUid: string;
    coadminUid: string;
    amountNpr: number;
    type: string;
    requestId?: string;
    bonusEventId?: string;
    staffAudit?: Record<string, unknown>;
    createdAt: string;
    source: string;
  }
) {
  const raw = {
    playerUid: input.playerUid,
    coadminUid: input.coadminUid,
    amountNpr: input.amountNpr,
    type: input.type,
    requestId: input.requestId ?? null,
    bonusEventId: input.bonusEventId ?? null,
    createdAt: input.createdAt,
    ...(input.staffAudit || {}),
  };
  await client.query(
    `
      INSERT INTO public.financial_events_cache (
        firebase_id, player_uid, coadmin_uid, type, amount_npr, request_id,
        created_at, updated_at, source, mirrored_at, deleted_at, raw_firestore_data
      )
      VALUES (
        $1, $2, $3, $4, $5, NULLIF($6, ''),
        $7::timestamptz, $7::timestamptz, $8, now(), NULL, $9::jsonb
      )
      ON CONFLICT (firebase_id) DO NOTHING
    `,
    [
      input.eventId,
      input.playerUid,
      input.coadminUid,
      input.type,
      input.amountNpr,
      cleanText(input.requestId),
      input.createdAt,
      input.source,
      JSON.stringify(raw),
    ]
  );
}

async function upsertBonusEventInTxn(
  client: PoolClient,
  eventId: string,
  raw: Record<string, unknown>,
  source: string
) {
  await client.query(
    `
      INSERT INTO public.bonus_events_cache (
        firebase_id, coadmin_uid, bonus_name, game_name, amount_npr, bonus_percentage,
        description, created_by_uid, created_by_username, created_by_role, status,
        start_date, end_date, created_at, updated_at, raw_firestore_data, source,
        mirrored_at, deleted_at
      )
      VALUES (
        $1, NULLIF($2, ''), NULLIF($3, ''), NULLIF($4, ''), $5, $6,
        NULLIF($7, ''), NULLIF($8, ''), NULLIF($9, ''), NULLIF($10, ''), NULLIF($11, ''),
        $12::timestamptz, $13::timestamptz, $14::timestamptz, $15::timestamptz, $16::jsonb, $17,
        now(), NULL
      )
      ON CONFLICT (firebase_id) DO UPDATE SET
        coadmin_uid = EXCLUDED.coadmin_uid,
        bonus_name = EXCLUDED.bonus_name,
        game_name = EXCLUDED.game_name,
        amount_npr = EXCLUDED.amount_npr,
        bonus_percentage = EXCLUDED.bonus_percentage,
        description = EXCLUDED.description,
        created_by_uid = EXCLUDED.created_by_uid,
        created_by_username = EXCLUDED.created_by_username,
        created_by_role = EXCLUDED.created_by_role,
        status = EXCLUDED.status,
        start_date = EXCLUDED.start_date,
        end_date = EXCLUDED.end_date,
        created_at = COALESCE(public.bonus_events_cache.created_at, EXCLUDED.created_at),
        updated_at = EXCLUDED.updated_at,
        raw_firestore_data = EXCLUDED.raw_firestore_data,
        source = EXCLUDED.source,
        mirrored_at = now(),
        deleted_at = NULL
    `,
    [
      eventId,
      cleanText(raw.coadminUid),
      cleanText(raw.bonusName),
      cleanText(raw.gameName),
      Number(raw.amountNpr ?? raw.amount ?? 0),
      Number(raw.bonusPercentage ?? raw.bonus_percentage ?? 0),
      cleanText(raw.description),
      cleanText(raw.createdByUid ?? raw.created_by),
      cleanText(raw.createdByUsername),
      cleanText(raw.createdByRole ?? raw.creator_role),
      cleanText(raw.status) || 'active',
      toIsoString(raw.startDate ?? raw.start_date),
      toIsoString(raw.endDate ?? raw.end_date),
      toIsoString(raw.createdAt ?? raw.created_at),
      toIsoString(raw.updatedAt ?? raw.updated_at),
      JSON.stringify(raw),
      source,
    ]
  );
}

async function tombstoneBonusEventInTxn(client: PoolClient, eventId: string, source: string) {
  await client.query(
    `
      UPDATE public.bonus_events_cache
      SET deleted_at = now(), mirrored_at = now(), source = $2
      WHERE firebase_id = $1
    `,
    [eventId, source]
  );
}

async function readActiveBonusEventsInTxn(client: PoolClient, coadminUid: string) {
  const { rows } = await client.query(
    `
      SELECT *
      FROM public.bonus_events_cache
      WHERE trim(coalesce(coadmin_uid, '')) = $1
        AND deleted_at IS NULL
        AND lower(trim(coalesce(status, 'active'))) = 'active'
        AND (start_date IS NULL OR start_date <= now())
        AND (end_date IS NULL OR end_date >= now())
      ORDER BY created_at DESC NULLS LAST
      LIMIT $2
    `,
    [coadminUid, MAX_ACTIVE_BONUS_EVENTS]
  );
  return rows.map((row) => mapBonusRow(row as Record<string, unknown>));
}

async function readCoadminGameNamesInTxn(client: PoolClient, coadminUid: string) {
  const rows = await readGameLoginsCacheByCoadminWithClient(client, coadminUid);
  const names = new Set<string>();
  for (const row of rows) {
    const name = cleanText(row.gameName);
    if (name) names.add(name);
  }
  return [...names];
}

async function readAutoBonusPercentRangeInTxn(client: PoolClient, coadminUid: string) {
  const playerResult = await client.query(
    `SELECT raw_firestore_data FROM public.players_cache WHERE uid = $1 AND deleted_at IS NULL LIMIT 1`,
    [coadminUid]
  );
  if (playerResult.rows.length) {
    const raw = (playerResult.rows[0] as Record<string, unknown>).raw_firestore_data;
    return normalizeAutoBonusPercentRange({
      minPercent: Number(readRawField(raw, 'autoBonusEventMinPercent')),
      maxPercent: Number(readRawField(raw, 'autoBonusEventMaxPercent')),
    });
  }
  const settingsResult = await client.query(
    `
      SELECT raw_json
      FROM public.coadmin_bonus_settings_cache
      WHERE coadmin_uid = $1 AND deleted_at IS NULL
      LIMIT 1
    `,
    [coadminUid]
  );
  if (settingsResult.rows.length) {
    const raw = (settingsResult.rows[0] as Record<string, unknown>).raw_json;
    return normalizeAutoBonusPercentRange({
      minPercent: Number(readRawField(raw, 'minPercent')),
      maxPercent: Number(readRawField(raw, 'maxPercent')),
    });
  }
  return normalizeAutoBonusPercentRange({});
}

function readEnsureLeaseFields(raw: unknown) {
  const leaseExpiresAtMs = (() => {
    const value = readRawField(raw, 'bonusEnsureCapacityLeaseExpiresAt');
    if (!value) return 0;
    if (typeof value === 'string') return Date.parse(value) || 0;
    if (typeof value === 'object' && value) {
      const maybe = value as { toMillis?: () => number; seconds?: number };
      if (typeof maybe.toMillis === 'function') return maybe.toMillis();
      if (typeof maybe.seconds === 'number') return maybe.seconds * 1000;
    }
    return 0;
  })();
  const lastEnsuredAtMs = (() => {
    const value = readRawField(raw, 'bonusEnsureCapacityLastEnsuredAt');
    if (!value) return 0;
    if (typeof value === 'string') return Date.parse(value) || 0;
    if (typeof value === 'object' && value) {
      const maybe = value as { toMillis?: () => number; seconds?: number };
      if (typeof maybe.toMillis === 'function') return maybe.toMillis();
      if (typeof maybe.seconds === 'number') return maybe.seconds * 1000;
    }
    return 0;
  })();
  return {
    leaseId: cleanText(readRawField(raw, 'bonusEnsureCapacityLeaseId')),
    leaseExpiresAtMs,
    lastEnsuredAtMs,
    lastEnsuredStateHash: cleanText(readRawField(raw, 'bonusEnsureCapacityLastStateHash')),
    lastActiveCount: Number(readRawField(raw, 'bonusEnsureCapacityLastActiveCount') || 0),
  };
}

async function patchCoadminEnsureLeaseInTxn(
  client: PoolClient,
  coadminUid: string,
  patch: Record<string, unknown>
) {
  const nowIso = new Date().toISOString();
  await client.query(
    `
      UPDATE public.players_cache
      SET
        updated_at = $2::timestamptz,
        raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb) || $3::jsonb
      WHERE uid = $1 AND deleted_at IS NULL
    `,
    [coadminUid, nowIso, JSON.stringify(patch)]
  );
}

export type AuthorityBonusInitiatePlayInput = {
  playerUid: string;
  bonusEventId: string;
  idempotencyKey?: string | null;
};

export type AuthorityBonusInitiatePlayResult = {
  success: true;
  duplicate: boolean;
  requestId: string;
};

export async function initiateBonusPlayInSql(
  input: AuthorityBonusInitiatePlayInput
): Promise<AuthorityBonusInitiatePlayResult> {
  const playerUid = cleanText(input.playerUid);
  const bonusEventId = cleanText(input.bonusEventId);
  const idempotencyKey = cleanText(input.idempotencyKey) || bonusEventId;
  const operationKey = `bonus_event:${playerUid}:initiate_play:${idempotencyKey}`;

  logAuthPayloadPreTxnRemoved('bonus_initiate_play');
  const db = getPlayerMirrorPool();
  if (!db) throw new Error('SQL authority unavailable.');

  const requestId = randomUUID();
  const eventId = randomUUID();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const claim = await claimAuthorityOperation(client, {
      operationKey,
      operationType: 'bonus_event',
      userUid: playerUid,
      sourceId: bonusEventId,
      actorUid: playerUid,
      actorRole: 'player',
      payload: {},
    });
    if (!claim.claimed) {
      const payload = await readAuthorityOperationPayloadWithClient(client, operationKey, {
        flowName: 'bonus_initiate_play',
      });
      await client.query('ROLLBACK');
      if (payload?.requestId) {
        return {
          success: true,
          duplicate: true,
          requestId: cleanText(payload.requestId),
        };
      }
      throw new Error('Duplicate bonus play in progress.');
    }

    const bonusResult = await client.query(
      `
        SELECT *
        FROM public.bonus_events_cache
        WHERE firebase_id = $1 AND deleted_at IS NULL
        FOR UPDATE
      `,
      [bonusEventId]
    );
    if (!bonusResult.rows.length) {
      throw new Error(
        'This bonus was already claimed by another player or is no longer available.'
      );
    }
    const bonusRow = bonusResult.rows[0] as Record<string, unknown>;
    const bonus = mapBonusRow(bonusRow);
    if (!isBonusEventActive(bonus)) {
      throw new Error(
        'This bonus was already claimed by another player or is no longer available.'
      );
    }

    const playerResult = await client.query(
      `
        SELECT uid, username, role, coin, coadmin_uid, created_by, raw_firestore_data
        FROM public.players_cache
        WHERE uid = $1 AND deleted_at IS NULL
        FOR UPDATE
      `,
      [playerUid]
    );
    if (!playerResult.rows.length) throw new Error('Player profile not found.');
    const player = playerResult.rows[0] as Record<string, unknown>;
    if (cleanText(player.role).toLowerCase() !== 'player') {
      throw new Error('Only players can start bonus event play.');
    }

    const playerCoadminUid =
      cleanText(player.coadmin_uid) || cleanText(player.created_by);
    if (!playerCoadminUid) throw new Error('Player coadmin scope not found.');

    // Phase 5: mutual exclusion + risk via authoritative eligibility helper.
    const claimDecision = evaluateArbEligibility({
      preference: parseArbPlayerPreferenceState(player.raw_firestore_data),
      nowMs: Date.now(),
      gates: {
        playerModeEnabled: true,
        globalKillActive: false,
        featureEnabled: true,
        emergencyDisable: false,
        playerOptInAllowed: true,
        riskBlocked: readBonusBlockedUntilMs(player) > Date.now(),
        hasPublishedConfiguration: true,
      },
      grantsEnabled: false,
    });
    assertArbCanClaimBonusEvent(claimDecision);

    const baseAmount = Math.max(0, Number(bonus.amountNpr || 0));
    const bonusPercent = Math.max(0, Number(bonus.bonusPercentage || 0));
    if (baseAmount <= 0) throw new Error('Bonus event amount is invalid.');
    if (bonusPercent <= 0 || bonusPercent > 50) {
      throw new Error('Bonus event percentage is invalid.');
    }

    const currentCoins = readPlayerCoin(player);
    if (currentCoins < baseAmount) {
      throw new Error('Low coins: cannot initiate this bonus event.');
    }

    const coadminUid = cleanText(bonus.coadminUid);
    const gameName = cleanText(bonus.gameName);
    if (!coadminUid) throw new Error('Bonus event coadmin scope missing.');
    if (coadminUid !== playerCoadminUid) {
      throw new Error('Forbidden: bonus event is outside your coadmin scope.');
    }

    const maintenanceBreak = await getCoadminMaintenanceBreak(playerCoadminUid);
    if (maintenanceBreak.enabled) {
      throw new Error(`MAINTENANCE_BREAK:${maintenanceBreak.message}`);
    }

    const loginRows = await readPlayerGameLoginsCacheByPlayerWithClient(client, playerUid);
    const normalizedGame = normalizeGameName(gameName);
    const assignedLogin = loginRows.find(
      (row) =>
        normalizeGameName(String(row.gameName || '')) === normalizedGame &&
        String(row.gameUsername || '').trim().length > 0
    );
    const assignedGameUsername = String(assignedLogin?.gameUsername || '').trim();
    const gameRows = await readGameLoginsCacheByCoadminWithClient(client, coadminUid);
    const gameCredentialRow = gameRows.find(
      (row) => normalizeGameName(String(row.gameName || '')) === normalizedGame
    );
    const gameCredential: RequestLinkedGameCredential | null = gameCredentialRow
      ? {
          id: gameCredentialRow.id,
          gameName: gameCredentialRow.gameName,
          username: gameCredentialRow.username,
          password: gameCredentialRow.password,
          backendUrl: gameCredentialRow.backendUrl,
          frontendUrl: gameCredentialRow.frontendUrl,
          siteUrl: gameCredentialRow.siteUrl,
        }
      : null;

    const bonusAddAmount = Math.max(1, Math.round((baseAmount * bonusPercent) / 100));
    const boostedAmount = baseAmount + bonusAddAmount;
    const nowIso = new Date().toISOString();
    const newCoin = currentCoins - baseAmount;
    const playerUsername = cleanText(player.username) || 'Player';
    const createdByRole = cleanText(bonus.createdByRole).toLowerCase();
    const createdByUid = cleanText(bonus.createdByUid);
    let staffRewardAudit: Record<string, unknown> | null = null;

    if (createdByRole === 'staff' && createdByUid) {
      const staffResult = await client.query(
        `
          SELECT uid, username, raw_firestore_data
          FROM public.players_cache
          WHERE uid = $1 AND deleted_at IS NULL
          FOR UPDATE
        `,
        [createdByUid]
      );
      const staff = staffResult.rows[0] as Record<string, unknown> | undefined;
      const normalizedAmount = Math.max(1, baseAmount) / 1000;
      const amountFactor = Math.min(3.5, 0.6 + Math.log10(normalizedAmount + 1) * 2.2);
      const percentPenalty = Math.max(0.25, 1.2 - bonusPercent / 60);
      const randomVariance = 0.9 + Math.random() * 0.3;
      const rawReward = amountFactor * percentPenalty * randomVariance;
      const multiplier = getStaffBonusMultiplier(bonusPercent);
      const minReward = bonusPercent <= 8 ? 0.2 : 0;
      const reward =
        multiplier === 0 ? 0 : Number(Math.max(minReward, rawReward * multiplier).toFixed(2));
      const cashBoxBefore = staff ? readCashBoxNpr(staff) : 0;
      const cashBoxAfter = cashBoxBefore + reward;
      if (staff) {
        await updatePlayerBalancesInTxn(client, createdByUid, { cashBoxNpr: cashBoxAfter });
      }
      staffRewardAudit = {
        rewardAmountNpr: reward,
        rewardReason: 'bonus_staff_reward',
        cashBoxBefore,
        cashBoxAfter,
        cashBoxDelta: cashBoxAfter - cashBoxBefore,
        actorUid: playerUid,
        actorRole: 'player',
        sourceRequestId: requestId,
        bonusEventId,
      };
      if (reward > 0 && staff) {
        await insertAuthorityLedgerEvent(client, {
          eventKey: `financialEvents:${eventId}:${createdByUid}:cashBoxNpr:bonus_staff_cashbox_credit`,
          userUid: createdByUid,
          username: cleanText(staff.username) || 'Staff',
          role: 'staff',
          coadminUid,
          balanceType: 'cashBoxNpr',
          direction: 'credit',
          delta: reward,
          absoluteAfter: cashBoxAfter,
          eventType: 'bonus_staff_cashbox_credit',
          sourceCollection: 'financialEvents',
          sourceId: eventId,
          actorUid: playerUid,
          actorRole: 'player',
          confidence: 'high',
          sourceCreatedAt: nowIso,
          rawSourceData: staffRewardAudit,
          sourceFields: { reward, bonusEventId, requestId },
        });
      }
    }

    await updatePlayerBalancesInTxn(client, playerUid, {
      coin: newCoin,
      rawPatch: {
        activeBonusEventId: bonusEventId,
        activeBonusStaffUid: createdByRole === 'staff' ? createdByUid : null,
        activeBonusEventName: bonus.bonusName || null,
        activeBonusGameName: gameName || null,
        activeBonusAmountNpr: baseAmount,
        activeBonusPercentage: bonusPercent,
      },
    });

    const requestRaw = {
      playerUid,
      gameName,
      currentUsername: assignedGameUsername,
      gameAccountUsername: assignedGameUsername,
      amount: boostedAmount,
      baseAmount,
      bonusPercentage: bonusPercent,
      bonusEventId,
      type: 'recharge',
      status: 'pending',
      createdBy: coadminUid,
      coadminUid,
      createdAt: nowIso,
      completedAt: null,
      pokedAt: null,
      pokeMessage: null,
      coinDeductedOnRequest: true,
    };
    await upsertGameRequestCacheInTxn(client, requestId, {
      ...requestRaw,
      playerUsername,
      source: 'authority_bonus_initiate_play',
      rawFirestoreData: requestRaw,
    });
    await upsertLinkedCarerTaskInTxn(
      client,
      {
        requestId,
        coadminUid,
        type: 'recharge',
        playerUid,
        playerUsername,
        gameName,
        amount: boostedAmount,
        currentUsername: assignedGameUsername,
        gameCredential,
      },
      nowIso
    );

    await insertFinancialEventInTxn(client, {
      eventId,
      playerUid,
      coadminUid,
      amountNpr: bonusAddAmount,
      type: 'bonus',
      requestId,
      bonusEventId,
      staffAudit: staffRewardAudit || undefined,
      createdAt: nowIso,
      source: 'authority_bonus_initiate_play',
    });
    await insertAuthorityLedgerEvent(client, {
      eventKey: `playerGameRequests:${requestId}:${playerUid}:coin:bonus_play_coin_debit`,
      userUid: playerUid,
      username: playerUsername,
      role: 'player',
      coadminUid,
      balanceType: 'coin',
      direction: 'debit',
      delta: -baseAmount,
      absoluteAfter: newCoin,
      eventType: 'bonus_play_coin_debit',
      sourceCollection: 'player_game_requests_cache',
      sourceId: requestId,
      actorUid: playerUid,
      actorRole: 'player',
      confidence: 'high',
      sourceCreatedAt: nowIso,
      rawSourceData: requestRaw,
      sourceFields: { baseAmount, bonusEventId, amount: boostedAmount },
    });

    await tombstoneBonusEventInTxn(client, bonusEventId, 'authority_bonus_initiate_play');

    await insertLiveOutboxEventsBatch(
      client,
      [
        ...buildGameRequestOutboxRows({
          playerUid,
          coadminUid,
          requestId,
          type: 'recharge',
          status: 'pending',
          gameName,
          amount: boostedAmount,
          eventType: 'bonus_initiate_play',
          updatedAt: nowIso,
        }),
        {
          channel: coadminTaskLiveChannel(coadminUid),
          eventType: 'bonus_event_claimed',
          entityType: 'bonus_event',
          entityId: bonusEventId,
          source: 'authority_bonus_initiate_play',
          mirroredAt: nowIso,
          payload: { bonusEventId, requestId, playerUid, updatedAt: nowIso },
        },
        {
          channel: playerRequestLiveChannel(playerUid),
          eventType: 'balance_update',
          entityType: 'player_balance',
          entityId: playerUid,
          source: 'authority_bonus_initiate_play',
          mirroredAt: nowIso,
          payload: { playerUid, updatedAt: nowIso },
        },
      ],
      { flowName: 'bonus_initiate_play' }
    );

    await client.query(`UPDATE public.authority_operations SET payload = $2::jsonb WHERE operation_key = $1`, [
      operationKey,
      JSON.stringify({ requestId, bonusEventId, playerUid }),
    ]);
    await client.query('COMMIT');
    scheduleAutoClaimPendingTaskOnCreate({
      taskId: requestLinkedCarerTaskId(requestId),
      coadminUid,
      trigger: 'bonus_initiate_play',
    });
    return { success: true, duplicate: false, requestId };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export type AuthorityEnsureBonusCapacityInput = {
  coadminUid: string;
  callerUid: string;
  callerUsername: string;
  activeCountHint?: number | null;
};

export type AuthorityEnsureBonusCapacityResult = {
  autoCreatedCount: number;
  totalActive: number;
  skipped?: string;
  retryAfterMs?: number;
};

export async function ensureBonusCapacityInSql(
  input: AuthorityEnsureBonusCapacityInput
): Promise<AuthorityEnsureBonusCapacityResult> {
  const coadminUid = cleanText(input.coadminUid);
  const callerUid = cleanText(input.callerUid);
  if (!coadminUid) throw new Error('coadminUid is required.');

  console.info('[BONUS_ENSURE_ENTRY]', {
    source: 'ensureBonusCapacityInSql',
    coadminUid,
    activeCountHint: input.activeCountHint ?? null,
    desiredCapacity: MAX_ACTIVE_BONUS_EVENTS,
  });

  const db = getPlayerMirrorPool();
  if (!db) throw new Error('SQL authority unavailable.');

  const client = await db.connect();
  const leaseId = randomUUID();
  let markEnsured = false;
  let ensuredActiveCount: number | undefined;
  let ensuredStateHash: string | undefined;

  try {
    await client.query('BEGIN');
    const coadminResult = await client.query(
      `
        SELECT uid, raw_firestore_data
        FROM public.players_cache
        WHERE uid = $1 AND deleted_at IS NULL
        FOR UPDATE
      `,
      [coadminUid]
    );
    if (!coadminResult.rows.length) {
      throw new Error('Current user profile not found.');
    }
    const coadminRaw = (coadminResult.rows[0] as Record<string, unknown>).raw_firestore_data;
    const leaseFields = readEnsureLeaseFields(coadminRaw);
    const nowMs = Date.now();

    if (input.activeCountHint != null && input.activeCountHint >= MAX_ACTIVE_BONUS_EVENTS) {
      await client.query('ROLLBACK');
      return {
        autoCreatedCount: 0,
        totalActive: input.activeCountHint,
        skipped: 'client-full-hint',
      };
    }

    if (
      leaseFields.lastActiveCount >= MAX_ACTIVE_BONUS_EVENTS &&
      leaseFields.lastEnsuredAtMs > 0 &&
      nowMs - leaseFields.lastEnsuredAtMs < BONUS_ENSURE_STATE_CACHE_MS
    ) {
      await client.query('ROLLBACK');
      console.info('[BONUS_ENSURE_COOLDOWN_BLOCK]', {
        source: 'ensureBonusCapacityInSql',
        reason: 'server-cooldown-last-active-full',
        coadminUid,
        lastActiveCount: leaseFields.lastActiveCount,
      });
      return {
        autoCreatedCount: 0,
        totalActive: leaseFields.lastActiveCount,
        skipped: 'server-cooldown',
        retryAfterMs: Math.max(
          1_000,
          BONUS_ENSURE_STATE_CACHE_MS - (nowMs - leaseFields.lastEnsuredAtMs)
        ),
      };
    }

    if (leaseFields.leaseExpiresAtMs > nowMs) {
      await client.query('ROLLBACK');
      return {
        autoCreatedCount: 0,
        totalActive: leaseFields.lastActiveCount,
        skipped: 'locked',
        retryAfterMs: Math.max(1_000, leaseFields.leaseExpiresAtMs - nowMs),
      };
    }

    if (
      leaseFields.lastEnsuredAtMs > 0 &&
      nowMs - leaseFields.lastEnsuredAtMs < BONUS_ENSURE_COOLDOWN_MS
    ) {
      await client.query('ROLLBACK');
      console.info('[BONUS_ENSURE_COOLDOWN_BLOCK]', {
        source: 'ensureBonusCapacityInSql',
        reason: 'cooldown',
        coadminUid,
      });
      return {
        autoCreatedCount: 0,
        totalActive: leaseFields.lastActiveCount,
        skipped: 'cooldown',
        retryAfterMs: Math.max(
          1_000,
          BONUS_ENSURE_COOLDOWN_MS - (nowMs - leaseFields.lastEnsuredAtMs)
        ),
      };
    }

    const leaseExpiresIso = new Date(nowMs + BONUS_ENSURE_LEASE_MS).toISOString();
    await patchCoadminEnsureLeaseInTxn(client, coadminUid, {
      bonusEnsureCapacityLeaseId: leaseId,
      bonusEnsureCapacityLeaseExpiresAt: leaseExpiresIso,
      bonusEnsureCapacityLeaseStartedAt: new Date(nowMs).toISOString(),
    });
    await client.query('COMMIT');

    const activeEvents = await readActiveBonusEventsInTxn(client, coadminUid);
    const activeStateHash = buildActiveStateHash(activeEvents);
    const missingCapacity = Math.max(0, MAX_ACTIVE_BONUS_EVENTS - activeEvents.length);
    const expiredRowsNotInActiveSet = true;
    console.info('[BONUS_ENSURE_ACTIVE_COUNT]', {
      source: 'ensureBonusCapacityInSql',
      coadminUid,
      activeRows: activeEvents.length,
      desiredCapacity: MAX_ACTIVE_BONUS_EVENTS,
      expiredRowsNotInActiveSet,
    });
    console.info('[BONUS_ENSURE_MISSING]', {
      source: 'ensureBonusCapacityInSql',
      coadminUid,
      missingCapacity,
      desiredCapacity: MAX_ACTIVE_BONUS_EVENTS,
    });

    if (
      leaseFields.lastEnsuredStateHash &&
      leaseFields.lastEnsuredStateHash === activeStateHash &&
      leaseFields.lastEnsuredAtMs > 0 &&
      nowMs - leaseFields.lastEnsuredAtMs < BONUS_ENSURE_STATE_CACHE_MS &&
      !(activeEvents.length === 0 && missingCapacity > 0)
    ) {
      markEnsured = true;
      ensuredActiveCount = activeEvents.length;
      ensuredStateHash = activeStateHash;
      console.info('[BONUS_EVENTS_ENSURE_UNCHANGED_ACTIVE_STATE]', {
        coadminUid,
        activeCount: activeEvents.length,
      });
      console.info('[BONUS_ENSURE_EXIT]', {
        source: 'ensureBonusCapacityInSql',
        coadminUid,
        skipped: 'unchanged-active-state',
        autoCreatedCount: 0,
      });
      return {
        autoCreatedCount: 0,
        totalActive: activeEvents.length,
        skipped: 'unchanged-active-state',
      };
    }

    if (activeEvents.length === 0 && missingCapacity > 0) {
      console.info('[BONUS_EVENTS_ENSURE_EMPTY_ACTIVE_CREATE]', {
        coadminUid,
        missing: missingCapacity,
      });
    }

    if (activeEvents.length >= MAX_ACTIVE_BONUS_EVENTS) {
      markEnsured = true;
      ensuredActiveCount = activeEvents.length;
      ensuredStateHash = activeStateHash;
      return { autoCreatedCount: 0, totalActive: activeEvents.length };
    }

    await client.query('BEGIN');
    const autoBonusPercentRange = await readAutoBonusPercentRangeInTxn(client, coadminUid);
    const gameNames = await readCoadminGameNamesInTxn(client, coadminUid);
    const pickGameName = () =>
      gameNames.length > 0 ? gameNames[randomInt(0, gameNames.length - 1)] : 'Bonus Table';

    const existing = new Set(
      activeEvents.map((event) =>
        duplicateKey({
          bonusName: event.bonusName,
          gameName: event.gameName,
          amountNpr: event.amountNpr,
          bonusPercentage: event.bonusPercentage,
        })
      )
    );
    const usedNames = new Set(
      activeEvents.map((event) => event.bonusName.trim().toLowerCase())
    );

    const nowIso = new Date().toISOString();
    const endIso = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const missing = missingCapacity;
    let autoCreatedCount = 0;
    let attempts = 0;

    while (autoCreatedCount < missing && attempts < missing * 25) {
      attempts += 1;
      const amount = randomInt(COADMIN_MIN_AMOUNT, COADMIN_MAX_AMOUNT);
      const percent = randomPercentInRange(
        autoBonusPercentRange.minPercent,
        autoBonusPercentRange.maxPercent
      );
      const gameName = pickGameName();
      const bonusName = pickFunnyBonusName(usedNames, attempts);
      const key = duplicateKey({ bonusName, gameName, amountNpr: amount, bonusPercentage: percent });
      if (existing.has(key)) continue;

      const eventId = randomUUID();
      const raw = {
        eventId,
        event_id: eventId,
        coadminUid,
        bonusName,
        gameName,
        amountNpr: amount,
        amount,
        bonusPercentage: percent,
        bonus_percentage: percent,
        description: 'Auto-generated co-admin bonus event to maintain active event capacity.',
        createdByUid: callerUid,
        created_by: callerUid,
        createdByUsername: input.callerUsername || 'Coadmin',
        createdByRole: 'coadmin',
        creator_role: 'system',
        status: 'active',
        startDate: nowIso,
        endDate: endIso,
        start_date: nowIso,
        end_date: endIso,
        createdAt: nowIso,
        created_at: nowIso,
        updatedAt: nowIso,
        updated_at: nowIso,
        autoGenerated: true,
      };
      await upsertBonusEventInTxn(client, eventId, raw, 'authority_bonus_ensure_capacity');
      await insertLiveOutboxEventWithClient(client, {
        channel: coadminTaskLiveChannel(coadminUid),
        eventType: 'bonus_event_created',
        entityType: 'bonus_event',
        entityId: eventId,
        source: 'authority_bonus_ensure_capacity',
        mirroredAt: nowIso,
        payload: { eventId, coadminUid, bonusName, gameName, amount, percent },
      });
      existing.add(key);
      autoCreatedCount += 1;
    }

    markEnsured = true;
    ensuredActiveCount = activeEvents.length + autoCreatedCount;
    ensuredStateHash = autoCreatedCount > 0 ? undefined : activeStateHash;
    await client.query('COMMIT');

    if (autoCreatedCount > 0) {
      console.info('[BONUS_EVENTS_ENSURE_CREATED]', {
        coadminUid,
        autoCreatedCount,
        totalActive: activeEvents.length + autoCreatedCount,
      });
      console.info('[BONUS_ENSURE_CREATED]', {
        source: 'ensureBonusCapacityInSql',
        coadminUid,
        autoCreatedCount,
        totalActive: activeEvents.length + autoCreatedCount,
      });
    }

    console.info('[BONUS_ENSURE_EXIT]', {
      source: 'ensureBonusCapacityInSql',
      coadminUid,
      autoCreatedCount,
      totalActive: activeEvents.length + autoCreatedCount,
    });

    return {
      autoCreatedCount,
      totalActive: activeEvents.length + autoCreatedCount,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    if (markEnsured) {
      const releaseClient = await db.connect();
      try {
        await releaseClient.query('BEGIN');
        await patchCoadminEnsureLeaseInTxn(releaseClient, coadminUid, {
          bonusEnsureCapacityLeaseId: null,
          bonusEnsureCapacityLeaseExpiresAt: null,
          bonusEnsureCapacityLeaseStartedAt: null,
          bonusEnsureCapacityLastEnsuredAt: new Date().toISOString(),
          ...(typeof ensuredActiveCount === 'number'
            ? { bonusEnsureCapacityLastActiveCount: ensuredActiveCount }
            : {}),
          ...(ensuredStateHash ? { bonusEnsureCapacityLastStateHash: ensuredStateHash } : {}),
        });
        await releaseClient.query('COMMIT');
      } catch {
        await releaseClient.query('ROLLBACK');
      } finally {
        releaseClient.release();
      }
    } else {
      const releaseClient = await db.connect();
      try {
        await releaseClient.query('BEGIN');
        const snap = await releaseClient.query(
          `SELECT raw_firestore_data FROM public.players_cache WHERE uid = $1 AND deleted_at IS NULL LIMIT 1`,
          [coadminUid]
        );
        if (snap.rows.length) {
          const fields = readEnsureLeaseFields(
            (snap.rows[0] as Record<string, unknown>).raw_firestore_data
          );
          if (fields.leaseId === leaseId) {
            await patchCoadminEnsureLeaseInTxn(releaseClient, coadminUid, {
              bonusEnsureCapacityLeaseId: null,
              bonusEnsureCapacityLeaseExpiresAt: null,
              bonusEnsureCapacityLeaseStartedAt: null,
            });
          }
        }
        await releaseClient.query('COMMIT');
      } catch {
        await releaseClient.query('ROLLBACK');
      } finally {
        releaseClient.release();
      }
    }
    client.release();
  }
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export type AuthorityUpdateBonusRangeInput = {
  coadminUid: string;
  minPercent: number;
  maxPercent: number;
  idempotencyKey?: string | null;
};

export type AuthorityUpdateBonusRangeResult = {
  minPercent: number;
  maxPercent: number;
  adjustedEventCount: number;
  skipped?: string;
  retryAfterMs?: number;
  duplicate?: boolean;
};

async function upsertCoadminBonusSettingsInTxn(
  client: PoolClient,
  coadminUid: string,
  raw: Record<string, unknown>
) {
  const nowIso = new Date().toISOString();
  await client.query(
    `
      INSERT INTO public.coadmin_bonus_settings_cache (
        firebase_id, coadmin_uid, raw_json, source, created_at, updated_at, mirrored_at, deleted_at
      )
      VALUES ($1, $2, $3::jsonb, 'authority', $4::timestamptz, $4::timestamptz, now(), NULL)
      ON CONFLICT (firebase_id) DO UPDATE SET
        coadmin_uid = EXCLUDED.coadmin_uid,
        raw_json = EXCLUDED.raw_json,
        source = EXCLUDED.source,
        updated_at = EXCLUDED.updated_at,
        mirrored_at = now(),
        deleted_at = NULL
    `,
    [coadminUid, coadminUid, JSON.stringify(raw), nowIso]
  );
}

export async function updateBonusRangeInSql(
  input: AuthorityUpdateBonusRangeInput
): Promise<AuthorityUpdateBonusRangeResult> {
  const coadminUid = cleanText(input.coadminUid);
  const normalized = normalizeAutoBonusPercentRange({
    minPercent: input.minPercent,
    maxPercent: input.maxPercent,
  });
  const idempotencyKey =
    cleanText(input.idempotencyKey) || `${normalized.minPercent}-${normalized.maxPercent}`;
  const operationKey = `bonus_event:${coadminUid}:update_range:${idempotencyKey}`;

  logAuthPayloadPreTxnRemoved('bonus_update_range');
  const db = getPlayerMirrorPool();
  if (!db) throw new Error('SQL authority unavailable.');

  const client = await db.connect();
  const nowIso = new Date().toISOString();
  try {
    await client.query('BEGIN');
    const claim = await claimAuthorityOperation(client, {
      operationKey,
      operationType: 'bonus_event',
      userUid: coadminUid,
      sourceId: coadminUid,
      actorUid: coadminUid,
      actorRole: 'coadmin',
      payload: {},
    });
    if (!claim.claimed) {
      const payload = await readAuthorityOperationPayloadWithClient(client, operationKey, {
        flowName: 'bonus_update_range',
      });
      await client.query('ROLLBACK');
      if (payload?.minPercent != null) {
        return {
          minPercent: Number(payload.minPercent),
          maxPercent: Number(payload.maxPercent),
          adjustedEventCount: Number(payload.adjustedEventCount || 0),
          duplicate: true,
        };
      }
      throw new Error('Duplicate bonus range update in progress.');
    }

    const settingsResult = await client.query(
      `
        SELECT raw_json
        FROM public.coadmin_bonus_settings_cache
        WHERE firebase_id = $1 AND deleted_at IS NULL
        FOR UPDATE
      `,
      [coadminUid]
    );
    const settingsRaw =
      settingsResult.rows.length &&
      typeof (settingsResult.rows[0] as Record<string, unknown>).raw_json === 'object'
        ? ((settingsResult.rows[0] as Record<string, unknown>).raw_json as Record<string, unknown>)
        : {};
    const leaseExpiresMs = (() => {
      const value = readRawField(settingsRaw, 'rangeUpdateLeaseExpiresAt');
      if (!value) return 0;
      if (typeof value === 'string') return Date.parse(value) || 0;
      return 0;
    })();
    if (leaseExpiresMs > Date.now()) {
      await client.query('ROLLBACK');
      return {
        minPercent: normalized.minPercent,
        maxPercent: normalized.maxPercent,
        adjustedEventCount: 0,
        skipped: 'lease-active',
        retryAfterMs: Math.max(1_000, leaseExpiresMs - Date.now()),
      };
    }

    const leaseId = randomUUID();
    const settingsPatch = {
      ...settingsRaw,
      coadminUid,
      minPercent: normalized.minPercent,
      maxPercent: normalized.maxPercent,
      autoBonusEventMinPercent: normalized.minPercent,
      autoBonusEventMaxPercent: normalized.maxPercent,
      updatedAt: nowIso,
      rangeUpdateLeaseId: leaseId,
      rangeUpdateLeaseExpiresAt: new Date(Date.now() + RANGE_LEASE_MS).toISOString(),
      rangeUpdateStartedAt: nowIso,
    };
    await upsertCoadminBonusSettingsInTxn(client, coadminUid, settingsPatch);
    await client.query(
      `
        UPDATE public.players_cache
        SET
          updated_at = $2::timestamptz,
          raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb) || $3::jsonb
        WHERE uid = $1 AND deleted_at IS NULL
      `,
      [
        coadminUid,
        nowIso,
        JSON.stringify({
          autoBonusEventMinPercent: normalized.minPercent,
          autoBonusEventMaxPercent: normalized.maxPercent,
          updatedAt: nowIso,
        }),
      ]
    );
    await client.query('COMMIT');

    const activeEvents = await readActiveBonusEventsInTxn(client, coadminUid);
    const outOfRange = activeEvents.filter(
      (event) =>
        event.bonusPercentage < normalized.minPercent ||
        event.bonusPercentage > normalized.maxPercent
    );

    if (outOfRange.length === 0) {
      const doneClient = await db.connect();
      try {
        await doneClient.query('BEGIN');
        await upsertCoadminBonusSettingsInTxn(doneClient, coadminUid, {
          ...settingsPatch,
          rangeUpdateLeaseId: null,
          rangeUpdateLeaseExpiresAt: null,
          rangeUpdateStartedAt: null,
          rangeUpdateLastCompletedAt: nowIso,
        });
        await doneClient.query(
          `UPDATE public.authority_operations SET payload = $2::jsonb WHERE operation_key = $1`,
          [
            operationKey,
            JSON.stringify({
              minPercent: normalized.minPercent,
              maxPercent: normalized.maxPercent,
              adjustedEventCount: 0,
            }),
          ]
        );
        await doneClient.query('COMMIT');
      } finally {
        doneClient.release();
      }
      return {
        minPercent: normalized.minPercent,
        maxPercent: normalized.maxPercent,
        adjustedEventCount: 0,
      };
    }

    let adjustedEventCount = 0;
    for (let i = 0; i < outOfRange.length; i += UPDATE_BATCH_SIZE) {
      const batch = outOfRange.slice(i, i + UPDATE_BATCH_SIZE);
      const batchClient = await db.connect();
      try {
        await batchClient.query('BEGIN');
        for (const event of batch) {
          const nextPercent = randomPercentInRange(
            normalized.minPercent,
            normalized.maxPercent
          );
          const updatedIso = new Date().toISOString();
          const raw = {
            eventId: event.id,
            coadminUid: event.coadminUid,
            bonusName: event.bonusName,
            gameName: event.gameName,
            amountNpr: event.amountNpr,
            amount: event.amountNpr,
            bonusPercentage: nextPercent,
            bonus_percentage: nextPercent,
            description: event.description,
            createdByUid: event.createdByUid,
            createdByUsername: event.createdByUsername,
            createdByRole: event.createdByRole,
            status: event.status,
            startDate: event.startDate,
            endDate: event.endDate,
            createdAt: event.createdAt,
            updatedAt: updatedIso,
            updated_at: updatedIso,
          };
          await upsertBonusEventInTxn(
            batchClient,
            event.id,
            raw,
            'authority_bonus_update_range'
          );
        }
        await batchClient.query('COMMIT');
        adjustedEventCount += batch.length;
      } catch (error) {
        await batchClient.query('ROLLBACK');
        throw error;
      } finally {
        batchClient.release();
      }
      if (i + UPDATE_BATCH_SIZE < outOfRange.length) {
        await sleep(UPDATE_DELAY_MS);
      }
    }

    const doneClient = await db.connect();
    try {
      await doneClient.query('BEGIN');
      await upsertCoadminBonusSettingsInTxn(doneClient, coadminUid, {
        ...settingsPatch,
        rangeUpdateLeaseId: null,
        rangeUpdateLeaseExpiresAt: null,
        rangeUpdateStartedAt: null,
        rangeUpdateLastCompletedAt: new Date().toISOString(),
      });
      await doneClient.query(
        `UPDATE public.authority_operations SET payload = $2::jsonb WHERE operation_key = $1`,
        [
          operationKey,
          JSON.stringify({
            minPercent: normalized.minPercent,
            maxPercent: normalized.maxPercent,
            adjustedEventCount,
          }),
        ]
      );
      await doneClient.query('COMMIT');
    } finally {
      doneClient.release();
    }

    return {
      minPercent: normalized.minPercent,
      maxPercent: normalized.maxPercent,
      adjustedEventCount,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
