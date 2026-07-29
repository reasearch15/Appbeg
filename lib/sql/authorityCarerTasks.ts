import 'server-only';

import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';

import {
  buildAutomationPayload,
  getTimestampMs,
  mapTaskType,
  resolveAutomationAccessFields,
  resolveTaskTypeLabel,
  type GameLoginDetailsInput,
} from '@/lib/automation/automationClaimPayload';
import {
  isSingleSessionAutomationGame,
  normalizeAutomationGameKey,
} from '@/lib/automation/singleSessionGames';
import {
  claimAuthorityOperation,
  deleteAuthorityOperationsByPrefixInTxn,
  insertAuthorityLedgerEvent,
  logAuthPayloadPreTxnRemoved,
  readAuthorityOperationExists,
  readAuthorityOperationPayloadWithClient,
} from '@/lib/sql/authorityLedger';
import {
  normalizeGameName,
  ttlAfterDaysIso,
  updatePlayerBalancesInTxn,
  upsertGameRequestCacheInTxn,
} from '@/lib/sql/authorityGameRequestHelpers';
import {
  agentJobLiveChannel,
  carerJobLiveChannel,
  carerTaskLiveChannel,
  coadminJobLiveChannel,
  coadminTaskLiveChannel,
  insertLiveOutboxEventsBatch,
  type LiveOutboxInsertInput,
} from '@/lib/sql/liveOutbox';
import { cleanText, getPlayerMirrorPool, toIsoString } from '@/lib/sql/playerMirrorCommon';

const STALE_TASK_CLAIM_TIMEOUT_MS = 5 * 60 * 1000;
const AUTOMATION_JOB_TTL_DAYS = 14;
export const RETURN_TO_PENDING_COOLDOWN_MS = 30_000;
const AGENT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

const ACTIVE_JOB_STATUSES = new Set([
  'queued',
  'waiting',
  'running',
  'in_progress',
  'cancelled_requested',
  'claimed',
  'processing',
]);

const RESETTABLE_TASK_STATUSES = new Set(['pending', 'in_progress', 'failed', 'urgent']);
const RESETTABLE_REQUEST_STATUSES = new Set(['pending', 'poked', 'pending_review', 'failed']);

const REUSABLE_CLAIM_DUPLICATE_JOB_STATUSES = new Set(['queued', 'running', 'in_progress', 'waiting']);

const FINAL_CLAIM_DUPLICATE_JOB_STATUSES = new Set([
  'cancelled',
  'completed',
  'failed',
  'dismissed',
]);

type SqlJobRow = {
  job_id: string;
  task_id: string | null;
  coadmin_uid: string | null;
  carer_uid: string | null;
  agent_id: string | null;
  status: string | null;
  payload: Record<string, unknown> | null;
  raw_firestore_data: Record<string, unknown> | null;
  last_heartbeat_at: string | null;
  updated_at: string | null;
  created_at: string | null;
  error_message: string | null;
};

type SqlTaskRow = {
  firebase_id: string;
  coadmin_uid: string | null;
  type: string | null;
  player_uid: string | null;
  player_username: string | null;
  game_name: string | null;
  amount: number | null;
  request_id: string | null;
  status: string | null;
  assigned_carer_uid: string | null;
  assigned_carer_username: string | null;
  claimed_status: string | null;
  claimed_by_uid: string | null;
  automation_status: string | null;
  automation_job_id: string | null;
  automation_error: string | null;
  retry_pending: boolean | null;
  returned_to_pending_at: string | null;
  created_at: string | null;
  claimed_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  raw_firestore_data: Record<string, unknown>;
};

