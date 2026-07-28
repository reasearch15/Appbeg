'use client';

import { playerDebugLog } from '@/lib/client/playerDebugLogs';
import { recordPlayerRequest } from '@/lib/client/playerRequestSummary';
import {
  recordSessionMeAuthHealth,
  shouldReuseSessionMeForRecentStatus,
} from '@/lib/client/playerAuthHealth';

import { isValidRole } from '@/lib/auth/roles';
import {
  isPlayerChatRoute,
  logChatLogoutTrigger,
} from '@/lib/client/chatLogoutDiagnostics';

const APP_SESSION_ID_KEY = 'appbeg:appSessionId';
const APP_SESSION_EXPIRES_AT_KEY = 'appbeg:appSessionExpiresAt';

export type SessionUser = {
  uid: string;
  role: string;
  username?: string | null;
  coadminUid?: string | null;
  status?: string | null;
  expiresAt?: string | null;
  appSessionId?: string | null;
  playerSessionId?: string | null;
  canonicalSessionId?: string | null;
  sessionSource?: string | null;
};

export type SessionMePayload = {
  ok?: boolean;
  reason?: string;
  uid?: string;
  role?: string;
  coadminUid?: string | null;
  username?: string;
  status?: string | null;
  expiresAt?: string;
  appSessionId?: string;
  playerSessionId?: string;
  canonicalSessionId?: string;
  sessionSource?: string;
  player?: {
    coin?: number;
    cash?: number;
    referralCode?: string | null;
    referredByUid?: string | null;
    referredByUsername?: string | null;
    dismissedPaymentDetailsNoticeVersion?: number;
    coadminPaymentDetailsNoticeVersion?: number;
    referralBonusNotice?: string | null;
    referralBonusNoticeAt?: string | null;
  };
};

let cachedUser: SessionUser | null = null;
let cachedSessionId: string | null = null;
let inflightPromise: Promise<SessionUser | null> | null = null;
let cachedSessionMePayload: SessionMePayload | null = null;
let cachedSessionMeAt = 0;
let sessionMeInflightPromise: Promise<SessionMePayload | null> | null = null;
let sessionMePollTimer: ReturnType<typeof setTimeout> | null = null;
let sessionMePollerActive = false;

const sessionMeSubscribers = new Map<
  number,
  {
    label: string;
    intervalMs: number;
    initialDelayMs: number;
    onChange: (payload: SessionMePayload) => void;
    onError?: (error: Error) => void;
  }
>();
let nextSessionMeSubscriberId = 1;

function readLocalAppSessionId() {
  if (typeof window === 'undefined') {
    return '';
  }
  return window.localStorage.getItem(APP_SESSION_ID_KEY) || '';
}

function clearLocalAppSessionStorage() {
  if (typeof window === 'undefined') {
    return;
  }
  if (isPlayerChatRoute() && cachedUser?.role === 'player') {
    logChatLogoutTrigger({
      file: 'features/auth/sessionUser.ts',
      function: 'clearLocalAppSessionStorage',
      reason: 'app_session_clear_on_player_chat',
      trigger: 'clearLocalAppSessionStorage',
      role: cachedUser.role,
      uid: cachedUser.uid,
    });
  }
  window.localStorage.removeItem(APP_SESSION_ID_KEY);
  window.localStorage.removeItem(APP_SESSION_EXPIRES_AT_KEY);
}

function clearExpiredAppSessionStorage() {
  if (typeof window === 'undefined') {
    return;
  }
  const expiresAt = window.localStorage.getItem(APP_SESSION_EXPIRES_AT_KEY);
  if (!expiresAt) {
    return;
  }
  if (new Date(expiresAt).getTime() <= Date.now()) {
    clearLocalAppSessionStorage();
  }
}

