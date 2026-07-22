'use client';

import { User, signOut } from 'firebase/auth';
import {
  doc,
  getDoc,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';

import { getAppSessionRequestHeaders, getLocalAppSessionId, APP_SESSION_EXPIRES_AT_KEY, APP_SESSION_ID_KEY } from '@/features/auth/appSession';
import { isSqlPlayerLoginEnabled } from '@/features/auth/sqlPlayerLoginFlags';
import { clearCachedSessionUser, getCachedSessionUser, getSessionUserOnce } from '@/features/auth/sessionUser';
import { logPlayerFetchBlockedRole } from '@/lib/client/playerFetchGuard';
import { playerDebugLog, playerRuntimeWarn } from '@/lib/client/playerDebugLogs';
import {
  consumePlayerSessionClientContinuation,
  isClientNavigationReload,
  isPlayerRouteNavigationActive,
  isRealAppUnloadEvent,
  markPlayerSessionClientContinuation,
} from '@/lib/client/playerSessionNavigationGuard';
import {
  isPlayerChatRoute,
  logChatLogoutTrigger,
} from '@/lib/client/chatLogoutDiagnostics';
import { resetConsecutiveInvalidSessionStatus } from '@/lib/client/playerSessionInvalidGuard';
import {
  recordPlayerSessionStatusHealth,
  shouldSkipPlayerSessionStatusForRecentSessionMe,
} from '@/lib/client/playerAuthHealth';
import {
  isPlayerSessionStale,
  markPlayerSessionStale,
  registerPlayerSessionStatusPollStop,
  resetPlayerStaleSessionState,
  stopAllPlayerRuntimePolls,
} from '@/lib/client/playerStaleSession';
import { assertClientFirestoreDisabled } from '@/lib/client/clientFirestoreGuard';
import { logClientFirestoreSkipped, isClientSqlReadMode } from '@/lib/client/sqlReadMode';
import {
  isSqlPlayerRuntimeMode,
  logSqlPlayerRuntimeAuth,
} from '@/lib/client/sqlPlayerRuntimeAuth';
import { auth, db } from '@/lib/firebase/client';

export const PLAYER_DEVICE_ID_KEY = 'appbeg:playerDeviceId';
export const PLAYER_SESSION_ID_KEY = 'appbeg:playerSessionId';
export const PLAYER_REPLACED_LOGIN_MESSAGE =
  'You were logged out because this account logged in on another device.';
export const PLAYER_SESSION_REPLACED_LOGIN_PATH = '/login?reason=session_replaced';
export const PLAYER_SESSION_LOADING_MESSAGE = 'Loading secure session...';

/** SQL app + player session pair from bootstrap (independent of NEXT_PUBLIC_SQL_PLAYER_LOGIN). */
export function isSqlPlayerAppSessionMode() {
  return Boolean(getLocalAppSessionId()) && Boolean(getLocalPlayerSessionId());
}

let forcedPlayerLogout = false;

function isCurrentPlayerRoute() {
  if (typeof window === 'undefined') {
    return false;
  }
  const pathname = window.location.pathname || '';
  return pathname === '/player' || pathname.startsWith('/player/');
}

const PLAYER_SESSION_END_DEDUP_MS = 2_000;
let lastPlayerSessionEndSent: {
  sessionId: string;
  reason: string;
  at: number;
} | null = null;

export type PlayerSessionEndClientContext = {
  reason: string;
  trigger: string;
  route?: string;
  currentPath?: string;
  nextPath?: string | null;
  visibilityState?: string | null;
  generation?: number;
  appSessionIdPrefix?: string | null;
  playerSessionIdPrefix?: string | null;
  isCurrentGeneration?: boolean;
  isLogoutInProgress?: boolean;
  isRouteNavigation?: boolean;
  willSendEnd?: boolean;
  file?: string;
  function?: string;
  stack?: string;
  userClickedLogout?: boolean;
  uid?: string | null;
  role?: string | null;
};

export type PlayerSessionEndCallerLog = {
  reason: string;
  trigger: string;
  file: string;
  function: string;
  currentPath: string;
  uid: string | null;
  role: string | null;
  appSessionIdPrefix: string | null;
  playerSessionIdPrefix: string | null;
  stack: string;
  userClickedLogout: boolean;
  isRouteNavigation: boolean;
  visibilityState: string | null;
  willSend: boolean;
};

function sessionIdPrefix(value: string | null | undefined) {
  const clean = String(value || '').trim();
  return clean ? clean.slice(0, 8) : null;
}

function currentClientPath() {
  if (typeof window === 'undefined') {
    return '';
  }
  return window.location.pathname || '';
}

function captureCallerStack() {
  if (typeof Error === 'undefined') {
    return '';
  }
  const stack = new Error('[PLAYER_SESSION_END_CALLER]').stack;
  if (!stack) {
    return '';
  }
  return stack
    .split('\n')
    .slice(2, 14)
    .map((line) => line.trim())
    .join('\n');
}

function readPlayerSessionEndActor() {
  const cached = getCachedSessionUser();
  return {
    uid: cached?.uid ?? null,
    role: cached?.role ?? null,
  };
}

export function logPlayerSessionEndCaller(values: PlayerSessionEndCallerLog) {
  playerDebugLog('[PLAYER_SESSION_END_CALLER]', values);
}

function logPlayerSessionEndClient(values: PlayerSessionEndClientContext) {
  const actor = readPlayerSessionEndActor();
  const callerLog: PlayerSessionEndCallerLog = {
    reason: values.reason,
    trigger: values.trigger,
    file: values.file || 'features/auth/playerSession.ts',
    function: values.function || 'endLocalPlayerSession',
    currentPath: values.currentPath || currentClientPath(),
    uid: values.uid ?? actor.uid,
    role: values.role ?? actor.role,
    appSessionIdPrefix: values.appSessionIdPrefix ?? null,
    playerSessionIdPrefix: values.playerSessionIdPrefix ?? null,
    stack: values.stack || captureCallerStack(),
    userClickedLogout: values.userClickedLogout === true,
    isRouteNavigation: values.isRouteNavigation === true,
    visibilityState: values.visibilityState ?? null,
    willSend: values.willSendEnd === true,
  };
  logPlayerSessionEndCaller(callerLog);
  playerDebugLog('[PLAYER_SESSION_END_CLIENT]', values);
}

function shouldDedupPlayerSessionEnd(sessionId: string, reason: string) {
  const now = Date.now();
  if (
    lastPlayerSessionEndSent &&
    lastPlayerSessionEndSent.sessionId === sessionId &&
    lastPlayerSessionEndSent.reason === reason &&
    now - lastPlayerSessionEndSent.at < PLAYER_SESSION_END_DEDUP_MS
  ) {
    return true;
  }
  lastPlayerSessionEndSent = { sessionId, reason, at: now };
  return false;
}

const DEFAULT_PLAYER_SESSION_POLL_INTERVAL_MS = 15_000;
const PLAYER_SESSION_VERIFY_CACHE_TTL_MS = 8_000;
let activePlayerSessionPollStop: (() => void) | null = null;

type PlayerSessionVerifyCacheEntry = {
  expiresAt: number;
  localSessionId: string;
  result: PlayerSessionVerifyResult;
};

let playerSessionVerifyCache: PlayerSessionVerifyCacheEntry | null = null;
let verifyActivePlayerSessionInflight: Promise<PlayerSessionVerifyResult> | null = null;

let expectedPlayerSessionId = '';
let playerSessionReady = false;
let playerSessionGeneration = 0;
let playerSessionReadyWaiters: Array<() => void> = [];
let gateValidatedSessionId: string | null = null;
let ensurePlayerSessionGateInflight: Promise<PlayerSessionGateResult> | null = null;

export class PlayerSessionStaleError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'PlayerSessionStaleError';
  }
}

function notifyPlayerSessionReadyWaiters() {
  const waiters = playerSessionReadyWaiters;
  playerSessionReadyWaiters = [];
  waiters.forEach((resolve) => resolve());
}

export function logPlayerSessionClientState(values: {
  phase: string;
  oldPlayerSessionId?: string | null;
  newPlayerSessionId?: string | null;
  appSessionId?: string | null;
  reason: string;
}) {
  playerDebugLog('[PLAYER_SESSION_CLIENT_STATE]', {
    phase: values.phase,
    oldPlayerSessionId: values.oldPlayerSessionId ?? null,
    newPlayerSessionId: values.newPlayerSessionId ?? null,
    appSessionId: values.appSessionId ?? (getLocalAppSessionId() || null),
    reason: values.reason,
  });
}