function automationJobDocId(carerUid: string, taskId: string): string {
  const uid = cleanText(carerUid);
  const tid = cleanText(taskId).replace(/\//g, '_');
  if (!uid || !tid) {
    throw new Error('carerUid and taskId are required for automation job id.');
  }
  return `${uid}--${tid}`;
}

function validateAutomationAgentId(agentId: string) {
  const trimmed = cleanText(agentId);
  if (!trimmed) {
    return { valid: false as const, error: 'Agent ID cannot be empty.' };
  }
  if (trimmed.length > 64) {
    return { valid: false as const, error: 'Agent ID must be at most 64 characters.' };
  }
  if (!AGENT_ID_PATTERN.test(trimmed)) {
    return {
      valid: false as const,
      error: 'Agent ID may only contain letters, numbers, underscores, and hyphens.',
    };
  }
  return { valid: true as const, normalized: trimmed };
}

function normalizeAutomationStatus(value: unknown) {
  return cleanText(value).toLowerCase();
}

function normalizeClaimedStatus(value: unknown) {
  return cleanText(value).toLowerCase();
}

function sanitizeStatus(value: unknown) {
  return cleanText(value).toLowerCase() || 'pending';
}

function isActiveAutomationJobStatus(value: unknown) {
  return ACTIVE_JOB_STATUSES.has(normalizeAutomationStatus(value));
}

function isAgentSupportedAutomationType(value: string) {
  return (
    value === 'CREATE_USERNAME' ||
    value === 'RESET_PASSWORD' ||
    value === 'RECHARGE' ||
    value === 'REDEEM'
  );
}

function jobHeartbeatMs(job: SqlJobRow) {
  const raw = job.raw_firestore_data || {};
  return Math.max(
    toIsoString(job.last_heartbeat_at) ? Date.parse(String(job.last_heartbeat_at)) : 0,
    toIsoString(job.updated_at) ? Date.parse(String(job.updated_at)) : 0,
    toIsoString(job.created_at) ? Date.parse(String(job.created_at)) : 0,
    getTimestampMs(raw.lastHeartbeatAt),
    getTimestampMs(raw.updatedAt),
    getTimestampMs(raw.createdAt)
  );
}

function isFreshAutomationJobSignal(job: SqlJobRow) {
  const raw = job.raw_firestore_data || {};
  const error = cleanText(job.error_message || raw.error).toLowerCase();
  if (error.includes('timed out') || error.includes('returned to the queue')) {
    return false;
  }
  const status = normalizeAutomationStatus(job.status);
  const signalMs = jobHeartbeatMs(job);
  if (!signalMs) {
    return false;
  }
  if (Date.now() - signalMs >= STALE_TASK_CLAIM_TIMEOUT_MS) {
    return false;
  }
  if (status === 'queued') {
    return true;
  }
  if (status === 'running') {
    return Boolean(job.last_heartbeat_at || raw.lastHeartbeatAt);
  }
  return status === 'waiting' || status === 'claimed' || status === 'in_progress';
}

function taskFromRow(row: Record<string, unknown>): SqlTaskRow {
  const raw =
    row.raw_firestore_data &&
    typeof row.raw_firestore_data === 'object' &&
    !Array.isArray(row.raw_firestore_data)
      ? (row.raw_firestore_data as Record<string, unknown>)
      : {};
  return {
    firebase_id: cleanText(row.firebase_id),
    coadmin_uid: cleanText(row.coadmin_uid) || null,
    type: cleanText(row.type) || null,
    player_uid: cleanText(row.player_uid) || null,
    player_username: cleanText(row.player_username) || null,
    game_name: cleanText(row.game_name) || null,
    amount: row.amount == null ? null : Number(row.amount),
    request_id: cleanText(row.request_id) || null,
    status: cleanText(row.status) || null,
    assigned_carer_uid: cleanText(row.assigned_carer_uid) || null,
    assigned_carer_username: cleanText(row.assigned_carer_username) || null,
    claimed_status: cleanText(row.claimed_status) || null,
    claimed_by_uid: cleanText(row.claimed_by_uid) || null,
    automation_status: cleanText(row.automation_status) || null,
    automation_job_id: cleanText(row.automation_job_id) || null,
    automation_error: cleanText(row.automation_error) || null,
    retry_pending: row.retry_pending === true ? true : row.retry_pending === false ? false : null,
    returned_to_pending_at: toIsoString(row.returned_to_pending_at),
    created_at: toIsoString(row.created_at),
    claimed_at: toIsoString(row.claimed_at),
    started_at: toIsoString(row.started_at),
    completed_at: toIsoString(row.completed_at),
    raw_firestore_data: raw,
  };
}

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

function taskHasRetryPending(task: SqlTaskRow): boolean {
  if (task.retry_pending === true) {
    return true;
  }
  return task.raw_firestore_data?.retryPending === true;
}

export function isWithinReturnToPendingCooldown(
  task: Pick<SqlTaskRow, 'returned_to_pending_at' | 'raw_firestore_data'>
): boolean {
  const returnedAt =
    toIsoString(task.returned_to_pending_at) ||
    toIsoString(task.raw_firestore_data?.returnedToPendingAt);
  if (!returnedAt) {
    return false;
  }
  const returnedMs = Date.parse(returnedAt);
  if (!Number.isFinite(returnedMs)) {
    return false;
  }
  return Date.now() - returnedMs < RETURN_TO_PENDING_COOLDOWN_MS;
}

function taskBlocksAutomationReclaim(task: SqlTaskRow): boolean {
  return taskHasRetryPending(task) || isWithinReturnToPendingCooldown(task);
}

function taskNeedsReturnReapply(task: SqlTaskRow): boolean {
  const status = sanitizeStatus(task.status);
  if (status !== 'pending') {
    return true;
  }
  if (cleanText(task.assigned_carer_uid) || cleanText(task.claimed_by_uid)) {
    return true;
  }
  if (cleanText(task.automation_job_id)) {
    return true;
  }
  if (normalizeClaimedStatus(task.claimed_status) === 'running') {
    return true;
  }
  return false;
}

async function readTaskReturnFinalState(client: PoolClient, taskId: string) {
  const finalStateResult = await client.query(
    `
      SELECT
        status,
        assigned_carer_uid,
        claimed_by_uid,
        automation_job_id,
        claimed_at,
        started_at,
        last_heartbeat_at,
        retry_pending,
        returned_to_pending_at
      FROM public.carer_tasks_cache
      WHERE firebase_id = $1 AND deleted_at IS NULL
      LIMIT 1
    `,
    [taskId]
  );
  return (finalStateResult.rows[0] as Record<string, unknown> | undefined) ?? null;
}

function logTaskReturnFinalState(input: {
  taskId: string;
  actorUid: string;
  finalState: Record<string, unknown> | null;
  cancelledJobs?: number;
  duplicate?: boolean;
  reapplied?: boolean;
}) {
  console.info('[SQL_TASK_RETURN_FINAL_STATE]', {
    taskId: input.taskId,
    actorUid: input.actorUid,
    duplicate: input.duplicate === true,
    reapplied: input.reapplied === true,
    status: cleanText(input.finalState?.status) || null,
    assignedCarerUid: cleanText(input.finalState?.assigned_carer_uid) || null,
    claimedByUid: cleanText(input.finalState?.claimed_by_uid) || null,
    automationJobId: cleanText(input.finalState?.automation_job_id) || null,
    claimedAt: toIsoString(input.finalState?.claimed_at),
    startedAt: toIsoString(input.finalState?.started_at),
    lastHeartbeatAt: toIsoString(input.finalState?.last_heartbeat_at),
    retryPending: input.finalState?.retry_pending === true,
    returnedToPendingAt: toIsoString(input.finalState?.returned_to_pending_at),
    cancelledJobs: input.cancelledJobs ?? null,
  });
}

function jobFromRow(row: Record<string, unknown>): SqlJobRow {
  const raw =
    row.raw_firestore_data &&
    typeof row.raw_firestore_data === 'object' &&
    !Array.isArray(row.raw_firestore_data)
      ? (row.raw_firestore_data as Record<string, unknown>)
      : {};
  return {
    job_id: cleanText(row.job_id),
    task_id: cleanText(row.task_id) || null,
    coadmin_uid: cleanText(row.coadmin_uid) || null,
    carer_uid: cleanText(row.carer_uid) || null,
    agent_id: cleanText(row.agent_id) || null,
    status: cleanText(row.status) || null,
    payload:
      row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
        ? (row.payload as Record<string, unknown>)
        : null,
    raw_firestore_data: raw,
    last_heartbeat_at: toIsoString(row.last_heartbeat_at),
    updated_at: toIsoString(row.updated_at),
    created_at: toIsoString(row.created_at),
    error_message: cleanText(row.error_message) || null,
  };
}

function mergeTaskRaw(task: SqlTaskRow, patch: Record<string, unknown>) {
  return { ...task.raw_firestore_data, ...patch };
}

async function readCarerProfileInTxn(
  client: PoolClient,
  carerUid: string,
  trusted?: { username?: string | null; automationAgentId?: string | null }
) {
  if (trusted?.automationAgentId) {
    return {
      username: cleanText(trusted.username) || 'Carer',
      automationAgentId: cleanText(trusted.automationAgentId),
    };
  }
  const result = await client.query(
    `
      SELECT username, raw_firestore_data
      FROM public.players_cache
      WHERE uid = $1 AND deleted_at IS NULL
      LIMIT 1
    `,
    [carerUid]
  );
  if (!result.rows.length) {
    throw new Error('Current user profile not found.');
  }
  const row = result.rows[0] as { username?: string; raw_firestore_data?: Record<string, unknown> };
  const raw = row.raw_firestore_data || {};
  return {
    username: cleanText(row.username) || cleanText(raw.username) || 'Carer',
    automationAgentId: cleanText(raw.automationAgentId),
  };
}

async function loadTaskForUpdate(client: PoolClient, taskId: string, skipLocked = false) {
  const lockClause = skipLocked ? 'FOR UPDATE SKIP LOCKED' : 'FOR UPDATE';
  const result = await client.query(
    `
      SELECT *
      FROM public.carer_tasks_cache
      WHERE firebase_id = $1 AND deleted_at IS NULL
      ${lockClause}
    `,
    [taskId]
  );
  if (!result.rows.length) {
    return null;
  }
  return taskFromRow(result.rows[0] as Record<string, unknown>);
}

async function loadJobsForTask(client: PoolClient, taskId: string, extraJobIds: string[] = []) {
  const ids = Array.from(new Set(extraJobIds.filter(Boolean)));
  const result = await client.query(
    `
      SELECT *
      FROM public.automation_jobs_cache
      WHERE deleted_at IS NULL
        AND (
          task_id = $1
          OR job_id = ANY($2::text[])
        )
      LIMIT 25
    `,
    [taskId, ids.length ? ids : ['']]
  );
  return (result.rows as Record<string, unknown>[]).map(jobFromRow);
}

async function upsertAutomationJobInTxn(
  client: PoolClient,
  jobId: string,
  data: Record<string, unknown>,
  source = 'authority_carer_task'
) {
  const nowIso = new Date().toISOString();
  const raw = { ...data };
  await client.query(
    `
      INSERT INTO public.automation_jobs_cache (
        job_id, task_id, linked_task_id, coadmin_uid, carer_uid, player_uid, agent_id,
        created_by_uid, created_by_name, game_id, game, type, request_type, status,
        claimed_status, payload, result, error_message, cancelled_reason,
        needs_manual_review, partial_success, attempts, created_at, updated_at,
        started_at, completed_at, failed_at, last_heartbeat_at, ttl_expires_at,
        raw_firestore_data, source, mirrored_at, deleted_at
      )
      VALUES (
        $1, NULLIF($2, ''), NULLIF($3, ''), NULLIF($4, ''), NULLIF($5, ''),
        NULLIF($6, ''), NULLIF($7, ''), NULLIF($8, ''), NULLIF($9, ''),
        NULLIF($10, ''), NULLIF($11, ''), NULLIF($12, ''), NULLIF($13, ''),
        NULLIF($14, ''), NULLIF($15, ''), $16::jsonb, $17::jsonb,
        NULLIF($18, ''), NULLIF($19, ''), $20, $21, $22,
        $23::timestamptz, $24::timestamptz, $25::timestamptz,
        $26::timestamptz, $27::timestamptz, $28::timestamptz,
        $29::timestamptz, $30::jsonb, $31, now(), NULL
      )
      ON CONFLICT (job_id) DO UPDATE SET
        task_id = EXCLUDED.task_id,
        coadmin_uid = EXCLUDED.coadmin_uid,
        carer_uid = EXCLUDED.carer_uid,
        player_uid = EXCLUDED.player_uid,
        agent_id = EXCLUDED.agent_id,
        created_by_uid = EXCLUDED.created_by_uid,
        created_by_name = EXCLUDED.created_by_name,
        game = EXCLUDED.game,
        type = EXCLUDED.type,
        request_type = EXCLUDED.request_type,
        status = EXCLUDED.status,
        claimed_status = EXCLUDED.claimed_status,
        payload = EXCLUDED.payload,
        error_message = EXCLUDED.error_message,
        cancelled_reason = EXCLUDED.cancelled_reason,
        attempts = EXCLUDED.attempts,
        updated_at = EXCLUDED.updated_at,
        started_at = EXCLUDED.started_at,
        completed_at = EXCLUDED.completed_at,
        last_heartbeat_at = EXCLUDED.last_heartbeat_at,
        ttl_expires_at = EXCLUDED.ttl_expires_at,
        raw_firestore_data = EXCLUDED.raw_firestore_data,
        source = EXCLUDED.source,
        mirrored_at = now(),
        deleted_at = NULL
    `,
    [
      jobId,
      cleanText(data.taskId),
      cleanText(data.linkedTaskId),
      cleanText(data.coadminUid),
      cleanText(data.carerUid || data.createdByUid),
      cleanText(data.playerUid),
      cleanText(data.agentId),
      cleanText(data.createdByUid || data.carerUid),
      cleanText(data.createdByName || data.carerName),
      cleanText(data.gameId),
      cleanText(data.game || data.gameName),
      cleanText(data.type),
      cleanText(data.requestType || data.type),
      cleanText(data.status),
      cleanText(data.claimedStatus),
      JSON.stringify(data.payload || {}),
      JSON.stringify(data.result || null),
      cleanText(data.error || data.errorMessage),
      cleanText(data.cancelledReason),
      data.needsManualReview === true,
      data.partialSuccess === true,
      Number(data.attempts || 0),
      toIsoString(data.createdAt) || nowIso,
      toIsoString(data.updatedAt) || nowIso,
      toIsoString(data.startedAt),
      toIsoString(data.completedAt),
      toIsoString(data.failedAt),
      toIsoString(data.lastHeartbeatAt),
      toIsoString(data.ttlExpiresAt),
      JSON.stringify(raw),
      source,
    ]
  );
}

async function patchCarerTaskInTxn(
  client: PoolClient,
  taskId: string,
  patch: Record<string, unknown>,
  source = 'authority_carer_task'
) {
  const nowIso = cleanText(patch.updatedAt) || new Date().toISOString();
  const rawPatch = { ...patch, updatedAt: nowIso };
  await client.query(
    `
      UPDATE public.carer_tasks_cache
      SET
        coadmin_uid = COALESCE(NULLIF($2, ''), coadmin_uid),
        type = COALESCE(NULLIF($3, ''), type),
        player_uid = COALESCE(NULLIF($4, ''), player_uid),
        player_username = COALESCE(NULLIF($5, ''), player_username),
        game_name = COALESCE(NULLIF($6, ''), game_name),
        amount = COALESCE($7, amount),
        request_id = COALESCE(NULLIF($8, ''), request_id),
        status = COALESCE(NULLIF($9, ''), status),
        assigned_carer_uid = CASE WHEN $10::boolean THEN NULLIF($11, '') ELSE assigned_carer_uid END,
        assigned_carer_username = CASE WHEN $10::boolean THEN NULLIF($12, '') ELSE assigned_carer_username END,
        assigned_carer = CASE WHEN $10::boolean THEN NULLIF($12, '') ELSE assigned_carer END,
        claimed_status = CASE WHEN $13::boolean THEN NULLIF($14, '') ELSE claimed_status END,
        claimed_by_uid = CASE WHEN $15::boolean THEN NULLIF($16, '') ELSE claimed_by_uid END,
        claimed_by_username = CASE WHEN $15::boolean THEN NULLIF($17, '') ELSE claimed_by_username END,
        automation_status = CASE WHEN $18::boolean THEN NULLIF($19, '') ELSE automation_status END,
        automation_job_id = CASE WHEN $20::boolean THEN NULLIF($21, '') ELSE automation_job_id END,
        linked_job_id = CASE WHEN $22::boolean THEN NULLIF($23, '') ELSE linked_job_id END,
        current_job_id = CASE WHEN $22::boolean THEN NULLIF($23, '') ELSE current_job_id END,
        active_job_id = CASE WHEN $22::boolean THEN NULLIF($23, '') ELSE active_job_id END,
        automation_error = CASE WHEN $24::boolean THEN NULLIF($25, '') ELSE automation_error END,
        retry_pending = COALESCE($26, retry_pending),
        started_at = CASE WHEN $52::boolean THEN NULL WHEN $27::boolean THEN $28::timestamptz ELSE started_at END,
        claimed_at = CASE WHEN $52::boolean THEN NULL WHEN $29::boolean THEN $30::timestamptz ELSE claimed_at END,
        last_heartbeat_at = CASE WHEN $52::boolean THEN NULL WHEN $31::boolean THEN $32::timestamptz ELSE last_heartbeat_at END,
        automation_updated_at = CASE WHEN $33::boolean THEN $34::timestamptz ELSE automation_updated_at END,
        completed_at = CASE WHEN $35::boolean THEN $36::timestamptz ELSE completed_at END,
        ttl_expires_at = CASE WHEN $37::boolean THEN $38::timestamptz ELSE ttl_expires_at END,
        reset_to_pending_at = CASE WHEN $39::boolean THEN $40::timestamptz ELSE reset_to_pending_at END,
        returned_to_pending_at = CASE WHEN $41::boolean THEN $42::timestamptz ELSE returned_to_pending_at END,
        pending_since = CASE WHEN $43::boolean THEN $44::timestamptz ELSE pending_since END,
        deleted_from_pending_at = CASE WHEN $45::boolean THEN $46::timestamptz ELSE deleted_from_pending_at END,
        failure_reason = CASE WHEN $47::boolean THEN NULLIF($48, '') ELSE failure_reason END,
        updated_at = $49::timestamptz,
        source = $50,
        mirrored_at = now(),
        raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb) || $51::jsonb
      WHERE firebase_id = $1 AND deleted_at IS NULL
    `,
    [
      taskId,
      cleanText(patch.coadminUid),
      cleanText(patch.type),
      cleanText(patch.playerUid),
      cleanText(patch.playerUsername),
      cleanText(patch.gameName || patch.game),
      patch.amount == null ? null : Number(patch.amount),
      cleanText(patch.requestId),
      cleanText(patch.status),
      patch.__setAssignedCarer === true,
      cleanText(patch.assignedCarerUid),
      cleanText(patch.assignedCarerUsername || patch.assignedCarer),
      patch.__setClaimedStatus === true,
      cleanText(patch.claimedStatus),
      patch.__setClaimedBy === true,
      cleanText(patch.claimedByUid),
      cleanText(patch.claimedByUsername),
      patch.__setAutomationStatus === true,
      cleanText(patch.automationStatus),
      patch.__setAutomationJobId === true,
      cleanText(patch.automationJobId),
      patch.__setJobIds === true,
      cleanText(patch.linkedJobId || patch.automationJobId),
      patch.__clearAutomationError === true,
      cleanText(patch.automationError),
      patch.retryPending == null ? null : Boolean(patch.retryPending),
      patch.__setStartedAt === true,
      toIsoString(patch.startedAt) || nowIso,
      patch.__setClaimedAt === true,
      toIsoString(patch.claimedAt) || nowIso,
      patch.__setLastHeartbeatAt === true,
      toIsoString(patch.lastHeartbeatAt) || nowIso,
      patch.__setAutomationUpdatedAt === true,
      toIsoString(patch.automationUpdatedAt) || nowIso,
      patch.__setCompletedAt === true,
      toIsoString(patch.completedAt) || nowIso,
      patch.__setTtlExpiresAt === true,
      toIsoString(patch.ttlExpiresAt),
      patch.__setResetToPendingAt === true,
      toIsoString(patch.resetToPendingAt) || nowIso,
      patch.__setReturnedToPendingAt === true,
      toIsoString(patch.returnedToPendingAt) || nowIso,
      patch.__setPendingSince === true,
      toIsoString(patch.pendingSince) || nowIso,
      patch.__setDeletedFromPendingAt === true,
      toIsoString(patch.deletedFromPendingAt) || nowIso,
      patch.__setFailureReason === true,
      cleanText(patch.failureReason),
      nowIso,
      source,
      JSON.stringify(rawPatch),
      patch.__clearClaimTimestamps === true,
    ]
  );
}

function buildTaskOutboxRows(input: {
  coadminUid: string;
  carerUid?: string | null;
  taskId: string;
  status: string;
  type?: string;
  gameName?: string;
  playerUid?: string;
  requestId?: string | null;
  assignedCarerUid?: string | null;
  claimedByUid?: string | null;
  automationStatus?: string | null;
  automationJobId?: string | null;
  retryPending?: boolean | null;
  returnedToPendingAt?: string | null;
  retryAt?: string | null;
  updatedAt: string;
  eventType?: string;
}): LiveOutboxInsertInput[] {
  const payload: Record<string, unknown> = {
    entityId: input.taskId,
    taskId: input.taskId,
    coadminUid: input.coadminUid,
    status: input.status,
    type: cleanText(input.type),
    gameName: cleanText(input.gameName),
    requestId: cleanText(input.requestId) || null,
    updatedAt: input.updatedAt,
    source: 'authority',
  };
  const playerUid = cleanText(input.playerUid);
  if (playerUid) {
    payload.playerUid = playerUid;
  }
  if (input.assignedCarerUid !== undefined) {
    payload.assignedCarerUid = input.assignedCarerUid;
  }
  if (input.claimedByUid !== undefined) {
    payload.claimedByUid = input.claimedByUid;
  }
  if (input.automationStatus !== undefined) {
    payload.automationStatus = input.automationStatus;
  }
  if (input.automationJobId !== undefined) {
    payload.automationJobId = input.automationJobId;
  }
  if (input.retryPending !== undefined && input.retryPending !== null) {
    payload.retryPending = input.retryPending === true;
  }
  if (input.returnedToPendingAt !== undefined) {
    payload.returnedToPendingAt = cleanText(input.returnedToPendingAt) || null;
  }
  if (input.retryAt !== undefined) {
    payload.retryAt = cleanText(input.retryAt) || null;
  }
  const eventType = cleanText(input.eventType) || 'task.upserted';
  const carerUid = cleanText(input.carerUid);
  if (eventType === 'task.claimed' && carerUid) {
    if (input.assignedCarerUid === undefined) {
      payload.assignedCarerUid = carerUid;
    }
    if (input.claimedByUid === undefined) {
      payload.claimedByUid = carerUid;
    }
  }
  const rows: LiveOutboxInsertInput[] = [
    {
      channel: coadminTaskLiveChannel(input.coadminUid),
      eventType,
      entityType: 'carer_task',
      entityId: input.taskId,
      source: 'authority_carer_task',
      mirroredAt: input.updatedAt,
      payload,
    },
  ];
  if (carerUid) {
    rows.push({
      channel: carerTaskLiveChannel(carerUid),
      eventType,
      entityType: 'carer_task',
      entityId: input.taskId,
      source: 'authority_carer_task',
      mirroredAt: input.updatedAt,
      payload,
    });
  }
  return rows;
}

async function writeTaskOutboxInTxn(
  client: PoolClient,
  input: {
    coadminUid: string;
    carerUid?: string | null;
    taskId: string;
    status: string;
    type?: string;
    gameName?: string;
    playerUid?: string;
    requestId?: string | null;
    assignedCarerUid?: string | null;
    claimedByUid?: string | null;
    automationStatus?: string | null;
    automationJobId?: string | null;
    updatedAt: string;
    eventType?: string;
    outboxFlowName?: string;
  }
) {
  await insertLiveOutboxEventsBatch(client, buildTaskOutboxRows(input), {
    flowName: input.outboxFlowName || 'write_task_outbox',
  });
}

function buildJobOutboxRows(input: {
  coadminUid: string;
  carerUid: string;
  jobId: string;
  taskId: string;
  status: string;
  type?: string;
  gameName?: string;
  requestId?: string | null;
  updatedAt: string;
  eventType?: string;
}): LiveOutboxInsertInput[] {
  const payload = {
    entityId: input.jobId,
    jobId: input.jobId,
    taskId: input.taskId,
    coadminUid: input.coadminUid,
    carerUid: input.carerUid,
    status: input.status,
    type: cleanText(input.type),
    gameName: cleanText(input.gameName),
    requestId: cleanText(input.requestId) || null,
    updatedAt: input.updatedAt,
    source: 'authority',
  };
  const eventType = cleanText(input.eventType) || 'job.upserted';
  return [
    {
      channel: coadminJobLiveChannel(input.coadminUid),
      eventType,
      entityType: 'automation_job',
      entityId: input.jobId,
      source: 'authority_carer_task',
      mirroredAt: input.updatedAt,
      payload,
    },
    {
      channel: carerJobLiveChannel(input.carerUid),
      eventType,
      entityType: 'automation_job',
      entityId: input.jobId,
      source: 'authority_carer_task',
      mirroredAt: input.updatedAt,
      payload,
    },
  ];
}

async function writeJobOutboxInTxn(
  client: PoolClient,
  input: {
    coadminUid: string;
    carerUid: string;
    jobId: string;
    taskId: string;
    status: string;
    type?: string;
    gameName?: string;
    requestId?: string | null;
    updatedAt: string;
    eventType?: string;
    outboxFlowName?: string;
  }
) {
  await insertLiveOutboxEventsBatch(client, buildJobOutboxRows(input), {
    flowName: input.outboxFlowName || 'write_job_outbox',
  });
}

function buildAgentJobAvailableOutboxRow(input: {
  carerUid: string;
  agentId: string;
  jobId: string;
  taskId: string;
  type: string;
  gameName: string;
  updatedAt: string;
}): LiveOutboxInsertInput | null {
  const carerUid = cleanText(input.carerUid);
  const agentId = cleanText(input.agentId);
  const jobId = cleanText(input.jobId);
  const taskId = cleanText(input.taskId);
  if (!carerUid || !agentId || !jobId || !taskId) {
    return null;
  }

  const payload = {
    jobId,
    taskId,
    carerUid,
    agentId,
    type: cleanText(input.type),
    game: cleanText(input.gameName),
  };

  console.info('[AGENT_STREAM_JOB_AVAILABLE]', payload);

  return {
    channel: agentJobLiveChannel(carerUid, agentId),
    eventType: 'job_available',
    entityType: 'automation_job',
    entityId: jobId,
    source: 'authority_carer_task',
    mirroredAt: input.updatedAt,
    payload,
  };
}

async function writeAgentJobAvailableOutboxInTxn(
  client: PoolClient,
  input: {
    carerUid: string;
    agentId: string;
    jobId: string;
    taskId: string;
    type: string;
    gameName: string;
    updatedAt: string;
  }
) {
  const row = buildAgentJobAvailableOutboxRow(input);
  if (!row) {
    return;
  }
  await insertLiveOutboxEventsBatch(client, [row], {
    flowName: 'write_agent_job_available_outbox',
  });
}

async function cancelAutomationJobInTxn(
  client: PoolClient,
  job: SqlJobRow,
  reason: string,
  nowIso: string
) {
  const raw = {
    ...(job.raw_firestore_data || {}),
    status: 'cancelled',
    claimedStatus: 'cancelled',
    cancelledReason: reason,
    error: `Cancelled by carer (${reason}).`,
    updatedAt: nowIso,
    lastHeartbeatAt: nowIso,
    completedAt: nowIso,
    ttlExpiresAt: ttlAfterDaysIso(AUTOMATION_JOB_TTL_DAYS),
  };
  await upsertAutomationJobInTxn(client, job.job_id, raw, 'authority_carer_task');
  if (reason === 'returned_to_pending') {
    console.info('[SQL_JOB_CANCELLED_FOR_RETURN]', {
      jobId: job.job_id,
      taskId: cleanText(job.task_id) || null,
      cancelledReason: reason,
      priorStatus: normalizeAutomationStatus(job.status),
    });
  }
  return job.job_id;
}

function getNepalHour() {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kathmandu',
    hour: 'numeric',
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date());
  return Number(parts.find((part) => part.type === 'hour')?.value || '0') || 0;
}

