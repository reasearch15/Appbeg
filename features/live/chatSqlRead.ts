'use client';

import type { FirestoreChatMessage } from '@/features/messages/chatMessages';
import { fetchChatApi } from '@/lib/client/chatLogoutDiagnostics';
import { getLocalAppSessionId } from '@/features/auth/appSession';
import { getLocalPlayerSessionId } from '@/features/auth/playerSession';
import { getCachedSessionUser, getSessionUserOnce } from '@/features/auth/sessionUser';
import { getSqlApiReadHeaders } from '@/lib/client/sqlApiHeaders';
import { getStaffAppSessionApiHeaders } from '@/lib/client/staffApiHeaders';
import { getPlayerApiHeaders } from '@/features/auth/playerSession';
import {
  attachHiddenTabPollResume,
  HIDDEN_THROTTLED_POLL_MS,
  isDocumentHidden,
  logHiddenTabPollPaused,
  logHiddenTabPollThrottled,
  resolveVisiblePollIntervalMs,
} from '@/lib/client/hiddenTabPoll';
import { scheduleSafetyInterval } from '@/lib/client/snapshotPollJitter';
import { auth } from '@/lib/firebase/client';
import { isClientSqlReadMode, logClientFirestoreSkipped } from '@/lib/client/sqlReadMode';

const POLL_MS = 8_000;
const SAFETY_REFETCH_MS = 45_000;
const UNREAD_SHARED_POLL_MS = 25_000;

const MESSAGE_LIVE_EVENTS = [
  'chat_message_created',
  'player_message_created',
  'chat.message.upserted',
  'chat.message.deleted',
] as const;

function cleanText(value: unknown) {
  return String(value || '').trim();
}

function userChatLiveChannel(uid: string) {
  return `user:${cleanText(uid)}:chat`;
}

