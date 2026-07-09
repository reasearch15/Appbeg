import {
  addDoc,
  arrayUnion,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';

import { jobCompleteGuard } from '@/lib/automation/jobCompleteGuard';

import { getAppSessionRequestHeaders, getLocalAppSessionId } from '@/features/auth/appSession';
import { assertActivePlayerSession, getLocalPlayerSessionId, getPlayerApiHeaders } from '@/features/auth/playerSession';
import { logCarerPageRequestAudit } from '@/lib/client/carerPageRequestAudit';
import { attachCarerRechargeRedeemTotalsSqlPoll } from '@/features/live/coadminCarerTotalsSqlRead';
import { clientOnSnapshot } from '@/lib/client/clientFirestoreQuery';
import { assertClientFirestoreDisabled } from '@/lib/client/clientFirestoreGuard';
import {
  logClientFirebaseRuntimeRemoved,
  logSqlClientMigration,
} from '@/lib/client/sqlClientMigration';
import { resolveSqlSessionUser } from '@/lib/client/carerSessionIdentity';
import { getSqlApiReadHeaders } from '@/lib/client/sqlApiHeaders';
import { getStaffAppSessionApiHeaders } from '@/lib/client/staffApiHeaders';
import { isClientSqlReadMode, logClientFirestoreSkipped } from '@/lib/client/sqlReadMode';
import { getFirebaseApiHeaders } from '@/lib/firebase/apiClient';
import { auth, db } from '@/lib/firebase/client';
import {
  getCurrentUserCoadminUid as getScopedCurrentUserCoadminUid,
  resolveCoadminUid,
} from '@/lib/coadmin/scope';

function isCarerTaskDebugLoggingEnabled() {
  if (typeof window === 'undefined') {
    return false;
  }
  try {
    return window.localStorage.getItem('debugCarerTaskListener') === '1';
  } catch {
    return false;
  }
}
import { getCoadminMaintenanceBreakClient } from '@/features/maintenance/maintenanceBreak';
import { GameLogin, getGameLoginsByCoadmin } from '@/features/games/gameLogins';
import {
  getPlayerGameLoginsByCoadminSqlFirst,
  PlayerGameLogin,
} from '@/features/games/playerGameLogins';
import {
  getCompletedPlayerGameRequestsByCoadmin,
  getPendingPlayerGameRequestsByCoadmin,
  PlayerGameRequest,
  PlayerGameRequestStatus,
  PlayerGameRequestType,
} from '@/features/games/playerGameRequests';
import { getPlayersByCoadminSqlFirst, PlayerUser } from '@/features/users/adminUsers';
import {
  automationJobTtl,
  completedCarerTaskTtl,
  completedPlayerGameRequestTtl,
} from '@/lib/firestore/ttl';

export type CarerTaskType =
  | 'create_game_username'
  | 'reset_password'
  | 'recreate_username'
  | PlayerGameRequestType;
export type CarerTaskStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'urgent';

export type CarerTask = {
  id: string;
  coadminUid: string;
  type: CarerTaskType;
  playerUid: string;
  playerUsername: string;
  gameName: string;
  amount?: number | null;
  requestId?: string | null;
  status: CarerTaskStatus;
  assignedCarerUid: string | null;
  assignedCarer?: string | null;
  assignedCarerUsername?: string | null;
  claimedStatus?: string | null;
  claimedAt?: Date | null;
  claimedByUid?: string | null;
  claimedByUsername?: string | null;
  lastHeartbeatAt?: Date | null;
  startedAt?: Date | null;
  expiresAt?: Date | null;
  completedAt?: Date | null;
  createdAt?: Date | null;
  isPoked?: boolean;
  pokedAt?: Date | null;
  pokeMessage?: string | null;
  completedByCarerUid?: string | null;
  completedByCarerUsername?: string | null;
  automationStatus?:
    | 'waiting'
    | 'running'
    | 'completed'
    | 'failed'
    | 'PLAYER_ACTIVE_IN_GAME'
    | 'retry_requested'
    | null;
  automationJobId?: string | null;
  automationUpdatedAt?: Date | null;
  automationError?: string | null;
  resetToPendingAt?: Date | null;
  returnedToPendingAt?: Date | null;
  pendingSince?: Date | null;
  currentUsername?: string | null;
  gameAccountUsername?: string | null;
  loginUrl?: string | null;
  gameLoginUrl?: string | null;
  lobbyUrl?: string | null;
  siteUrl?: string | null;
  baseUrl?: string | null;
  gameCredentialUsername?: string | null;
  gameCredentialPassword?: string | null;
};

function buildPendingTaskResetFields(): Record<string, unknown> {
  return {
    status: 'pending',
    assignedCarerUid: null,
    assignedCarer: null,
    assignedCarerUsername: null,
    claimedStatus: null,
    claimedAt: null,
    claimedByUid: null,
    claimedByUsername: null,
    startedAt: null,
    runningAt: null,
    expiresAt: null,
    completedAt: null,
    cancelledAt: null,
    failedAt: null,
    ttlExpiresAt: null,
    completedByCarerUid: null,
    completedByCarerUsername: null,
    automationStatus: null,
    automationJobId: null,
    linkedJobId: null,
    currentJobId: null,
    activeJobId: null,
    assignedJobStatus: null,
    automationError: null,
    error: null,
    failureReason: null,
    retryPending: true,
    resetToPendingAt: serverTimestamp(),
    returnedToPendingAt: serverTimestamp(),
    pendingSince: serverTimestamp(),
    lastHeartbeatAt: null,
    queuedAt: null,
    automationUpdatedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
}

function logCleanupCandidate(
  taskId: string,
  task: { status?: unknown; automationStatus?: unknown; failedAt?: unknown },
  reason: string
) {
  console.info(
    '[CLEANUP] candidate taskId=%s status=%s automationStatus=%s failedAt=%o reason=%s',
    taskId,
    String(task.status || '').trim() || null,
    String(task.automationStatus || '').trim() || null,
    task.failedAt || null,
    reason
  );
}

function shouldSkipTaskCleanup(
  taskId: string,
  task: {
    status?: unknown;
    assignedCarerUid?: unknown;
    assignedCarerUsername?: unknown;
    assignedCarer?: unknown;
    claimedByUid?: unknown;
    retryPending?: unknown;
    resetToPendingAt?: unknown;
    pendingSince?: unknown;
  },
  reason: string
) {
  logCleanupCandidate(taskId, task, reason);
  const status = String(task.status || '').trim().toLowerCase();
  if (status === 'pending') {
    console.info('[CLEANUP] skip pending taskId=%s', taskId);
    return true;
  }
  if (
    String(task.assignedCarerUid || '').trim() ||
    String(task.assignedCarerUsername || task.assignedCarer || '').trim() ||
    String(task.claimedByUid || '').trim()
  ) {
    console.info('[CLEANUP] skip assigned/visible taskId=%s', taskId);
    return true;
  }
  if (task.retryPending === true || task.resetToPendingAt || task.pendingSince) {
    console.info('[CLEANUP] skip retry-pending taskId=%s', taskId);
    return true;
  }
  console.info('[CLEANUP] deleting terminal taskId=%s reason=%s', taskId, reason);
  return false;
}

function logTaskResetPending(details: {
  taskId: string;
  oldStatus?: string | null;
  oldAutomationJobId?: string | null;
  oldLinkedJobId?: string | null;
}) {
  console.info('[TASK_RESET_PENDING] taskId=%s', details.taskId);
  console.info('[TASK_RESET_PENDING] oldStatus=%s', details.oldStatus || null);
  console.info('[TASK_RESET_PENDING] oldAutomationJobId=%s', details.oldAutomationJobId || null);
  console.info('[TASK_RESET_PENDING] oldLinkedJobId=%s', details.oldLinkedJobId || null);
  console.info('[TASK_RESET_PENDING] cleared stale automation fields');
  console.info('[TASK_RESET_PENDING] status=pending updatedAt=serverTimestamp');
}

async function forceRefreshTaskFromServer(
  taskId: string,
  taskRef?: ReturnType<typeof doc>,
  action = 'force_refresh'
) {
  if (isClientSqlReadMode()) {
    console.info('[CARER_POST_TASK_REFRESH_SKIPPED]', {
      taskId,
      action,
      sqlMode: true,
      reason: 'sql_listener_authoritative',
    });
    return null;
  }
  const ref = taskRef ?? doc(db, 'carerTasks', taskId);
  const snapshot = await getDocFromServer(ref);
  console.info('[FIRESTORE] forced server refresh taskId=%s', taskId);
  return snapshot;
}

function pendingTaskHasStaleAutomationState(task: CarerTask | undefined) {
  if (!task || task.status !== 'pending') {
    return false;
  }
  return Boolean(
    task.automationJobId ||
      task.automationStatus ||
      task.automationError ||
      task.claimedAt ||
      task.claimedByUid ||
      task.claimedStatus ||
      task.startedAt ||
      task.completedAt ||
      task.lastHeartbeatAt
  );
}

const CARER_TASK_LIVE_LISTENER_LIMIT = 150;
const CARER_TASK_COMPLETED_LISTENER_LIMIT = 50;
const CARER_TOTALS_HISTORY_LIMIT_PER_TYPE = 500;
const CARER_TOTALS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const RESET_TO_PENDING_SYNC_GUARD_MS = 5 * 60 * 1000;

export type CarerRewardSummary = {
  completedTaskCount: number;
  totalAwardNpr: number;
};

export type CarerEscalationAlert = {
  id: string;
  coadminUid: string;
  contextType?: 'task_help' | 'cashbox_inquiry';
  /** Who raised this alert (helps coadmin filter staff/player inquiries). */
  escalationFrom?: 'carer' | 'staff' | 'player' | 'risk_auto' | string | null;
  taskId?: string | null;
  playerUid?: string | null;
  playerUsername?: string | null;
  gameName?: string | null;
  message: string;
  createdByCarerUid: string;
  createdByCarerUsername: string;
  dismissedByUids?: string[];
  createdAt?: Date | null;
};

export type CarerRechargeRedeemTotals = {
  totalRechargeAmount: number;
  totalRedeemAmount: number;
};

const STUCK_TASK_TIMEOUT_MS = 10 * 60 * 1000;
const STUCK_AUTOMATION_JOB_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_AUTOMATION_RECOVERY_ATTEMPTS = 3;

type SyncTaskInput = {
  coadminUid: string;
  players: PlayerUser[];
  games: GameLogin[];
  logins: PlayerGameLogin[];
  pendingRequests: PlayerGameRequest[];
  completedRequests: PlayerGameRequest[];
};

function normalizeGameName(gameName: string) {
  return gameName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

function normalizeTaskUrl(value?: string | null) {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return null;
  }
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function normalizeTaskText(value?: string | null) {
  return String(value || '').trim() || null;
}

function resolveTaskGameAccess(game?: GameLogin | null) {
  const loginUrl = normalizeTaskUrl(game?.backendUrl || game?.siteUrl || '');
  const siteUrl = normalizeTaskUrl(game?.siteUrl || game?.frontendUrl || game?.backendUrl || '');

  return {
    loginUrl,
    gameLoginUrl: loginUrl,
    lobbyUrl: loginUrl,
    siteUrl,
    baseUrl: loginUrl || siteUrl,
    gameCredentialUsername: normalizeTaskText(game?.username || ''),
    gameCredentialPassword: normalizeTaskText(game?.password || ''),
  };
}

function getTimestampMs(value: unknown) {
  if (!value) {
    return 0;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    'toMillis' in value &&
    typeof (value as { toMillis?: unknown }).toMillis === 'function'
  ) {
    try {
      return Number((value as { toMillis: () => number }).toMillis()) || 0;
    } catch {
      return 0;
    }
  }
  return 0;
}

function usernameTaskId(
  coadminUid: string,
  playerUid: string,
  gameName: string
) {
  return `create_game_username__${coadminUid}__${playerUid}__${normalizeGameName(
    gameName
  )}`;
}

function resetPasswordTaskId(
  coadminUid: string,
  playerUid: string,
  gameName: string
) {
  return `reset_password__${coadminUid}__${playerUid}__${normalizeGameName(gameName)}`;
}

function recreateUsernameTaskId(
  coadminUid: string,
  playerUid: string,
  gameName: string
) {
  return `recreate_username__${coadminUid}__${playerUid}__${normalizeGameName(gameName)}`;
}

/** Deterministic `carerTasks` document id for a `playerGameRequests` doc. */
export function carerTaskDocIdForPlayerGameRequest(requestId: string) {
  return `request__${requestId}`;
}

function requestTaskId(requestId: string) {
  return carerTaskDocIdForPlayerGameRequest(requestId);
}

function isClaimablePendingTask(task: CarerTask) {
  return getEffectiveCarerTaskStatus(task) === 'pending';
}

function dedupeById<T extends { id: string }>(items: T[]) {
  return Array.from(new Map(items.map((item) => [item.id, item])).values());
}

function toCarerTask(docId: string, value: Omit<CarerTask, 'id'>): CarerTask {
  return {
    id: docId,
    ...value,
  };
}

function getTaskStatusFromRequestStatus(
  requestStatus: PlayerGameRequestStatus
): CarerTaskStatus {
  if (requestStatus === 'completed') {
    return 'completed';
  }
  if (
    requestStatus === 'failed' ||
    requestStatus === 'pending_review' ||
    requestStatus === 'dismissed'
  ) {
    return 'failed';
  }
  // Includes pending plus legacy poked from the removed poke flow.
  return 'pending';
}

function hasRetryablePendingRequestMarker(request: PlayerGameRequest) {
  const status = String(request.status || '').trim().toLowerCase();
  if (status !== 'pending_review' && status !== 'failed') {
    return false;
  }

  const resetFields = request as PlayerGameRequest & {
    resetToPendingAt?: unknown;
    returnedToPendingAt?: unknown;
    pendingSince?: unknown;
    retryPending?: unknown;
    retryableFailure?: unknown;
  };
  const resetMs = Math.max(
    getTimestampMs(resetFields.returnedToPendingAt),
    getTimestampMs(resetFields.resetToPendingAt),
    getTimestampMs(resetFields.pendingSince)
  );

  return Boolean(resetMs || resetFields.retryPending || resetFields.retryableFailure);
}

function getTaskStatusFromRequest(request: PlayerGameRequest): CarerTaskStatus {
  if (hasRetryablePendingRequestMarker(request)) {
    return 'pending';
  }
  return getTaskStatusFromRequestStatus(request.status);
}

function isActiveRequestLinkedTaskStatus(status: unknown) {
  const normalized = String(status || '').trim().toLowerCase();
  return normalized === 'pending' || normalized === 'poked' || normalized === 'pending_review';
}

function logRequestTaskSync(requestId: string, requestStatus: unknown, skipReason?: string) {
  console.info('[REQUEST_TASK_SYNC] requestId=%s', requestId);
  console.info('[REQUEST_TASK_SYNC] requestStatus=%s', String(requestStatus || '').trim() || null);
  if (skipReason) {
    console.info('[REQUEST_TASK_SYNC] skipCreate reason=%s', skipReason);
  }
}

function isRecentlyResetPendingTask(task: CarerTask | undefined) {
  if (!task || String(task.status || '').trim().toLowerCase() !== 'pending') {
    return false;
  }

  const resetMs = Math.max(
    getTimestampMs(task.returnedToPendingAt),
    getTimestampMs(task.resetToPendingAt),
    getTimestampMs(task.pendingSince)
  );

  return Boolean(resetMs) && Date.now() - resetMs < RESET_TO_PENDING_SYNC_GUARD_MS;
}

function buildCompletedTaskUpdate(values: {
  carerUid: string;
  carerUsername?: string | null;
}) {
  return {
    status: 'completed' as const,
    expiresAt: null,
    completedAt: serverTimestamp(),
    ttlExpiresAt: completedCarerTaskTtl(),
    automationStatus: 'completed' as const,
    automationUpdatedAt: serverTimestamp(),
    isPoked: false,
    pokedAt: null,
    pokeMessage: null,
    completedByCarerUid: values.carerUid,
    completedByCarerUsername: values.carerUsername || null,
  };
}

function getNepalHour() {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kathmandu',
    hour: 'numeric',
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date());
  const hourPart = parts.find((part) => part.type === 'hour');
  const parsedHour = Number(hourPart?.value || '0');
  return Number.isFinite(parsedHour) ? parsedHour : 0;
}

function isNepalNightTime() {
  const hour = getNepalHour();
  return hour >= 22 || hour < 6;
}

/**
 * Carer reward tuning constants.
 * Keep these centralized so monthly payout targets are easy to calibrate.
 */
const DAY_USERNAME_REWARD_MIN_NPR = 5;
const DAY_USERNAME_REWARD_MAX_NPR = 10;
const NIGHT_USERNAME_REWARD_MIN_NPR = 8;
const NIGHT_USERNAME_REWARD_MAX_NPR = 15;

const DAY_RECHARGE_REDEEM_REWARD_MIN_NPR = 12;
const DAY_RECHARGE_REDEEM_REWARD_MAX_NPR = 22;
const NIGHT_RECHARGE_REDEEM_REWARD_MIN_NPR = 22;
const NIGHT_RECHARGE_REDEEM_REWARD_MAX_NPR = 35;

const NIGHT_BONUS_PERCENT_MIN = 10;
const NIGHT_BONUS_PERCENT_MAX = 15;

const URGENT_PENALTY_MIN_NPR = 0;
const URGENT_PENALTY_MAX_NPR = 30;

function randomInt(min: number, max: number) {
  const safeMin = Math.min(min, max);
  const safeMax = Math.max(min, max);
  return Math.floor(Math.random() * (safeMax - safeMin + 1)) + safeMin;
}

function calculateTaskRewardNpr(baseMin: number, baseMax: number) {
  return randomInt(baseMin, baseMax);
}

function calculateUsernameTaskBaseRewardNpr() {
  return isNepalNightTime()
    ? randomInt(NIGHT_USERNAME_REWARD_MIN_NPR, NIGHT_USERNAME_REWARD_MAX_NPR)
    : randomInt(DAY_USERNAME_REWARD_MIN_NPR, DAY_USERNAME_REWARD_MAX_NPR);
}

function calculateRechargeRedeemBaseRewardNpr() {
  return isNepalNightTime()
    ? calculateTaskRewardNpr(
        NIGHT_RECHARGE_REDEEM_REWARD_MIN_NPR,
        NIGHT_RECHARGE_REDEEM_REWARD_MAX_NPR
      )
    : calculateTaskRewardNpr(
        DAY_RECHARGE_REDEEM_REWARD_MIN_NPR,
        DAY_RECHARGE_REDEEM_REWARD_MAX_NPR
      );
}

/**
 * Formula order:
 * baseReward -> (night bonus) -> (urgent penalty) -> finalReward
 */
function applyNightBonusNpr(baseRewardNpr: number) {
  if (!isNepalNightTime()) {
    return baseRewardNpr;
  }

  const bonusPercent = randomInt(NIGHT_BONUS_PERCENT_MIN, NIGHT_BONUS_PERCENT_MAX);
  return Math.round(baseRewardNpr * (1 + bonusPercent / 100));
}

function applyUrgentPenaltyNpr(rewardWithBonusNpr: number, isUrgentOrPoked: boolean) {
  const penaltyNpr = isUrgentOrPoked
    ? randomInt(URGENT_PENALTY_MIN_NPR, URGENT_PENALTY_MAX_NPR)
    : 0;
  return Math.max(0, rewardWithBonusNpr - penaltyNpr);
}

function mapCarerEscalationAlert(
  docId: string,
  value: Omit<CarerEscalationAlert, 'id'>
) {
  return {
    id: docId,
    ...value,
  } satisfies CarerEscalationAlert;
}

async function getCurrentCarerIdentity() {
  if (isClientSqlReadMode()) {
    const session = await resolveSqlSessionUser();
    if (!session?.uid) {
      throw new Error('Session changed. Please refresh.');
    }
    console.info('[CARER_ESCALATION_SQL_IDENTITY]', {
      action: 'carer_identity',
      carerUid: session.uid,
      coadminUid: session.coadminUid ?? null,
      role: session.role ?? 'carer',
      identitySource: 'app_session_sql',
      firestoreAttempted: false,
    });
    return {
      uid: session.uid,
      username: session.username?.trim() || 'Carer',
    };
  }

  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error('Not authenticated.');
  }

  const userSnap = await getDoc(doc(db, 'users', currentUser.uid));
  if (!userSnap.exists()) {
    throw new Error('Current carer profile not found.');
  }

  const userData = userSnap.data() as { username?: string };
  return {
    uid: currentUser.uid,
    username: userData.username?.trim() || 'Carer',
  };
}

function mapCarerAuthErrorMessage(message: string) {
  if (/not authenticated|app session required/i.test(message)) {
    return 'Session changed. Please refresh.';
  }
  return message;
}

async function getAuthHeaders(
  action?: string,
  audit?: {
    logResetPasswordAudit?: boolean;
    expectedCarerUid?: string | null;
    file?: string;
    functionName?: string;
  }
) {
  const sqlMode = isClientSqlReadMode();
  if (sqlMode) {
    const headers = await getStaffAppSessionApiHeaders(true);
    const hasAppSessionId = Boolean(
      headers['X-App-Session-Id'] || headers['x-app-session-id']
    );
    if (action) {
      console.info('[CARER_TASK_ACTION_SQL_HEADERS]', {
        action,
        route: 'carer_task_action',
        hasAppSessionId,
        authSource: 'app_session_sql',
        firebaseAttempted: false,
      });
    }
    if (audit?.logResetPasswordAudit) {
      console.info('[CARER_RESET_PASSWORD_AUTH_AUDIT]', {
        file: audit.file || 'features/games/carerTasks.ts',
        function: audit.functionName || 'getAuthHeaders',
        authSource: 'app_session_sql',
        hasAppSessionId,
        firebaseCurrentUserUid: auth.currentUser?.uid || null,
        expectedCarerUid: audit.expectedCarerUid ?? null,
        firebaseAttempted: false,
        reason: action || 'carer_task_action',
      });
    }
    return headers;
  }
  if (audit?.logResetPasswordAudit) {
    console.info('[CARER_RESET_PASSWORD_AUTH_AUDIT]', {
      file: audit.file || 'features/games/carerTasks.ts',
      function: audit.functionName || 'getAuthHeaders',
      authSource: 'firebase_token',
      hasAppSessionId: Boolean(getLocalAppSessionId()),
      firebaseCurrentUserUid: auth.currentUser?.uid || null,
      expectedCarerUid: audit.expectedCarerUid ?? null,
      firebaseAttempted: true,
      reason: action || 'carer_task_action',
    });
  }
  return getFirebaseApiHeaders(true);
}

async function getMirrorAuthHeaders() {
  if (isClientSqlReadMode()) {
    return getSqlApiReadHeaders(true);
  }
  const token = await auth.currentUser?.getIdToken();
  if (!token) {
    return null;
  }
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    ...getAppSessionRequestHeaders(),
  };
}

