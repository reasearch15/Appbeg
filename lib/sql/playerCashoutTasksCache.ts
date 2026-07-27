import 'server-only';

import type { DocumentSnapshot } from 'firebase-admin/firestore';

import { adminDb } from '@/lib/firebase/admin';
import { extractPgErrorDetails } from '@/lib/server/sqlErrorDetails';
import { isSqlCacheVerboseLogs, SQL_QUERY_SLOW_MS } from '@/lib/server/verboseLogs';
import {
  cleanText,
  getPlayerMirrorPool,
  normalizeJson,
  numberOrNull,
  runMirrorPoolQuery,
  toIsoString,
} from '@/lib/sql/playerMirrorCommon';
import { isCacheSqlAuthoritative } from '@/lib/server/cacheSqlRead';
import { attachVendorAwarenessToPlayers } from '@/lib/sql/vendorOwnershipRead';
import type { VendorAwareness } from '@/features/vendors/vendorAwareness';

export type PlayerCashoutTaskCacheInput = {
  firebaseId: string;
  rawFirestoreData?: Record<string, unknown>;
  source?: string;
} & Record<string, unknown>;

function logPlayerCacheInfo(message: string, details?: unknown) {
  if (process.env.NODE_ENV === 'production') {
    return;
  }
  if (details === undefined) {
    console.info(message);
    return;
  }
  console.info(message, details);
}

function booleanOrNull(value: unknown) {
  return typeof value === 'boolean' ? value : null;
}

function jsonArrayOrNull(value: unknown) {
  if (!Array.isArray(value)) return null;
  return normalizeJson(value) || [];
}

function toCacheInput(firebaseId: string, data: Record<string, unknown>, source: string) {
  return {
    firebaseId,
    ...data,
    rawFirestoreData: data,
    source,
  } satisfies PlayerCashoutTaskCacheInput;
}

export async function upsertPlayerCashoutTaskCache(input: PlayerCashoutTaskCacheInput) {
  const db = getPlayerMirrorPool();
  const firebaseId = cleanText(input.firebaseId);
  if (!db || !firebaseId) return false;

  try {
    await db.query(
      `
        INSERT INTO public.player_cashout_tasks_cache (
          firebase_id, coadmin_uid, player_uid, player_username, amount_npr,
          payment_details, payout_method, qr_image_url, payment_app_name,
          payment_app_cash_tag, payment_app_account_name, cash_deducted_on_request,
          status, assigned_handler_uid, assigned_handler_username,
          cashout_requested_by_staff_id, reward_npr_applied,
          reward_blocked_applied, declined_by_uids, started_at, expires_at,
          created_at, completed_at, source, mirrored_at, deleted_at,
          raw_firestore_data
        )
        VALUES (
          $1, NULLIF($2, ''), NULLIF($3, ''), NULLIF($4, ''), $5,
          NULLIF($6, ''), NULLIF($7, ''), NULLIF($8, ''), NULLIF($9, ''),
          NULLIF($10, ''), NULLIF($11, ''), $12, NULLIF($13, ''),
          NULLIF($14, ''), NULLIF($15, ''), NULLIF($16, ''), $17,
          $18, $19::jsonb, $20::timestamptz, $21::timestamptz,
          $22::timestamptz, $23::timestamptz, $24, now(), NULL,
          $25::jsonb
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
          raw_firestore_data = EXCLUDED.raw_firestore_data
      `,
      [
        firebaseId,
        cleanText(input.coadminUid || input.createdBy),
        cleanText(input.playerUid || input.playerId),
        cleanText(input.playerUsername || input.username),
        numberOrNull(input.amountNpr ?? input.amount),
        cleanText(input.paymentDetails),
        cleanText(input.payoutMethod),
        cleanText(input.qrImageUrl),
        cleanText(input.paymentAppName),
        cleanText(input.paymentAppCashTag),
        cleanText(input.paymentAppAccountName),
        booleanOrNull(input.cashDeductedOnRequest),
        cleanText(input.status),
        cleanText(input.assignedHandlerUid),
        cleanText(input.assignedHandlerUsername),
        cleanText(input.cashoutRequestedByStaffId),
        numberOrNull(input.rewardNprApplied),
        booleanOrNull(input.rewardBlockedApplied),
        JSON.stringify(jsonArrayOrNull(input.declinedByUids)),
        toIsoString(input.startedAt),
        toIsoString(input.expiresAt),
        toIsoString(input.createdAt),
        toIsoString(input.completedAt),
        cleanText(input.source) || 'firestore',
        JSON.stringify(normalizeJson(input.rawFirestoreData || {}) || {}),
      ]
    );
    logPlayerCacheInfo('[PLAYER_CASHOUT_TASKS_CACHE] mirror upsert ok', { firebaseId });
    return true;
  } catch (error) {
    console.error('[PLAYER_CASHOUT_TASKS_CACHE] mirror failed', { firebaseId, error });
    return false;
  }
}

