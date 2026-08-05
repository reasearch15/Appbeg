import 'server-only';

import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';

import type { RequestLinkedGameCredential } from '@/lib/games/requestLinkedCarerTask';
import { getCoadminMaintenanceBreak } from '@/lib/maintenance/admin';
import {
  claimAuthorityOperation,
  insertAuthorityLedgerEvent,
  logAuthPayloadPreTxnRemoved,
  readAuthorityOperationPayloadWithClient,
} from '@/lib/sql/authorityLedger';
import { scheduleAutoClaimPendingTaskOnCreate } from '@/lib/sql/authorityAutoClaim';
import { applyArbOnRechargeCompleteInTxn } from '@/lib/sql/authorityAutomaticBonusGrant';
import {
  normalizeGameName,
  tombstoneLinkedCarerTaskInTxn,
  ttlAfterDaysIso,
  updatePlayerBalancesInTxn,
  emitPlayerRequestOutcomeMessage,
  upsertGameRequestCacheInTxn,
  upsertLinkedCarerTaskInTxn,
  writeGameRequestOutboxInTxn,
} from '@/lib/sql/authorityGameRequestHelpers';
import {
  carerTaskLiveChannel,
  coadminTaskLiveChannel,
  insertLiveOutboxEventsBatch,
  type LiveOutboxInsertInput,
  playerRequestLiveChannel,
} from '@/lib/sql/liveOutbox';
import { cleanText, getPlayerMirrorPool, toIsoString } from '@/lib/sql/playerMirrorCommon';
import { buildPlayerBalanceUpdatedOutboxRows } from '@/lib/sql/playerBalanceUpdatedEvent';
import { RechargeSqlWaterfall } from '@/lib/server/rechargeSqlWaterfall';
import { hasFirstRechargeMatchAppliedFromSqlWithClient } from '@/lib/sql/playerGameRequestsCache';
import { invalidateSessionMePlayerExtras } from '@/lib/server/sessionMeExtras';

const MIN_REDEEM_AMOUNT = 50;
const MAX_REDEEM_AMOUNT = 350;
const PLAYER_GAME_REDEEM_MAX_PER_24H = 350;
const PLAYER_GAME_REDEEM_ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;
const FIRST_RECHARGE_MATCH_PERCENT = 50;

const DISMISSIBLE_REDEEM_STATUSES = new Set(['pending', 'poked', 'pending_review', 'in_progress']);
const DISMISSIBLE_RECHARGE_STATUSES = new Set(['pending', 'poked', 'pending_review', 'failed']);
const GAME_VAULT_MIDNIGHT_PARTY_REASON = 'game_vault_midnight_party_pending';
export const PLAYER_RECHARGE_SENT_MESSAGE = 'Recharge successfully sent.';
export const PLAYER_REDEEM_SENT_MESSAGE = 'Redeem request successfully sent.';
export const PLAYER_RECHARGE_SUCCESS_MESSAGE = 'Your game is recharged. Enjoy!';
export const PLAYER_REDEEM_SUCCESS_MESSAGE = 'You have successfully redeemed from your game.';
export const FAKE_REDEEM_REASON_CODE = 'fake_redeem';
export const PLAYER_IN_GAME_REASON_CODE = 'PLAYER_IN_GAME';
export const PLAYER_IN_GAME_MESSAGE = 'Player is currently in game.';
export const PLAYER_IN_GAME_RECHARGE_MESSAGE =
  'Recharge failed because player is currently in game. Coins have been refunded.';
export const PLAYER_IN_GAME_REDEEM_MESSAGE =
  'Redeem failed because player is currently in game. Please try again later.';
export const PLAYER_FAKE_REDEEM_DEFAULT_MESSAGE =
  'Redeem could not be completed because the game balance is lower than the requested redeem amount.';

function durationBetweenMs(start: unknown, end: unknown) {
  const startIso = toIsoString(start);
  const endIso = toIsoString(end);
  if (!startIso || !endIso) {
    return null;
  }
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return null;
  }
  return Math.max(0, endMs - startMs);
}

function logTaskLifecycleDuration(input: {
  taskId: string;
  createdAt?: unknown;
  claimedAt?: unknown;
  startedAt?: unknown;
  completedAt?: unknown;
}) {
  console.info('[TASK_LIFECYCLE_DURATION]', {
    taskId: input.taskId,
    createToClaimMs: durationBetweenMs(input.createdAt, input.claimedAt),
    claimToStartMs: durationBetweenMs(input.claimedAt, input.startedAt),
    startToCompleteMs: durationBetweenMs(input.startedAt, input.completedAt),
    totalMs: durationBetweenMs(input.createdAt, input.completedAt),
  });
}

function formatFakeRedeemAmount(value: number) {
  if (Number.isInteger(value)) {
    return String(value);
  }
  return String(value);
}

export function buildFakeRedeemPlayerMessage(input: {
  playerBalance?: number | null;
  requestedAmount?: number | null;
  rawMessage?: string | null;
}) {
  const balance = input.playerBalance;
  const requested = input.requestedAmount;
  if (
    balance != null &&
    requested != null &&
    Number.isFinite(Number(balance)) &&
    Number.isFinite(Number(requested))
  ) {
    return `Redeem could not be completed because game balance is ${formatFakeRedeemAmount(Number(balance))}, but requested redeem amount is ${formatFakeRedeemAmount(Number(requested))}.`;
  }
  const message = cleanText(input.rawMessage);
  if (!message) {
    return PLAYER_FAKE_REDEEM_DEFAULT_MESSAGE;
  }
  const lower = message.toLowerCase();
  if (lower.startsWith('redeem could not be completed')) {
    return message;
  }
  if (/^[a-z][a-z0-9_]*$/i.test(message) && message.includes('_')) {
    return PLAYER_FAKE_REDEEM_DEFAULT_MESSAGE;
  }
  return `Redeem could not be completed: ${message}`;
}

export function buildPlayerRedeemDismissMessage(rawMessage: string | null | undefined) {
  return buildFakeRedeemPlayerMessage({ rawMessage });
}

function buildAutomationMidnightPartyPlayerMessage(gameToast: string, refunded: boolean) {
  const toast = cleanText(gameToast);
  const base = toast
    ? `Recharge could not be completed: ${toast}`
    : 'Recharge could not be completed: Midnight Party is pending on Game Vault.';
  return refunded ? `${base} Your balance was refunded.` : base;
}

function readRawBoolean(raw: unknown, ...fields: string[]) {
  for (const field of fields) {
    const value = readRawField(raw, field);
    if (value === true) return true;
    if (value === false) return false;
  }
  return false;
}

export type AuthorityRechargeCreateInput = {
  playerUid: string;
  gameName: string;
  amount: number;
  baseAmount?: number | null;
  bonusPercentage?: number | null;
  bonusEventId?: string | null;
  assignedGameUsername: string;
  gameCredential: RequestLinkedGameCredential | null;
  previewCoadminUid: string;
  hasAnyFirstRechargeAppliedRequest: boolean;
  firstRechargePrechecked?: boolean;
  maintenancePrechecked?: boolean;
  idempotencyKey?: string | null;
};

export type AuthorityRechargeCreateResult = {
  success: true;
  duplicate: boolean;
  requestId: string;
};

export type AuthorityRedeemCreateInput = {
  playerUid: string;
  gameName: string;
  amount: number;
  baseAmount?: number | null;
  bonusPercentage?: number | null;
  bonusEventId?: string | null;
  assignedGameUsername: string;
  gameCredential: RequestLinkedGameCredential | null;
  idempotencyKey?: string | null;
};

export type AuthorityRedeemCreateResult = {
  success: true;
  duplicate: boolean;
  requestId: string;
};

export type AuthorityCompleteRechargeRedeemInput = {
  taskId: string;
  actorUid: string;
  actorUsername?: string | null;
  actorRole: string;
  isAdmin: boolean;
  scopeUid: string | null;
  idempotencyKey?: string | null;
};

export type AuthorityCompleteRechargeRedeemResult = {
  success: true;
  duplicate: boolean;
  alreadyCompleted: boolean;
  taskId: string;
  requestId: string;
  totalAwardNpr: number;
};

export type AuthorityDismissRechargeInput = {
  requestId: string;
  actorUid: string;
  actorRole: string;
  isAdmin: boolean;
  scopeUid: string | null;
  idempotencyKey?: string | null;
  dismissType?: string | null;
  dismissReasonCode?: string | null;
  dismissReasonMessage?: string | null;
  dismissedByAutomation?: boolean;
  pokeMessage?: string | null;
  skipTaskTombstone?: boolean;
  txnClient?: PoolClient;
};

export type AuthorityDismissRechargeResult = {
  success: true;
  duplicate: boolean;
  alreadyDismissed: boolean;
  refunded: boolean;
  refundAmount?: number;
  requestId: string;
  linkedTaskId: string;
  taskDeleted: boolean;
};

export type AuthorityDismissRedeemInput = {
  requestId: string;
  actorUid: string;
  actorRole: string;
  isAdmin: boolean;
  scopeUid: string | null;
  idempotencyKey?: string | null;
  dismissType?: string | null;
  dismissReasonCode?: string | null;
  dismissReasonMessage?: string | null;
  dismissedByAutomation?: boolean;
  pokeMessage?: string | null;
  fakeRedeem?: boolean;
  refundCashOnDismissal?: boolean;
  skipTaskTombstone?: boolean;
  txnClient?: PoolClient;
};

export type AuthorityDismissRedeemResult = {
  success: true;
  duplicate: boolean;
  alreadyDismissed: boolean;
  refunded: boolean;
  refundAmount?: number;
  requestId: string;
  linkedTaskId: string;
  taskDeleted: boolean;
};

function getNepalHour() {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kathmandu',
    hour: 'numeric',
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date());
  return Number(parts.find((part) => part.type === 'hour')?.value || '0') || 0;
}

function isNepalNightTime() {
  const hour = getNepalHour();
  return hour >= 22 || hour < 6;
}

function randomInt(min: number, max: number) {
  const safeMin = Math.min(min, max);
  const safeMax = Math.max(min, max);
  return Math.floor(Math.random() * (safeMax - safeMin + 1)) + safeMin;
}