function calculateUsernameRewardNpr() {
  const night = getNepalHour() >= 22 || getNepalHour() < 6;
  const min = night ? 8 : 5;
  const max = night ? 15 : 10;
  const base = Math.floor(Math.random() * (max - min + 1)) + min;
  if (!night) return base;
  const bonusPercent = Math.floor(Math.random() * (15 - 10 + 1)) + 10;
  return Math.round(base * (1 + bonusPercent / 100));
}

function usernameTaskIds(coadminUid: string, playerUid: string, gameName: string) {
  const normalized = normalizeGameName(gameName);
  return [
    `create_game_username__${coadminUid}__${playerUid}__${normalized}`,
    `reset_password__${coadminUid}__${playerUid}__${normalized}`,
    `recreate_username__${coadminUid}__${playerUid}__${normalized}`,
  ];
}

async function assertAutomationEnabledInTxn(
  client: PoolClient,
  input: { carerUid: string; coadminUid: string; taskId: string }
) {
  const state = await client.query<Record<string, unknown>>(
    `
      SELECT enabled, coadmin_uid, automation_agent_id
      FROM public.automation_auto_state_cache
      WHERE carer_uid = $1
        AND deleted_at IS NULL
      FOR UPDATE
    `,
    [input.carerUid]
  );
  const row = state.rows[0];
  const rowCoadminUid = cleanText(row?.coadmin_uid);
  const enabled =
    row?.enabled === true &&
    (!rowCoadminUid || rowCoadminUid === input.coadminUid);

  if (enabled) {
    return;
  }

  console.info('[AUTO_DISPATCH_SKIPPED_AUTOMATION_OFF]', {
    taskId: input.taskId,
    carerUid: input.carerUid,
    coadminUid: input.coadminUid,
    stateExists: Boolean(row),
    stateCoadminUid: rowCoadminUid || null,
    enabled: row?.enabled === true,
    reason: row ? 'automation_disabled' : 'automation_state_missing',
    source: 'claimCarerTaskInSql',
  });
  throw new Error('Automation is off. Start Automation before claiming tasks.');
}

