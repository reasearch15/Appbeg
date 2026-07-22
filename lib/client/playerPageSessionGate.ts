'use client';

import { playerDebugLog } from '@/lib/client/playerDebugLogs';
import { getLocalAppSessionId } from '@/features/auth/appSession';
import {
  getLocalPlayerSessionId,
  isPlayerSessionLoading,
  isPlayerSessionReady,
  readPlayerSessionGateDebugState,
} from '@/features/auth/playerSession';
import { getCachedSessionUser } from '@/features/auth/sessionUser';

function sessionIdPrefix(value: string | null | undefined) {
  const id = String(value || '').trim();
  return id ? id.slice(0, 8) : null;
}

export function logPlayerPageSessionGate(values: {
  route: string;
  role: string | null;
  uid: string | null;
  hasAppSessionId: boolean;
  hasPlayerSessionId: boolean;
  appSessionIdPrefix: string | null;
  playerSessionIdPrefix: string | null;
  inMemoryReady?: boolean;
  expectedPlayerSessionId?: string | null;
  sessionReady: boolean;
  blocked: boolean;
  reason: string;
}) {
  playerDebugLog('[PLAYER_PAGE_SESSION_GATE]', values);
}

export function readPlayerPageSessionGateSnapshot() {
  const cached = getCachedSessionUser();
  const appSessionId = getLocalAppSessionId();
  const playerSessionId = getLocalPlayerSessionId();
  const route = typeof window !== 'undefined' ? window.location.pathname || '' : '';

  const debug = readPlayerSessionGateDebugState();

  return {
    route,
    role: cached?.role ?? null,
    uid: cached?.uid ?? null,
    hasAppSessionId: Boolean(appSessionId),
    hasPlayerSessionId: Boolean(playerSessionId),
    appSessionIdPrefix: sessionIdPrefix(appSessionId),
    playerSessionIdPrefix: sessionIdPrefix(playerSessionId),
    inMemoryReady: debug.inMemoryReady,
    expectedPlayerSessionId: debug.expectedPlayerSessionId,
    sessionReady: isPlayerSessionReady(),
    loading: isPlayerSessionLoading(),
  };
}