async function mirrorAutomationJobCacheBestEffort(jobId: string) {
  const cleanJobId = String(jobId || '').trim();
  if (!cleanJobId) return;
  try {
    const response = await fetch('/api/automation-jobs/cache/mirror', {
      method: 'POST',
      headers: await getAuthHeaders('mirror_automation_job'),
      body: JSON.stringify({ jobId: cleanJobId }),
    });
    if (!response.ok) {
      console.error('[AUTOMATION_JOBS_CACHE] mirror failed', {
        jobId: cleanJobId,
        status: response.status,
      });
    }
  } catch (error) {
    console.error('[AUTOMATION_JOBS_CACHE] mirror failed', { jobId: cleanJobId, error });
  }
}

async function mirrorCarerTaskCacheBestEffort(
  taskId: string,
  action: 'upsert' | 'tombstone' = 'upsert'
) {
  const cleanTaskId = String(taskId || '').trim();
  if (!cleanTaskId) return;
  try {
    const headers = await getMirrorAuthHeaders();
    if (!headers) return;
    const response = await fetch('/api/carer-tasks/cache/mirror', {
      method: 'POST',
      headers,
      body: JSON.stringify({ taskId: cleanTaskId, action }),
    });
    if (!response.ok) {
      const responseBody = await readCarerMirrorFailureBody(response);
      console.error('[CARER_TASKS_CACHE] mirror failed', {
        taskId: cleanTaskId,
        action,
        status: response.status,
        taskCount: 1,
        firstTaskId: cleanTaskId,
        lastTaskId: cleanTaskId,
        batchSize: 1,
        batchIndex: 1,
        totalBatches: 1,
        responseBody,
      });
    }
  } catch (error) {
    console.error('[CARER_TASKS_CACHE] mirror failed', {
      taskId: cleanTaskId,
      action,
      taskCount: 1,
      firstTaskId: cleanTaskId,
      lastTaskId: cleanTaskId,
      batchSize: 1,
      batchIndex: 1,
      totalBatches: 1,
      ...formatCarerMirrorClientError(error),
    });
  }
}

function formatCarerMirrorClientError(error: unknown) {
  const record =
    error instanceof Error
      ? (error as Error & {
          code?: string;
          detail?: string;
          constraint?: string;
          table?: string;
          column?: string;
        })
      : null;

  return {
    message: record?.message ?? String(error),
    stack: record?.stack ?? null,
    code: record?.code ?? null,
    detail: record?.detail ?? null,
    constraint: record?.constraint ?? null,
    table: record?.table ?? null,
    column: record?.column ?? null,
  };
}

async function readCarerMirrorFailureBody(response: Response) {
  try {
    return await response.json();
  } catch {
    try {
      return { rawBody: await response.text() };
    } catch {
      return null;
    }
  }
}

function carerMirrorBatchMeta(taskIds: string[]) {
  return {
    taskCount: taskIds.length,
    firstTaskId: taskIds[0] ?? null,
    lastTaskId: taskIds[taskIds.length - 1] ?? null,
    batchSize: taskIds.length,
    batchIndex: 1,
    totalBatches: 1,
  };
}

async function mirrorCarerTasksCacheBestEffort(
  taskIds: Iterable<string>,
  action: 'upsert' | 'tombstone' = 'upsert'
) {
  const cleanTaskIds = Array.from(new Set(Array.from(taskIds).map((id) => String(id || '').trim()).filter(Boolean)));
  if (!cleanTaskIds.length) return;
  const batchMeta = carerMirrorBatchMeta(cleanTaskIds);
  try {
    const headers = await getMirrorAuthHeaders();
    if (!headers) return;
    const response = await fetch('/api/carer-tasks/cache/mirror', {
      method: 'POST',
      headers,
      body: JSON.stringify({ taskIds: cleanTaskIds, action }),
    });
    if (!response.ok) {
      const responseBody = await readCarerMirrorFailureBody(response);
      console.error('[CARER_TASKS_CACHE] mirror failed', {
        action,
        status: response.status,
        ...batchMeta,
        responseBody,
      });
    }
  } catch (error) {
    console.error('[CARER_TASKS_CACHE] mirror failed', {
      action,
      ...batchMeta,
      ...formatCarerMirrorClientError(error),
    });
  }
}

async function mirrorPlayerGameRequestCacheBestEffort(
  requestId: string,
  action: 'upsert' | 'tombstone' = 'upsert'
) {
  const cleanRequestId = String(requestId || '').trim();
  if (!cleanRequestId) return;
  try {
    const headers = await getMirrorAuthHeaders();
    if (!headers) return;
    const response = await fetch('/api/player-game-requests/cache/mirror', {
      method: 'POST',
      headers,
      body: JSON.stringify({ requestId: cleanRequestId, action }),
    });
    if (!response.ok) {
      console.error('[PLAYER_GAME_REQUESTS_CACHE] mirror failed', {
        requestId: cleanRequestId,
        action,
        status: response.status,
      });
    }
  } catch (error) {
    console.error('[PLAYER_GAME_REQUESTS_CACHE] mirror failed', {
      requestId: cleanRequestId,
      action,
      error,
    });
  }
}

function readApiError(messageFallback: string, payload: unknown) {
  if (
    payload &&
    typeof payload === 'object' &&
    'error' in payload &&
    typeof (payload as { error?: unknown }).error === 'string'
  ) {
    return String((payload as { error: string }).error || messageFallback);
  }
  return messageFallback;
}

