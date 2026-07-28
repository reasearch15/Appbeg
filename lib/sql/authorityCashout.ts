import 'server-only';

import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';

import { evaluateWithdrawalPolicy } from '@/lib/economy/policy';
import { getCoadminMaintenanceBreak } from '@/lib/maintenance/admin';
import { CashoutClaimConflictError } from '@/lib/cashouts/playerCashoutClaimConflict';
import { cleanText, getPlayerMirrorPool, toIsoString } from '@/lib/sql/playerMirrorCommon';
import {
  claimAuthorityOperation,
  insertAuthorityLedgerEvent,
  logAuthPayloadPreTxnRemoved,
  readAuthorityOperationPayloadWithClient,
} from '@/lib/sql/authorityLedger';
import {
  readPlayerCashoutTasksCacheByCoadmin,
} from '@/lib/sql/playerCashoutTasksCache';
import {
  coadminCashoutLiveChannel,
  insertLiveOutboxEventWithClient,
  playerCashoutLiveChannel,
  playerRequestLiveChannel,
} from '@/lib/sql/liveOutbox';
import {
  isVendorLinked,
  mergeVendorIntoRawFirestoreData,
  readStoredVendorFieldsFromRow,
  storedVendorFieldsFromAwareness,
  vendorAwarenessFromStoredFields,
} from '@/lib/sql/vendorCashoutAttribution';
import { resolveVendorAwarenessForPlayerUid } from '@/lib/sql/vendorOwnershipRead';
import { reportVendorCashoutCompletedToLedger } from '@/lib/sql/vendorCashoutLedger';

export const PLAYER_CASHOUT_MAX_NPR_PER_24_H = 1000;
const PLAYER_CASHOUT_ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;

export type AuthorityCashoutCreateInput = {
  playerUid: string;
  playerUsername?: string | null;
  paymentDetails: string;
  payoutMethod?: string | null;
  qrImageUrl?: string | null;
  paymentAppName?: string | null;
  paymentAppCashTag?: string | null;
  paymentAppAccountName?: string | null;
  reuseLastPaymentDetails?: boolean;
  idempotencyKey?: string | null;
  requestedCoadminUid?: string | null;
};

export type AuthorityCashoutCreateResult = {
  success: true;
  duplicate: boolean;
  taskId: string;
};

type ResolvedCashoutPaymentDetails = {
  paymentDetails: string;
  payoutMethod: 'qr' | 'app';
  qrImageUrl: string | null;
  paymentAppName: string | null;
  paymentAppCashTag: string | null;
  paymentAppAccountName: string | null;
  reusedFromCashoutTaskId: string | null;
};

export type AuthorityCashoutCompleteInput = {
  taskId: string;
  actorUid: string;
  actorUsername?: string | null;
  actorRole: string;
  isAdmin: boolean;
  scopeUid: string | null;
  idempotencyKey?: string | null;
};

export type AuthorityCashoutCompleteResult = {
  success: true;
  duplicate: boolean;
  alreadyCompleted: boolean;
  taskId: string;
};

export type AuthorityCashoutDeclineInput = {
  taskId: string;
  actorUid: string;
  actorRole: string;
  isAdmin: boolean;
  scopeUid: string | null;
  idempotencyKey?: string | null;
};

export type AuthorityCashoutDeclineResult = {
  success: true;
  duplicate: boolean;
  taskId: string;
  refunded: boolean;
};

export type AuthorityCashoutStartInput = {
  taskId: string;
  actorUid: string;
  actorUsername?: string | null;
  actorRole: string;
  isAdmin: boolean;
  scopeUid: string | null;
};

export type AuthorityCashoutStartResult = {
  success: true;
  duplicate: boolean;
  taskId: string;
  expiresAtMs: number;
};

export type AuthorityCashoutReleaseInput = {
  taskId: string;
  actorUid: string;
  actorRole: string;
  isAdmin: boolean;
  scopeUid: string | null;
  reason?: 'manual' | 'timeout';
};

export type AuthorityCashoutReleaseResult = {
  success: true;
  duplicate: boolean;
  taskId: string;
  released: boolean;
};

const CASHOUT_TASK_DURATION_MS = 3 * 60 * 1000;

function cashoutClaimConflictFromTaskRow(taskId: string, task: Record<string, unknown>) {
  return new CashoutClaimConflictError({
    taskId,
    status: cleanText(task.status) || 'pending',
    claimedByUid: cleanText(task.assigned_handler_uid) || null,
    claimedAt: toIsoString(task.started_at),
  });
}

