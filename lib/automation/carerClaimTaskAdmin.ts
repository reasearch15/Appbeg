/**
 * Server-side (Firebase Admin) carer task claim + automation_jobs creation.
 * Mirrors client `claimTaskAndCreateJob` for the local agent auto-tick API.
 */

import { FieldValue } from 'firebase-admin/firestore';
import { createHash } from 'node:crypto';

import { adminDb } from '@/lib/firebase/admin';
import { isAppbegSqlOnlyMode } from '@/lib/server/appbegSqlOnlyMode';
import { isAuthSqlReadEnabled } from '@/lib/server/authSqlRead';
import { isAuthoritySqlWriteEnabled } from '@/lib/server/authoritySqlWrite';
import { logFirestoreTouch } from '@/lib/server/firestoreTouchAudit';
import { claimCarerTaskInSql } from '@/lib/sql/authorityCarerTasks';
import {
  buildAutomationPayload,
  getTimestampMs,
  mapTaskType,
  resolveAutomationAccessFields,
  resolveTaskTypeLabel,
  type GameLoginDetailsInput,
} from '@/lib/automation/automationClaimPayload';
import { mirrorAutomationJobById } from '@/lib/sql/automationJobsCache';
import { mirrorCarerTaskById } from '@/lib/sql/carerTasksCache';
import { lookupGameLoginDetailsForCoadminGameFromSql } from '@/lib/sql/gameLoginsCache';
import { readPlayerGameLoginForClaimFromSql } from '@/lib/sql/playerGameLoginsCache';

const AUTOMATION_JOB_TTL_MS = 14 * 24 * 60 * 60 * 1000;

function automationJobTtlAdmin() {
  return new Date(Date.now() + AUTOMATION_JOB_TTL_MS);
}

const STALE_TASK_CLAIM_TIMEOUT_MS = 5 * 60 * 1000;

const AGENT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

function logAutoClaimTiming(step: string, startedAt: number, details: Record<string, unknown> = {}) {
  console.info(`[AUTO_CLAIM_TIMING] ${step}`, {
    durationMs: Date.now() - startedAt,
    ...details,
  });
}

function logVegasPayloadCredentials(payload: Record<string, unknown>) {
  const game = String(payload.game || '').trim();
  if (normalizeGameNameForAutomation(game) !== 'vegas_sweeps') return;
  const password = String(payload.gameCredentialPassword ?? '');
  console.info('[VEGAS_CREDS_API_PAYLOAD]', {
    game,
    credentialUsername: String(payload.gameCredentialUsername || '').trim() || null,
    passwordPresent: Boolean(password),
    passwordLength: password.length,
    passwordHashPrefix: password
      ? createHash('sha256').update(password, 'utf8').digest('hex').slice(0, 8)
      : '-',
  });
}

function validateAutomationAgentId(agentId: string): {
  valid: boolean;
  error?: string;
  normalized?: string;
} {
  const trimmed = String(agentId || '').trim();
  if (!trimmed) {
    return { valid: false, error: 'Agent ID cannot be empty.' };
  }
  if (trimmed.length > 64) {
    return { valid: false, error: 'Agent ID must be at most 64 characters.' };
  }
  if (!AGENT_ID_PATTERN.test(trimmed)) {
    return {
      valid: false,
      error: 'Agent ID may only contain letters, numbers, underscores, and hyphens.',
    };
  }
  return { valid: true, normalized: trimmed };
}

function automationJobDocId(carerUid: string, taskId: string): string {
  const uid = String(carerUid || '').trim();
  const tid = String(taskId || '').trim().replace(/\//g, '_');
  if (!uid || !tid) {
    throw new Error('carerUid and taskId are required for automation job id.');
  }
  return `${uid}--${tid}`;
}

function isActiveAutomationJobStatus(value: unknown) {
  const normalized = String(value || '').trim().toLowerCase();
  return (
    normalized === 'queued' ||
    normalized === 'claimed' ||
    normalized === 'running' ||
    normalized === 'waiting' ||
    normalized === 'in_progress' ||
    normalized === 'processing' ||
    normalized === 'cancelled_requested'
  );
}

function isTerminalAutomationJobStatus(value: unknown) {
  const normalized = String(value || '').trim().toLowerCase();
  return (
    normalized === 'completed' ||
    normalized === 'failed' ||
    normalized === 'cancelled' ||
    normalized === 'canceled' ||
    normalized === 'dismissed' ||
    normalized === 'terminal' ||
    normalized === 'success' ||
    normalized === 'error'
  );
}

function normalizeAutomationStatus(value: unknown) {
  return String(value || '').trim().toLowerCase();
}

function isFreshAutomationJobSignal(job: {
  status?: string | null;
  heartbeatMs?: number;
  hasHeartbeat?: boolean;
  data?: Record<string, unknown> | null;
}) {
  const error = String(job.data?.error || '').trim().toLowerCase();
  if (error.includes('timed out') || error.includes('returned to the queue')) {
    return false;
  }
  const status = normalizeAutomationStatus(job.status);
  const signalMs = Math.max(
    Number(job.heartbeatMs || 0),
    getTimestampMs(job.data?.updatedAt),
    getTimestampMs(job.data?.createdAt)
  );
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
    return job.hasHeartbeat ?? Boolean(job.heartbeatMs);
  }
  return false;
}

function normalizeClaimedStatus(value: unknown) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'unclaimed') return 'unclaimed';
  if (normalized === 'running') return 'running';
  return normalized;
}

function sanitizeStatus(value: unknown): string {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'pending') return 'pending';
  if (normalized === 'in_progress') return 'in_progress';
  if (normalized === 'completed') return 'completed';
  if (normalized === 'failed') return 'failed';
  if (normalized === 'urgent') return 'urgent';
  return 'pending';
}