export function calculateRechargeRedeemRewardNpr() {
  const base = isNepalNightTime() ? randomInt(22, 35) : randomInt(12, 22);
  if (!isNepalNightTime()) return base;
  const bonusPercent = randomInt(10, 15);
  return Math.round(base * (1 + bonusPercent / 100));
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

function readPlayerCash(row: Record<string, unknown>) {
  const cash = Number(row.cash);
  if (Number.isFinite(cash)) return Math.max(0, cash);
  return Math.max(0, Number(readRawField(row.raw_firestore_data, 'cash') || 0));
}

function readCashBoxNpr(snapshot: Record<string, unknown>, playerRow?: Record<string, unknown>) {
  const fromSnapshot = Number(snapshot.cash_box_npr);
  if (Number.isFinite(fromSnapshot)) return Math.max(0, fromSnapshot);
  const raw = playerRow?.raw_firestore_data ?? snapshot.raw_firestore_data;
  const fromRaw = Number(readRawField(raw, 'cashBoxNpr'));
  return Number.isFinite(fromRaw) ? Math.max(0, fromRaw) : 0;
}

function readFirstRechargeMatchUsed(row: Record<string, unknown>) {
  const raw = row.raw_firestore_data;
  if (readRawField(raw, 'firstRechargeMatchUsed') === true) return true;
  return false;
}

async function fetchRolling24hRedeemUsageForPlayerGame(
  client: PoolClient,
  playerUid: string,
  gameName: string
) {
  const normalizedGame = normalizeGameName(gameName);
  const since = new Date(Date.now() - PLAYER_GAME_REDEEM_ROLLING_WINDOW_MS).toISOString();
  const { rows } = await client.query(
    `
      SELECT amount, status, normalized_game_name
      FROM public.player_game_requests_cache
      WHERE player_uid = $1
        AND type = 'redeem'
        AND deleted_at IS NULL
        AND created_at >= $2::timestamptz
    `,
    [playerUid, since]
  );
  let total = 0;
  for (const row of rows) {
    const record = row as Record<string, unknown>;
    if (cleanText(record.normalized_game_name) !== normalizedGame) continue;
    const status = cleanText(record.status).toLowerCase();
    if (status === 'failed' || status === 'dismissed') continue;
    total += Math.max(0, Number(record.amount || 0));
  }
  return total;
}

async function insertFinancialEventInTxn(
  client: PoolClient,
  input: {
    eventId: string;
    playerUid: string;
    coadminUid: string;
    amountNpr: number;
    type: string;
    requestId: string;
    beforeCash?: number | null;
    afterCash?: number | null;
    beforeCoin?: number | null;
    afterCoin?: number | null;
    createdAt: string;
    source: string;
  }
) {
  const raw = {
    playerUid: input.playerUid,
    coadminUid: input.coadminUid,
    amountNpr: input.amountNpr,
    type: input.type,
    requestId: input.requestId,
    createdAt: input.createdAt,
    ttlExpiresAt: ttlAfterDaysIso(90),
  };
  await client.query(
    `
      INSERT INTO public.financial_events_cache (
        firebase_id, player_uid, coadmin_uid, type, amount_npr, request_id,
        before_cash, after_cash, before_coin, after_coin,
        created_at, updated_at, ttl_expires_at, source, mirrored_at, deleted_at, raw_firestore_data
      )
      VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10,
        $11::timestamptz, $11::timestamptz, $12::timestamptz, $13, now(), NULL, $14::jsonb
      )
      ON CONFLICT (firebase_id) DO NOTHING
    `,
    [
      input.eventId,
      input.playerUid,
      input.coadminUid,
      input.type,
      input.amountNpr,
      input.requestId,
      input.beforeCash ?? null,
      input.afterCash ?? null,
      input.beforeCoin ?? null,
      input.afterCoin ?? null,
      input.createdAt,
      ttlAfterDaysIso(90),
      input.source,
      JSON.stringify(raw),
    ]
  );
}

async function updateCarerTaskCompletedInTxn(
  client: PoolClient,
  taskId: string,
  input: Record<string, unknown>
) {
  const nowIso = String(input.updatedAt || new Date().toISOString());
  const raw = {
    status: 'completed',
    expiresAt: null,
    completedAt: nowIso,
    ttlExpiresAt: ttlAfterDaysIso(30),
    automationStatus: 'completed',
    automationUpdatedAt: nowIso,
    claimedStatus: 'completed',
    isPoked: false,
    pokeMessage: null,
    pokedAt: null,
    completedByCarerUid: cleanText(input.completedByCarerUid),
    completedByCarerUsername: cleanText(input.completedByCarerUsername),
    rewardAmountNpr: input.rewardAmountNpr == null ? null : Number(input.rewardAmountNpr),
    rewardReason: cleanText(input.rewardReason),
    cashBoxBefore: input.cashBoxBefore == null ? null : Number(input.cashBoxBefore),
    cashBoxAfter: input.cashBoxAfter == null ? null : Number(input.cashBoxAfter),
    cashBoxDelta: input.cashBoxDelta == null ? null : Number(input.cashBoxDelta),
    actorUid: cleanText(input.actorUid),
    actorRole: cleanText(input.actorRole),
    sourceTaskId: cleanText(input.sourceTaskId),
    sourceRequestId: cleanText(input.sourceRequestId),
    updatedAt: nowIso,
  };
  await client.query(
    `
      UPDATE public.carer_tasks_cache
      SET
        status = 'completed',
        expires_at = NULL,
        completed_at = $2::timestamptz,
        ttl_expires_at = $3::timestamptz,
        automation_status = 'completed',
        automation_updated_at = $2::timestamptz,
        claimed_status = 'completed',
        is_poked = FALSE,
        poke_message = NULL,
        completed_by_carer_uid = NULLIF($4, ''),
        completed_by_carer_username = NULLIF($5, ''),
        updated_at = $2::timestamptz,
        source = 'authority',
        mirrored_at = now(),
        raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb) || $6::jsonb
      WHERE firebase_id = $1 AND deleted_at IS NULL
    `,
    [
      taskId,
      nowIso,
      ttlAfterDaysIso(30),
      cleanText(input.completedByCarerUid),
      cleanText(input.completedByCarerUsername),
      JSON.stringify(raw),
    ]
  );
  console.info('[SQL_TASK_COMPLETED]', {
    taskId,
    completedByCarerUid: cleanText(input.completedByCarerUid) || null,
    sourceRequestId: cleanText(input.sourceRequestId) || null,
  });
}

function buildCarerTaskOutboxRows(input: {
  coadminUid: string;
  carerUid?: string | null;
  taskId: string;
  requestId: string;
  status: string;
  eventType: string;
  updatedAt: string;
  type?: string;
  playerUid?: string;
  gameName?: string;
  amount?: number | null;
  assignedCarerUid?: string | null;
  claimedByUid?: string | null;
}): { rows: LiveOutboxInsertInput[]; channels: string[] } {
  const payload: Record<string, unknown> = {
    entityId: input.taskId,
    taskId: input.taskId,
    requestId: input.requestId,
    coadminUid: input.coadminUid,
    status: input.status,
    updatedAt: input.updatedAt,
    source: 'authority',
  };
  const type = cleanText(input.type);
  if (type) {
    payload.type = type;
  }
  const playerUid = cleanText(input.playerUid);
  if (playerUid) {
    payload.playerUid = playerUid;
  }
  const gameName = cleanText(input.gameName);
  if (gameName) {
    payload.gameName = gameName;
  }
  if (input.amount !== undefined && input.amount !== null) {
    payload.amount = input.amount;
  }
  if (input.assignedCarerUid !== undefined) {
    payload.assignedCarerUid = input.assignedCarerUid;
  }
  if (input.claimedByUid !== undefined) {
    payload.claimedByUid = input.claimedByUid;
  }

  const outboxChannels = [coadminTaskLiveChannel(input.coadminUid)];
  const rows: LiveOutboxInsertInput[] = [
    {
      channel: outboxChannels[0],
      eventType: input.eventType,
      entityType: 'carer_task',
      entityId: input.taskId,
      source: 'authority_game_request',
      mirroredAt: input.updatedAt,
      payload,
    },
  ];
  const carerUid = cleanText(input.carerUid);
  if (carerUid) {
    outboxChannels.push(carerTaskLiveChannel(carerUid));
    rows.push({
      channel: carerTaskLiveChannel(carerUid),
      eventType: input.eventType,
      entityType: 'carer_task',
      entityId: input.taskId,
      source: 'authority_game_request',
      mirroredAt: input.updatedAt,
      payload,
    });
  }
  return { rows, channels: outboxChannels };
}

async function writeCarerTaskOutboxInTxn(
  client: PoolClient,
  input: {
    coadminUid: string;
    carerUid?: string | null;
    taskId: string;
    requestId: string;
    status: string;
    eventType: string;
    updatedAt: string;
    type?: string;
    playerUid?: string;
    gameName?: string;
    amount?: number | null;
    assignedCarerUid?: string | null;
    claimedByUid?: string | null;
    outboxLogReason?: string;
    outboxFlowName?: string;
  }
) {
  const type = cleanText(input.type);
  const playerUid = cleanText(input.playerUid);
  const { rows, channels: outboxChannels } = buildCarerTaskOutboxRows(input);
  await insertLiveOutboxEventsBatch(client, rows, {
    flowName: input.outboxFlowName || 'write_carer_task_outbox',
  });
  const carerUid = cleanText(input.carerUid);

  if (input.eventType === 'task.completed') {
    console.info('[LIVE_OUTBOX_INSERT_TASK_COMPLETED]', {
      taskId: input.taskId,
      requestId: input.requestId,
      coadminUid: input.coadminUid,
      carerUid: carerUid || null,
      status: input.status,
      channels: outboxChannels,
    });
  }

  if (input.outboxLogReason) {
    console.info('[PLAYER_REQUEST_TASK_OUTBOX]', {
      requestId: input.requestId,
      taskId: input.taskId,
      type: type || null,
      coadminUid: input.coadminUid,
      playerUid: playerUid || null,
      taskStatus: input.status,
      assignedCarerUid: input.assignedCarerUid ?? null,
      outboxChannels,
      insertedTask: true,
      reason: input.outboxLogReason,
    });
  }

  return outboxChannels;
}

function logPlayerRequestCarerTaskLink(input: {
  logKey: '[PLAYER_RECHARGE_TO_CARER_TASK]' | '[PLAYER_REDEEM_TO_CARER_TASK]';
  requestId: string;
  taskId: string;
  playerUid: string;
  coadminUid: string;
  gameName: string;
  amount: number;
  taskType: 'recharge' | 'redeem';
  insertedCarerTask: boolean;
  outboxChannels: string[];
  reason: string;
}) {
  console.info(input.logKey, {
    requestId: input.requestId,
    taskId: input.taskId,
    playerUid: input.playerUid,
    coadminUid: input.coadminUid,
    game: input.gameName,
    amount: input.amount,
    taskType: input.taskType,
    taskStatus: 'pending',
    insertedCarerTask: input.insertedCarerTask,
    outboxChannels: input.outboxChannels,
    reason: input.reason,
  });
}

function logPlayerGameRequestFlowAudit(input: {
  auditKey: '[PLAYER_RECHARGE_FLOW_AUDIT]' | '[PLAYER_REDEEM_FLOW_AUDIT]';
  requestId: string;
  taskId: string;
  playerUid: string;
  coadminUid: string;
  gameName: string;
  amount: number;
  taskType: 'recharge' | 'redeem';
  insertedCarerTask: boolean;
  outboxChannels: string[];
  reason: string;
}) {
  console.info(input.auditKey, {
    requestId: input.requestId,
    taskId: input.taskId,
    playerUid: input.playerUid,
    coadminUid: input.coadminUid,
    gameName: input.gameName,
    amount: input.amount,
    requestStatus: 'pending',
    taskType: input.taskType,
    taskStatus: 'pending',
    insertedPlayerRequest: true,
    insertedCarerTask: input.insertedCarerTask,
    outboxChannels: input.outboxChannels,
    firestoreAttempted: false,
    reason: input.reason,
  });
}

export async function createRechargeRequestInSql(
  input: AuthorityRechargeCreateInput
): Promise<AuthorityRechargeCreateResult> {
  const playerUid = cleanText(input.playerUid);
  const gameName = cleanText(input.gameName);
  const amount = Math.max(0, Number(input.amount || 0));
  const bonusEventId = cleanText(input.bonusEventId) || null;
  const idempotencyKey = cleanText(input.idempotencyKey) || randomUUID();
  const operationKey = `game_request_create:${playerUid}:recharge:${idempotencyKey}`;
  const waterfall = new RechargeSqlWaterfall();

  if (!playerUid || !gameName || amount <= 0) {
    throw new Error('Enter a valid amount.');
  }

  logAuthPayloadPreTxnRemoved('recharge_create');
  const db = getPlayerMirrorPool();
  if (!db) throw new Error('SQL authority unavailable.');

  const requestId = randomUUID();
  const eventId = randomUUID();
  const client = await waterfall.time(
    {
      step: 'pool_connect',
      table: 'pool',
      queryType: 'txn',
      sequentialOrParallel: 'sequential',
      required: true,
      canMoveAfterResponse: false,
    },
    () => db.connect()
  );
  try {
    await waterfall.time(
      {
        step: 'begin',
        table: 'transaction',
        queryType: 'txn',
        sequentialOrParallel: 'sequential',
        required: true,
        canMoveAfterResponse: false,
      },
      () => client.query('BEGIN')
    );
    console.info('[PLAYER_REQUEST_TX_BEGIN]', {
      type: 'recharge',
      playerUid,
      requestId,
    });
    const claim = await waterfall.time(
      {
        step: 'claim_authority_operation',
        table: 'authority_operations',
        queryType: 'write',
        sequentialOrParallel: 'sequential',
        required: true,
        canMoveAfterResponse: false,
      },
      () =>
        claimAuthorityOperation(client, {
          operationKey,
          operationType: 'game_request_create',
          userUid: playerUid,
          sourceId: requestId,
          actorUid: playerUid,
          actorRole: 'player',
          payload: {},
        })
    );
    if (!claim.claimed) {
      const payload = await readAuthorityOperationPayloadWithClient(client, operationKey, {
        flowName: 'recharge_create',
      });
      await client.query('ROLLBACK');
      if (payload?.requestId) {
        const requestIdFromPayload = cleanText(payload.requestId);
        if (requestIdFromPayload) {
          waterfall.flushSummary();
          return {
            success: true,
            duplicate: true,
            requestId: requestIdFromPayload,
          };
        }
      }
      throw new Error('Duplicate recharge create in progress.');
    }

    const playerResult = await waterfall.time(
      {
        step: 'lock_player_for_update',
        table: 'players_cache',
        queryType: 'read',
        sequentialOrParallel: 'sequential',
        required: true,
        canMoveAfterResponse: false,
      },
      () =>
        client.query(
          `
            SELECT uid, username, role, status, coin, coadmin_uid, created_by, raw_firestore_data
            FROM public.players_cache
            WHERE uid = $1 AND deleted_at IS NULL
            FOR UPDATE
          `,
          [playerUid]
        )
    );
    if (!playerResult.rows.length) throw new Error('Player profile not found.');
    const player = playerResult.rows[0] as Record<string, unknown>;
    const role = cleanText(player.role).toLowerCase();
    const status = cleanText(player.status).toLowerCase();
    if (role !== 'player') throw new Error('Only players can create recharge requests.');
    if (status === 'disabled') {
      throw new Error('Your account is blocked. Recharge and redeem features are disabled.');
    }

    const coadminUid =
      cleanText(player.coadmin_uid) ||
      cleanText(player.created_by) ||
      cleanText(input.previewCoadminUid);
    if (!coadminUid) throw new Error('Player coadmin scope not found.');

    if (!input.maintenancePrechecked) {
      const maintenanceBreak = await waterfall.time(
        {
          step: 'read_maintenance_break',
          table: 'coadmin_maintenance_cache',
          queryType: 'read',
          sequentialOrParallel: 'sequential',
          required: true,
          canMoveAfterResponse: false,
        },
        () => getCoadminMaintenanceBreak(coadminUid)
      );
      if (maintenanceBreak.enabled) {
        throw new Error(`MAINTENANCE_BREAK:${maintenanceBreak.message}`);
      }
    }

    const currentCoin = readPlayerCoin(player);
    if (currentCoin < amount) {
      throw new Error(
        'Not enough coin to request this recharge. Use a lower amount or add coin first.'
      );
    }

    const firstRechargeMatchUsed = readFirstRechargeMatchUsed(player);
    let hasApplied =
      input.hasAnyFirstRechargeAppliedRequest || firstRechargeMatchUsed;
    if (!hasApplied && !input.firstRechargePrechecked) {
      hasApplied = await waterfall.time(
        {
          step: 'read_first_recharge_applied',
          table: 'player_game_requests_cache',
          queryType: 'read',
          sequentialOrParallel: 'sequential',
          required: true,
          canMoveAfterResponse: false,
        },
        () => hasFirstRechargeMatchAppliedFromSqlWithClient(client, playerUid)
      );
    }
    const firstRechargeMatchEligible =
      !bonusEventId && !firstRechargeMatchUsed && !hasApplied;

    const requestedBaseAmount = Math.max(0, Number(input.baseAmount || 0));
    const requestedBonusPercentage = Number(input.bonusPercentage);
    const boostedAmount = firstRechargeMatchEligible
      ? Math.round(amount * (1 + FIRST_RECHARGE_MATCH_PERCENT / 100))
      : amount;

    const nowIso = new Date().toISOString();
    const newCoin = currentCoin - amount;
    const playerUsername = cleanText(player.username) || 'Player';
    const assignedGameUsername = cleanText(input.assignedGameUsername);
    if (!assignedGameUsername) {
      throw new Error(
        'Game username is not assigned for this game yet. Please create username first.'
      );
    }

    const requestRaw = {
      playerUid,
      gameName,
      currentUsername: assignedGameUsername,
      gameAccountUsername: assignedGameUsername,
      amount: boostedAmount,
      baseAmount: firstRechargeMatchEligible
        ? amount
        : requestedBaseAmount > 0
          ? requestedBaseAmount
          : null,
      bonusPercentage: firstRechargeMatchEligible
        ? FIRST_RECHARGE_MATCH_PERCENT
        : Number.isFinite(requestedBonusPercentage) && requestedBonusPercentage > 0
          ? requestedBonusPercentage
          : null,
      bonusEventId,
      firstRechargeMatchApplied: firstRechargeMatchEligible,
      type: 'recharge',
      status: 'pending',
      createdBy: coadminUid,
      coadminUid,
      createdAt: nowIso,
      completedAt: null,
      pokedAt: null,
      pokeMessage: PLAYER_RECHARGE_SENT_MESSAGE,
      coinDeductedOnRequest: true,
    };

    await waterfall.time(
      {
        step: 'update_player_balance',
        table: 'players_cache',
        queryType: 'write',
        sequentialOrParallel: 'sequential',
        required: true,
        canMoveAfterResponse: false,
      },
      () => updatePlayerBalancesInTxn(client, playerUid, { coin: newCoin })
    );
    await waterfall.time(
      {
        step: 'upsert_game_request',
        table: 'player_game_requests_cache',
        queryType: 'write',
        sequentialOrParallel: 'sequential',
        required: true,
        canMoveAfterResponse: false,
      },
      () =>
        upsertGameRequestCacheInTxn(client, requestId, {
          ...requestRaw,
          playerUsername,
          source: 'authority_recharge_create',
          rawFirestoreData: requestRaw,
        })
    );
    const linkedRechargeTask = await waterfall.time(
      {
        step: 'upsert_linked_carer_task',
        table: 'carer_tasks_cache',
        queryType: 'write',
        sequentialOrParallel: 'sequential',
        required: true,
        canMoveAfterResponse: false,
      },
      () =>
        upsertLinkedCarerTaskInTxn(
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
            gameCredential: input.gameCredential,
          },
          nowIso
        )
    );
    console.info('[PLAYER_REQUEST_TASK_CREATED]', {
      type: 'recharge',
      playerUid,
      requestId,
      taskId: linkedRechargeTask.taskId,
      insertedCarerTask: linkedRechargeTask.inserted,
    });

    const financialRaw = {
      playerUid,
      coadminUid,
      amountNpr: amount,
      type: 'recharge_request_deduct',
      requestId,
      createdAt: nowIso,
      ttlExpiresAt: ttlAfterDaysIso(90),
    };
    await waterfall.time(
      {
        step: 'insert_financial_event',
        table: 'financial_events_cache',
        queryType: 'write',
        sequentialOrParallel: 'sequential',
        required: true,
        canMoveAfterResponse: false,
      },
      () =>
        insertFinancialEventInTxn(client, {
          eventId,
          playerUid,
          coadminUid,
          amountNpr: amount,
          type: 'recharge_request_deduct',
          requestId,
          beforeCoin: currentCoin,
          afterCoin: newCoin,
          createdAt: nowIso,
          source: 'authority_recharge_create',
        })
    );
    await waterfall.time(
      {
        step: 'insert_authority_ledger',
        table: 'user_balance_events',
        queryType: 'write',
        sequentialOrParallel: 'sequential',
        required: true,
        canMoveAfterResponse: false,
      },
      () =>
        insertAuthorityLedgerEvent(client, {
          eventKey: `financialEvents:${eventId}:${playerUid}:coin:recharge_request_coin_debit`,
          userUid: playerUid,
          username: playerUsername,
          role: 'player',
          coadminUid,
          balanceType: 'coin',
          direction: 'debit',
          delta: -amount,
          absoluteAfter: newCoin,
          eventType: 'recharge_request_coin_debit',
          sourceCollection: 'financialEvents',
          sourceId: eventId,
          actorUid: playerUid,
          actorRole: 'player',
          confidence: 'high',
          sourceCreatedAt: nowIso,
          rawSourceData: financialRaw,
          sourceFields: { amount, requestId },
        })
    );

    const carerOutbox = buildCarerTaskOutboxRows({
      coadminUid,
      taskId: `request__${requestId}`,
      requestId,
      status: 'pending',
      type: 'recharge',
      playerUid,
      gameName,
      amount: boostedAmount,
      assignedCarerUid: null,
      eventType: 'task.upserted',
      updatedAt: nowIso,
    });
    await waterfall.time(
      {
        step: 'emit_recharge_sent_outbox_batch',
        table: 'live_outbox',
        queryType: 'write',
        sequentialOrParallel: 'sequential',
        required: true,
        canMoveAfterResponse: false,
      },
      () =>
        emitPlayerRequestOutcomeMessage(client, {
          playerUid,
          coadminUid,
          requestId,
          requestType: 'recharge',
          outcomeType: 'recharge_sent',
          status: 'pending',
          gameName,
          amount: boostedAmount,
          updatedAt: nowIso,
          message: PLAYER_RECHARGE_SENT_MESSAGE,
          toastVariant: 'info',
          source: 'authority_recharge_create',
          skipPokeUpdate: true,
          additionalOutboxRows: carerOutbox.rows,
          outboxFlowName: 'recharge_create',
        })
    );
    const rechargeOutboxChannels = carerOutbox.channels;
    console.info('[TASK_OUTBOX_EMITTED]', {
      taskId: linkedRechargeTask.taskId,
      requestId,
      phase: 'create',
      flowName: 'recharge_create',
      rowCount: carerOutbox.rows.length,
      channels: rechargeOutboxChannels,
      eventType: 'task.upserted',
    });
    console.info('[PLAYER_REQUEST_OUTBOX_EMITTED]', {
      type: 'recharge',
      playerUid,
      requestId,
      taskId: linkedRechargeTask.taskId,
      rowCount: carerOutbox.rows.length,
      channels: rechargeOutboxChannels,
    });
    logPlayerRequestCarerTaskLink({
      logKey: '[PLAYER_RECHARGE_TO_CARER_TASK]',
      requestId,
      taskId: linkedRechargeTask.taskId,
      playerUid,
      coadminUid,
      gameName,
      amount: boostedAmount,
      taskType: 'recharge',
      insertedCarerTask: linkedRechargeTask.inserted,
      outboxChannels: rechargeOutboxChannels,
      reason: 'player_recharge_create',
    });
    logPlayerGameRequestFlowAudit({
      auditKey: '[PLAYER_RECHARGE_FLOW_AUDIT]',
      requestId,
      taskId: linkedRechargeTask.taskId,
      playerUid,
      coadminUid,
      gameName,
      amount: boostedAmount,
      taskType: 'recharge',
      insertedCarerTask: linkedRechargeTask.inserted,
      outboxChannels: rechargeOutboxChannels,
      reason: 'player_recharge_create',
    });

    await waterfall.time(
      {
        step: 'finalize_authority_operation',
        table: 'authority_operations',
        queryType: 'write',
        sequentialOrParallel: 'sequential',
        required: true,
        canMoveAfterResponse: false,
      },
      () =>
        client.query(
          `UPDATE public.authority_operations SET payload = $2::jsonb WHERE operation_key = $1`,
          [operationKey, JSON.stringify({ requestId, playerUid, type: 'recharge', amount })]
        )
    );
    await waterfall.time(
      {
        step: 'commit',
        table: 'transaction',
        queryType: 'txn',
        sequentialOrParallel: 'sequential',
        required: true,
        canMoveAfterResponse: false,
      },
      () => client.query('COMMIT')
    );
    console.info('[PLAYER_REQUEST_TX_COMMIT]', {
      type: 'recharge',
      playerUid,
      requestId,
      taskId: linkedRechargeTask.taskId,
    });
    waterfall.flushSummary();
    console.info('[TASK_CREATE_COMMITTED]', {
      taskId: linkedRechargeTask.taskId,
      requestId,
      createdAt: nowIso,
      status: 'pending',
      type: 'recharge',
    });
    scheduleAutoClaimPendingTaskOnCreate({
      taskId: linkedRechargeTask.taskId,
      coadminUid,
      trigger: 'recharge_create',
    });
    return { success: true, duplicate: false, requestId };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function createRedeemRequestInSql(
  input: AuthorityRedeemCreateInput
): Promise<AuthorityRedeemCreateResult> {
  const playerUid = cleanText(input.playerUid);
  const gameName = cleanText(input.gameName);
  const amount = Math.max(0, Number(input.amount || 0));
  const idempotencyKey = cleanText(input.idempotencyKey) || randomUUID();
  const operationKey = `game_request_create:${playerUid}:redeem:${idempotencyKey}`;

  if (!gameName) throw new Error('Game is required.');
  if (!amount) throw new Error('Enter a valid amount.');
  if (amount < MIN_REDEEM_AMOUNT || amount > MAX_REDEEM_AMOUNT) {
    throw new Error(
      `Redeem amount must be between ${MIN_REDEEM_AMOUNT} and ${MAX_REDEEM_AMOUNT}.`
    );
  }

  logAuthPayloadPreTxnRemoved('redeem_create');
  const db = getPlayerMirrorPool();
  if (!db) throw new Error('SQL authority unavailable.');

  const requestId = randomUUID();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    console.info('[PLAYER_REQUEST_TX_BEGIN]', {
      type: 'redeem',
      playerUid,
      requestId,
    });
    const claim = await claimAuthorityOperation(client, {
      operationKey,
      operationType: 'game_request_create',
      userUid: playerUid,
      sourceId: requestId,
      actorUid: playerUid,
      actorRole: 'player',
      payload: {},
    });
    if (!claim.claimed) {
      const payload = await readAuthorityOperationPayloadWithClient(client, operationKey, {
        flowName: 'redeem_create',
      });
      await client.query('ROLLBACK');
      if (payload?.requestId) {
        return {
          success: true,
          duplicate: true,
          requestId: cleanText(payload.requestId),
        };
      }
      throw new Error('Duplicate redeem create in progress.');
    }

    const rollingUsed = await fetchRolling24hRedeemUsageForPlayerGame(client, playerUid, gameName);
    const redeemRemaining = Math.max(0, PLAYER_GAME_REDEEM_MAX_PER_24H - rollingUsed);
    if (redeemRemaining <= 0) {
      throw new Error(
        `Redeem limit for ${gameName} is ${PLAYER_GAME_REDEEM_MAX_PER_24H} per rolling 24 hours. Wait until older redeems expire from this game window before redeeming again.`
      );
    }
    if (amount > redeemRemaining) {
      throw new Error(
        `Only ${redeemRemaining} redeem is left for ${gameName} in this rolling 24-hour window.`
      );
    }

    const playerResult = await client.query(
      `
        SELECT uid, username, role, status, coadmin_uid, created_by
        FROM public.players_cache
        WHERE uid = $1 AND deleted_at IS NULL
        FOR UPDATE
      `,
      [playerUid]
    );
    if (!playerResult.rows.length) throw new Error('Player profile not found.');
    const player = playerResult.rows[0] as Record<string, unknown>;
    const role = cleanText(player.role).toLowerCase();
    const status = cleanText(player.status).toLowerCase();
    if (role !== 'player') throw new Error('Only players can create redeem requests.');
    if (status === 'disabled') {
      throw new Error('Your account is blocked. Recharge and redeem features are disabled.');
    }

    const coadminUid = cleanText(player.coadmin_uid) || cleanText(player.created_by);
    if (!coadminUid) throw new Error('Player coadmin scope not found.');

    const maintenanceBreak = await getCoadminMaintenanceBreak(coadminUid);
    if (maintenanceBreak.enabled) {
      throw new Error(`MAINTENANCE_BREAK:${maintenanceBreak.message}`);
    }

    const assignedGameUsername = cleanText(input.assignedGameUsername);
    if (!assignedGameUsername) {
      throw new Error(
        'Game username is not assigned for this game yet. Please create username first.'
      );
    }

    const nowIso = new Date().toISOString();
    const playerUsername = cleanText(player.username) || 'Player';
    const requestRaw = {
      playerUid,
      gameName,
      currentUsername: assignedGameUsername,
      gameAccountUsername: assignedGameUsername,
      amount,
      baseAmount:
        input.baseAmount !== undefined && input.baseAmount !== null
          ? Number(input.baseAmount)
          : null,
      bonusPercentage:
        input.bonusPercentage !== undefined && input.bonusPercentage !== null
          ? Number(input.bonusPercentage)
          : null,
      bonusEventId: cleanText(input.bonusEventId) || null,
      type: 'redeem',
      status: 'pending',
      createdBy: coadminUid,
      coadminUid,
      createdAt: nowIso,
      completedAt: null,
      pokedAt: null,
      pokeMessage: null,
    };

    await upsertGameRequestCacheInTxn(client, requestId, {
      ...requestRaw,
      playerUsername,
      source: 'authority_redeem_create',
      rawFirestoreData: requestRaw,
    });
    const linkedRedeemTask = await upsertLinkedCarerTaskInTxn(
      client,
      {
        requestId,
        coadminUid,
        type: 'redeem',
        playerUid,
        playerUsername,
        gameName,
        amount,
        currentUsername: assignedGameUsername,
        gameCredential: input.gameCredential,
      },
      nowIso
    );
    console.info('[PLAYER_REQUEST_TASK_CREATED]', {
      type: 'redeem',
      playerUid,
      requestId,
      taskId: linkedRedeemTask.taskId,
      insertedCarerTask: linkedRedeemTask.inserted,
    });

    const redeemCarerOutbox = buildCarerTaskOutboxRows({
      coadminUid,
      taskId: `request__${requestId}`,
      requestId,
      status: 'pending',
      type: 'redeem',
      playerUid,
      gameName,
      amount,
      assignedCarerUid: null,
      eventType: 'task.upserted',
      updatedAt: nowIso,
    });
    await emitPlayerRequestOutcomeMessage(client, {
      playerUid,
      coadminUid,
      requestId,
      requestType: 'redeem',
      outcomeType: 'redeem_sent',
      status: 'pending',
      gameName,
      amount,
      updatedAt: nowIso,
      message: PLAYER_REDEEM_SENT_MESSAGE,
      toastVariant: 'info',
      source: 'authority_redeem_create',
      additionalOutboxRows: redeemCarerOutbox.rows,
      outboxFlowName: 'redeem_create',
    });
    const redeemOutboxChannels = redeemCarerOutbox.channels;
    console.info('[TASK_OUTBOX_EMITTED]', {
      taskId: linkedRedeemTask.taskId,
      requestId,
      phase: 'create',
      flowName: 'redeem_create',
      rowCount: redeemCarerOutbox.rows.length,
      channels: redeemOutboxChannels,
      eventType: 'task.upserted',
    });
    console.info('[PLAYER_REQUEST_OUTBOX_EMITTED]', {
      type: 'redeem',
      playerUid,
      requestId,
      taskId: linkedRedeemTask.taskId,
      rowCount: redeemCarerOutbox.rows.length,
      channels: redeemOutboxChannels,
    });
    logPlayerRequestCarerTaskLink({
      logKey: '[PLAYER_REDEEM_TO_CARER_TASK]',
      requestId,
      taskId: linkedRedeemTask.taskId,
      playerUid,
      coadminUid,
      gameName,
      amount,
      taskType: 'redeem',
      insertedCarerTask: linkedRedeemTask.inserted,
      outboxChannels: redeemOutboxChannels,
      reason: 'player_redeem_create',
    });
    logPlayerGameRequestFlowAudit({
      auditKey: '[PLAYER_REDEEM_FLOW_AUDIT]',
      requestId,
      taskId: linkedRedeemTask.taskId,
      playerUid,
      coadminUid,
      gameName,
      amount,
      taskType: 'redeem',
      insertedCarerTask: linkedRedeemTask.inserted,
      outboxChannels: redeemOutboxChannels,
      reason: 'player_redeem_create',
    });

    await client.query(`UPDATE public.authority_operations SET payload = $2::jsonb WHERE operation_key = $1`, [
      operationKey,
      JSON.stringify({ requestId, playerUid, type: 'redeem', amount }),
    ]);
    await client.query('COMMIT');
    console.info('[PLAYER_REQUEST_TX_COMMIT]', {
      type: 'redeem',
      playerUid,
      requestId,
      taskId: linkedRedeemTask.taskId,
    });
    console.info('[TASK_CREATE_COMMITTED]', {
      taskId: linkedRedeemTask.taskId,
      requestId,
      createdAt: nowIso,
      status: 'pending',
      type: 'redeem',
    });
    scheduleAutoClaimPendingTaskOnCreate({
      taskId: linkedRedeemTask.taskId,
      coadminUid,
      trigger: 'redeem_create',
    });
    return { success: true, duplicate: false, requestId };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function completeRechargeRedeemTaskInSql(
  input: AuthorityCompleteRechargeRedeemInput
): Promise<AuthorityCompleteRechargeRedeemResult> {
  const taskId = cleanText(input.taskId);
  const actorUid = cleanText(input.actorUid);
  const actorRole = cleanText(input.actorRole);
  if (!taskId) throw new Error('taskId is required.');
  console.info('[AUTHORITY_RECHARGE_COMPLETE_START]', {
    taskId,
    actorUid,
    actorRole,
    scopeUid: cleanText(input.scopeUid) || null,
  });

  const idempotencyKey = cleanText(input.idempotencyKey) || taskId;
  const operationKey = `game_request_complete:${taskId}:${idempotencyKey}`;

  logAuthPayloadPreTxnRemoved('complete_recharge_redeem');
  const db = getPlayerMirrorPool();
  if (!db) throw new Error('SQL authority unavailable.');

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const claim = await claimAuthorityOperation(client, {
      operationKey,
      operationType: 'game_request_complete',
      userUid: actorUid,
      sourceId: taskId,
      actorUid,
      actorRole,
      payload: {},
    });
    if (!claim.claimed) {
      const payload = await readAuthorityOperationPayloadWithClient(client, operationKey, {
        flowName: 'complete_recharge_redeem',
      });
      await client.query('ROLLBACK');
      if (payload?.requestId) {
        return {
          success: true,
          duplicate: true,
          alreadyCompleted: payload.alreadyCompleted === true,
          taskId,
          requestId: cleanText(payload.requestId),
          totalAwardNpr: Number(payload.totalAwardNpr || 0),
        };
      }
      throw new Error('Duplicate complete in progress.');
    }

    const taskResult = await client.query(
      `
        SELECT *
        FROM public.carer_tasks_cache
        WHERE firebase_id = $1 AND deleted_at IS NULL
        FOR UPDATE
      `,
      [taskId]
    );
    if (!taskResult.rows.length) throw new Error('Task not found.');
    const task = taskResult.rows[0] as Record<string, unknown>;
    const taskStatus = cleanText(task.status).toLowerCase();
    if (taskStatus === 'completed') {
      const requestId = cleanText(task.request_id);
      await client.query(`UPDATE public.authority_operations SET payload = $2::jsonb WHERE operation_key = $1`, [
        operationKey,
        JSON.stringify({
          requestId,
          alreadyCompleted: true,
          totalAwardNpr: 0,
        }),
      ]);
      await client.query('COMMIT');
      return {
        success: true,
        duplicate: false,
        alreadyCompleted: true,
        taskId,
        requestId,
        totalAwardNpr: 0,
      };
    }
    if (taskStatus !== 'in_progress') {
      throw new Error('Start the task first so it moves to In Progress before completion.');
    }

    const taskScope = cleanText(task.coadmin_uid);
    if (!input.isAdmin && (!input.scopeUid || input.scopeUid !== taskScope)) {
      throw new Error('Forbidden: task is outside your scope.');
    }
    const assignedCarerUid = cleanText(task.assigned_carer_uid);
    if (assignedCarerUid && assignedCarerUid !== actorUid && !input.isAdmin) {
      throw new Error('Only the assigned handler can complete this task.');
    }

    const requestId = cleanText(task.request_id);
    if (!requestId) throw new Error('This task is not linked to a request.');

    const requestResult = await client.query(
      `
        SELECT *
        FROM public.player_game_requests_cache
        WHERE firebase_id = $1 AND deleted_at IS NULL
        FOR UPDATE
      `,
      [requestId]
    );
    if (!requestResult.rows.length) throw new Error('Related request not found.');
    const request = requestResult.rows[0] as Record<string, unknown>;
    const requestStatus = cleanText(request.status).toLowerCase();
    const playerUid = cleanText(task.player_uid) || cleanText(request.player_uid);
    if (!playerUid) throw new Error('Related player not found.');

    if (requestStatus === 'completed') {
      const nowIso = new Date().toISOString();
      await updateCarerTaskCompletedInTxn(client, taskId, {
        updatedAt: nowIso,
        completedByCarerUid:
          cleanText(task.completed_by_carer_uid) || assignedCarerUid || actorUid,
        completedByCarerUsername:
          cleanText(task.completed_by_carer_username) ||
          cleanText(task.assigned_carer_username) ||
          input.actorUsername ||
          'Handler',
        actorUid,
        actorRole,
        sourceTaskId: taskId,
        sourceRequestId: requestId,
      });
      await client.query(`UPDATE public.authority_operations SET payload = $2::jsonb WHERE operation_key = $1`, [
        operationKey,
        JSON.stringify({ requestId, alreadyCompleted: true, totalAwardNpr: 0 }),
      ]);
      await client.query('COMMIT');
      return {
        success: true,
        duplicate: false,
        alreadyCompleted: true,
        taskId,
        requestId,
        totalAwardNpr: 0,
      };
    }
    if (requestStatus !== 'pending' && requestStatus !== 'poked') {
      throw new Error('Request is not available to complete.');
    }

    const playerResult = await client.query(
      `
        SELECT
          p.uid,
          p.username,
          p.coin,
          p.cash,
          p.promo_locked_coins,
          p.coadmin_uid,
          p.created_by,
          p.raw_firestore_data,
          (
            SELECT s.bonus_blocked_until
            FROM public.user_balance_snapshots_cache s
            WHERE s.firebase_id = p.uid
              AND s.deleted_at IS NULL
            LIMIT 1
          ) AS bonus_blocked_until
        FROM public.players_cache p
        WHERE p.uid = $1 AND p.deleted_at IS NULL
        FOR UPDATE
      `,
      [playerUid]
    );
    if (!playerResult.rows.length) throw new Error('Related player not found.');
    const player = playerResult.rows[0] as Record<string, unknown>;

    const handlerResult = await client.query(
      `
        SELECT uid, username, raw_firestore_data
        FROM public.players_cache
        WHERE uid = $1 AND deleted_at IS NULL
        FOR UPDATE
      `,
      [actorUid]
    );
    const handler = handlerResult.rows[0] as Record<string, unknown> | undefined;
    const snapshotResult = await client.query(
      `
        SELECT firebase_id, cash_box_npr, raw_firestore_data
        FROM public.user_balance_snapshots_cache
        WHERE firebase_id = $1 AND deleted_at IS NULL
        FOR UPDATE
      `,
      [actorUid]
    );
    const handlerSnapshot = snapshotResult.rows[0] as Record<string, unknown> | undefined;

    const requestType = cleanText(request.type).toLowerCase();
    const amount = Math.max(0, Number(request.amount || 0));
    const coadminUid = cleanText(request.coadmin_uid) || taskScope;
    const nowIso = new Date().toISOString();
    const eventId = randomUUID();
    let totalAwardNpr = 0;
    let committedCashBalance: number | null = null;
    let committedCoinBalance = readPlayerCoin(player);

    if (requestType === 'redeem') {
      const currentCash = readPlayerCash(player);
      const newCash = currentCash + amount;
      await updatePlayerBalancesInTxn(client, playerUid, { cash: newCash });
      committedCashBalance = newCash;
      const financialRaw = {
        playerUid,
        coadminUid,
        amountNpr: amount,
        type: 'redeem',
        requestId,
        createdAt: nowIso,
      };
      await insertFinancialEventInTxn(client, {
        eventId,
        playerUid,
        coadminUid,
        amountNpr: amount,
        type: 'redeem',
        requestId,
        beforeCash: currentCash,
        afterCash: newCash,
        createdAt: nowIso,
        source: 'authority_game_request_complete',
      });
      await insertAuthorityLedgerEvent(client, {
        eventKey: `financialEvents:${eventId}:${playerUid}:cash:redeem_cash_credit`,
        userUid: playerUid,
        username: cleanText(player.username) || 'Player',
        role: 'player',
        coadminUid,
        balanceType: 'cash',
        direction: 'credit',
        delta: amount,
        absoluteAfter: newCash,
        eventType: 'redeem_cash_credit',
        sourceCollection: 'financialEvents',
        sourceId: eventId,
        actorUid,
        actorRole,
        confidence: 'high',
        sourceCreatedAt: nowIso,
        rawSourceData: financialRaw,
        sourceFields: { amount, requestId },
      });
    } else if (requestType === 'recharge') {
      if (
        request.first_recharge_match_applied === true &&
        !readFirstRechargeMatchUsed(player)
      ) {
        await updatePlayerBalancesInTxn(client, playerUid, { firstRechargeMatchUsed: true });
      }
      const depositAmount = Math.max(
        0,
        Number(request.base_amount ?? request.amount ?? 0)
      );
      const financialRaw = {
        playerUid,
        coadminUid,
        amountNpr: depositAmount,
        type: 'deposit',
        requestId,
        createdAt: nowIso,
      };
      await insertFinancialEventInTxn(client, {
        eventId,
        playerUid,
        coadminUid,
        amountNpr: depositAmount,
        type: 'deposit',
        requestId,
        createdAt: nowIso,
        source: 'authority_game_request_complete',
      });

      // Phase 6: Automatic Recharge Bonus (shadow and/or real grant) — same txn.
      // Never blocks completion on skip; consumes eligibility + resolver domain services.
      const arbGrant = await applyArbOnRechargeCompleteInTxn(client, {
        playerUid,
        playerRow: player,
        requestId,
        requestRow: request,
        rechargeAmount: depositAmount,
        requestCoadminUid: coadminUid,
        taskId,
        actorUid,
        actorRole,
        nowIso,
      });
      if (arbGrant.coinBalanceAfter != null) {
        (player as { coin?: number }).coin = arbGrant.coinBalanceAfter;
        committedCoinBalance = arbGrant.coinBalanceAfter;
      }
      if (Object.keys(arbGrant.requestRawPatch).length) {
        const raw =
          request.raw_firestore_data &&
          typeof request.raw_firestore_data === 'object' &&
          !Array.isArray(request.raw_firestore_data)
            ? (request.raw_firestore_data as Record<string, unknown>)
            : {};
        Object.assign(raw, arbGrant.requestRawPatch);
        (request as { raw_firestore_data: Record<string, unknown> }).raw_firestore_data =
          raw;
      }
    } else {
      throw new Error('Unsupported request type for completion.');
    }

    totalAwardNpr = calculateRechargeRedeemRewardNpr();
    const cashBoxBefore = handlerSnapshot
      ? readCashBoxNpr(handlerSnapshot, handler)
      : 0;
    const cashBoxAfter = cashBoxBefore + totalAwardNpr;
    if (handlerSnapshot) {
      await updatePlayerBalancesInTxn(client, actorUid, { cashBoxNpr: cashBoxAfter });
    }

    const requestRaw = {
      ...(request.raw_firestore_data as Record<string, unknown>),
      status: 'completed',
      completedAt: nowIso,
      ttlExpiresAt: ttlAfterDaysIso(90),
      pokedAt: null,
      pokeMessage: null,
    };
    await upsertGameRequestCacheInTxn(client, requestId, {
      ...requestRaw,
      playerUid,
      playerUsername: cleanText(request.player_username),
      coadminUid,
      gameName: cleanText(request.game_name),
      type: requestType,
      status: 'completed',
      amount,
      completedAt: nowIso,
      ttlExpiresAt: ttlAfterDaysIso(90),
      source: 'authority_game_request_complete',
      rawFirestoreData: requestRaw,
    });

    await updateCarerTaskCompletedInTxn(client, taskId, {
      updatedAt: nowIso,
      completedByCarerUid: actorUid,
      completedByCarerUsername: input.actorUsername || 'Handler',
      rewardAmountNpr: totalAwardNpr,
      rewardReason: 'recharge_redeem_task_completion',
      cashBoxBefore,
      cashBoxAfter,
      cashBoxDelta: cashBoxAfter - cashBoxBefore,
      actorUid,
      actorRole,
      sourceTaskId: taskId,
      sourceRequestId: requestId,
    });
    console.info('[TASK_COMPLETED]', {
      taskId,
      completedAt: nowIso,
      completedBy: actorUid,
      requestId,
      requestType,
    });

    if (totalAwardNpr > 0 && handlerSnapshot) {
      await insertAuthorityLedgerEvent(client, {
        eventKey: `game_request_complete:${taskId}:${actorUid}:cashBoxNpr:handler_reward`,
        userUid: actorUid,
        username: cleanText(handler?.username) || input.actorUsername || 'Handler',
        role: actorRole,
        coadminUid: taskScope,
        balanceType: 'cashBoxNpr',
        direction: 'credit',
        delta: totalAwardNpr,
        absoluteAfter: cashBoxAfter,
        eventType: 'recharge_redeem_handler_cashbox_credit',
        sourceCollection: 'carerTasks',
        sourceId: taskId,
        actorUid,
        actorRole,
        confidence: 'high',
        sourceCreatedAt: nowIso,
        rawSourceData: {
          rewardNpr: totalAwardNpr,
          requestId,
          taskId,
        },
        sourceFields: { rewardNpr: totalAwardNpr, requestId, taskId },
      });
    }

    const playerSuccessMessage =
      requestType === 'redeem' ? PLAYER_REDEEM_SUCCESS_MESSAGE : PLAYER_RECHARGE_SUCCESS_MESSAGE;
    const completeOutcomeType =
      requestType === 'redeem' ? 'redeem_completed' : 'recharge_completed';

    const completeCarerOutbox = buildCarerTaskOutboxRows({
      coadminUid: taskScope,
      carerUid: assignedCarerUid || actorUid,
      taskId,
      requestId,
      status: 'completed',
      type: requestType,
      playerUid,
      gameName: cleanText(request.game_name),
      amount,
      assignedCarerUid: assignedCarerUid || actorUid,
      eventType: 'task.completed',
      updatedAt: nowIso,
    });
    const balanceOutboxRows =
      requestType === 'redeem' && committedCashBalance != null
        ? (buildPlayerBalanceUpdatedOutboxRows({
            playerUid,
            cashBalance: committedCashBalance,
            coinBalance: committedCoinBalance,
            reason: 'redeem_completed',
            eventId,
            occurredAt: nowIso,
            taskId,
            requestId,
            source: 'authority_game_request_complete',
          }) as LiveOutboxInsertInput[])
        : [];

    await emitPlayerRequestOutcomeMessage(client, {
      playerUid,
      coadminUid,
      requestId,
      requestType: requestType === 'redeem' ? 'redeem' : 'recharge',
      outcomeType: completeOutcomeType,
      status: 'completed',
      gameName: cleanText(request.game_name),
      amount,
      updatedAt: nowIso,
      message: playerSuccessMessage,
      toastVariant: 'success',
      source: 'authority_game_request_complete',
      additionalOutboxRows: [...completeCarerOutbox.rows, ...balanceOutboxRows],
      outboxFlowName: 'complete_recharge_redeem',
    });
    console.info('[TASK_OUTBOX_EMITTED]', {
      taskId,
      requestId,
      phase: 'complete',
      flowName: 'complete_recharge_redeem',
      rowCount: completeCarerOutbox.rows.length + balanceOutboxRows.length,
      channels: completeCarerOutbox.channels,
      eventType: 'task.completed',
    });
    if (balanceOutboxRows.length) {
      console.info('[PLAYER_BALANCE_UPDATED_OUTBOX_QUEUED]', {
        taskId,
        requestId,
        playerUid,
        eventId,
        cashBalance: committedCashBalance,
        reason: 'redeem_completed',
        eventTypes: balanceOutboxRows.map((row) => row.eventType),
      });
    }
    console.info('[PLAYER_RECHARGE_SUCCESS_TOAST_QUEUED]', {
      requestId,
      playerUid,
      message: playerSuccessMessage,
      requestType,
    });
    console.info('[SQL_PLAYER_REQUEST_COMPLETED]', {
      requestId,
      playerUid,
      requestType,
      taskId,
    });

    await client.query(`UPDATE public.authority_operations SET payload = $2::jsonb WHERE operation_key = $1`, [
      operationKey,
      JSON.stringify({
        requestId,
        alreadyCompleted: false,
        totalAwardNpr,
        eventId,
        cashBalance: committedCashBalance,
      }),
    ]);
    await client.query('COMMIT');
    // Session/me extras are process-local; clear only after the credit has committed.
    invalidateSessionMePlayerExtras({ uid: playerUid });
    logTaskLifecycleDuration({
      taskId,
      createdAt: task.created_at,
      claimedAt: task.claimed_at,
      startedAt: task.started_at,
      completedAt: nowIso,
    });
    console.info('[AUTHORITY_RECHARGE_COMPLETE_DONE]', {
      taskId,
      requestId,
      playerUid,
      requestType,
      totalAwardNpr,
      alreadyCompleted: false,
      cashBalance: committedCashBalance,
    });
    return {
      success: true,
      duplicate: false,
      alreadyCompleted: false,
      taskId,
      requestId,
      totalAwardNpr,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function buildDismissRechargeSqlResult(input: {
  requestId: string;
  linkedTaskId: string;
  duplicate: boolean;
  alreadyDismissed: boolean;
  refunded: boolean;
  refundAmount?: number;
  taskDeleted: boolean;
}): AuthorityDismissRechargeResult {
  return {
    success: true,
    duplicate: input.duplicate,
    alreadyDismissed: input.alreadyDismissed,
    refunded: input.refunded,
    refundAmount: input.refundAmount,
    requestId: input.requestId,
    linkedTaskId: input.linkedTaskId,
    taskDeleted: input.taskDeleted,
  };
}

function logDismissRechargeSqlState(input: {
  requestId: string;
  beforeStatus: string;
  afterStatus: string;
  alreadyDismissed: boolean;
  alreadyRefunded: boolean;
  duplicateOperation: boolean;
  refundApplied: boolean;
  taskUpdated: boolean;
  outboxInserted: boolean;
  ok: boolean;
  reason: string | null;
}) {
  console.info('[DISMISS_RECHARGE_SQL_STATE]', input);
}

async function readDismissRechargeRequestStatus(requestId: string) {
  const db = getPlayerMirrorPool();
  if (!db) {
    return null;
  }
  const result = await db.query(
    `
      SELECT status, coin_refunded_on_dismissal
      FROM public.player_game_requests_cache
      WHERE firebase_id = $1 AND deleted_at IS NULL
      LIMIT 1
    `,
    [requestId]
  );
  if (!result.rows.length) {
    return null;
  }
  const row = result.rows[0] as Record<string, unknown>;
  return {
    status: cleanText(row.status).toLowerCase(),
    alreadyRefunded: row.coin_refunded_on_dismissal === true,
  };
}

async function resolveDismissRechargeDuplicate(
  requestId: string,
  linkedTaskId: string,
  payload: Record<string, unknown> | null | undefined
): Promise<AuthorityDismissRechargeResult | null> {
  if (payload?.requestId) {
    const result = buildDismissRechargeSqlResult({
      requestId,
      linkedTaskId,
      duplicate: true,
      alreadyDismissed: true,
      refunded: payload.refunded === true,
      refundAmount: Math.max(0, Number(payload.refundAmount || 0)) || undefined,
      taskDeleted: payload.taskDeleted === true,
    });
    logDismissRechargeSqlState({
      requestId,
      beforeStatus: 'unknown',
      afterStatus: 'dismissed',
      alreadyDismissed: true,
      alreadyRefunded: payload.refunded === true,
      duplicateOperation: true,
      refundApplied: false,
      taskUpdated: payload.taskDeleted === true,
      outboxInserted: false,
      ok: true,
      reason: 'authority_operation_duplicate',
    });
    return result;
  }

  const requestState = await readDismissRechargeRequestStatus(requestId);
  if (requestState?.status === 'dismissed') {
    const result = buildDismissRechargeSqlResult({
      requestId,
      linkedTaskId,
      duplicate: true,
      alreadyDismissed: true,
      refunded: requestState.alreadyRefunded,
      taskDeleted: true,
    });
    logDismissRechargeSqlState({
      requestId,
      beforeStatus: 'dismissed',
      afterStatus: 'dismissed',
      alreadyDismissed: true,
      alreadyRefunded: requestState.alreadyRefunded,
      duplicateOperation: true,
      refundApplied: false,
      taskUpdated: false,
      outboxInserted: false,
      ok: true,
      reason: 'request_already_dismissed',
    });
    return result;
  }

  return null;
}

export async function dismissRechargeRequestInSql(
  input: AuthorityDismissRechargeInput
): Promise<AuthorityDismissRechargeResult> {
  const requestId = cleanText(input.requestId);
  if (!requestId) throw new Error('requestId is required.');

  const idempotencyKey = cleanText(input.idempotencyKey) || requestId;
  const operationKey = `game_request_dismiss:${requestId}:${idempotencyKey}`;
  const linkedTaskId = `request__${requestId}`;

  logAuthPayloadPreTxnRemoved('dismiss_recharge');
  const db = getPlayerMirrorPool();
  if (!db) throw new Error('SQL authority unavailable.');

  const ownsTransaction = !input.txnClient;
  const client = input.txnClient ?? (await db.connect());
  const outboxStartedAt = Date.now();
  try {
    if (ownsTransaction) {
      await client.query('BEGIN');
    }
    const claim = await claimAuthorityOperation(client, {
      operationKey,
      operationType: 'game_request_dismiss',
      userUid: input.actorUid,
      sourceId: requestId,
      actorUid: input.actorUid,
      actorRole: input.actorRole,
      payload: {},
    });
    if (!claim.claimed) {
      const payload = await readAuthorityOperationPayloadWithClient(client, operationKey, {
        flowName: 'dismiss_recharge',
      });
      if (ownsTransaction) {
        await client.query('ROLLBACK');
      }
      const duplicate = await resolveDismissRechargeDuplicate(requestId, linkedTaskId, payload);
      if (duplicate) {
        return duplicate;
      }
      throw new Error('Duplicate dismiss in progress.');
    }

    const requestResult = await client.query(
      `
        SELECT *
        FROM public.player_game_requests_cache
        WHERE firebase_id = $1 AND deleted_at IS NULL
        FOR UPDATE
      `,
      [requestId]
    );
    if (!requestResult.rows.length) {
      const payload = await readAuthorityOperationPayloadWithClient(client, operationKey, {
        flowName: 'dismiss_recharge',
      });
      const duplicate = await resolveDismissRechargeDuplicate(requestId, linkedTaskId, payload);
      if (duplicate) {
        if (ownsTransaction) {
          await client.query('ROLLBACK');
        }
        return duplicate;
      }
      throw new Error('Request not found.');
    }
    const request = requestResult.rows[0] as Record<string, unknown>;
    if (cleanText(request.type).toLowerCase() !== 'recharge') {
      throw new Error('Only recharge requests can be dismissed.');
    }

    const requestCoadminUid =
      cleanText(request.coadmin_uid) || cleanText(request.created_by);
    if (!input.isAdmin && (!input.scopeUid || input.scopeUid !== requestCoadminUid)) {
      throw new Error('Forbidden: request is outside your scope.');
    }

    const beforeStatus = cleanText(request.status).toLowerCase();
    const alreadyDismissed = beforeStatus === 'dismissed';
    const alreadyRefunded = request.coin_refunded_on_dismissal === true;
    if (
      !alreadyDismissed &&
      !DISMISSIBLE_RECHARGE_STATUSES.has(beforeStatus) &&
      beforeStatus !== 'completed'
    ) {
      throw new Error('Request is not pending.');
    }

    const taskResult = await client.query(
      `
        SELECT firebase_id
        FROM public.carer_tasks_cache
        WHERE firebase_id = $1 AND deleted_at IS NULL
        FOR UPDATE
      `,
      [linkedTaskId]
    );
    const taskExists = taskResult.rows.length > 0;
    const nowIso = new Date().toISOString();
    let refunded = false;
    let refundAmount = 0;
    const playerUid = cleanText(request.player_uid);

    if (alreadyDismissed || beforeStatus === 'completed') {
      if (taskExists) {
        await tombstoneLinkedCarerTaskInTxn(client, requestId, 'authority_dismiss_recharge');
      }
      await client.query(`UPDATE public.authority_operations SET payload = $2::jsonb WHERE operation_key = $1`, [
        operationKey,
        JSON.stringify({
          requestId,
          alreadyDismissed: true,
          refunded: alreadyRefunded,
          taskDeleted: taskExists,
        }),
      ]);
      if (ownsTransaction) {
        await client.query('COMMIT');
      }
      logDismissRechargeSqlState({
        requestId,
        beforeStatus,
        afterStatus: beforeStatus === 'completed' ? 'completed' : 'dismissed',
        alreadyDismissed: true,
        alreadyRefunded,
        duplicateOperation: true,
        refundApplied: false,
        taskUpdated: taskExists,
        outboxInserted: taskExists,
        ok: true,
        reason: 'request_already_handled',
      });
      return buildDismissRechargeSqlResult({
        requestId,
        linkedTaskId,
        duplicate: true,
        alreadyDismissed: true,
        refunded: alreadyRefunded,
        taskDeleted: taskExists,
      });
    }

    if (!playerUid) throw new Error('Request player not found.');

    const deductedAmount = Math.max(
      0,
      Number(request.base_amount ?? request.amount ?? 0)
    );
    const shouldRefund =
      request.coin_deducted_on_request === true &&
      request.coin_refunded_on_dismissal !== true &&
      deductedAmount > 0;

    const dismissType = cleanText(input.dismissType) || 'carer_manual';
    const dismissReasonCode = cleanText(input.dismissReasonCode) || null;
    const dismissReasonMessage = cleanText(input.dismissReasonMessage) || null;
    const dismissedByAutomation = input.dismissedByAutomation === true;
    const pokeMessage =
      cleanText(input.pokeMessage) ||
      (dismissReasonCode === GAME_VAULT_MIDNIGHT_PARTY_REASON
        ? buildAutomationMidnightPartyPlayerMessage(dismissReasonMessage || '', shouldRefund)
        : dismissReasonMessage) ||
      null;
    const requestRaw = {
      ...(request.raw_firestore_data as Record<string, unknown>),
      status: 'dismissed',
      completedAt: nowIso,
      ttlExpiresAt: ttlAfterDaysIso(90),
      pokedAt: null,
      pokeMessage,
      dismissType,
      dismissedByAutomation,
      dismissReasonCode,
      dismissReasonMessage,
      dismissReason: dismissReasonMessage || dismissReasonCode,
      automationStatus: dismissedByAutomation ? 'dismissed' : cleanText(request.automation_status) || null,
      automationError: dismissedByAutomation ? dismissReasonMessage || dismissReasonCode : null,
      retryPending: false,
      coinRefundedOnDismissal: shouldRefund ? true : request.coin_refunded_on_dismissal,
      coinRefundedOnDismissalAt: shouldRefund ? nowIso : toIsoString(request.coin_refunded_on_dismissal_at),
    };
    await upsertGameRequestCacheInTxn(client, requestId, {
      ...requestRaw,
      playerUid,
      playerUsername: cleanText(request.player_username),
      coadminUid: requestCoadminUid,
      gameName: cleanText(request.game_name),
      type: 'recharge',
      status: 'dismissed',
      dismissType,
      dismissedByAutomation,
      dismissReasonCode,
      dismissReasonMessage,
      dismissReason: dismissReasonMessage || dismissReasonCode,
      pokeMessage,
      automationStatus: dismissedByAutomation ? 'dismissed' : cleanText(request.automation_status) || null,
      automationError: dismissedByAutomation ? dismissReasonMessage || dismissReasonCode : cleanText(request.automation_error) || null,
      retryPending: false,
      coinRefundedOnDismissal: shouldRefund,
      coinRefundedOnDismissalAt: shouldRefund ? nowIso : null,
      completedAt: nowIso,
      ttlExpiresAt: ttlAfterDaysIso(90),
      source: 'authority_dismiss_recharge',
      rawFirestoreData: requestRaw,
    });

    if (taskExists && input.skipTaskTombstone !== true) {
      await tombstoneLinkedCarerTaskInTxn(client, requestId, 'authority_dismiss_recharge');
    }

    if (shouldRefund) {
      const refundKey = `game_request_refund:${requestId}:${idempotencyKey}`;
      const refundClaim = await claimAuthorityOperation(client, {
        operationKey: refundKey,
        operationType: 'game_request_refund',
        userUid: playerUid,
        sourceId: requestId,
        actorUid: input.actorUid,
        actorRole: input.actorRole,
        payload: {},
      });
      if (refundClaim.claimed) {
        const playerResult = await client.query(
          `
            SELECT uid, username, coin, raw_firestore_data
            FROM public.players_cache
            WHERE uid = $1 AND deleted_at IS NULL
            FOR UPDATE
          `,
          [playerUid]
        );
        if (!playerResult.rows.length) throw new Error('Player not found.');
        const player = playerResult.rows[0] as Record<string, unknown>;
        const currentCoin = readPlayerCoin(player);
        const newCoin = currentCoin + deductedAmount;
        await updatePlayerBalancesInTxn(client, playerUid, { coin: newCoin });
        const eventId = randomUUID();
        const financialRaw = {
          playerUid,
          coadminUid: requestCoadminUid,
          amountNpr: deductedAmount,
          type: 'recharge_refund',
          requestId,
          createdAt: nowIso,
        };
        await insertFinancialEventInTxn(client, {
          eventId,
          playerUid,
          coadminUid: requestCoadminUid,
          amountNpr: deductedAmount,
          type: 'recharge_refund',
          requestId,
          beforeCoin: currentCoin,
          afterCoin: newCoin,
          createdAt: nowIso,
          source: 'authority_dismiss_recharge',
        });
        await insertAuthorityLedgerEvent(client, {
          eventKey: `financialEvents:${eventId}:${playerUid}:coin:recharge_refund_coin_credit`,
          userUid: playerUid,
          username: cleanText(player.username) || 'Player',
          role: 'player',
          coadminUid: requestCoadminUid,
          balanceType: 'coin',
          direction: 'credit',
          delta: deductedAmount,
          absoluteAfter: newCoin,
          eventType: 'recharge_refund_coin_credit',
          sourceCollection: 'financialEvents',
          sourceId: eventId,
          actorUid: input.actorUid,
          actorRole: input.actorRole,
          confidence: 'high',
          sourceCreatedAt: nowIso,
          rawSourceData: financialRaw,
          sourceFields: { amount: deductedAmount, requestId },
        });
        refunded = true;
        refundAmount = deductedAmount;
      }
    }

    if (pokeMessage) {
      const dismissAdditionalRows: LiveOutboxInsertInput[] = [];
      if (refunded) {
        dismissAdditionalRows.push({
          channel: playerRequestLiveChannel(playerUid),
          eventType: 'balance_update',
          entityType: 'player_balance',
          entityId: playerUid,
          source: 'authority_dismiss_recharge',
          mirroredAt: nowIso,
          payload: {
            entityId: playerUid,
            playerUid,
            updatedAt: nowIso,
            source: 'authority',
            refunded: true,
            requestId,
          },
        });
      }
      await emitPlayerRequestOutcomeMessage(client, {
        playerUid,
        coadminUid: requestCoadminUid,
        requestId,
        requestType: 'recharge',
        outcomeType: 'recharge_dismissed',
        status: 'dismissed',
        gameName: cleanText(request.game_name),
        amount: Math.max(0, Number(request.amount || 0)),
        updatedAt: nowIso,
        message: pokeMessage,
        toastVariant: 'error',
        dismissReasonCode,
        dismissReasonMessage,
        refunded,
        source: 'authority_dismiss_recharge',
        additionalOutboxRows: dismissAdditionalRows,
        outboxFlowName: 'dismiss_recharge',
      });
    }
    console.info('[LIVE_OUTBOX_INSERT_DONE]', {
      requestId,
      playerUid,
      durationMs: Date.now() - outboxStartedAt,
    });
    if (refunded) {
      console.info('[LIVE_OUTBOX_INSERT_PLAYER_BALANCE_UPDATE]', {
        requestId,
        playerUid,
        eventType: 'balance_update',
        refunded: true,
      });
    }

    await client.query(`UPDATE public.authority_operations SET payload = $2::jsonb WHERE operation_key = $1`, [
      operationKey,
      JSON.stringify({
        requestId,
        alreadyDismissed: false,
        refunded,
        refundAmount: refunded ? refundAmount : 0,
        taskDeleted: taskExists,
      }),
    ]);
    if (ownsTransaction) {
      await client.query('COMMIT');
    }
    logDismissRechargeSqlState({
      requestId,
      beforeStatus,
      afterStatus: 'dismissed',
      alreadyDismissed: false,
      alreadyRefunded,
      duplicateOperation: false,
      refundApplied: refunded,
      taskUpdated: taskExists,
      outboxInserted: true,
      ok: true,
      reason: null,
    });
    return buildDismissRechargeSqlResult({
      requestId,
      linkedTaskId,
      duplicate: false,
      alreadyDismissed: false,
      refunded,
      refundAmount: refunded ? refundAmount : undefined,
      taskDeleted: taskExists,
    });
  } catch (error) {
    if (ownsTransaction) {
      await client.query('ROLLBACK');
    }
    throw error;
  } finally {
    if (ownsTransaction) {
      client.release();
    }
  }
}

export async function dismissRedeemRequestInSql(
  input: AuthorityDismissRedeemInput
): Promise<AuthorityDismissRedeemResult> {
  const requestId = cleanText(input.requestId);
  if (!requestId) throw new Error('requestId is required.');

  const idempotencyKey = cleanText(input.idempotencyKey) || requestId;
  const operationKey = `game_request_dismiss:${requestId}:${idempotencyKey}`;
  const linkedTaskId = `request__${requestId}`;

  logAuthPayloadPreTxnRemoved('dismiss_redeem');
  const db = getPlayerMirrorPool();
  if (!db) throw new Error('SQL authority unavailable.');

  const ownsTransaction = !input.txnClient;
  const client = input.txnClient ?? (await db.connect());
  try {
    if (ownsTransaction) {
      await client.query('BEGIN');
    }
    const claim = await claimAuthorityOperation(client, {
      operationKey,
      operationType: 'game_request_dismiss',
      userUid: input.actorUid,
      sourceId: requestId,
      actorUid: input.actorUid,
      actorRole: input.actorRole,
      payload: {},
    });
    if (!claim.claimed) {
      const payload = await readAuthorityOperationPayloadWithClient(client, operationKey, {
        flowName: 'dismiss_redeem',
      });
      if (ownsTransaction) {
        await client.query('ROLLBACK');
      }
      if (payload?.requestId) {
        return {
          success: true,
          duplicate: true,
          alreadyDismissed: payload.alreadyDismissed === true,
          refunded: payload.refunded === true,
          refundAmount: Math.max(0, Number(payload.refundAmount || 0)) || undefined,
          requestId,
          linkedTaskId,
          taskDeleted: payload.taskDeleted === true,
        };
      }
      throw new Error('Duplicate dismiss in progress.');
    }

    const requestResult = await client.query(
      `
        SELECT *
        FROM public.player_game_requests_cache
        WHERE firebase_id = $1 AND deleted_at IS NULL
        FOR UPDATE
      `,
      [requestId]
    );
    if (!requestResult.rows.length) throw new Error('Request not found.');
    const request = requestResult.rows[0] as Record<string, unknown>;
    if (cleanText(request.type).toLowerCase() !== 'redeem') {
      throw new Error('Only redeem requests can be dismissed.');
    }

    const playerUid = cleanText(request.player_uid);
    if (!playerUid) throw new Error('Request player not found.');

    const playerResult = await client.query(
      `
        SELECT uid, role, coadmin_uid, created_by
        FROM public.players_cache
        WHERE uid = $1 AND deleted_at IS NULL
        FOR UPDATE
      `,
      [playerUid]
    );
    if (!playerResult.rows.length) throw new Error('Player not found.');
    const player = playerResult.rows[0] as Record<string, unknown>;
    if (cleanText(player.role).toLowerCase() !== 'player') {
      throw new Error('Request player not found.');
    }

    const requestScope =
      cleanText(request.coadmin_uid) || cleanText(request.created_by);
    const playerScope = cleanText(player.coadmin_uid) || cleanText(player.created_by);
    const canonicalScope = requestScope || playerScope;
    if (!canonicalScope) throw new Error('Request missing scope.');
    if (requestScope && playerScope && requestScope !== playerScope) {
      throw new Error('Forbidden: request is outside your scope.');
    }
    if (!input.isAdmin && (!input.scopeUid || input.scopeUid !== canonicalScope)) {
      throw new Error('Forbidden: request is outside your scope.');
    }

    const taskResult = await client.query(
      `
        SELECT firebase_id, coadmin_uid, request_id
        FROM public.carer_tasks_cache
        WHERE firebase_id = $1 AND deleted_at IS NULL
        FOR UPDATE
      `,
      [linkedTaskId]
    );
    const taskExists = taskResult.rows.length > 0;
    if (taskExists) {
      const task = taskResult.rows[0] as Record<string, unknown>;
      const taskScope = cleanText(task.coadmin_uid);
      if (
        cleanText(task.request_id) !== requestId ||
        (taskScope && taskScope !== canonicalScope)
      ) {
        throw new Error('Forbidden: linked task is outside your scope.');
      }
    }

    const currentStatus = cleanText(request.status).toLowerCase();
    const alreadyDismissed = currentStatus === 'dismissed';
    const alreadyCashRefunded =
      readRawBoolean(request.raw_firestore_data, 'cashRefundedOnDismissal', 'cash_refunded_on_dismissal') ||
      readRawBoolean(request.raw_firestore_data, 'redeemCashRefundedOnDismissal', 'redeem_cash_refunded_on_dismissal');
    if (!alreadyDismissed && !DISMISSIBLE_REDEEM_STATUSES.has(currentStatus)) {
      throw new Error('Redeem request is not dismissible.');
    }

    const nowIso = new Date().toISOString();
    const dismissType = cleanText(input.dismissType) || 'carer_manual';
    const dismissedByAutomation = input.dismissedByAutomation === true;
    const dismissReasonCode = cleanText(input.dismissReasonCode) || null;
    const dismissReasonMessage = cleanText(input.dismissReasonMessage) || null;
    const cashDeductedOnRequest =
      readRawBoolean(request.raw_firestore_data, 'cashDeductedOnRequest', 'cash_deducted_on_request') ||
      readRawBoolean(request.raw_firestore_data, 'redeemCashDeductedOnRequest', 'redeem_cash_deducted_on_request');
    const deductedAmount = Math.max(0, Number(request.amount || 0));
    const shouldRefundCash =
      input.refundCashOnDismissal === true &&
      cashDeductedOnRequest &&
      !alreadyCashRefunded &&
      deductedAmount > 0;
    let refunded = false;
    let refundAmount = 0;
    const pokeMessage =
      cleanText(input.pokeMessage) ||
      (dismissedByAutomation && input.fakeRedeem === true
        ? buildFakeRedeemPlayerMessage({ rawMessage: dismissReasonMessage || dismissReasonCode })
        : dismissedByAutomation
          ? buildPlayerRedeemDismissMessage(dismissReasonMessage || dismissReasonCode)
          : null);
    const requestRaw = {
      ...(request.raw_firestore_data as Record<string, unknown>),
      status: 'dismissed',
      completedAt: nowIso,
      ttlExpiresAt: ttlAfterDaysIso(90),
      pokedAt: null,
      pokeMessage,
      dismissType,
      dismissedByAutomation,
      dismissReasonCode,
      dismissReasonMessage,
      dismissReason: dismissReasonMessage || dismissReasonCode,
      fakeRedeem: input.fakeRedeem === true,
      fakeRedeemReason: dismissReasonMessage || dismissReasonCode,
      cashRefundedOnDismissal: shouldRefundCash ? true : alreadyCashRefunded,
      cashRefundedOnDismissalAt: shouldRefundCash ? nowIso : readRawField(request.raw_firestore_data, 'cashRefundedOnDismissalAt'),
      automationStatus: dismissedByAutomation ? 'dismissed' : cleanText(request.automation_status) || null,
      automationError: dismissedByAutomation ? dismissReasonMessage || dismissReasonCode : null,
      retryPending: false,
      updatedAt: nowIso,
    };
    await upsertGameRequestCacheInTxn(client, requestId, {
      ...requestRaw,
      playerUid,
      playerUsername: cleanText(request.player_username),
      coadminUid: canonicalScope,
      gameName: cleanText(request.game_name),
      type: 'redeem',
      status: 'dismissed',
      dismissType,
      dismissedByAutomation,
      dismissReasonCode,
      dismissReasonMessage,
      dismissReason: dismissReasonMessage || dismissReasonCode,
      pokeMessage,
      automationStatus: dismissedByAutomation ? 'dismissed' : cleanText(request.automation_status) || null,
      automationError: dismissedByAutomation ? dismissReasonMessage || dismissReasonCode : cleanText(request.automation_error) || null,
      retryPending: false,
      completedAt: nowIso,
      ttlExpiresAt: ttlAfterDaysIso(90),
      source: dismissedByAutomation && input.fakeRedeem === true ? 'authority_dismiss_fake_redeem' : 'authority_dismiss_redeem',
      rawFirestoreData: requestRaw,
    });

    if (taskExists && input.skipTaskTombstone !== true) {
      await tombstoneLinkedCarerTaskInTxn(client, requestId, 'authority_dismiss_redeem');
    }

    if (shouldRefundCash) {
      const refundKey = `game_request_redeem_refund:${requestId}:${idempotencyKey}`;
      const refundClaim = await claimAuthorityOperation(client, {
        operationKey: refundKey,
        operationType: 'game_request_redeem_refund',
        userUid: playerUid,
        sourceId: requestId,
        actorUid: input.actorUid,
        actorRole: input.actorRole,
        payload: {},
      });
      if (refundClaim.claimed) {
        const balanceResult = await client.query(
          `
            SELECT uid, username, cash, raw_firestore_data
            FROM public.players_cache
            WHERE uid = $1 AND deleted_at IS NULL
            FOR UPDATE
          `,
          [playerUid]
        );
        if (!balanceResult.rows.length) throw new Error('Player not found.');
        const balancePlayer = balanceResult.rows[0] as Record<string, unknown>;
        const currentCash = readPlayerCash(balancePlayer);
        const newCash = currentCash + deductedAmount;
        await updatePlayerBalancesInTxn(client, playerUid, { cash: newCash });
        const eventId = randomUUID();
        const financialRaw = {
          playerUid,
          coadminUid: canonicalScope,
          amountNpr: deductedAmount,
          type: 'redeem_refund',
          requestId,
          createdAt: nowIso,
        };
        await insertFinancialEventInTxn(client, {
          eventId,
          playerUid,
          coadminUid: canonicalScope,
          amountNpr: deductedAmount,
          type: 'redeem_refund',
          requestId,
          beforeCash: currentCash,
          afterCash: newCash,
          createdAt: nowIso,
          source: 'authority_dismiss_redeem',
        });
        await insertAuthorityLedgerEvent(client, {
          eventKey: `financialEvents:${eventId}:${playerUid}:cash:redeem_refund_cash_credit`,
          userUid: playerUid,
          username: cleanText(balancePlayer.username) || 'Player',
          role: 'player',
          coadminUid: canonicalScope,
          balanceType: 'cash',
          direction: 'credit',
          delta: deductedAmount,
          absoluteAfter: newCash,
          eventType: 'redeem_refund_cash_credit',
          sourceCollection: 'financialEvents',
          sourceId: eventId,
          actorUid: input.actorUid,
          actorRole: input.actorRole,
          confidence: 'high',
          sourceCreatedAt: nowIso,
          rawSourceData: financialRaw,
          sourceFields: { amount: deductedAmount, requestId },
        });
        refunded = true;
        refundAmount = deductedAmount;
      }
    }

    if (pokeMessage) {
      const outcomeSource =
        dismissedByAutomation && input.fakeRedeem === true
          ? 'authority_dismiss_fake_redeem'
          : 'authority_dismiss_redeem';
      const dismissAdditionalRows: LiveOutboxInsertInput[] = [];
      if (refunded) {
        dismissAdditionalRows.push({
          channel: playerRequestLiveChannel(playerUid),
          eventType: 'balance_update',
          entityType: 'player_balance',
          entityId: playerUid,
          source: outcomeSource,
          mirroredAt: nowIso,
          payload: {
            entityId: playerUid,
            playerUid,
            updatedAt: nowIso,
            source: 'authority',
            refunded: true,
            requestId,
          },
        });
      }
      await emitPlayerRequestOutcomeMessage(client, {
        playerUid,
        coadminUid: canonicalScope,
        requestId,
        requestType: 'redeem',
        outcomeType: 'redeem_dismissed',
        status: 'dismissed',
        gameName: cleanText(request.game_name),
        amount: Math.max(0, Number(request.amount || 0)),
        updatedAt: nowIso,
        message: pokeMessage,
        toastVariant: 'error',
        dismissReasonCode,
        dismissReasonMessage,
        refunded,
        source: outcomeSource,
        additionalOutboxRows: dismissAdditionalRows,
        outboxFlowName: 'dismiss_redeem',
      });
    }
    if (taskExists && input.skipTaskTombstone !== true) {
      await writeCarerTaskOutboxInTxn(client, {
        coadminUid: canonicalScope,
        taskId: linkedTaskId,
        requestId,
        status: 'deleted',
        type: 'redeem',
        playerUid,
        gameName: cleanText(request.game_name),
        amount: Math.max(0, Number(request.amount || 0)),
        eventType: 'task.tombstoned',
        updatedAt: nowIso,
        outboxFlowName: 'dismiss_redeem_task_tombstone',
      });
    }

    await client.query(`UPDATE public.authority_operations SET payload = $2::jsonb WHERE operation_key = $1`, [
      operationKey,
      JSON.stringify({
        requestId,
        alreadyDismissed,
        refunded,
        refundAmount: refunded ? refundAmount : 0,
        taskDeleted: taskExists,
      }),
    ]);
    if (ownsTransaction) {
      await client.query('COMMIT');
    }
    return {
      success: true,
      duplicate: false,
      alreadyDismissed,
      refunded,
      refundAmount: refunded ? refundAmount : undefined,
      requestId,
      linkedTaskId,
      taskDeleted: taskExists,
    };
  } catch (error) {
    if (ownsTransaction) {
      await client.query('ROLLBACK');
    }
    throw error;
  } finally {
    if (ownsTransaction) {
      client.release();
    }
  }
}