function isAppSessionRoleAllowed(status: string | null | undefined, role: string) {
  const normalizedStatus = String(status || '').trim().toLowerCase();
  const normalizedRole = String(role || '').trim().toLowerCase();
  const isActive = normalizedStatus === 'active';
  const isBlockedPlayer = normalizedStatus === 'disabled' && normalizedRole === 'player';
  return isActive || isBlockedPlayer;
}

function getSessionRequestHeaders(): Record<string, string> {
  const sessionId = readLocalAppSessionId();
  if (!sessionId) {
    return {};
  }
  return { 'X-App-Session-Id': sessionId };
}

function mapPayloadToSessionUser(payload: {
  uid?: string;
  role?: string;
  coadminUid?: string | null;
  username?: string;
  status?: string | null;
  expiresAt?: string;
  appSessionId?: string;
  playerSessionId?: string;
  canonicalSessionId?: string;
  sessionSource?: string;
}): SessionUser | null {
  if (!payload.uid || !payload.role || !isValidRole(payload.role)) {
    return null;
  }
  if (!isAppSessionRoleAllowed(payload.status ?? null, payload.role)) {
    return null;
  }
  return {
    uid: payload.uid,
    role: payload.role,
    coadminUid: payload.coadminUid ?? null,
    username: String(payload.username || ''),
    status: payload.status ?? null,
    expiresAt: String(payload.expiresAt || ''),
    appSessionId: String(payload.appSessionId || '').trim() || null,
    playerSessionId:
      String(payload.playerSessionId || payload.canonicalSessionId || '').trim() ||
      null,
    canonicalSessionId:
      String(payload.canonicalSessionId || payload.playerSessionId || '').trim() ||
      null,
    sessionSource: String(payload.sessionSource || '').trim() || null,
  };
}

async function fetchSessionMePayloadFromApi(): Promise<SessionMePayload | null> {
  clearExpiredAppSessionStorage();

  const sessionId = readLocalAppSessionId();
  if (!sessionId) {
    clearCachedSessionUser('missing_session_id');
    return null;
  }

  try {
    const startedAt = Date.now();
    const response = await fetch('/api/auth/session/me', {
      method: 'GET',
      headers: getSessionRequestHeaders(),
      cache: 'no-store',
    });
    recordPlayerRequest('/api/auth/session/me', Date.now() - startedAt);

    const payload = (await response.json().catch(() => ({}))) as SessionMePayload;

    if (!response.ok || !payload.ok) {
      const meReason = payload.reason || `http_${response.status}`;
      playerDebugLog('[APP_SESSION_ME_CLIENT_STATE]', {
        route: typeof window !== 'undefined' ? window.location.pathname || '' : '',
        hasAppSessionId: Boolean(sessionId),
        appSessionIdPrefix: sessionId ? sessionId.slice(0, 8) : null,
        role: payload.role ?? cachedUser?.role ?? null,
        visibilityState:
          typeof document !== 'undefined' ? document.visibilityState : null,
        reason: meReason,
      });
      const protectChatAppSession =
        isPlayerChatRoute() &&
        (cachedUser?.role === 'player' || payload.role === 'player');
      if (
        payload.reason === 'invalid_or_expired' ||
        payload.reason === 'account_not_active' ||
        payload.reason === 'uid_mismatch'
      ) {
        if (protectChatAppSession && payload.reason === 'invalid_or_expired') {
          playerDebugLog('[APP_SESSION_ME_CLIENT_STATE]', {
            route: typeof window !== 'undefined' ? window.location.pathname || '' : '',
            hasAppSessionId: Boolean(sessionId),
            appSessionIdPrefix: sessionId ? sessionId.slice(0, 8) : null,
            role: payload.role ?? cachedUser?.role ?? null,
            visibilityState:
              typeof document !== 'undefined' ? document.visibilityState : null,
            reason: meReason,
            deferredAppSessionClear: true,
          });
        } else {
          clearLocalAppSessionStorage();
        }
      }
      clearCachedSessionUser(payload.reason || 'fetch_invalid');
      cachedSessionMePayload = payload;
      cachedSessionMeAt = Date.now();
      return payload;
    }

    const user = mapPayloadToSessionUser(payload);
    if (!user) {
      clearLocalAppSessionStorage();
      clearCachedSessionUser('payload_invalid');
      cachedSessionMePayload = payload;
      cachedSessionMeAt = Date.now();
      return payload;
    }

    cachedUser = user;
    cachedSessionId = sessionId;
    cachedSessionMePayload = payload;
    cachedSessionMeAt = Date.now();
    recordSessionMeAuthHealth({
      uid: payload.uid,
      role: payload.role,
      playerSessionId: payload.playerSessionId,
      canonicalSessionId: payload.canonicalSessionId,
    });
    return payload;
  } catch {
    clearCachedSessionUser('fetch_failed');
    return null;
  }
}