export function clearPlayerSessionBeforeLogin(reason = 'login_start') {
  stopAllPlayerRuntimePolls('login_clear', reason);
  resetPlayerStaleSessionState(reason);

  const oldPlayerSessionId = getLocalPlayerSessionId() || null;
  playerSessionReady = false;
  expectedPlayerSessionId = '';
  gateValidatedSessionId = null;
  playerSessionGeneration += 1;
  invalidatePlayerSessionVerifyCache(reason);
  if (typeof window !== 'undefined' && oldPlayerSessionId) {
    window.localStorage.removeItem(PLAYER_SESSION_ID_KEY);
  }
  logPlayerSessionClientState({
    phase: 'login_clear',
    oldPlayerSessionId,
    newPlayerSessionId: null,
    reason,
  });
}

export function resetPlayerAuthClientOnLogout(reason = 'logout') {
  stopPlayerSessionStatusPolling();
  forcedPlayerLogout = false;
  clearPlayerSessionBeforeLogin(reason);
}

export function storePlayerLoginSessionPair(values: {
  appSessionId: string;
  appSessionExpiresAt: string;
  playerSessionId: string;
  phase: string;
  reason: string;
}) {
  stopAllPlayerRuntimePolls('session_pair_store', values.reason);
  resetPlayerStaleSessionState(values.reason);

  const oldPlayerSessionId = getLocalPlayerSessionId() || null;
  const oldAppSessionId = getLocalAppSessionId() || null;
  const nextAppSessionId = String(values.appSessionId || '').trim();
  const nextPlayerSessionId = String(values.playerSessionId || '').trim();
  if (!nextAppSessionId || !nextPlayerSessionId) {
    throw new Error('App session and player session are required.');
  }

  forcedPlayerLogout = false;
  invalidatePlayerSessionVerifyCache('login_session_pair_stored');

  const keysWritten = [APP_SESSION_ID_KEY, PLAYER_SESSION_ID_KEY];
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(APP_SESSION_ID_KEY, nextAppSessionId);
    if (values.appSessionExpiresAt) {
      window.localStorage.setItem(APP_SESSION_EXPIRES_AT_KEY, values.appSessionExpiresAt);
      keysWritten.push(APP_SESSION_EXPIRES_AT_KEY);
    }
    window.localStorage.setItem(PLAYER_SESSION_ID_KEY, nextPlayerSessionId);
  }

  if (oldAppSessionId && oldAppSessionId !== nextAppSessionId) {
    clearCachedSessionUser('session_id_replaced');
  }

  expectedPlayerSessionId = nextPlayerSessionId;
  playerSessionGeneration += 1;
  playerSessionReady = true;
  gateValidatedSessionId = nextPlayerSessionId;
  notifyPlayerSessionReadyWaiters();

  logPlayerSessionStorageWrite({
    source: values.phase,
    appSessionIdPrefix: sessionIdPrefix(nextAppSessionId),
    playerSessionIdPrefix: sessionIdPrefix(nextPlayerSessionId),
    keysWritten,
    role: 'player',
  });

  logPlayerSessionClientState({
    phase: values.phase,
    oldPlayerSessionId,
    newPlayerSessionId: nextPlayerSessionId,
    appSessionId: nextAppSessionId,
    reason: values.reason,
  });
}

function readPlayerSessionReadyContext() {
  const cached = getCachedSessionUser();
  return {
    route: currentClientPath(),
    uid: cached?.uid ?? auth.currentUser?.uid ?? null,
    role: cached?.role ?? null,
    appSessionId: getLocalAppSessionId() || null,
    playerSessionId: getLocalPlayerSessionId() || null,
  };
}

export function readPlayerSessionGateDebugState() {
  return {
    inMemoryReady: playerSessionReady,
    expectedPlayerSessionId: expectedPlayerSessionId || null,
    gateValidatedSessionId,
  };
}

export function logPlayerSessionReadyState(values: {
  source: string;
  sessionReady: boolean;
  loading?: boolean;
}) {
  const context = readPlayerSessionReadyContext();
  playerDebugLog('[PLAYER_SESSION_READY_STATE]', {
    route: context.route,
    uid: context.uid,
    role: context.role,
    appSessionId: context.appSessionId,
    playerSessionId: context.playerSessionId,
    sessionReady: values.sessionReady,
    loading: values.loading ?? isPlayerSessionLoading(),
    source: values.source,
    inMemoryReady: playerSessionReady,
    expectedPlayerSessionId: expectedPlayerSessionId || null,
  });
}

function logPlayerSessionWait(values: {
  startedAt: number;
  timeoutMs: number;
  result: 'ready' | 'timeout' | 'started';
  appSessionExists: boolean;
  playerSessionExists: boolean;
}) {
  const durationMs = Date.now() - values.startedAt;
  playerDebugLog('[PLAYER_SESSION_WAIT]', {
    startedAt: values.startedAt,
    appSessionExists: values.appSessionExists,
    playerSessionExists: values.playerSessionExists,
    timeoutMs: values.timeoutMs,
    result: values.result,
    durationMs,
  });
}

export function logPlayerSessionStorageWrite(values: {
  source: string;
  appSessionIdPrefix: string | null;
  playerSessionIdPrefix: string | null;
  keysWritten: string[];
  role: string | null;
}) {
  playerDebugLog('[PLAYER_SESSION_STORAGE_WRITE]', values);
}

function logPlayerSessionStorageHydrate(values: {
  hasAppSessionId: boolean;
  hasPlayerSessionId: boolean;
  appSessionIdPrefix: string | null;
  playerSessionIdPrefix: string | null;
  beforeReady: boolean;
  beforeExpected: string | null;
  afterReady: boolean;
  afterExpected: string | null;
  reason: string;
}) {
  playerDebugLog('[PLAYER_SESSION_STORAGE_HYDRATE]', values);
}

/**
 * Reconcile in-memory ready flags from localStorage when both session IDs exist.
 * After a full page load, localStorage can have valid IDs while module state is still false.
 */
export function syncPlayerSessionReadyFromStorage(source: string) {
  const appSessionId = getLocalAppSessionId();
  const localSessionId = getLocalPlayerSessionId();
  if (!appSessionId || !localSessionId || forcedPlayerLogout) {
    return false;
  }

  if (expectedPlayerSessionId && expectedPlayerSessionId !== localSessionId) {
    logPlayerSessionReadyState({
      source: `${source}:storage_mismatch`,
      sessionReady: false,
      loading: true,
    });
    return false;
  }

  const beforeReady = playerSessionReady;
  const beforeExpected = expectedPlayerSessionId || null;
  const changed =
    !playerSessionReady ||
    !expectedPlayerSessionId ||
    expectedPlayerSessionId !== localSessionId;

  expectedPlayerSessionId = localSessionId;
  playerSessionReady = true;
  logPlayerSessionStorageHydrate({
    hasAppSessionId: true,
    hasPlayerSessionId: true,
    appSessionIdPrefix: sessionIdPrefix(appSessionId),
    playerSessionIdPrefix: sessionIdPrefix(localSessionId),
    beforeReady,
    beforeExpected,
    afterReady: playerSessionReady,
    afterExpected: expectedPlayerSessionId,
    reason: source,
  });
  if (changed) {
    notifyPlayerSessionReadyWaiters();
    logPlayerSessionClientState({
      phase: 'storage_hydrate',
      oldPlayerSessionId: null,
      newPlayerSessionId: localSessionId,
      appSessionId,
      reason: source,
    });
    logPlayerSessionReadyState({
      source,
      sessionReady: true,
      loading: false,
    });
  }
  return true;
}

export function isPlayerSessionLoading() {
  if (forcedPlayerLogout) {
    return false;
  }

  const cached = getCachedSessionUser();
  const appSessionId = getLocalAppSessionId();
  const localSessionId = getLocalPlayerSessionId();

  if (cached?.role === 'player' && appSessionId && !localSessionId) {
    return true;
  }

  if (!appSessionId || !localSessionId) {
    return false;
  }

  if (expectedPlayerSessionId && expectedPlayerSessionId !== localSessionId) {
    return false;
  }

  syncPlayerSessionReadyFromStorage('isPlayerSessionLoading');

  if (gateValidatedSessionId === localSessionId) {
    return false;
  }

  const cachedVerify = readPlayerSessionVerifyCache(localSessionId);
  if (cachedVerify?.ok) {
    gateValidatedSessionId = localSessionId;
    return false;
  }

  return true;
}