async function getCurrentUserIdentityForEscalation() {
  if (isClientSqlReadMode()) {
    const session = await resolveSqlSessionUser();
    if (!session?.uid) {
      throw new Error('Session changed. Please refresh.');
    }
    console.info('[CARER_ESCALATION_SQL_IDENTITY]', {
      action: 'escalation_identity',
      carerUid: session.uid,
      coadminUid: session.coadminUid ?? null,
      role: session.role ?? 'carer',
      identitySource: 'app_session_sql',
      firestoreAttempted: false,
    });
    return {
      uid: session.uid,
      username: session.username?.trim() || 'User',
      role: String(session.role || 'carer').trim().toLowerCase(),
      coadminUid: session.coadminUid ?? null,
    };
  }

  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error('Not authenticated.');
  }

  const userSnap = await getDoc(doc(db, 'users', currentUser.uid));
  if (!userSnap.exists()) {
    throw new Error('Current user profile not found.');
  }

  const userData = userSnap.data() as {
    username?: string;
    role?: string;
    coadminUid?: string | null;
  };

  return {
    uid: currentUser.uid,
    username: userData.username?.trim() || 'User',
    role: String(userData.role || '').trim().toLowerCase(),
    coadminUid: userData.coadminUid ?? null,
  };
}

function buildUsernameTask(
  coadminUid: string,
  player: PlayerUser,
  game: GameLogin
): CarerTask {
  const access = resolveTaskGameAccess(game);
  return toCarerTask(usernameTaskId(coadminUid, player.uid, game.gameName), {
    coadminUid,
    type: 'create_game_username',
    playerUid: player.uid,
    playerUsername: player.username || 'Player',
    gameName: game.gameName || 'Unknown Game',
    amount: null,
    requestId: null,
    status: 'pending',
    assignedCarerUid: null,
    assignedCarerUsername: null,
    startedAt: null,
    expiresAt: null,
    completedAt: null,
    createdAt: null,
    isPoked: false,
    pokedAt: null,
    pokeMessage: null,
    completedByCarerUid: null,
    completedByCarerUsername: null,
    ...access,
  });
}

function buildRequestTask(
  coadminUid: string,
  request: PlayerGameRequest,
  playerUsername: string,
  currentUsername?: string | null,
  game?: GameLogin | null
): CarerTask {
  const nextStatus = getTaskStatusFromRequest(request);
  const normalizedCurrentUsername = String(currentUsername || '').trim() || null;
  const access = resolveTaskGameAccess(game);

  return toCarerTask(requestTaskId(request.id), {
    coadminUid,
    type: request.type,
    playerUid: request.playerUid,
    playerUsername: playerUsername || 'Player',
    gameName: request.gameName || 'Unknown Game',
    amount: request.amount ?? null,
    requestId: request.id,
    status: nextStatus,
    assignedCarerUid: null,
    assignedCarerUsername: null,
    startedAt: null,
    expiresAt: null,
    completedAt: request.completedAt || null,
    createdAt: request.createdAt || null,
    isPoked: false,
    pokedAt: null,
    pokeMessage: null,
    completedByCarerUid: null,
    completedByCarerUsername: null,
    currentUsername: normalizedCurrentUsername,
    gameAccountUsername: normalizedCurrentUsername,
    ...access,
  });
}

/**
 * Same merge rules as {@link syncCarerTasks} for a single request-linked task.
 * Used by sync and by immediate upserts after player request mutations.
 */
export function computeRequestLinkedCarerTaskWrite(
  coadminUid: string,
  request: PlayerGameRequest,
  playerUsername: string,
  existingTask: CarerTask | undefined,
  currentUsername?: string | null,
  game?: GameLogin | null
): Record<string, unknown> {
  const task = buildRequestTask(coadminUid, request, playerUsername, currentUsername, game);
  const desiredStatus = task.status;
  const existingCompletedAt = existingTask?.completedAt || null;
  const existingCompletedByUid =
    existingTask?.completedByCarerUid || existingTask?.assignedCarerUid || null;
  const existingCompletedByUsername =
    existingTask?.completedByCarerUsername ||
    existingTask?.assignedCarerUsername ||
    null;
  const existingEffectiveStatus = existingTask
    ? getEffectiveCarerTaskStatus(existingTask)
    : null;
  const shouldKeepRecentPendingReset =
    isRecentlyResetPendingTask(existingTask) && desiredStatus !== 'pending';
  const shouldPreserveExistingStatus =
    shouldKeepRecentPendingReset ||
    (desiredStatus === 'pending' &&
      (existingEffectiveStatus === 'in_progress' ||
        existingEffectiveStatus === 'completed' ||
        existingEffectiveStatus === 'failed'));
  const nextStatus = shouldKeepRecentPendingReset
    ? 'pending'
    : shouldPreserveExistingStatus
    ? existingEffectiveStatus
    : desiredStatus;

  return {
    ...task,
    status: nextStatus,
    assignedCarerUid:
      nextStatus === 'in_progress'
        ? existingTask?.assignedCarerUid ?? null
        : nextStatus === 'urgent'
          ? existingTask?.assignedCarerUid ||
            existingCompletedByUid ||
            null
          : nextStatus === 'completed'
            ? existingTask?.assignedCarerUid ||
              existingCompletedByUid ||
              null
            : null,
    assignedCarerUsername:
      nextStatus === 'in_progress'
        ? existingTask?.assignedCarerUsername ?? null
        : nextStatus === 'urgent'
          ? existingTask?.assignedCarerUsername ||
            existingCompletedByUsername ||
            null
          : nextStatus === 'completed'
            ? existingTask?.assignedCarerUsername ||
              existingCompletedByUsername ||
              null
            : null,
    startedAt:
      nextStatus === 'in_progress'
        ? existingTask?.startedAt || serverTimestamp()
        : nextStatus === 'pending' || nextStatus === 'completed'
          ? null
          : existingTask?.startedAt ?? null,
    expiresAt:
      nextStatus === 'in_progress'
        ? existingTask?.expiresAt ?? null
        : nextStatus === 'pending' ||
            nextStatus === 'completed' ||
            nextStatus === 'urgent'
          ? null
          : existingTask?.expiresAt ?? null,
    completedAt:
      nextStatus === 'completed'
        ? request.completedAt || existingCompletedAt || serverTimestamp()
        : nextStatus === 'urgent'
          ? request.completedAt || existingCompletedAt || null
          : null,
    automationStatus:
      nextStatus === 'completed'
        ? 'completed'
        : nextStatus === 'pending'
          ? null
          : existingTask?.automationStatus ?? null,
    automationUpdatedAt:
      nextStatus === 'completed'
        ? serverTimestamp()
        : nextStatus === 'pending'
          ? serverTimestamp()
          : existingTask?.automationUpdatedAt ?? null,
    createdAt: request.createdAt || existingTask?.createdAt || serverTimestamp(),
    isPoked: false,
    pokedAt: null,
    pokeMessage: null,
    completedByCarerUid:
      nextStatus === 'completed' || nextStatus === 'urgent'
        ? existingCompletedByUid
        : null,
    completedByCarerUsername:
      nextStatus === 'completed' || nextStatus === 'urgent'
        ? existingCompletedByUsername
        : null,
    ...(nextStatus === 'pending' ? buildPendingTaskResetFields() : {}),
  };
}

/**
 * Upserts `carerTasks/{request__requestId}` from the current request document shape.
 * Call after every player-side create/update to the linked `playerGameRequests` doc.
 */
export async function upsertCarerTaskForPlayerGameRequest(
  request: PlayerGameRequest
): Promise<void> {
  const coadminUid = String(request.coadminUid || request.createdBy || '').trim();
  if (!request.id.trim() || !coadminUid) {
    return;
  }

  const authoritativeRequestSnap = await getDocFromServer(doc(db, 'playerGameRequests', request.id));
  if (!authoritativeRequestSnap.exists()) {
    logRequestTaskSync(request.id, 'missing', 'request_not_pending');
    return;
  }
  const authoritativeRequest = {
    id: authoritativeRequestSnap.id,
    ...(authoritativeRequestSnap.data() as Omit<PlayerGameRequest, 'id'>),
  } satisfies PlayerGameRequest;
  if (!isActiveRequestLinkedTaskStatus(authoritativeRequest.status)) {
    logRequestTaskSync(authoritativeRequest.id, authoritativeRequest.status, 'request_not_pending');
    return;
  }
  logRequestTaskSync(authoritativeRequest.id, authoritativeRequest.status);

  const playerSnap = await getDoc(doc(db, 'users', authoritativeRequest.playerUid));
  const playerUsername = playerSnap.exists()
    ? String((playerSnap.data() as { username?: string }).username || '').trim() ||
      'Player'
    : 'Player';

  const taskRef = doc(db, 'carerTasks', requestTaskId(authoritativeRequest.id));
  const existingSnap = await getDoc(taskRef);
  const existingTask = existingSnap.exists()
    ? toCarerTask(existingSnap.id, existingSnap.data() as Omit<CarerTask, 'id'>)
    : undefined;
  if (existingTask) {
    console.info('[PLAYER_GAME_REQUEST] client task upsert skipped existing server task', {
      requestId: authoritativeRequest.id,
      taskId: taskRef.id,
      type: authoritativeRequest.type,
      status: existingTask.status || null,
    });
    return;
  }
  const loginQuery = query(
    collection(db, 'playerGameLogins'),
    where('playerUid', '==', authoritativeRequest.playerUid)
  );
  const loginSnap = await getDocs(loginQuery);
  const normalizedRequestGame = normalizeGameName(authoritativeRequest.gameName || '');
  const coadminGames = await getGameLoginsByCoadmin(coadminUid);
  const matchedGame =
    coadminGames.find(
      (game) => normalizeGameName(String(game.gameName || '')) === normalizedRequestGame
    ) || null;
  const matchedLogin = loginSnap.docs
    .map((docSnap) => docSnap.data() as { gameName?: string; gameUsername?: string })
    .find(
      (entry) =>
        normalizeGameName(String(entry.gameName || '')) === normalizedRequestGame &&
        String(entry.gameUsername || '').trim().length > 0
    );
  const requestGameUsername = String(matchedLogin?.gameUsername || '').trim() || null;

  const payload = computeRequestLinkedCarerTaskWrite(
    coadminUid,
    authoritativeRequest,
    playerUsername,
    existingTask,
    requestGameUsername,
    matchedGame
  );
  await setDoc(taskRef, payload, { merge: true });
  void mirrorCarerTaskCacheBestEffort(taskRef.id);

  const { recordDevUsageEstimate } = await import('@/features/dev/devUsageEstimates');
  recordDevUsageEstimate({
    tasksCreated: existingSnap.exists() ? 0 : 1,
    estReads: 2,
    estWrites: 1,
  });
}

async function getCurrentCoadminTasks(coadminUid: string) {
  const tasksQuery = query(
    collection(db, 'carerTasks'),
    where('coadminUid', '==', coadminUid)
  );
  const snapshot = await getDocs(tasksQuery);

  return new Map(
    snapshot.docs.map((docSnap) => [
      docSnap.id,
      {
        id: docSnap.id,
        ...(docSnap.data() as Omit<CarerTask, 'id'>),
      } as CarerTask,
    ])
  );
}

export function getVisibleTaskForCarer(task: CarerTask, currentCarerUid: string) {
  const effectiveStatus = getEffectiveCarerTaskStatus(task);

  if (effectiveStatus === 'completed') {
    return {
      ...task,
      status: 'completed',
    } satisfies CarerTask;
  }

  if (effectiveStatus === 'urgent') {
    if (task.assignedCarerUid !== currentCarerUid) {
      return null;
    }

    return {
      ...task,
      status: 'urgent',
      startedAt: null,
      expiresAt: null,
    } satisfies CarerTask;
  }

  if (effectiveStatus === 'pending') {
    const assignedCarerUid = String(task.assignedCarerUid || '').trim();
    if (assignedCarerUid && assignedCarerUid !== currentCarerUid) {
      return null;
    }

    return {
      ...task,
      status: 'pending',
      assignedCarerUid: assignedCarerUid || null,
      assignedCarerUsername: assignedCarerUid ? task.assignedCarerUsername || null : null,
      startedAt: null,
      expiresAt: null,
    } satisfies CarerTask;
  }

  if (effectiveStatus === 'failed') {
    return null;
  }

  if (task.assignedCarerUid === currentCarerUid) {
    return task;
  }

  return null;
}

export async function getCurrentUserCoadminUid() {
  return getScopedCurrentUserCoadminUid();
}

export function getCarerTaskCountdown() {
  return 0;
}

export function getEffectiveCarerTaskStatus(task: CarerTask): CarerTaskStatus {
  return task.status;
}

export function isRealCompletedCarerTask(task: CarerTask): boolean {
  if (getEffectiveCarerTaskStatus(task) !== 'completed') {
    return false;
  }
  const automationStatus = String(task.automationStatus || '').trim().toLowerCase();
  if (
    automationStatus === 'failed' ||
    automationStatus === 'fake_redeem' ||
    automationStatus === 'dismissed' ||
    automationStatus === 'returned_to_pending' ||
    automationStatus === 'cancelled'
  ) {
    return false;
  }
  const lowerPoke = String(task.pokeMessage || '').toLowerCase();
  if (
    lowerPoke.includes('fake redeem') ||
    lowerPoke.includes('dismissed') ||
    lowerPoke.includes('cancelled') ||
    lowerPoke.includes('returned to pending')
  ) {
    return false;
  }
  return true;
}