export function getCachedSessionMePayload(maxAgeMs = 1_000): SessionMePayload | null {
  clearExpiredAppSessionStorage();
  if (!cachedSessionMePayload || Date.now() - cachedSessionMeAt > maxAgeMs) {
    return null;
  }
  return cachedSessionMePayload;
}

export async function getSessionMeOnce(options?: {
  maxAgeMs?: number;
  force?: boolean;
  /** When true, always hit the network (ignore auth-health reuse of stale balances). */
  bypassCache?: boolean;
}): Promise<SessionMePayload | null> {
  const maxAgeMs = Math.max(0, Number(options?.maxAgeMs ?? 1_000));
  const sessionId = readLocalAppSessionId();
  if (!sessionId) {
    clearCachedSessionUser('missing_session_id');
    return null;
  }

  if (
    !options?.bypassCache &&
    !options?.force &&
    cachedSessionMePayload &&
    Date.now() - cachedSessionMeAt <= maxAgeMs
  ) {
    playerDebugLog('[SESSION_ME_POLLER_REUSED]', {
      source: 'cached_payload',
      ageMs: Date.now() - cachedSessionMeAt,
      subscriberCount: sessionMeSubscribers.size,
    });
    return cachedSessionMePayload;
  }

  if (
    !options?.bypassCache &&
    options?.force &&
    cachedSessionMePayload?.ok &&
    cachedSessionMePayload.role === 'player' &&
    shouldReuseSessionMeForRecentStatus({
      uid: cachedSessionMePayload.uid,
      playerSessionId:
        cachedSessionMePayload.playerSessionId ||
        cachedSessionMePayload.canonicalSessionId ||
        null,
      cachedPayloadAgeMs: Date.now() - cachedSessionMeAt,
    })
  ) {
    playerDebugLog('[SESSION_ME_POLLER_REUSED]', {
      source: 'recent_player_session_status',
      ageMs: Date.now() - cachedSessionMeAt,
      subscriberCount: sessionMeSubscribers.size,
    });
    return cachedSessionMePayload;
  }

  if (sessionMeInflightPromise && !options?.bypassCache) {
    playerDebugLog('[SESSION_ME_POLLER_REUSED]', {
      source: 'inflight_fetch',
      subscriberCount: sessionMeSubscribers.size,
    });
    return sessionMeInflightPromise;
  }

  sessionMeInflightPromise = fetchSessionMePayloadFromApi().finally(() => {
    sessionMeInflightPromise = null;
  });
  return sessionMeInflightPromise;
}

async function fetchSessionUserFromApi(): Promise<SessionUser | null> {
  const payload = await getSessionMeOnce({ force: true });
  if (!payload?.ok) {
    return null;
  }
  return mapPayloadToSessionUser(payload);
}

