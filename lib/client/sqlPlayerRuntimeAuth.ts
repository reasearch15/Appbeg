'use client';

import { playerDebugLog } from '@/lib/client/playerDebugLogs';
import { getLocalAppSessionId } from '@/features/auth/appSession';
import { getLocalPlayerSessionId } from '@/features/auth/playerSession';
import { isSqlPlayerLoginEnabled } from '@/features/auth/sqlPlayerLoginFlags';
import { getCachedSessionUser } from '@/features/auth/sessionUser';

function sessionIdPrefix(value: string | null | undefined) {
  const id = String(value || '').trim();
  return id ? id.slice(0, 8) : null;
}

/** Player runtime uses SQL sessions only (no Firebase auth state). */
export function isSqlPlayerRuntimeMode() {
  return isSqlPlayerLoginEnabled() && Boolean(getLocalAppSessionId());
}

export function logSqlPlayerRuntimeAuth(values: {
  route?: string;
  source?: string;
  uid?: string | null;
  role?: string | null;
  coadminUid?: string | null;
  appSessionIdPrefix?: string | null;
  playerSessionIdPrefix?: string | null;
  sessionSource?: string | null;
  firebaseIgnored?: boolean;
  ready?: boolean;
  blocked?: boolean;
  reason?: string;
}) {
  const cached = getCachedSessionUser();
  const route =
    values.route ??
    (typeof window !== 'undefined' ? window.location.pathname || '' : '');
  playerDebugLog('[SQL_PLAYER_RUNTIME_AUTH]', {
    route,
    source: values.source || 'session_me',
    uid: values.uid ?? cached?.uid ?? null,
    role: values.role ?? cached?.role ?? null,
    coadminUid: values.coadminUid ?? cached?.coadminUid ?? null,
    appSessionIdPrefix:
      values.appSessionIdPrefix ?? sessionIdPrefix(getLocalAppSessionId()),
    playerSessionIdPrefix:
      values.playerSessionIdPrefix ?? sessionIdPrefix(getLocalPlayerSessionId()),
    sessionSource: values.sessionSource ?? null,
    firebaseIgnored: values.firebaseIgnored ?? isSqlPlayerRuntimeMode(),
    ready: values.ready ?? false,
    blocked: values.blocked ?? false,
    reason: values.reason || 'ok',
  });
}