function isPlayerSessionReadyInternal() {
  const localSessionId = getLocalPlayerSessionId();
  return (
    playerSessionReady &&
    Boolean(expectedPlayerSessionId) &&
    Boolean(localSessionId) &&
    localSessionId === expectedPlayerSessionId &&
    Boolean(getLocalAppSessionId())
  );
}

export function isPlayerSessionReady() {
  syncPlayerSessionReadyFromStorage('isPlayerSessionReady');
  if (!isPlayerSessionReadyInternal()) {
    return false;
  }
  const localSessionId = getLocalPlayerSessionId();
  if (!localSessionId) {
    return false;
  }
  if (gateValidatedSessionId === localSessionId) {
    return true;
  }
  const cachedVerify = readPlayerSessionVerifyCache(localSessionId);
  return Boolean(cachedVerify?.ok);
}

export type PlayerSessionGateResult =
  | { state: 'ready' }
  | { state: 'loading'; reason: string }
  | { state: 'failed'; reason: string };

async function recoverPlayerSessionIdFromSessionMe(source: string) {
  const hadLocalPlayerSessionId = Boolean(getLocalPlayerSessionId());
  const appSessionId = getLocalAppSessionId();

  const logRecovery = (values: {
    sessionMePlayerSessionIdPrefix?: string | null;
    wroteStorage: boolean;
    statusCheckStarted: boolean;
    statusOk: boolean;
    reason: string;
  }) => {
    playerDebugLog('[PLAYER_SESSION_RECOVER_FROM_SESSION_ME]', {
      hadLocalPlayerSessionId,
      sessionMePlayerSessionIdPrefix: values.sessionMePlayerSessionIdPrefix ?? null,
      wroteStorage: values.wroteStorage,
      statusCheckStarted: values.statusCheckStarted,
      statusOk: values.statusOk,
      reason: values.reason,
    });
  };

  if (!appSessionId) {
    logRecovery({
      wroteStorage: false,
      statusCheckStarted: false,
      statusOk: false,
      reason: 'missing_app_session',
    });
    return null;
  }

  if (hadLocalPlayerSessionId) {
    return getLocalPlayerSessionId();
  }

  try {
    const sessionUser = await getSessionUserOnce();
    if (!sessionUser || sessionUser.role !== 'player') {
      logRecovery({
        wroteStorage: false,
        statusCheckStarted: false,
        statusOk: false,
        reason: 'session_me_not_player',
      });
      return null;
    }

    const recoveredId = String(
      sessionUser.playerSessionId || sessionUser.canonicalSessionId || ''
    ).trim();
    if (!recoveredId) {
      logRecovery({
        wroteStorage: false,
        statusCheckStarted: false,
        statusOk: false,
        reason: 'session_me_missing_player_session_id',
      });
      return null;
    }

    storeLocalPlayerSessionId(recoveredId);
    syncPlayerSessionReadyFromStorage(`${source}:session_me_recovery`);
    logPlayerSessionStorageWrite({
      source: `${source}:session_me_recovery`,
      appSessionIdPrefix: sessionIdPrefix(appSessionId),
      playerSessionIdPrefix: sessionIdPrefix(recoveredId),
      keysWritten: [PLAYER_SESSION_ID_KEY],
      role: 'player',
    });

    let statusOk = false;
    const status = await verifyActivePlayerSession({ forceRefresh: true });
    statusOk = status.ok;
    if (statusOk) {
      gateValidatedSessionId = recoveredId;
      seedPlayerSessionVerifyCache(status);
    }

    logRecovery({
      sessionMePlayerSessionIdPrefix: sessionIdPrefix(recoveredId),
      wroteStorage: true,
      statusCheckStarted: true,
      statusOk,
      reason: statusOk
        ? 'recovered_and_verified'
        : !status.ok
          ? status.reason
          : 'status_pending',
    });
    return recoveredId;
  } catch {
    logRecovery({
      wroteStorage: false,
      statusCheckStarted: false,
      statusOk: false,
      reason: 'session_me_fetch_failed',
    });
    return null;
  }
}

export async function ensurePlayerSessionGateReady(options?: {
  source?: string;
  forceRefresh?: boolean;
}): Promise<PlayerSessionGateResult> {
  const source = String(options?.source || 'unknown').trim() || 'unknown';

  if (ensurePlayerSessionGateInflight && !options?.forceRefresh) {
    return ensurePlayerSessionGateInflight;
  }

  const run = async (): Promise<PlayerSessionGateResult> => {
    const cached = getCachedSessionUser();
    const sessionUser =
      cached?.role === 'player' ? cached : await getSessionUserOnce().catch(() => null);

    if (!sessionUser || sessionUser.role !== 'player') {
      return { state: 'failed', reason: 'not_player_role' };
    }

    const appSessionId = getLocalAppSessionId();
    if (!appSessionId) {
      return { state: 'failed', reason: 'missing_app_session' };
    }

    if (!getLocalPlayerSessionId()) {
      await recoverPlayerSessionIdFromSessionMe(source);
    }

    const playerSessionId = getLocalPlayerSessionId();
    if (!playerSessionId) {
      return { state: 'loading', reason: 'missing_player_session_id' };
    }

    syncPlayerSessionReadyFromStorage(`${source}:gate`);

    if (
      !options?.forceRefresh &&
      gateValidatedSessionId === playerSessionId &&
      isPlayerSessionReadyInternal()
    ) {
      const cachedVerify = readPlayerSessionVerifyCache(playerSessionId);
      if (cachedVerify?.ok) {
        return { state: 'ready' };
      }
    }

    const status = await verifyActivePlayerSession({
      forceRefresh: options?.forceRefresh,
    });

    if (status.ok) {
      gateValidatedSessionId = playerSessionId;
      resetConsecutiveInvalidSessionStatus('gate_status_ok');
      seedPlayerSessionVerifyCache(status);
      syncPlayerSessionReadyFromStorage(`${source}:gate_verified`);
      logSqlPlayerRuntimeAuth({
        source: 'session_me',
        uid: sessionUser.uid,
        role: sessionUser.role,
        coadminUid: sessionUser.coadminUid ?? null,
        appSessionIdPrefix: sessionIdPrefix(appSessionId),
        playerSessionIdPrefix: sessionIdPrefix(playerSessionId),
        sessionSource: sessionUser.sessionSource ?? 'sql',
        firebaseIgnored: isSqlPlayerRuntimeMode(),
        ready: true,
        blocked: false,
        reason: 'gate_ready',
      });
      return { state: 'ready' };
    }

    if (status.reason === 'session_replaced' || status.reason === 'session_inactive') {
      markPlayerSessionStale(status.reason, 'ensurePlayerSessionGateReady');
      logSqlPlayerRuntimeAuth({
        source: 'session_me',
        uid: sessionUser.uid,
        role: sessionUser.role,
        coadminUid: sessionUser.coadminUid ?? null,
        appSessionIdPrefix: sessionIdPrefix(appSessionId),
        playerSessionIdPrefix: sessionIdPrefix(playerSessionId),
        sessionSource: sessionUser.sessionSource ?? 'sql',
        firebaseIgnored: isSqlPlayerRuntimeMode(),
        ready: false,
        blocked: true,
        reason: status.reason,
      });
      return { state: 'failed', reason: status.reason };
    }

    logSqlPlayerRuntimeAuth({
      source: 'session_me',
      uid: sessionUser.uid,
      role: sessionUser.role,
      coadminUid: sessionUser.coadminUid ?? null,
      appSessionIdPrefix: sessionIdPrefix(appSessionId),
      playerSessionIdPrefix: sessionIdPrefix(playerSessionId),
      sessionSource: sessionUser.sessionSource ?? 'sql',
      firebaseIgnored: isSqlPlayerRuntimeMode(),
      ready: false,
      blocked: false,
      reason: status.reason || 'status_pending',
    });
    return { state: 'loading', reason: status.reason || 'status_pending' };
  };

  ensurePlayerSessionGateInflight = run();
  try {
    return await ensurePlayerSessionGateInflight;
  } finally {
    ensurePlayerSessionGateInflight = null;
  }
}

