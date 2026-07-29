import 'server-only';

import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';

import { normalizeGameName } from '@/lib/sql/authorityGameRequestHelpers';
import {
  claimAuthorityOperation,
} from '@/lib/sql/authorityLedger';
import { returnTaskToPendingInSql } from '@/lib/sql/authorityCarerTasks';
import {
  buildFakeRedeemPlayerMessage,
  completeRechargeRedeemTaskInSql,
  dismissRechargeRequestInSql,
  dismissRedeemRequestInSql,
  FAKE_REDEEM_REASON_CODE,
  PLAYER_IN_GAME_MESSAGE,
  PLAYER_IN_GAME_RECHARGE_MESSAGE,
  PLAYER_IN_GAME_REDEEM_MESSAGE,
  PLAYER_IN_GAME_REASON_CODE,
} from '@/lib/sql/authorityGameRequests';
import { ttlAfterDaysIso } from '@/lib/sql/authorityGameRequestHelpers';
import { lookupAutomationAutoStateFromSqlCache } from '@/lib/sql/automationAutoStateCache';
import { lookupGameLoginDetailsForCoadminGameFromSql } from '@/lib/sql/gameLoginsCache';
import {
  carerJobLiveChannel,
  carerTaskLiveChannel,
  coadminJobLiveChannel,
  coadminTaskLiveChannel,
  insertLiveOutboxEventWithClient,
  playerRequestLiveChannel,
} from '@/lib/sql/liveOutbox';
import { lookupApiUserProfileFromSqlCache } from '@/lib/sql/playersCache';
import { cleanText, getPlayerMirrorPool, toIsoString } from '@/lib/sql/playerMirrorCommon';

const AUTOMATION_JOB_TTL_DAYS = 14;
const COMPLETED_CARER_TASK_TTL_DAYS = 90;
const RUNNING_JOB_STALE_MS = 10 * 60 * 1000;
const QUEUED_JOB_STALE_MS = 30 * 60 * 1000;
const GAME_VAULT_MIDNIGHT_PARTY_REASON = 'game_vault_midnight_party_pending';

function buildMidnightPartyPlayerMessage(gameToast: string, refunded: boolean) {
  const toast = cleanText(gameToast);
  const base = toast
    ? `Recharge could not be completed: ${toast}`
    : 'Recharge could not be completed: Midnight Party is pending on Game Vault.';
  return refunded ? `${base} Your balance was refunded.` : base;
}

function normalizeKnownFinalGameFailureReason(message: unknown, details?: Record<string, unknown> | null) {
  const detail = details || {};
  const reasonCode = cleanText(
    detail.reasonCode ||
      detail.dismissReasonCode ||
      detail.reason ||
      detail.failureCode
  );
  if (reasonCode.toUpperCase() === PLAYER_IN_GAME_REASON_CODE || reasonCode === 'GAME_RECHARGE_REDEEM_FAILED_IN_GAME') {
    return PLAYER_IN_GAME_REASON_CODE;
  }
  if (reasonCode === GAME_VAULT_MIDNIGHT_PARTY_REASON) {
    return GAME_VAULT_MIDNIGHT_PARTY_REASON;
  }
  const text = [
    cleanText(message),
    cleanText(detail.message),
    cleanText(detail.toast),
    cleanText(detail.toastText),
    cleanText(detail.banner),
    cleanText(detail.warningText),
    cleanText(detail.error),
    cleanText(detail.errorMessage),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replaceAll('in-game', 'in game');
  if (text.includes('midnight party')) {
    return GAME_VAULT_MIDNIGHT_PARTY_REASON;
  }
  if (
    text.includes('recharge or redeem failed in game') ||
    text.includes('failed in game') ||
    text.includes('player is in game') ||
    text.includes('player is currently in game') ||
    text.includes('user is playing') ||
    text.includes('currently in game') ||
    (text.includes('in game') &&
      (text.includes('recharge') || text.includes('redeem') || text.includes('failed') || text.includes('cannot')))
  ) {
    return PLAYER_IN_GAME_REASON_CODE;
  }
  return '';
}

function readJobPayloadValue(job: SqlJobRow, key: string) {
  const payload = parseJson(job.payload);
  const raw = parseJson(job.raw_firestore_data);
  return payload[key] ?? raw[key];
}

function readPlayerInGameLogFields(job: SqlJobRow, task?: Record<string, unknown> | null) {
  const game =
    cleanText(task?.gameName) ||
    cleanText(readJobPayloadValue(job, 'gameName')) ||
    cleanText(readJobPayloadValue(job, 'game')) ||
    cleanText(job.game);
  const username =
    cleanText(task?.playerUsername) ||
    cleanText(readJobPayloadValue(job, 'currentUsername')) ||
    cleanText(readJobPayloadValue(job, 'gameAccountUsername')) ||
    cleanText(readJobPayloadValue(job, 'username')) ||
    cleanText(readJobPayloadValue(job, 'playerUsername'));
  const taskType =
    cleanText(job.type).toUpperCase() ||
    cleanText(readJobPayloadValue(job, 'taskType')).toUpperCase();
  return { game, username, taskType };
}

type SqlJobRow = Record<string, unknown>;
type SqlTaskRow = Record<string, unknown>;

function parseJson(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

function rowToJob(row: SqlJobRow) {
  const payload = parseJson(row.payload);
  const raw = parseJson(row.raw_firestore_data);
  const jobId = cleanText(row.job_id);
  return {
    ...raw,
    id: jobId,
    jobId,
    taskId: cleanText(row.task_id) || cleanText(raw.taskId),
    status: cleanText(row.status) || cleanText(raw.status),
    claimedStatus: cleanText(row.claimed_status) || cleanText(raw.claimedStatus),
    carerUid: cleanText(row.carer_uid) || cleanText(raw.carerUid),
    agentId: cleanText(row.agent_id) || cleanText(raw.agentId),
    coadminUid: cleanText(row.coadmin_uid) || cleanText(raw.coadminUid),
    playerUid: cleanText(row.player_uid) || cleanText(raw.playerUid),
    type: cleanText(row.type) || cleanText(raw.type),
    game: cleanText(row.game) || cleanText(raw.game),
    gameName: cleanText(row.game) || cleanText(raw.gameName),
    payload,
    result: parseJson(row.result),
    error: cleanText(row.error_message) || cleanText(raw.error),
    attempts: Number(row.attempts || raw.attempts || 0),
    createdAt: toIsoString(row.created_at) || cleanText(raw.createdAt),
    updatedAt: toIsoString(row.updated_at) || cleanText(raw.updatedAt),
    startedAt: toIsoString(row.started_at) || cleanText(raw.startedAt),
    completedAt: toIsoString(row.completed_at) || cleanText(raw.completedAt),
    lastHeartbeatAt: toIsoString(row.last_heartbeat_at) || cleanText(raw.lastHeartbeatAt),
    createdByName: cleanText(row.created_by_name) || cleanText(raw.createdByName),
  };
}

function rowToTask(row: SqlTaskRow) {
  const raw = parseJson(row.raw_firestore_data);
  return {
    id: cleanText(row.firebase_id),
    taskId: cleanText(row.firebase_id),
    playerUid: cleanText(row.player_uid),
    playerUsername: cleanText(row.player_username),
    gameName: cleanText(row.game_name),
    amount: row.amount,
    requestId: cleanText(row.request_id),
    status: cleanText(row.status),
    coadminUid: cleanText(row.coadmin_uid),
    assignedCarerUid: cleanText(row.assigned_carer_uid),
    assignedCarerUsername: cleanText(row.assigned_carer_username),
    claimedByUid: cleanText(row.claimed_by_uid),
    automationStatus: cleanText(row.automation_status),
    automationJobId: cleanText(row.automation_job_id),
    ...raw,
  };
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
  }
) {
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
    source: 'authority_agent',
  };
  const eventType = cleanText(input.eventType) || 'job.upserted';
  await insertLiveOutboxEventWithClient(client, {
    channel: coadminJobLiveChannel(input.coadminUid),
    eventType,
    entityType: 'automation_job',
    entityId: input.jobId,
    source: 'authority_agent_jobs',
    mirroredAt: input.updatedAt,
    payload,
  });
  await insertLiveOutboxEventWithClient(client, {
    channel: carerJobLiveChannel(input.carerUid),
    eventType,
    entityType: 'automation_job',
    entityId: input.jobId,
    source: 'authority_agent_jobs',
    mirroredAt: input.updatedAt,
    payload,
  });
  console.info('[SQL_OUTBOX_EVENT_INSERTED] entityType=automation_job jobId=%s eventType=%s', input.jobId, eventType);
}

async function writePlayerGameLoginOutboxInTxn(
  client: PoolClient,
  input: {
    playerUid: string;
    coadminUid: string;
    loginId: string;
    gameName: string;
    gameUsername: string;
    taskId?: string | null;
    jobId?: string | null;
    updatedAt: string;
    eventType?: string;
    updateReason?: string | null;
    pokeMessage?: string | null;
  }
) {
  const payload = {
    entityId: input.loginId,
    loginId: input.loginId,
    playerUid: input.playerUid,
    coadminUid: input.coadminUid,
    gameName: input.gameName,
    gameUsername: input.gameUsername,
    taskId: cleanText(input.taskId) || null,
    jobId: cleanText(input.jobId) || null,
    updateReason: cleanText(input.updateReason) || null,
    pokeMessage: cleanText(input.pokeMessage) || null,
    updatedAt: input.updatedAt,
    source: 'authority_agent',
  };
  const eventType = cleanText(input.eventType) || 'player_game_login.updated';
  await insertLiveOutboxEventWithClient(client, {
    channel: playerRequestLiveChannel(input.playerUid),
    eventType,
    entityType: 'player_game_login',
    entityId: input.loginId,
    source: 'authority_agent_jobs',
    mirroredAt: input.updatedAt,
    payload,
  });
  await insertLiveOutboxEventWithClient(client, {
    channel: coadminTaskLiveChannel(input.coadminUid),
    eventType,
    entityType: 'player_game_login',
    entityId: input.loginId,
    source: 'authority_agent_jobs',
    mirroredAt: input.updatedAt,
    payload,
  });
  console.info('[LIVE_OUTBOX_INSERT_PLAYER_GAME_LOGIN_UPDATED]', {
    loginId: input.loginId,
    playerUid: input.playerUid,
    coadminUid: input.coadminUid,
    gameName: input.gameName,
    eventType,
  });
}

async function writeTaskOutboxInTxn(
  client: PoolClient,
  input: {
    coadminUid: string;
    carerUid: string;
    taskId: string;
    status: string;
    type?: string;
    gameName?: string;
    requestId?: string | null;
    updatedAt: string;
    eventType?: string;
  }
) {
  const payload = {
    entityId: input.taskId,
    taskId: input.taskId,
    coadminUid: input.coadminUid,
    carerUid: input.carerUid,
    status: input.status,
    type: cleanText(input.type),
    gameName: cleanText(input.gameName),
    requestId: cleanText(input.requestId) || null,
    updatedAt: input.updatedAt,
    source: 'authority_agent',
  };
  const eventType = cleanText(input.eventType) || 'task.upserted';
  await insertLiveOutboxEventWithClient(client, {
    channel: coadminTaskLiveChannel(input.coadminUid),
    eventType,
    entityType: 'carer_task',
    entityId: input.taskId,
    source: 'authority_agent_jobs',
    mirroredAt: input.updatedAt,
    payload,
  });
  await insertLiveOutboxEventWithClient(client, {
    channel: carerTaskLiveChannel(input.carerUid),
    eventType,
    entityType: 'carer_task',
    entityId: input.taskId,
    source: 'authority_agent_jobs',
    mirroredAt: input.updatedAt,
    payload,
  });
  console.info('[SQL_OUTBOX_EVENT_INSERTED] entityType=carer_task taskId=%s eventType=%s', input.taskId, eventType);
}