function taskDebugFields(task: Record<string, unknown> | null | undefined) {
  return {
    status: String(task?.['status'] || '').trim() || null,
    assignedCarerUid: String(task?.['assignedCarerUid'] || '').trim() || null,
    assignedCarerUsername: String(task?.['assignedCarerUsername'] || task?.['assignedCarer'] || '').trim() || null,
    claimedByUid: String(task?.['claimedByUid'] || '').trim() || null,
    automationJobId: String(task?.['automationJobId'] || '').trim() || null,
  };
}

function isAgentSupportedAutomationType(value: string) {
  return (
    value === 'CREATE_USERNAME' ||
    value === 'RESET_PASSWORD' ||
    value === 'RECHARGE' ||
    value === 'REDEEM'
  );
}

function isRetryableConcurrencyError(error: unknown) {
  const code = String((error as { code?: string } | null | undefined)?.code || '').toLowerCase();
  const message = String((error as { message?: string } | null | undefined)?.message || '').toLowerCase();
  return (
    code.includes('failed-precondition') ||
    code.includes('aborted') ||
    message.includes('failed-precondition') ||
    message.includes('too much contention') ||
    message.includes('transaction')
  );
}

export type ClaimCarerTaskAdminResult = {
  jobId: string;
  taskId: string;
  status: string;
  reusedExistingJob: boolean;
};