export async function waitForPlayerSessionReady(timeoutMs = 15_000) {
  const startedAt = Date.now();
  const appSessionExists = Boolean(getLocalAppSessionId());
  const playerSessionExists = Boolean(getLocalPlayerSessionId());

  logPlayerSessionWait({
    startedAt,
    timeoutMs,
    result: 'started',
    appSessionExists,
    playerSessionExists,
  });

  while (Date.now() - startedAt < timeoutMs) {
    const gate = await ensurePlayerSessionGateReady({
      source: 'waitForPlayerSessionReady',
    });
    if (gate.state === 'ready') {
      logPlayerSessionWait({
        startedAt,
        timeoutMs,
        result: 'ready',
        appSessionExists: Boolean(getLocalAppSessionId()),
        playerSessionExists: Boolean(getLocalPlayerSessionId()),
      });
      return;
    }
    if (gate.state === 'failed') {
      logPlayerSessionWait({
        startedAt,
        timeoutMs,
        result: 'timeout',
        appSessionExists: Boolean(getLocalAppSessionId()),
        playerSessionExists: Boolean(getLocalPlayerSessionId()),
      });
      throw new Error(PLAYER_SESSION_LOADING_MESSAGE);
    }
    await new Promise<void>((resolve) => {
      playerSessionReadyWaiters.push(resolve);
      window.setTimeout(resolve, 100);
    });
  }

  logPlayerSessionWait({
    startedAt,
    timeoutMs,
    result: 'timeout',
    appSessionExists: Boolean(getLocalAppSessionId()),
    playerSessionExists: Boolean(getLocalPlayerSessionId()),
  });
  throw new Error(PLAYER_SESSION_LOADING_MESSAGE);
}

export function getPlayerSessionGeneration() {
  return playerSessionGeneration;
}

export function assertPlayerSessionRequestCurrent(capturedGeneration: number, capturedSessionId: string) {
  if (!isSqlPlayerAppSessionMode() && !isSqlPlayerRuntimeMode()) {
    return;
  }
  if (capturedGeneration !== playerSessionGeneration) {
    throw new PlayerSessionStaleError('player_session_generation_stale');
  }
  const currentSessionId = getLocalPlayerSessionId();
  if (
    !currentSessionId ||
    currentSessionId !== capturedSessionId ||
    currentSessionId !== expectedPlayerSessionId
  ) {
    throw new PlayerSessionStaleError('player_session_id_stale');
  }
}

function markPlayerSessionReady(playerSessionId: string, phase: string, reason: string) {
  const cleanSessionId = String(playerSessionId || '').trim();
  if (!cleanSessionId) {
    return;
  }
  expectedPlayerSessionId = cleanSessionId;
  playerSessionReady = Boolean(getLocalAppSessionId());
  playerSessionGeneration += 1;
  if (playerSessionReady) {
    notifyPlayerSessionReadyWaiters();
  }
  logPlayerSessionClientState({
    phase,
    oldPlayerSessionId: null,
    newPlayerSessionId: cleanSessionId,
    reason,
  });
}

function makeId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function getPlayerSessionDevice(deviceId: string) {
  if (typeof window === 'undefined') {
    return { deviceId };
  }

  return {
    deviceId,
    userAgent: window.navigator.userAgent,
    platform: window.navigator.platform,
  };
}

export function getOrCreatePlayerDeviceId() {
  if (typeof window === 'undefined') {
    return '';
  }

  const existing = window.localStorage.getItem(PLAYER_DEVICE_ID_KEY);
  if (existing) {
    return existing;
  }

  const next = makeId();
  window.localStorage.setItem(PLAYER_DEVICE_ID_KEY, next);
  return next;
}

export function getLocalPlayerSessionId() {
  if (typeof window === 'undefined') {
    return '';
  }
  return window.localStorage.getItem(PLAYER_SESSION_ID_KEY) || '';
}

export function discardStalePlayerSessionIdForRole(role: string, reason = 'non_player_role') {
  const normalizedRole = String(role || '').trim().toLowerCase();
  if (normalizedRole === 'player') {
    return;
  }
  const existing = getLocalPlayerSessionId();
  if (!existing) {
    return;
  }
  if (typeof window !== 'undefined') {
    window.localStorage.removeItem(PLAYER_SESSION_ID_KEY);
  }
  invalidatePlayerSessionVerifyCache(reason);
  playerDebugLog('[PLAYER_SESSION_LOCAL] discarded_stale_id', {
    reason,
    role: normalizedRole,
    sessionIdPrefix: existing.slice(0, 8),
  });
}

export function storeLocalPlayerSessionId(sessionId: string) {
  forcedPlayerLogout = false;
  invalidatePlayerSessionVerifyCache('session_id_replaced');
  const cleanSessionId = String(sessionId || '').trim();
  if (!cleanSessionId || typeof window === 'undefined') {
    return;
  }
  window.localStorage.setItem(PLAYER_SESSION_ID_KEY, cleanSessionId);
  markPlayerSessionReady(cleanSessionId, 'session_id_stored', 'local_player_session_updated');
  gateValidatedSessionId = cleanSessionId;
  logPlayerSessionStorageWrite({
    source: 'storeLocalPlayerSessionId',
    appSessionIdPrefix: sessionIdPrefix(getLocalAppSessionId()),
    playerSessionIdPrefix: sessionIdPrefix(cleanSessionId),
    keysWritten: [PLAYER_SESSION_ID_KEY],
    role: getCachedSessionUser()?.role ?? 'player',
  });
}

export function invalidatePlayerSessionVerifyCache(reason = 'manual') {
  playerSessionVerifyCache = null;
  playerDebugLog('[PLAYER_SESSION_VERIFY_CACHE]', {
    hit: false,
    reason,
  });
}

function readPlayerSessionVerifyCache(localSessionId: string) {
  if (!playerSessionVerifyCache) {
    return null;
  }
  if (
    playerSessionVerifyCache.localSessionId !== localSessionId ||
    playerSessionVerifyCache.expiresAt <= Date.now()
  ) {
    playerSessionVerifyCache = null;
    return null;
  }
  return playerSessionVerifyCache.result;
}

function writePlayerSessionVerifyCache(
  localSessionId: string,
  result: PlayerSessionVerifyResult
) {
  if (!result.ok) {
    playerSessionVerifyCache = null;
    return;
  }
  playerSessionVerifyCache = {
    expiresAt: Date.now() + PLAYER_SESSION_VERIFY_CACHE_TTL_MS,
    localSessionId,
    result,
  };
}

export function seedPlayerSessionVerifyCache(result: PlayerSessionVerifyResult) {
  const localSessionId = getLocalPlayerSessionId();
  if (!localSessionId || !result.ok) {
    return;
  }
  writePlayerSessionVerifyCache(localSessionId, result);
}

export function resolvePlayerApiHeaderMode(headers: Record<string, string>) {
  const hasBearer = Boolean(headers.Authorization);
  const hasAppSession = Boolean(headers['X-App-Session-Id']);
  if (hasBearer && hasAppSession) {
    return 'mixed';
  }
  if (hasBearer) {
    return 'firebase';
  }
  return 'app_session';
}

async function buildPlayerSessionRequestHeaders(contentType = false) {
  const sessionId = getLocalPlayerSessionId();
  const sqlPlayerMode = isSqlPlayerRuntimeMode() || isSqlPlayerAppSessionMode();
  const headers: Record<string, string> = {
    ...getAppSessionRequestHeaders(),
  };
  if (contentType) {
    headers['Content-Type'] = 'application/json';
  }
  if (sessionId) {
    headers['X-Player-Session-Id'] = sessionId;
  }
  const currentUser = auth.currentUser;
  if (currentUser && !sqlPlayerMode) {
    headers.Authorization = `Bearer ${await currentUser.getIdToken()}`;
  }
  return headers;
}

export function isPlayerForcedLogout() {
  return forcedPlayerLogout;
}

export function clearPlayerBrowserState() {
  invalidatePlayerSessionVerifyCache('browser_state_cleared');
  playerSessionReady = false;
  expectedPlayerSessionId = '';
  gateValidatedSessionId = null;
  playerSessionGeneration += 1;
  notifyPlayerSessionReadyWaiters();
  if (typeof window === 'undefined') {
    return;
  }
  logChatLogoutTrigger({
    file: 'features/auth/playerSession.ts',
    function: 'clearPlayerBrowserState',
    reason: 'clearing_local_session',
    trigger: 'clearPlayerBrowserState',
  });
  playerDebugLog('[SESSION_GUARD] clearing local session');
  const deviceId = window.localStorage.getItem(PLAYER_DEVICE_ID_KEY);
  window.localStorage.clear();
  window.sessionStorage.clear();
  if (deviceId) {
    window.localStorage.setItem(PLAYER_DEVICE_ID_KEY, deviceId);
  }
  window.dispatchEvent(new Event('appbeg:player-session-cleared'));
}

