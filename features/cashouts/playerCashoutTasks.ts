import {
  arrayUnion,
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from 'firebase/firestore';

import { auth, db } from '@/lib/firebase/client';
import { evaluateWithdrawalPolicy } from '@/lib/economy/policy';
import { getPlayerApiHeaders } from '@/features/auth/playerSession';
import {
  attachCoadminCashoutLifecyclePoll,
  attachPlayerCashoutTasksSqlPoll,
  attachStaffCashoutLifecyclePoll,
  isPlayerCashoutSqlReadEnabled,
} from '@/features/live/playerCashoutSqlRead';
import { assertClientFirestoreDisabled } from '@/lib/client/clientFirestoreGuard';
import { playerDevLog } from '@/lib/client/playerDebugLogs';
import { getFirebaseApiHeaders } from '@/lib/firebase/apiClient';
import {
  getStaffAppSessionApiHeaders,
  staffApiHeaderFlags,
} from '@/lib/client/staffApiHeaders';

import {
  CashoutClaimConflictError,
  isCashoutClaimConflictResponse,
  parseCashoutClaimConflictSnapshot,
  type CashoutClaimConflictSnapshot,
} from '@/lib/cashouts/playerCashoutClaimConflict';

export type PlayerCashoutTaskStatus = 'pending' | 'in_progress' | 'completed' | 'declined';
export type PlayerCashoutPayoutMethod = 'qr' | 'app';

export type PlayerCashoutTask = {
  id: string;
  coadminUid: string;
  playerUid: string;
  playerUsername: string;
  amountNpr: number;
  paymentDetails: string;
  payoutMethod?: PlayerCashoutPayoutMethod | null;
  qrImageUrl?: string | null;
  paymentAppName?: string | null;
  paymentAppCashTag?: string | null;
  paymentAppAccountName?: string | null;
  cashDeductedOnRequest?: boolean;
  declinedByUids?: string[];
  status: PlayerCashoutTaskStatus;
  assignedHandlerUid?: string | null;
  assignedHandlerUsername?: string | null;
  startedAt?: Date | null;
  expiresAt?: Date | null;
  createdAt?: Date | null;
  completedAt?: Date | null;
};

const CASHOUT_ACTIVE_LISTENER_LIMIT = 100;
const CASHOUT_HISTORY_LISTENER_LIMIT = 50;

/** Max NPR a player may cash out in a rolling ~24-hour window (sums non-declined task amounts). */
export const PLAYER_CASHOUT_MAX_NPR_PER_24_H = 1000;
export const PLAYER_CASHOUT_ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Sum non-declined player cashouts with `createdAt` in [now − 24h, now]. */
export function rolling24hCashoutUsageNprFromTasks(
  tasks: PlayerCashoutTask[],
  nowMs: number = Date.now()
): number {
  const since = nowMs - PLAYER_CASHOUT_ROLLING_WINDOW_MS;
  let total = 0;
  for (const task of tasks) {
    const created = getSnapshotMs(task.createdAt);
    if (!created || created < since) {
      continue;
    }
    if (task.status === 'declined') {
      continue;
    }
    total += Math.max(0, Number(task.amountNpr || 0));
  }
  return total;
}

async function fetchRolling24hCashoutUsageNprForPlayer(playerUid: string): Promise<number> {
  const sinceMillis = Date.now() - PLAYER_CASHOUT_ROLLING_WINDOW_MS;
  const q = query(
    collection(db, 'playerCashoutTasks'),
    where('playerUid', '==', playerUid),
    where('createdAt', '>=', new Date(sinceMillis))
  );
  const snapshot = await getDocs(q);
  let total = 0;
  snapshot.forEach((docSnap) => {
    const data = docSnap.data() as { status?: string; amountNpr?: number };
    if (String(data.status || '') === 'declined') {
      return;
    }
    total += Math.max(0, Number(data.amountNpr || 0));
  });
  return total;
}

async function fetchCompletedCashoutCountForPlayer(playerUid: string): Promise<number> {
  const q = query(
    collection(db, 'playerCashoutTasks'),
    where('playerUid', '==', playerUid),
    where('status', '==', 'completed')
  );
  const snapshot = await getDocs(q);
  return snapshot.size;
}

async function fetchLatestCompletedRechargeAmountForPlayer(playerUid: string): Promise<number> {
  const q = query(
    collection(db, 'playerGameRequests'),
    where('playerUid', '==', playerUid),
    where('type', '==', 'recharge'),
    where('status', '==', 'completed'),
    orderBy('completedAt', 'desc'),
    limit(1)
  );

  try {
    const snapshot = await getDocs(q);
    const latest = snapshot.docs[0]?.data() as { amount?: number } | undefined;
    return Math.max(0, Math.round(Number(latest?.amount || 0)));
  } catch {
    const fallback = await getDocs(
      query(
        collection(db, 'playerGameRequests'),
        where('playerUid', '==', playerUid),
        where('type', '==', 'recharge'),
        where('status', '==', 'completed')
      )
    );

    const sorted = fallback.docs
      .map((docSnap) => {
        const data = docSnap.data() as {
          amount?: number;
          completedAt?: Date | null;
          createdAt?: Date | null;
        };
        return {
          amount: Math.max(0, Math.round(Number(data.amount || 0))),
          sortMs: Math.max(
            getSnapshotMs(data.completedAt),
            getSnapshotMs(data.createdAt)
          ),
        };
      })
      .sort((left, right) => right.sortMs - left.sortMs);

    return sorted[0]?.amount || 0;
  }
}

function toTask(docId: string, value: Omit<PlayerCashoutTask, 'id'>): PlayerCashoutTask {
  return { id: docId, ...value };
}

function getSnapshotMs(value?: unknown) {
  if (!value) {
    return 0;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  const maybe = value as { toMillis?: () => number; toDate?: () => Date; seconds?: number };
  if (typeof maybe.toMillis === 'function') {
    return maybe.toMillis();
  }
  if (typeof maybe.toDate === 'function') {
    return maybe.toDate().getTime();
  }
  if (typeof maybe.seconds === 'number') {
    return maybe.seconds * 1000;
  }
  return 0;
}

export function getPlayerCashoutPaymentDisplay(task: PlayerCashoutTask) {
  const rawText = String(task.paymentDetails || '').trim();
  const method = task.payoutMethod || null;
  const qrImageUrl = String(task.qrImageUrl || '').trim() || null;
  const paymentAppName = String(task.paymentAppName || '').trim() || null;
  const paymentAppCashTag = String(task.paymentAppCashTag || '').trim() || null;
  const paymentAppAccountName = String(task.paymentAppAccountName || '').trim() || null;

  if (method === 'qr' || qrImageUrl) {
    return {
      method: 'qr' as const,
      qrImageUrl,
      paymentAppName: null,
      paymentAppCashTag: null,
      paymentAppAccountName: null,
      rawText,
    };
  }

  if (
    method === 'app' ||
    paymentAppName ||
    paymentAppCashTag ||
    paymentAppAccountName
  ) {
    return {
      method: 'app' as const,
      qrImageUrl: null,
      paymentAppName,
      paymentAppCashTag,
      paymentAppAccountName,
      rawText,
    };
  }

  if (/Payout method:\s*QR/i.test(rawText)) {
    const qrMatch = rawText.match(/QR image:\s*(.+)/i);
    return {
      method: 'qr' as const,
      qrImageUrl: qrMatch?.[1]?.trim() || null,
      paymentAppName: null,
      paymentAppCashTag: null,
      paymentAppAccountName: null,
      rawText,
    };
  }

  if (/Payout method:\s*Payment app/i.test(rawText)) {
    const appNameMatch = rawText.match(/App name:\s*(.+)/i);
    const cashTagMatch = rawText.match(/Cash tag:\s*(.+)/i);
    const accountNameMatch = rawText.match(/Name on app:\s*(.+)/i);
    return {
      method: 'app' as const,
      qrImageUrl: null,
      paymentAppName: appNameMatch?.[1]?.trim() || null,
      paymentAppCashTag: cashTagMatch?.[1]?.trim() || null,
      paymentAppAccountName: accountNameMatch?.[1]?.trim() || null,
      rawText,
    };
  }

  return {
    method: null,
    qrImageUrl: null,
    paymentAppName: null,
    paymentAppCashTag: null,
    paymentAppAccountName: null,
    rawText,
  };
}

export function getEffectivePlayerCashoutTaskStatus(task: PlayerCashoutTask) {
  if (
    task.status === 'in_progress' &&
    task.expiresAt &&
    getSnapshotMs(task.expiresAt) <= Date.now()
  ) {
    return 'pending' as const;
  }

  return task.status;
}

export function getPlayerCashoutTaskCountdown(task: PlayerCashoutTask) {
  if (task.status !== 'in_progress' || !task.expiresAt) {
    return 0;
  }

  return Math.max(0, getSnapshotMs(task.expiresAt) - Date.now());
}

/**
 * When a task is in progress under another handler's claim, hide from other viewers' active lists.
 * Expired windows still report effective `pending`, so competing staff can reclaim.
 */
export function isPlayerCashoutHandledBySomeoneElse(task: PlayerCashoutTask, viewerUid: string) {
  const effective = getEffectivePlayerCashoutTaskStatus(task);
  if (effective !== 'in_progress') {
    return false;
  }

  const handlerUid = String(task.assignedHandlerUid || '').trim();
  if (!handlerUid) {
    return false;
  }

  return handlerUid !== String(viewerUid || '').trim();
}

async function getCurrentUserIdentity() {
  const currentUser = auth.currentUser;

  if (!currentUser) {
    throw new Error('Not authenticated.');
  }

  const userSnap = await getDoc(doc(db, 'users', currentUser.uid));

  if (!userSnap.exists()) {
    throw new Error('Current user profile not found.');
  }

  const userData = userSnap.data() as { username?: string; role?: string };

  return {
    uid: currentUser.uid,
    username: userData.username?.trim() || 'Handler',
    role: String(userData.role || '').toLowerCase(),
  };
}

async function getPlayerCashoutAuthHeaders() {
  return getPlayerApiHeaders();
}

async function getCashoutTaskAppSessionHeaders(action: string) {
  try {
    const headers = await getStaffAppSessionApiHeaders(true);
    const flags = staffApiHeaderFlags(headers);
    console.info('[CASHOUT_TASK_SEND] usingAppSessionAuth', {
      action,
      ...flags,
    });
    if (!flags.hasAppSessionId && !flags.usesAuthorizationHeader) {
      console.warn('[CASHOUT_TASK_SEND] blockedMissingStaffCoadminAuth', {
        action,
        ...flags,
      });
      throw new Error('Staff/coadmin session required.');
    }
    return headers;
  } catch (error) {
    console.warn('[CASHOUT_TASK_SEND] blockedMissingStaffCoadminAuth', {
      action,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function readApiError(messageFallback: string, payload: unknown) {
  if (
    payload &&
    typeof payload === 'object' &&
    'message' in payload &&
    typeof (payload as { message?: unknown }).message === 'string'
  ) {
    return String((payload as { message: string }).message || messageFallback);
  }
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

const PLAYER_SAFE_BONUS_ABUSE_CASHOUT_ERROR =
  'Cashout is temporarily unavailable for this account. Please contact support.';

function isPossibleBonusAbusePayloadValue(value: unknown) {
  return String(value || '').trim().toLowerCase() === 'possible bonus abuse';
}

function isPossibleBonusAbusePayload(payload: {
  error?: string | null;
  message?: string | null;
  reason?: string | null;
}) {
  return (
    isPossibleBonusAbusePayloadValue(payload.error) ||
    isPossibleBonusAbusePayloadValue(payload.message) ||
    isPossibleBonusAbusePayloadValue(payload.reason) ||
    String(payload.reason || '').trim().toLowerCase() === 'possible_bonus_abuse'
  );
}

function requestPlayerCashoutRefresh(reason: string, taskId?: string | null) {
  if (typeof window === 'undefined') {
    return;
  }
  window.dispatchEvent(
    new CustomEvent('appbeg:player-cashout-refetch', {
      detail: {
        reason,
        taskId: taskId || null,
      },
    })
  );
}

export async function createPlayerCashoutTask(values: {
  coadminUid: string;
  paymentDetails?: string;
  payoutMethod?: PlayerCashoutPayoutMethod;
  qrImageUrl?: string;
  paymentAppName?: string;
  paymentAppCashTag?: string;
  paymentAppAccountName?: string;
  reuseLastPaymentDetails?: boolean;
  idempotencyKey?: string;
}) {
  const idempotencyKey =
    String(values.idempotencyKey || '').trim() ||
    (typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `cashout-${Date.now()}`);

  const requestBody = {
    ...values,
    idempotencyKey,
  };

  playerDevLog('[PLAYER_CASHOUT_REQUEST_BODY]', requestBody);

  const response = await fetch('/api/player/cashout-tasks/create', {
    method: 'POST',
    credentials: 'include',
    headers: await getPlayerCashoutAuthHeaders(),
    body: JSON.stringify(requestBody),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    message?: string;
    reason?: string;
    taskId?: string;
    success?: boolean;
    authority?: string;
    duplicate?: boolean;
  };
  if (!response.ok) {
    console.error('[PLAYER_CASHOUT_ERROR]', {
      status: response.status,
      error: payload.error || null,
      message: payload.message || null,
      reason: payload.reason || null,
      body: requestBody,
    });
    if (isPossibleBonusAbusePayload(payload)) {
      throw new Error(PLAYER_SAFE_BONUS_ABUSE_CASHOUT_ERROR);
    }
    throw new Error(readApiError('Failed to create cashout request.', payload));
  }

  playerDevLog('[PLAYER_CASHOUT_RESPONSE]', {
    status: response.status,
    taskId: payload.taskId || null,
    authority: payload.authority || null,
    duplicate: payload.duplicate ?? false,
    success: payload.success ?? true,
  });
  requestPlayerCashoutRefresh('create', payload.taskId || null);

  return payload;
}

export async function startPlayerCashoutTask(taskId: string) {
  const action = 'claim';
  const headers = await getCashoutTaskAppSessionHeaders(action);
  const response = await fetch('/api/cashout-tasks/claim', {
    method: 'POST',
    headers,
    body: JSON.stringify({ taskId }),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    conflict?: boolean;
    task?: Partial<CashoutClaimConflictSnapshot> | null;
  };
  if (!response.ok) {
    if (response.status === 409 && isCashoutClaimConflictResponse(payload)) {
      throw new CashoutClaimConflictError(parseCashoutClaimConflictSnapshot(taskId, payload));
    }
    console.warn('[CASHOUT_TASK_SEND] failed', {
      action,
      taskId,
      status: response.status,
      error: payload.error || null,
    });
    throw new Error(readApiError('Failed to claim cashout task.', payload));
  }
  console.info('[CASHOUT_TASK_SEND] success', { action, taskId, status: response.status });
}

export async function completePlayerCashoutTask(taskId: string) {
  const action = 'complete';
  console.info('[CASHOUT_TASK_DONE] attempting', { taskId });
  const headers = await getCashoutTaskAppSessionHeaders(action);
  const response = await fetch('/api/cashout-tasks/complete', {
    method: 'POST',
    headers,
    body: JSON.stringify({ taskId }),
  });
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    console.error('[CASHOUT_TASK_DONE] failed', {
      taskId,
      status: response.status,
      error: payload.error || null,
    });
    throw new Error(readApiError('Failed to complete cashout task.', payload));
  }
  console.info('[CASHOUT_TASK_DONE] success', { taskId, status: 'completed' });
  requestPlayerCashoutRefresh('complete', taskId);
}

export async function releasePlayerCashoutTask(taskId: string) {
  const action = 'release';
  const headers = await getCashoutTaskAppSessionHeaders(action);
  const response = await fetch('/api/cashout-tasks/release', {
    method: 'POST',
    headers,
    body: JSON.stringify({ taskId }),
  });
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    console.warn('[CASHOUT_TASK_SEND] failed', {
      action,
      taskId,
      status: response.status,
      error: payload.error || null,
    });
    throw new Error(readApiError('Failed to release cashout task.', payload));
  }
  console.info('[CASHOUT_TASK_RELEASE] success', { taskId, status: response.status });
}

export function listenStaffCashoutTaskLifecycle(
  coadminUid: string,
  handlers: {
    onPendingChange: (tasks: PlayerCashoutTask[]) => void;
    onActiveChange: (tasks: PlayerCashoutTask[]) => void;
    onCompletedChange: (tasks: PlayerCashoutTask[]) => void;
    onError?: (error: Error) => void;
  }
): { dispose: () => void; refetchNow: () => void } {
  if (isPlayerCashoutSqlReadEnabled()) {
    return attachStaffCashoutLifecyclePoll({
      coadminUid,
      limit: CASHOUT_ACTIVE_LISTENER_LIMIT,
      ...handlers,
    });
  }

  const dispose = listenPlayerCashoutTasksForStaff(coadminUid, (tasks) => {
    const pending = tasks.filter(
      (task) => task.status === 'pending' && !task.assignedHandlerUid
    );
    handlers.onPendingChange(pending);
    handlers.onActiveChange(
      tasks.filter((task) => task.status === 'in_progress')
    );
    handlers.onCompletedChange(
      tasks.filter((task) => task.status === 'completed')
    );
  }, handlers.onError);

  return { dispose, refetchNow: () => {} };
}

export function listenCoadminCashoutTaskLifecycle(
  coadminUid: string,
  handlers: {
    onPendingChange: (tasks: PlayerCashoutTask[]) => void;
    onActiveChange: (tasks: PlayerCashoutTask[]) => void;
    onCompletedChange: (tasks: PlayerCashoutTask[]) => void;
    onError?: (error: Error) => void;
  }
): { dispose: () => void; refetchNow: () => void } {
  if (isPlayerCashoutSqlReadEnabled()) {
    return attachCoadminCashoutLifecyclePoll({
      coadminUid,
      limit: CASHOUT_ACTIVE_LISTENER_LIMIT,
      ...handlers,
    });
  }

  const dispose = listenPlayerCashoutTasksByCoadmin(coadminUid, (tasks) => {
    const pending = tasks.filter(
      (task) => task.status === 'pending' && !task.assignedHandlerUid
    );
    handlers.onPendingChange(pending);
    handlers.onActiveChange(
      tasks.filter((task) => task.status === 'in_progress')
    );
    handlers.onCompletedChange(
      tasks.filter((task) => task.status === 'completed')
    );
  }, handlers.onError);

  return { dispose, refetchNow: () => {} };
}

export async function declinePlayerCashoutTaskForCurrentHandler(taskId: string) {
  const identity = await getCurrentUserIdentity();
  const taskRef = doc(db, 'playerCashoutTasks', taskId);
  await updateDoc(taskRef, {
    declinedByUids: arrayUnion(identity.uid),
  });
  void (async () => {
    try {
      await fetch('/api/player-cashout-tasks/cache/mirror', {
        method: 'POST',
        headers: await getFirebaseApiHeaders(),
        body: JSON.stringify({ action: 'upsert', taskId }),
      });
    } catch (error) {
      console.warn('[PLAYER_CASHOUT_TASKS_CACHE] mirror failed', { taskId, error });
    }
  })();
}

export async function declinePlayerCashoutTaskByCoadmin(taskId: string) {
  const action = 'decline';
  const headers = await getCashoutTaskAppSessionHeaders(action);
  const response = await fetch('/api/cashout-tasks/decline', {
    method: 'POST',
    headers,
    body: JSON.stringify({ taskId }),
  });
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    console.warn('[CASHOUT_TASK_SEND] failed', {
      action,
      taskId,
      status: response.status,
      error: payload.error || null,
    });
    throw new Error(readApiError('Failed to decline cashout task.', payload));
  }
  console.info('[CASHOUT_TASK_SEND] success', { action, taskId, status: response.status });
  requestPlayerCashoutRefresh('decline', taskId);
}

function sortByNewest(tasks: PlayerCashoutTask[]) {
  return [...tasks].sort((left, right) => getSnapshotMs(right.createdAt) - getSnapshotMs(left.createdAt));
}

function getTaskLedgerSortMs(task: PlayerCashoutTask) {
  return Math.max(getSnapshotMs(task.completedAt), getSnapshotMs(task.createdAt));
}

function sortByLedgerNewest(tasks: PlayerCashoutTask[]) {
  return [...tasks].sort(
    (left, right) => getTaskLedgerSortMs(right) - getTaskLedgerSortMs(left)
  );
}

/** Player payout tasks claimed or completed by a specific staff/carer handler. */
export function listenPlayerCashoutTasksByAssignedHandler(
  assignedHandlerUid: string,
  onChange: (tasks: PlayerCashoutTask[]) => void,
  onError?: (error: Error) => void
) {
  if (isPlayerCashoutSqlReadEnabled()) {
    return attachPlayerCashoutTasksSqlPoll({
      scope: 'assigned_handler',
      uid: assignedHandlerUid,
      limit: CASHOUT_HISTORY_LISTENER_LIMIT,
      onChange,
      onError,
    });
  }

  const tasksQuery = query(
    collection(db, 'playerCashoutTasks'),
    where('assignedHandlerUid', '==', assignedHandlerUid),
    orderBy('createdAt', 'desc'),
    limit(CASHOUT_HISTORY_LISTENER_LIMIT)
  );

  return onSnapshot(
    tasksQuery,
    (snapshot) => {
      const tasks = snapshot.docs.map((docSnap) =>
        toTask(docSnap.id, docSnap.data() as Omit<PlayerCashoutTask, 'id'>)
      );
      onChange(sortByLedgerNewest(tasks));
    },
    (error) => onError?.(error as Error)
  );
}

export function listenPlayerCashoutTasksByCoadmin(
  coadminUid: string,
  onChange: (tasks: PlayerCashoutTask[]) => void,
  onError?: (error: Error) => void
) {
  if (isPlayerCashoutSqlReadEnabled()) {
    return attachPlayerCashoutTasksSqlPoll({
      scope: 'coadmin',
      uid: coadminUid,
      limit: CASHOUT_ACTIVE_LISTENER_LIMIT,
      onChange,
      onError,
    });
  }

  const tasksQuery = query(
    collection(db, 'playerCashoutTasks'),
    where('coadminUid', '==', coadminUid),
    orderBy('createdAt', 'desc'),
    limit(CASHOUT_ACTIVE_LISTENER_LIMIT)
  );

  return onSnapshot(
    tasksQuery,
    (snapshot) => {
      const tasks = snapshot.docs
        .map((docSnap) => toTask(docSnap.id, docSnap.data() as Omit<PlayerCashoutTask, 'id'>));
      onChange(sortByNewest(tasks));
    },
    (error) => onError?.(error as Error)
  );
}

export function listenPlayerCashoutTasksForStaff(
  coadminUid: string,
  onChange: (tasks: PlayerCashoutTask[]) => void,
  onError?: (error: Error) => void
) {
  if (isPlayerCashoutSqlReadEnabled()) {
    return attachPlayerCashoutTasksSqlPoll({
      scope: 'staff',
      uid: coadminUid,
      limit: CASHOUT_ACTIVE_LISTENER_LIMIT,
      onChange,
      onError,
    });
  }

  const tasksQuery = query(
    collection(db, 'playerCashoutTasks'),
    where('coadminUid', '==', coadminUid),
    orderBy('createdAt', 'desc'),
    limit(CASHOUT_ACTIVE_LISTENER_LIMIT)
  );

  return onSnapshot(
    tasksQuery,
    (snapshot) => {
      const tasks = snapshot.docs
        .map((docSnap) => toTask(docSnap.id, docSnap.data() as Omit<PlayerCashoutTask, 'id'>));
      onChange(sortByNewest(tasks));
    },
    (error) => onError?.(error as Error)
  );
}

export function listenAllPlayerCashoutTasks(
  onChange: (tasks: PlayerCashoutTask[]) => void,
  onError?: (error: Error) => void
) {
  if (isPlayerCashoutSqlReadEnabled()) {
    return attachPlayerCashoutTasksSqlPoll({
      scope: 'all',
      uid: 'all',
      limit: CASHOUT_ACTIVE_LISTENER_LIMIT,
      onChange,
      onError,
    });
  }

  const tasksQuery = query(
    collection(db, 'playerCashoutTasks'),
    orderBy('createdAt', 'desc'),
    limit(CASHOUT_ACTIVE_LISTENER_LIMIT)
  );

  return onSnapshot(
    tasksQuery,
    (snapshot) => {
      const tasks = snapshot.docs
        .map((docSnap) => toTask(docSnap.id, docSnap.data() as Omit<PlayerCashoutTask, 'id'>));
      onChange(sortByNewest(tasks));
    },
    (error) => onError?.(error as Error)
  );
}

export function listenPlayerCashoutTasksByPlayer(
  playerUid: string,
  onChange: (tasks: PlayerCashoutTask[]) => void,
  onError?: (error: Error) => void
) {
  if (isPlayerCashoutSqlReadEnabled()) {
    return attachPlayerCashoutTasksSqlPoll({
      scope: 'player',
      uid: playerUid,
      limit: CASHOUT_HISTORY_LISTENER_LIMIT,
      onChange,
      onError,
    });
  }

  if (assertClientFirestoreDisabled('player_cashout_tasks_listener', 'onSnapshot', { playerUid })) {
    onChange([]);
    return () => {};
  }

  const tasksQuery = query(
    collection(db, 'playerCashoutTasks'),
    where('playerUid', '==', playerUid),
    orderBy('createdAt', 'desc'),
    limit(CASHOUT_HISTORY_LISTENER_LIMIT)
  );

  return onSnapshot(
    tasksQuery,
    (snapshot) => {
      const tasks = snapshot.docs.map((docSnap) =>
        toTask(docSnap.id, docSnap.data() as Omit<PlayerCashoutTask, 'id'>)
      );
      onChange(sortByNewest(tasks));
    },
    (error) => onError?.(error as Error)
  );
}
