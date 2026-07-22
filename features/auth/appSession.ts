'use client';

import { playerDebugLog, playerRuntimeWarn } from '@/lib/client/playerDebugLogs';
import { isValidRole, type UserRole } from '@/lib/auth/roles';
import {
  clearCachedSessionUser,
  getCachedSessionUser,
  getSessionUserOnce,
} from '@/features/auth/sessionUser';

export const APP_SESSION_ID_KEY = 'appbeg:appSessionId';
export const APP_SESSION_EXPIRES_AT_KEY = 'appbeg:appSessionExpiresAt';
export const IMPERSONATOR_SESSION_ID_KEY = 'appbeg:impersonatorSessionId';

export function getLocalAppSessionId() {
  if (typeof window === 'undefined') {
    return '';
  }
  return window.localStorage.getItem(APP_SESSION_ID_KEY) || '';
}

export function getAppSessionRequestHeaders(): Record<string, string> {
  const sessionId = getLocalAppSessionId();
  if (!sessionId) {
    return {};
  }
  return { 'X-App-Session-Id': sessionId };
}

export type AppSessionUser = {
  uid: string;
  role: UserRole;
  coadminUid: string | null;
  username: string;
  status: string | null;
  expiresAt: string;
};

function mapCachedAppSessionUser(
  user: NonNullable<ReturnType<typeof getCachedSessionUser>>
): AppSessionUser {
  return {
    uid: user.uid,
    role: user.role as UserRole,
    coadminUid: user.coadminUid ?? null,
    username: String(user.username || ''),
    status: user.status ?? null,
    expiresAt: String(user.expiresAt || ''),
  };
}

export async function getCurrentAppSessionUser(): Promise<AppSessionUser | null> {
  clearExpiredAppSessionLocal();

  if (!getLocalAppSessionId()) {
    return null;
  }

  const cached = getCachedSessionUser();
  if (cached && isValidRole(cached.role)) {
    return mapCachedAppSessionUser(cached);
  }

  const user = await getSessionUserOnce();
  if (!user || !isValidRole(user.role)) {
    return null;
  }

  return mapCachedAppSessionUser(user);
}

function clearExpiredAppSessionLocal() {
  if (typeof window === 'undefined') {
    return;
  }
  const expiresAt = window.localStorage.getItem(APP_SESSION_EXPIRES_AT_KEY);
  if (!expiresAt) {
    return;
  }
  if (new Date(expiresAt).getTime() <= Date.now()) {
    clearAppSessionLocal();
  }
}

export async function ensureAppSessionBootstrapped(): Promise<string | null> {
  clearExpiredAppSessionLocal();

  const existing = getLocalAppSessionId();
  if (existing) {
    return existing;
  }

  return null;
}

export function clearAppSessionLocal() {
  if (typeof window === 'undefined') {
    return;
  }
  window.localStorage.removeItem(APP_SESSION_ID_KEY);
  window.localStorage.removeItem(APP_SESSION_EXPIRES_AT_KEY);
  clearCachedSessionUser('local_session_cleared');
}

export function storeAppSessionLocal(sessionId: string, expiresAt: string) {
  if (typeof window === 'undefined') {
    return;
  }
  const previousSessionId = getLocalAppSessionId();
  window.localStorage.setItem(APP_SESSION_ID_KEY, sessionId);
  if (expiresAt) {
    window.localStorage.setItem(APP_SESSION_EXPIRES_AT_KEY, expiresAt);
  }
  if (previousSessionId && previousSessionId !== sessionId) {
    clearCachedSessionUser('session_id_replaced');
  }
}

export function storeImpersonatorSessionId(sessionId: string) {
  if (typeof window === 'undefined' || !sessionId) {
    return;
  }
  window.sessionStorage.setItem(IMPERSONATOR_SESSION_ID_KEY, sessionId);
}

export function startImpersonationSession(sessionId: string, expiresAt: string) {
  const currentSessionId = getLocalAppSessionId();
  if (currentSessionId) {
    storeImpersonatorSessionId(currentSessionId);
  }
  storeAppSessionLocal(sessionId, expiresAt);
  clearCachedSessionUser('impersonation_started');
}

export async function bootstrapAppSessionAfterFirebaseLogin(input?: {
  roleHint?: string;
  playerSessionId?: string;
}) {
  void input;
  playerDebugLog('[SQL_AUTH_BOOTSTRAP] skipped', {
    reason: 'firebase_runtime_removed',
  });
  return null;
}

export async function revokeAppSessionOnLogout(reason = 'logout') {
  const { performSqlClientLogoutCleanup } = await import('@/lib/client/sqlLogoutCleanup');
  await performSqlClientLogoutCleanup(reason);
}