export function stopPlayerSessionStatusPolling() {
  activePlayerSessionPollStop?.();
  activePlayerSessionPollStop = null;
}

export type PlayerSessionStatusPollingOptions = {
  intervalMs?: number;
  onReplaced?: () => void;
  onInactive?: () => void;
  redirect?: (url: string) => void;
};

export function startPlayerSessionStatusPolling(
  options: PlayerSessionStatusPollingOptions = {}
) {
  stopPlayerSessionStatusPolling();

  if (typeof window === 'undefined') {
    return () => {};
  }

  const intervalMs = options.intervalMs ?? DEFAULT_PLAYER_SESSION_POLL_INTERVAL_MS;
  const sessionId = getLocalPlayerSessionId();
  if (!sessionId) {
    return () => {};
  }
  if (!isCurrentPlayerRoute()) {
    playerDebugLog('[PLAYER_SESSION_STATUS] skippedNonPlayerRoute', {
      pathname: window.location.pathname || null,
      hasPlayerSessionId: true,
      source: 'startPlayerSessionStatusPolling',
    });
    return () => {};
  }
  const cachedUser = getCachedSessionUser();
  if (cachedUser?.role && cachedUser.role !== 'player') {
    playerDebugLog('[PLAYER_SESSION_STATUS] skippedNonPlayerRole', {
      role: cachedUser.role,
      uid: cachedUser.uid || null,
      hasPlayerSessionId: true,
      source: 'startPlayerSessionStatusPolling',
    });
    return () => {};
  }

  playerDebugLog('[PLAYER_SESSION_POLL]', {
    started: true,
    sessionId,
    intervalMs,
  });

  let stopped = false;
  let timeoutId: number | undefined;
  let inFlight = false;

  const stop = () => {
    stopped = true;
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
      timeoutId = undefined;
    }
    if (activePlayerSessionPollStop === stop) {
      activePlayerSessionPollStop = null;
    }
  };

  const scheduleNext = (delayMs: number) => {
    if (stopped) {
      return;
    }
    timeoutId = window.setTimeout(() => {
      void tick();
    }, delayMs);
  };

  const tick = async () => {
    if (stopped || isPlayerSessionStale()) {
      stop();
      return;
    }
    if (!isCurrentPlayerRoute()) {
      playerDebugLog('[PLAYER_SESSION_STATUS] skippedNonPlayerRoute', {
        pathname: window.location.pathname || null,
        hasPlayerSessionId: Boolean(getLocalPlayerSessionId()),
        source: 'player_session_poll_tick',
      });
      stop();
      return;
    }

    if (document.hidden) {
      scheduleNext(intervalMs + Math.floor(Math.random() * 1_000));
      return;
    }

    if (inFlight || forcedPlayerLogout) {
      scheduleNext(intervalMs);
      return;
    }

    inFlight = true;
    const pollSessionId = getLocalPlayerSessionId();

    try {
      const status = await verifyActivePlayerSession({ forceRefresh: true });
      if (stopped) {
        return;
      }

      if (status.ok) {
        playerDebugLog('[PLAYER_SESSION_POLL]', {
          status: 'ok',
          sessionId: pollSessionId,
        });
        scheduleNext(intervalMs);
        return;
      }

      if (status.reason === 'session_replaced' || status.reason === 'session_inactive') {
        playerRuntimeWarn('[PLAYER_SESSION_POLL]', {
          status: status.reason,
          sessionId: pollSessionId,
          activeSessionId: status.activeSessionId || null,
        });
        stop();
        if (status.reason === 'session_replaced') {
          options.onReplaced?.();
        } else {
          options.onInactive?.();
        }
        await handleDefinitivePlayerSessionFailure(status.reason, {
          pollName: 'player_session_poll',
          redirect: options.redirect,
        });
        return;
      }

      playerRuntimeWarn('[PLAYER_SESSION_POLL]', {
        status: 'error',
        sessionId: pollSessionId,
        reason: status.reason,
      });
      scheduleNext(intervalMs);
    } catch (error) {
      playerRuntimeWarn('[PLAYER_SESSION_POLL]', {
        status: 'error',
        sessionId: pollSessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      scheduleNext(intervalMs);
    } finally {
      inFlight = false;
    }
  };

  activePlayerSessionPollStop = stop;
  registerPlayerSessionStatusPollStop(stop);
  scheduleNext(intervalMs);

  return stop;
}

export async function handleDefinitivePlayerSessionFailure(
  reason: 'session_replaced' | 'session_inactive',
  options: {
    pollName: string;
    redirect?: (url: string) => void;
  }
) {
  stopPlayerSessionStatusPolling();

  if (isSqlPlayerRuntimeMode() || isSqlPlayerAppSessionMode() || getLocalAppSessionId()) {
    markPlayerSessionStale(reason, options.pollName, {
      redirect: options.redirect,
    });
    return;
  }

  await forcePlayerSessionLogout({
    redirect: options.redirect,
    markSessionInactive: false,
    trigger: options.pollName,
    sourceFile: 'features/auth/playerSession.ts',
    sourceFunction: 'handleDefinitivePlayerSessionFailure',
    reason,
  });
}

export async function forcePlayerSessionLogout(options?: {
  redirect?: (url: string) => void;
  markSessionInactive?: boolean;
  trigger?: string;
  sourceFile?: string;
  sourceFunction?: string;
  reason?: string;
}) {
  stopPlayerSessionStatusPolling();

  if (forcedPlayerLogout) {
    return;
  }

  logChatLogoutTrigger({
    file: options?.sourceFile || 'features/auth/playerSession.ts',
    function: options?.sourceFunction || 'forcePlayerSessionLogout',
    reason: options?.reason || 'force_player_session_logout',
    trigger: options?.trigger || 'forcePlayerSessionLogout',
  });

  forcedPlayerLogout = true;

  if (options?.markSessionInactive !== false) {
    await endLocalPlayerSession('replaced_by_new_login', {
      trigger: options?.trigger || 'forcePlayerSessionLogout',
      file: options?.sourceFile || 'features/auth/playerSession.ts',
      function: options?.sourceFunction || 'forcePlayerSessionLogout',
      userClickedLogout: false,
    });
  }
  clearPlayerBrowserState();

  playerDebugLog('[SESSION_GUARD] firebase signOut start');
  try {
    await signOut(auth);
  } finally {
    playerDebugLog('[SESSION_GUARD] firebase signOut done');
  }

  playerDebugLog('[SESSION_GUARD] redirecting to login');
  if (options?.redirect) {
    options.redirect(PLAYER_SESSION_REPLACED_LOGIN_PATH);
  } else if (typeof window !== 'undefined') {
    window.location.replace(PLAYER_SESSION_REPLACED_LOGIN_PATH);
  }
}

export type PlayerSessionVerifyFailureReason =
  | 'missing_auth_user'
  | 'missing_local_session_id'
  | 'forced_logout_already_set'
  | 'not_player_app_session'
  | 'non_player_route'
  | 'session_replaced'
  | 'session_inactive';

export type PlayerSessionVerifyResult =
  | { ok: true; source?: 'sql' | 'firestore_fallback' }
  | {
      ok: false;
      reason: PlayerSessionVerifyFailureReason;
      activeSessionId?: string | null;
      source?: 'sql' | 'firestore_fallback';
    };

async function verifyActivePlayerSessionViaApi(
  localSessionId: string
): Promise<PlayerSessionVerifyResult | null> {
  syncPlayerSessionReadyFromStorage('verifyActivePlayerSessionViaApi');
  const cachedSessionUser = getCachedSessionUser();
  if (!isCurrentPlayerRoute()) {
    playerDebugLog('[PLAYER_SESSION_STATUS] skippedNonPlayerRoute', {
      pathname: typeof window === 'undefined' ? null : window.location.pathname || null,
      role: cachedSessionUser?.role || null,
      hasPlayerSessionId: Boolean(getLocalPlayerSessionId()),
    });
    return { ok: false, reason: 'non_player_route', source: 'sql' };
  }
  if (cachedSessionUser?.role && cachedSessionUser.role !== 'player') {
    playerDebugLog('[PLAYER_SESSION_STATUS] skippedNonPlayerRole', {
      role: cachedSessionUser.role,
      uid: cachedSessionUser.uid || null,
      hasPlayerSessionId: Boolean(getLocalPlayerSessionId()),
    });
    return { ok: false, reason: 'not_player_app_session', source: 'sql' };
  }
  const currentLocalSessionId = getLocalPlayerSessionId();
  if (!currentLocalSessionId || currentLocalSessionId !== localSessionId) {
    return {
      ok: false,
      reason: 'session_replaced',
      activeSessionId: expectedPlayerSessionId || currentLocalSessionId || null,
      source: 'sql',
    };
  }

  if (
    !isSqlPlayerRuntimeMode() &&
    expectedPlayerSessionId &&
    localSessionId !== expectedPlayerSessionId
  ) {
    return {
      ok: false,
      reason: 'session_replaced',
      activeSessionId: expectedPlayerSessionId || null,
      source: 'sql',
    };
  }

  if (shouldSkipPlayerSessionStatusForRecentSessionMe(localSessionId)) {
    recordPlayerSessionStatusHealth({
      uid: cachedSessionUser?.uid || null,
      playerSessionId: localSessionId,
    });
    return {
      ok: true,
      source: 'sql',
    };
  }

  try {
    const headers = await buildPlayerSessionRequestHeaders();
    headers['X-Player-Session-Id'] = localSessionId;
    const response = await fetch('/api/auth/player-session/status', {
      method: 'GET',
      headers,
      cache: 'no-store',
    });
    if (!response.ok) {
      if (response.status === 401) {
        playerRuntimeWarn('[PLAYER_SESSION_STATUS] unauthorizedStopPolling', {
          pathname: typeof window === 'undefined' ? null : window.location.pathname || null,
          status: response.status,
          hasPlayerSessionId: Boolean(localSessionId),
        });
        stopAllPlayerRuntimePolls('player_session_status', 'status_401');
        markPlayerSessionStale('session_inactive', 'player_session_status', {
          skipRedirect: !isCurrentPlayerRoute(),
        });
        return {
          ok: false,
          reason: 'session_inactive',
          activeSessionId: null,
          source: 'sql',
        };
      }
      return null;
    }

    const payload = (await response.json()) as {
      ok?: boolean;
      reason?: string;
      activeSessionId?: string | null;
      source?: 'sql' | 'firestore_fallback';
    };

    if (payload.ok) {
      recordPlayerSessionStatusHealth({
        uid: cachedSessionUser?.uid || null,
        playerSessionId: localSessionId,
      });
      return {
        ok: true,
        source: payload.source === 'firestore_fallback' ? 'firestore_fallback' : 'sql',
      };
    }

    if (payload.reason === 'session_inactive') {
      return {
        ok: false,
        reason: 'session_inactive',
        activeSessionId: payload.activeSessionId || null,
        source: payload.source,
      };
    }

    if (payload.reason === 'session_replaced') {
      return {
        ok: false,
        reason: 'session_replaced',
        activeSessionId: payload.activeSessionId || null,
        source: payload.source,
      };
    }

    return null;
  } catch {
    return null;
  }
}

async function verifyActivePlayerSessionViaFirestore(
  currentUser: User,
  localSessionId: string
): Promise<PlayerSessionVerifyResult> {
  const userSnap = await getDoc(doc(db, 'users', currentUser.uid));
  const activeSessionId = String(userSnap.data()?.activeSessionId || '').trim();
  if (!activeSessionId || activeSessionId !== localSessionId) {
    return {
      ok: false,
      reason: 'session_replaced',
      activeSessionId: activeSessionId || null,
      source: 'firestore_fallback',
    };
  }

  return { ok: true, source: 'firestore_fallback' };
}

async function resolveActivePlayerSession(
  options?: { forceRefresh?: boolean }
): Promise<PlayerSessionVerifyResult> {
  const appSessionUser = getCachedSessionUser();
  if (appSessionUser?.role && appSessionUser.role !== 'player') {
    return { ok: false, reason: 'not_player_app_session' };
  }

  const currentUser = auth.currentUser;
  const localSessionId = getLocalPlayerSessionId();
  const sqlPlayerMode = isSqlPlayerRuntimeMode() || isSqlPlayerAppSessionMode();

  if (!localSessionId || forcedPlayerLogout) {
    return {
      ok: false,
      reason: !localSessionId ? 'missing_local_session_id' : 'forced_logout_already_set',
    };
  }

  if (!currentUser && !sqlPlayerMode) {
    return { ok: false, reason: 'missing_auth_user' };
  }

  if (!options?.forceRefresh) {
    const cached = readPlayerSessionVerifyCache(localSessionId);
    if (cached) {
      playerDebugLog('[PLAYER_SESSION_VERIFY_CACHE]', {
        hit: true,
        sessionIdPrefix: localSessionId.slice(0, 8),
      });
      return cached;
    }
    playerDebugLog('[PLAYER_SESSION_VERIFY_CACHE]', {
      hit: false,
      sessionIdPrefix: localSessionId.slice(0, 8),
    });
  }

  const apiResult = await verifyActivePlayerSessionViaApi(localSessionId);
  if (apiResult) {
    if (apiResult.ok) {
      resetConsecutiveInvalidSessionStatus('api_verify_ok');
      writePlayerSessionVerifyCache(localSessionId, apiResult);
    } else {
      invalidatePlayerSessionVerifyCache('api_verify_failed');
    }
    return apiResult;
  }

  if (currentUser && !sqlPlayerMode) {
    const firestoreResult = await verifyActivePlayerSessionViaFirestore(
      currentUser,
      localSessionId
    );
    if (firestoreResult.ok) {
      resetConsecutiveInvalidSessionStatus('firestore_verify_ok');
      writePlayerSessionVerifyCache(localSessionId, firestoreResult);
    } else {
      invalidatePlayerSessionVerifyCache('firestore_verify_failed');
    }
    return firestoreResult;
  }

  return { ok: false, reason: 'missing_auth_user' };
}

export async function verifyActivePlayerSession(options?: {
  forceRefresh?: boolean;
}): Promise<PlayerSessionVerifyResult> {
  if (options?.forceRefresh) {
    return resolveActivePlayerSession(options);
  }

  if (verifyActivePlayerSessionInflight) {
    playerDebugLog('[PLAYER_SESSION_VERIFY_CACHE]', {
      hit: false,
      reason: 'inflight_deduped',
    });
    return verifyActivePlayerSessionInflight;
  }

  verifyActivePlayerSessionInflight = resolveActivePlayerSession(options);
  try {
    return await verifyActivePlayerSessionInflight;
  } finally {
    verifyActivePlayerSessionInflight = null;
  }
}

export async function assertActivePlayerSession() {
  const currentUser = auth.currentUser;
  const localSessionId = getLocalPlayerSessionId();
  const result = await verifyActivePlayerSession();

  if (!result.ok) {
    playerDebugLog('[SESSION_GUARD] blocked player session check', {
      reason: result.reason,
      uid: currentUser?.uid || null,
      localSessionId: localSessionId || null,
      activeSessionId: result.activeSessionId || null,
      source: result.source || null,
    });

    if (
      result.reason === 'not_player_app_session' ||
      result.reason === 'missing_local_session_id' ||
      result.reason === 'missing_auth_user'
    ) {
      throw new Error('Player session required.');
    }

    if (result.reason === 'session_replaced') {
      playerRuntimeWarn('[SESSION_GUARD] old device kicked because session mismatch', {
        uid: currentUser?.uid || null,
        localSessionId,
        activeSessionId: result.activeSessionId || null,
      });
    }

    if (
      result.reason === 'session_replaced' ||
      result.reason === 'session_inactive'
    ) {
      if (isSqlPlayerRuntimeMode() || isSqlPlayerAppSessionMode() || getLocalAppSessionId()) {
        markPlayerSessionStale(result.reason, 'assertActivePlayerSession', { skipRedirect: true });
        throw new PlayerSessionStaleError(result.reason);
      }
      await forcePlayerSessionLogout({
        markSessionInactive: true,
        trigger: 'assertActivePlayerSession',
        sourceFile: 'features/auth/playerSession.ts',
        sourceFunction: 'assertActivePlayerSession',
        reason: result.reason,
      });
      throw new Error(PLAYER_REPLACED_LOGIN_MESSAGE);
    }
    throw new Error('Player session required.');
  }

  playerDebugLog('[SESSION_GUARD] allowed player session check', {
    uid: currentUser?.uid || null,
    sessionId: localSessionId,
    source: result.source || 'sql',
  });
}

export async function getPlayerApiHeaders(
  contentType = true,
  options?: { route?: string }
) {
  const route = String(options?.route || 'unknown').trim() || 'unknown';
  const generationAtStart = playerSessionGeneration;

  const cachedRoleUser = getCachedSessionUser();
  const sessionUser =
    cachedRoleUser?.role === 'player'
      ? cachedRoleUser
      : await getSessionUserOnce().catch(() => null);
  const role = String(sessionUser?.role || '').trim() || null;
  const uid = String(
    sessionUser?.uid || (isSqlPlayerRuntimeMode() ? '' : auth.currentUser?.uid) || ''
  ).trim() || null;

  if (!isCurrentPlayerRoute()) {
    playerDebugLog('[PLAYER_SESSION_STATUS] skippedNonPlayerRoute', {
      pathname: typeof window === 'undefined' ? null : window.location.pathname || null,
      route,
      uid,
      role,
      hasPlayerSessionId: Boolean(getLocalPlayerSessionId()),
    });
    throw new Error('Player route required.');
  }

  if (role && role !== 'player') {
    logPlayerFetchBlockedRole({
      route,
      uid,
      role,
      reason: 'non_player_role',
    });
    playerDebugLog('[PLAYER_API_HEADERS]', {
      route,
      uid,
      role,
      hasAppSessionId: Boolean(getLocalAppSessionId()),
      hasPlayerSessionId: Boolean(getLocalPlayerSessionId()),
      blocked: true,
      reason: 'non_player_role',
    });
    throw new Error('Player role required.');
  }

  if (isSqlPlayerRuntimeMode() || isSqlPlayerAppSessionMode()) {
    const gate = await ensurePlayerSessionGateReady({
      source: `getPlayerApiHeaders:${route}`,
    });
    if (gate.state === 'loading') {
      await waitForPlayerSessionReady();
    } else if (gate.state === 'failed') {
      throw new Error(PLAYER_SESSION_LOADING_MESSAGE);
    }
  }

  assertPlayerSessionRequestCurrent(generationAtStart, getLocalPlayerSessionId());

  const localSessionId = getLocalPlayerSessionId();
  const sqlPlayerMode = isSqlPlayerRuntimeMode() || isSqlPlayerAppSessionMode();
  const cached =
    localSessionId && !forcedPlayerLogout
      ? readPlayerSessionVerifyCache(localSessionId)
      : null;
  if (!cached?.ok) {
    if (sqlPlayerMode) {
      const result = await verifyActivePlayerSession();
      assertPlayerSessionRequestCurrent(generationAtStart, localSessionId);
      if (
        !result.ok &&
        (result.reason === 'session_replaced' || result.reason === 'session_inactive')
      ) {
        markPlayerSessionStale(result.reason, 'getPlayerApiHeaders', { skipRedirect: true });
        throw new PlayerSessionStaleError(result.reason);
      }
    } else {
      await assertActivePlayerSession();
      assertPlayerSessionRequestCurrent(generationAtStart, localSessionId);
    }
  }

  assertPlayerSessionRequestCurrent(generationAtStart, localSessionId);
  const headers = await buildPlayerSessionRequestHeaders(contentType);
  const hasAppSessionId = Boolean(headers['X-App-Session-Id']);
  const hasPlayerSessionId = Boolean(headers['X-Player-Session-Id']);
  if (!headers.Authorization && !hasAppSessionId) {
    throw new Error('Not authenticated.');
  }
  if (!headers.Authorization && hasAppSessionId && !hasPlayerSessionId) {
    playerDebugLog('[PLAYER_API_HEADERS]', {
      route,
      uid,
      role: role || 'player',
      hasAppSessionId,
      hasPlayerSessionId,
      blocked: true,
      reason: 'missing_player_session_id',
    });
    throw new Error('Not authenticated.');
  }
  playerDebugLog('[PLAYER_API_HEADERS]', {
    route,
    uid,
    role: role || 'player',
    hasAppSessionId,
    hasPlayerSessionId,
    playerSessionIdPrefix: sessionIdPrefix(headers['X-Player-Session-Id']),
    appSessionIdPrefix: sessionIdPrefix(headers['X-App-Session-Id']),
    blocked: false,
    reason: 'ok',
  });
  return headers;
}

async function startPlayerSessionViaApi(
  user: User,
  deviceId: string,
  activeSessionDevice: ReturnType<typeof getPlayerSessionDevice>
) {
  try {
    const token = await user.getIdToken();
    const response = await fetch('/api/auth/player-session/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        deviceId,
        userAgent: activeSessionDevice.userAgent,
        platform: activeSessionDevice.platform,
      }),
    });
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as {
      ok?: boolean;
      sessionId?: string;
      sqlOk?: boolean;
    };
    if (!payload.ok || !payload.sessionId) {
      return null;
    }
    playerDebugLog('[PLAYER_LOGIN_SESSION] sql session start ok', {
      uid: user.uid,
      sessionId: payload.sessionId,
      sqlOk: payload.sqlOk === true,
    });
    return { sessionId: String(payload.sessionId), deviceId };
  } catch (error) {
    playerDebugLog('[PLAYER_LOGIN_SESSION] sql session start failed, using firestore fallback', {
      uid: user.uid,
      error,
    });
    return null;
  }
}

