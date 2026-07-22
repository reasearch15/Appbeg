import 'server-only';

import type { DocumentSnapshot } from 'firebase-admin/firestore';

import { adminDb } from '@/lib/firebase/admin';
import {
  API_ROUTE_SLOW_MS,
  debugLog,
  isAppDebugLoggingEnabled,
} from '@/lib/server/verboseLogs';
import {
  mirrorBatchLogFields,
  mirrorErrorLogFields,
  runCarerTaskMirrorBatchItem,
} from '@/lib/sql/carerTasksCacheMirrorLog';
import {
  runQueuedCarerTaskTombstone,
  runQueuedCarerTaskUpsert,
} from '@/lib/sql/carerTasksMirrorQueue';
import { emitCarerTaskOutboxEvent } from '@/lib/sql/liveOutbox';
import {
  cleanText,
  createPlayerMirrorSqlTiming,
  getPlayerMirrorPool,
  isPgConnectionTimeoutError,
  logPlayerMirrorPoolStats,
  normalizeJson,
  numberOrNull,
  runMirrorPoolQuery,
  toIsoString,
  type PlayerMirrorSqlTiming,
} from '@/lib/sql/playerMirrorCommon';

export type CarerTaskCacheInput = {
  firebaseId: string;
  rawFirestoreData?: Record<string, unknown>;
  source?: string;
} & Record<string, unknown>;

function normalizeGameName(value: unknown) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

function booleanOrNull(value: unknown) {
  return typeof value === 'boolean' ? value : null;
}

function toCacheInput(firebaseId: string, data: Record<string, unknown>, source: string) {
  return {
    firebaseId,
    ...data,
    rawFirestoreData: data,
    source,
  } satisfies CarerTaskCacheInput;
}