async function assertSingleSessionGameAvailableInTxn(
  client: PoolClient,
  input: {
    taskId: string;
    coadminUid: string;
    carerUid: string;
    gameName: string;
    mappedType: string;
  }
) {
  if (!isSingleSessionAutomationGame(input.gameName)) {
    return;
  }

  const gameKey = normalizeAutomationGameKey(input.gameName);
  const lockKey = `single_session:${input.coadminUid}:${input.carerUid}:${gameKey}`;
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [lockKey]);

  const active = await client.query<Record<string, unknown>>(
    `
      SELECT
        t.firebase_id AS task_id,
        t.game_name,
        t.automation_job_id,
        j.status AS job_status
      FROM public.carer_tasks_cache t
      LEFT JOIN public.automation_jobs_cache j
        ON j.job_id = t.automation_job_id
       AND j.deleted_at IS NULL
      WHERE t.deleted_at IS NULL
        AND t.coadmin_uid = $1
        AND t.firebase_id <> $2
        AND t.status = 'in_progress'
        AND (
          t.assigned_carer_uid = $3
          OR t.claimed_by_uid = $3
        )
        AND trim(both '_' from regexp_replace(LOWER(COALESCE(t.game_name, '')), '[^a-z0-9]+', '_', 'g')) = $4
      ORDER BY t.updated_at DESC NULLS LAST
      LIMIT 1
    `,
    [input.coadminUid, input.taskId, input.carerUid, gameKey]
  );

  const row = active.rows[0];
  if (!row) {
    return;
  }

  const jobStatus = cleanText(row.job_status).toLowerCase();
  const jobId = cleanText(row.automation_job_id) || null;
  const blocksNextClaim = !jobId || ACTIVE_JOB_STATUSES.has(jobStatus);
  if (!blocksNextClaim) {
    return;
  }

  console.info('[SINGLE_SESSION_GAME_BLOCKED]', {
    taskId: input.taskId,
    activeTaskId: cleanText(row.task_id) || null,
    activeJobId: jobId,
    activeJobStatus: jobStatus || null,
    coadminUid: input.coadminUid,
    carerUid: input.carerUid,
    gameName: input.gameName,
    gameKey,
    type: input.mappedType,
    reason: 'single_session_game_active',
  });
  console.info('[AUTO_TICK_SINGLE_SESSION_BLOCKED_GAME]', {
    message: `skipped ${input.gameName} because ${input.gameName} already active`,
    taskId: input.taskId,
    activeTaskId: cleanText(row.task_id) || null,
    activeJobId: jobId,
    coadminUid: input.coadminUid,
    carerUid: input.carerUid,
    gameName: input.gameName,
    gameKey,
  });
  throw new Error(`${input.gameName} already has an active automation task.`);
}

function isRequestTask(taskId: string, task: SqlTaskRow) {
  const taskType = cleanText(task.type).toLowerCase();
  return (
    Boolean(cleanText(task.request_id)) ||
    taskId.startsWith('request__') ||
    taskType === 'recharge' ||
    taskType === 'redeem'
  );
}

function readCashBoxNpr(row: Record<string, unknown> | null) {
  if (!row) return 0;
  const raw = (row.raw_firestore_data as Record<string, unknown>) || {};
  return Math.max(0, Math.floor(Number(row.cash_box_npr ?? raw.cashBoxNpr ?? 0)));
}

export type ClaimCarerTaskInput = {
  carerUid: string;
  carerCoadminUid: string;
  taskId: string;
  currentUsername?: string | null;
  carerName?: string | null;
  gameLoginDetails?: GameLoginDetailsInput;
  trustedUser?: {
    username?: string | null;
    automationAgentId?: string | null;
  };
  skipLocked?: boolean;
  allowRetryPendingClaim?: boolean;
  /** When true, claim is rejected unless Start Automation is ON for this carer. */
  requireAutomationEnabled?: boolean;
};