async function patchAutomationJobInTxn(
  client: PoolClient,
  jobId: string,
  patch: Record<string, unknown>
) {
  const nowIso = cleanText(patch.updatedAt) || new Date().toISOString();
  const current = await client.query(
    `SELECT raw_firestore_data, payload, result FROM public.automation_jobs_cache WHERE job_id = $1 FOR UPDATE`,
    [jobId]
  );
  if (!current.rows.length) throw new Error('Automation job not found.');
  const row = current.rows[0] as Record<string, unknown>;
  const raw = { ...parseJson(row.raw_firestore_data), ...patch, updatedAt: nowIso };
  const payload = patch.payload ?? parseJson(row.payload);
  const result = patch.result ?? parseJson(row.result);
  await client.query(
    `
      UPDATE public.automation_jobs_cache SET
        task_id = COALESCE(NULLIF($2, ''), task_id),
        status = COALESCE(NULLIF($3, ''), status),
        claimed_status = COALESCE(NULLIF($4, ''), claimed_status),
        payload = $5::jsonb,
        result = $6::jsonb,
        error_message = COALESCE(NULLIF($7, ''), error_message),
        cancelled_reason = COALESCE(NULLIF($8, ''), cancelled_reason),
        needs_manual_review = COALESCE($9, needs_manual_review),
        partial_success = COALESCE($10, partial_success),
        attempts = COALESCE($11, attempts),
        updated_at = $12::timestamptz,
        started_at = COALESCE($13::timestamptz, started_at),
        completed_at = COALESCE($14::timestamptz, completed_at),
        failed_at = COALESCE($15::timestamptz, failed_at),
        last_heartbeat_at = COALESCE($16::timestamptz, last_heartbeat_at),
        ttl_expires_at = COALESCE($17::timestamptz, ttl_expires_at),
        raw_firestore_data = $18::jsonb,
        source = 'authority_agent_jobs',
        mirrored_at = now(),
        deleted_at = NULL
      WHERE job_id = $1
    `,
    [
      jobId,
      cleanText(patch.taskId),
      cleanText(patch.status),
      cleanText(patch.claimedStatus),
      JSON.stringify(payload || {}),
      JSON.stringify(result || null),
      cleanText(patch.error || patch.errorMessage),
      cleanText(patch.cancelledReason),
      patch.needsManualReview === undefined ? null : patch.needsManualReview === true,
      patch.partialSuccess === undefined ? null : patch.partialSuccess === true,
      patch.attempts === undefined ? null : Number(patch.attempts),
      nowIso,
      patch.startedAt ? toIsoString(patch.startedAt) : null,
      patch.completedAt ? toIsoString(patch.completedAt) : null,
      patch.failedAt ? toIsoString(patch.failedAt) : null,
      patch.lastHeartbeatAt ? toIsoString(patch.lastHeartbeatAt) : nowIso,
      patch.ttlExpiresAt ? toIsoString(patch.ttlExpiresAt) : null,
      JSON.stringify(raw),
    ]
  );
}