async function upsertCarerTaskCacheDirect(input: CarerTaskCacheInput) {
  const db = getPlayerMirrorPool();
  const firebaseId = cleanText(input.firebaseId);
  if (!db || !firebaseId) return false;

  const batchLog = mirrorBatchLogFields(firebaseId);
  console.info('[CARER_TASKS_CACHE] starting batch', {
    action: 'upsert',
    ...batchLog,
  });

  try {
    const incomingSource = cleanText(input.source) || 'appbeg';
    const incomingUpdatedAtMs = (() => {
      const raw = toIsoString(input.updatedAt);
      const parsed = raw ? Date.parse(raw) : NaN;
      return Number.isFinite(parsed) ? parsed : Date.now();
    })();
    const existing = await db.query(
      `
        SELECT status, deleted_at, source, updated_at
        FROM public.carer_tasks_cache
        WHERE firebase_id = $1
        LIMIT 1
      `,
      [firebaseId]
    );
    if (existing.rows.length) {
      const row = existing.rows[0] as {
        status?: string | null;
        deleted_at?: string | null;
        source?: string | null;
        updated_at?: string | null;
      };
      if (row.deleted_at) {
        console.info('[CARER_TASK_RESURRECTION_AUDIT]', {
          taskId: firebaseId,
          source: cleanText(input.source) || 'unknown',
          oldStatus: cleanText(row.status) || null,
          newStatus: cleanText(input.status) || null,
          oldDeletedAt: toIsoString(row.deleted_at),
          newDeletedAt: null,
          action: 'upsert',
          blocked: true,
          reason: 'tombstoned_row_preserved',
        });
        return false;
      }
      const existingSource = cleanText(row.source);
      const isIncomingFirestoreMirror = !incomingSource.startsWith('authority');
      if (existingSource.startsWith('authority') && isIncomingFirestoreMirror) {
        const existingUpdatedAtMs = (() => {
          const parsed = Date.parse(toIsoString(row.updated_at) || '');
          return Number.isFinite(parsed) ? parsed : 0;
        })();
        if (existingUpdatedAtMs && incomingUpdatedAtMs <= existingUpdatedAtMs + 1000) {
          console.info('[CARER_TASK_MIRROR_SKIP_STALE]', {
            taskId: firebaseId,
            existingSource,
            incomingSource,
            existingStatus: cleanText(row.status) || null,
            incomingStatus: cleanText(input.status) || null,
            existingUpdatedAt: toIsoString(row.updated_at),
            incomingUpdatedAt: toIsoString(input.updatedAt),
            reason: 'authority_row_newer_than_firestore_mirror',
          });
          return false;
        }
      }
    }

    await db.query(
      `
        INSERT INTO public.carer_tasks_cache (
          firebase_id, coadmin_uid, type, player_uid, player_username, game_name,
          normalized_game_name, amount, request_id, status, assigned_carer_uid,
          assigned_carer_username, assigned_carer, claimed_status, claimed_by_uid,
          claimed_by_username, completed_by_carer_uid, completed_by_carer_username,
          current_username, game_account_username, login_url, game_login_url, lobby_url,
          site_url, base_url, game_credential_username, game_credential_password,
          is_poked, poke_message, automation_status, automation_job_id, linked_job_id,
          current_job_id, active_job_id, assigned_job_status, automation_error,
          error_message, failure_reason, last_failure_reason, retry_pending, fake_redeem,
          dismiss_type, dismissed_by_automation, completion_issue_code, completion_issue,
          created_at, updated_at, started_at, running_at, expires_at, completed_at,
          cancelled_at, failed_at, ttl_expires_at, claimed_at, last_heartbeat_at,
          automation_updated_at, reset_to_pending_at, returned_to_pending_at,
          pending_since, queued_at, deleted_from_pending_at, source, mirrored_at,
          deleted_at, raw_firestore_data
        )
        VALUES (
          $1, NULLIF($2, ''), NULLIF($3, ''), NULLIF($4, ''), NULLIF($5, ''),
          NULLIF($6, ''), NULLIF($7, ''), $8, NULLIF($9, ''), NULLIF($10, ''),
          NULLIF($11, ''), NULLIF($12, ''), NULLIF($13, ''), NULLIF($14, ''),
          NULLIF($15, ''), NULLIF($16, ''), NULLIF($17, ''), NULLIF($18, ''),
          NULLIF($19, ''), NULLIF($20, ''), NULLIF($21, ''), NULLIF($22, ''),
          NULLIF($23, ''), NULLIF($24, ''), NULLIF($25, ''), NULLIF($26, ''),
          NULLIF($27, ''), $28, NULLIF($29, ''), NULLIF($30, ''), NULLIF($31, ''),
          NULLIF($32, ''), NULLIF($33, ''), NULLIF($34, ''), NULLIF($35, ''),
          NULLIF($36, ''), NULLIF($37, ''), NULLIF($38, ''), NULLIF($39, ''),
          $40, $41, NULLIF($42, ''), $43, NULLIF($44, ''), NULLIF($45, ''),
          $46::timestamptz, $47::timestamptz, $48::timestamptz, $49::timestamptz,
          $50::timestamptz, $51::timestamptz, $52::timestamptz, $53::timestamptz,
          $54::timestamptz, $55::timestamptz, $56::timestamptz, $57::timestamptz,
          $58::timestamptz, $59::timestamptz, $60::timestamptz, $61::timestamptz,
          $62::timestamptz, $63, now(), NULL, $64::jsonb
        )
        ON CONFLICT (firebase_id) DO UPDATE SET
          coadmin_uid = EXCLUDED.coadmin_uid,
          type = EXCLUDED.type,
          player_uid = EXCLUDED.player_uid,
          player_username = EXCLUDED.player_username,
          game_name = EXCLUDED.game_name,
          normalized_game_name = EXCLUDED.normalized_game_name,
          amount = EXCLUDED.amount,
          request_id = EXCLUDED.request_id,
          status = EXCLUDED.status,
          assigned_carer_uid = EXCLUDED.assigned_carer_uid,
          assigned_carer_username = EXCLUDED.assigned_carer_username,
          assigned_carer = EXCLUDED.assigned_carer,
          claimed_status = EXCLUDED.claimed_status,
          claimed_by_uid = EXCLUDED.claimed_by_uid,
          claimed_by_username = EXCLUDED.claimed_by_username,
          completed_by_carer_uid = EXCLUDED.completed_by_carer_uid,
          completed_by_carer_username = EXCLUDED.completed_by_carer_username,
          current_username = EXCLUDED.current_username,
          game_account_username = EXCLUDED.game_account_username,
          login_url = EXCLUDED.login_url,
          game_login_url = EXCLUDED.game_login_url,
          lobby_url = EXCLUDED.lobby_url,
          site_url = EXCLUDED.site_url,
          base_url = EXCLUDED.base_url,
          game_credential_username = EXCLUDED.game_credential_username,
          game_credential_password = EXCLUDED.game_credential_password,
          is_poked = EXCLUDED.is_poked,
          poke_message = EXCLUDED.poke_message,
          automation_status = EXCLUDED.automation_status,
          automation_job_id = EXCLUDED.automation_job_id,
          linked_job_id = EXCLUDED.linked_job_id,
          current_job_id = EXCLUDED.current_job_id,
          active_job_id = EXCLUDED.active_job_id,
          assigned_job_status = EXCLUDED.assigned_job_status,
          automation_error = EXCLUDED.automation_error,
          error_message = EXCLUDED.error_message,
          failure_reason = EXCLUDED.failure_reason,
          last_failure_reason = EXCLUDED.last_failure_reason,
          retry_pending = EXCLUDED.retry_pending,
          fake_redeem = EXCLUDED.fake_redeem,
          dismiss_type = EXCLUDED.dismiss_type,
          dismissed_by_automation = EXCLUDED.dismissed_by_automation,
          completion_issue_code = EXCLUDED.completion_issue_code,
          completion_issue = EXCLUDED.completion_issue,
          created_at = COALESCE(public.carer_tasks_cache.created_at, EXCLUDED.created_at),
          updated_at = EXCLUDED.updated_at,
          started_at = EXCLUDED.started_at,
          running_at = EXCLUDED.running_at,
          expires_at = EXCLUDED.expires_at,
          completed_at = EXCLUDED.completed_at,
          cancelled_at = EXCLUDED.cancelled_at,
          failed_at = EXCLUDED.failed_at,
          ttl_expires_at = EXCLUDED.ttl_expires_at,
          claimed_at = EXCLUDED.claimed_at,
          last_heartbeat_at = EXCLUDED.last_heartbeat_at,
          automation_updated_at = EXCLUDED.automation_updated_at,
          reset_to_pending_at = EXCLUDED.reset_to_pending_at,
          returned_to_pending_at = EXCLUDED.returned_to_pending_at,
          pending_since = EXCLUDED.pending_since,
          queued_at = EXCLUDED.queued_at,
          deleted_from_pending_at = EXCLUDED.deleted_from_pending_at,
          source = EXCLUDED.source,
          mirrored_at = now(),
          deleted_at = NULL,
          raw_firestore_data = EXCLUDED.raw_firestore_data
      `,
      [
        firebaseId,
        cleanText(input.coadminUid || input.createdBy),
        cleanText(input.type || input.kind || input.action || input.taskAction),
        cleanText(input.playerUid || input.playerId),
        cleanText(input.playerUsername || input.username),
        cleanText(input.gameName || input.game),
        normalizeGameName(input.gameName || input.game),
        numberOrNull(input.amount),
        cleanText(input.requestId),
        cleanText(input.status),
        cleanText(input.assignedCarerUid),
        cleanText(input.assignedCarerUsername),
        cleanText(input.assignedCarer),
        cleanText(input.claimedStatus),
        cleanText(input.claimedByUid),
        cleanText(input.claimedByUsername),
        cleanText(input.completedByCarerUid),
        cleanText(input.completedByCarerUsername),
        cleanText(input.currentUsername),
        cleanText(input.gameAccountUsername),
        cleanText(input.loginUrl),
        cleanText(input.gameLoginUrl),
        cleanText(input.lobbyUrl),
        cleanText(input.siteUrl),
        cleanText(input.baseUrl),
        cleanText(input.gameCredentialUsername),
        cleanText(input.gameCredentialPassword),
        booleanOrNull(input.isPoked),
        cleanText(input.pokeMessage),
        cleanText(input.automationStatus),
        cleanText(input.automationJobId),
        cleanText(input.linkedJobId),
        cleanText(input.currentJobId),
        cleanText(input.activeJobId),
        cleanText(input.assignedJobStatus),
        cleanText(input.automationError),
        cleanText(input.error || input.errorMessage),
        cleanText(input.failureReason),
        cleanText(input.lastFailureReason),
        booleanOrNull(input.retryPending),
        booleanOrNull(input.fakeRedeem),
        cleanText(input.dismissType),
        booleanOrNull(input.dismissedByAutomation),
        cleanText(input.completionIssueCode),
        cleanText(input.completionIssue),
        toIsoString(input.createdAt),
        toIsoString(input.updatedAt),
        toIsoString(input.startedAt),
        toIsoString(input.runningAt),
        toIsoString(input.expiresAt),
        toIsoString(input.completedAt),
        toIsoString(input.cancelledAt),
        toIsoString(input.failedAt),
        toIsoString(input.ttlExpiresAt),
        toIsoString(input.claimedAt),
        toIsoString(input.lastHeartbeatAt),
        toIsoString(input.automationUpdatedAt),
        toIsoString(input.resetToPendingAt),
        toIsoString(input.returnedToPendingAt),
        toIsoString(input.pendingSince),
        toIsoString(input.queuedAt),
        toIsoString(input.deletedFromPendingAt),
        cleanText(input.source) || 'appbeg',
        JSON.stringify(normalizeJson(input.rawFirestoreData || {}) || {}),
      ]
    );
    console.info('[CARER_TASKS_CACHE] batch succeeded', {
      action: 'upsert',
      rowCount: 1,
      ...batchLog,
    });
    console.info('[CARER_TASKS_CACHE] mirror upsert ok', { firebaseId });
    void emitCarerTaskOutboxEvent({
      firebaseId,
      coadminUid: input.coadminUid || input.createdBy,
      assignedCarerUid: input.assignedCarerUid,
      claimedByUid: input.claimedByUid,
      playerUid: input.playerUid || input.playerId,
      type: input.type || input.kind || input.action || input.taskAction,
      status: input.status,
      automationStatus: input.automationStatus,
      gameName: input.gameName || input.game,
      amount: input.amount,
      requestId: input.requestId,
      updatedAt: input.updatedAt,
      mirroredAt: new Date().toISOString(),
      source: cleanText(input.source) || 'appbeg',
      eventType: 'task.upserted',
    }).catch(() => undefined);
    return true;
  } catch (error) {
    console.error('[CARER_TASKS_CACHE] batch failed', {
      action: 'upsert',
      ...batchLog,
      ...mirrorErrorLogFields(error),
    });
    if (isPgConnectionTimeoutError(error)) {
      logPlayerMirrorPoolStats('carer_tasks_cache_upsert');
    }
    console.error('[CARER_TASKS_CACHE] mirror failed', {
      firebaseId,
      ...mirrorErrorLogFields(error),
    });
    return false;
  }
}