export async function claimCarerTaskInTxn(
  client: PoolClient,
  input: ClaimCarerTaskInput
): Promise<{
  jobId: string;
  taskId: string;
  status: string;
  reusedExistingJob: boolean;
}> {
  const taskId = cleanText(input.taskId);
  const carerUid = cleanText(input.carerUid);
  const carerCoadminUid = cleanText(input.carerCoadminUid);

  const task = await loadTaskForUpdate(client, taskId, Boolean(input.skipLocked));
    if (!task) {
      throw new Error(input.skipLocked ? 'Task locked or not found.' : 'Task not found');
    }

    const profile = await readCarerProfileInTxn(client, carerUid, input.trustedUser);
    const agentCheck = validateAutomationAgentId(profile.automationAgentId);
    if (!agentCheck.valid || !agentCheck.normalized) {
      throw new Error(
        'No automation agent connected. Use “Connect Automation Agent” on the carer panel, set the same ID as in your agent .env, then try again.'
      );
    }
    const resolvedAgentId = agentCheck.normalized;
    const taskCoadminUid = cleanText(task.coadmin_uid);
    if (!carerCoadminUid || taskCoadminUid !== carerCoadminUid) {
      throw new Error('Forbidden: task is outside the carer coadmin scope.');
    }
    await assertAutomationEnabledInTxn(client, {
      taskId,
      carerUid,
      coadminUid: taskCoadminUid,
    });

    const createdByName = cleanText(input.carerName) || profile.username || 'Carer';
    const rawTaskStatus = sanitizeStatus(task.status);
    const automationStatus = normalizeAutomationStatus(task.automation_status);
    const claimedStatus = normalizeClaimedStatus(task.claimed_status);
    const claimedByUid = cleanText(task.claimed_by_uid);
    const automationError = cleanText(task.automation_error) || null;
    const assignedCarerUid = cleanText(task.assigned_carer_uid);
    const linkedJobId = cleanText(task.automation_job_id);
    const currentUserUid = carerUid;

    if (taskBlocksAutomationReclaim(task) && input.allowRetryPendingClaim !== true) {
      console.info('[AUTO_TICK_SKIP_RECENTLY_RETURNED_TASK]', {
        taskId,
        carerUid,
        retryPending: taskHasRetryPending(task),
        returnedToPendingAt:
          toIsoString(task.returned_to_pending_at) ||
          toIsoString(task.raw_firestore_data?.returnedToPendingAt),
        cooldownMs: RETURN_TO_PENDING_COOLDOWN_MS,
        allowRetryPendingClaim: input.allowRetryPendingClaim ?? false,
      });
      throw new Error('Task was returned to pending and is not reclaimable by automation yet.');
    }

    const isPendingCleanTask =
      rawTaskStatus === 'pending' && !claimedByUid && !assignedCarerUid && !linkedJobId;

    const legacyJobId = automationJobDocId(currentUserUid, taskId);
    const jobs = await loadJobsForTask(
      client,
      taskId,
      isPendingCleanTask ? [] : [linkedJobId, legacyJobId]
    );
    const activeJobs = jobs.filter((job) => isActiveAutomationJobStatus(job.status));
    const freshJobs = activeJobs.filter((job) => isFreshAutomationJobSignal(job));
    const jobOwnerUid = (job: SqlJobRow) => cleanText(job.carer_uid || job.raw_firestore_data?.createdByUid);
    const myFreshJobs = freshJobs.filter((job) => jobOwnerUid(job) === currentUserUid);
    const blockingFreshOtherCarer = freshJobs.filter((job) => jobOwnerUid(job) !== currentUserUid);
    if (blockingFreshOtherCarer.length > 0) {
      throw new Error('Automation job already exists for this task.');
    }

    const nowIso = new Date().toISOString();
    const cancelledJobIds: string[] = [];

    if (rawTaskStatus === 'pending' && !myFreshJobs[0]) {
      const keepJobIds = new Set(
        activeJobs
          .filter(
            (job) =>
              jobOwnerUid(job) === currentUserUid &&
              normalizeAutomationStatus(job.status) === 'queued'
          )
          .map((job) => job.job_id)
      );
      for (const job of activeJobs) {
        if (keepJobIds.has(job.job_id)) continue;
        if (jobOwnerUid(job) === currentUserUid) continue;
        cancelledJobIds.push(
          await cancelAutomationJobInTxn(client, job, 'pending_reclaim_stale_job', nowIso)
        );
      }
    }

    const freshTask = mergeTaskRaw(task, {});
    const resolvedAccess = resolveAutomationAccessFields(freshTask, input.gameLoginDetails);
    const claimedTaskData = {
      ...freshTask,
      status: 'in_progress',
      assignedCarerUid: currentUserUid,
      assignedCarerUsername: createdByName,
      assignedCarer: createdByName,
      currentUsername: input.currentUsername ?? freshTask.currentUsername ?? null,
      gameCredentialUsername: resolvedAccess.gameCredentialUsername,
      gameCredentialPassword: resolvedAccess.gameCredentialPassword,
      loginUrl: resolvedAccess.loginUrl,
      gameLoginUrl: resolvedAccess.gameLoginUrl,
      baseUrl: resolvedAccess.baseUrl,
      siteUrl: resolvedAccess.siteUrl,
      lobbyUrl: resolvedAccess.lobbyUrl,
      retryPending: false,
      resetToPendingAt: null,
      returnedToPendingAt: null,
      pendingSince: null,
    } as Record<string, unknown>;

    const mappedType = mapTaskType(resolveTaskTypeLabel(claimedTaskData));
    if (!isAgentSupportedAutomationType(mappedType)) {
      throw new Error(
        `Automation is currently supported only for CREATE_USERNAME, RESET_PASSWORD, RECHARGE, and REDEEM. ${mappedType} must be handled manually.`
      );
    }
    await assertSingleSessionGameAvailableInTxn(client, {
      taskId,
      coadminUid: taskCoadminUid,
      carerUid: currentUserUid,
      gameName: cleanText(task.game_name) || cleanText(freshTask.gameName) || cleanText(freshTask.game),
      mappedType,
    });

    const claimedByCurrentCarer =
      assignedCarerUid === currentUserUid ||
      claimedByUid === currentUserUid ||
      (rawTaskStatus === 'in_progress' && assignedCarerUid === currentUserUid);

    const reusableActiveJob = [...myFreshJobs].sort(
      (left, right) => jobHeartbeatMs(right) - jobHeartbeatMs(left)
    )[0];

    if (
      rawTaskStatus !== 'pending' &&
      claimedStatus === 'running' &&
      !claimedByCurrentCarer &&
      (!reusableActiveJob || normalizeAutomationStatus(reusableActiveJob.status) === 'running')
    ) {
      throw new Error('Task already claimed');
    }

    let result:
      | {
          jobId: string;
          taskId: string;
          status: string;
          reusedExistingJob: boolean;
        }
      | undefined;
    let reusedExistingJob = false;

    const pendingQueuedJob =
      myFreshJobs.find((job) => normalizeAutomationStatus(job.status) === 'queued') ??
      activeJobs.find(
        (job) =>
          jobOwnerUid(job) === currentUserUid &&
          normalizeAutomationStatus(job.status) === 'queued'
      );

    if (
      rawTaskStatus === 'pending' &&
      pendingQueuedJob &&
      isActiveAutomationJobStatus(pendingQueuedJob.status) &&
      taskBlocksAutomationReclaim(task)
    ) {
      console.info('[SQL_TASK_CLAIM_CANCEL_STALE_QUEUED_JOB]', {
        taskId,
        carerUid: currentUserUid,
        jobId: pendingQueuedJob.job_id,
        reason: 'returned_to_pending_cooldown',
      });
      await cancelAutomationJobInTxn(
        client,
        pendingQueuedJob,
        'returned_to_pending_stale_job',
        nowIso
      );
    } else if (
      rawTaskStatus === 'pending' &&
      pendingQueuedJob &&
      isActiveAutomationJobStatus(pendingQueuedJob.status)
    ) {
      console.info('[SQL_AUTOMATION_JOB_ALREADY_EXISTS]', {
        taskId,
        jobId: pendingQueuedJob.job_id,
        carerUid: currentUserUid,
        agentId: resolvedAgentId,
        status: normalizeAutomationStatus(pendingQueuedJob.status),
        phase: 'claim_reuse',
      });
      reusedExistingJob = true;
      result = {
        jobId: pendingQueuedJob.job_id,
        taskId,
        status: 'queued',
        reusedExistingJob: true,
      };
      await patchCarerTaskInTxn(client, taskId, {
        ...claimedTaskData,
        claimedStatus: 'running',
        claimedByUid: currentUserUid,
        claimedByUsername: createdByName,
        claimedAt: nowIso,
        startedAt: nowIso,
        lastHeartbeatAt: nowIso,
        automationStatus: 'waiting',
        automationJobId: pendingQueuedJob.job_id,
        linkedJobId: pendingQueuedJob.job_id,
        automationError: null,
        automationUpdatedAt: nowIso,
        __setAssignedCarer: true,
        __setClaimedStatus: true,
        __setClaimedBy: true,
        __setAutomationStatus: true,
        __setAutomationJobId: true,
        __setJobIds: true,
        __clearAutomationError: true,
        __setStartedAt: true,
        __setClaimedAt: true,
        __setLastHeartbeatAt: true,
        __setAutomationUpdatedAt: true,
      });
    } else if (
      rawTaskStatus !== 'pending' &&
      reusableActiveJob &&
      isActiveAutomationJobStatus(reusableActiveJob.status) &&
      isFreshAutomationJobSignal(reusableActiveJob)
    ) {
      reusedExistingJob = true;
      result = {
        jobId: reusableActiveJob.job_id,
        taskId,
        status: normalizeAutomationStatus(reusableActiveJob.status) || 'queued',
        reusedExistingJob: true,
      };
      await patchCarerTaskInTxn(client, taskId, {
        ...claimedTaskData,
        claimedStatus: 'running',
        claimedByUid: currentUserUid,
        claimedByUsername: createdByName,
        claimedAt: nowIso,
        startedAt: nowIso,
        lastHeartbeatAt: nowIso,
        automationStatus:
          normalizeAutomationStatus(reusableActiveJob.status) === 'running' ? 'running' : 'waiting',
        automationJobId: reusableActiveJob.job_id,
        automationError: null,
        automationUpdatedAt: nowIso,
        __setAssignedCarer: true,
        __setClaimedStatus: true,
        __setClaimedBy: true,
        __setAutomationStatus: true,
        __setAutomationJobId: true,
        __setJobIds: true,
        __clearAutomationError: true,
        __setStartedAt: true,
        __setClaimedAt: true,
        __setLastHeartbeatAt: true,
        __setAutomationUpdatedAt: true,
      });
    } else {
      if (rawTaskStatus !== 'pending' && !claimedByCurrentCarer) {
        const restartable =
          rawTaskStatus === 'waiting' ||
          automationStatus === 'waiting' ||
          automationStatus === 'failed' ||
          automationStatus === 'pending_review' ||
          automationStatus === 'returned_to_pending' ||
          automationStatus === 'cancelled' ||
          Boolean(automationError);
        if (!restartable) {
          throw new Error('Task already claimed');
        }
      }

      const existingActiveQueued = activeJobs.find(
        (job) =>
          jobOwnerUid(job) === currentUserUid &&
          normalizeAutomationStatus(job.status) === 'queued'
      );
      if (existingActiveQueued && taskBlocksAutomationReclaim(task)) {
        console.info('[SQL_TASK_CLAIM_CANCEL_STALE_QUEUED_JOB]', {
          taskId,
          carerUid: currentUserUid,
          jobId: existingActiveQueued.job_id,
          reason: 'returned_to_pending_cooldown',
        });
        await cancelAutomationJobInTxn(
          client,
          existingActiveQueued,
          'returned_to_pending_stale_job',
          nowIso
        );
      } else if (existingActiveQueued) {
        console.info('[SQL_AUTOMATION_JOB_ALREADY_EXISTS]', {
          taskId,
          jobId: existingActiveQueued.job_id,
          carerUid: currentUserUid,
          agentId: resolvedAgentId,
          status: 'queued',
          phase: 'claim_else_reuse',
        });
        reusedExistingJob = true;
        result = {
          jobId: existingActiveQueued.job_id,
          taskId,
          status: 'queued',
          reusedExistingJob: true,
        };
        await patchCarerTaskInTxn(client, taskId, {
          ...claimedTaskData,
          claimedStatus: 'running',
          claimedByUid: currentUserUid,
          claimedByUsername: createdByName,
          claimedAt: nowIso,
          startedAt: nowIso,
          lastHeartbeatAt: nowIso,
          automationStatus: 'waiting',
          automationJobId: existingActiveQueued.job_id,
          linkedJobId: existingActiveQueued.job_id,
          automationError: null,
          automationUpdatedAt: nowIso,
          __setAssignedCarer: true,
          __setClaimedStatus: true,
          __setClaimedBy: true,
          __setAutomationStatus: true,
          __setAutomationJobId: true,
          __setJobIds: true,
          __clearAutomationError: true,
          __setStartedAt: true,
          __setClaimedAt: true,
          __setLastHeartbeatAt: true,
          __setAutomationUpdatedAt: true,
        });
      } else {
        const payload = buildAutomationPayload({
          taskId,
          freshTask: claimedTaskData,
          currentUserUid,
          currentCarerName: createdByName,
          currentUsername: input.currentUsername ?? null,
        });
        console.info('[CLAIM_TASK_SQL_PAYLOAD_BUILT]', {
          taskId,
          carerUid: currentUserUid,
          coadminUid: taskCoadminUid,
          type: mappedType,
          hasCurrentUsername: Boolean(input.currentUsername ?? claimedTaskData.currentUsername),
          hasGameCredentialUsername: Boolean(claimedTaskData.gameCredentialUsername),
          hasGameCredentialPassword: Boolean(claimedTaskData.gameCredentialPassword),
          hasLoginUrl: Boolean(claimedTaskData.loginUrl || claimedTaskData.gameLoginUrl),
        });
        const jobId = randomUUID();
        const jobData = {
          carerUid: currentUserUid,
          coadminUid: taskCoadminUid,
          agentId: resolvedAgentId,
          taskId,
          type: mappedType,
          status: 'queued',
          payload,
          createdByUid: currentUserUid,
          createdByName,
          createdAt: nowIso,
          updatedAt: nowIso,
          startedAt: null,
          completedAt: null,
          ttlExpiresAt: null,
          error: null,
          attempts: 0,
          lastHeartbeatAt: null,
          game: cleanText(task.game_name),
          playerUid: cleanText(task.player_uid),
        };
        await upsertAutomationJobInTxn(client, jobId, jobData);
        console.info('[SQL_AUTOMATION_JOB_QUEUED]', {
          taskId,
          jobId,
          carerUid: currentUserUid,
          agentId: resolvedAgentId,
          coadminUid: taskCoadminUid,
          type: mappedType,
          status: 'queued',
          phase: 'claim_create',
        });
        result = { jobId, taskId, status: 'queued', reusedExistingJob: false };
        await patchCarerTaskInTxn(client, taskId, {
        ...claimedTaskData,
        claimedStatus: 'running',
        claimedByUid: currentUserUid,
        claimedByUsername: createdByName,
        claimedAt: nowIso,
        startedAt: nowIso,
        lastHeartbeatAt: nowIso,
        automationStatus: 'waiting',
        automationJobId: jobId,
        linkedJobId: jobId,
        automationError: null,
        automationUpdatedAt: nowIso,
        __setAssignedCarer: true,
        __setClaimedStatus: true,
        __setClaimedBy: true,
        __setAutomationStatus: true,
        __setAutomationJobId: true,
        __setJobIds: true,
        __clearAutomationError: true,
        __setStartedAt: true,
        __setClaimedAt: true,
        __setLastHeartbeatAt: true,
        __setAutomationUpdatedAt: true,
      });
      }
    }

    if (!result) {
      throw new Error('Failed to claim task: no automation job was created.');
    }
    console.info('[TASK_CLAIMED]', {
      taskId,
      claimedAt: nowIso,
      carerUid: currentUserUid,
      createToClaimMs: durationBetweenMs(task.created_at, nowIso),
    });
    console.info('[TASK_STARTED]', {
      taskId,
      startedAt: nowIso,
      carerUid: currentUserUid,
      claimToStartMs: durationBetweenMs(nowIso, nowIso),
    });
    console.info('[AUTO_TASK_CLAIM]', {
      taskId,
      player: cleanText(task.player_uid) || null,
      automationUser: currentUserUid,
      claimTime: nowIso,
      jobId: result.jobId,
      source: 'claim_carer_task_in_txn',
    });
    console.info('[AUTO_TASK_STARTED]', {
      taskId,
      player: cleanText(task.player_uid) || null,
      automationUser: currentUserUid,
      claimTime: nowIso,
      jobId: result.jobId,
      source: 'claim_carer_task_in_txn',
    });

    const claimOutboxRows: LiveOutboxInsertInput[] = [
      ...buildTaskOutboxRows({
        coadminUid: taskCoadminUid,
        carerUid: currentUserUid,
        taskId,
        status: 'in_progress',
        type: cleanText(task.type),
        gameName: cleanText(task.game_name),
        requestId: cleanText(task.request_id),
        updatedAt: nowIso,
        eventType: 'task.claimed',
      }),
      ...buildJobOutboxRows({
        coadminUid: taskCoadminUid,
        carerUid: currentUserUid,
        jobId: result.jobId,
        taskId,
        status: result.status,
        type: mappedType,
        gameName: cleanText(task.game_name),
        requestId: cleanText(task.request_id),
        updatedAt: nowIso,
        eventType: reusedExistingJob ? 'job.reused' : 'job.created',
      }),
    ];
    if (normalizeAutomationStatus(result.status) === 'queued') {
      const agentRow = buildAgentJobAvailableOutboxRow({
        carerUid: currentUserUid,
        agentId: resolvedAgentId,
        jobId: result.jobId,
        taskId,
        type: mappedType,
        gameName: cleanText(task.game_name),
        updatedAt: nowIso,
      });
      if (agentRow) {
        claimOutboxRows.push(agentRow);
      }
    }
    for (const cancelledJobId of cancelledJobIds) {
      claimOutboxRows.push(
        ...buildJobOutboxRows({
          coadminUid: taskCoadminUid,
          carerUid: currentUserUid,
          jobId: cancelledJobId,
          taskId,
          status: 'cancelled',
          updatedAt: nowIso,
          eventType: 'job.cancelled',
        })
      );
    }
    await insertLiveOutboxEventsBatch(client, claimOutboxRows, {
      flowName: 'carer_task_claim',
    });
    console.info('[TASK_OUTBOX_EMITTED]', {
      taskId,
      phase: 'claim',
      flowName: 'carer_task_claim',
      rowCount: claimOutboxRows.length,
      eventTypes: claimOutboxRows.map((row) => row.eventType),
    });

  return result;
}