export async function syncCarerTasks({
  coadminUid,
  players,
  games,
  logins,
  pendingRequests,
  completedRequests,
}: SyncTaskInput) {
  const existingTasks = await getCurrentCoadminTasks(coadminUid);
  const activePlayerUidSet = new Set(players.map((player) => player.uid));
  const playerNameMap = new Map(
    players.map((player) => [player.uid, player.username || 'Player'])
  );
  const loginKeySet = new Set(
    logins.map(
      (login) => `${login.playerUid}::${normalizeGameName(login.gameName || '')}`
    )
  );
  const loginUsernameByPlayerGame = new Map(
    logins.map((login) => [
      `${login.playerUid}::${normalizeGameName(login.gameName || '')}`,
      String(login.gameUsername || '').trim() || null,
    ])
  );
  const allRequests = [...pendingRequests, ...completedRequests];
  const requestIds = new Set(allRequests.map((request) => request.id));
  const gameByNormalizedName = new Map(
    games.map((game) => [normalizeGameName(game.gameName || ''), game] as const)
  );

  const batch = writeBatch(db);
  let changed = false;
  const changedTaskIds = new Set<string>();
  const resetTaskIdsToRefresh = new Set<string>();
  const syncCandidateTaskIds = new Set<string>();
  for (const player of players) {
    for (const game of games) {
      syncCandidateTaskIds.add(usernameTaskId(coadminUid, player.uid, game.gameName));
    }
  }
  for (const request of allRequests) {
    syncCandidateTaskIds.add(requestTaskId(request.id));
  }
  for (const taskId of existingTasks.keys()) {
    syncCandidateTaskIds.add(taskId);
  }

  for (const player of players) {
    for (const game of games) {
      const taskId = usernameTaskId(coadminUid, player.uid, game.gameName);
      const taskRef = doc(db, 'carerTasks', taskId);
      const existingTask = existingTasks.get(taskId);
      const hasLogin = loginKeySet.has(
        `${player.uid}::${normalizeGameName(game.gameName || '')}`
      );

      if (!existingTask && !hasLogin) {
        const task = buildUsernameTask(coadminUid, player, game);
        batch.set(taskRef, {
          ...task,
          createdAt: serverTimestamp(),
        });
        changedTaskIds.add(taskId);
        changed = true;
        continue;
      }

      if (!existingTask) {
        continue;
      }

      if (hasLogin && existingTask.status !== 'completed') {
        const access = resolveTaskGameAccess(game);
        // Guard: skip marking completed if server currently reports pending (reset-to-pending race)
        try {
          const serverSnap = await getDocFromServer(taskRef);
          if (serverSnap.exists()) {
            const latest = serverSnap.data() as Record<string, any>;
            if (String(latest.status || '').trim().toLowerCase() === 'pending') {
              console.info('[JOB_COMPLETE_GUARD] skip sync mark completed due to pending reset taskId=%s', taskRef.id);
            } else {
              batch.update(taskRef, {
                playerUsername: player.username || 'Player',
                gameName: game.gameName || 'Unknown Game',
                status: 'completed',
                automationStatus: 'completed',
                automationUpdatedAt: serverTimestamp(),
                assignedCarerUid: existingTask.assignedCarerUid ?? null,
                assignedCarerUsername: existingTask.assignedCarerUsername ?? null,
                startedAt: existingTask.startedAt ?? null,
                expiresAt: null,
                completedAt: serverTimestamp(),
                ttlExpiresAt: completedCarerTaskTtl(),
                isPoked: false,
                pokedAt: null,
                pokeMessage: null,
                completedByCarerUid:
                  existingTask.completedByCarerUid || existingTask.assignedCarerUid || null,
                completedByCarerUsername:
                  existingTask.completedByCarerUsername ||
                  existingTask.assignedCarerUsername ||
                  null,
                ...access,
              });
              changedTaskIds.add(taskId);
            }
          }
        } catch (err) {
          // If server read fails, fall back to applying the update to avoid silent drift
          batch.update(taskRef, {
            playerUsername: player.username || 'Player',
            gameName: game.gameName || 'Unknown Game',
            status: 'completed',
            automationStatus: 'completed',
            automationUpdatedAt: serverTimestamp(),
            assignedCarerUid: existingTask.assignedCarerUid ?? null,
            assignedCarerUsername: existingTask.assignedCarerUsername ?? null,
            startedAt: existingTask.startedAt ?? null,
            expiresAt: null,
            completedAt: serverTimestamp(),
            ttlExpiresAt: completedCarerTaskTtl(),
            isPoked: false,
            pokedAt: null,
            pokeMessage: null,
            completedByCarerUid:
              existingTask.completedByCarerUid || existingTask.assignedCarerUid || null,
            completedByCarerUsername:
              existingTask.completedByCarerUsername ||
              existingTask.assignedCarerUsername ||
              null,
            ...access,
          });
          changedTaskIds.add(taskId);
        }
        changed = true;
        continue;
      }

      if (!hasLogin && existingTask.status === 'completed' && !existingTask.requestId) {
        const access = resolveTaskGameAccess(game);
        batch.update(taskRef, {
          playerUsername: player.username || 'Player',
          gameName: game.gameName || 'Unknown Game',
          ...buildPendingTaskResetFields(),
          isPoked: false,
          pokedAt: null,
          pokeMessage: null,
          ...access,
        });
        changedTaskIds.add(taskId);
        logTaskResetPending({
          taskId,
          oldStatus: existingTask.status,
          oldAutomationJobId: existingTask.automationJobId || null,
          oldLinkedJobId: null,
        });
        resetTaskIdsToRefresh.add(taskId);
        changed = true;
        continue;
      }

      if (
        existingTask.playerUsername !== (player.username || 'Player') ||
        existingTask.gameName !== (game.gameName || 'Unknown Game') ||
        existingTask.loginUrl !== (resolveTaskGameAccess(game).loginUrl ?? null) ||
        existingTask.gameCredentialUsername !==
          (resolveTaskGameAccess(game).gameCredentialUsername ?? null) ||
        existingTask.siteUrl !== (resolveTaskGameAccess(game).siteUrl ?? null)
      ) {
        const access = resolveTaskGameAccess(game);
        batch.update(taskRef, {
          playerUsername: player.username || 'Player',
          gameName: game.gameName || 'Unknown Game',
          ...access,
        });
        changedTaskIds.add(taskId);
        changed = true;
      }
    }
  }

  for (const request of allRequests) {
    const taskId = requestTaskId(request.id);
    const taskRef = doc(db, 'carerTasks', taskId);
    const existingTask = existingTasks.get(taskId);
    const authoritativeRequestSnap = await getDocFromServer(doc(db, 'playerGameRequests', request.id));
    if (!authoritativeRequestSnap.exists()) {
      logRequestTaskSync(request.id, 'missing', 'request_not_pending');
      continue;
    }
    const authoritativeRequest = {
      id: authoritativeRequestSnap.id,
      ...(authoritativeRequestSnap.data() as Omit<PlayerGameRequest, 'id'>),
    } satisfies PlayerGameRequest;
    if (!isActiveRequestLinkedTaskStatus(authoritativeRequest.status)) {
      logRequestTaskSync(authoritativeRequest.id, authoritativeRequest.status, 'request_not_pending');
      continue;
    }
    logRequestTaskSync(authoritativeRequest.id, authoritativeRequest.status);
    const desiredStatus = getTaskStatusFromRequest(authoritativeRequest);
    if (
      desiredStatus === 'pending' &&
      authoritativeRequest.status === 'pending_review' &&
      hasRetryablePendingRequestMarker(authoritativeRequest)
    ) {
      console.info('[RETRY_RESET] retryable failure forced task pending', {
        taskId,
        requestId: authoritativeRequest.id,
        requestStatus: authoritativeRequest.status,
      });
    }
    if (isRecentlyResetPendingTask(existingTask) && desiredStatus !== 'pending') {
      console.info('[carerTasks] skip terminal request overwrite after pending reset', {
        taskId,
        requestId: authoritativeRequest.id,
        requestStatus: authoritativeRequest.status,
        resetToPendingAt: existingTask?.resetToPendingAt || null,
        returnedToPendingAt: existingTask?.returnedToPendingAt || null,
      });
      continue;
    }
    const playerUsername = playerNameMap.get(authoritativeRequest.playerUid) || 'Player';
    const loginUsername =
      loginUsernameByPlayerGame.get(
        `${authoritativeRequest.playerUid}::${normalizeGameName(authoritativeRequest.gameName || '')}`
      ) || null;
    const payload = computeRequestLinkedCarerTaskWrite(
      coadminUid,
      authoritativeRequest,
      playerUsername,
      existingTask,
      loginUsername,
      gameByNormalizedName.get(normalizeGameName(authoritativeRequest.gameName || '')) || null
    );

    batch.set(taskRef, payload, { merge: true });
    changedTaskIds.add(taskId);
    if (pendingTaskHasStaleAutomationState(existingTask) && String(payload.status || '') === 'pending') {
      resetTaskIdsToRefresh.add(taskId);
    }
    changed = true;
  }

  for (const existingTask of existingTasks.values()) {
    if (!activePlayerUidSet.has(existingTask.playerUid)) {
      if (existingTask.status === 'completed') {
        continue;
      }

      // Guard: read latest server state and skip if it was reset to pending
      try {
        const serverSnap = await getDocFromServer(doc(db, 'carerTasks', existingTask.id));
        if (serverSnap.exists()) {
          const latest = serverSnap.data() as Record<string, any>;
          if (String(latest.status || '').trim().toLowerCase() === 'pending') {
            console.info('[JOB_COMPLETE_GUARD] skip sync mark completed due to pending reset taskId=%s', existingTask.id);
          } else {
            batch.update(doc(db, 'carerTasks', existingTask.id), {
              status: 'completed',
              automationStatus: 'completed',
              automationUpdatedAt: serverTimestamp(),
              assignedCarerUid: existingTask.assignedCarerUid ?? null,
              assignedCarerUsername: existingTask.assignedCarerUsername ?? null,
              startedAt: null,
              expiresAt: null,
              completedAt: existingTask.completedAt ?? serverTimestamp(),
              ttlExpiresAt: completedCarerTaskTtl(),
              isPoked: false,
              pokedAt: null,
              pokeMessage: null,
              completedByCarerUid:
                existingTask.completedByCarerUid || existingTask.assignedCarerUid || null,
              completedByCarerUsername:
                existingTask.completedByCarerUsername ||
                existingTask.assignedCarerUsername ||
                null,
            });
            changedTaskIds.add(existingTask.id);
            changed = true;
          }
        }
      } catch (err) {
        batch.update(doc(db, 'carerTasks', existingTask.id), {
          status: 'completed',
          automationStatus: 'completed',
          automationUpdatedAt: serverTimestamp(),
          assignedCarerUid: existingTask.assignedCarerUid ?? null,
          assignedCarerUsername: existingTask.assignedCarerUsername ?? null,
          startedAt: null,
          expiresAt: null,
          completedAt: existingTask.completedAt ?? serverTimestamp(),
          ttlExpiresAt: completedCarerTaskTtl(),
          isPoked: false,
          pokedAt: null,
          pokeMessage: null,
          completedByCarerUid:
            existingTask.completedByCarerUid || existingTask.assignedCarerUid || null,
          completedByCarerUsername:
            existingTask.completedByCarerUsername ||
            existingTask.assignedCarerUsername ||
            null,
        });
        changedTaskIds.add(existingTask.id);
        changed = true;
      }
      continue;
    }

    if (existingTask.type === 'create_game_username') {
      continue;
    }

    if (!existingTask.requestId || requestIds.has(existingTask.requestId)) {
      continue;
    }

    if (existingTask.status === 'completed') {
      continue;
    }

    try {
      const serverSnap = await getDocFromServer(doc(db, 'carerTasks', existingTask.id));
      if (serverSnap.exists()) {
        const latest = serverSnap.data() as Record<string, any>;
        if (String(latest.status || '').trim().toLowerCase() === 'pending') {
          console.info('[JOB_COMPLETE_GUARD] skip sync mark completed due to pending reset taskId=%s', existingTask.id);
        } else {
          batch.update(doc(db, 'carerTasks', existingTask.id), {
            status: 'completed',
            automationStatus: 'completed',
            automationUpdatedAt: serverTimestamp(),
            assignedCarerUid: existingTask.assignedCarerUid ?? null,
            assignedCarerUsername: existingTask.assignedCarerUsername ?? null,
            startedAt: null,
            expiresAt: null,
            completedAt: serverTimestamp(),
            ttlExpiresAt: completedCarerTaskTtl(),
            isPoked: false,
            pokedAt: null,
            pokeMessage: null,
            completedByCarerUid:
              existingTask.completedByCarerUid || existingTask.assignedCarerUid || null,
            completedByCarerUsername:
              existingTask.completedByCarerUsername ||
              existingTask.assignedCarerUsername ||
              null,
          });
          changedTaskIds.add(existingTask.id);
          changed = true;
        }
      }
    } catch (err) {
      batch.update(doc(db, 'carerTasks', existingTask.id), {
        status: 'completed',
        automationStatus: 'completed',
        automationUpdatedAt: serverTimestamp(),
        assignedCarerUid: existingTask.assignedCarerUid ?? null,
        assignedCarerUsername: existingTask.assignedCarerUsername ?? null,
        startedAt: null,
        expiresAt: null,
        completedAt: serverTimestamp(),
        ttlExpiresAt: completedCarerTaskTtl(),
        isPoked: false,
        pokedAt: null,
        pokeMessage: null,
        completedByCarerUid:
          existingTask.completedByCarerUid || existingTask.assignedCarerUid || null,
        completedByCarerUsername:
          existingTask.completedByCarerUsername ||
          existingTask.assignedCarerUsername ||
          null,
      });
      changedTaskIds.add(existingTask.id);
      changed = true;
    }
  }

  if (changed) {
    await batch.commit();
    if (changedTaskIds.size > 0) {
      console.info('[CARER_TASKS_SYNC] mirror changed ids', {
        changedCount: changedTaskIds.size,
        candidateCount: syncCandidateTaskIds.size,
      });
      void mirrorCarerTasksCacheBestEffort(changedTaskIds);
    } else {
      console.warn('[CARER_TASKS_SYNC] changed true but no changedTaskIds', {
        candidateCount: syncCandidateTaskIds.size,
      });
    }
    await Promise.all(
      Array.from(resetTaskIdsToRefresh).map((taskId) =>
        forceRefreshTaskFromServer(taskId, doc(db, 'carerTasks', taskId))
      )
    );
  }
}

async function dropPendingRechargeRequestsWithoutEnoughCoin(
  pendingRequests: PlayerGameRequest[],
  players: PlayerUser[]
) {
  const rechargeRequests = pendingRequests.filter((request) => request.type === 'recharge');

  if (rechargeRequests.length === 0) {
    return pendingRequests;
  }

  const coinByPlayerUid = new Map(
    players.map((player) => [player.uid, Number(player.coin || 0)] as const)
  );

  const invalidRechargeIds = rechargeRequests
    .filter((request) => {
      if (request.coinDeductedOnRequest) {
        return false;
      }
      const playerCoin = Number(coinByPlayerUid.get(request.playerUid) || 0);
      const rechargeAmount = Math.max(0, Number(request.amount || 0));
      return playerCoin < rechargeAmount;
    })
    .map((request) => request.id);

  if (invalidRechargeIds.length > 0) {
    // Keep tasks visible for manual handling. Carer can dismiss explicitly from UI.
    console.info('[carerTasks] keeping pending recharge tasks with low coin', {
      invalidRechargeIds,
    });
  }
  return pendingRequests;
}

export type CarerBaseData = {
  players: PlayerUser[];
  games: GameLogin[];
  logins: PlayerGameLogin[];
};

const CARER_BASE_DATA_TIMEOUT_MS = 10_000;