export async function upsertCarerTaskCache(input: CarerTaskCacheInput) {
  const firebaseId = cleanText(input.firebaseId);
  if (!firebaseId) return false;
  return runQueuedCarerTaskUpsert(firebaseId, input, upsertCarerTaskCacheDirect);
}

export async function mirrorCarerTaskSnapshot(snap: DocumentSnapshot, source = 'appbeg') {
  if (!snap.exists) return false;
  return upsertCarerTaskCache(
    toCacheInput(snap.id, (snap.data() || {}) as Record<string, unknown>, source)
  );
}

export async function mirrorCarerTaskById(firebaseId: string, source = 'appbeg') {
  const cleanId = cleanText(firebaseId);
  if (!cleanId) return false;
  try {
    return mirrorCarerTaskSnapshot(
      await adminDb.collection('carerTasks').doc(cleanId).get(),
      source
    );
  } catch (error) {
    console.error('[CARER_TASKS_CACHE] mirror failed', { firebaseId: cleanId, error });
    return false;
  }
}

export async function mirrorCarerTaskSnapshotsBatch(
  snaps: DocumentSnapshot[],
  source = 'appbeg'
) {
  let mirrored = 0;
  for (const snap of snaps) {
    if (!snap.exists) continue;
    if (await mirrorCarerTaskSnapshot(snap, source)) {
      mirrored += 1;
    }
  }
  return mirrored;
}