function isoToTimestamp(iso: string | null | undefined) {
  if (!iso) {
    return null;
  }
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

function mapCachedMessage(row: Record<string, unknown>): FirestoreChatMessage {
  return {
    id: String(row.id || row.firebase_id || ''),
    text: String(row.text || '').trim() || undefined,
    imageUrl: String(row.imageUrl || '').trim() || undefined,
    imagePublicId: String(row.imagePublicId || '').trim() || undefined,
    type: String(row.type || 'text') === 'image' ? 'image' : 'text',
    senderUid: String(row.senderUid || ''),
    receiverUid: String(row.receiverUid || ''),
    createdAt: isoToTimestamp(String(row.createdAt || '') || null),
    deletedForEveryone: row.deletedForEveryone === true,
    deletedFor: Array.isArray(row.deletedFor) ? row.deletedFor.map(String).filter(Boolean) : [],
  };
}

function listQueryLogTag(role: string | null) {
  const normalized = cleanText(role).toLowerCase();
  if (normalized === 'coadmin') {
    return 'COADMIN_MESSAGE_LIST';
  }
  if (normalized === 'staff' || normalized === 'carer' || normalized === 'admin') {
    return 'STAFF_MESSAGE_LIST';
  }
  return 'MESSAGE_LIST';
}

async function resolveSelfUid() {
  const cached = getCachedSessionUser();
  if (cached?.uid) {
    return cached.uid;
  }
  const sessionUser = await getSessionUserOnce().catch(() => null);
  if (sessionUser?.uid) {
    return sessionUser.uid;
  }
  return auth.currentUser?.uid || '';
}

async function readChatApiContext(options?: { preferStaffSession?: boolean; peerUid?: string }) {
  const cached = getCachedSessionUser();
  const role = String(cached?.role || '').toLowerCase();
  const uid = cached?.uid ?? null;
  const preferStaff =
    options?.preferStaffSession === true ||
    role === 'staff' ||
    role === 'coadmin' ||
    role === 'admin' ||
    role === 'carer';

  const headers = preferStaff
    ? await getStaffAppSessionApiHeaders(false)
    : role === 'player'
      ? await getPlayerApiHeaders(false)
      : await getSqlApiReadHeaders(false);

  const conversationId =
    uid && options?.peerUid
      ? [uid, options.peerUid].sort().join('_')
      : null;

  console.info('[CHAT_SESSION_CONTEXT]', {
    currentUid: uid,
    currentRole: role || null,
    expectedReceiverUid: options?.peerUid || null,
    selectedPlayerUid: options?.peerUid || null,
    conversationId,
    preferStaffSession: preferStaff,
    hasAppSessionId: Boolean(getLocalAppSessionId()),
    hasPlayerSessionId: Boolean(getLocalPlayerSessionId()),
  });

  return {
    role: cached?.role ?? null,
    uid,
    hasAppSessionId: Boolean(getLocalAppSessionId()),
    hasPlayerSessionId: Boolean(getLocalPlayerSessionId()),
    headersSent: Object.keys(headers),
    headers,
  };
}

export async function fetchSqlUnreadCounts(options?: { preferStaffSession?: boolean }) {
  const context = await readChatApiContext({
    preferStaffSession: options?.preferStaffSession,
  });
  const logTag = listQueryLogTag(context.role);
  console.info(`[${logTag}_QUERY]`, {
    uid: context.uid,
    role: context.role,
  });

  const response = await fetchChatApi(
    '/api/chat/unread-counts',
    {
      method: 'GET',
      headers: context.headers,
      cache: 'no-store',
    },
    {
      role: context.role,
      uid: context.uid,
      hasAppSessionId: context.hasAppSessionId,
      hasPlayerSessionId: context.hasPlayerSessionId,
      headersSent: context.headersSent,
    }
  );
  const payload = (await response.json().catch(() => ({}))) as {
    unreadCounts?: Record<string, number>;
    error?: string;
  };
  if (!response.ok) {
    if (response.status === 401) {
      throw new Error(payload.error || 'Chat unread counts unauthorized.');
    }
    throw new Error(payload.error || 'Failed to load unread counts.');
  }
  const counts = payload.unreadCounts || {};
  console.info(`[${logTag}_RESULT]`, {
    uid: context.uid,
    role: context.role,
    peerCount: Object.keys(counts).length,
    totalUnread: Object.values(counts).reduce((sum, value) => sum + value, 0),
  });
  return counts;
}

export async function fetchSqlChatMessages(
  peerUid: string,
  limit = 50,
  options?: {
    conversationId?: string;
    olderThanMessageId?: string;
    preferStaffSession?: boolean;
  }
) {
  const context = await readChatApiContext({
    preferStaffSession: options?.preferStaffSession,
    peerUid,
  });
  const logTag = listQueryLogTag(context.role);
  const params = new URLSearchParams({
    peerUid,
    limit: String(limit),
  });
  if (options?.conversationId) {
    params.set('conversationId', options.conversationId);
  }
  if (options?.olderThanMessageId) {
    params.set('olderThanMessageId', options.olderThanMessageId);
  }
  const url = `/api/chat/messages?${params.toString()}`;

  console.info(`[${logTag}_QUERY]`, {
    uid: context.uid,
    role: context.role,
    peerUid,
    limit,
    olderThanMessageId: options?.olderThanMessageId || null,
  });

  const response = await fetchChatApi(
    url,
    {
      method: 'GET',
      headers: context.headers,
      cache: 'no-store',
    },
    {
      role: context.role,
      uid: context.uid,
      hasAppSessionId: context.hasAppSessionId,
      hasPlayerSessionId: context.hasPlayerSessionId,
      headersSent: context.headersSent,
    }
  );
  const payload = (await response.json().catch(() => ({}))) as {
    messages?: Array<Record<string, unknown>>;
    error?: string;
  };
  if (!response.ok) {
    if (response.status === 401) {
      throw new Error(payload.error || 'Chat messages unauthorized.');
    }
    throw new Error(payload.error || 'Failed to load chat messages.');
  }
  const messages = (payload.messages || []).map(mapCachedMessage);
  console.info('[CHAT_MESSAGES_CLIENT]', {
    conversationId: options?.conversationId || null,
    olderThanMessageId: options?.olderThanMessageId || null,
    currentUid: context.uid,
    currentRole: context.role,
    returnedMessages: messages.length,
    messageIds: messages.slice(0, 5).map((message) => message.id),
  });
  return messages;
}

export async function fetchSqlChatMessagesOlderThan(
  peerUid: string,
  olderThanMessageId: string,
  limit = 50,
  options?: { conversationId?: string; preferStaffSession?: boolean }
) {
  return fetchSqlChatMessages(peerUid, limit, {
    ...options,
    olderThanMessageId,
  });
}

function attachChatSqlPoll(input: {
  selfUid: string;
  onRefetch: (reason: string) => Promise<void>;
  onError?: (error: Error) => void;
  pollMs?: number;
  enableLive?: boolean;
}) {
  let disposed = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let safetyRefetchStop: (() => void) | null = null;
  let eventSource: EventSource | null = null;
  let lastEventId = 0;
  let refetchInFlight = false;
  let streamHealthy = false;
  const pollName = 'chat_sql_poll';

  const isSafetyOnlyMode = () =>
    input.enableLive === true && streamHealthy && eventSource?.readyState === EventSource.OPEN;

  const scheduleNextPoll = () => {
    if (disposed) {
      return;
    }
    if (isSafetyOnlyMode()) {
      console.info('[CHAT_SSE_HEALTHY_SAFETY_ONLY]', {
        pollName,
        selfUid: input.selfUid,
        safetyRefetchMs: SAFETY_REFETCH_MS,
      });
      return;
    }
    console.info('[CHAT_POLL_FAST_MODE]', {
      pollName,
      selfUid: input.selfUid,
      intervalMs: resolveVisiblePollIntervalMs(input.pollMs || POLL_MS),
    });
    pollTimer = setTimeout(() => {
      void runPoll('poll_interval');
    }, resolveVisiblePollIntervalMs(input.pollMs || POLL_MS));
  };

  const runPoll = async (reason: string) => {
    if (disposed || refetchInFlight) {
      return;
    }
    if (isDocumentHidden() && eventSource?.readyState === EventSource.OPEN) {
      logHiddenTabPollThrottled(pollName, HIDDEN_THROTTLED_POLL_MS);
      pollTimer = setTimeout(() => {
        void runPoll('hidden_throttled');
      }, HIDDEN_THROTTLED_POLL_MS);
      return;
    }
    refetchInFlight = true;
    try {
      await input.onRefetch(reason);
    } catch (error) {
      if (!disposed) {
        input.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      refetchInFlight = false;
      scheduleNextPoll();
    }
  };

  const scheduleImmediateRefetch = (reason: string) => {
    if (disposed) {
      return;
    }
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    void runPoll(reason);
  };

  const closeEventSource = () => {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    streamHealthy = false;
  };

  const connectEventSource = () => {
    if (!input.enableLive || !input.selfUid || disposed) {
      return;
    }

    closeEventSource();
    const channel = userChatLiveChannel(input.selfUid);
    const params = new URLSearchParams({
      channels: channel,
      lastEventId: String(Math.max(0, lastEventId)),
    });
    const appSessionId = cleanText(getLocalAppSessionId());
    if (appSessionId) {
      params.set('appSessionId', appSessionId);
    }
    const playerSessionId = cleanText(getLocalPlayerSessionId());
    if (playerSessionId) {
      params.set('playerSessionId', playerSessionId);
    }

    const url = `/api/live/stream?${params.toString()}`;
    const source = new EventSource(url);
    eventSource = source;

    source.onopen = () => {
      streamHealthy = true;
      console.info('[CHAT_SSE_HEALTHY_SAFETY_ONLY]', {
        pollName,
        selfUid: input.selfUid,
        safetyRefetchMs: SAFETY_REFETCH_MS,
      });
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
    };

    const handleLiveEvent = (eventName: string, rawData: string, outboxId: number) => {
      if (eventName === 'ping') {
        streamHealthy = true;
        return;
      }
      streamHealthy = true;
      if (outboxId > 0) {
        lastEventId = Math.max(lastEventId, outboxId);
      }
      try {
        const payload = JSON.parse(rawData) as Record<string, unknown>;
        console.info('[MESSAGE_LIVE_EVENT_RECEIVED]', {
          eventType: eventName,
          messageId: cleanText(payload.messageId || payload.entityId),
          playerUid: cleanText(payload.playerUid),
          coadminUid: cleanText(payload.coadminUid),
          senderUid: cleanText(payload.senderUid),
          receiverUid: cleanText(payload.receiverUid),
          outboxId,
        });
      } catch {
        console.info('[MESSAGE_LIVE_EVENT_RECEIVED]', {
          eventType: eventName,
          outboxId,
        });
      }
      scheduleImmediateRefetch(`live:${eventName}`);
    };

    source.addEventListener('ping', (ev: Event) => {
      const message = ev as MessageEvent<string>;
      handleLiveEvent('ping', String(message.data || ''), Number(message.lastEventId) || 0);
    });

    for (const eventName of MESSAGE_LIVE_EVENTS) {
      source.addEventListener(eventName, (ev: Event) => {
        const message = ev as MessageEvent<string>;
        handleLiveEvent(
          eventName,
          String(message.data || ''),
          Number(message.lastEventId) || 0
        );
      });
    }

    source.onmessage = (ev: MessageEvent<string>) => {
      handleLiveEvent('message', String(ev.data || ''), Number(ev.lastEventId) || 0);
    };

    source.onerror = () => {
      const wasHealthy = streamHealthy;
      streamHealthy = false;
      if (wasHealthy) {
        console.info('[CHAT_STREAM_UNHEALTHY_RESUME_POLL]', {
          pollName,
          selfUid: input.selfUid,
          reason: 'sse_error',
          intervalMs: input.pollMs || POLL_MS,
        });
      }
      closeEventSource();
      scheduleImmediateRefetch('sse_error');
    };
  };

  const detachHiddenResume = attachHiddenTabPollResume(pollName, () => {
    scheduleImmediateRefetch('hidden_tab_resume');
  });
  void runPoll('initial');
  connectEventSource();
  safetyRefetchStop = scheduleSafetyInterval({
    baseMs: SAFETY_REFETCH_MS,
    pollName: `${pollName}_safety`,
    onTick: () => {
      if (isDocumentHidden() && eventSource?.readyState === EventSource.OPEN) {
        logHiddenTabPollPaused(`${pollName}_safety`);
        return;
      }
      console.info('[CHAT_SAFETY_REFETCH]', {
        pollName,
        selfUid: input.selfUid,
        streamHealthy,
      });
      scheduleImmediateRefetch('safety_interval');
    },
  });

  return () => {
    disposed = true;
    detachHiddenResume();
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    safetyRefetchStop?.();
    safetyRefetchStop = null;
    closeEventSource();
  };
}

export function attachSqlUnreadCountsPoll(
  onChange: (counts: Record<string, number>) => void,
  onError?: (error: Error) => void,
  options?: { requirePlayerRole?: boolean }
) {
  logClientFirestoreSkipped('chat_unread_counts_listener');

  if (options?.requirePlayerRole) {
    let disposed = false;
    let cleanupLive: (() => void) | null = null;

    void (async () => {
      const selfUid = await resolveSelfUid();
      if (disposed) {
        return;
      }
      cleanupLive = attachChatSqlPoll({
        selfUid,
        enableLive: Boolean(selfUid),
        pollMs: UNREAD_SHARED_POLL_MS,
        onRefetch: async (reason) => {
          const counts = await fetchSqlUnreadCounts();
          if (!disposed) {
            onChange(counts);
            console.info('[CHAT_RECEIVER_UI_UPDATED]', {
              kind: 'player_unread_counts',
              peerCount: Object.keys(counts).length,
              reason,
            });
          }
        },
        onError,
      });
    })();

    return () => {
      disposed = true;
      cleanupLive?.();
      cleanupLive = null;
    };
  }

  let disposed = false;
  let cleanupLive: (() => void) | null = null;

  void (async () => {
    const selfUid = await resolveSelfUid();
    if (disposed) {
      return;
    }
    cleanupLive = attachChatSqlPoll({
      selfUid,
      enableLive: Boolean(selfUid),
      onRefetch: async (reason) => {
        const counts = await fetchSqlUnreadCounts({ preferStaffSession: true });
        if (!disposed) {
          onChange(counts);
          console.info('[CHAT_RECEIVER_UI_UPDATED]', {
            kind: 'unread_counts',
            peerCount: Object.keys(counts).length,
            reason,
          });
        }
      },
      onError,
    });
  })();

  return () => {
    disposed = true;
    cleanupLive?.();
    cleanupLive = null;
  };
}

export function attachSqlChatMessagesPoll(
  peerUid: string,
  onChange: (messages: FirestoreChatMessage[]) => void,
  options?: { limit?: number; requirePlayerRole?: boolean; conversationId?: string },
  onError?: (error: Error) => void
) {
  logClientFirestoreSkipped('chat_messages_listener', {
    peerUid,
    conversationId: options?.conversationId || null,
  });

  if (options?.requirePlayerRole) {
    let disposed = false;
    let cleanupLive: (() => void) | null = null;

    void (async () => {
      const selfUid = await resolveSelfUid();
      if (disposed) {
        return;
      }
      cleanupLive = attachChatSqlPoll({
        selfUid,
        enableLive: Boolean(selfUid),
        onRefetch: async (reason) => {
          const messages = await fetchSqlChatMessages(peerUid, options?.limit || 50, {
            conversationId: options?.conversationId,
          });
          if (!disposed) {
            onChange(messages);
            console.info('[CHAT_RECEIVER_UI_UPDATED]', {
              kind: 'messages',
              peerUid,
              count: messages.length,
              reason,
            });
          }
        },
        onError,
      });
    })();

    return () => {
      disposed = true;
      cleanupLive?.();
      cleanupLive = null;
    };
  }

  let disposed = false;
  let cleanupLive: (() => void) | null = null;

  void (async () => {
    const selfUid = await resolveSelfUid();
    if (disposed) {
      return;
    }
    cleanupLive = attachChatSqlPoll({
      selfUid,
      enableLive: Boolean(selfUid),
      onRefetch: async (reason) => {
        const messages = await fetchSqlChatMessages(peerUid, options?.limit || 50, {
          conversationId: options?.conversationId,
          preferStaffSession: true,
        });
        if (!disposed) {
          onChange(messages);
          console.info('[CHAT_MESSAGES_REFETCHED]', {
            peerUid,
            count: messages.length,
            reason,
          });
          console.info('[CHAT_RECEIVER_UI_UPDATED]', {
            kind: 'messages',
            peerUid,
            count: messages.length,
            reason,
          });
        }
      },
      onError,
    });
  })();

  return () => {
    disposed = true;
    cleanupLive?.();
    cleanupLive = null;
  };
}

export function isChatSqlReadEnabled() {
  return isClientSqlReadMode();
}