export async function mirrorPlayerCashoutTaskSnapshot(snap: DocumentSnapshot, source = 'appbeg') {
  if (!snap.exists) return false;
  return upsertPlayerCashoutTaskCache(
    toCacheInput(snap.id, (snap.data() || {}) as Record<string, unknown>, source)
  );
}

export async function mirrorPlayerCashoutTaskById(firebaseId: string, source = 'appbeg') {
  const cleanId = cleanText(firebaseId);
  if (!cleanId) return false;
  try {
    return mirrorPlayerCashoutTaskSnapshot(
      await adminDb.collection('playerCashoutTasks').doc(cleanId).get(),
      source
    );
  } catch (error) {
    console.error('[PLAYER_CASHOUT_TASKS_CACHE] mirror failed', { firebaseId: cleanId, error });
    return false;
  }
}

export async function tombstonePlayerCashoutTaskCache(firebaseId: string, source = 'appbeg') {
  const db = getPlayerMirrorPool();
  const cleanId = cleanText(firebaseId);
  if (!db || !cleanId) return false;
  try {
    await db.query(
      `
        INSERT INTO public.player_cashout_tasks_cache (
          firebase_id, source, mirrored_at, deleted_at, raw_firestore_data
        )
        VALUES ($1, $2, now(), now(), '{}'::jsonb)
        ON CONFLICT (firebase_id) DO UPDATE SET
          source = EXCLUDED.source,
          mirrored_at = now(),
          deleted_at = now()
      `,
      [cleanId, source]
    );
    logPlayerCacheInfo('[PLAYER_CASHOUT_TASKS_CACHE] tombstone ok', { firebaseId: cleanId });
    return true;
  } catch (error) {
    console.error('[PLAYER_CASHOUT_TASKS_CACHE] mirror failed', { firebaseId: cleanId, error });
    return false;
  }
}

export type CachedPlayerCashoutTask = {
  id: string;
  coadminUid: string;
  playerUid: string;
  playerUsername: string;
  amountNpr: number;
  paymentDetails: string;
  payoutMethod: string | null;
  qrImageUrl: string | null;
  paymentAppName: string | null;
  paymentAppCashTag: string | null;
  paymentAppAccountName: string | null;
  cashDeductedOnRequest: boolean | null;
  declinedByUids: string[];
  status: string;
  assignedHandlerUid: string | null;
  assignedHandlerUsername: string | null;
  startedAt: string | null;
  expiresAt: string | null;
  createdAt: string | null;
  completedAt: string | null;
  vendor?: VendorAwareness | null;
};

function mapCachedPlayerCashoutTaskRow(row: Record<string, unknown>): CachedPlayerCashoutTask | null {
  const id = cleanText(row.firebase_id);
  const playerUid = cleanText(row.player_uid);
  if (!id || !playerUid) {
    return null;
  }
  const declinedRaw = row.declined_by_uids;
  const declinedByUids = Array.isArray(declinedRaw)
    ? declinedRaw.map((entry) => String(entry)).filter(Boolean)
    : [];

  return {
    id,
    coadminUid: cleanText(row.coadmin_uid),
    playerUid,
    playerUsername: cleanText(row.player_username),
    amountNpr: Number(row.amount_npr || 0),
    paymentDetails: cleanText(row.payment_details),
    payoutMethod: cleanText(row.payout_method) || null,
    qrImageUrl: cleanText(row.qr_image_url) || null,
    paymentAppName: cleanText(row.payment_app_name) || null,
    paymentAppCashTag: cleanText(row.payment_app_cash_tag) || null,
    paymentAppAccountName: cleanText(row.payment_app_account_name) || null,
    cashDeductedOnRequest:
      typeof row.cash_deducted_on_request === 'boolean' ? row.cash_deducted_on_request : null,
    declinedByUids,
    status: cleanText(row.status) || 'pending',
    assignedHandlerUid: cleanText(row.assigned_handler_uid) || null,
    assignedHandlerUsername: cleanText(row.assigned_handler_username) || null,
    startedAt: toIsoString(row.started_at),
    expiresAt: toIsoString(row.expires_at),
    createdAt: toIsoString(row.created_at),
    completedAt: toIsoString(row.completed_at),
  };
}