async function startPlayerSessionViaFirestore(user: User, deviceId: string) {
  const sessionId = makeId();
  const activeSessionDevice = getPlayerSessionDevice(deviceId);
  const userRef = doc(db, 'users', user.uid);
  const sessionRef = doc(db, 'playerSessions', sessionId);
  let previousSessionId = '';

  playerDebugLog('[PLAYER_LOGIN_SESSION] generated sessionId', {
    uid: user.uid,
    sessionId,
    deviceId,
  });

  await runTransaction(db, async (transaction) => {
    const userSnap = await transaction.get(userRef);
    previousSessionId = String(userSnap.data()?.activeSessionId || '').trim();

    playerDebugLog('[PLAYER_LOGIN_SESSION] previous activeSessionId', {
      uid: user.uid,
      previousSessionId: previousSessionId || null,
    });

    transaction.set(sessionRef, {
      playerUid: user.uid,
      deviceId,
      startedAt: serverTimestamp(),
      lastSeenAt: serverTimestamp(),
      active: true,
    });
    transaction.update(userRef, {
      activeSessionId: sessionId,
      activeDeviceId: deviceId,
      activeSessionDevice,
      activeSessionStartedAt: serverTimestamp(),
      activeSessionLastSeenAt: serverTimestamp(),
      activeSessionUpdatedAt: serverTimestamp(),
      lastLoginAt: serverTimestamp(),
    });
  });

  if (previousSessionId && previousSessionId !== sessionId) {
    const previousSessionRef = doc(db, 'playerSessions', previousSessionId);
    try {
      const previousSessionSnap = await getDoc(previousSessionRef);
      if (previousSessionSnap.exists()) {
        await updateDoc(previousSessionRef, {
          active: false,
          endedAt: serverTimestamp(),
          endedReason: 'replaced_by_new_login',
        });
        playerDebugLog('[PLAYER_LOGIN_SESSION] previous player session marked inactive', {
          uid: user.uid,
          previousSessionId,
          activeSessionId: sessionId,
        });
      } else {
        playerDebugLog('[PLAYER_LOGIN_SESSION] previous player session cleanup skipped', {
          uid: user.uid,
          previousSessionId,
          activeSessionId: sessionId,
          reason: 'previous_session_doc_missing',
        });
      }
    } catch (error) {
      console.warn('[PLAYER_LOGIN_SESSION] previous player session cleanup failed', {
        uid: user.uid,
        previousSessionId,
        activeSessionId: sessionId,
        error,
      });
    }
  }

  return { sessionId, deviceId };
}