export async function claimCarerTaskInSql(input: ClaimCarerTaskInput): Promise<{
  jobId: string;
  taskId: string;
  status: string;
  reusedExistingJob: boolean;
  duplicate?: boolean;
}> {
  const db = getPlayerMirrorPool();
  if (!db) {
    throw new Error('SQL pool unavailable.');
  }

  const taskId = cleanText(input.taskId);
  const carerUid = cleanText(input.carerUid);
  if (input.requireAutomationEnabled) {
    const { assertCarerAutomationDispatchEnabled } = await import(
      '@/lib/automation/automationDispatchGate'
    );
    await assertCarerAutomationDispatchEnabled(carerUid, {
      route: 'claimCarerTaskInSql',
      carerUid,
      coadminUid: input.carerCoadminUid,
      taskId,
      source: 'auto_dispatch',
    });
  }
  const operationKey = `task_claim:${taskId}:${carerUid}`;

  logAuthPayloadPreTxnRemoved('carer_task_claim');
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const op = await claimAuthorityOperation(client, {
      operationKey,
      operationType: 'task_claim',
      userUid: carerUid,
      sourceId: taskId,
      actorUid: carerUid,
      payload: {},
    });
    if (!op.claimed && op.duplicate) {
      const payload = await readAuthorityOperationPayloadWithClient(client, operationKey, {
        flowName: 'carer_task_claim',
      });
      const staleJobId = cleanText(payload?.jobId);
      console.info('[SQL_TASK_CLAIM_DUPLICATE_CHECK]', {
        taskId,
        carerUid,
        operationKey,
        staleJobId: staleJobId || null,
        hasPayload: Boolean(payload?.jobId),
      });

      if (staleJobId) {
        const taskSnap = await client.query(
          `
            SELECT status, automation_job_id
            FROM public.carer_tasks_cache
            WHERE firebase_id = $1 AND deleted_at IS NULL
            LIMIT 1
          `,
          [taskId]
        );
        const taskStatus = sanitizeStatus(
          (taskSnap.rows[0] as { status?: string | null } | undefined)?.status
        );
        const taskAutomationJobId = cleanText(
          (taskSnap.rows[0] as { automation_job_id?: string | null } | undefined)
            ?.automation_job_id
        );
        const taskPendingWithoutJob = taskStatus === 'pending' && !taskAutomationJobId;

        const jobSnap = await client.query(
          `
            SELECT job_id, status
            FROM public.automation_jobs_cache
            WHERE job_id = $1 AND deleted_at IS NULL
            LIMIT 1
          `,
          [staleJobId]
        );
        const jobStatus = normalizeAutomationStatus(
          (jobSnap.rows[0] as { status?: string | null } | undefined)?.status
        );

        if (taskPendingWithoutJob) {
          console.info('[SQL_TASK_CLAIM_STALE_JOB_IGNORED]', {
            taskId,
            carerUid,
            staleJobId,
            jobStatus: jobStatus || null,
            reason: 'task_pending_without_job',
          });
          console.info('[SQL_TASK_RECLAIM_AFTER_RETURN]', {
            taskId,
            carerUid,
            staleJobId,
            priorJobStatus: jobStatus || null,
          });
        } else if (
          REUSABLE_CLAIM_DUPLICATE_JOB_STATUSES.has(jobStatus) &&
          taskStatus === 'in_progress' &&
          taskAutomationJobId === staleJobId
        ) {
          console.info('[SQL_TASK_CLAIM_REUSE_ACTIVE_JOB]', {
            taskId,
            carerUid,
            jobId: staleJobId,
            jobStatus,
            taskStatus,
          });
          await client.query('COMMIT');
          return {
            jobId: staleJobId,
            taskId,
            status: String(payload?.status || jobStatus || 'queued'),
            reusedExistingJob: Boolean(payload?.reusedExistingJob),
            duplicate: true,
          };
        } else if (REUSABLE_CLAIM_DUPLICATE_JOB_STATUSES.has(jobStatus)) {
          console.info('[SQL_TASK_CLAIM_STALE_JOB_IGNORED]', {
            taskId,
            carerUid,
            staleJobId,
            jobStatus,
            taskStatus,
            taskAutomationJobId: taskAutomationJobId || null,
            reason: 'active_job_not_linked_to_in_progress_task',
          });
        } else if (
          !jobSnap.rows.length ||
          FINAL_CLAIM_DUPLICATE_JOB_STATUSES.has(jobStatus) ||
          !jobStatus
        ) {
          console.info('[SQL_TASK_CLAIM_STALE_JOB_IGNORED]', {
            taskId,
            carerUid,
            staleJobId,
            jobStatus: jobStatus || 'missing',
            reason: 'final_or_missing_job',
          });
          if (FINAL_CLAIM_DUPLICATE_JOB_STATUSES.has(jobStatus)) {
            console.info('[SQL_TASK_RECLAIM_AFTER_RETURN]', {
              taskId,
              carerUid,
              staleJobId,
              priorJobStatus: jobStatus,
            });
          }
        } else {
          console.info('[SQL_TASK_CLAIM_STALE_JOB_IGNORED]', {
            taskId,
            carerUid,
            staleJobId,
            jobStatus,
            reason: 'non_reusable_active_status',
          });
        }
      }
    }

    const result = await claimCarerTaskInTxn(client, input);

    await client.query(`UPDATE public.authority_operations SET payload = $2::jsonb WHERE operation_key = $1`, [
      operationKey,
      JSON.stringify({
        jobId: result.jobId,
        status: result.status,
        reusedExistingJob: result.reusedExistingJob,
      }),
    ]);
    await client.query('COMMIT');
    return { ...result, duplicate: false };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function returnTaskToPendingInSql(input: {
  taskId: string;
  actorUid: string;
  actorRole: string;
  isAdmin: boolean;
  scopeUid: string | null;
  idempotencyKey?: string | null;
}) {
  const db = getPlayerMirrorPool();
  if (!db) throw new Error('SQL pool unavailable.');

  const taskId = cleanText(input.taskId);
  const idempotencyKey = cleanText(input.idempotencyKey) || taskId;
  const operationKey = `task_return:${taskId}:${idempotencyKey}`;

  logAuthPayloadPreTxnRemoved('carer_task_return');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const op = await claimAuthorityOperation(client, {
      operationKey,
      operationType: 'task_return',
      userUid: input.actorUid,
      sourceId: taskId,
      actorUid: input.actorUid,
      actorRole: input.actorRole,
      payload: {},
    });
    let duplicateReturn = false;
    if (!op.claimed && op.duplicate) {
      duplicateReturn = true;
      const existingTask = await loadTaskForUpdate(client, taskId);
      if (!existingTask) {
        throw new Error('Task not found.');
      }
      if (!taskNeedsReturnReapply(existingTask)) {
        const payload = await readAuthorityOperationPayloadWithClient(client, operationKey, {
          flowName: 'carer_task_return',
        });
        const finalState = await readTaskReturnFinalState(client, taskId);
        logTaskReturnFinalState({
          taskId,
          actorUid: input.actorUid,
          finalState,
          cancelledJobs:
            typeof payload?.cancelledJobs === 'number' ? payload.cancelledJobs : undefined,
          duplicate: true,
        });
        await client.query('COMMIT');
        return { success: true as const, duplicate: true, reapplied: false, ...(payload || {}) };
      }
      console.info('[SQL_TASK_RETURN_DUPLICATE_REAPPLY]', {
        taskId,
        actorUid: input.actorUid,
        operationKey,
        reason: 'task_not_clean_pending_after_prior_return',
        status: sanitizeStatus(existingTask.status),
        assignedCarerUid: cleanText(existingTask.assigned_carer_uid) || null,
        automationJobId: cleanText(existingTask.automation_job_id) || null,
      });
    }

    console.info('[SQL_TASK_RETURN_TO_PENDING_START]', {
      taskId,
      actorUid: input.actorUid,
      actorRole: input.actorRole,
      idempotencyKey,
      operationKey,
    });

    const task = await loadTaskForUpdate(client, taskId);
    if (!task) throw new Error('Task not found.');
    const taskScope = cleanText(task.coadmin_uid);
    if (!taskScope) throw new Error('Task missing scope.');
    if (!input.isAdmin && (!input.scopeUid || input.scopeUid !== taskScope)) {
      throw new Error('Forbidden: task is outside your scope.');
    }
    const oldTaskStatus = sanitizeStatus(task.status);
    if (!RESETTABLE_TASK_STATUSES.has(oldTaskStatus)) {
      throw new Error('Task is not resettable.');
    }
    const beforeAssignedCarerUid = cleanText(task.assigned_carer_uid) || null;
    if (input.actorRole === 'carer') {
      const assignedUid = beforeAssignedCarerUid || cleanText(task.claimed_by_uid);
      if (assignedUid && assignedUid !== input.actorUid) {
        throw new Error('Forbidden: only the assigned carer can return this task.');
      }
    }

    const nowIso = new Date().toISOString();
    const legacyJobId = automationJobDocId(input.actorUid, taskId);
    const jobs = await loadJobsForTask(client, taskId, [
      legacyJobId,
      cleanText(task.automation_job_id),
    ]);
    let cancelledJobs = 0;
    for (const job of jobs) {
      if (cleanText(job.task_id) && cleanText(job.task_id) !== taskId) continue;
      const jobScope = cleanText(job.coadmin_uid);
      if (jobScope && jobScope !== taskScope) {
        throw new Error('Forbidden: linked automation job is outside your scope.');
      }
      const jobStatus = normalizeAutomationStatus(job.status);
      if (FINAL_CLAIM_DUPLICATE_JOB_STATUSES.has(jobStatus)) continue;
      if (!jobStatus) continue;
      await cancelAutomationJobInTxn(client, job, 'returned_to_pending', nowIso);
      cancelledJobs += 1;
      await writeJobOutboxInTxn(client, {
        coadminUid: taskScope,
        carerUid: cleanText(job.carer_uid) || input.actorUid,
        jobId: job.job_id,
        taskId,
        status: 'cancelled',
        updatedAt: nowIso,
        eventType: 'job.cancelled',
      });
    }

    const requestId = cleanText(task.request_id);
    if (requestId) {
      const requestResult = await client.query(
        `
          SELECT firebase_id, coadmin_uid, status, raw_firestore_data
          FROM public.player_game_requests_cache
          WHERE firebase_id = $1 AND deleted_at IS NULL
          FOR UPDATE
        `,
        [requestId]
      );
      if (requestResult.rows.length) {
        const request = requestResult.rows[0] as {
          coadmin_uid?: string;
          status?: string;
          raw_firestore_data?: Record<string, unknown>;
        };
        const requestScope = cleanText(request.coadmin_uid);
        if (requestScope && requestScope !== taskScope) {
          throw new Error('Forbidden: linked request is outside your scope.');
        }
        const requestStatus = sanitizeStatus(request.status);
        if (requestStatus && !RESETTABLE_REQUEST_STATUSES.has(requestStatus)) {
          throw new Error('Linked request is settled and cannot be reset.');
        }
        const requestRaw = {
          ...(request.raw_firestore_data || {}),
          status: 'pending',
          automationStatus: null,
          automationJobId: null,
          linkedJobId: null,
          completedAt: null,
          dismissedAt: null,
          failedAt: null,
          ttlExpiresAt: null,
          pokedAt: null,
          pokeMessage: null,
          fakeRedeem: null,
          fakeRedeemReason: null,
          dismissType: null,
          dismissedByAutomation: null,
          dismissReasonCode: null,
          dismissReasonMessage: null,
          dismissMeta: null,
          automationError: null,
          resetToPendingAt: nowIso,
          returnedToPendingAt: nowIso,
          error: null,
          failureReason: null,
          lastFailureReason: null,
          retryPending: true,
          updatedAt: nowIso,
        };
        await upsertGameRequestCacheInTxn(client, requestId, {
          ...requestRaw,
          status: 'pending',
          source: 'authority_task_return',
          rawFirestoreData: requestRaw,
        });
      }
    }

    await patchCarerTaskInTxn(client, taskId, {
      status: 'pending',
      assignedCarerUid: '',
      assignedCarerUsername: '',
      assignedCarer: '',
      claimedStatus: '',
      claimedByUid: '',
      claimedByUsername: '',
      automationStatus: '',
      automationJobId: '',
      linkedJobId: '',
      automationError: '',
      claimedAt: null,
      startedAt: null,
      lastHeartbeatAt: null,
      retryPending: true,
      resetToPendingAt: nowIso,
      returnedToPendingAt: nowIso,
      pendingSince: nowIso,
      automationUpdatedAt: nowIso,
      __setAssignedCarer: true,
      __setClaimedStatus: true,
      __setClaimedBy: true,
      __setAutomationStatus: true,
      __setAutomationJobId: true,
      __setJobIds: true,
      __clearAutomationError: true,
      __clearClaimTimestamps: true,
      __setResetToPendingAt: true,
      __setReturnedToPendingAt: true,
      __setPendingSince: true,
      __setAutomationUpdatedAt: true,
    }, 'authority_task_return');

    const deletedClaimOps = await deleteAuthorityOperationsByPrefixInTxn(
      client,
      `task_claim:${taskId}:`
    );
    console.info('[SQL_TASK_RETURN_CLEARED_CLAIM_FIELDS]', {
      taskId,
      actorUid: input.actorUid,
      clearedFields: [
        'assigned_carer_uid',
        'claimed_by_uid',
        'automation_job_id',
        'claimed_at',
        'started_at',
        'last_heartbeat_at',
      ],
      deletedTaskClaimOps: deletedClaimOps,
      resetToPendingAt: nowIso,
      returnedToPendingAt: nowIso,
    });

    const finalState = await readTaskReturnFinalState(client, taskId);
    logTaskReturnFinalState({
      taskId,
      actorUid: input.actorUid,
      finalState,
      cancelledJobs,
      duplicate: duplicateReturn,
      reapplied: duplicateReturn,
    });

    const returnCarerUid = beforeAssignedCarerUid || input.actorUid;
    const retryAtIso = new Date(Date.parse(nowIso) + RETURN_TO_PENDING_COOLDOWN_MS).toISOString();
    const returnOutboxBase = {
      coadminUid: taskScope,
      carerUid: returnCarerUid,
      taskId,
      status: 'pending' as const,
      type: cleanText(task.type),
      gameName: cleanText(task.game_name),
      playerUid: cleanText(task.player_uid),
      requestId,
      updatedAt: nowIso,
      assignedCarerUid: null,
      claimedByUid: null,
      automationStatus: null,
      automationJobId: null,
      retryPending: true,
      returnedToPendingAt: nowIso,
      retryAt: retryAtIso,
    };
    await insertLiveOutboxEventsBatch(
      client,
      [
        ...buildTaskOutboxRows({ ...returnOutboxBase, eventType: 'task.returned_to_pending' }),
        ...buildTaskOutboxRows({ ...returnOutboxBase, eventType: 'task.failed' }),
        ...buildTaskOutboxRows({ ...returnOutboxBase, eventType: 'task.released' }),
      ],
      { flowName: 'carer_task_return_to_pending' }
    );

    console.info('[AUTO_TASK_FAILED]', {
      taskId,
      player: cleanText(task.player_uid) || null,
      automationUser: returnCarerUid,
      failureReason:
        cleanText(task.automation_error) ||
        cleanText(task.raw_firestore_data?.lastFailureReason) ||
        cleanText(task.raw_firestore_data?.failureReason) ||
        'returned_to_pending',
      completionTime: nowIso,
      retryAt: retryAtIso,
      retryAfterMs: RETURN_TO_PENDING_COOLDOWN_MS,
    });
    console.info('[AUTO_TASK_RELEASED]', {
      taskId,
      player: cleanText(task.player_uid) || null,
      automationUser: returnCarerUid,
      claimTime: toIsoString(task.claimed_at),
      completionTime: nowIso,
      retryPending: true,
      returnedToPendingAt: nowIso,
      retryAt: retryAtIso,
    });
    console.info('[AUTO_RETRY_PENDING_DETECTED]', {
      taskId,
      carerUid: returnCarerUid,
      reason: 'returned_to_pending',
      retryAt: retryAtIso,
      retryAfterMs: RETURN_TO_PENDING_COOLDOWN_MS,
    });

    console.info('[CARER_RETURN_TO_PENDING_SQL_WRITE]', {
      taskId,
      beforeStatus: oldTaskStatus,
      afterStatus: 'pending',
      beforeAssignedCarerUid,
      afterAssignedCarerUid: null,
      automationJobCancelled: cancelledJobs > 0,
      outboxInserted: true,
      ok: true,
      reason: null,
    });

    const outcome = {
      oldTaskStatus,
      cancelledJobs,
      linkedRequestReset: Boolean(requestId),
      reapplied: duplicateReturn,
    };
    await client.query(`UPDATE public.authority_operations SET payload = $2::jsonb WHERE operation_key = $1`, [
      operationKey,
      JSON.stringify(outcome),
    ]);
    await client.query('COMMIT');
    return { success: true as const, duplicate: duplicateReturn, ...outcome };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function resolveCarerTaskCacheId(taskId: string) {
  const clean = cleanText(taskId);
  if (!clean) return '';
  if (clean.startsWith('request__')) {
    return clean;
  }
  if (!clean.includes('__')) {
    return `request__${clean}`;
  }
  return clean;
}

async function resolveTaskRowForDelete(client: PoolClient, rawTaskId: string) {
  const candidates = Array.from(
    new Set([cleanText(rawTaskId), resolveCarerTaskCacheId(rawTaskId)].filter(Boolean))
  );
  for (const candidate of candidates) {
    const result = await client.query(
      `
        SELECT *
        FROM public.carer_tasks_cache
        WHERE firebase_id = $1
        FOR UPDATE
      `,
      [candidate]
    );
    if (result.rows.length) {
      return {
        taskId: candidate,
        row: result.rows[0] as Record<string, unknown>,
      };
    }
  }
  return null;
}

function logCarerDeleteSql(input: {
  taskId: string;
  matchedRows: number;
  deletedAt: string | null;
  deletedByCarerUid: string | null;
  success: boolean;
}) {
  console.info('[CARER_DELETE_SQL]', input);
}

async function tombstoneCarerTaskInTxn(
  client: PoolClient,
  taskId: string,
  input: {
    coadminUid: string;
    carerUid?: string | null;
    type?: string;
    gameName?: string;
    requestId?: string | null;
    source: string;
    failureReason?: string;
    deletedFromPendingAt: string;
    deletedFromPendingByCarerUid: string;
    deletedFromPendingByCarerUsername?: string | null;
  }
) {
  const nowIso = input.deletedFromPendingAt;
  const deletedByCarerUid = cleanText(input.deletedFromPendingByCarerUid);
  const deletedByCarerUsername = cleanText(input.deletedFromPendingByCarerUsername) || 'Carer';
  const tombstoneResult = await client.query(
    `
      UPDATE public.carer_tasks_cache
      SET
        status = 'deleted',
        assigned_carer_uid = NULL,
        assigned_carer_username = NULL,
        assigned_carer = NULL,
        claimed_status = NULL,
        claimed_by_uid = NULL,
        claimed_by_username = NULL,
        automation_status = NULL,
        automation_job_id = NULL,
        linked_job_id = NULL,
        current_job_id = NULL,
        active_job_id = NULL,
        automation_error = NULL,
        failure_reason = COALESCE(NULLIF($2, ''), failure_reason),
        deleted_from_pending_at = $3::timestamptz,
        updated_at = $3::timestamptz,
        mirrored_at = now(),
        deleted_at = now(),
        source = $4,
        raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb) || $5::jsonb
      WHERE firebase_id = $1
        AND deleted_at IS NULL
    `,
    [
      taskId,
      cleanText(input.failureReason) || 'deleted_by_carer',
      nowIso,
      input.source,
      JSON.stringify({
        status: 'deleted',
        deletedAt: nowIso,
        deletedFromPendingAt: nowIso,
        deletedFromPendingByCarerUid: deletedByCarerUid,
        deletedFromPendingByCarerUsername: deletedByCarerUsername,
        failureReason: cleanText(input.failureReason) || 'deleted_by_carer',
      }),
    ]
  );
  const matchedRows = tombstoneResult.rowCount || 0;
  logCarerDeleteSql({
    taskId,
    matchedRows,
    deletedAt: nowIso,
    deletedByCarerUid: deletedByCarerUid || null,
    success: matchedRows > 0,
  });

  await writeTaskOutboxInTxn(client, {
    coadminUid: input.coadminUid,
    carerUid: input.carerUid,
    taskId,
    status: 'tombstoned',
    type: cleanText(input.type),
    gameName: cleanText(input.gameName),
    requestId: input.requestId,
    assignedCarerUid: null,
    claimedByUid: null,
    automationStatus: null,
    automationJobId: null,
    updatedAt: nowIso,
    eventType: 'task.tombstoned',
  });
  return matchedRows;
}

export async function deletePendingTaskInSql(input: {
  taskId: string;
  actorUid: string;
  actorUsername?: string | null;
  actorRole: string;
  isAdmin: boolean;
  scopeUid: string | null;
  idempotencyKey?: string | null;
}) {
  const db = getPlayerMirrorPool();
  if (!db) throw new Error('SQL pool unavailable.');

  const requestedTaskId = cleanText(input.taskId);
  const taskId = resolveCarerTaskCacheId(requestedTaskId) || requestedTaskId;
  const idempotencyKey = cleanText(input.idempotencyKey) || taskId;
  const operationKey = `task_delete:${taskId}:${idempotencyKey}`;

  logAuthPayloadPreTxnRemoved('carer_task_delete');

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const op = await claimAuthorityOperation(client, {
      operationKey,
      operationType: 'task_delete',
      userUid: input.actorUid,
      sourceId: taskId,
      actorUid: input.actorUid,
      actorRole: input.actorRole,
      payload: {},
    });
    if (!op.claimed && op.duplicate) {
      const payload = await readAuthorityOperationPayloadWithClient(client, operationKey, {
        flowName: 'carer_task_delete',
      });
      await client.query('ROLLBACK');
      const tombstoneCheck = await db.query(
        `
          SELECT status, deleted_at, request_id
          FROM public.carer_tasks_cache
          WHERE firebase_id = $1
          LIMIT 1
        `,
        [taskId]
      );
      const tombstoneRow = tombstoneCheck.rows[0] as Record<string, unknown> | undefined;
      const alreadyTombstoned = Boolean(tombstoneRow?.deleted_at);
      if (payload?.deleted === true || alreadyTombstoned) {
        console.info('[CARER_DELETE_TASK_SQL_WRITE]', {
          taskId,
          matchedRows: alreadyTombstoned ? 1 : 0,
          beforeStatus: cleanText(tombstoneRow?.status) || 'unknown',
          afterStatus: 'deleted',
          beforeDeletedAt: tombstoneRow?.deleted_at ? toIsoString(tombstoneRow.deleted_at) : null,
          afterDeletedAt: tombstoneRow?.deleted_at ? toIsoString(tombstoneRow.deleted_at) : 'existing',
          deletedAtSet: true,
          linkedRequestId: cleanText(payload?.linkedRequestId || tombstoneRow?.request_id) || null,
          linkedRequestUpdated: false,
          automationJobCancelled: false,
          outboxInserted: false,
          ok: true,
          reason: 'duplicate_operation',
        });
        return {
          success: true as const,
          duplicate: true,
          alreadyDeleted: true,
          taskId,
        };
      }
      throw new Error('Duplicate delete in progress.');
    }

    const resolved = await resolveTaskRowForDelete(client, requestedTaskId);
    if (!resolved) {
      throw new Error('Task not found.');
    }
    const resolvedTaskId = resolved.taskId;
    const row = resolved.row;
    const beforeStatus = sanitizeStatus(row.status);
    const beforeDeletedAt = row.deleted_at ? toIsoString(row.deleted_at) : null;
    if (beforeDeletedAt) {
      await client.query(`UPDATE public.authority_operations SET payload = $2::jsonb WHERE operation_key = $1`, [
        operationKey,
        JSON.stringify({
          deleted: true,
          linkedRequestId: cleanText(row.request_id) || null,
        }),
      ]);
      await client.query('COMMIT');
      console.info('[CARER_DELETE_TASK_SQL_WRITE]', {
        taskId: resolvedTaskId,
        matchedRows: 1,
        beforeStatus,
        afterStatus: 'deleted',
        deletedAtSet: true,
        ok: true,
      });
      return {
        success: true as const,
        duplicate: true,
        alreadyDeleted: true,
        taskId: resolvedTaskId,
      };
    }

    const task = taskFromRow(row);
    const taskScope = cleanText(task.coadmin_uid);
    if (!taskScope) throw new Error('Task missing scope.');
    if (!input.isAdmin && (!input.scopeUid || input.scopeUid !== taskScope)) {
      throw new Error('Forbidden: task is outside your scope.');
    }
    if (sanitizeStatus(task.status) !== 'pending') {
      throw new Error('Only pending tasks can be deleted.');
    }

    const linkedRequestId = cleanText(task.request_id) || null;
    const nowIso = new Date().toISOString();
    const carerUid =
      cleanText(task.assigned_carer_uid) || cleanText(task.claimed_by_uid) || input.actorUid;

    const legacyJobId = automationJobDocId(carerUid, resolvedTaskId);
    const jobs = await loadJobsForTask(client, resolvedTaskId, [
      legacyJobId,
      cleanText(task.automation_job_id),
    ]);
    let cancelledJobs = 0;
    for (const job of jobs) {
      if (cleanText(job.task_id) && cleanText(job.task_id) !== resolvedTaskId) continue;
      const jobScope = cleanText(job.coadmin_uid);
      if (jobScope && jobScope !== taskScope) {
        throw new Error('Forbidden: linked automation job is outside your scope.');
      }
      if (!ACTIVE_JOB_STATUSES.has(normalizeAutomationStatus(job.status))) continue;
      await cancelAutomationJobInTxn(client, job, 'deleted_from_pending', nowIso);
      cancelledJobs += 1;
      await writeJobOutboxInTxn(client, {
        coadminUid: taskScope,
        carerUid: cleanText(job.carer_uid) || carerUid,
        jobId: job.job_id,
        taskId: resolvedTaskId,
        status: 'cancelled',
        updatedAt: nowIso,
        eventType: 'job.cancelled',
      });
    }

    const matchedRows = await tombstoneCarerTaskInTxn(client, resolvedTaskId, {
      coadminUid: taskScope,
      carerUid,
      type: cleanText(task.type),
      gameName: cleanText(task.game_name),
      requestId: linkedRequestId,
      source: 'authority_task_delete',
      failureReason: 'deleted_by_carer',
      deletedFromPendingAt: nowIso,
      deletedFromPendingByCarerUid: input.actorUid,
      deletedFromPendingByCarerUsername: input.actorUsername || 'Carer',
    });
    if (matchedRows < 1) {
      throw new Error('Task delete did not update any rows.');
    }

    await client.query(`UPDATE public.authority_operations SET payload = $2::jsonb WHERE operation_key = $1`, [
      operationKey,
      JSON.stringify({
        deleted: true,
        linkedRequestId,
      }),
    ]);
    await client.query('COMMIT');
    console.info('[CARER_DELETE_TASK_SQL_WRITE]', {
      taskId: resolvedTaskId,
      matchedRows,
      beforeStatus,
      afterStatus: 'deleted',
      deletedAtSet: true,
      ok: true,
    });
    return {
      success: true as const,
      duplicate: false,
      alreadyDeleted: false,
      taskId: resolvedTaskId,
      automationJobCancelled: cancelledJobs > 0,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    const reason = error instanceof Error ? error.message : 'delete_failed';
    console.warn('[CARER_DELETE_TASK_SQL_WRITE]', {
      taskId,
      matchedRows: 0,
      beforeStatus: 'unknown',
      afterStatus: 'unknown',
      beforeDeletedAt: null,
      afterDeletedAt: null,
      deletedAtSet: false,
      linkedRequestId: null,
      linkedRequestUpdated: false,
      automationJobCancelled: false,
      outboxInserted: false,
      ok: false,
      reason,
    });
    throw error;
  } finally {
    client.release();
  }
}

export async function completeUsernameTasksInSql(input: {
  coadminUid: string;
  playerUid: string;
  gameName: string;
  actorUid: string;
  actorUsername?: string | null;
  actorRole: string;
  isAdmin: boolean;
  scopeUid: string | null;
  idempotencyKey?: string | null;
}) {
  const db = getPlayerMirrorPool();
  if (!db) throw new Error('SQL pool unavailable.');

  const coadminUid = cleanText(input.coadminUid);
  const playerUid = cleanText(input.playerUid);
  const gameName = cleanText(input.gameName);
  if (!input.isAdmin && (!input.scopeUid || input.scopeUid !== coadminUid)) {
    throw new Error('Forbidden: task is outside your scope.');
  }

  const taskIds = usernameTaskIds(coadminUid, playerUid, gameName);
  const batchKey =
    cleanText(input.idempotencyKey) || `username:${coadminUid}:${playerUid}:${normalizeGameName(gameName)}`;
  const operationKey = `task_complete:${batchKey}:${input.actorUid}`;

  logAuthPayloadPreTxnRemoved('carer_task_complete_username');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const op = await claimAuthorityOperation(client, {
      operationKey,
      operationType: 'task_complete_username',
      userUid: input.actorUid,
      sourceId: batchKey,
      actorUid: input.actorUid,
      actorRole: input.actorRole,
      payload: {},
    });
    if (!op.claimed && op.duplicate) {
      const payload = await readAuthorityOperationPayloadWithClient(client, operationKey, {
        flowName: 'carer_task_complete_username',
      });
      await client.query('COMMIT');
      return {
        success: true as const,
        duplicate: true,
        completedTaskCount: Number(payload?.completedTaskCount || 0),
        totalAwardNpr: Number(payload?.totalAwardNpr || 0),
      };
    }

    const handlerResult = await client.query(
      `
        SELECT uid, username, cash_box_npr, raw_firestore_data
        FROM public.user_balance_snapshots_cache
        WHERE firebase_id = $1 AND deleted_at IS NULL
        FOR UPDATE
      `,
      [input.actorUid]
    );
    const handlerSnapshot = (handlerResult.rows[0] as Record<string, unknown>) || null;
    let runningCashBoxNpr = readCashBoxNpr(handlerSnapshot);
    let completedTaskCount = 0;
    let totalAwardNpr = 0;
    const nowIso = new Date().toISOString();

    for (const taskId of taskIds) {
      const task = await loadTaskForUpdate(client, taskId);
      if (!task) continue;
      const status = sanitizeStatus(task.status);
      if (status === 'completed') continue;
      if (status !== 'in_progress' || (task.assigned_carer_uid && task.assigned_carer_uid !== input.actorUid)) {
        throw new Error('Start the task first so it moves to In Progress before completion.');
      }

      const rewardAmountNpr = calculateUsernameRewardNpr();
      const cashBoxBefore = runningCashBoxNpr;
      const cashBoxAfter = cashBoxBefore + rewardAmountNpr;
      const rawPatch = {
        status: 'completed',
        expiresAt: null,
        completedAt: nowIso,
        ttlExpiresAt: ttlAfterDaysIso(30),
        automationStatus: 'completed',
        automationUpdatedAt: nowIso,
        isPoked: false,
        pokeMessage: null,
        pokedAt: null,
        completedByCarerUid: input.actorUid,
        completedByCarerUsername: input.actorUsername || 'Carer',
        rewardAmountNpr,
        rewardReason: 'username_task_completion',
        cashBoxBefore,
        cashBoxAfter,
        cashBoxDelta: cashBoxAfter - cashBoxBefore,
        actorUid: input.actorUid,
        actorRole: input.actorRole,
        sourceTaskId: taskId,
        updatedAt: nowIso,
      };
      await patchCarerTaskInTxn(client, taskId, rawPatch, 'authority_complete_username');
      console.info('[TASK_COMPLETED]', {
        taskId,
        completedAt: nowIso,
        completedBy: input.actorUid,
        taskType: cleanText(task.type),
      });
      console.info('[TASK_LIFECYCLE_DURATION]', {
        taskId,
        createToClaimMs: durationBetweenMs(task.created_at, task.claimed_at),
        claimToStartMs: durationBetweenMs(task.claimed_at, task.started_at),
        startToCompleteMs: durationBetweenMs(task.started_at, nowIso),
        totalMs: durationBetweenMs(task.created_at, nowIso),
      });
      const linkedJobId = cleanText(task.automation_job_id);
      if (linkedJobId) {
        const jobs = await loadJobsForTask(client, taskId, [linkedJobId]);
        for (const job of jobs) {
          if (job.job_id !== linkedJobId) continue;
          await upsertAutomationJobInTxn(client, job.job_id, {
            ...(job.raw_firestore_data || {}),
            status: 'completed',
            completedAt: nowIso,
            updatedAt: nowIso,
            ttlExpiresAt: ttlAfterDaysIso(AUTOMATION_JOB_TTL_DAYS),
          });
          await writeJobOutboxInTxn(client, {
            coadminUid,
            carerUid: input.actorUid,
            jobId: job.job_id,
            taskId,
            status: 'completed',
            updatedAt: nowIso,
            eventType: 'job.completed',
          });
        }
      }
      await writeTaskOutboxInTxn(client, {
        coadminUid,
        carerUid: input.actorUid,
        taskId,
        status: 'completed',
        type: cleanText(task.type),
        gameName,
        updatedAt: nowIso,
        eventType: 'task.completed',
      });
      console.info('[AUTO_TASK_COMPLETED]', {
        taskId,
        player: cleanText(task.player_uid) || null,
        automationUser: input.actorUid,
        claimTime: toIsoString(task.claimed_at),
        completionTime: nowIso,
      });
      console.info('[TASK_OUTBOX_EMITTED]', {
        taskId,
        phase: 'complete',
        flowName: 'carer_task_complete_username',
        rowCount: 1,
        eventType: 'task.completed',
      });
      if (rewardAmountNpr > 0) {
        await insertAuthorityLedgerEvent(client, {
          eventKey: `task_complete:${taskId}:${input.actorUid}:cashBoxNpr:handler_reward`,
          userUid: input.actorUid,
          username: input.actorUsername || 'Carer',
          role: input.actorRole,
          coadminUid,
          balanceType: 'cashBoxNpr',
          direction: 'credit',
          delta: rewardAmountNpr,
          absoluteAfter: cashBoxAfter,
          eventType: 'username_task_handler_cashbox_credit',
          sourceCollection: 'carerTasks',
          sourceId: taskId,
          actorUid: input.actorUid,
          actorRole: input.actorRole,
          confidence: 'high',
          sourceCreatedAt: nowIso,
          rawSourceData: { rewardNpr: rewardAmountNpr, taskId },
          sourceFields: { rewardNpr: rewardAmountNpr, taskId },
        });
      }
      completedTaskCount += 1;
      totalAwardNpr += rewardAmountNpr;
      runningCashBoxNpr = cashBoxAfter;
    }

    if (completedTaskCount > 0 && handlerSnapshot) {
      await updatePlayerBalancesInTxn(client, input.actorUid, { cashBoxNpr: runningCashBoxNpr });
    }

    await client.query(`UPDATE public.authority_operations SET payload = $2::jsonb WHERE operation_key = $1`, [
      operationKey,
      JSON.stringify({ completedTaskCount, totalAwardNpr }),
    ]);
    await client.query('COMMIT');
    return { success: true as const, duplicate: false, completedTaskCount, totalAwardNpr };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