export async function mirrorCarerTaskIdsBatch(taskIds: string[], source = 'appbeg') {
  const cleanIds = taskIds.map(cleanText).filter(Boolean);
  if (!cleanIds.length) return 0;

  let mirrored = 0;
  for (let index = 0; index < cleanIds.length; index += 1) {
    const taskId = cleanIds[index];
    const batchIndex = index + 1;
    const batchResult = await runCarerTaskMirrorBatchItem(cleanIds, batchIndex, taskId, async () => {
      try {
        const snap = await adminDb.collection('carerTasks').doc(taskId).get();
        return mirrorCarerTaskSnapshot(snap, source);
      } catch (error) {
        console.error('[CARER_TASKS_CACHE] batch failed', {
          action: 'upsert',
          ...mirrorBatchLogFields(taskId),
          ...mirrorErrorLogFields(error),
        });
        console.error('[CARER_TASKS_CACHE] mirror failed', {
          firebaseId: taskId,
          ...mirrorErrorLogFields(error),
        });
        return false;
      }
    });
    if (batchResult) {
      mirrored += 1;
    }
  }
  return mirrored;
}

async function tombstoneCarerTaskCacheDirect(firebaseId: string, source = 'appbeg') {
  const db = getPlayerMirrorPool();
  const cleanId = cleanText(firebaseId);
  if (!db || !cleanId) return false;
  const batchLog = mirrorBatchLogFields(cleanId);
  try {
    let emitContext: {
      coadminUid?: string;
      assignedCarerUid?: string;
      claimedByUid?: string;
      playerUid?: string;
      type?: string;
      status?: string;
      automationStatus?: string;
      gameName?: string;
      amount?: unknown;
      requestId?: string;
    } = {};
    try {
      const existing = await db.query(
        `
          SELECT
            coadmin_uid,
            assigned_carer_uid,
            claimed_by_uid,
            player_uid,
            type,
            status,
            automation_status,
            game_name,
            amount,
            request_id
          FROM public.carer_tasks_cache
          WHERE firebase_id = $1
          LIMIT 1
        `,
        [cleanId]
      );
      const row = existing.rows[0] as Record<string, unknown> | undefined;
      if (row) {
        emitContext = {
          coadminUid: cleanText(row.coadmin_uid),
          assignedCarerUid: cleanText(row.assigned_carer_uid),
          claimedByUid: cleanText(row.claimed_by_uid),
          playerUid: cleanText(row.player_uid),
          type: cleanText(row.type),
          status: cleanText(row.status),
          automationStatus: cleanText(row.automation_status),
          gameName: cleanText(row.game_name),
          amount: row.amount,
          requestId: cleanText(row.request_id),
        };
      }
    } catch {
      // Best-effort lookup for live shadow emit only.
    }

    console.info('[CARER_TASKS_CACHE] starting batch', {
      action: 'tombstone',
      ...batchLog,
    });

    await db.query(
      `
        INSERT INTO public.carer_tasks_cache (
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
    console.info('[CARER_TASKS_CACHE] batch succeeded', {
      action: 'tombstone',
      rowCount: 1,
      ...batchLog,
    });
    console.info('[CARER_TASKS_CACHE] tombstone ok', { firebaseId: cleanId });
    void emitCarerTaskOutboxEvent({
      firebaseId: cleanId,
      ...emitContext,
      status: 'tombstoned',
      updatedAt: new Date().toISOString(),
      mirroredAt: new Date().toISOString(),
      source,
      eventType: 'task.tombstoned',
    }).catch(() => undefined);
    return true;
  } catch (error) {
    console.error('[CARER_TASKS_CACHE] batch failed', {
      action: 'tombstone',
      ...batchLog,
      ...mirrorErrorLogFields(error),
    });
    if (isPgConnectionTimeoutError(error)) {
      logPlayerMirrorPoolStats('carer_tasks_cache_tombstone');
    }
    console.error('[CARER_TASKS_CACHE] tombstone failed', {
      firebaseId: cleanId,
      ...mirrorErrorLogFields(error),
    });
    return false;
  }
}

export async function tombstoneCarerTaskCache(firebaseId: string, source = 'appbeg') {
  const cleanId = cleanText(firebaseId);
  if (!cleanId) return false;
  return runQueuedCarerTaskTombstone(cleanId, source, tombstoneCarerTaskCacheDirect);
}

export async function tombstoneCarerTaskIdsBatch(taskIds: string[], source = 'appbeg') {
  const cleanIds = taskIds.map(cleanText).filter(Boolean);
  if (!cleanIds.length) return 0;

  let mirrored = 0;
  for (let index = 0; index < cleanIds.length; index += 1) {
    const taskId = cleanIds[index];
    const batchIndex = index + 1;
    const batchResult = await runCarerTaskMirrorBatchItem(cleanIds, batchIndex, taskId, async () =>
      tombstoneCarerTaskCache(taskId, source)
    );
    if (batchResult) {
      mirrored += 1;
    }
  }
  return mirrored;
}

export async function getCarerTaskCacheById(firebaseId: string) {
  const db = getPlayerMirrorPool();
  const cleanId = cleanText(firebaseId);
  if (!db || !cleanId) return null;
  try {
    const result = await db.query(
      'SELECT * FROM public.carer_tasks_cache WHERE firebase_id = $1 LIMIT 1',
      [cleanId]
    );
    return result.rows[0] || null;
  } catch (error) {
    console.error('[CARER_TASKS_CACHE] mirror failed', { firebaseId: cleanId, error });
    return null;
  }
}

export type AutoTickPendingTaskCandidate = Record<string, unknown> & { id: string };

export type PendingCarerTaskCandidatesSqlResult = {
  candidates: AutoTickPendingTaskCandidate[];
  timing: PlayerMirrorSqlTiming;
  hit: boolean;
  missReason: 'postgres_unavailable' | 'lookup_failed' | 'missing_required_fields' | null;
};

function mapSqlRowToAutoTickPendingTask(row: Record<string, unknown>): AutoTickPendingTaskCandidate | null {
  const taskId = cleanText(row.firebase_id);
  if (!taskId) {
    return null;
  }

  const raw =
    row.raw_firestore_data &&
    typeof row.raw_firestore_data === 'object' &&
    !Array.isArray(row.raw_firestore_data)
      ? { ...(row.raw_firestore_data as Record<string, unknown>) }
      : {};

  const gameName = cleanText(row.game_name) || cleanText(raw.gameName) || cleanText(raw.game);
  const playerUid = cleanText(row.player_uid) || cleanText(raw.playerUid) || cleanText(raw.playerId);
  const taskType =
    cleanText(row.type) ||
    cleanText(raw.type) ||
    cleanText(raw.kind) ||
    cleanText(raw.action) ||
    cleanText(raw.taskAction);

  return {
    ...raw,
    id: taskId,
    coadminUid: cleanText(row.coadmin_uid) || cleanText(raw.coadminUid) || cleanText(raw.createdBy),
    status: cleanText(row.status) || cleanText(raw.status),
    type: taskType,
    kind: taskType || raw.kind,
    playerUid,
    playerId: playerUid || raw.playerId,
    playerUsername: cleanText(row.player_username) || cleanText(raw.playerUsername) || cleanText(raw.player),
    player: cleanText(row.player_username) || cleanText(raw.player) || cleanText(raw.playerUsername),
    gameName,
    game: gameName,
    currentUsername: cleanText(row.current_username) || cleanText(raw.currentUsername),
    gameAccountUsername:
      cleanText(row.game_account_username) || cleanText(raw.gameAccountUsername),
    loginUrl: cleanText(row.login_url) || cleanText(raw.loginUrl),
    gameLoginUrl: cleanText(row.game_login_url) || cleanText(raw.gameLoginUrl),
    siteUrl: cleanText(row.site_url) || cleanText(raw.siteUrl),
    baseUrl: cleanText(row.base_url) || cleanText(raw.baseUrl),
    lobbyUrl: cleanText(row.lobby_url) || cleanText(raw.lobbyUrl),
    gameCredentialUsername:
      cleanText(row.game_credential_username) || cleanText(raw.gameCredentialUsername),
    gameCredentialPassword:
      cleanText(row.game_credential_password) || cleanText(raw.gameCredentialPassword),
    assignedCarerUid: cleanText(row.assigned_carer_uid) || cleanText(raw.assignedCarerUid),
    assignedCarerUsername:
      cleanText(row.assigned_carer_username) || cleanText(raw.assignedCarerUsername),
    assignedCarer: cleanText(row.assigned_carer) || cleanText(raw.assignedCarer),
    claimedByUid: cleanText(row.claimed_by_uid) || cleanText(raw.claimedByUid),
    automationJobId: cleanText(row.automation_job_id) || cleanText(raw.automationJobId),
    retryPending: row.retry_pending === true || raw.retryPending === true,
    returnedToPendingAt: row.returned_to_pending_at || raw.returnedToPendingAt,
    createdAt: row.created_at || raw.createdAt,
    updatedAt: row.updated_at || raw.updatedAt,
  };
}

function hasAutoTickPendingTaskFields(task: AutoTickPendingTaskCandidate) {
  return Boolean(
    cleanText(task.id) &&
      (cleanText(task.type) ||
        cleanText(task.kind) ||
        cleanText(task.action) ||
        cleanText(task.taskAction) ||
        (task.raw_firestore_data && typeof task.raw_firestore_data === 'object'))
  );
}

export function hasAutoTickTaskRecheckFields(task: Record<string, unknown>) {
  if (!cleanText(task.id)) {
    return false;
  }
  return Boolean(
    cleanText(task.status) ||
      cleanText(task.assignedCarerUid) ||
      cleanText(task.claimedByUid) ||
      cleanText(task.automationJobId)
  );
}

const AUTO_TICK_TASK_RECHECK_SQL = `
  SELECT
    firebase_id,
    coadmin_uid,
    type,
    player_uid,
    player_username,
    game_name,
    status,
    current_username,
    game_account_username,
    login_url,
    game_login_url,
    lobby_url,
    site_url,
    base_url,
    game_credential_username,
    game_credential_password,
    assigned_carer_uid,
    assigned_carer_username,
    assigned_carer,
    claimed_by_uid,
    automation_job_id,
    created_at,
    updated_at,
    raw_firestore_data
  FROM public.carer_tasks_cache
  WHERE firebase_id = $1
    AND deleted_at IS NULL
  LIMIT 1
`;

export type AutoTickTaskRecheckSqlResult = {
  task: AutoTickPendingTaskCandidate | null;
  timing: PlayerMirrorSqlTiming;
  hit: boolean;
  missReason:
    | 'postgres_unavailable'
    | 'lookup_failed'
    | 'not_found'
    | 'missing_required_fields'
    | null;
};

export async function lookupAutoTickTaskRecheckFromSql(
  taskId: string
): Promise<AutoTickTaskRecheckSqlResult> {
  const startedAt = Date.now();
  const cleanTaskId = cleanText(taskId);
  const db = getPlayerMirrorPool();
  const emptyTiming = createPlayerMirrorSqlTiming({
    total_ms: Date.now() - startedAt,
  });

  if (!db || !cleanTaskId) {
    return {
      task: null,
      timing: emptyTiming,
      hit: false,
      missReason: 'postgres_unavailable',
    };
  }

  try {
    const { rows, timing } = await runMirrorPoolQuery<Record<string, unknown>>(db, AUTO_TICK_TASK_RECHECK_SQL, [
      cleanTaskId,
    ]);
    const row = rows[0];
    if (!row) {
      return {
        task: null,
        timing,
        hit: false,
        missReason: 'not_found',
      };
    }

    const task = mapSqlRowToAutoTickPendingTask(row);
    if (!task || !hasAutoTickTaskRecheckFields(task)) {
      return {
        task,
        timing,
        hit: false,
        missReason: 'missing_required_fields',
      };
    }

    return {
      task,
      timing,
      hit: true,
      missReason: null,
    };
  } catch (error) {
    console.info(
      '[AUTO_TICK_TASK_RECHECK_SQL] hit=false taskId=%s durationMs=%s reason=lookup_failed error=%s',
      cleanTaskId,
      Date.now() - startedAt,
      error instanceof Error ? error.message : String(error)
    );
    return {
      task: null,
      timing: createPlayerMirrorSqlTiming({
        total_ms: Date.now() - startedAt,
      }),
      hit: false,
      missReason: 'lookup_failed',
    };
  }
}

export type CachedCarerTotalsTask = {
  id: string;
  type: 'recharge' | 'redeem';
  completedByCarerUid: string | null;
  assignedCarerUid: string | null;
  amount: number;
};

function mapCachedCarerTotalsTaskRow(row: Record<string, unknown>): CachedCarerTotalsTask | null {
  const id = cleanText(row.firebase_id);
  const type = cleanText(row.type) as 'recharge' | 'redeem';
  if (!id || (type !== 'recharge' && type !== 'redeem')) {
    return null;
  }
  return {
    id,
    type,
    completedByCarerUid: cleanText(row.completed_by_carer_uid) || null,
    assignedCarerUid: cleanText(row.assigned_carer_uid) || null,
    amount: Number(row.amount || 0),
  };
}

export async function readCarerRechargeRedeemTotalsFromCache(
  coadminUid: string,
  windowStartIso: string,
  limitPerType: number
): Promise<CachedCarerTotalsTask[] | null> {
  const db = getPlayerMirrorPool();
  const cleanCoadminUid = cleanText(coadminUid);
  const cleanWindowStart = cleanText(windowStartIso);
  const safeLimit = Math.max(1, Math.min(Number(limitPerType) || 500, 1000));
  if (!db || !cleanCoadminUid || !cleanWindowStart) {
    return null;
  }

  try {
    const startedAt = Date.now();
    const { rows } = await runMirrorPoolQuery<Record<string, unknown>>(
      db,
      `
        SELECT firebase_id, type, completed_by_carer_uid, assigned_carer_uid, amount
        FROM public.carer_tasks_cache
        WHERE coadmin_uid = $1
          AND status = 'completed'
          AND type IN ('recharge', 'redeem')
          AND completed_at >= $2::timestamptz
          AND deleted_at IS NULL
        ORDER BY completed_at DESC NULLS LAST
        LIMIT $3
      `,
      [cleanCoadminUid, cleanWindowStart, safeLimit * 2]
    );
    const tasks = rows
      .map((row) => mapCachedCarerTotalsTaskRow(row))
      .filter((task): task is CachedCarerTotalsTask => Boolean(task));
    console.info('[CARER_TASKS_CACHE] carer_totals read ok', {
      coadminUid: cleanCoadminUid,
      count: tasks.length,
      durationMs: Date.now() - startedAt,
    });
    return tasks;
  } catch (error) {
    console.warn('[CARER_TASKS_CACHE] carer_totals read failed', {
      coadminUid: cleanCoadminUid,
      error,
    });
    return null;
  }
}

export async function getPendingCarerTaskCandidatesFromSql(
  coadminUid: string,
  limit: number,
  carerUid?: string,
  options?: { excludeRetryPending?: boolean; excludeReturnCooldown?: boolean }
): Promise<PendingCarerTaskCandidatesSqlResult> {
  const startedAt = Date.now();
  const cleanCoadminUid = cleanText(coadminUid);
  const cleanCarerUid = cleanText(carerUid);
  const safeLimit = Math.max(1, Math.min(Number(limit) || 15, 50));
  const db = getPlayerMirrorPool();
  const emptyTiming = createPlayerMirrorSqlTiming({
    total_ms: Date.now() - startedAt,
  });

  if (!db || !cleanCoadminUid) {
    console.info(
      '[AUTO_TICK_PENDING_SQL] hit=false candidateCount=%s coadminUid=%s carerUid=%s durationMs=%s reason=%s',
      0,
      cleanCoadminUid || null,
      cleanCarerUid || null,
      emptyTiming.total_ms,
      'postgres_unavailable'
    );
    return {
      candidates: [],
      timing: emptyTiming,
      hit: false,
      missReason: 'postgres_unavailable',
    };
  }

  const excludeRetryPending = options?.excludeRetryPending !== false;
  const excludeReturnCooldown =
    options?.excludeReturnCooldown ?? excludeRetryPending;
  const returnCooldownSeconds = Math.ceil(30_000 / 1000);
  const pendingSql = `
    SELECT
      firebase_id,
      coadmin_uid,
      type,
      player_uid,
      player_username,
      game_name,
      status,
      current_username,
      game_account_username,
      login_url,
      game_login_url,
      lobby_url,
      site_url,
      base_url,
      game_credential_username,
      game_credential_password,
      assigned_carer_uid,
      assigned_carer_username,
      assigned_carer,
      claimed_by_uid,
      automation_job_id,
      retry_pending,
      returned_to_pending_at,
      created_at,
      updated_at,
      raw_firestore_data
    FROM public.carer_tasks_cache
    WHERE coadmin_uid = $1
      AND status = 'pending'
      AND deleted_at IS NULL
      AND COALESCE(assigned_carer_uid, '') = ''
      AND COALESCE(claimed_by_uid, '') = ''
      AND COALESCE(automation_job_id, '') = ''
      ${excludeRetryPending ? 'AND COALESCE(retry_pending, false) = false' : ''}
      ${
        excludeReturnCooldown
          ? `AND (
        returned_to_pending_at IS NULL
        OR returned_to_pending_at < NOW() - ($3::int * INTERVAL '1 second')
      )`
          : ''
      }
    ORDER BY
      CASE
        WHEN LOWER(COALESCE(type, '')) IN (
          'create_game_username',
          'create_username',
          'createusername',
          'reset_password',
          'recharge',
          'redeem'
        ) THEN 0
        ELSE 1
      END,
      created_at DESC NULLS LAST
    LIMIT $2
  `;

  try {
    const queryParams = excludeReturnCooldown
      ? [cleanCoadminUid, safeLimit, returnCooldownSeconds]
      : [cleanCoadminUid, safeLimit];
    const { rows, timing } = await runMirrorPoolQuery<Record<string, unknown>>(
      db,
      pendingSql,
      queryParams
    );

    const candidates = rows
      .map((row) => mapSqlRowToAutoTickPendingTask(row))
      .filter((task): task is AutoTickPendingTaskCandidate => task !== null);

    if (rows.length > 0 && candidates.length === 0) {
      console.info(
        '[AUTO_TICK_PENDING_SQL] hit=false candidateCount=%s coadminUid=%s carerUid=%s durationMs=%s reason=%s rowCount=%s',
        0,
        cleanCoadminUid,
        cleanCarerUid || null,
        timing.total_ms,
        'missing_required_fields',
        rows.length
      );
      return {
        candidates: [],
        timing,
        hit: false,
        missReason: 'missing_required_fields',
      };
    }

    if (candidates.some((task) => !hasAutoTickPendingTaskFields(task))) {
      console.info(
        '[AUTO_TICK_PENDING_SQL] hit=false candidateCount=%s coadminUid=%s carerUid=%s durationMs=%s reason=%s',
        candidates.length,
        cleanCoadminUid,
        cleanCarerUid || null,
        timing.total_ms,
        'missing_required_fields'
      );
      return {
        candidates: [],
        timing,
        hit: false,
        missReason: 'missing_required_fields',
      };
    }

    if (candidates.length > 0) {
      console.info(
        '[AUTO_TICK_SQL_PENDING_SCAN] coadminUid=%s carerUid=%s candidateCount=%s',
        cleanCoadminUid,
        cleanCarerUid || '-',
        candidates.length
      );
      if (isAppDebugLoggingEnabled()) {
        for (const task of candidates) {
          debugLog('[AUTO_TICK_SQL_PENDING_TASK_ROW]', {
            taskId: cleanText(task.id),
            type: cleanText(task.type),
            gameName: cleanText(task.gameName),
            playerUid: cleanText(task.playerUid),
            retryPending: task.retryPending === true,
          });
        }
      }
    } else {
      debugLog('[AUTO_TICK_SQL_PENDING_SCAN]', {
        coadminUid: cleanCoadminUid,
        carerUid: cleanCarerUid || null,
        candidateCount: 0,
        excludeRetryPending,
        excludeReturnCooldown,
      });
    }
    if (isAppDebugLoggingEnabled() || timing.total_ms >= API_ROUTE_SLOW_MS || candidates.length > 0) {
      console.info(
        '[AUTO_TICK_PENDING_SQL] hit=true candidateCount=%s coadminUid=%s carerUid=%s durationMs=%s',
        candidates.length,
        cleanCoadminUid,
        cleanCarerUid || null,
        timing.total_ms
      );
    }
    return {
      candidates,
      timing,
      hit: true,
      missReason: null,
    };
  } catch (error) {
    const timing = createPlayerMirrorSqlTiming({
      total_ms: Date.now() - startedAt,
    });
    console.info(
      '[AUTO_TICK_PENDING_SQL] hit=false candidateCount=%s coadminUid=%s carerUid=%s durationMs=%s reason=%s error=%s',
      0,
      cleanCoadminUid,
      cleanCarerUid || null,
      timing.total_ms,
      'lookup_failed',
      error instanceof Error ? error.message : String(error)
    );
    return {
      candidates: [],
      timing,
      hit: false,
      missReason: 'lookup_failed',
    };
  }
}

export type CarerActiveInProgressTaskSqlResult = {
  hit: boolean;
  taskId: string | null;
  jobId: string | null;
  jobStatus: string | null;
  gameName?: string | null;
  timing: PlayerMirrorSqlTiming;
};

export async function getCarerActiveInProgressTaskFromSql(
  coadminUid: string,
  carerUid: string
): Promise<CarerActiveInProgressTaskSqlResult> {
  const startedAt = Date.now();
  const cleanCoadminUid = cleanText(coadminUid);
  const cleanCarerUid = cleanText(carerUid);
  const db = getPlayerMirrorPool();
  const emptyTiming = createPlayerMirrorSqlTiming({
    total_ms: Date.now() - startedAt,
  });

  if (!db || !cleanCoadminUid || !cleanCarerUid) {
    return { hit: false, taskId: null, jobId: null, jobStatus: null, timing: emptyTiming };
  }

  try {
    const { rows, timing } = await runMirrorPoolQuery<Record<string, unknown>>(
      db,
      `
        SELECT
          t.firebase_id AS task_id,
          j.job_id,
          j.status AS job_status
        FROM public.carer_tasks_cache t
        LEFT JOIN public.automation_jobs_cache j
          ON j.job_id = t.automation_job_id
         AND j.deleted_at IS NULL
        WHERE t.deleted_at IS NULL
          AND t.coadmin_uid = $1
          AND t.status = 'in_progress'
          AND (
            t.assigned_carer_uid = $2
            OR t.claimed_by_uid = $2
          )
        ORDER BY t.updated_at DESC NULLS LAST
        LIMIT 1
      `,
      [cleanCoadminUid, cleanCarerUid]
    );

    if (!rows.length) {
      return { hit: false, taskId: null, jobId: null, jobStatus: null, timing };
    }

    const row = rows[0];
    const jobStatus = cleanText(row.job_status).toLowerCase();
    const activeJobStatuses = new Set([
      'queued',
      'waiting',
      'running',
      'in_progress',
      'cancelled_requested',
      'claimed',
      'processing',
      'pending_review',
    ]);
    const jobId = cleanText(row.job_id) || null;
    const blocksNextClaim = !jobId || activeJobStatuses.has(jobStatus);

    return {
      hit: blocksNextClaim,
      taskId: cleanText(row.task_id) || null,
      jobId,
      jobStatus: jobStatus || null,
      timing,
    };
  } catch (error) {
    console.warn('[AUTO_TICK_IN_PROGRESS_SQL] lookup_failed', {
      coadminUid: cleanCoadminUid,
      carerUid: cleanCarerUid,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      hit: false,
      taskId: null,
      jobId: null,
      jobStatus: null,
      timing: createPlayerMirrorSqlTiming({ total_ms: Date.now() - startedAt }),
    };
  }
}

export async function getCarerActiveSingleSessionTaskFromSql(
  coadminUid: string,
  carerUid: string,
  gameKey: string
): Promise<CarerActiveInProgressTaskSqlResult> {
  const startedAt = Date.now();
  const cleanCoadminUid = cleanText(coadminUid);
  const cleanCarerUid = cleanText(carerUid);
  const cleanGameKey = cleanText(gameKey);
  const db = getPlayerMirrorPool();
  const emptyTiming = createPlayerMirrorSqlTiming({
    total_ms: Date.now() - startedAt,
  });

  if (!db || !cleanCoadminUid || !cleanCarerUid || !cleanGameKey) {
    return { hit: false, taskId: null, jobId: null, jobStatus: null, gameName: null, timing: emptyTiming };
  }

  try {
    const { rows, timing } = await runMirrorPoolQuery<Record<string, unknown>>(
      db,
      `
        SELECT
          t.firebase_id AS task_id,
          t.game_name,
          j.job_id,
          j.status AS job_status
        FROM public.carer_tasks_cache t
        LEFT JOIN public.automation_jobs_cache j
          ON j.job_id = t.automation_job_id
         AND j.deleted_at IS NULL
        WHERE t.deleted_at IS NULL
          AND t.coadmin_uid = $1
          AND t.status = 'in_progress'
          AND (
            t.assigned_carer_uid = $2
            OR t.claimed_by_uid = $2
          )
          AND trim(both '_' from regexp_replace(LOWER(COALESCE(t.game_name, '')), '[^a-z0-9]+', '_', 'g')) = $3
        ORDER BY t.updated_at DESC NULLS LAST
        LIMIT 1
      `,
      [cleanCoadminUid, cleanCarerUid, cleanGameKey]
    );

    if (!rows.length) {
      return { hit: false, taskId: null, jobId: null, jobStatus: null, gameName: null, timing };
    }

    const row = rows[0];
    const jobStatus = cleanText(row.job_status).toLowerCase();
    const activeJobStatuses = new Set([
      'queued',
      'waiting',
      'running',
      'in_progress',
      'cancelled_requested',
      'claimed',
      'processing',
      'pending_review',
    ]);
    const jobId = cleanText(row.job_id) || null;
    const blocksNextClaim = !jobId || activeJobStatuses.has(jobStatus);

    return {
      hit: blocksNextClaim,
      taskId: cleanText(row.task_id) || null,
      jobId,
      jobStatus: jobStatus || null,
      gameName: cleanText(row.game_name) || null,
      timing,
    };
  } catch (error) {
    console.warn('[AUTO_TICK_SINGLE_SESSION_SQL] lookup_failed', {
      coadminUid: cleanCoadminUid,
      carerUid: cleanCarerUid,
      gameKey: cleanGameKey,
      error,
    });
    return {
      hit: false,
      taskId: null,
      jobId: null,
      jobStatus: null,
      gameName: null,
      timing: createPlayerMirrorSqlTiming({
        total_ms: Date.now() - startedAt,
      }),
    };
  }
}