export async function startPlayerSession(user: User) {
  forcedPlayerLogout = false;
  clearPlayerSessionBeforeLogin('firebase_player_session_start');
  const deviceId = getOrCreatePlayerDeviceId();
  const activeSessionDevice = getPlayerSessionDevice(deviceId);

  const sqlStarted = await startPlayerSessionViaApi(user, deviceId, activeSessionDevice);
  if (!sqlStarted && isSqlPlayerAppSessionMode()) {
    throw new Error('Failed to start player session.');
  }
  const result = sqlStarted || (await startPlayerSessionViaFirestore(user, deviceId));

  storeLocalPlayerSessionId(result.sessionId);

  playerDebugLog('[PLAYER_LOGIN_SESSION] newly saved activeSessionId', {
    uid: user.uid,
    activeSessionId: result.sessionId,
    source: sqlStarted ? 'sql' : 'firestore_fallback',
    reason: 'new_login_force_replaced_previous_session',
  });

  return result;
}

async function touchPlayerSessionViaApi(sessionId: string) {
  try {
    const response = await fetch('/api/auth/player-session/touch', {
      method: 'POST',
      headers: await buildPlayerSessionRequestHeaders(true),
      body: JSON.stringify({
        sessionId,
        deviceId: getOrCreatePlayerDeviceId(),
      }),
    });
    if (!response.ok) {
      return false;
    }
    const payload = (await response.json()) as { ok?: boolean };
    return payload.ok === true;
  } catch {
    return false;
  }
}