export async function claimCarerTaskAsAdmin(input: {
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
  requireAutomationEnabled?: boolean;
}): Promise<ClaimCarerTaskAdminResult> {
  const totalStartedAt = Date.now();
  console.info('[START_TIMING] server claim start at=%s taskId=%s source=admin_claimCarerTaskAsAdmin', new Date(totalStartedAt).toISOString(), input.taskId);
  const sqlOnlyMode = isAppbegSqlOnlyMode();
  if (isAuthoritySqlWriteEnabled() || sqlOnlyMode) {
    console.info('[CLAIM_TASK_SQL_ONLY_START]', {
      taskId: input.taskId,
      carerUid: input.carerUid,
      coadminUid: input.carerCoadminUid,
      appbegSqlOnlyMode: sqlOnlyMode,
      authoritySqlWrite: isAuthoritySqlWriteEnabled(),
    });
    console.info('[SQL_NO_FIRESTORE_CLAIM_TASK]', {
      taskId: input.taskId,
      carerUid: input.carerUid,
      collections: ['carerTasks', 'automation_jobs', 'users', 'playerGameLogins', 'gameLogins'],
    });
    const result = await claimCarerTaskInSql(input);
    console.info('[AUTHORITY_SQL_WRITE] claimCarerTaskAsAdmin', {
      taskId: input.taskId,
      carerUid: input.carerUid,
      jobId: result.jobId,
      reusedExistingJob: result.reusedExistingJob,
      duplicate: result.duplicate ?? false,
      durationMs: Date.now() - totalStartedAt,
    });
    return {
      jobId: result.jobId,
      taskId: result.taskId,
      status: result.status,
      reusedExistingJob: result.reusedExistingJob,
    };
  }
  const taskRef = adminDb.collection('carerTasks').doc(input.taskId);
  const affectedJobIds = new Set<string>();

  const loadSameTaskJobRefs = async (options: { isPendingCleanTask: boolean }) => {
    const startedAt = Date.now();
    if (options.isPendingCleanTask) {
      logAutoClaimTiming('same_task_jobs_query', startedAt, {
        taskId: input.taskId,
        resultCount: 0,
        skipped: true,
        reason: 'pending_clean_task',
      });
      return [];
    }
    const sameTaskJobsSnap = await adminDb
      .collection('automation_jobs')
      .where('taskId', '==', input.taskId)
      .where('status', 'in', ['queued', 'waiting', 'running', 'in_progress', 'cancelled_requested'])
      .limit(10)
      .get();
    logAutoClaimTiming('same_task_jobs_query', startedAt, {
      taskId: input.taskId,
      resultCount: sameTaskJobsSnap.docs.length,
      activeOnly: true,
    });
    return sameTaskJobsSnap.docs.map((jobSnap) => jobSnap.ref);
  };

  const runClaimTransaction = async () => {
    const transactionStartedAt = Date.now();
    logFirestoreTouch({
      firestore_touch_type: 'authority_write_keep_for_now',
      route: '/api/carer/automation-auto-tick',
      operation: 'transaction',
      collection: 'carerTasks,automation_jobs',
      document_id: input.taskId,
      details: { context: 'claimCarerTaskAsAdmin', carerUid: input.carerUid },
    });
    try {
      return await adminDb.runTransaction(async (transaction) => {
      const taskReadStartedAt = Date.now();
      const taskSnap = await transaction.get(taskRef);
      logAutoClaimTiming('task_read', taskReadStartedAt, {
        taskId: input.taskId,
        carerUid: input.carerUid,
        userReadSkipped: Boolean(input.trustedUser),
        taskExists: taskSnap.exists,
      });
      let userData = input.trustedUser as {
        username?: string;
        automationAgentId?: string | null;
      } | undefined;
      if (!userData) {
        const userReadStartedAt = Date.now();
        const userSnap = await transaction.get(adminDb.collection('users').doc(input.carerUid));
        logAutoClaimTiming('user_read', userReadStartedAt, {
          taskId: input.taskId,
          carerUid: input.carerUid,
          userExists: userSnap.exists,
        });
        if (!userSnap.exists) {
          throw new Error('Current user profile not found.');
        }
        userData = userSnap.data() as {
          username?: string;
          automationAgentId?: string | null;
        };
      }
      const linkedAgentRaw = String(userData.automationAgentId || '').trim();
      const agentCheck = validateAutomationAgentId(linkedAgentRaw);
      if (!agentCheck.valid || !agentCheck.normalized) {
        throw new Error(
          'No automation agent connected. Use “Connect Automation Agent” on the carer panel, set the same ID as in your agent .env, then try again.'
        );
      }
      const resolvedAgentId = agentCheck.normalized;

      if (!taskSnap.exists) {
        throw new Error('Task not found');
      }

      const freshTask = taskSnap.data() as Record<string, unknown>;
      const carerCoadminUid = String(input.carerCoadminUid || '').trim();
      const taskCoadminUid = String(freshTask.coadminUid || '').trim();
      if (!carerCoadminUid || taskCoadminUid !== carerCoadminUid) {
        console.warn('[automation] cross-scope task claim blocked', {
          taskId: taskSnap.id,
          carerUid: input.carerUid,
          carerCoadminUid: carerCoadminUid || null,
          taskCoadminUid: taskCoadminUid || null,
        });
        throw new Error('Forbidden: task is outside the carer coadmin scope.');
      }
      const createdByName = input.carerName?.trim() || userData.username?.trim() || 'Carer';
      console.info('[TASK_START] taskId=%s begin path=claimCarerTaskAsAdmin', taskSnap.id);
      console.info('[AUTO_CLAIM_ADMIN] before task status fields', {
        taskId: taskSnap.id,
        carerUid: input.carerUid,
        carerUsername: createdByName,
        fields: taskDebugFields(freshTask),
      });
      const currentStatus = sanitizeStatus(freshTask.status);
      const rawTaskStatus = String(freshTask.status || '').trim().toLowerCase() || 'pending';
      const automationStatus = normalizeAutomationStatus(freshTask.automationStatus);
      const claimedStatus = normalizeClaimedStatus(freshTask.claimedStatus);
      const claimedByUid = String(freshTask.claimedByUid || '').trim();
      const automationError = String(freshTask.automationError || '').trim() || null;
      const assignedCarerUid = String(freshTask.assignedCarerUid || '').trim();
      const assignedCarerName = String(
        freshTask.assignedCarerUsername || freshTask.assignedCarer || ''
      ).trim();
      const currentUserUid = input.carerUid;
      const claimedByCurrentCarer =
        assignedCarerUid === currentUserUid ||
        claimedByUid === currentUserUid ||
        (currentStatus === 'in_progress' &&
          (assignedCarerUid === currentUserUid ||
            (assignedCarerName &&
              createdByName &&
              assignedCarerName.toLowerCase() === createdByName.toLowerCase()))) ||
        (assignedCarerName &&
          createdByName &&
          assignedCarerName.toLowerCase() === createdByName.toLowerCase());
      const linkedJobId = String(freshTask.automationJobId || '').trim();
      console.info('[TASK_START] existing linkedJobId=%s taskId=%s status=%s automationStatus=%s assignedCarer=%s updatedAt=%o createdAt=%o',
        linkedJobId || null,
        taskSnap.id,
        rawTaskStatus,
        automationStatus || null,
        assignedCarerUid || assignedCarerName || null,
        freshTask.updatedAt || null,
        freshTask.createdAt || null
      );
      const isPendingCleanTask =
        rawTaskStatus === 'pending' &&
        !claimedByUid &&
        !assignedCarerUid &&
        !linkedJobId;
      const sameTaskJobRefs = await loadSameTaskJobRefs({ isPendingCleanTask });
      const legacyJobId = automationJobDocId(currentUserUid, taskSnap.id);
      const candidateJobIds = Array.from(
        new Set((isPendingCleanTask ? [] : [linkedJobId, legacyJobId]).filter((value) => Boolean(value)))
      );
      const candidateJobRefs = candidateJobIds.map((jobId) =>
        adminDb.collection('automation_jobs').doc(jobId)
      );
      const candidateJobSnaps = await Promise.all(
        candidateJobRefs.map((jobRef) => transaction.get(jobRef))
      );
      const sameTaskJobSnaps = await Promise.all(
        sameTaskJobRefs
          .filter((jobRef) => !candidateJobIds.includes(jobRef.id))
          .map((jobRef) => transaction.get(jobRef))
      );
      const legacyCandidateJobs = candidateJobRefs.map((jobRef, index) => {
        const jobSnap = candidateJobSnaps[index];
        const jobData = jobSnap.exists ? (jobSnap.data() as Record<string, unknown>) : null;
        const heartbeatMs = Math.max(
          getTimestampMs(jobData?.lastHeartbeatAt),
          getTimestampMs(jobData?.updatedAt),
          getTimestampMs(jobData?.createdAt)
        );
        return {
          ref: jobRef,
          snap: jobSnap,
          data: jobData,
          status: normalizeAutomationStatus(jobData?.status),
          heartbeatMs,
          hasHeartbeat: Boolean(getTimestampMs(jobData?.lastHeartbeatAt)),
        };
      });
      const sameTaskJobs = sameTaskJobSnaps
        .filter((jobSnap) => jobSnap.exists)
        .map((jobSnap) => {
          const jobData = jobSnap.data() as Record<string, unknown>;
          const heartbeatMs = Math.max(
            getTimestampMs(jobData.lastHeartbeatAt),
            getTimestampMs(jobData.updatedAt),
            getTimestampMs(jobData.createdAt)
          );
          return {
            ref: jobSnap.ref,
            snap: jobSnap,
            data: jobData,
            status: normalizeAutomationStatus(jobData.status),
            heartbeatMs,
            hasHeartbeat: Boolean(getTimestampMs(jobData.lastHeartbeatAt)),
          };
        });
      const candidateJobs = Array.from(
        new Map(
          [...legacyCandidateJobs, ...sameTaskJobs].map((job) => [job.ref.id, job])
        ).values()
      );
      candidateJobs.forEach((job) => {
        console.info('[TASK_START] existing job status=%s jobId=%s taskId=%s linked=%s exists=%s createdAt=%o updatedAt=%o heartbeatMs=%s',
          job.status || null,
          job.ref.id,
          String(job.data?.taskId || '').trim() || null,
          job.ref.id === linkedJobId,
          job.snap.exists,
          job.data?.createdAt || null,
          job.data?.updatedAt || null,
          job.heartbeatMs || 0
        );
      });
      const activeSameTaskJobs = candidateJobs.filter((job) =>
        isActiveAutomationJobStatus(job.status)
      );
      const oldSameTaskJobs = candidateJobs.filter(
        (job) => job.snap.exists && !isActiveAutomationJobStatus(job.status)
      );
      oldSameTaskJobs.forEach((job) => {
        console.info('START_TASK_CLEARING_OLD_COMPLETED_JOB_AND_CREATING_NEW', {
          taskId: taskSnap.id,
          jobId: job.ref.id,
          status: job.status || null,
          linked: job.ref.id === linkedJobId,
        });
      });
      const freshActiveSameTaskJobs = activeSameTaskJobs.filter((job) =>
        isFreshAutomationJobSignal(job)
      );
      const jobOwnerUid = (job: (typeof activeSameTaskJobs)[number]) =>
        String(job.data?.carerUid || job.data?.createdByUid || '').trim();
      const freshJobsAllowedToBlock = isPendingCleanTask ? [] : freshActiveSameTaskJobs;
      const myFreshJobs = freshJobsAllowedToBlock.filter(
        (job) => jobOwnerUid(job) === currentUserUid
      );
      const blockingFreshOtherCarer = freshJobsAllowedToBlock.filter(
        (job) => jobOwnerUid(job) !== currentUserUid
      );
      if (blockingFreshOtherCarer.length > 0) {
        console.info('[CARER_ADMIN] claim blocked fresh job owned by another carer', {
          taskId: taskSnap.id,
          blockingJobIds: blockingFreshOtherCarer.map((j) => j.ref.id),
        });
        throw new Error('Automation job already exists for this task.');
      }

      const activeExistingJob = [...activeSameTaskJobs].sort(
        (left, right) => right.heartbeatMs - left.heartbeatMs
      )[0];
      if (activeExistingJob) {
        console.info('START_TASK_BLOCKED_ACTIVE_JOB', {
          taskId: taskSnap.id,
          jobId: activeExistingJob.ref.id,
          status: activeExistingJob.status || null,
          isFresh: isFreshAutomationJobSignal(activeExistingJob),
        });
      }
      const reusableActiveJob = [...myFreshJobs].sort(
        (left, right) => right.heartbeatMs - left.heartbeatMs
      )[0];
      const linkedAutomationJob = linkedJobId
        ? candidateJobs.find((job) => job.ref.id === linkedJobId) || null
        : null;
      const preferredJobLockActivityMs =
        (linkedAutomationJob && isFreshAutomationJobSignal(linkedAutomationJob)
          ? linkedAutomationJob.heartbeatMs
          : 0) ||
        reusableActiveJob?.heartbeatMs ||
        [...freshActiveSameTaskJobs].sort((left, right) => right.heartbeatMs - left.heartbeatMs)[0]
          ?.heartbeatMs ||
        0;
      const latestLockActivityMs =
        preferredJobLockActivityMs ||
        Math.max(getTimestampMs(freshTask.lastHeartbeatAt), getTimestampMs(freshTask.claimedAt));
      const hasFreshLock =
        Boolean(latestLockActivityMs) &&
        Date.now() - latestLockActivityMs < STALE_TASK_CLAIM_TIMEOUT_MS;
      const linkedAutomationJobIsTerminal = Boolean(
        linkedAutomationJob &&
          linkedAutomationJob.snap.exists &&
          isTerminalAutomationJobStatus(linkedAutomationJob.status)
      );
      if (linkedAutomationJobIsTerminal) {
        console.info('[TASK_START] linked job terminal; clearing stale link', {
          taskId: taskSnap.id,
          linkedJobId,
          linkedJobStatus: linkedAutomationJob?.status || null,
        });
      }
      const hasLinkedAutomationJob = Boolean(
        linkedAutomationJob && isActiveAutomationJobStatus(linkedAutomationJob.status)
      );
      console.info('[TASK_START] terminalCheck=%o', {
        taskId: taskSnap.id,
        linkedJobId: linkedJobId || null,
        linkedJobStatus: linkedAutomationJob?.status || null,
        hasLinkedAutomationJob,
        activeSameTaskJobCount: activeSameTaskJobs.length,
        freshActiveSameTaskJobCount: freshActiveSameTaskJobs.length,
      });
      const orphanedClaimFields =
        rawTaskStatus === 'pending' &&
        !claimedByUid &&
        !assignedCarerUid &&
        !hasLinkedAutomationJob &&
        freshActiveSameTaskJobs.length === 0 &&
        Boolean(claimedStatus || automationStatus === 'running');
      const restartableTask =
        rawTaskStatus === 'pending' ||
        rawTaskStatus === 'waiting' ||
        linkedAutomationJobIsTerminal ||
        automationStatus === 'waiting' ||
        automationStatus === 'failed' ||
        automationStatus === 'pending_review' ||
        automationStatus === 'returned_to_pending' ||
        automationStatus === 'cancelled' ||
        Boolean(
          automationError &&
            (automationStatus === 'waiting' ||
              automationStatus === 'failed' ||
              automationStatus === 'pending_review')
        );
      const staleClaim =
        claimedStatus === 'running' &&
        (orphanedClaimFields ||
          linkedAutomationJobIsTerminal ||
          !hasFreshLock ||
          (activeExistingJob?.status === 'running' && !activeExistingJob.heartbeatMs));
      const hasFreshActiveClaim =
        claimedStatus === 'running' &&
        !linkedAutomationJobIsTerminal &&
        hasFreshLock &&
        !orphanedClaimFields;

      const canStartPendingClean =
        rawTaskStatus === 'pending' &&
        blockingFreshOtherCarer.length === 0 &&
        (freshActiveSameTaskJobs.length === 0 || Boolean(reusableActiveJob));
      console.info('[CARER_ADMIN] claim transaction state', {
        taskId: taskSnap.id,
        rawTaskStatus,
        canStartPendingClean,
        staleTaskFieldsIgnoredForPending: rawTaskStatus === 'pending',
        staleSnapshot:
          rawTaskStatus === 'pending'
            ? {
                assignedCarerUid: assignedCarerUid || null,
                claimedByUid: claimedByUid || null,
                claimedStatus: claimedStatus || null,
                automationJobId: linkedJobId || null,
                automationStatus: automationStatus || null,
              }
            : null,
        freshJobsForSameTask: freshActiveSameTaskJobs.length,
        myFreshJobs: myFreshJobs.length,
        automationStatus: automationStatus || null,
        claimedStatus: claimedStatus || null,
        claimedByUid: claimedByUid || null,
        assignedCarerUid: assignedCarerUid || null,
        automationJobId: linkedJobId || null,
        orphanedClaimFields,
        activeJobsForSameTask: activeSameTaskJobs.map((job) => ({
          jobId: job.ref.id,
          status: job.status || null,
          heartbeatMs: job.heartbeatMs || 0,
          isFresh: isFreshAutomationJobSignal(job),
        })),
        lastHeartbeatAt: freshTask.lastHeartbeatAt || freshTask.claimedAt || null,
        automationError,
        isPendingCleanTask,
      });

      if (orphanedClaimFields) {
        console.info('[automation] start-task:decision', {
          taskId: taskSnap.id,
          decision: 'orphaned claim fields ignored for restart',
          status: rawTaskStatus,
          claimedStatus: claimedStatus || null,
          automationStatus: automationStatus || null,
          automationJobId: linkedJobId || null,
          activeJobsForSameTask: activeSameTaskJobs.length,
        });
      }

      let skipSingleStaleJobCleanup = false;
      const cleanupStartedAt = Date.now();
      let cleanupCount = 0;
      if (rawTaskStatus === 'pending' && (!reusableActiveJob || isPendingCleanTask)) {
        const freshIds = new Set(isPendingCleanTask ? [] : freshActiveSameTaskJobs.map((j) => j.ref.id));
        for (const job of activeSameTaskJobs) {
          if (freshIds.has(job.ref.id)) {
            continue;
          }
          cleanupCount += 1;
          transaction.update(job.ref, {
            status: 'cancelled',
            completedAt: FieldValue.serverTimestamp(),
            ttlExpiresAt: automationJobTtlAdmin(),
            updatedAt: FieldValue.serverTimestamp(),
            lastHeartbeatAt: FieldValue.serverTimestamp(),
            error: 'Stale automation job cleared while reclaiming pending task.',
            cancelledReason: isPendingCleanTask ? 'stale_returned_to_pending' : 'pending_reclaim_stale_job',
          });
          affectedJobIds.add(job.ref.id);
          console.info('[RETURN_TO_PENDING] stale active job cancelled', {
            taskId: taskSnap.id,
            jobId: job.ref.id,
            previousStatus: job.status || null,
            reason: isPendingCleanTask ? 'pending_clean_claim' : 'pending_reclaim_stale_job',
          });
          console.info('[CARER_ADMIN] stale automation job cancelled for pending reclaim', {
            taskId: taskSnap.id,
            jobId: job.ref.id,
            jobStatus: job.status || null,
          });
        }
        if (isPendingCleanTask && activeSameTaskJobs.length > 0) {
          console.info('[AUTO_TICK] pending clean task claim allowed despite stale job', {
            taskId: taskSnap.id,
            staleJobIds: activeSameTaskJobs.map((job) => job.ref.id),
          });
        }
        skipSingleStaleJobCleanup = true;
        console.info('[CARER_ADMIN] pending reclaim will overwrite stale task fields', {
          taskId: taskSnap.id,
          hadAssignedCarerUid: Boolean(assignedCarerUid),
          hadClaimedByUid: Boolean(claimedByUid),
          hadAutomationJobId: Boolean(linkedJobId),
        });
      }
      logAutoClaimTiming('old_job_cleanup', cleanupStartedAt, {
        taskId: taskSnap.id,
        cleanupCount,
        activeSameTaskJobCount: activeSameTaskJobs.length,
      });

      if (rawTaskStatus !== 'pending') {
        if (
          hasFreshActiveClaim &&
          !claimedByCurrentCarer &&
          (!reusableActiveJob || reusableActiveJob.status === 'running')
        ) {
          console.info('[automation] start-task:decision', {
            taskId: taskSnap.id,
            decision: 'rejected because fresh active claim',
          });
          throw new Error('Task already claimed');
        }
      }

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
        console.info('[automation] unsupported-job-type-blocked', {
          taskId: taskSnap.id,
          mappedType,
        });
        throw new Error(
          `Automation is currently supported only for CREATE_USERNAME, RESET_PASSWORD, RECHARGE, and REDEEM. ${mappedType} must be handled manually.`
        );
      }
      const payload = buildAutomationPayload({
        taskId: taskSnap.id,
        freshTask: claimedTaskData,
        currentUserUid,
        currentCarerName: createdByName,
        currentUsername: input.currentUsername ?? null,
      });
      const coadminUid = taskCoadminUid;
      const staleOrFailedJob =
        !skipSingleStaleJobCleanup &&
        activeExistingJob &&
        (staleClaim || Boolean(automationError) || !isFreshAutomationJobSignal(activeExistingJob))
          ? activeExistingJob
          : null;
      if (staleOrFailedJob) {
        transaction.update(staleOrFailedJob.ref, {
          status: automationError ? 'failed' : 'cancelled',
          completedAt: FieldValue.serverTimestamp(),
          ttlExpiresAt: automationJobTtlAdmin(),
          updatedAt: FieldValue.serverTimestamp(),
          lastHeartbeatAt: FieldValue.serverTimestamp(),
          error: automationError || 'Task claim expired and was cleared before restart.',
          cancelledReason: automationError
            ? 'failed_automation_claim_released'
            : 'stale_claim_cleared',
        });
        affectedJobIds.add(staleOrFailedJob.ref.id);
        console.info('[automation] start-task:decision', {
          taskId: taskSnap.id,
          decision: automationError
            ? 'failed automation claim released'
            : 'stale claim cleared',
          previousJobId: staleOrFailedJob.ref.id,
        });
      }

      if (
        rawTaskStatus !== 'pending' &&
        reusableActiveJob &&
        isActiveAutomationJobStatus(reusableActiveJob.status) &&
        isFreshAutomationJobSignal(reusableActiveJob) &&
        !staleOrFailedJob &&
        hasFreshLock
      ) {
        console.info('[TASK_START] reusing existing job=%s taskId=%s existingStatus=%s linkedJobId=%s updatedAt=%o createdAt=%o',
          reusableActiveJob.ref.id,
          taskSnap.id,
          reusableActiveJob.status || null,
          linkedJobId || null,
          reusableActiveJob.data?.updatedAt || null,
          reusableActiveJob.data?.createdAt || null
        );
        console.info('[automation] task claimed', {
          taskId: taskSnap.id,
          carerUid: currentUserUid,
          reusedExistingJob: true,
          jobId: reusableActiveJob.ref.id,
        });
        transaction.update(taskRef, {
          ...claimedTaskData,
          claimedStatus: 'running',
          claimedByUid: currentUserUid,
          claimedByUsername: createdByName,
          claimedAt: FieldValue.serverTimestamp(),
          startedAt: FieldValue.serverTimestamp(),
          lastHeartbeatAt: FieldValue.serverTimestamp(),
          automationStatus: reusableActiveJob.status === 'running' ? 'running' : 'waiting',
          automationJobId: reusableActiveJob.ref.id,
          automationError: null,
          retryPending: false,
          resetToPendingAt: null,
          returnedToPendingAt: null,
          pendingSince: null,
          automationUpdatedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        console.info('[automation] task moved to in_progress', {
          taskId: taskSnap.id,
          assignedCarerUid: currentUserUid,
          jobId: reusableActiveJob.ref.id,
          originalTaskUpdatedToInProgress: true,
        });
        console.info('[HEARTBEAT] task state transition update taskId=%s status=in_progress', taskSnap.id);
        console.info('[automation] start-task:decision', {
          taskId: taskSnap.id,
          decision: 'claim allowed',
          reusedExistingJob: true,
          jobId: reusableActiveJob.ref.id,
        });
        logAutoClaimTiming('create_job', Date.now(), {
          taskId: taskSnap.id,
          jobId: reusableActiveJob.ref.id,
          queued: false,
          skipped: true,
          reason: 'reused_existing_job',
        });

        return {
          jobId: reusableActiveJob.ref.id,
          taskId: taskSnap.id,
          status: reusableActiveJob.status || 'queued',
          reusedExistingJob: true as const,
        };
      }

      if (rawTaskStatus !== 'pending') {
        if (!claimedByCurrentCarer && !restartableTask && !staleClaim) {
          console.info('[automation] start-task:decision', {
            taskId: taskSnap.id,
            decision: 'rejected because task is not reclaimable',
          });
          throw new Error('Task already claimed');
        }
      }

      const createJobStartedAt = Date.now();
      console.info('[START_TIMING] automation job create start at=%s taskId=%s', new Date(createJobStartedAt).toISOString(), taskSnap.id);
      const jobRef = adminDb.collection('automation_jobs').doc();
      console.info('[TASK_START] creating fresh automation job=%s taskId=%s previousLinkedJobId=%s type=%s',
        jobRef.id,
        taskSnap.id,
        linkedJobId || null,
        mappedType
      );
      console.info('[automation] task claimed', {
        taskId: taskSnap.id,
        carerUid: currentUserUid,
        reusedExistingJob: false,
        jobId: jobRef.id,
      });
      transaction.update(taskRef, {
        ...claimedTaskData,
        claimedStatus: 'running',
        claimedByUid: currentUserUid,
        claimedByUsername: createdByName,
        claimedAt: FieldValue.serverTimestamp(),
        startedAt: FieldValue.serverTimestamp(),
        lastHeartbeatAt: FieldValue.serverTimestamp(),
        automationStatus: 'waiting',
        automationJobId: jobRef.id,
        automationError: null,
        retryPending: false,
        resetToPendingAt: null,
        returnedToPendingAt: null,
        pendingSince: null,
        automationUpdatedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      console.info('[automation] task moved to in_progress', {
        taskId: taskSnap.id,
        assignedCarerUid: currentUserUid,
        jobId: jobRef.id,
        originalTaskUpdatedToInProgress: true,
      });
      logVegasPayloadCredentials(payload as unknown as Record<string, unknown>);
      console.info('[HEARTBEAT] task state transition update taskId=%s status=in_progress', taskSnap.id);

      const jobData = {
        carerUid: currentUserUid,
        coadminUid,
        agentId: resolvedAgentId,
        taskId: taskSnap.id,
        type: mappedType,
        status: 'queued',
        payload,
        createdByUid: currentUserUid,
        createdByName,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        startedAt: null,
        completedAt: null,
        ttlExpiresAt: null,
        error: null,
        attempts: 0,
        lastHeartbeatAt: null,
      };
      transaction.set(jobRef, jobData);
      affectedJobIds.add(jobRef.id);
      console.info(
        '[START_TIMING] automation job create done at=%s jobId=%s durationMs=%s taskId=%s',
        new Date().toISOString(),
        jobRef.id,
        Date.now() - createJobStartedAt,
        taskSnap.id
      );
      console.info('[TASK_START] task status transition taskId=%s from=%s to=in_progress automationJobId=%s automationStatus=waiting writeTimestamps=serverTimestamp',
        taskSnap.id,
        rawTaskStatus,
        jobRef.id
      );
      console.info('[TASK_START] task linked to fresh automation job=%s taskId=%s previousLinkedJobId=%s',
        jobRef.id,
        taskSnap.id,
        linkedJobId || null
      );
      logAutoClaimTiming('create_job', createJobStartedAt, {
        taskId: taskSnap.id,
        jobId: jobRef.id,
        queued: true,
      });
      console.info('[automation] start-task:decision', {
        taskId: taskSnap.id,
        decision: 'new automation job created',
        jobId: jobRef.id,
      });
      console.info('[automation] automation job created', {
        taskId: taskSnap.id,
        jobId: jobRef.id,
        carerUid: currentUserUid,
      });

      return {
        jobId: jobRef.id,
        taskId: taskSnap.id,
        status: 'queued' as const,
        reusedExistingJob: false as const,
      };
      });
    } finally {
      logAutoClaimTiming('transaction', transactionStartedAt, {
        taskId: input.taskId,
        carerUid: input.carerUid,
      });
    }
  };

  let result: ClaimCarerTaskAdminResult | null = null;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      result = await runClaimTransaction();
      break;
    } catch (error) {
      lastError = error;
      if (!isRetryableConcurrencyError(error) || attempt >= 2) {
        break;
      }
      console.info('START_TASK_RETRY_AFTER_PRECONDITION', {
        taskId: input.taskId,
        attempt,
        nextAttempt: attempt + 1,
        code: String((error as { code?: string } | null | undefined)?.code || ''),
        message: String((error as { message?: string } | null | undefined)?.message || ''),
      });
      await adminDb.collection('carerTasks').doc(input.taskId).get();
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  if (!result && isRetryableConcurrencyError(lastError)) {
    const latestTaskSnap = await adminDb.collection('carerTasks').doc(input.taskId).get();
    if (latestTaskSnap.exists) {
      const latestTask = latestTaskSnap.data() as Record<string, unknown>;
      const latestStatus = sanitizeStatus(latestTask.status);
      const latestAssignedCarerUid = String(
        latestTask.claimedByUid || latestTask.assignedCarerUid || ''
      ).trim();
      const latestLinkedJobId = String(latestTask.automationJobId || '').trim();
      const latestJobSnap = latestLinkedJobId
        ? await adminDb.collection('automation_jobs').doc(latestLinkedJobId).get()
        : null;
      const latestJobStatus = latestJobSnap?.exists
        ? String((latestJobSnap.data() as { status?: string }).status || '')
            .trim()
            .toLowerCase()
        : '';

      if (latestStatus === 'in_progress' && latestAssignedCarerUid === input.carerUid) {
        console.info('[TASK_START] reusing existing job=%s taskId=%s reason=concurrency_retry_latest_state existingStatus=%s',
          latestLinkedJobId || automationJobDocId(input.carerUid, input.taskId),
          input.taskId,
          latestJobStatus || 'queued'
        );
        result = {
          jobId: latestLinkedJobId || automationJobDocId(input.carerUid, input.taskId),
          taskId: input.taskId,
          status: latestJobStatus || 'queued',
          reusedExistingJob: true,
        };
      }
    }
  }

  if (!result) {
    throw lastError instanceof Error ? lastError : new Error('Failed to queue the task.');
  }
  affectedJobIds.add(result.jobId);
  if (!isAuthSqlReadEnabled()) {
    for (const jobId of affectedJobIds) {
      void mirrorAutomationJobById(jobId, 'appbeg_admin');
    }
    void mirrorCarerTaskById(input.taskId, 'appbeg_admin_claim');
  }
  console.info(
    '[START_TIMING] server write completed at=%s durationMs=%s taskId=%s jobId=%s status=%s source=admin_claimCarerTaskAsAdmin',
    new Date().toISOString(),
    Date.now() - totalStartedAt,
    input.taskId,
    result.jobId,
    result.status
  );

  console.info('[AUTO_CLAIM_ADMIN] after task status fields', {
    taskId: input.taskId,
    jobId: result.jobId,
    carerUid: input.carerUid,
    reusedExistingJob: result.reusedExistingJob,
    automationJobCreated: !result.reusedExistingJob,
    originalTaskUpdatedToInProgress: true,
  });

  logAutoClaimTiming('total', totalStartedAt, {
    taskId: input.taskId,
    carerUid: input.carerUid,
    ok: true,
    jobId: result.jobId,
    reusedExistingJob: result.reusedExistingJob,
  });
  return result;
}

export function normalizeGameNameForAutomation(gameName: string) {
  return gameName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

function logAutoTickResolverSql(
  type: 'game_login' | 'username',
  details: {
    hit: boolean;
    source: 'sql' | 'fallback';
    durationMs: number;
    coadminUid?: string;
    playerUid?: string;
    gameName?: string;
  }
) {
  console.info(
    '[AUTO_TICK_RESOLVER_SQL] type=%s hit=%s source=%s durationMs=%s coadminUid=%s playerUid=%s gameName=%s',
    type,
    details.hit,
    details.source,
    details.durationMs,
    details.coadminUid || null,
    details.playerUid || null,
    details.gameName || null
  );
}

function logAutoTickResolverFallback(
  type: 'game_login' | 'username',
  reason: string,
  details: { coadminUid?: string; playerUid?: string; gameName?: string }
) {
  console.info(
    '[AUTO_TICK_RESOLVER_FALLBACK] type=%s reason=%s coadminUid=%s playerUid=%s gameName=%s',
    type,
    reason,
    details.coadminUid || null,
    details.playerUid || null,
    details.gameName || null
  );
}

export async function resolveGameLoginDetailsForCoadminGame(
  coadminUid: string,
  gameName: string
): Promise<GameLoginDetailsInput> {
  const sqlLookup = await lookupGameLoginDetailsForCoadminGameFromSql(coadminUid, gameName);
  console.info('[CLAIM_TASK_SQL_GAME_LOGIN_READ]', {
    type: 'game_login_details',
    coadminUid,
    gameName,
    hit: Boolean(sqlLookup.hit && sqlLookup.details),
    missReason: sqlLookup.missReason,
    durationMs: sqlLookup.durationMs,
  });
  if (sqlLookup.hit && sqlLookup.details) {
    logAutoTickResolverSql('game_login', {
      hit: true,
      source: 'sql',
      durationMs: sqlLookup.durationMs,
      coadminUid,
      gameName,
    });
    return sqlLookup.details;
  }

  if (sqlLookup.missReason) {
    logAutoTickResolverFallback('game_login', sqlLookup.missReason, { coadminUid, gameName });
  }

  console.info('[CLAIM_TASK_FIRESTORE_GAME_LOGINS_BRANCH_BLOCKED]', {
    resolver: 'resolveGameLoginDetailsForCoadminGame',
    collection: 'gameLogins',
    coadminUid,
    gameName,
    missReason: sqlLookup.missReason,
    appbegSqlOnlyMode: isAppbegSqlOnlyMode(),
  });
  if (isAppbegSqlOnlyMode()) {
    console.info('[SQL_NO_FIRESTORE_CLAIM_TASK]', {
      resolver: 'resolveGameLoginDetailsForCoadminGame',
      collection: 'gameLogins',
      coadminUid,
      gameName,
      missReason: sqlLookup.missReason,
    });
  }
  return null;
}

export async function resolveCurrentUsernameForTask(
  coadminUid: string,
  playerUid: string,
  gameName: string,
  options?: { taskType?: string | null }
): Promise<string | null> {
  const taskType = String(options?.taskType || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '_');
  if (taskType === 'CREATE_USERNAME') {
    console.info('[CLAIM_TASK_SQL_GAME_LOGIN_MISSING_ALLOWED]', {
      type: 'CREATE_USERNAME',
      coadminUid,
      playerUid,
      gameName,
      reason: 'create_username_has_no_existing_player_game_login',
    });
    return null;
  }

  const sqlLookup = await readPlayerGameLoginForClaimFromSql({
    playerUid,
    coadminUid,
    gameName,
  });
  console.info('[CLAIM_TASK_SQL_GAME_LOGIN_READ]', {
    type: 'player_game_login_username',
    coadminUid,
    playerUid,
    gameName,
    taskType: taskType || null,
    hit: Boolean(sqlLookup.hit && sqlLookup.gameUsername),
    missReason: sqlLookup.missReason,
    durationMs: sqlLookup.durationMs,
  });
  if (sqlLookup.hit && sqlLookup.gameUsername) {
    console.info('[CLAIM_TASK_SQL_GAME_LOGIN_FOUND]', {
      coadminUid,
      playerUid,
      gameName,
      username: sqlLookup.gameUsername,
      durationMs: sqlLookup.durationMs,
    });
    logAutoTickResolverSql('username', {
      hit: true,
      source: 'sql',
      durationMs: sqlLookup.durationMs,
      coadminUid,
      playerUid,
      gameName,
    });
    return sqlLookup.gameUsername;
  }

  if (sqlLookup.missReason) {
    logAutoTickResolverFallback('username', sqlLookup.missReason, {
      coadminUid,
      playerUid,
      gameName,
    });
  }

  console.info('[CLAIM_TASK_FIRESTORE_PLAYER_GAME_LOGINS_BRANCH_BLOCKED]', {
    resolver: 'resolveCurrentUsernameForTask',
    collection: 'playerGameLogins',
    coadminUid,
    playerUid,
    gameName,
    taskType: taskType || null,
    missReason: sqlLookup.missReason,
    appbegSqlOnlyMode: isAppbegSqlOnlyMode(),
  });
  if (isAppbegSqlOnlyMode()) {
    console.info('[SQL_NO_FIRESTORE_CLAIM_TASK]', {
      resolver: 'resolveCurrentUsernameForTask',
      collection: 'playerGameLogins',
      coadminUid,
      playerUid,
      gameName,
      missReason: sqlLookup.missReason,
    });
  }
  return null;
}
