'use client';

import { playerDebugLog } from '@/lib/client/playerDebugLogs';
import {
  APP_SESSION_EXPIRES_AT_KEY,
  APP_SESSION_ID_KEY,
  IMPERSONATOR_SESSION_ID_KEY,
  getLocalAppSessionId,
} from '@/features/auth/appSession';
import {
  PLAYER_SESSION_ID_KEY,
  getLocalPlayerSessionId,
  resetPlayerAuthClientOnLogout,
  stopPlayerSessionStatusPolling,
} from '@/features/auth/playerSession';
import { clearCachedSessionUser, getCachedSessionUser } from '@/features/auth/sessionUser';
import { failLoginUiProgress } from '@/lib/client/loginUiProgress';
import { resetPlayerStaleSessionState } from '@/lib/client/playerStaleSession';

function sessionIdPrefix(value: string | null | undefined) {
  const clean = String(value || '').trim();
  return clean ? clean.slice(0, 8) : null;
}

export async function revokeRemoteAppSession(sessionId: string, reason = 'logout') {
  try {
    const response = await fetch('/api/auth/session/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, reason }),
    });
    return response.ok;
  } catch (error) {
    playerDebugLog('[SQL_AUTH_BOOTSTRAP] logout_revoke_failed', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export function clearSqlClientAuthState(reason: string) {
  const route = typeof window !== 'undefined' ? window.location.pathname || '' : '';
  const cached = getCachedSessionUser();
  const appSessionId = getLocalAppSessionId();
  const playerSessionId = getLocalPlayerSessionId();
  const clearedKeys: string[] = [];

  stopPlayerSessionStatusPolling();
  resetPlayerAuthClientOnLogout(reason);

  if (typeof window !== 'undefined') {
    for (const key of [APP_SESSION_ID_KEY, APP_SESSION_EXPIRES_AT_KEY, PLAYER_SESSION_ID_KEY]) {
      if (window.localStorage.getItem(key)) {
        window.localStorage.removeItem(key);
        clearedKeys.push(key);
      }
    }
    if (window.sessionStorage.getItem(IMPERSONATOR_SESSION_ID_KEY)) {
      window.sessionStorage.removeItem(IMPERSONATOR_SESSION_ID_KEY);
      clearedKeys.push(IMPERSONATOR_SESSION_ID_KEY);
    }
    const loginProgressKey = 'appbeg:loginUiProgress';
    if (window.sessionStorage.getItem(loginProgressKey)) {
      window.sessionStorage.removeItem(loginProgressKey);
      clearedKeys.push(loginProgressKey);
    }
  }

  clearCachedSessionUser(reason);
  resetPlayerStaleSessionState(reason);
  failLoginUiProgress(`logout:${reason}`);

  playerDebugLog('[SQL_LOGOUT_CLIENT_CLEANUP]', {
    route,
    uid: cached?.uid ?? null,
    role: cached?.role ?? null,
    appSessionIdPrefix: sessionIdPrefix(appSessionId),
    playerSessionIdPrefix: sessionIdPrefix(playerSessionId),
    clearedKeys,
    reason,
  });
}

export async function performSqlClientLogoutCleanup(reason = 'logout') {
  const appSessionId = getLocalAppSessionId();
  if (appSessionId) {
    await revokeRemoteAppSession(appSessionId, reason);
  }
  clearSqlClientAuthState(reason);
}