function notifySessionMeSubscribers(payload: SessionMePayload) {
  for (const subscriber of sessionMeSubscribers.values()) {
    try {
      subscriber.onChange(payload);
    } catch (error) {
      subscriber.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

function nextSessionMePollIntervalMs() {
  if (!sessionMeSubscribers.size) {
    return 0;
  }
  return Math.max(
    4_000,
    Math.min(...[...sessionMeSubscribers.values()].map((subscriber) => subscriber.intervalMs))
  );
}

function stopSessionMePoller(reason: string) {
  if (sessionMePollTimer) {
    clearTimeout(sessionMePollTimer);
    sessionMePollTimer = null;
  }
  if (sessionMePollerActive) {
    playerDebugLog('[SESSION_ME_POLLER_REMOVED]', {
      reason,
      subscriberCount: sessionMeSubscribers.size,
      pollerCount: 0,
    });
  }
  sessionMePollerActive = false;
}

function scheduleSessionMePoller(reason: string) {
  if (sessionMePollTimer || !sessionMeSubscribers.size) {
    if (sessionMeSubscribers.size) {
      playerDebugLog('[SESSION_ME_POLLER_REUSED]', {
        reason,
        subscriberCount: sessionMeSubscribers.size,
        pollerCount: sessionMePollerActive ? 1 : 0,
      });
    }
    return;
  }

  if (!sessionMePollerActive) {
    sessionMePollerActive = true;
    playerDebugLog('[SESSION_ME_POLLER_CREATED]', {
      reason,
      subscriberCount: sessionMeSubscribers.size,
      pollerCount: 1,
    });
  }

  const tick = async () => {
    sessionMePollTimer = null;
    if (!sessionMeSubscribers.size) {
      stopSessionMePoller('no_subscribers');
      return;
    }
    if (typeof document !== 'undefined' && document.hidden) {
      sessionMePollTimer = setTimeout(tick, nextSessionMePollIntervalMs());
      return;
    }
    try {
      const payload = await getSessionMeOnce({ force: true });
      if (payload) {
        notifySessionMeSubscribers(payload);
      }
    } catch (error) {
      for (const subscriber of sessionMeSubscribers.values()) {
        subscriber.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      const intervalMs = nextSessionMePollIntervalMs();
      if (intervalMs > 0 && sessionMeSubscribers.size) {
        const jitterCap = Math.min(2_000, Math.floor(intervalMs * 0.15));
        const jitterMs = Math.floor(Math.random() * (jitterCap + 1));
        sessionMePollTimer = setTimeout(tick, intervalMs + jitterMs);
      } else {
        stopSessionMePoller('no_interval');
      }
    }
  };

  const initialDelayMs =
    reason === 'subscriber_added'
      ? Math.max(
          0,
          Math.min(...[...sessionMeSubscribers.values()].map((subscriber) => subscriber.initialDelayMs))
        )
      : 0;
  sessionMePollTimer = setTimeout(tick, initialDelayMs);
}

export function subscribeSessionMe(
  label: string,
  onChange: (payload: SessionMePayload) => void,
  options?: { intervalMs?: number; initialDelayMs?: number; onError?: (error: Error) => void }
) {
  const id = nextSessionMeSubscriberId++;
  const intervalMs = Math.max(4_000, Number(options?.intervalMs || 20_000));
  const initialDelayMs = Math.max(0, Number(options?.initialDelayMs || 0));
  sessionMeSubscribers.set(id, {
    label,
    intervalMs,
    initialDelayMs,
    onChange,
    onError: options?.onError,
  });
  playerDebugLog('[SESSION_ME_SUBSCRIBER]', {
    action: 'added',
    id,
    label,
    intervalMs,
    initialDelayMs,
    subscriberCount: sessionMeSubscribers.size,
  });
  scheduleSessionMePoller('subscriber_added');

  return () => {
    sessionMeSubscribers.delete(id);
    playerDebugLog('[SESSION_ME_SUBSCRIBER]', {
      action: 'removed',
      id,
      label,
      subscriberCount: sessionMeSubscribers.size,
    });
    if (!sessionMeSubscribers.size) {
      stopSessionMePoller('last_subscriber_removed');
    }
  };
}

export function getCachedSessionUser(): SessionUser | null {
  clearExpiredAppSessionStorage();

  const sessionId = readLocalAppSessionId();
  if (!sessionId || !cachedUser || cachedSessionId !== sessionId) {
    return null;
  }

  playerDebugLog('[SESSION_USER_CACHE] hit', {
    uid: cachedUser.uid,
    role: cachedUser.role,
  });
  return cachedUser;
}

export type SessionUserCacheSeedReason = 'sql_login' | 'bootstrap' | 'manual';

export function seedSessionUserCache(user: SessionUser, reason: SessionUserCacheSeedReason) {
  const sessionId = readLocalAppSessionId();
  if (!sessionId) {
    playerDebugLog('[SESSION_USER_CACHE] seed_skipped', {
      reason,
      detail: 'missing_local_app_session_id',
      uid: user.uid,
      role: user.role,
    });
    return false;
  }

  cachedUser = user;
  cachedSessionId = sessionId;
  playerDebugLog('[SESSION_USER_CACHE] seeded', {
    reason,
    uid: user.uid,
    role: user.role,
    sessionIdPrefix: sessionId.slice(0, 8),
  });
  return true;
}

/** @deprecated Prefer seedSessionUserCache with an explicit reason. */
export function setCachedSessionUser(user: SessionUser) {
  seedSessionUserCache(user, 'manual');
}

export function clearCachedSessionUser(reason: string) {
  cachedUser = null;
  cachedSessionId = null;
  inflightPromise = null;
  cachedSessionMePayload = null;
  cachedSessionMeAt = 0;
  sessionMeInflightPromise = null;
  playerDebugLog('[SESSION_USER_CACHE] clear', { reason });
}

/** Patch authoritative cash/coin into the in-memory session/me cache without a network round-trip. */
export function patchCachedSessionMeBalances(input: {
  cash?: number | null;
  coin?: number | null;
}) {
  if (!cachedSessionMePayload?.ok || !cachedSessionMePayload.player) {
    return false;
  }
  const nextCash =
    input.cash === undefined || input.cash === null
      ? Number(cachedSessionMePayload.player.cash || 0)
      : Math.max(0, Number(input.cash) || 0);
  const nextCoin =
    input.coin === undefined || input.coin === null
      ? Number(cachedSessionMePayload.player.coin || 0)
      : Math.max(0, Number(input.coin) || 0);
  cachedSessionMePayload = {
    ...cachedSessionMePayload,
    player: {
      ...cachedSessionMePayload.player,
      cash: nextCash,
      coin: nextCoin,
    },
  };
  cachedSessionMeAt = Date.now();
  notifySessionMeSubscribers(cachedSessionMePayload);
  playerDebugLog('[SESSION_ME_BALANCE_PATCHED]', {
    cash: nextCash,
    coin: nextCoin,
  });
  return true;
}

export function getSessionUserOnce(): Promise<SessionUser | null> {
  clearExpiredAppSessionStorage();

  const sessionId = readLocalAppSessionId();
  if (!sessionId) {
    clearCachedSessionUser('missing_session_id');
    return Promise.resolve(null);
  }

  if (cachedUser && cachedSessionId === sessionId) {
    playerDebugLog('[SESSION_USER_CACHE] hit', {
      uid: cachedUser.uid,
      role: cachedUser.role,
    });
    return Promise.resolve(cachedUser);
  }

  if (cachedSessionId && cachedSessionId !== sessionId) {
    clearCachedSessionUser('session_id_changed');
  }

  if (inflightPromise) {
    playerDebugLog('[SESSION_USER_CACHE] inflight');
    return inflightPromise;
  }

  playerDebugLog('[SESSION_USER_CACHE] miss', { reason: 'fetch_required' });
  inflightPromise = fetchSessionUserFromApi().finally(() => {
    inflightPromise = null;
  });
  return inflightPromise;
}