async function readPlayerCashoutTasksBySql(
  sql: string,
  params: unknown[],
  label: string
): Promise<CachedPlayerCashoutTask[] | null> {
  const db = getPlayerMirrorPool();
  if (!db) {
    return null;
  }
  const startedAt = Date.now();
  try {
    const { rows } = await runMirrorPoolQuery<Record<string, unknown>>(db, sql, params, {
      context: 'player_cashout_tasks_cache_read',
    });
    const tasks = rows
      .map((row) => mapCachedPlayerCashoutTaskRow(row))
      .filter((task): task is CachedPlayerCashoutTask => Boolean(task));
    const enrichedTasks = await attachVendorAwarenessToPlayers(tasks);
    const durationMs = Date.now() - startedAt;
    if (isSqlCacheVerboseLogs() || durationMs >= SQL_QUERY_SLOW_MS) {
      logPlayerCacheInfo('[PLAYER_CASHOUT_TASKS_CACHE] read ok', {
        label,
        count: enrichedTasks.length,
        durationMs,
      });
    }
    return enrichedTasks;
  } catch (error) {
    const pg = extractPgErrorDetails(error);
    console.error('[PLAYER_CASHOUT_TASKS_CACHE_ERROR]', {
      uid: cleanText(params[0]) || null,
      scope: label,
      sqlMode: isCacheSqlAuthoritative(),
      query: sql.trim().split('\n')[0],
      durationMs: Date.now() - startedAt,
      ...pg,
    });
    return null;
  }
}

export async function readPlayerCashoutTasksCacheByPlayer(
  playerUid: string,
  limit = 50
): Promise<CachedPlayerCashoutTask[] | null> {
  const cleanPlayerUid = cleanText(playerUid);
  if (!cleanPlayerUid) {
    return [];
  }
  return readPlayerCashoutTasksBySql(
    `
      SELECT *
      FROM public.player_cashout_tasks_cache
      WHERE deleted_at IS NULL
        AND player_uid = $1
      ORDER BY created_at DESC NULLS LAST
      LIMIT $2
    `,
    [cleanPlayerUid, Math.max(1, Math.min(200, limit))],
    'by_player'
  );
}

export async function readPlayerCashoutTasksCacheByCoadmin(
  coadminUid: string,
  limit = 100,
  pendingOnly = false
): Promise<CachedPlayerCashoutTask[] | null> {
  const cleanCoadminUid = cleanText(coadminUid);
  if (!cleanCoadminUid) {
    return [];
  }
  const pendingWhere = pendingOnly
    ? `
        AND LOWER(COALESCE(status, '')) = 'pending'
        AND COALESCE(assigned_handler_uid, '') = ''
      `
    : '';
  return readPlayerCashoutTasksBySql(
    `
      SELECT *
      FROM public.player_cashout_tasks_cache
      WHERE deleted_at IS NULL
        AND coadmin_uid = $1
        ${pendingWhere}
      ORDER BY created_at DESC NULLS LAST
      LIMIT $2
    `,
    [cleanCoadminUid, Math.max(1, Math.min(200, limit))],
    'by_coadmin'
  );
}

export async function readStaffPendingCashoutTasks(
  coadminUid: string,
  limit = 50
): Promise<CachedPlayerCashoutTask[] | null> {
  const tasks = await readPlayerCashoutTasksCacheByCoadmin(coadminUid, limit, true);
  if (tasks === null) {
    return null;
  }
  return tasks.filter(
    (task) =>
      cleanText(task.status).toLowerCase() === 'pending' &&
      !cleanText(task.assignedHandlerUid)
  );
}

export async function readPlayerCashoutTaskCacheById(
  taskId: string
): Promise<CachedPlayerCashoutTask | null> {
  const cleanId = cleanText(taskId);
  if (!cleanId) {
    return null;
  }
  const tasks = await readPlayerCashoutTasksBySql(
    `
      SELECT *
      FROM public.player_cashout_tasks_cache
      WHERE deleted_at IS NULL
        AND firebase_id = $1
      LIMIT 1
    `,
    [cleanId],
    'by_id'
  );
  return tasks?.[0] ?? null;
}

export async function readStaffActiveCashoutTasks(
  coadminUid: string,
  staffUid: string,
  limit = 50
): Promise<CachedPlayerCashoutTask[] | null> {
  const cleanCoadminUid = cleanText(coadminUid);
  const cleanStaffUid = cleanText(staffUid);
  if (!cleanCoadminUid || !cleanStaffUid) {
    return [];
  }
  return readPlayerCashoutTasksBySql(
    `
      SELECT *
      FROM public.player_cashout_tasks_cache
      WHERE deleted_at IS NULL
        AND coadmin_uid = $1
        AND LOWER(COALESCE(status, '')) = 'in_progress'
        AND assigned_handler_uid = $2
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY started_at DESC NULLS LAST, created_at DESC NULLS LAST
      LIMIT $3
    `,
    [cleanCoadminUid, cleanStaffUid, Math.max(1, Math.min(200, limit))],
    'staff_active'
  );
}