function ttlAfterDays(days: number) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function buildPaymentDetails(input: {
  payoutMethod: string | null;
  qrImageUrl: string | null;
  paymentAppName: string | null;
  paymentAppCashTag: string | null;
  paymentAppAccountName: string | null;
}) {
  if (input.payoutMethod === 'qr') {
    return input.qrImageUrl ? `Payout method: QR\nQR image: ${input.qrImageUrl}` : '';
  }
  if (input.payoutMethod === 'app') {
    return [
      'Payout method: Payment app',
      input.paymentAppName ? `App name: ${input.paymentAppName}` : '',
      input.paymentAppCashTag ? `Cash tag: ${input.paymentAppCashTag}` : '',
      input.paymentAppAccountName ? `Name on app: ${input.paymentAppAccountName}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function normalizePayoutMethod(value: unknown): 'qr' | 'app' | null {
  const raw = cleanText(value).toLowerCase();
  if (raw === 'qr') return 'qr';
  if (raw === 'app' || raw === 'payment app' || raw === 'payment_app') return 'app';
  return null;
}

function parsePaymentDetailsText(rawText: string): {
  payoutMethod: 'qr' | 'app' | null;
  qrImageUrl: string | null;
  paymentAppName: string | null;
  paymentAppCashTag: string | null;
  paymentAppAccountName: string | null;
} {
  const text = cleanText(rawText);
  if (/Payout method:\s*QR/i.test(text)) {
    const qrMatch = text.match(/QR image:\s*(.+)/i);
    return {
      payoutMethod: 'qr',
      qrImageUrl: cleanText(qrMatch?.[1]) || null,
      paymentAppName: null,
      paymentAppCashTag: null,
      paymentAppAccountName: null,
    };
  }
  if (/Payout method:\s*Payment app/i.test(text)) {
    const appNameMatch = text.match(/App name:\s*(.+)/i);
    const cashTagMatch = text.match(/Cash tag:\s*(.+)/i);
    const accountNameMatch = text.match(/Name on app:\s*(.+)/i);
    return {
      payoutMethod: 'app',
      qrImageUrl: null,
      paymentAppName: cleanText(appNameMatch?.[1]) || null,
      paymentAppCashTag: cleanText(cashTagMatch?.[1]) || null,
      paymentAppAccountName: cleanText(accountNameMatch?.[1]) || null,
    };
  }
  return {
    payoutMethod: null,
    qrImageUrl: null,
    paymentAppName: null,
    paymentAppCashTag: null,
    paymentAppAccountName: null,
  };
}

function resolveUsablePaymentDetails(input: {
  payoutMethod?: unknown;
  qrImageUrl?: unknown;
  paymentAppName?: unknown;
  paymentAppCashTag?: unknown;
  paymentAppAccountName?: unknown;
  paymentDetails?: unknown;
}): ResolvedCashoutPaymentDetails | null {
  let payoutMethod = normalizePayoutMethod(input.payoutMethod);
  let qrImageUrl = cleanText(input.qrImageUrl) || null;
  let paymentAppName = cleanText(input.paymentAppName) || null;
  let paymentAppCashTag = cleanText(input.paymentAppCashTag) || null;
  let paymentAppAccountName = cleanText(input.paymentAppAccountName) || null;
  const parsed = parsePaymentDetailsText(String(input.paymentDetails || ''));

  if (!payoutMethod) {
    payoutMethod = parsed.payoutMethod;
  }
  if (payoutMethod === 'qr') {
    qrImageUrl = qrImageUrl || parsed.qrImageUrl;
  }
  if (payoutMethod === 'app') {
    paymentAppName = paymentAppName || parsed.paymentAppName;
    paymentAppCashTag = paymentAppCashTag || parsed.paymentAppCashTag;
    paymentAppAccountName = paymentAppAccountName || parsed.paymentAppAccountName;
  }

  if (payoutMethod === 'qr' && qrImageUrl) {
    const paymentDetails = buildPaymentDetails({
      payoutMethod: 'qr',
      qrImageUrl,
      paymentAppName: null,
      paymentAppCashTag: null,
      paymentAppAccountName: null,
    });
    if (paymentDetails.length < 5) return null;
    return {
      paymentDetails,
      payoutMethod: 'qr',
      qrImageUrl,
      paymentAppName: null,
      paymentAppCashTag: null,
      paymentAppAccountName: null,
      reusedFromCashoutTaskId: null,
    };
  }

  if (
    payoutMethod === 'app' &&
    paymentAppName &&
    paymentAppCashTag &&
    paymentAppAccountName
  ) {
    const paymentDetails = buildPaymentDetails({
      payoutMethod: 'app',
      qrImageUrl: null,
      paymentAppName,
      paymentAppCashTag,
      paymentAppAccountName,
    });
    if (paymentDetails.length < 5) return null;
    return {
      paymentDetails,
      payoutMethod: 'app',
      qrImageUrl: null,
      paymentAppName,
      paymentAppCashTag,
      paymentAppAccountName,
      reusedFromCashoutTaskId: null,
    };
  }

  return null;
}

function assertPaymentDetailsForPayoutMethod(input: {
  payoutMethod: string | null;
  qrImageUrl: string | null;
  paymentAppName: string | null;
  paymentAppCashTag: string | null;
  paymentAppAccountName: string | null;
  paymentDetails: string;
}) {
  const method = normalizePayoutMethod(input.payoutMethod);
  if (method === 'qr') {
    if (!cleanText(input.qrImageUrl)) {
      throw new Error('Upload your QR before sending cashout.');
    }
    return;
  }
  if (method === 'app') {
    if (
      !cleanText(input.paymentAppName) ||
      !cleanText(input.paymentAppCashTag) ||
      !cleanText(input.paymentAppAccountName)
    ) {
      throw new Error('Enter your payment app name, cash tag, and name on the app.');
    }
    return;
  }
  if (cleanText(input.paymentDetails).length < 5) {
    throw new Error('Please provide clear payment details.');
  }
}

async function resolveLastCashoutPaymentDetailsWithClient(
  client: PoolClient,
  playerUid: string
): Promise<ResolvedCashoutPaymentDetails | null> {
  const result = await client.query(
    `
      SELECT
        firebase_id,
        payout_method,
        qr_image_url,
        payment_app_name,
        payment_app_cash_tag,
        payment_app_account_name,
        payment_details
      FROM public.player_cashout_tasks_cache
      WHERE deleted_at IS NULL
        AND player_uid = $1::text
        AND LOWER(COALESCE(status, '')) NOT IN ('declined', 'cancelled', 'failed')
      ORDER BY COALESCE(completed_at, created_at) DESC NULLS LAST, created_at DESC NULLS LAST
      LIMIT 25
    `,
    [playerUid]
  );

  for (const row of result.rows as Array<Record<string, unknown>>) {
    const resolved = resolveUsablePaymentDetails({
      payoutMethod: row.payout_method,
      qrImageUrl: row.qr_image_url,
      paymentAppName: row.payment_app_name,
      paymentAppCashTag: row.payment_app_cash_tag,
      paymentAppAccountName: row.payment_app_account_name,
      paymentDetails: row.payment_details,
    });
    if (!resolved) {
      continue;
    }
    return {
      ...resolved,
      reusedFromCashoutTaskId: cleanText(row.firebase_id) || null,
    };
  }

  return null;
}

function readRawField(raw: unknown, field: string) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return (raw as Record<string, unknown>)[field];
}

function readCashBoxNpr(snapshot: Record<string, unknown>, playerRow?: Record<string, unknown>) {
  const fromSnapshot = Number(snapshot.cash_box_npr);
  if (Number.isFinite(fromSnapshot)) return Math.max(0, fromSnapshot);
  const raw = playerRow?.raw_firestore_data ?? snapshot.raw_firestore_data;
  const fromRaw = Number(readRawField(raw, 'cashBoxNpr'));
  return Number.isFinite(fromRaw) ? Math.max(0, fromRaw) : 0;
}

function readRewardBlocked(snapshot: Record<string, unknown>, playerRow?: Record<string, unknown>) {
  if (typeof snapshot.reward_blocked === 'boolean') return snapshot.reward_blocked;
  const raw = playerRow?.raw_firestore_data ?? snapshot.raw_firestore_data;
  return readRawField(raw, 'rewardBlocked') === true;
}

async function fetchRolling24hCashoutUsageNpr(
  client: PoolClient,
  playerUid: string,
  requestedAmount: number | null = null
) {
  const cutoffIso = new Date(Date.now() - PLAYER_CASHOUT_ROLLING_WINDOW_MS).toISOString();
  console.info('[CASHOUT_24H_LIMIT_QUERY_PARAMS]', {
    playerUid,
    cutoffIso,
    requestedAmount,
  });
  const result = await client.query(
    `
      SELECT COALESCE(SUM(amount_npr), 0)::numeric AS total
      FROM public.player_cashout_tasks_cache
      WHERE player_uid = $1::text
        AND deleted_at IS NULL
        AND created_at >= NOW() - INTERVAL '24 hours'
        AND LOWER(COALESCE(status, '')) NOT IN ('declined', 'cancelled', 'failed')
    `,
    [playerUid]
  );
  return Math.max(0, Number(result.rows[0]?.total || 0));
}

export async function isPlayerCashoutRollingLimitHit(client: PoolClient, playerUid: string) {
  const rollingUsed = await fetchRolling24hCashoutUsageNpr(client, playerUid);
  return rollingUsed >= PLAYER_CASHOUT_MAX_NPR_PER_24_H;
}

async function fetchCompletedCashoutCount(client: PoolClient, playerUid: string) {
  const result = await client.query(
    `
      SELECT COUNT(*)::int AS count
      FROM public.player_cashout_tasks_cache
      WHERE player_uid = $1::text
        AND deleted_at IS NULL
        AND status = 'completed'
    `,
    [playerUid]
  );
  return Number(result.rows[0]?.count || 0);
}

async function fetchLatestCompletedRechargeAmount(client: PoolClient, playerUid: string) {
  const result = await client.query(
    `
      SELECT amount, base_amount, completed_at
      FROM public.player_game_requests_cache
      WHERE player_uid = $1::text
        AND deleted_at IS NULL
        AND type = 'recharge'
        AND status = 'completed'
      ORDER BY completed_at DESC NULLS LAST
      LIMIT 1
    `,
    [playerUid]
  );
  if (!result.rows.length) return 0;
  const row = result.rows[0] as Record<string, unknown>;
  return Math.max(0, Math.round(Number(row.base_amount ?? row.amount ?? 0)));
}

async function upsertCashoutTaskCache(client: PoolClient, taskId: string, input: Record<string, unknown>) {
  const raw = (input.rawFirestoreData || input) as Record<string, unknown>;
  await client.query(
    `
      INSERT INTO public.player_cashout_tasks_cache (
        firebase_id, coadmin_uid, player_uid, player_username, amount_npr,
        payment_details, payout_method, qr_image_url, payment_app_name,
        payment_app_cash_tag, payment_app_account_name, cash_deducted_on_request,
        status, assigned_handler_uid, assigned_handler_username,
        cashout_requested_by_staff_id, reward_npr_applied,
        reward_blocked_applied, declined_by_uids, started_at, expires_at,
        created_at, completed_at, source, mirrored_at, deleted_at,
        vendor_id, vendor_code, vendor_name, vendor_status,
        vendor_linked_staff_uid, vendor_ownership_date, vendor_resolved_at,
        raw_firestore_data
      )
      VALUES (
        $1::text, NULLIF($2::text, ''), NULLIF($3::text, ''), NULLIF($4::text, ''), $5::numeric,
        NULLIF($6::text, ''), NULLIF($7::text, ''), NULLIF($8::text, ''), NULLIF($9::text, ''),
        NULLIF($10::text, ''), NULLIF($11::text, ''), $12::boolean, NULLIF($13::text, ''),
        NULLIF($14::text, ''), NULLIF($15::text, ''), NULLIF($16::text, ''), $17::numeric,
        $18::boolean, $19::jsonb, $20::timestamptz, $21::timestamptz,
        $22::timestamptz, $23::timestamptz, $24::text, now(), NULL,
        $25::bigint, NULLIF($26::text, ''), NULLIF($27::text, ''), NULLIF($28::text, ''),
        NULLIF($29::text, ''), $30::timestamptz, $31::timestamptz,
        $32::jsonb
      )
      ON CONFLICT (firebase_id) DO UPDATE SET
        coadmin_uid = EXCLUDED.coadmin_uid,
        player_uid = EXCLUDED.player_uid,
        player_username = EXCLUDED.player_username,
        amount_npr = EXCLUDED.amount_npr,
        payment_details = EXCLUDED.payment_details,
        payout_method = EXCLUDED.payout_method,
        qr_image_url = EXCLUDED.qr_image_url,
        payment_app_name = EXCLUDED.payment_app_name,
        payment_app_cash_tag = EXCLUDED.payment_app_cash_tag,
        payment_app_account_name = EXCLUDED.payment_app_account_name,
        cash_deducted_on_request = EXCLUDED.cash_deducted_on_request,
        status = EXCLUDED.status,
        assigned_handler_uid = EXCLUDED.assigned_handler_uid,
        assigned_handler_username = EXCLUDED.assigned_handler_username,
        cashout_requested_by_staff_id = EXCLUDED.cashout_requested_by_staff_id,
        reward_npr_applied = EXCLUDED.reward_npr_applied,
        reward_blocked_applied = EXCLUDED.reward_blocked_applied,
        declined_by_uids = EXCLUDED.declined_by_uids,
        started_at = EXCLUDED.started_at,
        expires_at = EXCLUDED.expires_at,
        created_at = COALESCE(public.player_cashout_tasks_cache.created_at, EXCLUDED.created_at),
        completed_at = EXCLUDED.completed_at,
        source = EXCLUDED.source,
        mirrored_at = now(),
        deleted_at = NULL,
        vendor_id = COALESCE(EXCLUDED.vendor_id, public.player_cashout_tasks_cache.vendor_id),
        vendor_code = COALESCE(NULLIF(EXCLUDED.vendor_code, ''), public.player_cashout_tasks_cache.vendor_code),
        vendor_name = COALESCE(NULLIF(EXCLUDED.vendor_name, ''), public.player_cashout_tasks_cache.vendor_name),
        vendor_status = COALESCE(NULLIF(EXCLUDED.vendor_status, ''), public.player_cashout_tasks_cache.vendor_status),
        vendor_linked_staff_uid = COALESCE(
          NULLIF(EXCLUDED.vendor_linked_staff_uid, ''),
          public.player_cashout_tasks_cache.vendor_linked_staff_uid
        ),
        vendor_ownership_date = COALESCE(
          EXCLUDED.vendor_ownership_date,
          public.player_cashout_tasks_cache.vendor_ownership_date
        ),
        vendor_resolved_at = COALESCE(
          EXCLUDED.vendor_resolved_at,
          public.player_cashout_tasks_cache.vendor_resolved_at
        ),
        raw_firestore_data = EXCLUDED.raw_firestore_data
    `,
    [
      taskId,
      cleanText(input.coadminUid),
      cleanText(input.playerUid),
      cleanText(input.playerUsername),
      Number(input.amountNpr ?? 0),
      cleanText(input.paymentDetails),
      cleanText(input.payoutMethod),
      cleanText(input.qrImageUrl),
      cleanText(input.paymentAppName),
      cleanText(input.paymentAppCashTag),
      cleanText(input.paymentAppAccountName),
      input.cashDeductedOnRequest === true,
      cleanText(input.status),
      cleanText(input.assignedHandlerUid),
      cleanText(input.assignedHandlerUsername),
      cleanText(input.cashoutRequestedByStaffId),
      input.rewardNprApplied == null ? null : Number(input.rewardNprApplied),
      typeof input.rewardBlockedApplied === 'boolean' ? input.rewardBlockedApplied : null,
      JSON.stringify(Array.isArray(input.declinedByUids) ? input.declinedByUids : []),
      toIsoString(input.startedAt),
      toIsoString(input.expiresAt),
      toIsoString(input.createdAt),
      toIsoString(input.completedAt),
      cleanText(input.source) || 'authority',
      input.vendorId == null || input.vendorId === ''
        ? null
        : Number.isFinite(Number(input.vendorId))
          ? Math.trunc(Number(input.vendorId))
          : null,
      cleanText(input.vendorCode),
      cleanText(input.vendorName),
      cleanText(input.vendorStatus),
      cleanText(input.vendorLinkedStaffUid),
      toIsoString(input.vendorOwnershipDate),
      toIsoString(input.vendorResolvedAt),
      JSON.stringify(raw),
    ]
  );
}

async function updateBalances(
  client: PoolClient,
  uid: string,
  input: { cash?: number; coin?: number; cashBoxNpr?: number }
) {
  const nowIso = new Date().toISOString();
  if (input.cash != null) {
    await client.query(
      `
        UPDATE public.players_cache
        SET
          cash = $2::numeric,
          updated_at = $3::timestamptz,
          raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb) || jsonb_build_object('cash', $2::numeric)
        WHERE uid = $1::text AND deleted_at IS NULL
      `,
      [uid, input.cash, nowIso]
    );
    await client.query(
      `
        UPDATE public.user_balance_snapshots_cache
        SET
          cash = $2::numeric,
          updated_at = $3::timestamptz,
          mirrored_at = now(),
          raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb) || jsonb_build_object('cash', $2::numeric)
        WHERE firebase_id = $1::text AND deleted_at IS NULL
      `,
      [uid, input.cash, nowIso]
    );
  }
  if (input.cashBoxNpr != null) {
    await client.query(
      `
        UPDATE public.user_balance_snapshots_cache
        SET
          cash_box_npr = $2::numeric,
          updated_at = $3::timestamptz,
          mirrored_at = now(),
          raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb) || jsonb_build_object('cashBoxNpr', $2::numeric)
        WHERE firebase_id = $1::text AND deleted_at IS NULL
      `,
      [uid, input.cashBoxNpr, nowIso]
    );
    await client.query(
      `
        UPDATE public.players_cache
        SET
          updated_at = $3::timestamptz,
          raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb) || jsonb_build_object('cashBoxNpr', $2::numeric)
        WHERE uid = $1::text AND deleted_at IS NULL
      `,
      [uid, input.cashBoxNpr, nowIso]
    );
  }
}

async function writeCashoutOutbox(
  client: PoolClient,
  input: {
    playerUid: string;
    coadminUid: string;
    taskId: string;
    status: string;
    amountNpr: number;
    eventType: string;
    updatedAt: string;
  }
) {
  const payload = {
    entityId: input.taskId,
    taskId: input.taskId,
    playerUid: input.playerUid,
    coadminUid: input.coadminUid,
    status: input.status,
    amountNpr: input.amountNpr,
    createdAt: input.updatedAt,
    updatedAt: input.updatedAt,
    source: 'authority',
  };
  await insertLiveOutboxEventWithClient(client, {
    channel: playerCashoutLiveChannel(input.playerUid),
    eventType: input.eventType,
    entityType: 'player_cashout_task',
    entityId: input.taskId,
    source: 'authority_cashout',
    mirroredAt: input.updatedAt,
    payload,
  });
  await insertLiveOutboxEventWithClient(client, {
    channel: coadminCashoutLiveChannel(input.coadminUid),
    eventType: input.eventType,
    entityType: 'player_cashout_task',
    entityId: input.taskId,
    source: 'authority_cashout',
    mirroredAt: input.updatedAt,
    payload,
  });
  console.info('[CASHOUT_TASK_LIVE] emitted', {
    taskId: input.taskId,
    coadminUid: input.coadminUid,
    playerUid: input.playerUid,
    eventType: input.eventType,
    status: input.status,
  });
}

async function writeCashoutBalanceOutbox(
  client: PoolClient,
  input: {
    playerUid: string;
    taskId: string;
    cash: number;
    coin: number;
    updatedAt: string;
  }
) {
  await insertLiveOutboxEventWithClient(client, {
    channel: playerRequestLiveChannel(input.playerUid),
    eventType: 'balance_update',
    entityType: 'player_balance',
    entityId: input.playerUid,
    source: 'authority_cashout_create',
    mirroredAt: input.updatedAt,
    payload: {
      entityId: input.playerUid,
      playerUid: input.playerUid,
      cash: input.cash,
      coin: input.coin,
      reason: 'cashout_request_deduct',
      cashoutTaskId: input.taskId,
      updatedAt: input.updatedAt,
      source: 'authority',
    },
  });
  console.info('[CASHOUT_BALANCE_OUTBOX_EVENT_CREATED]', {
    taskId: input.taskId,
    playerUid: input.playerUid,
    eventType: 'balance_update',
    channel: playerRequestLiveChannel(input.playerUid),
    reason: 'cashout_request_deduct',
    cash: input.cash,
    coin: input.coin,
  });
}

export async function createPlayerCashoutTaskInSql(
  input: AuthorityCashoutCreateInput
): Promise<AuthorityCashoutCreateResult> {
  const playerUid = cleanText(input.playerUid);
  const reuseLastPaymentDetails = input.reuseLastPaymentDetails === true;
  let paymentDetails = cleanText(input.paymentDetails);
  let payoutMethod = cleanText(input.payoutMethod) || null;
  let qrImageUrl = cleanText(input.qrImageUrl) || null;
  let paymentAppName = cleanText(input.paymentAppName) || null;
  let paymentAppCashTag = cleanText(input.paymentAppCashTag) || null;
  let paymentAppAccountName = cleanText(input.paymentAppAccountName) || null;
  let reusedFromCashoutTaskId: string | null = null;
  const idempotencyKey = cleanText(input.idempotencyKey);
  console.info('[CASHOUT_CREATE_START]', {
    playerUid,
    requestedCoadminUid: cleanText(input.requestedCoadminUid) || null,
    reuseLastPaymentDetails,
  });
  if (!playerUid) throw new Error('Player profile not found.');

  const resolvedIdempotencyKey = idempotencyKey || randomUUID();
  const operationKey = `cashout_create:${playerUid}:${resolvedIdempotencyKey}`;

  logAuthPayloadPreTxnRemoved('cashout_create');
  const db = getPlayerMirrorPool();
  if (!db) throw new Error('Postgres is unavailable.');

  const taskId = randomUUID();
  const eventId = randomUUID();
  const nowIso = new Date().toISOString();

  // Resolve vendor before the DB transaction so we never hold locks across HTTP.
  const vendorAwareness = await resolveVendorAwarenessForPlayerUid(playerUid);
  const vendorFields = storedVendorFieldsFromAwareness(vendorAwareness, nowIso);
  if (!isVendorLinked(vendorFields)) {
    console.warn('[VENDOR_CASHOUT_UNASSIGNED]', {
      phase: 'create',
      taskId,
      playerUid,
      configured: vendorAwareness.configured,
      owned: vendorAwareness.owned,
    });
  }

  const client = await db.connect();

  try {
    await client.query('BEGIN');

    const claim = await claimAuthorityOperation(client, {
      operationKey,
      operationType: 'cashout_create',
      userUid: playerUid,
      sourceId: taskId,
      actorUid: playerUid,
      actorRole: 'player',
      payload: {},
    });
    if (claim.duplicate) {
      const payload = await readAuthorityOperationPayloadWithClient(client, operationKey, {
        flowName: 'cashout_create',
      });
      await client.query('ROLLBACK');
      if (payload?.taskId) {
        return { success: true, duplicate: true, taskId: cleanText(payload.taskId) };
      }
      throw new Error('Duplicate cashout create idempotency conflict.');
    }

    if (reuseLastPaymentDetails) {
      const fromClient = resolveUsablePaymentDetails({
        payoutMethod: input.payoutMethod,
        qrImageUrl: input.qrImageUrl,
        paymentAppName: input.paymentAppName,
        paymentAppCashTag: input.paymentAppCashTag,
        paymentAppAccountName: input.paymentAppAccountName,
        paymentDetails: input.paymentDetails,
      });
      const resolved =
        fromClient || (await resolveLastCashoutPaymentDetailsWithClient(client, playerUid));
      if (!resolved) {
        throw new Error(
          'No previous payment details found. Please upload a QR or enter payment app details first.'
        );
      }
      paymentDetails = resolved.paymentDetails;
      payoutMethod = resolved.payoutMethod;
      qrImageUrl = resolved.qrImageUrl;
      paymentAppName = resolved.paymentAppName;
      paymentAppCashTag = resolved.paymentAppCashTag;
      paymentAppAccountName = resolved.paymentAppAccountName;
      reusedFromCashoutTaskId = resolved.reusedFromCashoutTaskId;
      console.info('[CASHOUT_CREATE_REUSED_PAYMENT_DETAILS]', {
        playerUid,
        reusedFromCashoutTaskId,
        payoutMethod,
        source: fromClient ? 'client_payload' : 'sql_history',
      });
    }

    assertPaymentDetailsForPayoutMethod({
      payoutMethod,
      qrImageUrl,
      paymentAppName,
      paymentAppCashTag,
      paymentAppAccountName,
      paymentDetails,
    });

    const normalizedMethod = normalizePayoutMethod(payoutMethod);
    if (normalizedMethod === 'qr') {
      payoutMethod = 'qr';
      paymentAppName = null;
      paymentAppCashTag = null;
      paymentAppAccountName = null;
    } else if (normalizedMethod === 'app') {
      payoutMethod = 'app';
      qrImageUrl = null;
    }

    if (!paymentDetails) {
      paymentDetails = buildPaymentDetails({
        payoutMethod,
        qrImageUrl,
        paymentAppName,
        paymentAppCashTag,
        paymentAppAccountName,
      });
    }

    const [rollingUsed, completedCashoutCount, lastRechargeAmountNpr] = await Promise.all([
      fetchRolling24hCashoutUsageNpr(client, playerUid),
      fetchCompletedCashoutCount(client, playerUid),
      fetchLatestCompletedRechargeAmount(client, playerUid),
    ]);
    const remainingQuota = Math.max(0, PLAYER_CASHOUT_MAX_NPR_PER_24_H - rollingUsed);

    const playerLock = await client.query(
      `
        SELECT uid, username, role, status, cash, coadmin_uid, created_by
        FROM public.players_cache
        WHERE uid = $1::text AND deleted_at IS NULL
        FOR UPDATE
      `,
      [playerUid]
    );
    if (!playerLock.rows.length) throw new Error('Player profile not found.');
    const player = playerLock.rows[0] as Record<string, unknown>;
    console.info('[CASHOUT_CREATE_PLAYER_PROFILE]', {
      playerUid,
      role: cleanText(player.role),
      cash: Number(player.cash || 0),
      coadminUid: cleanText(player.coadmin_uid) || null,
      createdBy: cleanText(player.created_by) || null,
    });
    if (cleanText(player.role).toLowerCase() !== 'player') {
      throw new Error('Only players can create cashout tasks.');
    }

    const availableCash = Math.max(0, Math.floor(Number(player.cash || 0)));
    if (availableCash <= 0) throw new Error('No cash available to cash out.');

    const amountThisRequest = Math.min(availableCash, remainingQuota);
    const limitPassed = rollingUsed + amountThisRequest <= PLAYER_CASHOUT_MAX_NPR_PER_24_H;
    console.info('[CASHOUT_24H_LIMIT_CHECK]', {
      playerUid,
      requestedAmount: amountThisRequest,
      last24HourTotal: rollingUsed,
      max24HourLimit: PLAYER_CASHOUT_MAX_NPR_PER_24_H,
      remainingLimit: remainingQuota,
      passed: limitPassed && amountThisRequest > 0,
    });
    if (!limitPassed || amountThisRequest <= 0) {
      console.info('[CASHOUT_CREATE_VALIDATION_FAILED]', {
        playerUid,
        reason: 'rolling_24h_max',
        last24HourTotal: rollingUsed,
        requestedAmount: amountThisRequest,
      });
      throw new Error('Maximum withdrawal is 1000 in 24 hours.');
    }

    const decision = evaluateWithdrawalPolicy({
      amountNpr: amountThisRequest,
      completedWithdrawalCount: completedCashoutCount,
      lastRechargeAmountNpr,
    });
    if (!decision.allowed) {
      console.info('[CASHOUT_CREATE_VALIDATION_FAILED]', {
        playerUid,
        reason: decision.code,
        message: decision.message,
      });
      throw new Error(decision.message);
    }

    const coadminUid =
      cleanText(input.requestedCoadminUid) ||
      cleanText(player.coadmin_uid) ||
      cleanText(player.created_by);
    if (!coadminUid) throw new Error('Player coadmin scope not found.');
    console.info('[CASHOUT_CREATE_COADMIN_UID]', {
      playerUid,
      coadminUid,
      requestedCoadminUid: cleanText(input.requestedCoadminUid) || null,
      fromPlayerCache: cleanText(player.coadmin_uid) || null,
      fromCreatedBy: cleanText(player.created_by) || null,
    });

    const maintenanceBreak = await getCoadminMaintenanceBreak(coadminUid);
    if (maintenanceBreak.enabled) {
      console.info('[MAINTENANCE] blocked redeem request', { playerUid, coadminUid });
      throw new Error(`MAINTENANCE_BREAK:${maintenanceBreak.message}`);
    }

    const newCash = availableCash - amountThisRequest;
    await updateBalances(client, playerUid, { cash: newCash });

    const playerUsername =
      cleanText(input.playerUsername) || cleanText(player.username) || 'Player';

    const taskRaw = mergeVendorIntoRawFirestoreData(
      {
        coadminUid,
        playerUid,
        playerUsername,
        amountNpr: amountThisRequest,
        paymentDetails,
        payoutMethod,
        qrImageUrl,
        paymentAppName,
        paymentAppCashTag,
        paymentAppAccountName,
        reusedPaymentDetails: reuseLastPaymentDetails,
        reusedFromCashoutTaskId,
        cashDeductedOnRequest: true,
        status: 'pending',
        assignedHandlerUid: null,
        assignedHandlerUsername: null,
        startedAt: null,
        expiresAt: null,
        createdAt: nowIso,
        completedAt: null,
      },
      vendorFields
    );

    await upsertCashoutTaskCache(client, taskId, {
      ...taskRaw,
      ...vendorFields,
      source: 'authority_cashout_create',
      rawFirestoreData: taskRaw,
    });
    console.info('[CASHOUT_CREATE_INSERT_DONE]', {
      taskId,
      playerUid,
      coadminUid,
      amountNpr: amountThisRequest,
      table: 'player_cashout_tasks_cache',
      status: 'pending',
      payoutMethod,
      vendorId: vendorFields.vendorId,
      vendorCode: vendorFields.vendorCode,
    });

    const rawEvent = {
      playerUid,
      coadminUid,
      amountNpr: amountThisRequest,
      type: 'cashout_request_deduct',
      cashoutTaskId: taskId,
      createdAt: nowIso,
      ttlExpiresAt: ttlAfterDays(90),
      vendorId: vendorFields.vendorId,
      vendorCode: vendorFields.vendorCode,
      vendorName: vendorFields.vendorName,
    };

    await client.query(
      `
        INSERT INTO public.financial_events_cache (
          firebase_id, player_uid, coadmin_uid, type, amount_npr, cashout_task_id,
          before_cash, after_cash, created_at, updated_at, ttl_expires_at,
          vendor_id, vendor_code, vendor_name,
          source, mirrored_at, deleted_at, raw_firestore_data
        )
        VALUES (
          $1::text, $2::text, $3::text, 'cashout_request_deduct', $4::numeric, $5::text,
          $6::numeric, $7::numeric, $8::timestamptz, $8::timestamptz, $9::timestamptz,
          $10::bigint, NULLIF($11::text, ''), NULLIF($12::text, ''),
          'authority_cashout_create', now(), NULL, $13::jsonb
        )
        ON CONFLICT (firebase_id) DO NOTHING
      `,
      [
        eventId,
        playerUid,
        coadminUid,
        amountThisRequest,
        taskId,
        availableCash,
        newCash,
        nowIso,
        ttlAfterDays(90),
        vendorFields.vendorId,
        vendorFields.vendorCode,
        vendorFields.vendorName,
        JSON.stringify(rawEvent),
      ]
    );

    await insertAuthorityLedgerEvent(client, {
      eventKey: `financialEvents:${eventId}:${playerUid}:cash:cashout_request_cash_debit`,
      userUid: playerUid,
      username: playerUsername,
      role: 'player',
      coadminUid,
      balanceType: 'cash',
      direction: 'debit',
      delta: -amountThisRequest,
      absoluteAfter: newCash,
      eventType: 'cashout_request_cash_debit',
      sourceCollection: 'financialEvents',
      sourceId: eventId,
      actorUid: playerUid,
      actorRole: 'player',
      confidence: 'high',
      sourceCreatedAt: nowIso,
      rawSourceData: rawEvent,
      sourceFields: { amount: amountThisRequest, cashoutTaskId: taskId },
    });

    await writeCashoutOutbox(client, {
      playerUid,
      coadminUid,
      taskId,
      status: 'pending',
      amountNpr: amountThisRequest,
      eventType: 'cashout_task_created',
      updatedAt: nowIso,
    });
    await writeCashoutBalanceOutbox(client, {
      playerUid,
      taskId,
      cash: newCash,
      coin: Math.max(0, Number(player.coin || 0)),
      updatedAt: nowIso,
    });
    console.info('[CASHOUT_OUTBOX_EVENT_CREATED]', {
      taskId,
      playerUid,
      coadminUid,
      eventType: 'cashout_task_created',
      channels: [
        playerCashoutLiveChannel(playerUid),
        coadminCashoutLiveChannel(coadminUid),
      ],
    });

    await client.query(
      `UPDATE public.authority_operations SET payload = $2::jsonb WHERE operation_key = $1`,
      [operationKey, JSON.stringify({ taskId, playerUid, amountNpr: amountThisRequest })]
    );

    await client.query('COMMIT');
    console.info('[CASHOUT_CREATE_COMMIT]', {
      taskId,
      playerUid,
      coadminUid,
      amountNpr: amountThisRequest,
      status: 'pending',
    });

    const visibleTasks = await readPlayerCashoutTasksCacheByCoadmin(coadminUid, 100);
    const pendingVisible = (visibleTasks || []).filter(
      (task) => String(task.status || '').toLowerCase() === 'pending'
    );
    const taskVisible = (visibleTasks || []).some((task) => task.id === taskId);
    console.info('[CASHOUT_CREATE_VISIBILITY_CHECK]', {
      taskId,
      coadminUid,
      staffVisibleCount: pendingVisible.length,
      coadminVisibleCount: pendingVisible.length,
      taskVisible,
      totalForCoadmin: visibleTasks?.length ?? 0,
    });

    console.info('[CASHOUT_CREATE_TASK_ID]', { taskId, playerUid, coadminUid });
    return { success: true, duplicate: false, taskId };
  } catch (error) {
    await client.query('ROLLBACK');
    const pgCode =
      error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code || '')
        : '';
    console.error('[CASHOUT_CREATE_FAILED]', {
      playerUid,
      pgCode: pgCode || null,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    client.release();
  }
}

export async function completePlayerCashoutTaskInSql(
  input: AuthorityCashoutCompleteInput
): Promise<AuthorityCashoutCompleteResult> {
  const taskId = cleanText(input.taskId);
  const actorUid = cleanText(input.actorUid);
  const actorRole = cleanText(input.actorRole);
  if (!taskId) throw new Error('taskId is required.');
  if (!actorUid || !actorRole) throw new Error('Actor is required.');

  console.info('[CASHOUT_TASK_DONE] attempting', {
    taskId,
    actorUid,
    actorRole,
    scopeUid: cleanText(input.scopeUid) || null,
    isAdmin: input.isAdmin,
  });

  const idempotencyKey = cleanText(input.idempotencyKey) || taskId;
  const operationKey = `cashout_complete:${taskId}:${idempotencyKey}`;

  logAuthPayloadPreTxnRemoved('cashout_complete');
  const db = getPlayerMirrorPool();
  if (!db) throw new Error('Postgres is unavailable.');

  const eventId = randomUUID();
  const nowIso = new Date().toISOString();

  // Peek player/vendor without locking, then resolve via Ledger if the task lacks attribution.
  const peek = await db.query(
    `
      SELECT player_uid, vendor_id, vendor_code, vendor_name, vendor_status,
             vendor_linked_staff_uid, vendor_ownership_date, vendor_resolved_at,
             raw_firestore_data
      FROM public.player_cashout_tasks_cache
      WHERE firebase_id = $1 AND deleted_at IS NULL
      LIMIT 1
    `,
    [taskId]
  );
  if (!peek.rows.length) throw new Error('Cashout task not found.');
  const peekRow = peek.rows[0] as Record<string, unknown>;
  const peekPlayerUid = cleanText(peekRow.player_uid);
  let resolvedVendorFields = readStoredVendorFieldsFromRow(peekRow);
  const storedAwareness = vendorAwarenessFromStoredFields(resolvedVendorFields);
  if (!resolvedVendorFields.vendorResolvedAt || storedAwareness?.configured === false) {
    const liveVendor = await resolveVendorAwarenessForPlayerUid(peekPlayerUid);
    resolvedVendorFields = storedVendorFieldsFromAwareness(liveVendor, nowIso);
  }
  if (!isVendorLinked(resolvedVendorFields)) {
    console.warn('[VENDOR_CASHOUT_UNASSIGNED]', {
      phase: 'complete',
      taskId,
      playerUid: peekPlayerUid,
    });
  }

  const client = await db.connect();

  try {
    await client.query('BEGIN');

    const taskLock = await client.query(
      `SELECT * FROM public.player_cashout_tasks_cache WHERE firebase_id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [taskId]
    );
    if (!taskLock.rows.length) throw new Error('Cashout task not found.');
    const task = taskLock.rows[0] as Record<string, unknown>;
    const status = cleanText(task.status).toLowerCase();

    if (status === 'completed') {
      await client.query('COMMIT');
      return { success: true, duplicate: true, alreadyCompleted: true, taskId };
    }
    if (status !== 'pending' && status !== 'in_progress') {
      throw new Error('Cashout task is not available to complete.');
    }

    const taskScope = cleanText(task.coadmin_uid);
    if (!input.isAdmin && (!input.scopeUid || input.scopeUid !== taskScope)) {
      throw new Error('Forbidden: cashout task is outside your scope.');
    }

    const assignedHandlerUid = cleanText(task.assigned_handler_uid);
    if (
      status === 'in_progress' &&
      assignedHandlerUid &&
      assignedHandlerUid !== actorUid &&
      !input.isAdmin &&
      actorRole !== 'coadmin'
    ) {
      throw new Error('This task is already assigned to another handler.');
    }

    const requestedAmount = Math.max(0, Math.round(Number(task.amount_npr || 0)));
    if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
      throw new Error('Cashout task amount is invalid.');
    }

    const lockedVendorFields = readStoredVendorFieldsFromRow(task);
    if (isVendorLinked(lockedVendorFields) || lockedVendorFields.vendorResolvedAt) {
      resolvedVendorFields = lockedVendorFields;
    }

    const shouldDeductOnComplete = task.cash_deducted_on_request !== true;
    const playerUid = cleanText(task.player_uid);
    let playerCash = 0;
    if (shouldDeductOnComplete) {
      const playerLock = await client.query(
        `SELECT cash FROM public.players_cache WHERE uid = $1 AND deleted_at IS NULL FOR UPDATE`,
        [playerUid]
      );
      if (!playerLock.rows.length) throw new Error('Cashout task player not found.');
      playerCash = Math.max(0, Math.floor(Number((playerLock.rows[0] as Record<string, unknown>).cash || 0)));
      if (playerCash < requestedAmount) {
        throw new Error('Cashout task player cash is lower than the requested amount.');
      }
    }

    const handlerLock = await client.query(
      `SELECT * FROM public.user_balance_snapshots_cache WHERE firebase_id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [actorUid]
    );
    const handlerSnapshot = (handlerLock.rows[0] as Record<string, unknown> | undefined) || {};
    const handlerPlayer = await client.query(
      `SELECT raw_firestore_data FROM public.players_cache WHERE uid = $1 AND deleted_at IS NULL`,
      [actorUid]
    );
    const handlerPlayerRow = (handlerPlayer.rows[0] as Record<string, unknown> | undefined) || {};

    const rewardNpr = Math.max(1, Math.round(requestedAmount * 0.05));
    const rewardBlocked = readRewardBlocked(handlerSnapshot, handlerPlayerRow);
    const rewardAppliedNpr = rewardBlocked ? 0 : rewardNpr;
    const handlerCreditAmount = requestedAmount + rewardAppliedNpr;
    const cashBoxBefore = readCashBoxNpr(handlerSnapshot, handlerPlayerRow);
    const cashBoxAfter = cashBoxBefore + handlerCreditAmount;
    const cashBoxDelta = cashBoxAfter - cashBoxBefore;

    const claim = await claimAuthorityOperation(client, {
      operationKey,
      operationType: 'cashout_complete',
      userUid: playerUid,
      sourceId: taskId,
      actorUid,
      actorRole,
      payload: {},
    });
    if (claim.duplicate) {
      const payload = await readAuthorityOperationPayloadWithClient(client, operationKey, {
        flowName: 'cashout_complete',
      });
      await client.query('ROLLBACK');
      return {
        success: true,
        duplicate: true,
        alreadyCompleted: payload?.alreadyCompleted === true,
        taskId,
      };
    }

    const taskRaw = mergeVendorIntoRawFirestoreData(
      {
        ...(task.raw_firestore_data && typeof task.raw_firestore_data === 'object' && !Array.isArray(task.raw_firestore_data)
          ? (task.raw_firestore_data as Record<string, unknown>)
          : {}),
        status: 'completed',
        assignedHandlerUid: actorUid,
        assignedHandlerUsername: cleanText(input.actorUsername) || 'Handler',
        cashoutRequestedByStaffId: actorRole === 'staff' ? actorUid : null,
        rewardNprApplied: rewardAppliedNpr,
        rewardBlockedApplied: rewardBlocked,
        payoutAmountNpr: requestedAmount,
        rewardAmountNpr: rewardAppliedNpr,
        cashBoxBefore,
        cashBoxAfter,
        cashBoxDelta,
        actorUid,
        actorRole,
        sourceCashoutId: taskId,
        startedAt: toIsoString(task.started_at) || nowIso,
        expiresAt: null,
        completedAt: nowIso,
      },
      resolvedVendorFields
    );

    await upsertCashoutTaskCache(client, taskId, {
      coadminUid: taskScope,
      playerUid,
      playerUsername: cleanText(task.player_username),
      amountNpr: requestedAmount,
      paymentDetails: cleanText(task.payment_details),
      payoutMethod: cleanText(task.payout_method),
      qrImageUrl: cleanText(task.qr_image_url),
      paymentAppName: cleanText(task.payment_app_name),
      paymentAppCashTag: cleanText(task.payment_app_cash_tag),
      paymentAppAccountName: cleanText(task.payment_app_account_name),
      cashDeductedOnRequest: task.cash_deducted_on_request === true,
      status: 'completed',
      assignedHandlerUid: actorUid,
      assignedHandlerUsername: cleanText(input.actorUsername) || 'Handler',
      cashoutRequestedByStaffId: actorRole === 'staff' ? actorUid : null,
      rewardNprApplied: rewardAppliedNpr,
      rewardBlockedApplied: rewardBlocked,
      startedAt: task.started_at,
      expiresAt: null,
      createdAt: task.created_at,
      completedAt: nowIso,
      ...resolvedVendorFields,
      source: 'authority_cashout_complete',
      rawFirestoreData: taskRaw,
    });

    if (shouldDeductOnComplete) {
      await updateBalances(client, playerUid, { cash: playerCash - requestedAmount });
    }
    await updateBalances(client, actorUid, { cashBoxNpr: cashBoxAfter });

    const rawEvent = {
      playerUid,
      coadminUid: taskScope,
      amountNpr: requestedAmount,
      type: 'cashout',
      cashoutTaskId: taskId,
      createdAt: nowIso,
      cashBoxBefore,
      cashBoxAfter,
      cashBoxDelta,
      actorUid,
      actorRole,
      vendorId: resolvedVendorFields.vendorId,
      vendorCode: resolvedVendorFields.vendorCode,
      vendorName: resolvedVendorFields.vendorName,
    };

    await client.query(
      `
        INSERT INTO public.financial_events_cache (
          firebase_id, player_uid, coadmin_uid, type, amount_npr, cashout_task_id,
          vendor_id, vendor_code, vendor_name,
          created_at, updated_at, source, mirrored_at, deleted_at, raw_firestore_data
        )
        VALUES (
          $1, $2, $3, 'cashout', $4, $5,
          $6::bigint, NULLIF($7::text, ''), NULLIF($8::text, ''),
          $9::timestamptz, $9::timestamptz, 'authority_cashout_complete', now(), NULL, $10::jsonb
        )
        ON CONFLICT (firebase_id) DO NOTHING
      `,
      [
        eventId,
        playerUid,
        taskScope,
        requestedAmount,
        taskId,
        resolvedVendorFields.vendorId,
        resolvedVendorFields.vendorCode,
        resolvedVendorFields.vendorName,
        nowIso,
        JSON.stringify(rawEvent),
      ]
    );

    await insertAuthorityLedgerEvent(client, {
      eventKey: `playerCashoutTasks:${taskId}:${actorUid}:cashBoxNpr:cashout_handler_cashbox_credit`,
      userUid: actorUid,
      role: actorRole,
      coadminUid: taskScope,
      balanceType: 'cashBoxNpr',
      direction: 'credit',
      delta: cashBoxDelta,
      absoluteAfter: cashBoxAfter,
      eventType: 'cashout_handler_cashbox_credit',
      sourceCollection: 'player_cashout_tasks_cache',
      sourceId: taskId,
      actorUid,
      actorRole,
      confidence: 'high',
      sourceCreatedAt: nowIso,
      rawSourceData: taskRaw,
      sourceFields: {
        cashBoxBefore,
        cashBoxAfter,
        cashBoxDelta,
        payoutAmountNpr: requestedAmount,
        rewardAmountNpr: rewardAppliedNpr,
      },
    });

    if (shouldDeductOnComplete) {
      await insertAuthorityLedgerEvent(client, {
        eventKey: `playerCashoutTasks:${taskId}:${playerUid}:cash:cashout_complete_cash_debit_legacy`,
        userUid: playerUid,
        role: 'player',
        coadminUid: taskScope,
        balanceType: 'cash',
        direction: 'debit',
        delta: -requestedAmount,
        absoluteAfter: playerCash - requestedAmount,
        eventType: 'cashout_complete_cash_debit_legacy',
        sourceCollection: 'player_cashout_tasks_cache',
        sourceId: taskId,
        actorUid,
        actorRole,
        confidence: 'high',
        sourceCreatedAt: nowIso,
        rawSourceData: taskRaw,
        sourceFields: { amount: requestedAmount },
      });
    }

    await writeCashoutOutbox(client, {
      playerUid,
      coadminUid: taskScope,
      taskId,
      status: 'completed',
      amountNpr: requestedAmount,
      eventType: 'cashout_complete',
      updatedAt: nowIso,
    });

    await client.query(
      `UPDATE public.authority_operations SET payload = $2::jsonb WHERE operation_key = $1`,
      [
        operationKey,
        JSON.stringify({
          taskId,
          alreadyCompleted: false,
          eventId,
          vendorId: resolvedVendorFields.vendorId,
          vendorCode: resolvedVendorFields.vendorCode,
        }),
      ]
    );

    await client.query('COMMIT');
    // Ledger Total Out / Net / receivable update — only after the cashout event committed.
    void reportVendorCashoutCompletedToLedger({
      eventId,
      taskId,
      playerUid,
      coadminUid: taskScope,
      amountNpr: requestedAmount,
      occurredAt: nowIso,
      vendor: resolvedVendorFields,
    }).catch((error) => {
      console.warn('[VENDOR_CASHOUT_LEDGER_POST_COMMIT_ERROR]', {
        taskId,
        eventId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    console.info('[CASHOUT_TASK_DONE] success', {
      taskId,
      status: 'completed',
      actorUid,
      actorRole,
      coadminUid: taskScope,
      vendorId: resolvedVendorFields.vendorId,
      vendorCode: resolvedVendorFields.vendorCode,
    });
    return { success: true, duplicate: false, alreadyCompleted: false, taskId };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[CASHOUT_TASK_DONE] failed', {
      taskId,
      actorUid,
      actorRole,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    client.release();
  }
}

export async function startPlayerCashoutTaskInSql(
  input: AuthorityCashoutStartInput
): Promise<AuthorityCashoutStartResult> {
  const taskId = cleanText(input.taskId);
  const actorUid = cleanText(input.actorUid);
  const actorRole = cleanText(input.actorRole);
  if (!taskId) throw new Error('taskId is required.');
  if (!actorUid || !actorRole) throw new Error('Actor is required.');

  const operationKey = `cashout_start:${taskId}:${actorUid}`;

  const db = getPlayerMirrorPool();
  if (!db) throw new Error('Postgres is unavailable.');

  const nowIso = new Date().toISOString();
  const expiresAtIso = new Date(Date.now() + CASHOUT_TASK_DURATION_MS).toISOString();
  const expiresAtMs = Date.parse(expiresAtIso);
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    const taskLock = await client.query(
      `SELECT * FROM public.player_cashout_tasks_cache WHERE firebase_id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [taskId]
    );
    if (!taskLock.rows.length) throw new Error('Cashout task not found.');
    const task = taskLock.rows[0] as Record<string, unknown>;
    const status = cleanText(task.status).toLowerCase();
    const taskScope = cleanText(task.coadmin_uid);
    const playerUid = cleanText(task.player_uid);
    const amountNpr = Math.max(0, Math.round(Number(task.amount_npr || 0)));

    if (!input.isAdmin && (!input.scopeUid || input.scopeUid !== taskScope)) {
      console.warn('[CASHOUT_TASK_CLAIM] forbiddenScope', {
        taskId,
        actorUid,
        actorRole,
        actorScopeUid: cleanText(input.scopeUid) || null,
        taskScope,
      });
      throw new Error('Forbidden: cashout task is outside your scope.');
    }
    const assignedHandlerUid = cleanText(task.assigned_handler_uid);
    if (status !== 'pending' || assignedHandlerUid) {
      console.warn('[CASHOUT_TASK_CLAIM] conflictAlreadyClaimed', {
        taskId,
        actorUid,
        actorRole,
        status,
        assignedHandlerUid: assignedHandlerUid || null,
      });
      throw cashoutClaimConflictFromTaskRow(taskId, task);
    }

    const claim = await claimAuthorityOperation(client, {
      operationKey,
      operationType: 'cashout_start',
      userUid: playerUid,
      sourceId: taskId,
      actorUid,
      actorRole,
      payload: {},
    });
    if (claim.duplicate) {
      console.warn('[CASHOUT_TASK_CLAIM] conflictAlreadyClaimed', {
        taskId,
        actorUid,
        actorRole,
        status,
        assignedHandlerUid: assignedHandlerUid || null,
        duplicateOperation: true,
      });
      throw cashoutClaimConflictFromTaskRow(taskId, task);
    }

    const taskRaw = {
      ...(task.raw_firestore_data &&
      typeof task.raw_firestore_data === 'object' &&
      !Array.isArray(task.raw_firestore_data)
        ? (task.raw_firestore_data as Record<string, unknown>)
        : {}),
      status: 'in_progress',
      assignedHandlerUid: actorUid,
      assignedHandlerUsername: cleanText(input.actorUsername) || 'Handler',
      assignedHandlerRole: actorRole,
      claimedByRole: actorRole,
      claimedAt: nowIso,
      startedAt: nowIso,
      expiresAt: expiresAtIso,
      updatedAt: nowIso,
    };

    await upsertCashoutTaskCache(client, taskId, {
      coadminUid: taskScope,
      playerUid,
      playerUsername: cleanText(task.player_username),
      amountNpr,
      paymentDetails: cleanText(task.payment_details),
      payoutMethod: cleanText(task.payout_method),
      qrImageUrl: cleanText(task.qr_image_url),
      paymentAppName: cleanText(task.payment_app_name),
      paymentAppCashTag: cleanText(task.payment_app_cash_tag),
      paymentAppAccountName: cleanText(task.payment_app_account_name),
      cashDeductedOnRequest: task.cash_deducted_on_request === true,
      status: 'in_progress',
      assignedHandlerUid: actorUid,
      assignedHandlerUsername: cleanText(input.actorUsername) || 'Handler',
      startedAt: nowIso,
      expiresAt: expiresAtIso,
      createdAt: task.created_at,
      source: 'authority_cashout_start',
      rawFirestoreData: taskRaw,
    });

    await writeCashoutOutbox(client, {
      playerUid,
      coadminUid: taskScope,
      taskId,
      status: 'in_progress',
      amountNpr,
      eventType: 'cashout_start',
      updatedAt: nowIso,
    });

    await client.query(
      `UPDATE public.authority_operations SET payload = $2::jsonb WHERE operation_key = $1`,
      [operationKey, JSON.stringify({ taskId, expiresAtMs })]
    );

    await client.query('COMMIT');
    console.info('[CASHOUT_TASK_CLAIM] success', {
      taskId,
      actorUid,
      actorRole,
      coadminUid: taskScope,
      expiresAtMs,
    });
    return { success: true, duplicate: false, taskId, expiresAtMs };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function releaseExpiredPlayerCashoutTasksForCoadminInSql(
  coadminUid: string
): Promise<string[]> {
  const cleanCoadminUid = cleanText(coadminUid);
  if (!cleanCoadminUid) {
    return [];
  }
  const db = getPlayerMirrorPool();
  if (!db) {
    return [];
  }

  const client = await db.connect();
  const releasedIds: string[] = [];
  try {
    await client.query('BEGIN');
    const expired = await client.query(
      `
        SELECT firebase_id
        FROM public.player_cashout_tasks_cache
        WHERE deleted_at IS NULL
          AND coadmin_uid = $1
          AND LOWER(COALESCE(status, '')) = 'in_progress'
          AND expires_at IS NOT NULL
          AND expires_at <= NOW()
        FOR UPDATE
      `,
      [cleanCoadminUid]
    );

    for (const row of expired.rows) {
      const taskId = cleanText((row as Record<string, unknown>).firebase_id);
      if (!taskId) {
        continue;
      }
      const result = await releasePlayerCashoutTaskInSql(
        {
          taskId,
          actorUid: 'system',
          actorRole: 'system',
          isAdmin: true,
          scopeUid: cleanCoadminUid,
          reason: 'timeout',
        },
        client
      );
      if (result.released) {
        releasedIds.push(taskId);
        console.info('[CASHOUT_TASK_TIMEOUT_RELEASE] success', {
          taskId,
          coadminUid: cleanCoadminUid,
        });
      }
    }

    await client.query('COMMIT');
    return releasedIds;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function releasePlayerCashoutTaskInSql(
  input: AuthorityCashoutReleaseInput,
  existingClient?: PoolClient
): Promise<AuthorityCashoutReleaseResult> {
  const taskId = cleanText(input.taskId);
  const actorUid = cleanText(input.actorUid);
  const actorRole = cleanText(input.actorRole);
  if (!taskId) throw new Error('taskId is required.');
  if (!actorUid || !actorRole) throw new Error('Actor is required.');

  const operationKey = `cashout_release:${taskId}:${input.reason || 'manual'}:${actorUid}`;
  const db = getPlayerMirrorPool();
  if (!db) throw new Error('Postgres is unavailable.');

  const client = existingClient || (await db.connect());
  const ownsClient = !existingClient;

  try {
    if (!existingClient) {
      await client.query('BEGIN');
    }

    const taskLock = await client.query(
      `SELECT * FROM public.player_cashout_tasks_cache WHERE firebase_id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [taskId]
    );
    if (!taskLock.rows.length) throw new Error('Cashout task not found.');
    const task = taskLock.rows[0] as Record<string, unknown>;
    const status = cleanText(task.status).toLowerCase();
    const taskScope = cleanText(task.coadmin_uid);
    const playerUid = cleanText(task.player_uid);
    const amountNpr = Math.max(0, Math.round(Number(task.amount_npr || 0)));
    const assignedHandlerUid = cleanText(task.assigned_handler_uid);

    if (!input.isAdmin && (!input.scopeUid || input.scopeUid !== taskScope)) {
      throw new Error('Forbidden: cashout task is outside your scope.');
    }

    if (status !== 'in_progress') {
      return { success: true, duplicate: true, taskId, released: false };
    }

    if (
      input.reason !== 'timeout' &&
      assignedHandlerUid &&
      assignedHandlerUid !== actorUid &&
      !input.isAdmin &&
      actorRole !== 'coadmin'
    ) {
      throw new Error('Only the handler who claimed this task can release it.');
    }

    const claim = await claimAuthorityOperation(client, {
      operationKey,
      operationType: 'cashout_release',
      userUid: playerUid,
      sourceId: taskId,
      actorUid,
      actorRole,
      payload: {},
    });
    if (claim.duplicate) {
      if (!existingClient) {
        await client.query('ROLLBACK');
      }
      return { success: true, duplicate: true, taskId, released: false };
    }

    const taskRaw = {
      ...(task.raw_firestore_data &&
      typeof task.raw_firestore_data === 'object' &&
      !Array.isArray(task.raw_firestore_data)
        ? (task.raw_firestore_data as Record<string, unknown>)
        : {}),
      status: 'pending',
      assignedHandlerUid: null,
      assignedHandlerUsername: null,
      assignedHandlerRole: null,
      claimedByRole: null,
      claimedAt: null,
      startedAt: null,
      expiresAt: null,
      updatedAt: new Date().toISOString(),
    };

    await upsertCashoutTaskCache(client, taskId, {
      coadminUid: taskScope,
      playerUid,
      playerUsername: cleanText(task.player_username),
      amountNpr,
      paymentDetails: cleanText(task.payment_details),
      payoutMethod: cleanText(task.payout_method),
      qrImageUrl: cleanText(task.qr_image_url),
      paymentAppName: cleanText(task.payment_app_name),
      paymentAppCashTag: cleanText(task.payment_app_cash_tag),
      paymentAppAccountName: cleanText(task.payment_app_account_name),
      cashDeductedOnRequest: task.cash_deducted_on_request === true,
      status: 'pending',
      assignedHandlerUid: null,
      assignedHandlerUsername: null,
      startedAt: null,
      expiresAt: null,
      createdAt: task.created_at,
      source: input.reason === 'timeout' ? 'authority_cashout_timeout_release' : 'authority_cashout_release',
      rawFirestoreData: taskRaw,
    });

    await writeCashoutOutbox(client, {
      playerUid,
      coadminUid: taskScope,
      taskId,
      status: 'pending',
      amountNpr,
      eventType: input.reason === 'timeout' ? 'cashout_timeout_release' : 'cashout_release',
      updatedAt: new Date().toISOString(),
    });

    if (!existingClient) {
      await client.query('COMMIT');
    }

    if (input.reason !== 'timeout') {
      console.info('[CASHOUT_TASK_RELEASE] success', {
        taskId,
        actorUid,
        actorRole,
        coadminUid: taskScope,
      });
    }

    return { success: true, duplicate: false, taskId, released: true };
  } catch (error) {
    if (!existingClient) {
      await client.query('ROLLBACK');
    }
    throw error;
  } finally {
    if (ownsClient) {
      client.release();
    }
  }
}

export async function declinePlayerCashoutTaskInSql(
  input: AuthorityCashoutDeclineInput
): Promise<AuthorityCashoutDeclineResult> {
  const taskId = cleanText(input.taskId);
  if (!taskId) throw new Error('taskId is required.');

  const idempotencyKey = cleanText(input.idempotencyKey) || taskId;
  const operationKey = `cashout_decline:${taskId}:${idempotencyKey}`;

  logAuthPayloadPreTxnRemoved('cashout_decline');
  const db = getPlayerMirrorPool();
  if (!db) throw new Error('Postgres is unavailable.');

  const eventId = randomUUID();
  const nowIso = new Date().toISOString();
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    const taskLock = await client.query(
      `SELECT * FROM public.player_cashout_tasks_cache WHERE firebase_id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [taskId]
    );
    if (!taskLock.rows.length) throw new Error('Cashout task not found.');
    const task = taskLock.rows[0] as Record<string, unknown>;
    const status = cleanText(task.status).toLowerCase();

    if (status === 'declined') {
      await client.query('COMMIT');
      return {
        success: true,
        duplicate: true,
        taskId,
        refunded: task.cash_deducted_on_request === true,
      };
    }
    if (status !== 'pending' && status !== 'in_progress') {
      throw new Error('Only active cashout tasks can be declined.');
    }

    const taskScope = cleanText(task.coadmin_uid);
    if (!input.isAdmin && taskScope !== cleanText(input.scopeUid)) {
      throw new Error('Forbidden: cashout task is outside your scope.');
    }

    const claim = await claimAuthorityOperation(client, {
      operationKey,
      operationType: 'cashout_decline',
      userUid: cleanText(task.player_uid),
      sourceId: taskId,
      actorUid: input.actorUid,
      actorRole: input.actorRole,
      payload: {},
    });
    if (claim.duplicate) {
      const payload = await readAuthorityOperationPayloadWithClient(client, operationKey, {
        flowName: 'cashout_decline',
      });
      await client.query('ROLLBACK');
      return {
        success: true,
        duplicate: true,
        taskId,
        refunded: payload?.refunded === true,
      };
    }

    const amountNpr = Math.max(0, Math.round(Number(task.amount_npr || 0)));
    const playerUid = cleanText(task.player_uid);
    let refunded = false;

    const playerLock = await client.query(
      `SELECT cash, username FROM public.players_cache WHERE uid = $1 AND deleted_at IS NULL FOR UPDATE`,
      [playerUid]
    );
    const playerCash = playerLock.rows.length
      ? Math.max(0, Math.floor(Number((playerLock.rows[0] as Record<string, unknown>).cash || 0)))
      : 0;
    const playerUsername = playerLock.rows.length
      ? cleanText((playerLock.rows[0] as Record<string, unknown>).username)
      : null;

    const taskRaw = {
      ...(task.raw_firestore_data && typeof task.raw_firestore_data === 'object' && !Array.isArray(task.raw_firestore_data)
        ? (task.raw_firestore_data as Record<string, unknown>)
        : {}),
      status: 'declined',
      expiresAt: null,
      completedAt: nowIso,
    };

    await upsertCashoutTaskCache(client, taskId, {
      coadminUid: taskScope,
      playerUid,
      playerUsername: cleanText(task.player_username),
      amountNpr,
      paymentDetails: cleanText(task.payment_details),
      payoutMethod: cleanText(task.payout_method),
      qrImageUrl: cleanText(task.qr_image_url),
      paymentAppName: cleanText(task.payment_app_name),
      paymentAppCashTag: cleanText(task.payment_app_cash_tag),
      paymentAppAccountName: cleanText(task.payment_app_account_name),
      cashDeductedOnRequest: task.cash_deducted_on_request === true,
      status: 'declined',
      assignedHandlerUid: cleanText(task.assigned_handler_uid),
      assignedHandlerUsername: cleanText(task.assigned_handler_username),
      startedAt: task.started_at,
      expiresAt: null,
      createdAt: task.created_at,
      completedAt: nowIso,
      source: 'authority_cashout_decline',
      rawFirestoreData: taskRaw,
    });

    if (task.cash_deducted_on_request === true && amountNpr > 0) {
      const newCash = playerCash + amountNpr;
      await updateBalances(client, playerUid, { cash: newCash });
      refunded = true;

      const rawEvent = {
        playerUid,
        coadminUid: taskScope,
        amountNpr,
        type: 'cashout_decline_refund',
        cashoutTaskId: taskId,
        createdAt: nowIso,
      };

      await client.query(
        `
          INSERT INTO public.financial_events_cache (
            firebase_id, player_uid, coadmin_uid, type, amount_npr, cashout_task_id,
            before_cash, after_cash, created_at, updated_at, source, mirrored_at, deleted_at,
            raw_firestore_data
          )
          VALUES (
            $1, $2, $3, 'cashout_decline_refund', $4, $5,
            $6, $7, $8::timestamptz, $8::timestamptz, 'authority_cashout_decline', now(), NULL,
            $9::jsonb
          )
          ON CONFLICT (firebase_id) DO NOTHING
        `,
        [
          eventId,
          playerUid,
          taskScope,
          amountNpr,
          taskId,
          playerCash,
          newCash,
          nowIso,
          JSON.stringify(rawEvent),
        ]
      );

      await insertAuthorityLedgerEvent(client, {
        eventKey: `financialEvents:${eventId}:${playerUid}:cash:cashout_decline_cash_refund`,
        userUid: playerUid,
        username: playerUsername,
        role: 'player',
        coadminUid: taskScope,
        balanceType: 'cash',
        direction: 'credit',
        delta: amountNpr,
        absoluteAfter: newCash,
        eventType: 'cashout_decline_cash_refund',
        sourceCollection: 'financialEvents',
        sourceId: eventId,
        actorUid: input.actorUid,
        actorRole: input.actorRole,
        confidence: 'high',
        sourceCreatedAt: nowIso,
        rawSourceData: rawEvent,
        sourceFields: { amount: amountNpr, cashoutTaskId: taskId },
      });
    }

    await writeCashoutOutbox(client, {
      playerUid,
      coadminUid: taskScope,
      taskId,
      status: 'declined',
      amountNpr,
      eventType: 'cashout_decline',
      updatedAt: nowIso,
    });

    await client.query(
      `UPDATE public.authority_operations SET payload = $2::jsonb WHERE operation_key = $1`,
      [operationKey, JSON.stringify({ taskId, refunded })]
    );

    await client.query('COMMIT');
    return { success: true, duplicate: false, taskId, refunded };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