type CombinedBaseDataReadResult =
  | { ok: true; data: CarerBaseData }
  | { ok: false; reason: string };

const carerBaseDataInflight = new Map<string, Promise<CarerBaseData>>();

async function tryReadCarerBaseDataFromCombinedApi(
  coadminUid: string
): Promise<CombinedBaseDataReadResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CARER_BASE_DATA_TIMEOUT_MS);

  try {
    const headers = await getFirebaseApiHeaders(false);
    const appSessionId = getLocalAppSessionId();
    console.info('[APP_SESSION_HEADER_DEBUG]', {
      route: '/api/carer/base-data',
      hasHeader: Boolean(appSessionId),
      sessionIdPrefix: appSessionId ? appSessionId.slice(0, 8) : null,
      reason: appSessionId ? 'header_attached' : 'missing_header',
    });

    const response = await fetch(
      `/api/carer/base-data?coadminUid=${encodeURIComponent(coadminUid)}`,
      {
        method: 'GET',
        headers,
        cache: 'no-store',
        signal: controller.signal,
      }
    );

    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
      players?: PlayerUser[];
      gameLogins?: GameLogin[];
      playerGameLogins?: PlayerGameLogin[];
      source?: string;
      snapshotAt?: string;
    };

    logCarerPageRequestAudit({
      route: `/api/carer/base-data?coadminUid=${encodeURIComponent(coadminUid)}`,
      method: 'GET',
      status: response.status,
      coadminUid,
      role: 'carer',
      authPath: 'firebase_bearer_only_missing_app_session_header',
      reason: response.ok
        ? 'base_data_ok'
        : String(payload.error || `api_status_${response.status}`),
    });

    if (!response.ok) {
      return { ok: false, reason: `api_status_${response.status}` };
    }

    if (
      !Array.isArray(payload.players) ||
      !Array.isArray(payload.gameLogins) ||
      !Array.isArray(payload.playerGameLogins)
    ) {
      return { ok: false, reason: 'invalid_payload' };
    }

    console.info('[CARER_BASE_DATA] client hit', {
      coadminUid,
      source: payload.source || 'unknown',
      snapshotAt: payload.snapshotAt || null,
      counts: {
        players: payload.players.length,
        gameLogins: payload.gameLogins.length,
        playerGameLogins: payload.playerGameLogins.length,
      },
      durationMs: Date.now() - startedAt,
    });

    return {
      ok: true,
      data: {
        players: payload.players,
        games: payload.gameLogins,
        logins: payload.playerGameLogins,
      },
    };
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof Error && error.name === 'AbortError' ? 'api_timeout' : 'api_failed',
    };
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeCarerBaseData(baseData: CarerBaseData): CarerBaseData {
  return {
    players: dedupeById(
      baseData.players.filter((player) => player.status !== 'disabled')
    ),
    games: dedupeById(baseData.games),
    logins: dedupeById(baseData.logins),
  };
}

export async function fetchCarerBaseDataForCoadmin(coadminUid: string): Promise<CarerBaseData> {
  const cleanCoadminUid = String(coadminUid || '').trim();
  if (!cleanCoadminUid) {
    return { players: [], games: [], logins: [] };
  }

  const inflight = carerBaseDataInflight.get(cleanCoadminUid);
  if (inflight) {
    console.info('[CARER_BASE_DATA_CLIENT]', {
      source: 'combined',
      usedFallback: false,
      reason: 'inflight_reuse',
      coadminUid: cleanCoadminUid,
    });
    return inflight;
  }

  const promise = (async () => {
    const startedAt = Date.now();
    const combined = await tryReadCarerBaseDataFromCombinedApi(cleanCoadminUid);

    if (combined.ok) {
      console.info('[CARER_BASE_DATA_CLIENT]', {
        source: 'combined',
        usedFallback: false,
        reason: 'combined_ok',
        coadminUid: cleanCoadminUid,
        durationMs: Date.now() - startedAt,
      });
      return normalizeCarerBaseData(combined.data);
    }

    console.info('[CARER_BASE_DATA_CLIENT]', {
      source: 'combined',
      usedFallback: false,
      reason: combined.reason,
      coadminUid: cleanCoadminUid,
      durationMs: Date.now() - startedAt,
    });
    return normalizeCarerBaseData({ players: [], games: [], logins: [] });
  })().finally(() => {
    carerBaseDataInflight.delete(cleanCoadminUid);
  });

  carerBaseDataInflight.set(cleanCoadminUid, promise);
  return promise;
}

export async function syncCarerTasksForCoadmin(
  coadminUid: string,
  baseData: CarerBaseData
) {
  const cleanCoadminUid = String(coadminUid || '').trim();
  const { players, games, logins } = baseData;

  if (isClientSqlReadMode()) {
    console.info('[CARER_TASK_SYNC_SKIPPED]', {
      coadminUid: cleanCoadminUid,
      reason: 'sql_mode_authoritative_sse',
    });
    return {
      players,
      games,
      logins,
      pendingRequests: [],
      completedRequests: [],
    };
  }

  const pendingRequestsRaw = await getPendingPlayerGameRequestsByCoadmin(cleanCoadminUid);
  const pendingRequests = await dropPendingRechargeRequestsWithoutEnoughCoin(
    pendingRequestsRaw.filter((request) => players.some((player) => player.uid === request.playerUid)),
    players
  );
  const completedRequests = (await getCompletedPlayerGameRequestsByCoadmin(cleanCoadminUid)).filter(
    (request) => players.some((player) => player.uid === request.playerUid)
  );

  const maintenanceBreak = await getCoadminMaintenanceBreakClient(cleanCoadminUid);
  if (maintenanceBreak.enabled) {
    console.info(`[MAINTENANCE] sync skipped for coadmin=${cleanCoadminUid}`);
    return {
      players,
      games,
      logins,
      pendingRequests,
      completedRequests,
    };
  }

  await syncCarerTasks({
    coadminUid: cleanCoadminUid,
    players,
    games,
    logins,
    pendingRequests,
    completedRequests,
  });

  return {
    players,
    games,
    logins,
    pendingRequests,
    completedRequests,
  };
}

export function listenToAvailableCarerTasks(
  coadminUid: string,
  currentCarerUid: string,
  callback: (tasks: CarerTask[]) => void,
  onError?: (error: Error) => void
) {
  if (assertClientFirestoreDisabled('carer_tasks_available_listener', 'onSnapshot', { coadminUid })) {
    callback([]);
    return () => {};
  }

  const activeTasksQuery = query(
    collection(db, 'carerTasks'),
    where('coadminUid', '==', coadminUid),
    where('status', 'in', ['pending', 'in_progress', 'urgent']),
    orderBy('createdAt', 'desc'),
    limit(CARER_TASK_LIVE_LISTENER_LIMIT)
  );
  const completedTasksQuery = query(
    collection(db, 'carerTasks'),
    where('coadminUid', '==', coadminUid),
    where('status', '==', 'completed'),
    orderBy('completedAt', 'desc'),
    limit(CARER_TASK_COMPLETED_LISTENER_LIMIT)
  );
  let activeTasks: CarerTask[] = [];
  let completedTasks: CarerTask[] = [];
  /** Block stale cached snapshots from re-adding tasks removed via docChanges. */
  const recentlyRemovedActiveTaskIds = new Set<string>();
  const debugLogs = isCarerTaskDebugLoggingEnabled();

  if (debugLogs) {
    console.info(
      '[CARER_TASKS_LIVE] listener attached coadminUid=%s carerUid=%s activeLimit=%s completedLimit=%s',
      coadminUid,
      currentCarerUid,
      CARER_TASK_LIVE_LISTENER_LIMIT,
      CARER_TASK_COMPLETED_LISTENER_LIMIT
    );
  }

  const emit = () => {
    const byId = new Map<string, CarerTask>();
    for (const task of [...activeTasks, ...completedTasks]) {
      byId.set(task.id, task);
    }
    callback(Array.from(byId.values()));
  };

  const mapVisibleTasks = (
    docs: Array<{ id: string; data: () => unknown }>,
    tab: 'active' | 'completed' = 'active'
  ) =>
    docs
      .map((docSnap) => {
        const raw = docSnap.data() as Omit<CarerTask, 'id'>;
        const task = {
          id: docSnap.id,
          ...raw,
        } satisfies CarerTask;

        const visible = getVisibleTaskForCarer(task, currentCarerUid);
        const included = Boolean(visible);
        const reason = included ? 'visible' : 'filtered_out';
        if (debugLogs) {
          console.info(
            '[TASK_VISIBILITY] taskId=%s existsInSnapshot=%s status=%s automationStatus=%s tab=%s included=%s reason=%s',
            docSnap.id,
            true,
            String(raw.status || '').trim() || null,
            String(raw.automationStatus || '').trim() || null,
            tab,
            included,
            reason
          );
        }

        return visible;
      })
      .filter((task): task is CarerTask => Boolean(task));

  const applyActiveTasksSnapshot = (
    docs: Array<{ id: string; data: () => unknown }>,
    docChanges: Array<{ type: string; doc: { id: string } }>,
    fromCache: boolean,
    hasPendingWrites: boolean
  ) => {
    const removedIdsThisSnapshot = new Set<string>();

    for (const change of docChanges) {
      if (change.type !== 'removed') {
        continue;
      }
      const taskId = change.doc.id;
      removedIdsThisSnapshot.add(taskId);
      recentlyRemovedActiveTaskIds.add(taskId);
      console.info(
        '[CARER_TASKS_LISTENER] removed taskId=%s fromCache=%s hasPendingWrites=%s',
        taskId,
        fromCache,
        hasPendingWrites
      );
    }

    let nextActiveTasks = mapVisibleTasks(docs, 'active');

    // Removed docChanges win over stale docs still present in snapshot.docs (cache race).
    if (removedIdsThisSnapshot.size > 0) {
      nextActiveTasks = nextActiveTasks.filter((task) => !removedIdsThisSnapshot.has(task.id));
    }

    if (fromCache) {
      if (recentlyRemovedActiveTaskIds.size > 0) {
        nextActiveTasks = nextActiveTasks.filter(
          (task) => !recentlyRemovedActiveTaskIds.has(task.id)
        );
      }
    } else {
      const snapshotTaskIds = new Set(docs.map((docSnap) => docSnap.id));
      for (const taskId of recentlyRemovedActiveTaskIds) {
        if (snapshotTaskIds.has(taskId) && !removedIdsThisSnapshot.has(taskId)) {
          // Server snapshot confirms the task still exists (re-created or status change).
          recentlyRemovedActiveTaskIds.delete(taskId);
        } else if (!snapshotTaskIds.has(taskId)) {
          // Server snapshot confirms deletion.
          recentlyRemovedActiveTaskIds.delete(taskId);
        }
      }
    }

    activeTasks = nextActiveTasks;
    emit();
  };

  const unsubscribeActive = onSnapshot(
    activeTasksQuery,
    (snapshot) => {
      const snapshotReceivedAt = new Date().toISOString();
      const docChanges = snapshot.docChanges();
      if (debugLogs) {
        console.info(
          '[CARER_TASKS_LIVE] snapshot size=%s tab=active fromCache=%s hasPendingWrites=%s',
          snapshot.size,
          snapshot.metadata.fromCache,
          snapshot.metadata.hasPendingWrites
        );
        console.info(
          '[FIRESTORE] snapshot fromCache=%s hasPendingWrites=%s docCount=%s docChanges=%s at=%s',
          snapshot.metadata.fromCache,
          snapshot.metadata.hasPendingWrites,
          snapshot.size,
          docChanges.length,
          snapshotReceivedAt
        );
        snapshot.docs.forEach((docSnap) => {
          const task = docSnap.data() as Partial<CarerTask> & { linkedJobId?: string | null };
          console.info(
            '[START_TIMING] snapshot received at=%s fromCache=%s hasPendingWrites=%s taskId=%s status=%s automationStatus=%s assignedCarerUid=%s claimedByUid=%s automationJobId=%s linkedJobId=%s',
            snapshotReceivedAt,
            snapshot.metadata.fromCache,
            snapshot.metadata.hasPendingWrites,
            docSnap.id,
            String(task.status || '').trim() || null,
            String(task.automationStatus || '').trim() || null,
            String(task.assignedCarerUid || '').trim() || null,
            String(task.claimedByUid || '').trim() || null,
            String(task.automationJobId || '').trim() || null,
            String(task.linkedJobId || '').trim() || null
          );
        });
      }
      applyActiveTasksSnapshot(
        snapshot.docs,
        docChanges,
        snapshot.metadata.fromCache,
        snapshot.metadata.hasPendingWrites
      );
    },
    (error) => {
      console.error('[CARER_TASKS_LIVE] active listener error', error);
      onError?.(error as Error);
    }
  );
  const unsubscribeCompleted = onSnapshot(
    completedTasksQuery,
    (snapshot) => {
      const snapshotReceivedAt = new Date().toISOString();
      const docChanges = snapshot.docChanges();
      if (debugLogs) {
        console.info(
          '[CARER_TASKS_LIVE] snapshot size=%s tab=completed fromCache=%s hasPendingWrites=%s',
          snapshot.size,
          snapshot.metadata.fromCache,
          snapshot.metadata.hasPendingWrites
        );
        console.info(
          '[FIRESTORE] snapshot fromCache=%s hasPendingWrites=%s docCount=%s docChanges=%s at=%s',
          snapshot.metadata.fromCache,
          snapshot.metadata.hasPendingWrites,
          snapshot.size,
          docChanges.length,
          snapshotReceivedAt
        );
        snapshot.docs.forEach((docSnap) => {
          const task = docSnap.data() as Partial<CarerTask> & { linkedJobId?: string | null };
          console.info(
            '[START_TIMING] snapshot received at=%s fromCache=%s hasPendingWrites=%s taskId=%s status=%s automationStatus=%s assignedCarerUid=%s claimedByUid=%s automationJobId=%s linkedJobId=%s',
            snapshotReceivedAt,
            snapshot.metadata.fromCache,
            snapshot.metadata.hasPendingWrites,
            docSnap.id,
            String(task.status || '').trim() || null,
            String(task.automationStatus || '').trim() || null,
            String(task.assignedCarerUid || '').trim() || null,
            String(task.claimedByUid || '').trim() || null,
            String(task.automationJobId || '').trim() || null,
            String(task.linkedJobId || '').trim() || null
          );
        });
      }
      completedTasks = mapVisibleTasks(snapshot.docs, 'completed');
      emit();
    },
    (error) => {
      console.error('[CARER_TASKS_LIVE] completed listener error', error);
      onError?.(error as Error);
    }
  );

  return () => {
    unsubscribeActive();
    unsubscribeCompleted();
  };
}