async function touchPlayerSessionViaFirestore(user: User, sessionId: string) {
  await Promise.all([
    updateDoc(doc(db, 'users', user.uid), {
      activeSessionLastSeenAt: serverTimestamp(),
      activeSessionUpdatedAt: serverTimestamp(),
    }),
    setDoc(
      doc(db, 'playerSessions', sessionId),
      {
        playerUid: user.uid,
        deviceId: getOrCreatePlayerDeviceId(),
        lastSeenAt: serverTimestamp(),
        active: true,
      },
      { merge: true }
    ),
  ]);
}

export async function touchPlayerSession(user?: User | null) {
  const sessionId = getLocalPlayerSessionId();
  if (!sessionId) {
    return;
  }

  const resolvedUser = user === undefined ? auth.currentUser : user;
  const sqlOk = await touchPlayerSessionViaApi(sessionId);
  if (!sqlOk && resolvedUser && !isSqlPlayerRuntimeMode() && !isSqlPlayerAppSessionMode()) {
    await touchPlayerSessionViaFirestore(resolvedUser, sessionId);
  }
}

async function endLocalPlayerSessionViaApi(sessionId: string, reason: string) {
  try {
    const response = await fetch('/api/auth/player-session/end', {
      method: 'POST',
      headers: await buildPlayerSessionRequestHeaders(true),
      body: JSON.stringify({
        sessionId,
        reason,
      }),
    });
    if (!response.ok) {
      return false;
    }
    const payload = (await response.json()) as { ok?: boolean };
    return payload.ok === true;
  } catch {
    return false;
  }
}

async function endLocalPlayerSessionViaFirestore(sessionId: string, reason: string) {
  await setDoc(
    doc(db, 'playerSessions', sessionId),
    {
      active: false,
      endedAt: serverTimestamp(),
      endedReason: reason,
    },
    { merge: true }
  );
}

export async function endLocalPlayerSession(
  reason = 'logout',
  context?: Partial<Omit<PlayerSessionEndClientContext, 'reason'>>
) {
  const sessionId = getLocalPlayerSessionId();
  const appSessionId = getLocalAppSessionId();
  const generation = getPlayerSessionGeneration();
  const isCurrentGeneration =
    Boolean(sessionId) &&
    sessionId === expectedPlayerSessionId &&
    sessionId === getLocalPlayerSessionId();

  const entryStack = context?.stack || captureCallerStack();
  const actor = readPlayerSessionEndActor();

  const logValues: PlayerSessionEndClientContext = {
    reason,
    trigger: context?.trigger || 'direct_call',
    route: context?.route || currentClientPath(),
    currentPath: context?.currentPath ?? currentClientPath(),
    nextPath: context?.nextPath ?? null,
    visibilityState:
      context?.visibilityState ??
      (typeof document !== 'undefined' ? document.visibilityState : null),
    generation,
    appSessionIdPrefix: sessionIdPrefix(appSessionId),
    playerSessionIdPrefix: sessionIdPrefix(sessionId),
    isCurrentGeneration,
    isLogoutInProgress: forcedPlayerLogout || isPlayerForcedLogout(),
    isRouteNavigation: context?.isRouteNavigation ?? false,
    willSendEnd: false,
    file: context?.file,
    function: context?.function,
    stack: entryStack,
    userClickedLogout: context?.userClickedLogout,
    uid: context?.uid ?? actor.uid,
    role: context?.role ?? actor.role,
  };

  if (!sessionId) {
    logPlayerSessionEndClient({
      ...logValues,
      willSendEnd: false,
      trigger: context?.trigger || 'missing_session_id',
    });
    return;
  }

  if (shouldDedupPlayerSessionEnd(sessionId, reason)) {
    logPlayerSessionEndClient({
      ...logValues,
      willSendEnd: false,
      trigger: context?.trigger || 'deduped',
    });
    return;
  }

  const blockedOnChatNavigation =
    isPlayerChatRoute(logValues.currentPath) &&
    reason === 'browser_closed' &&
    (logValues.isRouteNavigation || context?.willSendEnd === false);

  logValues.willSendEnd =
    context?.willSendEnd !== false && !blockedOnChatNavigation;
  logPlayerSessionEndClient(logValues);

  if (context?.willSendEnd === false || blockedOnChatNavigation) {
    if (blockedOnChatNavigation) {
      logChatLogoutTrigger({
        file: 'features/auth/playerSession.ts',
        function: 'endLocalPlayerSession',
        reason: 'blocked_player_session_end_on_chat_navigation',
        trigger: context?.trigger || reason,
        currentPath: logValues.currentPath,
      });
    }
    return;
  }

  const currentUser = auth.currentUser;
  try {
    const sqlOk = await endLocalPlayerSessionViaApi(sessionId, reason);
    if (!sqlOk && currentUser && !isSqlPlayerAppSessionMode()) {
      await endLocalPlayerSessionViaFirestore(sessionId, reason);
    }
  } catch {
    // Best effort; realtime activeSessionId still protects the account.
  }
}

export async function endLocalPlayerSessionOnBrowserLeave(
  event: Event,
  context?: {
    mountedAt?: number;
    bootWindowMs?: number;
    route?: string;
  }
) {
  const sessionId = getLocalPlayerSessionId();
  const isRouteNavigation = isPlayerRouteNavigationActive();
  const isRealUnload = isRealAppUnloadEvent(event);
  if (sessionId) {
    markPlayerSessionClientContinuation(sessionId);
    playerDebugLog('[PLAYER_SESSION_CONTINUATION_MARKED]', {
      sessionIdPrefix: sessionId.slice(0, 8),
      trigger: event.type,
      isRouteNavigation,
      isRealUnload,
      route: context?.route || currentClientPath(),
    });
  }

  // Never end the active SQL player session on refresh/navigation/pagehide.
  // Explicit logout and server-side expiry handle session closure.
  const willSendEnd = false;

  await endLocalPlayerSession('browser_closed', {
    trigger: event.type,
    route: context?.route || currentClientPath(),
    currentPath: currentClientPath(),
    isRouteNavigation,
    willSendEnd,
    file: 'features/auth/playerSession.ts',
    function: 'endLocalPlayerSessionOnBrowserLeave',
    userClickedLogout: false,
  });
}

export async function resumePlayerSessionAfterClientContinuation(user?: User | null) {
  const sessionId = getLocalPlayerSessionId();
  if (!sessionId) {
    return false;
  }
  const resumed = consumePlayerSessionClientContinuation(sessionId);
  const reload = isClientNavigationReload();
  if (!resumed && !reload) {
    return false;
  }
  playerDebugLog('[PLAYER_SESSION_RESUME_AFTER_RELOAD]', {
    sessionIdPrefix: sessionId.slice(0, 8),
    resumed,
    reload,
  });
  await touchPlayerSession(user === undefined ? auth.currentUser : user);
  return true;
}

export function listenForPlayerSessionReplacement(
  user: User,
  onMismatch?: () => void
) {
  if (
    assertClientFirestoreDisabled('player_session_replacement_listener', 'onSnapshot', {
      uid: user.uid,
    }) ||
    getLocalAppSessionId() ||
    isSqlPlayerAppSessionMode() ||
    isSqlPlayerLoginEnabled() ||
    isClientSqlReadMode()
  ) {
    logClientFirestoreSkipped('player_session_replacement_listener', { uid: user.uid });
    return () => {};
  }

  const localSessionId = getLocalPlayerSessionId();
  if (!localSessionId) {
    return () => {};
  }

  return onSnapshot(doc(db, 'users', user.uid), async (snapshot) => {
    const activeSessionId = String(snapshot.data()?.activeSessionId || '').trim();
    if (!activeSessionId || activeSessionId === localSessionId) {
      return;
    }

    playerRuntimeWarn('[SESSION_GUARD] old device kicked because session mismatch', {
      uid: user.uid,
      localSessionId,
      activeSessionId,
    });
    onMismatch?.();
  });
}
