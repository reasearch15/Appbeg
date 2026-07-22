'use client';

import { getLocalAppSessionId } from '@/features/auth/appSession';
import { playerDebugLog } from '@/lib/client/playerDebugLogs';
import {
  getLocalPlayerSessionId,
} from '@/features/auth/playerSession';
import { getCachedSessionUser } from '@/features/auth/sessionUser';

function sessionIdPrefix(value: string | null | undefined) {
  const id = String(value || '').trim();
  return id ? id.slice(0, 8) : null;
}

export function isPlayerChatRoute(path?: string) {
  const route = String(path || (typeof window !== 'undefined' ? window.location.pathname : '')).trim();
  return route === '/player/chat' || route.startsWith('/player/chat/');
}

export function isPlayerShellRoute(path?: string) {
  const route = String(path || (typeof window !== 'undefined' ? window.location.pathname : '')).trim();
  return route === '/player' || route.startsWith('/player/');
}

export function readChatLogoutContext() {
  const cached = getCachedSessionUser();
  return {
    route: typeof window !== 'undefined' ? window.location.pathname || '' : '',
    currentPath: typeof window !== 'undefined' ? window.location.pathname || '' : '',
    role: cached?.role ?? null,
    uid: cached?.uid ?? null,
    appSessionIdPrefix: sessionIdPrefix(getLocalAppSessionId()),
    playerSessionIdPrefix: sessionIdPrefix(getLocalPlayerSessionId()),
    visibilityState:
      typeof document !== 'undefined' ? document.visibilityState : null,
  };
}

export function logChatLogoutTrigger(values: {
  file: string;
  function: string;
  reason: string;
  trigger: string;
  route?: string;
  currentPath?: string;
  role?: string | null;
  uid?: string | null;
  appSessionIdPrefix?: string | null;
  playerSessionIdPrefix?: string | null;
  visibilityState?: string | null;
}) {
  const context = readChatLogoutContext();
  console.info('[CHAT_LOGOUT_TRIGGER]', {
    file: values.file,
    function: values.function,
    reason: values.reason,
    trigger: values.trigger,
    route: values.route ?? context.route,
    currentPath: values.currentPath ?? context.currentPath,
    role: values.role ?? context.role,
    uid: values.uid ?? context.uid,
    appSessionIdPrefix: values.appSessionIdPrefix ?? context.appSessionIdPrefix,
    playerSessionIdPrefix:
      values.playerSessionIdPrefix ?? context.playerSessionIdPrefix,
    visibilityState: values.visibilityState ?? context.visibilityState,
  });
}

export function logChatPageMount(values: {
  role: string | null;
  uid: string | null;
  hasAppSessionId: boolean;
  hasPlayerSessionId: boolean;
  appSessionIdPrefix: string | null;
  playerSessionIdPrefix: string | null;
}) {
  playerDebugLog('[CHAT_PAGE_MOUNT]', values);
}

export function logChatApiRequest(values: {
  url: string;
  role: string | null;
  uid: string | null;
  hasAppSessionId: boolean;
  hasPlayerSessionId: boolean;
  headersSent: string[];
  blocked: boolean;
  reason: string;
}) {
  playerDebugLog('[CHAT_API_REQUEST]', values);
}

export function logChatApi401(values: {
  url: string;
  responseBody: unknown;
  role: string | null;
  uid: string | null;
  appSessionIdPrefix: string | null;
  playerSessionIdPrefix: string | null;
}) {
  console.info('[CHAT_API_401]', values);
}

export function shouldProtectPlayerChatSession(path?: string) {
  if (!isPlayerChatRoute(path)) {
    return false;
  }
  const cached = getCachedSessionUser();
  return cached?.role === 'player' && Boolean(getLocalAppSessionId());
}

export async function fetchChatApi(
  url: string,
  init: RequestInit,
  values: {
    role: string | null;
    uid: string | null;
    hasAppSessionId: boolean;
    hasPlayerSessionId: boolean;
    headersSent: string[];
    blocked?: boolean;
    blockReason?: string;
  }
) {
  logChatApiRequest({
    url,
    role: values.role,
    uid: values.uid,
    hasAppSessionId: values.hasAppSessionId,
    hasPlayerSessionId: values.hasPlayerSessionId,
    headersSent: values.headersSent,
    blocked: values.blocked === true,
    reason: values.blocked ? values.blockReason || 'blocked' : 'ok',
  });

  if (values.blocked) {
    throw new Error(values.blockReason || 'Chat API request blocked.');
  }

  const response = await fetch(url, init);
  if (response.status === 401) {
    const responseBody = await response
      .clone()
      .json()
      .catch(() => ({}));
    logChatApi401({
      url,
      responseBody,
      role: values.role,
      uid: values.uid,
      appSessionIdPrefix: sessionIdPrefix(getLocalAppSessionId()),
      playerSessionIdPrefix: sessionIdPrefix(getLocalPlayerSessionId()),
    });
  }
  return response;
}
