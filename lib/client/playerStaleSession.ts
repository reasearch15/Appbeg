'use client';

import { APP_SESSION_ID_KEY } from '@/features/auth/appSession';
import { playerDebugLog, playerRuntimeWarn } from '@/lib/client/playerDebugLogs';
import { PLAYER_SESSION_ID_KEY } from '@/features/auth/playerSession';
import { clearCachedSessionUser } from '@/features/auth/sessionUser';

export const PLAYER_SESSION_REPLACED_USER_MESSAGE =
  'Your session was replaced. Please log in again.';

const STALE_SESSION_ERROR_PATTERNS = [
  /player session not found in sql/i,
  /session_inactive/i,
  /session_validation_failed/i,
  /live_auth_denied/i,
  /player_session_generation_stale/i,
  /player_session_id_stale/i,
  /session_replaced/i,
  /sse_http_401/i,
];

let staleMarked = false;
let staleReason: string | null = null;
let redirectScheduled = false;
let storageWatchInstalled = false;
const runtimeStoppers = new Set<() => void>();
let externalSessionPollStop: (() => void) | null = null;

function currentRoute() {
  return typeof window !== 'undefined' ? window.location.pathname || '' : '';
}

function isCurrentPlayerRoute() {
  const route = currentRoute();
  return route === '/player' || route.startsWith('/player/');
}

function sessionIdPrefix(value: string | null | undefined) {
  const clean = String(value || '').trim();
  return clean ? clean.slice(0, 8) : null;
}

function readLocalPlayerSessionId() {
  if (typeof window === 'undefined') {
    return '';
  }
  return window.localStorage.getItem(PLAYER_SESSION_ID_KEY) || '';
}

export function isPlayerSessionStale() {
  return staleMarked;
}

export function isStalePlayerSessionError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || '');
  return STALE_SESSION_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

export function isStalePlayerSessionReason(reason: string) {
  const normalized = String(reason || '').trim().toLowerCase();
  return normalized === 'session_inactive' || normalized === 'session_replaced';
}

export function logPlayerStaleSessionStop(values: {
  route: string;
  pollName: string;
  oldPlayerSessionIdPrefix: string | null;
  currentPlayerSessionIdPrefix: string | null;
  reason: string;
  stopped: boolean;
}) {
  playerRuntimeWarn('[PLAYER_STALE_SESSION_STOP]', values);
}

export function logPlayerStaleResponseIgnored(values: {
  route: string;
  requestSessionIdPrefix: string | null;
  currentSessionIdPrefix: string | null;
  status?: string | number | null;
  reason: string;
}) {
  playerDebugLog('[PLAYER_STALE_RESPONSE_IGNORED]', values);
}

export function registerPlayerRuntimeStopper(stop: () => void) {
  runtimeStoppers.add(stop);
  return () => {
    runtimeStoppers.delete(stop);
  };
}

export function registerPlayerSessionStatusPollStop(stop: () => void) {
  externalSessionPollStop = stop;
  return () => {
    if (externalSessionPollStop === stop) {
      externalSessionPollStop = null;
    }
  };
}

export function resetPlayerStaleSessionState(reason = 'session_reset') {
  staleMarked = false;
  staleReason = null;
  redirectScheduled = false;
  playerDebugLog('[PLAYER_STALE_SESSION_RESET]', { reason, route: currentRoute() });
}

export function stopAllPlayerRuntimePolls(pollName: string, reason: string) {
  externalSessionPollStop?.();
  externalSessionPollStop = null;

  for (const stop of runtimeStoppers) {
    try {
      stop();
    } catch {
      // Best effort shutdown.
    }
  }
  runtimeStoppers.clear();

  logPlayerStaleSessionStop({
    route: currentRoute(),
    pollName,
    oldPlayerSessionIdPrefix: sessionIdPrefix(readLocalPlayerSessionId()),
    currentPlayerSessionIdPrefix: sessionIdPrefix(readLocalPlayerSessionId()),
    reason,
    stopped: true,
  });
}

export function markPlayerSessionStale(
  reason: string,
  pollName: string,
  options?: { redirect?: (url: string) => void; skipRedirect?: boolean }
) {
  if (staleMarked) {
    return;
  }

  staleMarked = true;
  staleReason = reason;

  const oldPlayerSessionIdPrefix = sessionIdPrefix(readLocalPlayerSessionId());
  stopAllPlayerRuntimePolls(pollName, reason);

  if (typeof window !== 'undefined') {
    window.localStorage.removeItem(PLAYER_SESSION_ID_KEY);
  }
  clearCachedSessionUser(`stale_session:${reason}`);

  logPlayerStaleSessionStop({
    route: currentRoute(),
    pollName,
    oldPlayerSessionIdPrefix,
    currentPlayerSessionIdPrefix: sessionIdPrefix(readLocalPlayerSessionId()),
    reason,
    stopped: true,
  });

  if (options?.skipRedirect || redirectScheduled || !isCurrentPlayerRoute()) {
    if (!options?.skipRedirect && !isCurrentPlayerRoute()) {
      playerRuntimeWarn('[PLAYER_SESSION_STATUS] unauthorizedStopPolling', {
        route: currentRoute(),
        reason,
        redirectSkipped: true,
      });
    }
    return;
  }

  redirectScheduled = true;
  const loginPath = '/login?reason=session_replaced';
  if (options?.redirect) {
    options.redirect(loginPath);
    return;
  }
  if (typeof window !== 'undefined') {
    window.location.replace(loginPath);
  }
}

export function ignoreStalePlayerResponse(input: {
  pollName: string;
  requestSessionId?: string | null;
  status?: string | number | null;
  reason: string;
}) {
  const currentSessionId = readLocalPlayerSessionId();
  logPlayerStaleResponseIgnored({
    route: currentRoute(),
    requestSessionIdPrefix: sessionIdPrefix(input.requestSessionId || currentSessionId),
    currentSessionIdPrefix: sessionIdPrefix(currentSessionId),
    status: input.status ?? null,
    reason: input.reason,
  });
}

export function handleStalePlayerFetchError(
  pollName: string,
  error: unknown,
  requestSessionId?: string | null
) {
  if (!isPlayerSessionStale() && !isStalePlayerSessionError(error)) {
    return false;
  }

  ignoreStalePlayerResponse({
    pollName,
    requestSessionId,
    status: 'error',
    reason: error instanceof Error ? error.message : String(error),
  });

  if (!isPlayerSessionStale()) {
    markPlayerSessionStale(
      error instanceof Error ? error.message : 'stale_fetch_error',
      pollName,
      { skipRedirect: true }
    );
  }

  return true;
}

export function installPlayerSessionStorageWatch() {
  if (typeof window === 'undefined' || storageWatchInstalled) {
    return;
  }
  storageWatchInstalled = true;

  window.addEventListener('storage', (event) => {
    if (event.key !== PLAYER_SESSION_ID_KEY && event.key !== APP_SESSION_ID_KEY) {
      return;
    }
    if (event.newValue === event.oldValue) {
      return;
    }

    const localPlayerSessionId = readLocalPlayerSessionId();
    if (
      event.key === PLAYER_SESSION_ID_KEY &&
      event.newValue &&
      event.oldValue &&
      event.newValue !== event.oldValue &&
      localPlayerSessionId !== event.newValue
    ) {
      markPlayerSessionStale('session_replaced_storage', 'storage_event');
      return;
    }

    if (
      event.key === APP_SESSION_ID_KEY &&
      event.newValue &&
      event.oldValue &&
      event.newValue !== event.oldValue
    ) {
      markPlayerSessionStale('app_session_replaced_storage', 'storage_event');
    }
  });
}