export async function releaseExpiredCarerTasks(coadminUid: string) {
  const scopedCoadminUid = String(coadminUid || '').trim();
  if (!scopedCoadminUid) {
    return;
  }

  const [stuckTaskSnap, activeJobSnap] = await Promise.all([
    getDocs(
      query(
        collection(db, 'carerTasks'),
        where('coadminUid', '==', scopedCoadminUid),
        where('status', '==', 'in_progress')
      )
    ),
    getDocs(
      query(
        collection(db, 'automation_jobs'),
        where('coadminUid', '==', scopedCoadminUid),
        where('status', 'in', ['queued', 'running'])
      )
    ),
  ]);

  const nowMs = Date.now();
  const activeJobByTaskId = new Map<
    string,
    {
      id: string;
      status: string;
      attempts: number;
      startedAtMs: number;
      updatedAtMs: number;
      createdAtMs: number;
    }
  >();

  activeJobSnap.docs.forEach((docSnap) => {
    const data = docSnap.data() as {
      taskId?: string;
      status?: string;
      attempts?: number;
      startedAt?: Date | null;
      updatedAt?: Date | null;
      createdAt?: Date | null;
    };
    const taskId = String(data.taskId || '').trim();
    if (!taskId) {
      return;
    }
    activeJobByTaskId.set(taskId, {
      id: docSnap.id,
      status: String(data.status || '').trim(),
      attempts: Math.max(0, Number(data.attempts || 0)),
      startedAtMs: getTimestampMs(data.startedAt),
      updatedAtMs: getTimestampMs(data.updatedAt),
      createdAtMs: getTimestampMs(data.createdAt),
    });
  });

  for (const [taskId, job] of activeJobByTaskId.entries()) {
    if (job.status !== 'running') {
      continue;
    }

    const activityMs = Math.max(job.startedAtMs, job.updatedAtMs, job.createdAtMs);
    if (!activityMs || nowMs - activityMs < STUCK_AUTOMATION_JOB_TIMEOUT_MS) {
      continue;
    }

    const retryable = job.attempts < MAX_AUTOMATION_RECOVERY_ATTEMPTS;
    const jobRef = doc(db, 'automation_jobs', job.id);
    const taskRef = doc(db, 'carerTasks', taskId);

    let updatedAutomationJob = false;
    let mirroredRequestId = '';
    await runTransaction(db, async (transaction) => {
      const [jobSnap, taskSnap] = await Promise.all([
        transaction.get(jobRef),
        transaction.get(taskRef),
      ]);

      if (!jobSnap.exists()) {
        return;
      }

      const currentJob = jobSnap.data() as {
        status?: string;
        taskId?: string;
        attempts?: number;
        error?: string | null;
      };
      if (String(currentJob.status || '').trim() !== 'running') {
        return;
      }

      const taskData = taskSnap.exists()
        ? (taskSnap.data() as Omit<CarerTask, 'id'>)
        : null;
      const requestId = String(taskData?.requestId || '').trim();
      mirroredRequestId = requestId;
      const requestRef = requestId ? doc(db, 'playerGameRequests', requestId) : null;
      const requestSnap = requestRef ? await transaction.get(requestRef) : null;
      const timeoutMessage = retryable
        ? 'Automation timed out and was returned to the queue.'
        : 'Automation timed out repeatedly and now needs manual review.';

      if (retryable) {
        transaction.update(jobRef, {
          status: 'failed',
          startedAt: null,
          completedAt: serverTimestamp(),
          ttlExpiresAt: automationJobTtl(),
          updatedAt: serverTimestamp(),
          error: timeoutMessage,
          result: null,
          cancelledReason: 'returned_to_pending_timeout',
        });
        updatedAutomationJob = true;

        if (taskSnap.exists()) {
          transaction.update(taskRef, {
            ...buildPendingTaskResetFields(),
          });
          logTaskResetPending({
            taskId,
            oldStatus: taskData?.status || null,
            oldAutomationJobId: taskData?.automationJobId || job.id,
            oldLinkedJobId: null,
          });
        }

        if (requestRef && requestSnap?.exists()) {
          const requestData = requestSnap.data() as Omit<PlayerGameRequest, 'id'>;
          if (requestData.status !== 'completed') {
            transaction.update(requestRef, {
              status: 'pending',
              completedAt: null,
              ttlExpiresAt: null,
              pokedAt: null,
              pokeMessage: null,
            });
          }
        }

        return;
      }

      transaction.update(jobRef, {
        status: 'failed',
        completedAt: serverTimestamp(),
        ttlExpiresAt: automationJobTtl(),
        updatedAt: serverTimestamp(),
        error: timeoutMessage,
      });
      updatedAutomationJob = true;

      if (taskSnap.exists()) {
        const latestTask = taskSnap.data() as Omit<CarerTask, 'id'>;
        if (jobCompleteGuard(taskId, latestTask as Record<string, any>, job.id)) {
          transaction.update(taskRef, {
            status: 'failed',
            expiresAt: null,
            ttlExpiresAt: completedCarerTaskTtl(),
            automationStatus: 'failed',
            automationJobId: job.id,
            automationUpdatedAt: serverTimestamp(),
          });
        } else {
          console.info('[JOB_COMPLETE_GUARD] skipped marking task failed taskId=%s jobId=%s', taskId, job.id);
        }
      }

      if (requestRef && requestSnap?.exists()) {
        const requestData = requestSnap.data() as Omit<PlayerGameRequest, 'id'>;
        if (requestData.status !== 'completed') {
          transaction.update(requestRef, {
            status: 'pending_review',
            completedAt: null,
            pokedAt: serverTimestamp(),
            pokeMessage: timeoutMessage,
          });
        }
      }
    });
    await forceRefreshTaskFromServer(taskId, taskRef);
    void mirrorCarerTaskCacheBestEffort(taskId);
    void mirrorPlayerGameRequestCacheBestEffort(mirroredRequestId);
    if (updatedAutomationJob) {
      void mirrorAutomationJobCacheBestEffort(job.id);
    }
  }

  for (const docSnap of stuckTaskSnap.docs) {
    const task = {
      id: docSnap.id,
      ...(docSnap.data() as Omit<CarerTask, 'id'>),
    } satisfies CarerTask;
    const activeJob = activeJobByTaskId.get(task.id);
    if (activeJob) {
      continue;
    }

    const activityMs = Math.max(
      getTimestampMs(task.startedAt),
      getTimestampMs(task.expiresAt),
      getTimestampMs(task.createdAt)
    );
    if (!activityMs || nowMs - activityMs < STUCK_TASK_TIMEOUT_MS) {
      continue;
    }

    const taskRef = doc(db, 'carerTasks', task.id);
    const requestRef = task.requestId ? doc(db, 'playerGameRequests', task.requestId) : null;

    await runTransaction(db, async (transaction) => {
      const [currentTaskSnap, requestSnap] = await Promise.all([
        transaction.get(taskRef),
        requestRef ? transaction.get(requestRef) : Promise.resolve(null),
      ]);
      if (!currentTaskSnap.exists()) {
        return;
      }

      const currentTask = currentTaskSnap.data() as Omit<CarerTask, 'id'>;
      if (currentTask.status !== 'in_progress') {
        return;
      }

      console.info('[carerTasks] transaction-recovery-fixed', {
        taskId: task.id,
        hasRequestRef: Boolean(requestRef),
        requestReadBeforeWrite: true,
      });

      transaction.update(taskRef, {
        ...buildPendingTaskResetFields(),
      });
      logTaskResetPending({
        taskId: task.id,
        oldStatus: currentTask.status,
        oldAutomationJobId: currentTask.automationJobId || null,
        oldLinkedJobId: null,
      });

      if (requestRef && requestSnap?.exists()) {
        const requestData = requestSnap.data() as Omit<PlayerGameRequest, 'id'>;
        if (requestData.status !== 'completed') {
          transaction.update(requestRef, {
            status: 'pending',
            completedAt: null,
            ttlExpiresAt: null,
            pokedAt: null,
            pokeMessage: null,
          });
        }
      }
    });
    await forceRefreshTaskFromServer(task.id, taskRef);
    void mirrorCarerTaskCacheBestEffort(task.id);
    void mirrorPlayerGameRequestCacheBestEffort(task.requestId || '');
  }
}

export async function startCarerTask(taskId: string) {
  const { uid: carerUid, username: carerUsername } = await getCurrentCarerIdentity();
  const taskRef = doc(db, 'carerTasks', taskId);

  await runTransaction(db, async (transaction) => {
    const taskSnap = await transaction.get(taskRef);

    if (!taskSnap.exists()) {
      throw new Error('Task not found.');
    }

    const task = taskSnap.data() as Omit<CarerTask, 'id'>;
    const effectiveStatus = getEffectiveCarerTaskStatus({
      id: taskId,
      ...task,
    });

    if (effectiveStatus === 'completed') {
      throw new Error('Task already completed.');
    }

    if (effectiveStatus === 'urgent' && task.assignedCarerUid !== carerUid) {
      throw new Error('This urgent task is locked to another carer.');
    }

    if (
      effectiveStatus === 'in_progress' &&
      task.assignedCarerUid !== carerUid
    ) {
      throw new Error('Task is already assigned to another carer.');
    }

    const rechargeRequestRef =
      task.type === 'recharge' && task.requestId
        ? doc(db, 'playerGameRequests', task.requestId)
        : null;
    const rechargePlayerRef =
      task.type === 'recharge' ? doc(db, 'users', task.playerUid) : null;
    const rechargeRequestSnap = rechargeRequestRef
      ? await transaction.get(rechargeRequestRef)
      : null;
    const rechargePlayerSnap = rechargePlayerRef
      ? await transaction.get(rechargePlayerRef)
      : null;

    if (task.type === 'recharge') {
      if (!rechargeRequestRef || !rechargeRequestSnap?.exists()) {
        console.info('[CLEANUP] latest status before delete=%s', task.status || null);
        if (shouldSkipTaskCleanup(taskId, task, 'linked_request_not_found')) {
          console.info('[CLEANUP] abort delete because latest status is pending');
        } else {
          transaction.delete(taskRef);
        }
        throw new Error('Recharge task dismissed: linked request not found.');
      }

      if (!rechargePlayerRef || !rechargePlayerSnap?.exists()) {
        console.info('[CLEANUP] latest status before delete=%s', task.status || null);
        if (shouldSkipTaskCleanup(taskId, task, 'player_profile_not_found')) {
          console.info('[CLEANUP] abort delete because latest status is pending');
        } else {
          transaction.delete(taskRef);
          transaction.delete(rechargeRequestRef);
        }
        throw new Error('Recharge task dismissed: player profile not found.');
      }

      const requestData = rechargeRequestSnap.data() as Omit<PlayerGameRequest, 'id'>;
      const playerData = rechargePlayerSnap.data() as { coin?: number };
      const rechargeAmount = Math.max(0, Number(requestData.amount || 0));
      const currentCoin = Number(playerData.coin || 0);
      const coinAlreadyHeld = Boolean(
        (requestData as { coinDeductedOnRequest?: boolean | null })
          .coinDeductedOnRequest
      );

      if (
        !coinAlreadyHeld &&
        currentCoin < rechargeAmount
      ) {
        console.info('[CLEANUP] latest status before delete=%s', task.status || null);
        if (shouldSkipTaskCleanup(taskId, task, 'insufficient_coin_balance')) {
          console.info('[CLEANUP] abort delete because latest status is pending');
        } else {
          transaction.delete(taskRef);
          transaction.delete(rechargeRequestRef);
        }
        throw new Error('Recharge task dismissed: player has insufficient coin balance.');
      }
    }

    const now = new Date();

    transaction.update(taskRef, {
      status: 'in_progress',
      assignedCarerUid: carerUid,
      assignedCarerUsername: carerUsername,
      startedAt: now,
      expiresAt: null,
      completedAt:
        effectiveStatus === 'urgent'
          ? task.completedAt || null
          : null,
      completedByCarerUid:
        effectiveStatus === 'urgent'
          ? task.completedByCarerUid || task.assignedCarerUid || null
          : task.completedByCarerUid || null,
      completedByCarerUsername:
        effectiveStatus === 'urgent'
          ? task.completedByCarerUsername || task.assignedCarerUsername || null
          : task.completedByCarerUsername || null,
      retryPending: false,
      resetToPendingAt: null,
      returnedToPendingAt: null,
      pendingSince: null,
    });
  });
  await forceRefreshTaskFromServer(taskId, taskRef);
  void mirrorCarerTaskCacheBestEffort(taskId);
}