export async function readStaffCompletedCashoutTasks(
  coadminUid: string,
  staffUid: string,
  limit = 50
): Promise<CachedPlayerCashoutTask[] | null> {
  const cleanCoadminUid = cleanText(coadminUid);
  const cleanStaffUid = cleanText(staffUid);
  if (!cleanCoadminUid || !cleanStaffUid) {
    return [];
  }
  return readPlayerCashoutTasksBySql(
    `
      SELECT *
      FROM public.player_cashout_tasks_cache
      WHERE deleted_at IS NULL
        AND coadmin_uid = $1
        AND LOWER(COALESCE(status, '')) = 'completed'
        AND COALESCE(
          NULLIF(raw_firestore_data->>'actorUid', ''),
          assigned_handler_uid
        ) = $2
      ORDER BY completed_at DESC NULLS LAST, created_at DESC NULLS LAST
      LIMIT $3
    `,
    [cleanCoadminUid, cleanStaffUid, Math.max(1, Math.min(200, limit))],
    'staff_completed'
  );
}

export async function readCoadminActiveCashoutTasks(
  coadminUid: string,
  limit = 50
): Promise<CachedPlayerCashoutTask[] | null> {
  const cleanCoadminUid = cleanText(coadminUid);
  if (!cleanCoadminUid) {
    return [];
  }
  return readPlayerCashoutTasksBySql(
    `
      SELECT *
      FROM public.player_cashout_tasks_cache
      WHERE deleted_at IS NULL
        AND coadmin_uid = $1
        AND LOWER(COALESCE(status, '')) = 'in_progress'
      ORDER BY started_at DESC NULLS LAST, created_at DESC NULLS LAST
      LIMIT $2
    `,
    [cleanCoadminUid, Math.max(1, Math.min(200, limit))],
    'coadmin_active'
  );
}

export async function readCoadminCompletedCashoutTasks(
  coadminUid: string,
  limit = 50
): Promise<CachedPlayerCashoutTask[] | null> {
  const cleanCoadminUid = cleanText(coadminUid);
  if (!cleanCoadminUid) {
    return [];
  }
  return readPlayerCashoutTasksBySql(
    `
      SELECT *
      FROM public.player_cashout_tasks_cache
      WHERE deleted_at IS NULL
        AND coadmin_uid = $1
        AND LOWER(COALESCE(status, '')) = 'completed'
      ORDER BY completed_at DESC NULLS LAST, created_at DESC NULLS LAST
      LIMIT $2
    `,
    [cleanCoadminUid, Math.max(1, Math.min(200, limit))],
    'coadmin_completed'
  );
}

export async function readPlayerCashoutTasksCacheByAssignedHandler(
  assignedHandlerUid: string,
  limit = 50
): Promise<CachedPlayerCashoutTask[] | null> {
  const cleanHandlerUid = cleanText(assignedHandlerUid);
  if (!cleanHandlerUid) {
    return [];
  }
  return readPlayerCashoutTasksBySql(
    `
      SELECT *
      FROM public.player_cashout_tasks_cache
      WHERE deleted_at IS NULL
        AND assigned_handler_uid = $1
      ORDER BY COALESCE(completed_at, created_at) DESC NULLS LAST
      LIMIT $2
    `,
    [cleanHandlerUid, Math.max(1, Math.min(200, limit))],
    'by_assigned_handler'
  );
}

export async function readPlayerCashoutTasksCacheAll(
  limit = 100
): Promise<CachedPlayerCashoutTask[] | null> {
  return readPlayerCashoutTasksBySql(
    `
      SELECT *
      FROM public.player_cashout_tasks_cache
      WHERE deleted_at IS NULL
      ORDER BY created_at DESC NULLS LAST
      LIMIT $1
    `,
    [Math.max(1, Math.min(200, limit))],
    'all'
  );
}

export async function getPlayerCashoutTaskCacheById(firebaseId: string) {
  const db = getPlayerMirrorPool();
  const cleanId = cleanText(firebaseId);
  if (!db || !cleanId) return null;
  try {
    const result = await db.query(
      'SELECT * FROM public.player_cashout_tasks_cache WHERE firebase_id = $1 LIMIT 1',
      [cleanId]
    );
    return result.rows[0] || null;
  } catch (error) {
    console.error('[PLAYER_CASHOUT_TASKS_CACHE] mirror failed', { firebaseId: cleanId, error });
    return null;
  }
}
