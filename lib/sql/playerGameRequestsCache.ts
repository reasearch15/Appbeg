import 'server-only';

import type { DocumentSnapshot } from 'firebase-admin/firestore';
import type { PoolClient } from 'pg';

import { adminDb } from '@/lib/firebase/admin';
import {
  cleanText,
  getPlayerMirrorPool,
  normalizeJson,
  numberOrNull,
  runMirrorClientQuery,
  runMirrorPoolQuery,
  toIsoString,
} from '@/lib/sql/playerMirrorCommon';
import { emitPlayerRequestOutboxEvent } from '@/lib/sql/liveOutbox';

export type PlayerGameRequestCacheInput = {
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

function normalizeGameName(value: unknown) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

function booleanOrNull(value: unknown) {
  return typeof value === 'boolean' ? value : null;
}

function jsonObjectOrNull(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return normalizeJson(value) || {};
}

function linkedTaskId(input: PlayerGameRequestCacheInput) {
  const explicit = cleanText(input.taskId);
  if (explicit) return explicit;
  const firebaseId = cleanText(input.firebaseId);
  return firebaseId ? `request__${firebaseId}` : '';
}

function toCacheInput(firebaseId: string, data: Record<string, unknown>, source: string) {
  return {
    firebaseId,
    ...data,
    rawFirestoreData: data,
    source,
  } satisfies PlayerGameRequestCacheInput;
}

export async function upsertPlayerGameRequestCache(input: PlayerGameRequestCacheInput) {
  const db = getPlayerMirrorPool();
  const firebaseId = cleanText(input.firebaseId);
  if (!db || !firebaseId) return false;

  try {
    await db.query(
      `
        INSERT INTO public.player_game_requests_cache (
          firebase_id, player_uid, player_username, coadmin_uid, created_by,
          game_name, normalized_game_name, current_username, game_account_username,
          type, status, amount, base_amount, bonus_percentage, bonus_event_id,
          first_recharge_match_applied, coin_deducted_on_request,
          coin_refunded_on_dismissal, coin_refunded_on_dismissal_at, task_id,
          automation_job_id, linked_job_id, automation_status, automation_error,
          retry_pending, retryable_failure, fake_redeem, fake_redeem_reason,
          dismiss_type, dismissed_by_automation, dismiss_reason_code,
          dismiss_reason_message, dismiss_reason, dismiss_meta, error_message,
          failure_reason, last_failure_reason, poke_message, created_at, updated_at,
          completed_at, poked_at, dismissed_at, failed_at, ttl_expires_at,
          reset_to_pending_at, returned_to_pending_at, pending_since, source,
          mirrored_at, deleted_at, raw_firestore_data
        )
        VALUES (
          $1, NULLIF($2, ''), NULLIF($3, ''), NULLIF($4, ''), NULLIF($5, ''),
          NULLIF($6, ''), NULLIF($7, ''), NULLIF($8, ''), NULLIF($9, ''),
          NULLIF($10, ''), NULLIF($11, ''), $12, $13, $14, NULLIF($15, ''),
          $16, $17, $18, $19::timestamptz, NULLIF($20, ''), NULLIF($21, ''),
          NULLIF($22, ''), NULLIF($23, ''), NULLIF($24, ''), $25, $26, $27,
          NULLIF($28, ''), NULLIF($29, ''), $30, NULLIF($31, ''), NULLIF($32, ''),
          NULLIF($33, ''), $34::jsonb, NULLIF($35, ''), NULLIF($36, ''),
          NULLIF($37, ''), NULLIF($38, ''), $39::timestamptz, $40::timestamptz,
          $41::timestamptz, $42::timestamptz, $43::timestamptz, $44::timestamptz,
          $45::timestamptz, $46::timestamptz, $47::timestamptz, $48::timestamptz,
          $49, now(), NULL, $50::jsonb
        )
        ON CONFLICT (firebase_id) DO UPDATE SET
          player_uid = EXCLUDED.player_uid,
          player_username = EXCLUDED.player_username,
          coadmin_uid = EXCLUDED.coadmin_uid,
          created_by = EXCLUDED.created_by,
          game_name = EXCLUDED.game_name,
          normalized_game_name = EXCLUDED.normalized_game_name,
          current_username = EXCLUDED.current_username,
          game_account_username = EXCLUDED.game_account_username,
          type = EXCLUDED.type,
          status = EXCLUDED.status,
          amount = EXCLUDED.amount,
          base_amount = EXCLUDED.base_amount,
          bonus_percentage = EXCLUDED.bonus_percentage,
          bonus_event_id = EXCLUDED.bonus_event_id,
          first_recharge_match_applied = EXCLUDED.first_recharge_match_applied,
          coin_deducted_on_request = EXCLUDED.coin_deducted_on_request,
          coin_refunded_on_dismissal = EXCLUDED.coin_refunded_on_dismissal,
          coin_refunded_on_dismissal_at = EXCLUDED.coin_refunded_on_dismissal_at,
          task_id = EXCLUDED.task_id,
          automation_job_id = EXCLUDED.automation_job_id,
          linked_job_id = EXCLUDED.linked_job_id,
          automation_status = EXCLUDED.automation_status,
          automation_error = EXCLUDED.automation_error,
          retry_pending = EXCLUDED.retry_pending,
          retryable_failure = EXCLUDED.retryable_failure,
          fake_redeem = EXCLUDED.fake_redeem,
          fake_redeem_reason = EXCLUDED.fake_redeem_reason,
          dismiss_type = EXCLUDED.dismiss_type,
          dismissed_by_automation = EXCLUDED.dismissed_by_automation,
          dismiss_reason_code = EXCLUDED.dismiss_reason_code,
          dismiss_reason_message = EXCLUDED.dismiss_reason_message,
          dismiss_reason = EXCLUDED.dismiss_reason,
          dismiss_meta = EXCLUDED.dismiss_meta,
          error_message = EXCLUDED.error_message,
          failure_reason = EXCLUDED.failure_reason,
          last_failure_reason = EXCLUDED.last_failure_reason,
          poke_message = EXCLUDED.poke_message,
          created_at = COALESCE(public.player_game_requests_cache.created_at, EXCLUDED.created_at),
          updated_at = EXCLUDED.updated_at,
          completed_at = EXCLUDED.completed_at,
          poked_at = EXCLUDED.poked_at,
          dismissed_at = EXCLUDED.dismissed_at,
          failed_at = EXCLUDED.failed_at,
          ttl_expires_at = EXCLUDED.ttl_expires_at,
          reset_to_pending_at = EXCLUDED.reset_to_pending_at,
          returned_to_pending_at = EXCLUDED.returned_to_pending_at,
          pending_since = EXCLUDED.pending_since,
          source = EXCLUDED.source,
          mirrored_at = now(),
          deleted_at = NULL,
          raw_firestore_data = EXCLUDED.raw_firestore_data
      `,
      [
        firebaseId,
        cleanText(input.playerUid || input.playerId),
        cleanText(input.playerUsername || input.username),
        cleanText(input.coadminUid || input.createdBy),
        cleanText(input.createdBy),
        cleanText(input.gameName || input.game),
        normalizeGameName(input.gameName || input.game),
        cleanText(input.currentUsername),
        cleanText(input.gameAccountUsername),
        cleanText(input.type || input.requestType),
        cleanText(input.status),
        numberOrNull(input.amount),
        numberOrNull(input.baseAmount),
        numberOrNull(input.bonusPercentage),
        cleanText(input.bonusEventId),
        booleanOrNull(input.firstRechargeMatchApplied),
        booleanOrNull(input.coinDeductedOnRequest),
        booleanOrNull(input.coinRefundedOnDismissal),
        toIsoString(input.coinRefundedOnDismissalAt),
        linkedTaskId(input),
        cleanText(input.automationJobId),
        cleanText(input.linkedJobId),
        cleanText(input.automationStatus),
        cleanText(input.automationError),
        booleanOrNull(input.retryPending),
        booleanOrNull(input.retryableFailure),
        booleanOrNull(input.fakeRedeem),
        cleanText(input.fakeRedeemReason),
        cleanText(input.dismissType),
        booleanOrNull(input.dismissedByAutomation),
        cleanText(input.dismissReasonCode),
        cleanText(input.dismissReasonMessage),
        cleanText(input.dismissReason),
        JSON.stringify(jsonObjectOrNull(input.dismissMeta)),
        cleanText(input.error || input.errorMessage),
        cleanText(input.failureReason),
        cleanText(input.lastFailureReason),
        cleanText(input.pokeMessage),
        toIsoString(input.createdAt),
        toIsoString(input.updatedAt),
        toIsoString(input.completedAt),
        toIsoString(input.pokedAt),
        toIsoString(input.dismissedAt),
        toIsoString(input.failedAt),
        toIsoString(input.ttlExpiresAt),
        toIsoString(input.resetToPendingAt),
        toIsoString(input.returnedToPendingAt),
        toIsoString(input.pendingSince),
        cleanText(input.source) || 'firestore',
        JSON.stringify(normalizeJson(input.rawFirestoreData || {}) || {}),
      ]
    );
    logPlayerCacheInfo('[PLAYER_GAME_REQUESTS_CACHE] mirror upsert ok', { firebaseId });
    void emitPlayerRequestOutboxEvent({
      firebaseId,
      playerUid: cleanText(input.playerUid || input.playerId),
      eventType: 'request.upserted',
      type: input.type || input.requestType,
      status: input.status,
      gameName: input.gameName || input.game,
      amount: input.amount,
      baseAmount: input.baseAmount,
      automationStatus: input.automationStatus,
      playerMessage: input.playerMessage,
      pokeMessage: input.pokeMessage,
      updatedAt: input.updatedAt,
      mirroredAt: new Date().toISOString(),
      source: cleanText(input.source) || 'firestore',
    }).catch(() => undefined);
    return true;
  } catch (error) {
    console.error('[PLAYER_GAME_REQUESTS_CACHE] mirror failed', { firebaseId, error });
    return false;
  }
}

export async function mirrorPlayerGameRequestSnapshot(snap: DocumentSnapshot, source = 'appbeg') {
  if (!snap.exists) return false;
  return upsertPlayerGameRequestCache(
    toCacheInput(snap.id, (snap.data() || {}) as Record<string, unknown>, source)
  );
}

export async function mirrorPlayerGameRequestById(firebaseId: string, source = 'appbeg') {
  const cleanId = cleanText(firebaseId);
  if (!cleanId) return false;
  try {
    return mirrorPlayerGameRequestSnapshot(
      await adminDb.collection('playerGameRequests').doc(cleanId).get(),
      source
    );
  } catch (error) {
    console.error('[PLAYER_GAME_REQUESTS_CACHE] mirror failed', { firebaseId: cleanId, error });
    return false;
  }
}

export async function tombstonePlayerGameRequestCache(firebaseId: string, source = 'appbeg') {
  const db = getPlayerMirrorPool();
  const cleanId = cleanText(firebaseId);
  if (!db || !cleanId) return false;
  try {
    let playerUid = '';
    try {
      const existing = await db.query(
        `
          SELECT player_uid
          FROM public.player_game_requests_cache
          WHERE firebase_id = $1
          LIMIT 1
        `,
        [cleanId]
      );
      playerUid = cleanText(existing.rows[0]?.player_uid);
    } catch {
      // Best-effort lookup for live shadow emit only.
    }

    await db.query(
      `
        INSERT INTO public.player_game_requests_cache (
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
    logPlayerCacheInfo('[PLAYER_GAME_REQUESTS_CACHE] tombstone ok', { firebaseId: cleanId });
    if (playerUid) {
      void emitPlayerRequestOutboxEvent({
        firebaseId: cleanId,
        playerUid,
        eventType: 'request.tombstoned',
        status: 'tombstoned',
        source,
        mirroredAt: new Date().toISOString(),
      }).catch(() => undefined);
    } else {
      logPlayerCacheInfo('[LIVE_OUTBOX] failed', {
        reason: 'tombstone_player_uid_unavailable',
        firebaseId: cleanId,
      });
    }
    return true;
  } catch (error) {
    console.error('[PLAYER_GAME_REQUESTS_CACHE] mirror failed', { firebaseId: cleanId, error });
    return false;
  }
}

export type CompletedRechargeCacheRow = {
  firebaseId: string;
  amount: number;
  createdAtMs: number;
  bonusEventId: string;
  bonusPercentage: number | null;
};

const COMPLETED_RECHARGES_BY_PLAYER_SQL = `
  SELECT
    firebase_id,
    amount,
    bonus_event_id,
    bonus_percentage,
    completed_at,
    created_at
  FROM public.player_game_requests_cache
  WHERE deleted_at IS NULL
    AND player_uid = $1
    AND type = 'recharge'
    AND status = 'completed'
  ORDER BY COALESCE(completed_at, created_at, mirrored_at) ASC
`;

function rechargeCreatedAtMs(row: Record<string, unknown>) {
  const completedAt = toIsoString(row.completed_at);
  const createdAt = toIsoString(row.created_at);
  const completedMs = completedAt ? Date.parse(completedAt) : 0;
  const createdMs = createdAt ? Date.parse(createdAt) : 0;
  return Math.max(completedMs, createdMs);
}

const FIRST_RECHARGE_MATCH_APPLIED_SQL = `
  SELECT 1
  FROM public.player_game_requests_cache
  WHERE deleted_at IS NULL
    AND player_uid = $1
    AND type = 'recharge'
    AND first_recharge_match_applied = TRUE
    AND LOWER(COALESCE(status, '')) NOT IN ('failed', 'dismissed')
  LIMIT 1
`;

export async function hasFirstRechargeMatchAppliedFromSqlWithClient(
  client: PoolClient,
  playerUid: string
): Promise<boolean> {
  const cleanPlayerUid = cleanText(playerUid);
  const { rows } = await runMirrorClientQuery<Record<string, unknown>>(
    client,
    FIRST_RECHARGE_MATCH_APPLIED_SQL,
    [cleanPlayerUid]
  );
  return rows.length > 0;
}

export async function hasFirstRechargeMatchAppliedFromSql(
  playerUid: string
): Promise<boolean | null> {
  const cleanPlayerUid = cleanText(playerUid);
  const db = getPlayerMirrorPool();
  if (!db || !cleanPlayerUid) {
    return null;
  }

  try {
    const startedAt = Date.now();
    const { rows } = await runMirrorPoolQuery<Record<string, unknown>>(
      db,
      FIRST_RECHARGE_MATCH_APPLIED_SQL,
      [cleanPlayerUid]
    );
    logPlayerCacheInfo('[PLAYER_GAME_REQUESTS_CACHE] first_recharge_match_applied read ok', {
      playerUid: cleanPlayerUid,
      hasApplied: rows.length > 0,
      durationMs: Date.now() - startedAt,
    });
    return rows.length > 0;
  } catch (error) {
    console.warn('[PLAYER_GAME_REQUESTS_CACHE] first_recharge_match_applied postgres read failed', {
      playerUid: cleanPlayerUid,
      error,
    });
    return null;
  }
}

/** Alias for recharge Finance Layer 1 first-recharge eligibility reads. */
export const hasCompletedRechargeRequestInCache = hasFirstRechargeMatchAppliedFromSql;

function mapCompletedRechargeRows(rows: Record<string, unknown>[]): CompletedRechargeCacheRow[] {
  return rows.map((row) => ({
    firebaseId: cleanText(row.firebase_id),
    amount: Math.max(0, numberOrNull(row.amount) ?? 0),
    createdAtMs: rechargeCreatedAtMs(row),
    bonusEventId: cleanText(row.bonus_event_id),
    bonusPercentage: cleanText(row.bonus_event_id)
      ? numberOrNull(row.bonus_percentage)
      : null,
  }));
}

export async function readCompletedRechargeRequestsForPlayerWithClient(
  client: PoolClient,
  playerUid: string
): Promise<CompletedRechargeCacheRow[]> {
  const cleanPlayerUid = cleanText(playerUid);
  const { rows } = await runMirrorClientQuery<Record<string, unknown>>(
    client,
    COMPLETED_RECHARGES_BY_PLAYER_SQL,
    [cleanPlayerUid]
  );
  return mapCompletedRechargeRows(rows);
}

export async function readCompletedRechargeRequestsForPlayer(
  playerUid: string
): Promise<CompletedRechargeCacheRow[] | null> {
  const cleanPlayerUid = cleanText(playerUid);
  const db = getPlayerMirrorPool();
  if (!db || !cleanPlayerUid) {
    return null;
  }

  try {
    const startedAt = Date.now();
    const { rows } = await runMirrorPoolQuery<Record<string, unknown>>(
      db,
      COMPLETED_RECHARGES_BY_PLAYER_SQL,
      [cleanPlayerUid]
    );
    logPlayerCacheInfo('[PLAYER_GAME_REQUESTS_CACHE] completed_recharges read ok', {
      playerUid: cleanPlayerUid,
      count: rows.length,
      durationMs: Date.now() - startedAt,
    });
    return mapCompletedRechargeRows(rows);
  } catch (error) {
    console.warn('[PLAYER_GAME_REQUESTS_CACHE] completed_recharges postgres read failed', {
      playerUid: cleanPlayerUid,
      error,
    });
    return null;
  }
}

export async function getPlayerGameRequestCacheById(firebaseId: string) {
  const db = getPlayerMirrorPool();
  const cleanId = cleanText(firebaseId);
  if (!db || !cleanId) return null;
  try {
    const result = await db.query(
      'SELECT * FROM public.player_game_requests_cache WHERE firebase_id = $1 LIMIT 1',
      [cleanId]
    );
    return result.rows[0] || null;
  } catch (error) {
    console.error('[PLAYER_GAME_REQUESTS_CACHE] mirror failed', { firebaseId: cleanId, error });
    return null;
  }
}