export async function deletePendingCarerTask(taskId: string) {
  const route = '/api/carer/tasks/delete-pending';
  const headers = await getAuthHeaders('delete_pending');
  const authSource = isClientSqlReadMode() ? 'app_session_sql' : 'firebase_token';
  if (isClientSqlReadMode()) {
    console.info('[CARER_DELETE_TASK_FETCH_START]', {
      taskId,
      route,
      authSource: 'app_session_sql',
      firestoreAttempted: false,
    });
  }
  const response = await fetch(route, {
    method: 'POST',
    headers,
    body: JSON.stringify({ taskId }),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    duplicate?: boolean;
    alreadyDeleted?: boolean;
  };
  console.info('[CARER_DELETE_TASK_REQUEST]', {
    route,
    taskId,
    status: response.status,
    responseBody: payload,
    authSource,
  });
  if (!response.ok) {
    const message = readApiError('Failed to delete pending task.', payload);
    const normalized = message.toLowerCase();
    if (
      payload.alreadyDeleted ||
      normalized.includes('already deleted') ||
      (normalized.includes('not found') && payload.duplicate)
    ) {
      return payload;
    }
    throw new Error(message);
  }

  if (isClientSqlReadMode()) {
    console.info('[CARER_POST_TASK_REFRESH_SKIPPED]', {
      taskId,
      action: 'delete_pending',
      sqlMode: true,
      reason: 'sql_listener_authoritative',
    });
    return payload;
  }

  await forceRefreshTaskFromServer(taskId, doc(db, 'carerTasks', taskId));
  void mirrorCarerTaskCacheBestEffort(taskId);
  return payload;
}

export async function completeCarerTask(taskId: string) {
  const { uid: carerUid, username: carerUsername } =
    await getCurrentCarerIdentity();
  const taskRef = doc(db, 'carerTasks', taskId);

  await runTransaction(db, async (transaction) => {
    const taskSnap = await transaction.get(taskRef);

    if (!taskSnap.exists()) {
      throw new Error('Task not found.');
    }

    const task = taskSnap.data() as Omit<CarerTask, 'id'>;
    const effectiveStatus = getEffectiveCarerTaskStatus({
      id: taskId,
      ...task,
    });

    if (effectiveStatus !== 'in_progress' || task.assignedCarerUid !== carerUid) {
      throw new Error('Only the assigned carer can complete this task.');
    }

    transaction.update(taskRef, buildCompletedTaskUpdate({
      carerUid,
      carerUsername,
    }));
  });
  await forceRefreshTaskFromServer(taskId, taskRef);
  void mirrorCarerTaskCacheBestEffort(taskId);
}

export async function completeUsernameTaskForPlayerGame(
  coadminUid: string,
  playerUid: string,
  gameName: string,
  options?: {
    taskType?: 'reset_password' | 'recreate_username' | 'create_game_username';
    taskId?: string | null;
    playerGameLoginId?: string | null;
    carerUid?: string | null;
    source?: string | null;
  }
) {
  const sqlMode = isClientSqlReadMode();
  const taskType = options?.taskType || 'create_game_username';
  const logResetPasswordAudit = taskType === 'reset_password';
  const headers = await getAuthHeaders('complete_username', {
    logResetPasswordAudit,
    expectedCarerUid: options?.carerUid ?? null,
    functionName: 'completeUsernameTaskForPlayerGame',
  });
  const hasAppSessionId = Boolean(
    (headers as Record<string, string>)['X-App-Session-Id'] ||
      (headers as Record<string, string>)['x-app-session-id']
  );
  const authSource = sqlMode ? 'app_session_sql' : 'firebase_token';
  if (logResetPasswordAudit) {
    console.info('[CARER_RESET_PASSWORD_CLICK]', {
      taskId: options?.taskId || null,
      playerUid,
      playerGameLoginId: options?.playerGameLoginId || null,
      gameName,
      carerUid: options?.carerUid ?? null,
      coadminUid,
      sqlMode,
      hasAppSessionId,
      source: options?.source || 'complete_username_task',
    });
  }
  console.info('[CARER_RESET_PASSWORD_ACTION]', {
    action: 'complete_username_task',
    taskId: options?.taskId || null,
    playerUid,
    playerGameLoginId: options?.playerGameLoginId || null,
    gameId: gameName,
    carerUid: options?.carerUid ?? null,
    coadminUid,
    sqlMode,
    hasAppSessionId,
    authSource,
    firebaseAttempted: !sqlMode,
    taskType,
  });
  const response = await fetch('/api/carer/tasks/complete-username', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      coadminUid,
      playerUid,
      gameName,
    }),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    completedTaskCount?: number;
    totalAwardNpr?: number;
  };
  console.info('[CARER_RESET_PASSWORD_REQUEST]', {
    route: '/api/carer/tasks/complete-username',
    method: 'POST',
    status: response.status,
    responseBody: payload,
    authSource,
    firebaseAttempted: !sqlMode,
  });
  if (!response.ok) {
    const message = mapCarerAuthErrorMessage(
      readApiError('Failed to complete username task.', payload)
    );
    if (/not authenticated|session changed/i.test(message)) {
      console.info('[CARER_RESET_PASSWORD_NOT_AUTHENTICATED]', {
        file: 'features/games/carerTasks.ts',
        function: 'completeUsernameTaskForPlayerGame',
        reason: message,
        authCurrentUserUid: auth.currentUser?.uid || null,
        sessionUid: options?.carerUid ?? null,
        expectedCarerUid: options?.carerUid ?? null,
        sqlMode,
      });
    }
    throw new Error(message);
  }
  const taskId = options?.taskId || usernameTaskId(coadminUid, playerUid, gameName);
  await forceRefreshTaskFromServer(taskId, doc(db, 'carerTasks', taskId));
  if (!sqlMode) {
    void mirrorCarerTaskCacheBestEffort(taskId);
  }
  return {
    completedTaskCount: Number(payload.completedTaskCount || 0),
    totalAwardNpr: Number(payload.totalAwardNpr || 0),
  } satisfies CarerRewardSummary;
}

function mapPlayerVaultAuthErrorMessage(message: string) {
  if (/not authenticated|app session required|player role required/i.test(message)) {
    return 'Session changed. Please refresh.';
  }
  return message;
}

async function postPlayerCredentialTaskViaSql(values: {
  taskType: 'reset_password' | 'recreate_username';
  playerUid: string;
  playerUsername: string;
  gameName: string;
  coadminUid: string;
  gameLoginId?: string | null;
}) {
  const headers = await getPlayerApiHeaders(true, {
    route: '/api/player/credential-tasks',
  });
  const hasAppSessionId = Boolean(headers['X-App-Session-Id']);
  const hasPlayerSessionId = Boolean(headers['X-Player-Session-Id']);
  console.info('[PLAYER_VAULT_RESET_PASSWORD_AUTH_AUDIT]', {
    file: 'features/games/carerTasks.ts',
    function: 'postPlayerCredentialTaskViaSql',
    authSource: 'app_session_sql',
    hasAppSessionId,
    hasPlayerSessionId,
    firebaseCurrentUserUid: auth.currentUser?.uid || null,
    firebaseAttempted: false,
    reason: values.taskType,
  });
  const response = await fetch('/api/player/credential-tasks', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      taskType: values.taskType,
      gameName: values.gameName,
      gameLoginId: values.gameLoginId || null,
      playerUsername: values.playerUsername,
      coadminUid: values.coadminUid,
    }),
    cache: 'no-store',
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    taskId?: string;
  };
  console.info('[PLAYER_VAULT_RESET_PASSWORD_REQUEST]', {
    route: '/api/player/credential-tasks',
    method: 'POST',
    status: response.status,
    responseBody: payload,
    authSource: 'app_session_sql',
    firebaseAttempted: false,
  });
  if (!response.ok) {
    throw new Error(
      mapPlayerVaultAuthErrorMessage(payload.error || 'Failed to create credential task.')
    );
  }
  return String(payload.taskId || '').trim();
}

export async function createPlayerCredentialTask(values: {
  taskType: 'reset_password' | 'recreate_username';
  playerUid: string;
  playerUsername: string;
  gameName: string;
  coadminUid: string;
  gameLoginId?: string | null;
}) {
  if (isClientSqlReadMode()) {
    logClientFirebaseRuntimeRemoved({
      feature: 'player_credential_task',
      file: 'features/games/carerTasks.ts',
      operation: 'setDoc',
      replacement: 'POST /api/player/credential-tasks',
    });
    const sqlMode = true;
    console.info('[PLAYER_VAULT_RESET_PASSWORD_CLICK]', {
      playerUid: values.playerUid,
      gameLoginId: values.gameLoginId || null,
      gameName: values.gameName,
      username: values.playerUsername,
      coadminUid: values.coadminUid,
      sqlMode,
      hasAppSessionId: Boolean(getLocalAppSessionId()),
      hasPlayerSessionId: Boolean(getLocalPlayerSessionId()),
    });
    const taskId = await postPlayerCredentialTaskViaSql(values);
    logSqlClientMigration({
      feature: 'player_credential_task',
      oldFirebaseOperation: 'setDoc',
      newSqlRoute: '/api/player/credential-tasks',
      result: 'ok',
      fallbackUsed: false,
    });
    console.info('[PLAYER_CREDENTIAL_TASK_SQL_SKIP_REFRESH]', {
      taskId,
      type: values.taskType,
      reason: 'sql_listener_authority',
      firestoreAttempted: false,
    });
    return;
  }

  const currentUser = auth.currentUser;

  if (!currentUser) {
    throw new Error('Session changed. Please refresh.');
  }

  if (currentUser.uid !== values.playerUid) {
    throw new Error('You can only create credential tasks for your own account.');
  }

  await assertActivePlayerSession();

  if (!values.gameName.trim()) {
    throw new Error('Game name is required.');
  }

  const playerSnap = await getDoc(doc(db, 'users', values.playerUid));
  if (!playerSnap.exists()) {
    throw new Error('Player profile not found.');
  }

  const playerCoadminUid =
    resolveCoadminUid({
      uid: values.playerUid,
      ...(playerSnap.data() as {
        role?: string | null;
        coadminUid?: string | null;
        createdBy?: string | null;
      }),
    }) || String(values.coadminUid || '').trim();
  if (!playerCoadminUid) {
    throw new Error('Player coadmin scope not found.');
  }

  const maintenanceBreak = await getCoadminMaintenanceBreakClient(playerCoadminUid);
  if (maintenanceBreak.enabled) {
    throw new Error(maintenanceBreak.message);
  }

  const taskId =
    values.taskType === 'reset_password'
      ? resetPasswordTaskId(playerCoadminUid, values.playerUid, values.gameName)
      : recreateUsernameTaskId(playerCoadminUid, values.playerUid, values.gameName);

  const taskRef = doc(db, 'carerTasks', taskId);

  await setDoc(
    taskRef,
    {
      coadminUid: playerCoadminUid,
      type: values.taskType,
      playerUid: values.playerUid,
      playerUsername: values.playerUsername || 'Player',
      gameName: values.gameName.trim(),
      amount: null,
      requestId: null,
      ...buildPendingTaskResetFields(),
      isPoked: false,
      pokedAt: null,
      pokeMessage: null,
      createdAt: serverTimestamp(),
    },
    { merge: true }
  );
  await forceRefreshTaskFromServer(taskId, taskRef);
  void mirrorCarerTaskCacheBestEffort(taskId);
}

async function postEscalationAlertViaSql(body: Record<string, unknown>) {
  const response = await fetch('/api/carer/escalation-alerts', {
    method: 'POST',
    headers: await getSqlApiReadHeaders(true),
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to send escalation alert.');
  }
}

export async function sendCarerEscalationAlert(task: CarerTask) {
  const { uid: carerUid, username: carerUsername } =
    await getCurrentCarerIdentity();

  if (isClientSqlReadMode()) {
    logClientFirebaseRuntimeRemoved({
      feature: 'carer_escalation_alert',
      file: 'features/games/carerTasks.ts',
      operation: 'addDoc',
      replacement: 'POST /api/carer/escalation-alerts',
    });
    await postEscalationAlertViaSql({
      coadminUid: task.coadminUid,
      contextType: 'task_help',
      escalationFrom: 'carer',
      taskId: task.id,
      playerUid: task.playerUid,
      playerUsername: task.playerUsername || 'Player',
      gameName: task.gameName || 'Unknown Game',
      message: 'This player is being an idiot.',
      createdByCarerUid: carerUid,
      createdByCarerUsername: carerUsername,
    });
    logSqlClientMigration({
      feature: 'carer_escalation_alert',
      oldFirebaseOperation: 'addDoc',
      newSqlRoute: '/api/carer/escalation-alerts',
      result: 'ok',
      fallbackUsed: false,
    });
    return;
  }

  await addDoc(collection(db, 'carerEscalationAlerts'), {
    coadminUid: task.coadminUid,
    contextType: 'task_help',
    escalationFrom: 'carer',
    taskId: task.id,
    playerUid: task.playerUid,
    playerUsername: task.playerUsername || 'Player',
    gameName: task.gameName || 'Unknown Game',
    message: 'This player is being an idiot.',
    createdByCarerUid: carerUid,
    createdByCarerUsername: carerUsername,
    createdAt: serverTimestamp(),
  });
}

export async function sendCarerCashboxInquiryAlert(values: {
  coadminUid: string;
  message: string;
  /** When the sender is the player, pass their UID so coadmins can audit inquiries. */
  playerUid?: string | null;
  playerUsername?: string | null;
}) {
  const sender = await getCurrentUserIdentityForEscalation();
  const cleanMessage = values.message.trim();

  if (!cleanMessage) {
    throw new Error('Inquiry message is required.');
  }

  const explicitPlayerUid = String(values.playerUid || '').trim();
  const explicitPlayerUsername = String(values.playerUsername || '').trim();

  const playerUid =
    explicitPlayerUid ||
    (sender.role === 'player' ? sender.uid : '') ||
    null;
  const playerUsername =
    explicitPlayerUsername ||
    (sender.role === 'player' ? sender.username || 'Player' : null);

  let escalationFrom: CarerEscalationAlert['escalationFrom'] = sender.role === 'staff'
      ? 'staff'
      : sender.role === 'player'
        ? 'player'
        : 'carer';

  if (isClientSqlReadMode()) {
    logClientFirebaseRuntimeRemoved({
      feature: 'carer_cashbox_inquiry_alert',
      file: 'features/games/carerTasks.ts',
      operation: 'addDoc',
      replacement: 'POST /api/carer/escalation-alerts',
    });
    await postEscalationAlertViaSql({
      coadminUid: values.coadminUid,
      contextType: 'cashbox_inquiry',
      escalationFrom,
      taskId: null,
      playerUid,
      playerUsername,
      gameName: null,
      message: cleanMessage,
      createdByCarerUid: sender.uid,
      createdByCarerUsername: sender.username,
    });
    logSqlClientMigration({
      feature: 'carer_cashbox_inquiry_alert',
      oldFirebaseOperation: 'addDoc',
      newSqlRoute: '/api/carer/escalation-alerts',
      result: 'ok',
      fallbackUsed: false,
    });
    return;
  }

  await addDoc(collection(db, 'carerEscalationAlerts'), {
    coadminUid: values.coadminUid,
    contextType: 'cashbox_inquiry',
    escalationFrom,
    taskId: null,
    playerUid,
    playerUsername,
    gameName: null,
    message: cleanMessage,
    createdByCarerUid: sender.uid,
    createdByCarerUsername: sender.username,
    createdAt: serverTimestamp(),
  });
}

const CARER_ESCALATION_ALERT_LIVE_LIMIT = 24;

function isoToEscalationDate(iso: string | null | undefined): Date | null {
  if (!iso) {
    return null;
  }
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

export function listenToCarerEscalationAlertsByCoadmin(
  coadminUid: string,
  onChange: (alerts: CarerEscalationAlert[]) => void,
  onError?: (error: Error) => void
) {
  if (isClientSqlReadMode()) {
    logClientFirestoreSkipped('carer_escalation_alerts_listener', { coadminUid });
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled) {
        return;
      }
      try {
        const response = await fetch(
          `/api/carer/escalation-alerts?coadminUid=${encodeURIComponent(coadminUid)}&limit=${CARER_ESCALATION_ALERT_LIVE_LIMIT}`,
          {
            method: 'GET',
            headers: await getSqlApiReadHeaders(false),
            cache: 'no-store',
          }
        );
        const payload = (await response.json().catch(() => ({}))) as {
          alerts?: Array<{
            id: string;
            coadminUid: string;
            contextType?: string | null;
            escalationFrom?: string | null;
            taskId?: string | null;
            playerUid?: string | null;
            playerUsername?: string | null;
            gameName?: string | null;
            message?: string | null;
            createdByCarerUid?: string | null;
            createdByCarerUsername?: string | null;
            createdAt?: string | null;
          }>;
        };
        if (!cancelled) {
          const currentUid = auth.currentUser?.uid || '';
          const alerts = (payload.alerts || [])
            .map((alert) =>
              mapCarerEscalationAlert(alert.id, {
                coadminUid: alert.coadminUid,
                contextType: alert.contextType as CarerEscalationAlert['contextType'],
                escalationFrom: alert.escalationFrom,
                taskId: alert.taskId,
                playerUid: alert.playerUid,
                playerUsername: alert.playerUsername,
                gameName: alert.gameName,
                message: String(alert.message || ''),
                createdByCarerUid: String(alert.createdByCarerUid || ''),
                createdByCarerUsername: String(alert.createdByCarerUsername || ''),
                createdAt: isoToEscalationDate(alert.createdAt),
              })
            )
            .filter(
              (alert) =>
                !currentUid || !Array.isArray(alert.dismissedByUids)
                  ? true
                  : !alert.dismissedByUids.includes(currentUid)
            );
          onChange(alerts);
        }
      } catch (error) {
        if (!cancelled) {
          onError?.(error instanceof Error ? error : new Error(String(error)));
        }
      } finally {
        if (!cancelled) {
          timer = setTimeout(() => {
            void tick();
          }, 12_000);
        }
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer != null) {
        clearTimeout(timer);
        timer = null;
      }
    };
  }

  const alertsQuery = query(
    collection(db, 'carerEscalationAlerts'),
    where('coadminUid', '==', coadminUid),
    orderBy('createdAt', 'desc'),
    limit(CARER_ESCALATION_ALERT_LIVE_LIMIT)
  );
  console.info(
    '[ALERTS] bounded coadmin alert listener active limit=%s',
    CARER_ESCALATION_ALERT_LIVE_LIMIT
  );
  console.info('[ALERTS] unbounded global alert listener removed');

  return clientOnSnapshot(
    alertsQuery,
    {
      file: 'features/games/carerTasks.ts',
      hook: 'listenToCarerEscalationAlertsByCoadmin',
      collection: 'carerEscalationAlerts',
      where: { coadminUid, orderByCreatedAtDesc: true },
      orderBy: { field: 'createdAt', direction: 'desc' },
    },
    (snapshot) => {
      const currentUid = auth.currentUser?.uid || '';
      const alerts = snapshot.docs
        .map((docSnap) =>
          mapCarerEscalationAlert(
            docSnap.id,
            docSnap.data() as Omit<CarerEscalationAlert, 'id'>
          )
        )
        .filter(
          (alert) =>
            !currentUid || !Array.isArray(alert.dismissedByUids)
              ? true
              : !alert.dismissedByUids.includes(currentUid)
        )
        .sort((a, b) => {
          const aTime = getTimestampMs(a.createdAt);
          const bTime = getTimestampMs(b.createdAt);
          return bTime - aTime;
        });

      onChange(alerts);
    },
    (error) => {
      onError?.(error as Error);
    }
  );
}

