'use client';

import { playerDebugLog } from '@/lib/client/playerDebugLogs';
type AuthHealthState = {
  uid: string | null;
  playerSessionId: string | null;
  sessionMeOkAt: number;
  statusOkAt: number;
};

const RECENT_SESSION_ME_MS = 18_000;
const RECENT_STATUS_MS = 18_000;
const SESSION_ME_CACHE_REUSE_MS = 30_000;

const state: AuthHealthState = {
  uid: null,
  playerSessionId: null,
  sessionMeOkAt: 0,
  statusOkAt: 0,
};

function cleanText(value: unknown) {
  return String(value || '').trim();
}

function updateState(input: Partial<AuthHealthState> & { source: string }) {
  if (input.uid !== undefined) {
    state.uid = cleanText(input.uid) || null;
  }
  if (input.playerSessionId !== undefined) {
    state.playerSessionId = cleanText(input.playerSessionId) || null;
  }
  if (input.sessionMeOkAt !== undefined) {
    state.sessionMeOkAt = input.sessionMeOkAt;
  }
  if (input.statusOkAt !== undefined) {
    state.statusOkAt = input.statusOkAt;
  }
  playerDebugLog('[AUTH_HEALTH_STATE_UPDATED]', {
    source: input.source,
    uid: state.uid,
    hasPlayerSessionId: Boolean(state.playerSessionId),
    sessionMeAgeMs: state.sessionMeOkAt ? Date.now() - state.sessionMeOkAt : null,
    statusAgeMs: state.statusOkAt ? Date.now() - state.statusOkAt : null,
  });
}

export function recordSessionMeAuthHealth(input: {
  uid?: string | null;
  role?: string | null;
  playerSessionId?: string | null;
  canonicalSessionId?: string | null;
}) {
  const role = cleanText(input.role).toLowerCase();
  const uid = cleanText(input.uid);
  const playerSessionId = cleanText(input.playerSessionId || input.canonicalSessionId);
  if (role !== 'player' || !uid || !playerSessionId) {
    return;
  }
  updateState({
    source: 'session_me',
    uid,
    playerSessionId,
    sessionMeOkAt: Date.now(),
  });
  playerDebugLog('[AUTH_POLL_CONSOLIDATED]', {
    source: 'session_me',
    uid,
    playerSessionIdPrefix: playerSessionId.slice(0, 8),
  });
}

export function recordPlayerSessionStatusHealth(input: {
  uid?: string | null;
  playerSessionId?: string | null;
}) {
  const uid = cleanText(input.uid);
  const playerSessionId = cleanText(input.playerSessionId);
  if (!playerSessionId) {
    return;
  }
  updateState({
    source: 'player_session_status',
    uid: uid || state.uid,
    playerSessionId,
    statusOkAt: Date.now(),
  });
  playerDebugLog('[AUTH_POLL_CONSOLIDATED]', {
    source: 'player_session_status',
    uid: uid || state.uid,
    playerSessionIdPrefix: playerSessionId.slice(0, 8),
  });
}

export function shouldSkipPlayerSessionStatusForRecentSessionMe(playerSessionId: string) {
  const cleanSessionId = cleanText(playerSessionId);
  const ageMs = Date.now() - state.sessionMeOkAt;
  const shouldSkip =
    Boolean(cleanSessionId) &&
    state.playerSessionId === cleanSessionId &&
    state.sessionMeOkAt > 0 &&
    ageMs <= RECENT_SESSION_ME_MS;
  if (shouldSkip) {
    playerDebugLog('[AUTH_STATUS_SKIPPED_RECENT_SESSION_ME]', {
      playerSessionIdPrefix: cleanSessionId.slice(0, 8),
      ageMs,
    });
  }
  return shouldSkip;
}

export function shouldReuseSessionMeForRecentStatus(input: {
  uid?: string | null;
  playerSessionId?: string | null;
  cachedPayloadAgeMs: number;
}) {
  const uid = cleanText(input.uid);
  const playerSessionId = cleanText(input.playerSessionId);
  const statusAgeMs = Date.now() - state.statusOkAt;
  const shouldSkip =
    Boolean(uid) &&
    Boolean(playerSessionId) &&
    state.uid === uid &&
    state.playerSessionId === playerSessionId &&
    state.statusOkAt > 0 &&
    statusAgeMs <= RECENT_STATUS_MS &&
    input.cachedPayloadAgeMs <= SESSION_ME_CACHE_REUSE_MS;
  if (shouldSkip) {
    playerDebugLog('[SESSION_ME_SKIPPED_RECENT_STATUS]', {
      uid,
      playerSessionIdPrefix: playerSessionId.slice(0, 8),
      statusAgeMs,
      cachedPayloadAgeMs: input.cachedPayloadAgeMs,
    });
  }
  return shouldSkip;
}