async function patchCarerTaskAgentInTxn(
  client: PoolClient,
  taskId: string,
  patch: Record<string, unknown>
) {
  const nowIso = cleanText(patch.updatedAt) || new Date().toISOString();
  const retryPendingProvided = patch.retryPending !== undefined;
  const retryPendingParam = retryPendingProvided ? patch.retryPending === true : null;
  console.info('[PATCH_CARER_TASK_AGENT_INPUT]', {
    taskId,
    status: cleanText(patch.status) || null,
    retryPending: retryPendingParam,
    retryPendingProvided,
  });
  const current = await client.query(
    `SELECT raw_firestore_data FROM public.carer_tasks_cache WHERE firebase_id = $1 FOR UPDATE`,
    [taskId]
  );
  if (!current.rows.length) throw new Error('Task not found.');
  const raw = { ...parseJson(current.rows[0]?.raw_firestore_data), ...patch, updatedAt: nowIso };
  console.info('[PATCH_CARER_TASK_AGENT_SQL_START]', { taskId });
  try {
    await client.query(
      `
        UPDATE public.carer_tasks_cache SET
          status = COALESCE(NULLIF($2::text, ''), status),
          claimed_status = COALESCE(NULLIF($3::text, ''), claimed_status),
          claimed_by_uid = COALESCE(NULLIF($4::text, ''), claimed_by_uid),
          claimed_by_username = COALESCE(NULLIF($5::text, ''), claimed_by_username),
          automation_status = COALESCE(NULLIF($6::text, ''), automation_status),
          automation_job_id = COALESCE(NULLIF($7::text, ''), automation_job_id),
          automation_error = $8::text,
          assigned_carer_uid = COALESCE(NULLIF($9::text, ''), assigned_carer_uid),
          assigned_carer_username = COALESCE(NULLIF($10::text, ''), assigned_carer_username),
          completed_by_carer_uid = COALESCE(NULLIF($11::text, ''), completed_by_carer_uid),
          completed_by_carer_username = COALESCE(NULLIF($12::text, ''), completed_by_carer_username),
          amount = COALESCE($13::numeric, amount),
          updated_at = $14::timestamptz,
          started_at = COALESCE($15::timestamptz, started_at),
          completed_at = COALESCE($16::timestamptz, completed_at),
          claimed_at = COALESCE($17::timestamptz, claimed_at),
          last_heartbeat_at = COALESCE($18::timestamptz, last_heartbeat_at),
          ttl_expires_at = COALESCE($19::timestamptz, ttl_expires_at),
          retry_pending = CASE
            WHEN COALESCE(NULLIF($2::text, ''), status) = 'completed' THEN FALSE
            ELSE COALESCE($21::boolean, retry_pending)
          END,
          returned_to_pending_at = CASE
            WHEN COALESCE(NULLIF($2::text, ''), status) = 'completed' THEN NULL
            ELSE returned_to_pending_at
          END,
          raw_firestore_data = $20::jsonb,
          source = 'authority_agent_jobs',
          mirrored_at = now(),
          deleted_at = NULL
        WHERE firebase_id = $1
      `,
      [
        taskId,
        cleanText(patch.status),
        cleanText(patch.claimedStatus),
        cleanText(patch.claimedByUid),
        cleanText(patch.claimedByUsername),
        cleanText(patch.automationStatus),
        cleanText(patch.automationJobId),
        patch.automationError === undefined ? null : cleanText(patch.automationError) || null,
        cleanText(patch.assignedCarerUid),
        cleanText(patch.assignedCarerUsername),
        cleanText(patch.completedByCarerUid),
        cleanText(patch.completedByCarerUsername),
        patch.amount === undefined ? null : Number(patch.amount),
        nowIso,
        patch.startedAt === undefined ? null : patch.startedAt ? toIsoString(patch.startedAt) : null,
        patch.completedAt === undefined ? null : patch.completedAt ? toIsoString(patch.completedAt) : null,
        patch.claimedAt === undefined ? null : patch.claimedAt ? toIsoString(patch.claimedAt) : null,
        patch.lastHeartbeatAt ? toIsoString(patch.lastHeartbeatAt) : nowIso,
        patch.ttlExpiresAt ? toIsoString(patch.ttlExpiresAt) : null,
        JSON.stringify(raw),
        retryPendingParam,
      ]
    );
    console.info('[PATCH_CARER_TASK_AGENT_SQL_SUCCESS]', { taskId });
  } catch (error) {
    console.error('[PATCH_CARER_TASK_AGENT_SQL_ERROR]', {
      taskId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function listQueuedAutomationJobsForAgent(input: {
  carerUid: string;
  agentId: string;
  limit?: number;
}) {
  const db = getPlayerMirrorPool();
  if (!db) throw new Error('SQL pool unavailable.');
  const carerUid = cleanText(input.carerUid);
  const agentId = cleanText(input.agentId);
  const limit = Math.max(1, Math.min(200, Number(input.limit || 100)));
  const result = await db.query(
    `
      SELECT *
      FROM public.automation_jobs_cache
      WHERE deleted_at IS NULL
        AND carer_uid = $1
        AND agent_id = $2
        AND status = 'queued'
      ORDER BY created_at ASC NULLS LAST
      LIMIT $3
    `,
    [carerUid, agentId, limit]
  );
  return result.rows.map((row) => rowToJob(row as SqlJobRow));
}

export async function claimQueuedAutomationJobForAgent(input: {
  carerUid: string;
  agentId: string;
  jobId: string;
  carerName?: string | null;
}) {
  const carerUid = cleanText(input.carerUid);
  const agentId = cleanText(input.agentId);
  const jobId = cleanText(input.jobId);
  const carerName = cleanText(input.carerName) || 'Carer';
  if (!carerUid || !agentId || !jobId) throw new Error('carerUid, agentId, and jobId are required.');

  console.info('[SQL_JOB_CLAIM_ATTEMPT] jobId=%s carerUid=%s agentId=%s', jobId, carerUid, agentId);

  const db = getPlayerMirrorPool();
  if (!db) throw new Error('SQL pool unavailable.');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const jobResult = await client.query(
      `
        SELECT *
        FROM public.automation_jobs_cache
        WHERE job_id = $1 AND deleted_at IS NULL
        FOR UPDATE
      `,
      [jobId]
    );
    if (!jobResult.rows.length) {
      await client.query('ROLLBACK');
      console.info('[SQL_JOB_CLAIM_ATTEMPT] skipped reason=missing jobId=%s', jobId);
      return null;
    }
    const job = jobResult.rows[0] as SqlJobRow;
    if (cleanText(job.status) !== 'queued') {
      await client.query('ROLLBACK');
      console.info('[SQL_JOB_CLAIM_ATTEMPT] skipped reason=status_not_queued jobId=%s status=%s', jobId, job.status);
      return null;
    }
    if (cleanText(job.carer_uid) !== carerUid || cleanText(job.agent_id) !== agentId) {
      await client.query('ROLLBACK');
      console.info('[SQL_JOB_CLAIM_ATTEMPT] skipped reason=identity_mismatch jobId=%s', jobId);
      return null;
    }
    if (job.started_at) {
      await client.query('ROLLBACK');
      console.info('[SQL_JOB_CLAIM_ATTEMPT] skipped reason=started_at_present jobId=%s', jobId);
      return null;
    }
    const taskId = cleanText(job.task_id);
    if (taskId) {
      const dup = await client.query(
        `
          SELECT job_id
          FROM public.automation_jobs_cache
          WHERE deleted_at IS NULL
            AND task_id = $1
            AND carer_uid = $2
            AND agent_id = $3
            AND status = 'running'
            AND job_id <> $4
          LIMIT 1
        `,
        [taskId, carerUid, agentId, jobId]
      );
      if (dup.rows.length) {
        await client.query('ROLLBACK');
        console.info('[SQL_JOB_CLAIM_ATTEMPT] skipped reason=duplicate_running jobId=%s taskId=%s', jobId, taskId);
        return null;
      }
      const taskResult = await client.query(
        `SELECT firebase_id FROM public.carer_tasks_cache WHERE firebase_id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [taskId]
      );
      if (!taskResult.rows.length) {
        const nowIso = new Date().toISOString();
        await patchAutomationJobInTxn(client, jobId, {
          status: 'cancelled',
          claimedStatus: 'cancelled',
          completedAt: nowIso,
          cancelledReason: 'missing_task_doc',
          error: 'missing_task_doc',
          updatedAt: nowIso,
          ttlExpiresAt: ttlAfterDaysIso(AUTOMATION_JOB_TTL_DAYS),
        });
        await client.query('COMMIT');
        return null;
      }
    }

    const nowIso = new Date().toISOString();
    const attempts = Number(job.attempts || 0) + 1;
    await patchAutomationJobInTxn(client, jobId, {
      status: 'running',
      claimedStatus: 'running',
      startedAt: nowIso,
      lastHeartbeatAt: nowIso,
      updatedAt: nowIso,
      attempts,
      error: null,
      agentId,
    });
    if (taskId) {
      await patchCarerTaskAgentInTxn(client, taskId, {
        claimedStatus: 'running',
        claimedByUid: carerUid,
        claimedByUsername: carerName,
        claimedAt: nowIso,
        lastHeartbeatAt: nowIso,
        automationStatus: 'running',
        automationJobId: jobId,
        automationError: null,
        updatedAt: nowIso,
      });
    }
    const coadminUid = cleanText(job.coadmin_uid);
    if (coadminUid && taskId) {
      await writeTaskOutboxInTxn(client, {
        coadminUid,
        carerUid,
        taskId,
        status: 'in_progress',
        type: cleanText(job.type),
        gameName: cleanText(job.game),
        updatedAt: nowIso,
        eventType: 'task.claimed',
      });
      await writeJobOutboxInTxn(client, {
        coadminUid,
        carerUid,
        jobId,
        taskId,
        status: 'running',
        type: cleanText(job.type),
        gameName: cleanText(job.game),
        updatedAt: nowIso,
        eventType: 'job.claimed',
      });
    }
    await client.query('COMMIT');
    const claimed = rowToJob({ ...job, status: 'running', claimed_status: 'running', started_at: nowIso, attempts });
    console.info('[SQL_JOB_CLAIMED] jobId=%s taskId=%s', jobId, taskId || '-');
    console.info('[SQL_JOB_PAYLOAD] jobId=%s type=%s game=%s', jobId, claimed.type, claimed.game);
    console.info('[SQL_FIREBASE_BYPASS_CONFIRMED] operation=claim jobId=%s', jobId);
    return claimed;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function heartbeatAutomationJobForAgent(input: {
  carerUid: string;
  agentId: string;
  jobId: string;
  taskId?: string | null;
}) {
  const db = getPlayerMirrorPool();
  if (!db) throw new Error('SQL pool unavailable.');
  const nowIso = new Date().toISOString();
  const jobId = cleanText(input.jobId);
  const taskId = cleanText(input.taskId);
  await db.query(
    `
      UPDATE public.automation_jobs_cache
      SET last_heartbeat_at = $2::timestamptz, updated_at = $2::timestamptz, mirrored_at = now()
      WHERE job_id = $1 AND carer_uid = $3 AND agent_id = $4 AND deleted_at IS NULL
    `,
    [jobId, nowIso, cleanText(input.carerUid), cleanText(input.agentId)]
  );
  if (taskId) {
    await db.query(
      `
        UPDATE public.carer_tasks_cache
        SET last_heartbeat_at = $2::timestamptz, updated_at = $2::timestamptz, mirrored_at = now()
        WHERE firebase_id = $1 AND deleted_at IS NULL
      `,
      [taskId, nowIso]
    );
  }
}

async function finalizeAutomationJobCompletedInTxn(
  client: PoolClient,
  input: {
    jobId: string;
    carerUid: string;
    taskId: string;
    coadminUid: string;
    jobType: string;
    gameName: string;
    result?: Record<string, unknown>;
    requestId?: string | null;
  }
) {
  const nowIso = new Date().toISOString();
  const result = {
    success: true,
    jobId: input.jobId,
    ...(input.result || {}),
  };
  await patchAutomationJobInTxn(client, input.jobId, {
    status: 'completed',
    claimedStatus: 'completed',
    completedAt: nowIso,
    lastHeartbeatAt: nowIso,
    updatedAt: nowIso,
    ttlExpiresAt: ttlAfterDaysIso(AUTOMATION_JOB_TTL_DAYS),
    error: null,
    result,
  });
  await writeJobOutboxInTxn(client, {
    coadminUid: input.coadminUid,
    carerUid: input.carerUid,
    jobId: input.jobId,
    taskId: input.taskId,
    status: 'completed',
    type: input.jobType,
    gameName: input.gameName,
    requestId: input.requestId,
    updatedAt: nowIso,
    eventType: 'job.completed',
  });
}

export async function agentCompleteRechargeRedeemJob(input: {
  carerUid: string;
  agentId: string;
  jobId: string;
  taskId: string;
  actorUsername?: string | null;
  scopeUid?: string | null;
  evidence?: Record<string, unknown> | null;
}) {
  console.info('[AGENT_JOBS_API_COMPLETE_ATTEMPT]', {
    jobId: input.jobId,
    taskId: input.taskId,
    carerUid: input.carerUid,
    agentId: input.agentId,
  });
  console.info('[SQL_JOB_COMPLETE_START] action=complete_recharge_redeem jobId=%s taskId=%s', input.jobId, input.taskId);
  const idempotencyKey = `agent:${cleanText(input.jobId)}`;
  const completeResult = await completeRechargeRedeemTaskInSql({
    taskId: input.taskId,
    actorUid: input.carerUid,
    actorUsername: input.actorUsername,
    actorRole: 'carer',
    isAdmin: false,
    scopeUid: cleanText(input.scopeUid) || null,
    idempotencyKey,
  });

  const db = getPlayerMirrorPool();
  if (!db) throw new Error('SQL pool unavailable.');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const jobRow = await client.query(
      `SELECT * FROM public.automation_jobs_cache WHERE job_id = $1 FOR UPDATE`,
      [input.jobId]
    );
    if (!jobRow.rows.length) throw new Error('Automation job not found.');
    const job = jobRow.rows[0] as SqlJobRow;
    const taskId = cleanText(job.task_id) || input.taskId;
    const coadminUid = cleanText(job.coadmin_uid) || cleanText(input.scopeUid);
    await finalizeAutomationJobCompletedInTxn(client, {
      jobId: input.jobId,
      carerUid: input.carerUid,
      taskId,
      coadminUid,
      jobType: cleanText(job.type),
      gameName: cleanText(job.game),
      requestId: completeResult.requestId,
      result: {
        success: true,
        duplicate: completeResult.duplicate,
        alreadyCompleted: completeResult.alreadyCompleted,
        requestId: completeResult.requestId,
        evidence: input.evidence || {},
      },
    });
    await client.query('COMMIT');
    console.info('[SQL_JOB_COMPLETED]', {
      jobId: input.jobId,
      taskId,
      requestId: completeResult.requestId,
      carerUid: input.carerUid,
    });
    console.info('[SQL_JOB_COMPLETE_SUCCESS] action=complete_recharge_redeem jobId=%s taskId=%s', input.jobId, taskId);
    console.info('[SQL_FIREBASE_BYPASS_CONFIRMED] operation=complete_recharge_redeem jobId=%s', input.jobId);
    console.info('[TASK_COMPLETION]', {
      jobId: input.jobId,
      taskId,
      requestId: completeResult.requestId,
      alreadyCompleted: completeResult.alreadyCompleted,
      duplicate: completeResult.duplicate,
    });
    return { ...completeResult, success: true as const };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[SQL_JOB_COMPLETE_FAILED] action=complete_recharge_redeem jobId=%s error=%s', input.jobId, error);
    throw error;
  } finally {
    client.release();
  }
}

async function upsertPlayerGameLoginInTxn(
  client: PoolClient,
  input: {
    loginId: string;
    playerUid: string;
    playerUsername?: string | null;
    coadminUid: string;
    gameName: string;
    gameUsername: string;
    gamePassword: string;
    siteUrl?: string | null;
    frontendUrl?: string | null;
    jobId: string;
    carerUid: string;
  }
) {
  const nowIso = new Date().toISOString();
  const normalizedGameName = normalizeGameName(input.gameName);
  const raw = {
    playerUid: input.playerUid,
    coadminUid: input.coadminUid,
    gameName: input.gameName,
    gameUsername: input.gameUsername,
    gamePassword: input.gamePassword,
    currentUsername: input.gameUsername,
    currentPassword: input.gamePassword,
    siteUrl: input.siteUrl || null,
    frontendUrl: input.frontendUrl || null,
    updatedByAutomationJobId: input.jobId,
    updatedByCarerUid: input.carerUid,
    updatedAt: nowIso,
  };
  await client.query(
    `
      INSERT INTO public.player_game_logins_cache (
        firebase_id, player_uid, player_username, game_name, normalized_game_name,
        game_username, game_password, game_account_username, game_account_password,
        current_username, current_password, frontend_url, site_url, coadmin_uid,
        created_by, updated_by_automation_job_id, updated_by_carer_uid,
        created_at, updated_at, source, mirrored_at, deleted_at, raw_firestore_data
      )
      VALUES (
        $1::text, $2::text, NULLIF($3::text, ''), $4::text, $5::text,
        $6::text, $7::text, $6::text, $7::text, $6::text, $7::text,
        NULLIF($8::text, ''), NULLIF($9::text, ''), $10::text, $10::text,
        $11::text, $12::text,
        $13::timestamptz, $13::timestamptz, 'authority_agent_jobs', now(), NULL, $14::jsonb
      )
      ON CONFLICT (firebase_id) DO UPDATE SET
        game_username = EXCLUDED.game_username,
        game_password = EXCLUDED.game_password,
        game_account_username = EXCLUDED.game_account_username,
        game_account_password = EXCLUDED.game_account_password,
        current_username = EXCLUDED.current_username,
        current_password = EXCLUDED.current_password,
        frontend_url = EXCLUDED.frontend_url,
        site_url = EXCLUDED.site_url,
        updated_by_automation_job_id = EXCLUDED.updated_by_automation_job_id,
        updated_by_carer_uid = EXCLUDED.updated_by_carer_uid,
        updated_at = EXCLUDED.updated_at,
        raw_firestore_data = EXCLUDED.raw_firestore_data,
        mirrored_at = now(),
        deleted_at = NULL
    `,
    [
      input.loginId,
      input.playerUid,
      cleanText(input.playerUsername),
      input.gameName,
      normalizedGameName,
      input.gameUsername,
      input.gamePassword,
      cleanText(input.siteUrl),
      cleanText(input.frontendUrl),
      input.coadminUid,
      input.jobId,
      input.carerUid,
      nowIso,
      JSON.stringify(raw),
    ]
  );
}

export async function agentCompleteUsernameJob(input: {
  carerUid: string;
  agentId: string;
  jobId: string;
  taskId: string;
  evidence?: Record<string, unknown> | null;
  actorUsername?: string | null;
}) {
  console.info('[CREATE_USERNAME_COMPLETION_START]', {
    jobId: input.jobId,
    taskId: input.taskId,
    carerUid: input.carerUid,
  });
  console.info('[SQL_JOB_COMPLETE_START] action=complete_username jobId=%s taskId=%s', input.jobId, input.taskId);
  const evidence = input.evidence || {};
  const payloadUsername = cleanText(
    evidence.createdUsername || evidence.username || evidence.gameAccountUsername
  );
  const payloadPassword = cleanText(
    evidence.createdPassword || evidence.gamePassword || evidence.newPassword || evidence.password
  );
  const siteUrl = cleanText(evidence.siteUrl);
  const frontendUrl = cleanText(evidence.frontendUrl);
  console.info('[CREATE_USERNAME_RESULT_RETURNED]', {
    jobId: input.jobId,
    taskId: input.taskId,
    usernamePresent: Boolean(payloadUsername),
    passwordPresent: Boolean(payloadPassword),
    evidenceKeys: Object.keys(evidence),
  });

  const db = getPlayerMirrorPool();
  if (!db) throw new Error('SQL pool unavailable.');
  const client = await db.connect();
  const operationKey = `agent_username_complete:${input.jobId}`;
  try {
    await client.query('BEGIN');
    const op = await claimAuthorityOperation(client, {
      operationKey,
      operationType: 'agent_username_complete',
      userUid: input.carerUid,
      sourceId: input.jobId,
      actorUid: input.carerUid,
      actorRole: 'carer',
      payload: {},
    });
    if (!op.claimed && op.duplicate) {
      await client.query('COMMIT');
      return { success: true as const, duplicate: true };
    }

    const taskResult = await client.query(
      `SELECT * FROM public.carer_tasks_cache WHERE firebase_id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [input.taskId]
    );
    if (!taskResult.rows.length) throw new Error('Task not found.');
    const task = taskResult.rows[0] as SqlTaskRow;
    const playerUid = cleanText(task.player_uid);
    const coadminUid = cleanText(task.coadmin_uid);
    const gameName = cleanText(task.game_name);
    const createdUsername = payloadUsername || cleanText(task.player_username);
    const createdPassword = payloadPassword;
    if (!playerUid || !coadminUid || !gameName || !createdUsername || !createdPassword) {
      throw new Error('Missing username completion fields.');
    }

    const loginId = `${playerUid}__${normalizeGameName(gameName)}`;
    console.info('[GAME_LOGIN_AUTHORITY_UPSERT_START]', {
      jobId: input.jobId,
      taskId: input.taskId,
      playerUid,
      coadminUid,
      gameName,
      loginId,
    });
    await upsertPlayerGameLoginInTxn(client, {
      loginId,
      playerUid,
      playerUsername: cleanText(task.player_username),
      coadminUid,
      gameName,
      gameUsername: createdUsername,
      gamePassword: createdPassword,
      siteUrl,
      frontendUrl,
      jobId: input.jobId,
      carerUid: input.carerUid,
    });
    console.info('[GAME_LOGIN_AUTHORITY_UPSERT_DONE]', {
      jobId: input.jobId,
      taskId: input.taskId,
      playerUid,
      gameName,
      loginId,
      gameUsername: createdUsername,
    });

    const nowIso = new Date().toISOString();
    const completedBy = cleanText(input.actorUsername) || cleanText(task.assigned_carer_username) || 'Carer';
    await patchCarerTaskAgentInTxn(client, input.taskId, {
      status: 'completed',
      claimedStatus: 'completed',
      completedByCarerUid: input.carerUid,
      completedByCarerUsername: completedBy,
      automationStatus: 'completed',
      automationCompleted: true,
      automationCompletedAt: nowIso,
      automationError: null,
      completedAt: nowIso,
      ttlExpiresAt: ttlAfterDaysIso(COMPLETED_CARER_TASK_TTL_DAYS),
      retryPending: false,
      updatedAt: nowIso,
    });
    await finalizeAutomationJobCompletedInTxn(client, {
      jobId: input.jobId,
      carerUid: input.carerUid,
      taskId: input.taskId,
      coadminUid,
      jobType: 'CREATE_USERNAME',
      gameName,
      requestId: cleanText(task.request_id),
      result: { success: true, createdUsername, createdPassword: createdPassword, evidence },
    });
    await writeTaskOutboxInTxn(client, {
      coadminUid,
      carerUid: input.carerUid,
      taskId: input.taskId,
      status: 'completed',
      type: 'create_username',
      gameName,
      requestId: cleanText(task.request_id),
      updatedAt: nowIso,
      eventType: 'task.completed',
    });
    console.info('[LIVE_OUTBOX_INSERT_CREATE_USERNAME_COMPLETED]', {
      taskId: input.taskId,
      jobId: input.jobId,
      playerUid,
      gameName,
    });
    await writePlayerGameLoginOutboxInTxn(client, {
      playerUid,
      coadminUid,
      loginId,
      gameName,
      gameUsername: createdUsername,
      taskId: input.taskId,
      jobId: input.jobId,
      updatedAt: nowIso,
      updateReason: 'create_username',
      pokeMessage: 'Your game account has been created.',
    });
    await insertLiveOutboxEventWithClient(client, {
      channel: playerRequestLiveChannel(playerUid),
      eventType: 'player_message',
      entityType: 'carer_task',
      entityId: input.taskId,
      source: 'authority_agent_jobs',
      mirroredAt: nowIso,
      payload: {
        entityId: input.taskId,
        playerUid,
        taskId: input.taskId,
        type: 'create_username',
        status: 'completed',
        gameName,
        pokeMessage: 'Your game account has been created.',
        updatedAt: nowIso,
        source: 'authority',
      },
    });
    console.info('[LIVE_OUTBOX_INSERT_PLAYER_MESSAGE]', {
      taskId: input.taskId,
      jobId: input.jobId,
      playerUid,
      message: 'Your game account has been created.',
    });
    await client.query('COMMIT');
    console.info('[SQL_JOB_COMPLETE_SUCCESS] action=complete_username jobId=%s', input.jobId);
    console.info('[SQL_FIREBASE_BYPASS_CONFIRMED] operation=complete_username jobId=%s', input.jobId);
    return { success: true as const, duplicate: false, loginId };
  } catch (error) {
    await client.query('ROLLBACK');
    const message = error instanceof Error ? error.message : String(error);
    console.info('[CREATE_USERNAME_COMPLETION_EXCEPTION]', {
      jobId: input.jobId,
      taskId: input.taskId,
      error: message,
    });
    console.info('[CREATE_USERNAME_RETURN_TO_PENDING_CAUSE]', {
      jobId: input.jobId,
      taskId: input.taskId,
      error: message,
    });
    console.error('[SQL_JOB_COMPLETE_FAILED] action=complete_username jobId=%s error=%s', input.jobId, error);
    throw error;
  } finally {
    client.release();
  }
}

export async function agentCompleteResetPasswordJob(input: {
  carerUid: string;
  agentId: string;
  jobId: string;
  taskId: string;
  evidence?: Record<string, unknown> | null;
  actorUsername?: string | null;
}) {
  console.info('[AUTHORITY_RESET_PASSWORD_COMPLETE_START]', {
    jobId: input.jobId,
    taskId: input.taskId,
    carerUid: input.carerUid,
  });
  console.info('[SQL_JOB_COMPLETE_START] action=complete_reset_password jobId=%s taskId=%s', input.jobId, input.taskId);
  const evidence = input.evidence || {};
  const newPassword = cleanText(evidence.createdPassword || evidence.gamePassword || evidence.newPassword);
  const gameAccountUsername = cleanText(
    evidence.createdUsername || evidence.username || evidence.targetUsername || evidence.gameAccountUsername
  );
  console.info('[RESET_PASSWORD_JOB_PAYLOAD_RECEIVED]', {
    jobId: input.jobId,
    taskId: input.taskId,
    passwordPresent: Boolean(newPassword),
    passwordLength: newPassword.length,
    gameAccountUsername: gameAccountUsername || null,
    evidenceKeys: Object.keys(evidence),
  });

  const db = getPlayerMirrorPool();
  if (!db) throw new Error('SQL pool unavailable.');
  const client = await db.connect();
  const operationKey = `agent_reset_password_complete:${input.jobId}`;
  try {
    await client.query('BEGIN');
    const op = await claimAuthorityOperation(client, {
      operationKey,
      operationType: 'agent_reset_password_complete',
      userUid: input.carerUid,
      sourceId: input.jobId,
      actorUid: input.carerUid,
      actorRole: 'carer',
      payload: {},
    });
    if (!op.claimed && op.duplicate) {
      await client.query('COMMIT');
      return { success: true as const, duplicate: true };
    }

    const taskResult = await client.query(
      `SELECT * FROM public.carer_tasks_cache WHERE firebase_id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [input.taskId]
    );
    if (!taskResult.rows.length) throw new Error('Task not found.');
    const task = taskResult.rows[0] as SqlTaskRow;
    const playerUid = cleanText(task.player_uid);
    const coadminUid = cleanText(task.coadmin_uid);
    const gameName = cleanText(task.game_name);
    if (!playerUid || !coadminUid || !gameName || !newPassword) {
      throw new Error('Missing reset password completion fields.');
    }

    const loginLookup = await client.query(
      `
        SELECT firebase_id, game_username, game_account_username
        FROM public.player_game_logins_cache
        WHERE player_uid = $1 AND coadmin_uid = $2 AND normalized_game_name = $3 AND deleted_at IS NULL
        ORDER BY updated_at DESC NULLS LAST
        LIMIT 1
      `,
      [playerUid, coadminUid, normalizeGameName(gameName)]
    );
    const loginId =
      cleanText(loginLookup.rows[0]?.firebase_id) ||
      `${playerUid}__${normalizeGameName(gameName)}`;
    const resolvedUsername =
      gameAccountUsername ||
      cleanText(loginLookup.rows[0]?.game_account_username) ||
      cleanText(loginLookup.rows[0]?.game_username);
    if (!resolvedUsername) throw new Error('Game account username missing for reset password completion.');

    console.info('[AUTHORITY_RESET_PASSWORD_LOGIN_UPDATE_START]', {
      jobId: input.jobId,
      taskId: input.taskId,
      loginId,
      playerUid,
      gameName,
      gameAccountUsername: resolvedUsername,
    });
    await upsertPlayerGameLoginInTxn(client, {
      loginId,
      playerUid,
      playerUsername: cleanText(task.player_username),
      coadminUid,
      gameName,
      gameUsername: resolvedUsername,
      gamePassword: newPassword,
      siteUrl: cleanText(evidence.siteUrl),
      frontendUrl: cleanText(evidence.frontendUrl),
      jobId: input.jobId,
      carerUid: input.carerUid,
    });
    console.info('[AUTHORITY_RESET_PASSWORD_LOGIN_UPDATE_DONE]', {
      jobId: input.jobId,
      taskId: input.taskId,
      loginId,
      playerUid,
      gameName,
    });

    const nowIso = new Date().toISOString();
    const completedBy = cleanText(input.actorUsername) || cleanText(task.assigned_carer_username) || 'Carer';
    await patchCarerTaskAgentInTxn(client, input.taskId, {
      status: 'completed',
      claimedStatus: 'completed',
      completedByCarerUid: input.carerUid,
      completedByCarerUsername: completedBy,
      automationStatus: 'completed',
      automationCompleted: true,
      automationCompletedAt: nowIso,
      automationError: null,
      completedAt: nowIso,
      ttlExpiresAt: ttlAfterDaysIso(COMPLETED_CARER_TASK_TTL_DAYS),
      updatedAt: nowIso,
    });
    await finalizeAutomationJobCompletedInTxn(client, {
      jobId: input.jobId,
      carerUid: input.carerUid,
      taskId: input.taskId,
      coadminUid,
      jobType: 'RESET_PASSWORD',
      gameName,
      requestId: cleanText(task.request_id),
      result: { success: true, evidence: { ...evidence, gameAccountUsername: resolvedUsername } },
    });
    await writeTaskOutboxInTxn(client, {
      coadminUid,
      carerUid: input.carerUid,
      taskId: input.taskId,
      status: 'completed',
      type: 'reset_password',
      gameName,
      requestId: cleanText(task.request_id),
      updatedAt: nowIso,
      eventType: 'task.completed',
    });
    console.info('[LIVE_OUTBOX_INSERT_RESET_PASSWORD_COMPLETED]', {
      taskId: input.taskId,
      jobId: input.jobId,
      playerUid,
      gameName,
    });
    await writePlayerGameLoginOutboxInTxn(client, {
      playerUid,
      coadminUid,
      loginId,
      gameName,
      gameUsername: resolvedUsername,
      taskId: input.taskId,
      jobId: input.jobId,
      updatedAt: nowIso,
      updateReason: 'reset_password',
      pokeMessage: 'Your game password has been reset successfully.',
    });
    await insertLiveOutboxEventWithClient(client, {
      channel: playerRequestLiveChannel(playerUid),
      eventType: 'player_message',
      entityType: 'player_credential_task',
      entityId: input.taskId,
      source: 'authority_agent_jobs',
      mirroredAt: nowIso,
      payload: {
        entityId: input.taskId,
        playerUid,
        taskId: input.taskId,
        type: 'reset_password',
        status: 'completed',
        gameName,
        pokeMessage: 'Your game password has been reset successfully.',
        updatedAt: nowIso,
        source: 'authority',
      },
    });
    console.info('[AUTHORITY_RESET_PASSWORD_TASK_COMPLETED]', {
      taskId: input.taskId,
      jobId: input.jobId,
      playerUid,
    });
    console.info('[AUTHORITY_RESET_PASSWORD_JOB_COMPLETED]', {
      taskId: input.taskId,
      jobId: input.jobId,
    });
    await client.query('COMMIT');
    console.info('[SQL_JOB_COMPLETE_SUCCESS] action=complete_reset_password jobId=%s', input.jobId);
    console.info('[SQL_FIREBASE_BYPASS_CONFIRMED] operation=complete_reset_password jobId=%s', input.jobId);
    return { success: true as const, duplicate: false, loginId };
  } catch (error) {
    await client.query('ROLLBACK');
    const message = error instanceof Error ? error.message : String(error);
    console.info('[RESET_PASSWORD_COMPLETION_EXCEPTION]', {
      jobId: input.jobId,
      taskId: input.taskId,
      error: message,
    });
    console.error('[SQL_JOB_COMPLETE_FAILED] action=complete_reset_password jobId=%s error=%s', input.jobId, error);
    throw error;
  } finally {
    client.release();
  }
}

export async function agentFailJobReturnPending(input: {
  carerUid: string;
  agentId: string;
  jobId: string;
  reason: string;
  details?: Record<string, unknown> | null;
}) {
  const knownFinalReason = normalizeKnownFinalGameFailureReason(input.reason, input.details);
  if (knownFinalReason) {
    console.info('[KNOWN_GAME_FAILURE_NO_PENDING_RELEASE] taskId/jobId=%s', input.jobId);
    if (knownFinalReason === GAME_VAULT_MIDNIGHT_PARTY_REASON) {
      return agentDismissMidnightPartyBlockedRecharge({
        carerUid: input.carerUid,
        agentId: input.agentId,
        jobId: input.jobId,
        reason: cleanText(input.reason) || 'Game Vault Midnight Party pending.',
        details: input.details,
      });
    }
    return agentDismissPlayerInGame({
      carerUid: input.carerUid,
      agentId: input.agentId,
      jobId: input.jobId,
      reason: PLAYER_IN_GAME_MESSAGE,
      details: {
        ...(input.details || {}),
        reasonCode: knownFinalReason,
        originalFailureReason: input.reason,
      },
    });
  }
  const db = getPlayerMirrorPool();
  if (!db) throw new Error('SQL pool unavailable.');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const jobResult = await client.query(
      `SELECT * FROM public.automation_jobs_cache WHERE job_id = $1 FOR UPDATE`,
      [input.jobId]
    );
    if (!jobResult.rows.length) {
      await client.query('COMMIT');
      return { success: true as const, skipped: true };
    }
    const job = jobResult.rows[0] as SqlJobRow;
    const status = cleanText(job.status).toLowerCase();
    if (status === 'completed' || status === 'cancelled') {
      await client.query('COMMIT');
      return { success: true as const, skipped: true };
    }
    const taskId = cleanText(job.task_id);
    const nowIso = new Date().toISOString();
    await patchAutomationJobInTxn(client, input.jobId, {
      status: 'failed',
      completedAt: nowIso,
      failedAt: nowIso,
      updatedAt: nowIso,
      lastHeartbeatAt: nowIso,
      ttlExpiresAt: ttlAfterDaysIso(AUTOMATION_JOB_TTL_DAYS),
      error: input.reason,
      result: input.details || {},
      needsManualReview: false,
    });
    await client.query('COMMIT');
    if (taskId) {
      await returnTaskToPendingInSql({
        taskId,
        actorUid: input.carerUid,
        actorRole: 'carer',
        isAdmin: false,
        scopeUid: cleanText(job.coadmin_uid) || null,
        idempotencyKey: `agent_fail:${input.jobId}`,
      });
      console.info('[AUTO_TASK_FAILED]', {
        taskId,
        player: cleanText(job.player_uid) || null,
        automationUser: input.carerUid,
        failureReason: input.reason,
        completionTime: new Date().toISOString(),
        jobId: input.jobId,
        source: 'fail_return_pending',
      });
      console.info('[AUTO_TASK_RELEASED]', {
        taskId,
        player: cleanText(job.player_uid) || null,
        automationUser: input.carerUid,
        completionTime: new Date().toISOString(),
        jobId: input.jobId,
        source: 'fail_return_pending',
      });
      console.info('[AUTO_NEXT_TASK]', {
        status: 'released_for_reclaim',
        taskId,
        automationUser: input.carerUid,
        jobId: input.jobId,
      });
    }
    console.info('[SQL_FIREBASE_BYPASS_CONFIRMED] operation=fail_return_pending jobId=%s', input.jobId);
    return { success: true as const, skipped: false, taskId };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function agentMarkJobPendingReview(input: {
  carerUid: string;
  agentId: string;
  jobId: string;
  reason: string;
  details?: Record<string, unknown> | null;
}) {
  const db = getPlayerMirrorPool();
  if (!db) throw new Error('SQL pool unavailable.');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const jobResult = await client.query(
      `SELECT * FROM public.automation_jobs_cache WHERE job_id = $1 FOR UPDATE`,
      [input.jobId]
    );
    if (!jobResult.rows.length) {
      await client.query('COMMIT');
      return { success: true as const };
    }
    const job = jobResult.rows[0] as SqlJobRow;
    const taskId = cleanText(job.task_id);
    const coadminUid = cleanText(job.coadmin_uid);
    const nowIso = new Date().toISOString();
    await patchAutomationJobInTxn(client, input.jobId, {
      status: 'pending_review',
      claimedStatus: 'pending_review',
      needsManualReview: true,
      partialSuccess: Boolean(input.details?.partial_success || input.details?.partialSuccess),
      updatedAt: nowIso,
      lastHeartbeatAt: nowIso,
      error: input.reason,
      result: { success: false, reason: input.reason, ...(input.details || {}) },
    });
    if (taskId) {
      await patchCarerTaskAgentInTxn(client, taskId, {
        automationStatus: 'pending_review',
        automationError: input.reason,
        updatedAt: nowIso,
      });
      if (coadminUid) {
        await writeTaskOutboxInTxn(client, {
          coadminUid,
          carerUid: input.carerUid,
          taskId,
          status: 'in_progress',
          type: cleanText(job.type),
          gameName: cleanText(job.game),
          updatedAt: nowIso,
          eventType: 'task.pending_review',
        });
      }
    }
    await client.query('COMMIT');
    console.info('[SQL_FIREBASE_BYPASS_CONFIRMED] operation=pending_review jobId=%s', input.jobId);
    return { success: true as const };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function agentDismissMidnightPartyBlockedRecharge(input: {
  carerUid: string;
  agentId: string;
  jobId: string;
  reason: string;
  details?: Record<string, unknown> | null;
  scopeUid?: string | null;
}) {
  const db = getPlayerMirrorPool();
  if (!db) throw new Error('SQL pool unavailable.');
  const details = input.details || {};
  const gameToast = cleanText(input.reason) || cleanText(details.message) || '';
  const reasonCode = GAME_VAULT_MIDNIGHT_PARTY_REASON;
  const authorityStartedAt = Date.now();
  console.info('[AGENT_JOBS_API_DISMISS_ATTEMPT]', {
    jobId: input.jobId,
    reasonCode,
    gameToast: gameToast || null,
  });
  console.info('[AUTHORITY_RECHARGE_DISMISS_REFUND_START]', {
    jobId: input.jobId,
    reasonCode,
  });

  const client = await db.connect();
  let taskId = '';
  let requestId = '';
  let coadminUid = '';
  let playerUid = '';
  let dismissOutcome: Awaited<ReturnType<typeof dismissRechargeRequestInSql>> | null = null;
  try {
    await client.query('BEGIN');
    const jobResult = await client.query(
      `SELECT * FROM public.automation_jobs_cache WHERE job_id = $1 FOR UPDATE`,
      [input.jobId]
    );
    if (!jobResult.rows.length) {
      await client.query('COMMIT');
      console.info('[AUTHORITY_RECHARGE_DISMISS_REFUND_DONE]', {
        jobId: input.jobId,
        skipped: true,
        reason: 'job_not_found',
        durationMs: Date.now() - authorityStartedAt,
      });
      return { success: true as const, skipped: true };
    }
    const job = jobResult.rows[0] as SqlJobRow;
    taskId = cleanText(job.task_id);
    coadminUid = cleanText(job.coadmin_uid);
    playerUid = cleanText(job.player_uid);
    if (taskId) {
      const taskRow = await client.query(
        `SELECT request_id, player_uid FROM public.carer_tasks_cache WHERE firebase_id = $1 FOR UPDATE`,
        [taskId]
      );
      if (taskRow.rows.length) {
        requestId = cleanText(taskRow.rows[0]?.request_id);
        playerUid = playerUid || cleanText(taskRow.rows[0]?.player_uid);
      }
    }
    if (!requestId && taskId.startsWith('request__')) {
      requestId = taskId.slice('request__'.length);
    }

    if (requestId) {
      dismissOutcome = await dismissRechargeRequestInSql({
        requestId,
        actorUid: input.carerUid,
        actorRole: 'carer',
        isAdmin: false,
        scopeUid: cleanText(input.scopeUid) || coadminUid || null,
        idempotencyKey: `agent_midnight_party:${input.jobId}`,
        dismissType: reasonCode,
        dismissReasonCode: reasonCode,
        dismissReasonMessage: gameToast || reasonCode,
        dismissedByAutomation: true,
        skipTaskTombstone: true,
        txnClient: client,
      });
    }

    const playerMessage = buildMidnightPartyPlayerMessage(gameToast, dismissOutcome?.refunded === true);
    const nowIso = new Date().toISOString();
    const resultDetails = {
      success: true,
      dismissed: true,
      status: 'dismissed',
      reason: reasonCode,
      reasonCode,
      message: gameToast,
      playerMessage,
      retryPending: false,
      nonRetryable: true,
      refund: dismissOutcome?.refunded === true,
      requestId: requestId || null,
      ...details,
    };
    await patchAutomationJobInTxn(client, input.jobId, {
      status: 'completed',
      claimedStatus: 'completed',
      completedAt: nowIso,
      updatedAt: nowIso,
      lastHeartbeatAt: nowIso,
      ttlExpiresAt: ttlAfterDaysIso(AUTOMATION_JOB_TTL_DAYS),
      error: null,
      needsManualReview: false,
      result: resultDetails,
    });
    if (taskId) {
      await patchCarerTaskAgentInTxn(client, taskId, {
        status: 'completed',
        claimedStatus: 'completed',
        completedByCarerUid: input.carerUid,
        automationStatus: 'dismissed',
        automationError: gameToast || reasonCode,
        dismissedByAutomation: true,
        dismissType: reasonCode,
        dismissReasonCode: reasonCode,
        dismissReasonMessage: gameToast || reasonCode,
        dismissReason: gameToast || reasonCode,
        pokeMessage: playerMessage,
        retryPending: false,
        completedAt: nowIso,
        ttlExpiresAt: ttlAfterDaysIso(COMPLETED_CARER_TASK_TTL_DAYS),
        updatedAt: nowIso,
      });
      if (coadminUid) {
        await writeTaskOutboxInTxn(client, {
          coadminUid,
          carerUid: input.carerUid,
          taskId,
          status: 'completed',
          type: 'recharge',
          gameName: cleanText(job.game),
          updatedAt: nowIso,
          eventType: 'task.dismissed',
        });
        await writeJobOutboxInTxn(client, {
          coadminUid,
          carerUid: input.carerUid,
          jobId: input.jobId,
          taskId,
          status: 'completed',
          type: cleanText(job.type),
          gameName: cleanText(job.game),
          updatedAt: nowIso,
          eventType: 'job.dismissed',
        });
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[AUTHORITY_RECHARGE_DISMISS_REFUND_DONE]', {
      jobId: input.jobId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - authorityStartedAt,
    });
    throw error;
  } finally {
    client.release();
  }

  console.info('[AUTHORITY_RECHARGE_DISMISS_REFUND_DONE]', {
    jobId: input.jobId,
    requestId: requestId || null,
    ok: true,
    refunded: dismissOutcome?.refunded === true,
    duplicate: dismissOutcome?.duplicate === true,
    alreadyDismissed: dismissOutcome?.alreadyDismissed === true,
    durationMs: Date.now() - authorityStartedAt,
  });
  console.info('[PLAYER_RECHARGE_FAILURE_VISIBLE]', {
    requestId: requestId || null,
    playerUid: playerUid || null,
    reasonCode,
    playerMessage: buildMidnightPartyPlayerMessage(gameToast, dismissOutcome?.refunded === true),
  });
  console.info('[SQL_FIREBASE_BYPASS_CONFIRMED] operation=dismiss_midnight_party_blocked_recharge jobId=%s', input.jobId);
  return {
    success: true as const,
    requestId: requestId || null,
    refunded: dismissOutcome?.refunded === true,
    duplicate: dismissOutcome?.duplicate === true,
  };
}

export async function agentDismissPlayerInGame(input: {
  carerUid: string;
  agentId: string;
  jobId: string;
  reason: string;
  details?: Record<string, unknown> | null;
  scopeUid?: string | null;
}) {
  const db = getPlayerMirrorPool();
  if (!db) throw new Error('SQL pool unavailable.');
  const details = input.details || {};
  const reasonCode = PLAYER_IN_GAME_REASON_CODE;
  let playerMessage = PLAYER_IN_GAME_MESSAGE;
  const authorityStartedAt = Date.now();
  console.info('[AGENT_JOBS_API_DISMISS_ATTEMPT]', {
    jobId: input.jobId,
    reasonCode,
    message: playerMessage,
  });

  const client = await db.connect();
  let taskId = '';
  let requestId = '';
  let coadminUid = '';
  let playerUid = '';
  let requestType = '';
  let gameName = '';
  let username = '';
  let refundAmount = 0;
  let refunded = false;
  try {
    await client.query('BEGIN');
    const jobResult = await client.query(
      `SELECT * FROM public.automation_jobs_cache WHERE job_id = $1 FOR UPDATE`,
      [input.jobId]
    );
    if (!jobResult.rows.length) {
      await client.query('COMMIT');
      return { success: true as const, skipped: true };
    }
    const job = jobResult.rows[0] as SqlJobRow;
    taskId = cleanText(job.task_id);
    coadminUid = cleanText(job.coadmin_uid);
    playerUid = cleanText(job.player_uid);
    requestType = cleanText(job.type).toUpperCase();
    let task: Record<string, unknown> | null = null;
    if (taskId) {
      const taskRow = await client.query(
        `SELECT * FROM public.carer_tasks_cache WHERE firebase_id = $1 FOR UPDATE`,
        [taskId]
      );
      if (taskRow.rows.length) {
        task = rowToTask(taskRow.rows[0] as SqlTaskRow) as Record<string, unknown>;
        requestId = cleanText(task.requestId);
        playerUid = playerUid || cleanText(task.playerUid);
        coadminUid = coadminUid || cleanText(task.coadminUid);
      }
    }
    if (!requestId && taskId.startsWith('request__')) {
      requestId = taskId.slice('request__'.length);
    }
    const logFields = readPlayerInGameLogFields(job, task);
    gameName = logFields.game;
    username = logFields.username;
    requestType = requestType || logFields.taskType;
    console.info('[PLAYER_IN_GAME_TOAST_DETECTED] taskId=%s game=%s taskType=%s username=%s', taskId, gameName, requestType, username);
    console.info('[PLAYER_IN_GAME_DETECTED] game=%s username=%s taskType=%s', gameName, username, requestType);
    playerMessage =
      requestType === 'REDEEM'
        ? PLAYER_IN_GAME_REDEEM_MESSAGE
        : requestType === 'RECHARGE'
          ? PLAYER_IN_GAME_RECHARGE_MESSAGE
          : PLAYER_IN_GAME_MESSAGE;
    console.info(
      '[KNOWN_GAME_FAILURE_DETECTED] game=%s taskId/jobId=%s taskType=%s username=%s reason=%s toastText=%s',
      gameName,
      taskId || input.jobId,
      requestType,
      username,
      reasonCode,
      cleanText(input.reason || details.toastText || details.message) || playerMessage
    );

    if (requestId && requestType === 'RECHARGE') {
      const dismissOutcome = await dismissRechargeRequestInSql({
        requestId,
        actorUid: input.carerUid,
        actorRole: 'carer',
        isAdmin: false,
        scopeUid: cleanText(input.scopeUid) || coadminUid || null,
        idempotencyKey: `agent_player_in_game:${input.jobId}`,
        dismissType: reasonCode,
        dismissReasonCode: reasonCode,
        dismissReasonMessage: playerMessage,
        dismissedByAutomation: true,
        pokeMessage: playerMessage,
        skipTaskTombstone: true,
        txnClient: client,
      });
      refunded = dismissOutcome.refunded === true;
      refundAmount = Number(dismissOutcome.refundAmount || 0);
      console.info('[PLAYER_IN_GAME_RECHARGE_REFUND] amount=%s', refunded ? refundAmount : 0);
      console.info('[PLAYER_IN_GAME_REFUND_APPLIED] taskId=%s refundType=coin amount=%s', taskId, refunded ? refundAmount : 0);
      console.info('[KNOWN_GAME_FAILURE_REFUND_APPLIED] game=%s taskId/jobId=%s refundType=coin amount=%s', gameName, taskId || input.jobId, refunded ? refundAmount : 0);
    } else if (requestId && requestType === 'REDEEM') {
      const dismissOutcome = await dismissRedeemRequestInSql({
        requestId,
        actorUid: input.carerUid,
        actorRole: 'carer',
        isAdmin: false,
        scopeUid: cleanText(input.scopeUid) || coadminUid || null,
        idempotencyKey: `agent_player_in_game:${input.jobId}`,
        dismissType: reasonCode,
        dismissReasonCode: reasonCode,
        dismissReasonMessage: playerMessage,
        dismissedByAutomation: true,
        pokeMessage: playerMessage,
        refundCashOnDismissal: false,
        skipTaskTombstone: true,
        txnClient: client,
      });
      refunded = false;
      refundAmount = Number(dismissOutcome.refundAmount || 0);
    } else if (requestId) {
      throw new Error(`PLAYER_IN_GAME dismissal is not supported for ${requestType || 'unknown'} tasks.`);
    }

    const nowIso = new Date().toISOString();
    const resultDetails = {
      success: true,
      dismissed: true,
      status: 'dismissed',
      reason: reasonCode,
      reasonCode,
      requestType,
      message: playerMessage,
      playerMessage,
      dismissType: reasonCode,
      dismissReasonCode: reasonCode,
      dismissReasonMessage: playerMessage,
      refund: refunded,
      refundAmount: refunded ? refundAmount : 0,
      nonRetryable: true,
      retryPending: false,
      requestId: requestId || null,
      ...details,
    };
    await patchAutomationJobInTxn(client, input.jobId, {
      status: 'completed',
      claimedStatus: 'completed',
      completedAt: nowIso,
      updatedAt: nowIso,
      lastHeartbeatAt: nowIso,
      ttlExpiresAt: ttlAfterDaysIso(AUTOMATION_JOB_TTL_DAYS),
      error: null,
      needsManualReview: false,
      result: resultDetails,
    });
    if (taskId) {
      await patchCarerTaskAgentInTxn(client, taskId, {
        status: 'completed',
        claimedStatus: 'completed',
        completedByCarerUid: input.carerUid,
        automationStatus: 'dismissed',
        automationError: playerMessage,
        dismissType: reasonCode,
        dismissReasonCode: reasonCode,
        dismissReasonMessage: playerMessage,
        dismissReason: playerMessage,
        dismissedByAutomation: true,
        pokeMessage: playerMessage,
        retryPending: false,
        completedAt: nowIso,
        ttlExpiresAt: ttlAfterDaysIso(COMPLETED_CARER_TASK_TTL_DAYS),
        updatedAt: nowIso,
      });
      if (coadminUid) {
        await writeTaskOutboxInTxn(client, {
          coadminUid,
          carerUid: input.carerUid,
          taskId,
          status: 'completed',
          type: requestType.toLowerCase(),
          gameName,
          updatedAt: nowIso,
          eventType: 'task.dismissed',
        });
        await writeJobOutboxInTxn(client, {
          coadminUid,
          carerUid: input.carerUid,
          jobId: input.jobId,
          taskId,
          status: 'completed',
          type: requestType,
          gameName,
          updatedAt: nowIso,
          eventType: 'job.dismissed',
        });
      }
    }
    console.info('[PLAYER_IN_GAME_TASK_DISMISSED] taskId=%s reason=%s', taskId || null, reasonCode);
    console.info('[KNOWN_GAME_FAILURE_FINAL_DISMISS] game=%s taskId/jobId=%s reason=%s', gameName, taskId || input.jobId, reasonCode);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[PLAYER_IN_GAME_DISMISS_DONE]', {
      jobId: input.jobId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - authorityStartedAt,
    });
    throw error;
  } finally {
    client.release();
  }

  console.info('[PLAYER_IN_GAME_DISMISS_DONE]', {
    jobId: input.jobId,
    requestId: requestId || null,
    playerUid: playerUid || null,
    requestType: requestType || null,
    game: gameName || null,
    username: username || null,
    refunded,
    refundAmount: refunded ? refundAmount : 0,
    ok: true,
    durationMs: Date.now() - authorityStartedAt,
  });
  console.info('[SQL_FIREBASE_BYPASS_CONFIRMED] operation=dismiss_player_in_game jobId=%s', input.jobId);
  return {
    success: true as const,
    requestId: requestId || null,
    refunded,
    refundAmount: refunded ? refundAmount : 0,
  };
}

export async function agentMarkRedeemWaitingPlayerExit(input: {
  carerUid: string;
  agentId: string;
  jobId: string;
  reason: string;
  details?: Record<string, unknown> | null;
  scopeUid?: string | null;
}) {
  const db = getPlayerMirrorPool();
  if (!db) throw new Error('SQL pool unavailable.');
  const details = input.details || {};
  const playerMessage =
    cleanText(details.playerMessage) ||
    'Please exit the game first. Your redeem is waiting and will continue automatically.';
  const agentMessage =
    cleanText(input.reason) || cleanText(details.message) || 'Please exit the game to complete your redeem.';
  const client = await db.connect();
  let taskId = '';
  let requestId = '';
  let coadminUid = '';
  let playerUid = '';
  let gameName = '';
  try {
    await client.query('BEGIN');
    const jobResult = await client.query(
      `SELECT * FROM public.automation_jobs_cache WHERE job_id = $1 FOR UPDATE`,
      [input.jobId]
    );
    if (!jobResult.rows.length) {
      await client.query('COMMIT');
      return { success: true as const, skipped: true };
    }
    const job = jobResult.rows[0] as SqlJobRow;
    taskId = cleanText(job.task_id);
    coadminUid = cleanText(job.coadmin_uid);
    playerUid = cleanText(job.player_uid);
    gameName = cleanText(job.game);
    let task: Record<string, unknown> | null = null;
    if (taskId) {
      const taskRow = await client.query(
        `SELECT * FROM public.carer_tasks_cache WHERE firebase_id = $1 FOR UPDATE`,
        [taskId]
      );
      if (taskRow.rows.length) {
        task = rowToTask(taskRow.rows[0] as SqlTaskRow) as Record<string, unknown>;
        requestId = cleanText(task.requestId);
        playerUid = playerUid || cleanText(task.playerUid);
        coadminUid = coadminUid || cleanText(task.coadminUid);
        gameName = gameName || cleanText(task.gameName);
      }
    }
    if (!requestId && taskId.startsWith('request__')) {
      requestId = taskId.slice('request__'.length);
    }
    if (cleanText(job.type).toUpperCase() !== 'REDEEM') {
      throw new Error('PLAYER_ACTIVE_IN_GAME waiting state only applies to redeem jobs.');
    }
    if (!requestId) {
      throw new Error('Linked redeem request not found.');
    }

    const nowIso = new Date().toISOString();
    const requestRawPatch = {
      status: 'waiting_player_exit',
      automationStatus: 'PLAYER_ACTIVE_IN_GAME',
      playerMessage,
      pokeMessage: playerMessage,
      retryableFailure: true,
      retryPending: true,
      updatedAt: nowIso,
    };
    await client.query(
      `
        UPDATE public.player_game_requests_cache SET
          status = 'waiting_player_exit',
          automation_status = 'PLAYER_ACTIVE_IN_GAME',
          poke_message = $2,
          retry_pending = TRUE,
          retryable_failure = TRUE,
          updated_at = $3::timestamptz,
          raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb) || $4::jsonb,
          source = 'authority_agent_jobs',
          mirrored_at = now(),
          deleted_at = NULL
        WHERE firebase_id = $1
      `,
      [requestId, playerMessage, nowIso, JSON.stringify(requestRawPatch)]
    );

    const resultDetails = {
      success: false,
      status: 'waiting_player_exit',
      code: 'PLAYER_ACTIVE_IN_GAME',
      reasonCode: 'PLAYER_ACTIVE_IN_GAME',
      message: agentMessage,
      playerMessage,
      retryable: true,
      retryPending: true,
      refund: false,
      requestId,
      ...details,
    };
    await patchAutomationJobInTxn(client, input.jobId, {
      status: 'completed',
      claimedStatus: 'completed',
      completedAt: nowIso,
      updatedAt: nowIso,
      lastHeartbeatAt: nowIso,
      ttlExpiresAt: ttlAfterDaysIso(AUTOMATION_JOB_TTL_DAYS),
      error: null,
      needsManualReview: false,
      result: resultDetails,
    });
    if (taskId) {
      await patchCarerTaskAgentInTxn(client, taskId, {
        status: 'pending',
        claimedStatus: '',
        automationStatus: 'PLAYER_ACTIVE_IN_GAME',
        automationError: agentMessage,
        pokeMessage: playerMessage,
        retryPending: true,
        updatedAt: nowIso,
      });
      await client.query(
        `
          UPDATE public.carer_tasks_cache SET
            claimed_status = NULL,
            claimed_by_uid = NULL,
            claimed_by_username = NULL,
            automation_job_id = NULL,
            linked_job_id = NULL,
            raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb) || $2::jsonb
          WHERE firebase_id = $1
        `,
        [
          taskId,
          JSON.stringify({
            claimedStatus: null,
            claimedByUid: null,
            claimedByUsername: null,
            automationJobId: null,
            linkedJobId: null,
          }),
        ]
      );
      if (coadminUid) {
        await writeTaskOutboxInTxn(client, {
          coadminUid,
          carerUid: input.carerUid,
          taskId,
          status: 'pending',
          type: 'redeem',
          gameName,
          requestId,
          updatedAt: nowIso,
          eventType: 'task.waiting_player_exit',
        });
        await writeJobOutboxInTxn(client, {
          coadminUid,
          carerUid: input.carerUid,
          jobId: input.jobId,
          taskId,
          status: 'completed',
          type: 'REDEEM',
          gameName,
          requestId,
          updatedAt: nowIso,
          eventType: 'job.waiting_player_exit',
        });
      }
    }
    if (playerUid) {
      await insertLiveOutboxEventWithClient(client, {
        channel: playerRequestLiveChannel(playerUid),
        eventType: 'request.upserted',
        entityType: 'player_game_request',
        entityId: requestId,
        source: 'authority_agent_jobs',
        mirroredAt: nowIso,
        payload: {
          entityId: requestId,
          requestId,
          playerUid,
          gameName,
          type: 'redeem',
          status: 'waiting_player_exit',
          automationStatus: 'PLAYER_ACTIVE_IN_GAME',
          playerMessage,
          pokeMessage: playerMessage,
          updatedAt: nowIso,
          source: 'authority_agent',
        },
      });
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  console.info('[PLAYER_EXIT_REQUIRED_VISIBLE]', { requestId, playerUid, jobId: input.jobId });
  console.info('[SQL_FIREBASE_BYPASS_CONFIRMED] operation=mark_redeem_waiting_player_exit jobId=%s', input.jobId);
  return { success: true as const, requestId, playerUid };
}

export async function agentDismissFakeRedeem(input: {
  carerUid: string;
  agentId: string;
  jobId: string;
  reason: string;
  details?: Record<string, unknown> | null;
  scopeUid?: string | null;
}) {
  const db = getPlayerMirrorPool();
  if (!db) throw new Error('SQL pool unavailable.');
  const details = input.details || {};
  const reasonCode = FAKE_REDEEM_REASON_CODE;
  const requestedAmount = Number(
    details.requestedRedeemAmount ?? details.requestedAmount ?? details.amount ?? NaN
  );
  const playerBalance = Number(
    details.playerBalance ??
      details.orionBalance ??
      details.customerBalance ??
      details.mafiaBalance ??
      NaN
  );
  const dismissReasonMessage =
    cleanText(details.dismissReasonMessage) ||
    cleanText(details.reasonMessage) ||
    cleanText(details.message) ||
    cleanText(details.dismissReason) ||
    cleanText(input.reason) ||
    null;
  const playerMessage = buildFakeRedeemPlayerMessage({
    playerBalance: Number.isFinite(playerBalance) ? playerBalance : null,
    requestedAmount: Number.isFinite(requestedAmount) ? requestedAmount : null,
    rawMessage: dismissReasonMessage,
  });
  const authorityStartedAt = Date.now();
  console.info('[AGENT_JOBS_API_DISMISS_ATTEMPT]', {
    jobId: input.jobId,
    reasonCode,
    playerMessage,
  });

  const client = await db.connect();
  let taskId = '';
  let requestId = '';
  let coadminUid = '';
  let playerUid = '';
  try {
    await client.query('BEGIN');
    const jobResult = await client.query(
      `SELECT * FROM public.automation_jobs_cache WHERE job_id = $1 FOR UPDATE`,
      [input.jobId]
    );
    if (!jobResult.rows.length) {
      await client.query('COMMIT');
      return { success: true as const, skipped: true };
    }
    const job = jobResult.rows[0] as SqlJobRow;
    taskId = cleanText(job.task_id);
    coadminUid = cleanText(job.coadmin_uid);
    playerUid = cleanText(job.player_uid);
    if (taskId) {
      const taskRow = await client.query(
        `SELECT request_id, player_uid FROM public.carer_tasks_cache WHERE firebase_id = $1 FOR UPDATE`,
        [taskId]
      );
      if (taskRow.rows.length) {
        requestId = cleanText(taskRow.rows[0]?.request_id);
        playerUid = playerUid || cleanText(taskRow.rows[0]?.player_uid);
      }
    }
    if (!requestId && taskId.startsWith('request__')) {
      requestId = taskId.slice('request__'.length);
    }

    if (requestId) {
      await dismissRedeemRequestInSql({
        requestId,
        actorUid: input.carerUid,
        actorRole: 'carer',
        isAdmin: false,
        scopeUid: cleanText(input.scopeUid) || coadminUid || null,
        idempotencyKey: `agent_dismiss:${input.jobId}`,
        dismissType: reasonCode,
        dismissReasonCode: reasonCode,
        dismissReasonMessage,
        dismissedByAutomation: true,
        pokeMessage: playerMessage,
        fakeRedeem: true,
        skipTaskTombstone: true,
        txnClient: client,
      });
    }

    const nowIso = new Date().toISOString();
    const resultDetails = {
      success: true,
      dismissed: true,
      status: 'dismissed',
      reason: reasonCode,
      reasonCode,
      requestType: 'redeem',
      message: playerMessage,
      playerMessage,
      dismissType: reasonCode,
      dismissReasonCode: reasonCode,
      dismissReasonMessage,
      nonRetryable: true,
      retryPending: false,
      requestId: requestId || null,
      ...details,
    };
    await patchAutomationJobInTxn(client, input.jobId, {
      status: 'completed',
      claimedStatus: 'completed',
      completedAt: nowIso,
      updatedAt: nowIso,
      lastHeartbeatAt: nowIso,
      ttlExpiresAt: ttlAfterDaysIso(AUTOMATION_JOB_TTL_DAYS),
      error: null,
      needsManualReview: false,
      result: resultDetails,
    });
    if (taskId) {
      await patchCarerTaskAgentInTxn(client, taskId, {
        status: 'completed',
        claimedStatus: 'completed',
        completedByCarerUid: input.carerUid,
        automationStatus: 'dismissed',
        automationError: playerMessage,
        fakeRedeem: true,
        fakeRedeemReason: playerMessage,
        dismissType: reasonCode,
        dismissReasonCode: reasonCode,
        dismissReasonMessage,
        dismissReason: playerMessage,
        dismissedByAutomation: true,
        pokeMessage: playerMessage,
        retryPending: false,
        completedAt: nowIso,
        ttlExpiresAt: ttlAfterDaysIso(COMPLETED_CARER_TASK_TTL_DAYS),
        updatedAt: nowIso,
      });
      if (coadminUid) {
        await writeTaskOutboxInTxn(client, {
          coadminUid,
          carerUid: input.carerUid,
          taskId,
          status: 'completed',
          type: 'redeem',
          gameName: cleanText(job.game),
          updatedAt: nowIso,
          eventType: 'task.dismissed',
        });
        await writeJobOutboxInTxn(client, {
          coadminUid,
          carerUid: input.carerUid,
          jobId: input.jobId,
          taskId,
          status: 'completed',
          type: cleanText(job.type),
          gameName: cleanText(job.game),
          updatedAt: nowIso,
          eventType: 'job.dismissed',
        });
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[AUTHORITY_FAKE_REDEEM_DISMISS_DONE]', {
      jobId: input.jobId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - authorityStartedAt,
    });
    throw error;
  } finally {
    client.release();
  }

  console.info('[AUTHORITY_FAKE_REDEEM_DISMISS_DONE]', {
    jobId: input.jobId,
    requestId: requestId || null,
    playerUid: playerUid || null,
    ok: true,
    durationMs: Date.now() - authorityStartedAt,
  });
  console.info('[PLAYER_REQUEST_OUTCOME_MESSAGE_CREATED]', {
    jobId: input.jobId,
    requestId: requestId || null,
    playerUid: playerUid || null,
    reasonCode,
    playerMessage,
  });
  console.info('[SQL_FIREBASE_BYPASS_CONFIRMED] operation=dismiss_fake_redeem jobId=%s', input.jobId);
  return { success: true as const, requestId: requestId || null };
}

export async function agentUpdateJobStatus(input: {
  carerUid: string;
  agentId: string;
  jobId: string;
  status: string;
  result?: Record<string, unknown> | null;
  errorMessage?: string | null;
}) {
  const db = getPlayerMirrorPool();
  if (!db) throw new Error('SQL pool unavailable.');
  const nowIso = new Date().toISOString();
  const patch: Record<string, unknown> = {
    status: input.status,
    updatedAt: nowIso,
    lastHeartbeatAt: nowIso,
  };
  if (input.result) patch.result = input.result;
  if (input.errorMessage !== undefined) patch.error = input.errorMessage;
  if (input.status === 'completed') {
    patch.completedAt = nowIso;
    patch.ttlExpiresAt = ttlAfterDaysIso(AUTOMATION_JOB_TTL_DAYS);
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await patchAutomationJobInTxn(client, input.jobId, patch);
    await client.query('COMMIT');
    console.info('[SQL_FIREBASE_BYPASS_CONFIRMED] operation=update_status jobId=%s status=%s', input.jobId, input.status);
    return { success: true as const };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function agentRefreshRedeemAmount(input: {
  carerUid: string;
  agentId: string;
  jobId: string;
  amount: number;
}) {
  const db = getPlayerMirrorPool();
  if (!db) throw new Error('SQL pool unavailable.');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const jobResult = await client.query(
      `SELECT payload FROM public.automation_jobs_cache WHERE job_id = $1 FOR UPDATE`,
      [input.jobId]
    );
    if (!jobResult.rows.length) throw new Error('Job not found.');
    const payload = parseJson(jobResult.rows[0]?.payload);
    payload.amount = input.amount;
    payload.redeemAmount = input.amount;
    const originalTask = parseJson(payload.originalTask);
    if (Object.keys(originalTask).length) {
      originalTask.amount = input.amount;
      payload.originalTask = originalTask;
    }
    await patchAutomationJobInTxn(client, input.jobId, { payload, updatedAt: new Date().toISOString() });
    await client.query('COMMIT');
    console.info('[SQL_FIREBASE_BYPASS_CONFIRMED] operation=refresh_redeem_amount jobId=%s amount=%s', input.jobId, input.amount);
    return { success: true as const, payload };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function agentRecoverStaleJobs(input: { carerUid: string; agentId: string }) {
  const db = getPlayerMirrorPool();
  if (!db) throw new Error('SQL pool unavailable.');
  const result = await db.query(
    `
      SELECT job_id, task_id, coadmin_uid, last_heartbeat_at, updated_at, started_at, attempts
      FROM public.automation_jobs_cache
      WHERE deleted_at IS NULL
        AND carer_uid = $1
        AND agent_id = $2
        AND status = 'running'
    `,
    [cleanText(input.carerUid), cleanText(input.agentId)]
  );
  let recovered = 0;
  const now = Date.now();
  for (const row of result.rows) {
    const activity =
      Date.parse(String(row.last_heartbeat_at || row.updated_at || row.started_at || '')) || 0;
    if (!activity || now - activity < RUNNING_JOB_STALE_MS) continue;
    await agentFailJobReturnPending({
      carerUid: input.carerUid,
      agentId: input.agentId,
      jobId: cleanText(row.job_id),
      reason: 'stale_running_job_recovered',
      details: { attempts: Number(row.attempts || 0) },
    });
    recovered += 1;
  }
  return recovered;
}

export async function agentCleanupOldJobs(input: { carerUid: string; agentId: string; limit?: number }) {
  const db = getPlayerMirrorPool();
  if (!db) throw new Error('SQL pool unavailable.');
  const limit = Math.max(1, Math.min(100, Number(input.limit || 50)));
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const result = await db.query(
    `
      UPDATE public.automation_jobs_cache
      SET deleted_at = now(), source = 'authority_agent_cleanup', mirrored_at = now()
      WHERE job_id IN (
        SELECT job_id
        FROM public.automation_jobs_cache
        WHERE deleted_at IS NULL
          AND carer_uid = $1
          AND agent_id = $2
          AND status IN ('completed', 'failed', 'cancelled')
          AND COALESCE(completed_at, updated_at) < $3::timestamptz
        ORDER BY updated_at ASC
        LIMIT $4
      )
      RETURNING job_id
    `,
    [cleanText(input.carerUid), cleanText(input.agentId), cutoff, limit]
  );
  return result.rows.length;
}

export async function getCarerTaskFromSql(taskId: string) {
  const db = getPlayerMirrorPool();
  if (!db) return null;
  const result = await db.query(
    `SELECT * FROM public.carer_tasks_cache WHERE firebase_id = $1 AND deleted_at IS NULL LIMIT 1`,
    [cleanText(taskId)]
  );
  if (!result.rows.length) return null;
  return rowToTask(result.rows[0] as SqlTaskRow);
}

export async function getAutomationJobFromSql(jobId: string) {
  const db = getPlayerMirrorPool();
  if (!db) return null;
  const result = await db.query(
    `SELECT * FROM public.automation_jobs_cache WHERE job_id = $1 AND deleted_at IS NULL LIMIT 1`,
    [cleanText(jobId)]
  );
  if (!result.rows.length) return null;
  return rowToJob(result.rows[0] as SqlJobRow);
}

export async function getGameLoginDetailsForAgent(coadminUid: string, gameName: string) {
  const lookup = await lookupGameLoginDetailsForCoadminGameFromSql(coadminUid, gameName);
  return lookup.details;
}

export async function getAutomationAutoStateForAgent(carerUid: string) {
  const lookup = await lookupAutomationAutoStateFromSqlCache(carerUid);
  if (!lookup.state) return { enabled: false, coadminUid: null as string | null };
  return {
    enabled: lookup.state.enabled,
    coadminUid: lookup.state.coadminUid,
  };
}

export async function verifyAgentLinkedToCarerInSql(carerUid: string, agentId: string) {
  const lookup = await lookupApiUserProfileFromSqlCache(carerUid);
  if (!lookup.profile) throw new Error(`Carer user not found in SQL cache for CARER_UID=${carerUid}.`);
  const linked = cleanText(lookup.profile.automationAgentId);
  if (linked !== cleanText(agentId)) throw new Error('Agent ID is not linked to this carer');
}

export type AgentJobActionInput = {
  action: string;
  carerUid: string;
  agentId: string;
  jobId?: string;
  taskId?: string;
  reason?: string;
  details?: Record<string, unknown>;
  evidence?: Record<string, unknown>;
  status?: string;
  result?: Record<string, unknown>;
  errorMessage?: string;
  amount?: number;
  scopeUid?: string;
  actorUsername?: string;
  carerName?: string;
  limit?: number;
};

export async function runAgentJobAction(input: AgentJobActionInput) {
  const action = cleanText(input.action).toLowerCase();
  const actionStartedAt = Date.now();
  console.info('[AGENT_JOBS_API_ACTION_START]', {
    action: action || null,
    jobId: cleanText(input.jobId) || null,
    carerUid: cleanText(input.carerUid) || null,
  });
  try {
  switch (action) {
    case 'claim':
      return claimQueuedAutomationJobForAgent({
        carerUid: input.carerUid,
        agentId: input.agentId,
        jobId: cleanText(input.jobId),
        carerName: input.carerName,
      });
    case 'heartbeat':
      await heartbeatAutomationJobForAgent({
        carerUid: input.carerUid,
        agentId: input.agentId,
        jobId: cleanText(input.jobId),
        taskId: input.taskId,
      });
      return { success: true };
    case 'complete_recharge_redeem':
      return agentCompleteRechargeRedeemJob({
        carerUid: input.carerUid,
        agentId: input.agentId,
        jobId: cleanText(input.jobId),
        taskId: cleanText(input.taskId),
        actorUsername: input.actorUsername,
        scopeUid: input.scopeUid,
        evidence: input.evidence,
      });
    case 'complete_username':
      return agentCompleteUsernameJob({
        carerUid: input.carerUid,
        agentId: input.agentId,
        jobId: cleanText(input.jobId),
        taskId: cleanText(input.taskId),
        evidence: input.evidence,
        actorUsername: input.actorUsername,
      });
    case 'complete_reset_password':
      return agentCompleteResetPasswordJob({
        carerUid: input.carerUid,
        agentId: input.agentId,
        jobId: cleanText(input.jobId),
        taskId: cleanText(input.taskId),
        evidence: input.evidence,
        actorUsername: input.actorUsername,
      });
    case 'fail_return_pending':
      return agentFailJobReturnPending({
        carerUid: input.carerUid,
        agentId: input.agentId,
        jobId: cleanText(input.jobId),
        reason: cleanText(input.reason) || 'Automation failed.',
        details: input.details,
      });
    case 'pending_review':
      return agentMarkJobPendingReview({
        carerUid: input.carerUid,
        agentId: input.agentId,
        jobId: cleanText(input.jobId),
        reason: cleanText(input.reason) || 'Needs manual review.',
        details: input.details,
      });
    case 'dismiss_fake_redeem':
      return agentDismissFakeRedeem({
        carerUid: input.carerUid,
        agentId: input.agentId,
        jobId: cleanText(input.jobId),
        reason: cleanText(input.reason) || 'Fake redeem.',
        details: input.details,
        scopeUid: input.scopeUid,
      });
    case 'dismiss_midnight_party_blocked_recharge':
      return agentDismissMidnightPartyBlockedRecharge({
        carerUid: input.carerUid,
        agentId: input.agentId,
        jobId: cleanText(input.jobId),
        reason: cleanText(input.reason) || 'Game Vault Midnight Party pending.',
        details: input.details,
        scopeUid: input.scopeUid,
      });
    case 'dismiss_player_in_game':
      return agentDismissPlayerInGame({
        carerUid: input.carerUid,
        agentId: input.agentId,
        jobId: cleanText(input.jobId),
        reason: cleanText(input.reason) || PLAYER_IN_GAME_MESSAGE,
        details: input.details,
        scopeUid: input.scopeUid,
      });
    case 'mark_redeem_waiting_player_exit':
      return agentMarkRedeemWaitingPlayerExit({
        carerUid: input.carerUid,
        agentId: input.agentId,
        jobId: cleanText(input.jobId),
        reason: cleanText(input.reason) || 'Please exit the game to complete your redeem.',
        details: input.details,
        scopeUid: input.scopeUid,
      });
    case 'update_status':
      return agentUpdateJobStatus({
        carerUid: input.carerUid,
        agentId: input.agentId,
        jobId: cleanText(input.jobId),
        status: cleanText(input.status),
        result: input.result,
        errorMessage: input.errorMessage,
      });
    case 'refresh_redeem_amount':
      return agentRefreshRedeemAmount({
        carerUid: input.carerUid,
        agentId: input.agentId,
        jobId: cleanText(input.jobId),
        amount: Number(input.amount || 0),
      });
    case 'recover_stale':
      return { recovered: await agentRecoverStaleJobs({ carerUid: input.carerUid, agentId: input.agentId }) };
    case 'cleanup_old':
      return { deleted: await agentCleanupOldJobs({ carerUid: input.carerUid, agentId: input.agentId, limit: input.limit }) };
    case 'repair_successful_completion':
      return agentCompleteRechargeRedeemJob({
        carerUid: input.carerUid,
        agentId: input.agentId,
        jobId: cleanText(input.jobId),
        taskId: cleanText(input.taskId),
        actorUsername: input.actorUsername,
        scopeUid: input.scopeUid,
        evidence: input.evidence,
      });
    case 'mark_post_success_failure':
      return agentMarkJobPendingReview({
        carerUid: input.carerUid,
        agentId: input.agentId,
        jobId: cleanText(input.jobId),
        reason: cleanText(input.reason) || 'AppBeg completion failed after game success.',
        details: { ...(input.details || {}), partial_success: true },
      });
    default:
      throw new Error(`Unsupported agent job action: ${action}`);
  }
  } finally {
    console.info('[AGENT_JOBS_API_ACTION_DONE]', {
      action: action || null,
      jobId: cleanText(input.jobId) || null,
      durationMs: Date.now() - actionStartedAt,
    });
  }
}