export async function listenToCarerEscalationAlerts(
  onChange: (alerts: CarerEscalationAlert[]) => void,
  onError?: (error: Error) => void
) {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error('Not authenticated.');
  }

  const currentUserSnap = await getDoc(doc(db, 'users', currentUser.uid));
  const currentUserRole = currentUserSnap.exists()
    ? String((currentUserSnap.data() as { role?: string }).role || '').toLowerCase()
    : '';
  if (currentUserRole !== 'admin') {
    throw new Error('Only admin can listen to global carer alerts.');
  }

  const alertsQuery = query(
    collection(db, 'carerEscalationAlerts'),
    orderBy('createdAt', 'desc'),
    limit(CARER_ESCALATION_ALERT_LIVE_LIMIT)
  );
  console.info(
    '[ALERTS] bounded admin alert listener active limit=%s',
    CARER_ESCALATION_ALERT_LIVE_LIMIT
  );
  console.info('[ALERTS] unbounded global alert listener removed');

  return onSnapshot(
    alertsQuery,
    (snapshot) => {
      const currentUid = auth.currentUser?.uid || '';
      const alerts = snapshot.docs
        .map((docSnap) =>
          mapCarerEscalationAlert(
            docSnap.id,
            docSnap.data() as Omit<CarerEscalationAlert, 'id'>
          )
        )
        .filter(
          (alert) =>
            !currentUid || !Array.isArray(alert.dismissedByUids)
              ? true
              : !alert.dismissedByUids.includes(currentUid)
        )
        .sort((a, b) => {
          const aTime = getTimestampMs(a.createdAt);
          const bTime = getTimestampMs(b.createdAt);
          return bTime - aTime;
        });

      onChange(alerts);
    },
    (error) => {
      onError?.(error as Error);
    }
  );
}

export async function deleteCarerEscalationAlert(alertId: string) {
  await deleteDoc(doc(db, 'carerEscalationAlerts', alertId));
}

export async function dismissCarerEscalationAlertForCurrentUser(alertId: string) {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error('Not authenticated.');
  }
  await updateDoc(doc(db, 'carerEscalationAlerts', alertId), {
    dismissedByUids: arrayUnion(currentUser.uid),
  });
}

export async function completeRechargeRedeemTask(task: CarerTask) {
  if (!task.requestId) {
    throw new Error('This task is not linked to a request.');
  }
  const response = await fetch('/api/carer/tasks/complete-recharge-redeem', {
    method: 'POST',
    headers: await getAuthHeaders('complete_recharge_redeem'),
    body: JSON.stringify({ taskId: task.id }),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    completedTaskCount?: number;
    totalAwardNpr?: number;
  };
  if (!response.ok) {
    throw new Error(readApiError('Failed to complete task.', payload));
  }
  await forceRefreshTaskFromServer(task.id, doc(db, 'carerTasks', task.id));
  void mirrorCarerTaskCacheBestEffort(task.id);

  return {
    completedTaskCount: Number(payload.completedTaskCount || 0),
    totalAwardNpr: Number(payload.totalAwardNpr || 0),
  } satisfies CarerRewardSummary;
}

export async function ensureUsernameTaskExists(
  coadminUid: string,
  player: PlayerUser,
  game: GameLogin
) {
  const taskId = usernameTaskId(coadminUid, player.uid, game.gameName);
  const taskRef = doc(db, 'carerTasks', taskId);
  const taskSnap = await getDoc(taskRef);

  if (taskSnap.exists()) {
    return;
  }

  const task = buildUsernameTask(coadminUid, player, game);

  await setDoc(taskRef, {
    ...task,
    createdAt: serverTimestamp(),
  });
  void mirrorCarerTaskCacheBestEffort(taskId);
}

export async function completeCreateGameUsernameTask(values: {
  coadminUid: string;
  playerUid: string;
  gameName: string;
}) {
  return completeUsernameTaskForPlayerGame(
    values.coadminUid,
    values.playerUid,
    values.gameName
  );
}

export function listenToCarerTasks(
  coadminUid: string,
  onChange: (tasks: CarerTask[]) => void
) {
  const currentCarerUid = auth.currentUser?.uid;

  if (!currentCarerUid) {
    throw new Error('Not authenticated.');
  }

  return listenToAvailableCarerTasks(coadminUid, currentCarerUid, onChange);
}

export async function completeLegacyRechargeRedeemTask(taskId: string) {
  await updateDoc(doc(db, 'carerTasks', taskId), {
    status: 'completed',
    expiresAt: null,
    completedAt: serverTimestamp(),
    ttlExpiresAt: completedCarerTaskTtl(),
    isPoked: false,
    pokedAt: null,
    pokeMessage: null,
  });
  void mirrorCarerTaskCacheBestEffort(taskId);
}

export function getClaimablePendingTaskCount(tasks: CarerTask[]) {
  return tasks.filter(isClaimablePendingTask).length;
}

export async function getCompletedUsernameCarersByPlayer(playerUid: string) {
  if (!playerUid) {
    return {} as Record<string, string[]>;
  }

  if (isClientSqlReadMode()) {
    console.info('[COMPLETED_USERNAME_CARERS_FIRESTORE_SKIPPED]', {
      playerUid,
      sqlMode: true,
      reason: 'sql_read_mode',
    });
    try {
      const { getPlayerApiHeaders } = await import('@/features/auth/playerSession');
      const headers = await getPlayerApiHeaders(false, {
        route: '/api/player/completed-username-carers',
      });
      const response = await fetch('/api/player/completed-username-carers', {
        method: 'GET',
        headers,
        cache: 'no-store',
      });
      const payload = (await response.json().catch(() => ({}))) as {
        mapping?: Record<string, string[]>;
      };
      if (!response.ok) {
        console.warn('[COMPLETED_USERNAME_CARERS_SQL_READ]', {
          playerUid,
          source: 'sql',
          count: 0,
          firestoreAttempted: false,
          ok: false,
          status: response.status,
        });
        return {} as Record<string, string[]>;
      }
      const mapping = payload.mapping || {};
      console.info('[COMPLETED_USERNAME_CARERS_SQL_READ]', {
        playerUid,
        source: 'sql',
        count: Object.keys(mapping).length,
        firestoreAttempted: false,
      });
      return mapping;
    } catch (error) {
      console.warn('[COMPLETED_USERNAME_CARERS_SQL_READ]', {
        playerUid,
        source: 'sql',
        count: 0,
        firestoreAttempted: false,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
      return {} as Record<string, string[]>;
    }
  }

  const tasksQuery = query(
    collection(db, 'carerTasks'),
    where('playerUid', '==', playerUid),
    where('status', '==', 'completed')
  );
  const snapshot = await getDocs(tasksQuery);

  const mapping: Record<string, string[]> = {};

  snapshot.docs.forEach((docSnap) => {
    const task = {
      id: docSnap.id,
      ...(docSnap.data() as Omit<CarerTask, 'id'>),
    } as CarerTask;

    if (
      task.type !== 'create_game_username' &&
      task.type !== 'recreate_username' &&
      task.type !== 'reset_password'
    ) {
      return;
    }

    const normalizedGame = normalizeGameName(task.gameName || '');

    if (!normalizedGame) {
      return;
    }

    const carerName =
      String(task.completedByCarerUsername || task.assignedCarerUsername || '').trim() ||
      'Carer';

    if (!mapping[normalizedGame]) {
      mapping[normalizedGame] = [];
    }

    if (!mapping[normalizedGame].includes(carerName)) {
      mapping[normalizedGame].push(carerName);
    }
  });

  return mapping;
}

export function listenCarerRechargeRedeemTotalsByCoadmin(
  coadminUid: string,
  onChange: (totalsByCarerUid: Record<string, CarerRechargeRedeemTotals>) => void,
  onError?: (error: Error) => void
) {
  if (isClientSqlReadMode()) {
    return attachCarerRechargeRedeemTotalsSqlPoll({
      coadminUid,
      onChange,
      onError,
    });
  }

  const windowStart = new Date(Date.now() - CARER_TOTALS_WINDOW_MS);
  const rechargeQuery = query(
    collection(db, 'carerTasks'),
    where('coadminUid', '==', coadminUid),
    where('status', '==', 'completed'),
    where('type', '==', 'recharge'),
    where('completedAt', '>=', windowStart),
    orderBy('completedAt', 'desc'),
    limit(CARER_TOTALS_HISTORY_LIMIT_PER_TYPE)
  );
  const redeemQuery = query(
    collection(db, 'carerTasks'),
    where('coadminUid', '==', coadminUid),
    where('status', '==', 'completed'),
    where('type', '==', 'redeem'),
    where('completedAt', '>=', windowStart),
    orderBy('completedAt', 'desc'),
    limit(CARER_TOTALS_HISTORY_LIMIT_PER_TYPE)
  );

  let rechargeTasks: CarerTask[] = [];
  let redeemTasks: CarerTask[] = [];

  const emit = () => {
    const totals: Record<string, CarerRechargeRedeemTotals> = {};

    for (const task of [...rechargeTasks, ...redeemTasks]) {
      const carerUid = String(task.completedByCarerUid || task.assignedCarerUid || '').trim();
      if (!carerUid) {
        continue;
      }
      if (!totals[carerUid]) {
        totals[carerUid] = {
          totalRechargeAmount: 0,
          totalRedeemAmount: 0,
        };
      }
      const amount = Number(task.amount || 0);
      if (task.type === 'recharge') {
        totals[carerUid].totalRechargeAmount += amount;
      } else {
        totals[carerUid].totalRedeemAmount += amount;
      }
    }

    onChange(totals);
  };

  const queryMeta = {
    file: 'features/games/carerTasks.ts',
    hook: 'listenCarerRechargeRedeemTotalsByCoadmin',
    collection: 'carerTasks',
    where: {
      coadminUid,
      status: 'completed',
      completedAtGteWindowStart: true,
    },
    orderBy: { field: 'completedAt', direction: 'desc' },
  };

  const unsubRecharge = clientOnSnapshot(
    rechargeQuery,
    { ...queryMeta, hook: 'listenCarerRechargeRedeemTotalsByCoadmin/recharge' },
    (snapshot) => {
      rechargeTasks = snapshot.docs.map((docSnap) => ({
        id: docSnap.id,
        ...(docSnap.data() as Omit<CarerTask, 'id'>),
      }));
      emit();
    },
    (error) => onError?.(error as Error)
  );
  const unsubRedeem = clientOnSnapshot(
    redeemQuery,
    { ...queryMeta, hook: 'listenCarerRechargeRedeemTotalsByCoadmin/redeem' },
    (snapshot) => {
      redeemTasks = snapshot.docs.map((docSnap) => ({
        id: docSnap.id,
        ...(docSnap.data() as Omit<CarerTask, 'id'>),
      }));
      emit();
    },
    (error) => onError?.(error as Error)
  );

  return () => {
    unsubRecharge();
    unsubRedeem();
  };
}
