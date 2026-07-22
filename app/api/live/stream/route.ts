import {
  apiError,
  requireApiUser,
  requireCarerOwnedLiveAuth,
  requirePlayerOwnedLiveAuth,
  scopedCoadminUid,
  verifyApiTokenIdentity,
} from '@/lib/firebase/apiAuth';
import { authSqlReadEnvLogFields } from '@/lib/server/authSqlRead';
import { logRouteSessionValidation, sessionIdsFromRequest } from '@/lib/server/sessionAuthLog';
import { cleanText } from '@/lib/sql/playerMirrorCommon';
import {
  getLiveOutboxFanoutStats,
  subscribeLiveOutboxFanout,
  type LiveOutboxFanoutSubscription,
} from '@/lib/sql/liveOutboxFanout';
import { getLiveOutboxRowsAfter, type LiveOutboxRow } from '@/lib/sql/liveOutbox';
import { warnIfFanoutRequiredButDisabled } from '@/lib/server/liveStreamFanoutGuard';
import { debugLog } from '@/lib/server/verboseLogs';

export const runtime = 'nodejs';

export const dynamic = 'force-dynamic';
const MAX_CHANNELS = 3;
const POLL_INTERVAL_MS = 1_000;
const HEARTBEAT_INTERVAL_MS = 25_000;
const PLAYER_CHANNEL_PATTERN = /^player:([A-Za-z0-9_-]+):(requests|freeplay|cashouts)$/;
const CARER_CHANNEL_PATTERN = /^carer:([A-Za-z0-9_-]+):tasks$/;
const COADMIN_CHANNEL_PATTERN = /^coadmin:([A-Za-z0-9_-]+):tasks$/;
const CARER_JOBS_CHANNEL_PATTERN = /^carer:([A-Za-z0-9_-]+):jobs$/;
const COADMIN_JOBS_CHANNEL_PATTERN = /^coadmin:([A-Za-z0-9_-]+):jobs$/;
const PLAYER_CASHOUT_CHANNEL_PATTERN = /^player:([A-Za-z0-9_-]+):cashouts$/;
const COADMIN_CASHOUT_CHANNEL_PATTERN = /^coadmin:([A-Za-z0-9_-]+):cashouts$/;
const USER_CHAT_CHANNEL_PATTERN = /^user:([A-Za-z0-9_-]+):chat$/;

type CarerStreamChannelSpec = {
  channels: string[];
  carerUid: string | null;
  coadminUid: string | null;
  channelType: 'carer_tasks' | 'coadmin_tasks_for_carer' | 'carer_and_coadmin_tasks';
};

type CarerJobStreamChannelSpec = {
  channels: string[];
  carerUid: string | null;
  coadminUid: string | null;
  channelType: 'carer_jobs' | 'coadmin_jobs_for_carer' | 'carer_and_coadmin_jobs';
};

function parseChannels(raw: string | null) {
  return String(raw || '')
    .split(',')
    .map(cleanText)
    .filter(Boolean)
    .slice(0, MAX_CHANNELS);
}

function parseLastEventId(raw: string | null) {
  const parsed = Number.parseInt(String(raw || '0'), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function formatSseEvent(row: LiveOutboxRow) {
  const payload = {
    ...row.payload,
    entityId:
      cleanText(row.payload.entityId) ||
      cleanText(row.payload.requestId) ||
      cleanText(row.entity_id),
  };
  return `id: ${row.outbox_id}\nevent: ${row.event_type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function formatPingEvent(channels: string[]) {
  return `event: ping\ndata: ${JSON.stringify({
    now: new Date().toISOString(),
    channels,
  })}\n\n`;
}

function isBrowserFanoutEnabled() {
  return (
    String(process.env.LIVE_OUTBOX_FANOUT_ENABLED || '').trim() === '1' &&
    String(process.env.LIVE_OUTBOX_FANOUT_BROWSER_ENABLED || '').trim() === '1'
  );
}

function isLoggableLiveRow(row: LiveOutboxRow) {
  return (
    row.entity_type === 'carer_task' ||
    row.entity_type === 'player_game_request' ||
    row.entity_type === 'freeplay_gift' ||
    row.entity_type === 'player_cashout_task' ||
    row.entity_type === 'chat_message' ||
    row.event_type.startsWith('freeplay.') ||
    row.event_type.startsWith('task.') ||
    row.event_type.startsWith('cashout_') ||
    row.event_type.startsWith('chat.') ||
    row.event_type === 'player_message_created' ||
    row.event_type === 'chat_message_created' ||
    row.event_type.endsWith('_create') ||
    row.event_type.endsWith('_task_created') ||
    row.event_type.endsWith('_task_create')
  );
}

function logLiveStreamDelivered(row: LiveOutboxRow, phase: 'poll' | 'replay' | 'fanout') {
  if (!isLoggableLiveRow(row)) return;
  console.info('[LIVE_STREAM_EVENT_DELIVERED]', {
    outboxId: row.outbox_id,
    channel: row.channel,
    eventType: row.event_type,
    entityType: row.entity_type,
    entityId: row.entity_id,
    phase,
  });
}

function requestWithAppSessionQuery(request: Request): Request {
  const url = new URL(request.url);
  const sessionFromQuery = cleanText(url.searchParams.get('appSessionId'));
  const playerSessionFromQuery = cleanText(url.searchParams.get('playerSessionId'));
  const headers = new Headers(request.headers);
  let changed = false;
  if (sessionFromQuery && !headers.get('X-App-Session-Id')) {
    headers.set('X-App-Session-Id', sessionFromQuery);
    changed = true;
  }
  if (playerSessionFromQuery && !headers.get('X-Player-Session-Id')) {
    headers.set('X-Player-Session-Id', playerSessionFromQuery);
    changed = true;
  }
  if (!changed) {
    return request;
  }
  return new Request(request.url, {
    headers,
    signal: request.signal,
  });
}

function resolvePlayerOwnedChannels(channels: string[]): string[] | null {
  const playerUids = new Set<string>();

  for (const channel of channels) {
    const playerMatch = channel.match(PLAYER_CHANNEL_PATTERN);
    if (!playerMatch) {
      return null;
    }
    playerUids.add(playerMatch[1]);
  }

  if (playerUids.size !== 1) {
    return null;
  }

  return channels;
}

function resolveCarerTaskStreamChannels(channels: string[]): CarerStreamChannelSpec | null {
  let carerUid: string | null = null;
  let coadminUid: string | null = null;

  for (const channel of channels) {
    const carerMatch = channel.match(CARER_CHANNEL_PATTERN);
    if (carerMatch) {
      const uid = carerMatch[1];
      if (carerUid && carerUid !== uid) {
        return null;
      }
      carerUid = uid;
      continue;
    }

    const coadminMatch = channel.match(COADMIN_CHANNEL_PATTERN);
    if (coadminMatch) {
      const uid = coadminMatch[1];
      if (coadminUid && coadminUid !== uid) {
        return null;
      }
      coadminUid = uid;
      continue;
    }

    return null;
  }

  if (!carerUid && !coadminUid) {
    return null;
  }

  if (carerUid && coadminUid) {
    return {
      channels,
      carerUid,
      coadminUid,
      channelType: 'carer_and_coadmin_tasks',
    };
  }

  if (carerUid) {
    return {
      channels,
      carerUid,
      coadminUid: null,
      channelType: 'carer_tasks',
    };
  }

  return {
    channels,
    carerUid: null,
    coadminUid,
    channelType: 'coadmin_tasks_for_carer',
  };
}

function resolveCarerJobStreamChannels(channels: string[]): CarerJobStreamChannelSpec | null {
  let carerUid: string | null = null;
  let coadminUid: string | null = null;

  for (const channel of channels) {
    const carerMatch = channel.match(CARER_JOBS_CHANNEL_PATTERN);
    if (carerMatch) {
      const uid = carerMatch[1];
      if (carerUid && carerUid !== uid) {
        return null;
      }
      carerUid = uid;
      continue;
    }

    const coadminMatch = channel.match(COADMIN_JOBS_CHANNEL_PATTERN);
    if (coadminMatch) {
      const uid = coadminMatch[1];
      if (coadminUid && coadminUid !== uid) {
        return null;
      }
      coadminUid = uid;
      continue;
    }

    return null;
  }

  if (!carerUid && !coadminUid) {
    return null;
  }

  if (carerUid && coadminUid) {
    return {
      channels,
      carerUid,
      coadminUid,
      channelType: 'carer_and_coadmin_jobs',
    };
  }

  if (carerUid) {
    return {
      channels,
      carerUid,
      coadminUid: null,
      channelType: 'carer_jobs',
    };
  }

  return {
    channels,
    carerUid: null,
    coadminUid,
    channelType: 'coadmin_jobs_for_carer',
  };
}

async function authorizeCarerTaskStream(
  request: Request,
  spec: CarerStreamChannelSpec
) {
  const expectedCarerUid = spec.carerUid;
  if (expectedCarerUid) {
    const auth = await requireCarerOwnedLiveAuth(request, expectedCarerUid);
    if (!auth.ok) {
      return { ok: false as const, response: auth.response };
    }
    if (spec.coadminUid && auth.coadminUid !== spec.coadminUid) {
      return { ok: false as const, response: apiError('Forbidden.', 403) };
    }
    return { ok: true as const, auth };
  }

  const identity = await verifyApiTokenIdentity(request);
  if ('response' in identity) {
    return { ok: false as const, response: identity.response };
  }

  const auth = await requireCarerOwnedLiveAuth(request, identity.uid);
  if (!auth.ok) {
    return { ok: false as const, response: auth.response };
  }
  if (!spec.coadminUid || auth.coadminUid !== spec.coadminUid) {
    return { ok: false as const, response: apiError('Forbidden.', 403) };
  }

  return { ok: true as const, auth };
}

function resolvePlayerCashoutStreamChannels(channels: string[]): string[] | null {
  const playerUids = new Set<string>();

  for (const channel of channels) {
    const playerMatch = channel.match(PLAYER_CASHOUT_CHANNEL_PATTERN);
    if (!playerMatch) {
      return null;
    }
    playerUids.add(playerMatch[1]);
  }

  if (playerUids.size !== 1) {
    return null;
  }

  return channels;
}

function resolveCoadminCashoutStreamChannels(channels: string[]): string | null {
  let coadminUid: string | null = null;

  for (const channel of channels) {
    const coadminMatch = channel.match(COADMIN_CASHOUT_CHANNEL_PATTERN);
    if (!coadminMatch) {
      return null;
    }
    const uid = coadminMatch[1];
    if (coadminUid && coadminUid !== uid) {
      return null;
    }
    coadminUid = uid;
  }

  return coadminUid;
}

function resolveUserChatStreamChannels(channels: string[]): string | null {
  let userUid: string | null = null;

  for (const channel of channels) {
    const match = channel.match(USER_CHAT_CHANNEL_PATTERN);
    if (!match) {
      return null;
    }
    const uid = match[1];
    if (userUid && userUid !== uid) {
      return null;
    }
    userUid = uid;
  }

  return userUid;
}

async function authorizeUserChatStream(request: Request, expectedUid: string) {
  const headerSessions = sessionIdsFromRequest(request);
  if (headerSessions.player_session_id) {
    const auth = await requirePlayerOwnedLiveAuth(request, expectedUid);
    if (!auth.ok) {
      return { ok: false as const, response: auth.response };
    }
    return { ok: true as const, auth: { uid: auth.uid } };
  }

  const auth = await requireApiUser(request, ['admin', 'coadmin', 'staff', 'carer', 'player']);
  if ('response' in auth) {
    return { ok: false as const, response: auth.response };
  }
  if (auth.user.uid !== expectedUid) {
    return { ok: false as const, response: apiError('Forbidden.', 403) };
  }
  return { ok: true as const, auth: auth.user };
}

async function authorizeCoadminCashoutStream(request: Request, coadminUid: string) {
  const auth = await requireApiUser(request, ['admin', 'coadmin', 'staff']);
  if ('response' in auth) {
    return { ok: false as const, response: auth.response };
  }

  if (auth.user.role !== 'admin') {
    const scopeUid = scopedCoadminUid(auth.user);
    if (!scopeUid || scopeUid !== coadminUid) {
      return { ok: false as const, response: apiError('Forbidden.', 403) };
    }
  }

  return { ok: true as const, auth: auth.user };
}

async function authorizeCarerJobStream(
  request: Request,
  spec: CarerJobStreamChannelSpec
) {
  const expectedCarerUid = spec.carerUid;
  if (expectedCarerUid) {
    const auth = await requireCarerOwnedLiveAuth(request, expectedCarerUid);
    if (!auth.ok) {
      return { ok: false as const, response: auth.response };
    }
    if (spec.coadminUid && auth.coadminUid !== spec.coadminUid) {
      return { ok: false as const, response: apiError('Forbidden.', 403) };
    }
    return { ok: true as const, auth };
  }

  const identity = await verifyApiTokenIdentity(request);
  if ('response' in identity) {
    return { ok: false as const, response: identity.response };
  }

  const auth = await requireCarerOwnedLiveAuth(request, identity.uid);
  if (!auth.ok) {
    return { ok: false as const, response: auth.response };
  }
  if (!spec.coadminUid || auth.coadminUid !== spec.coadminUid) {
    return { ok: false as const, response: apiError('Forbidden.', 403) };
  }

  return { ok: true as const, auth };
}

export async function GET(request: Request) {
  warnIfFanoutRequiredButDisabled('browser_live_stream');
  const liveRequest = requestWithAppSessionQuery(request);
  const url = new URL(liveRequest.url);
  const channels = parseChannels(url.searchParams.get('channels'));
  if (!channels.length) {
    return apiError('channels query parameter is required.', 400);
  }

  const playerCashoutChannels = resolvePlayerCashoutStreamChannels(channels);
  if (playerCashoutChannels) {
    const playerUid = playerCashoutChannels[0].match(PLAYER_CASHOUT_CHANNEL_PATTERN)?.[1] || '';
    const headerSessions = sessionIdsFromRequest(request);
    const auth = await requirePlayerOwnedLiveAuth(liveRequest, playerUid);
    if (!auth.ok) {
      logRouteSessionValidation('/api/live/stream', {
        ok: false,
        channelType: 'player_cashouts',
        playerUid,
        ...headerSessions,
        canonical_session_id: headerSessions.player_session_id,
        validates: 'player_session_sql',
        ...authSqlReadEnvLogFields(),
        ...auth.timing,
      });
      return auth.response;
    }

    logRouteSessionValidation('/api/live/stream', {
      ok: true,
      channelType: 'player_cashouts',
      playerUid,
      ...headerSessions,
      canonical_session_id: headerSessions.player_session_id,
      validates: 'player_session_sql',
      ...authSqlReadEnvLogFields(),
      ...auth.timing,
    });

    return createLiveStreamResponse(
      liveRequest,
      playerCashoutChannels,
      parseLastEventId(url.searchParams.get('lastEventId'))
    );
  }

  const coadminCashoutUid = resolveCoadminCashoutStreamChannels(channels);
  if (coadminCashoutUid) {
    const auth = await authorizeCoadminCashoutStream(liveRequest, coadminCashoutUid);
    if (!auth.ok) {
      return auth.response;
    }

    console.info('[LIVE_STREAM_AUTH]', {
      channelType: 'coadmin_cashouts',
      coadminUid: coadminCashoutUid,
      uid: auth.auth.uid,
      role: auth.auth.role,
    });

    return createLiveStreamResponse(
      liveRequest,
      channels,
      parseLastEventId(url.searchParams.get('lastEventId'))
    );
  }

  const userChatUid = resolveUserChatStreamChannels(channels);
  if (userChatUid) {
    const auth = await authorizeUserChatStream(liveRequest, userChatUid);
    if (!auth.ok) {
      console.info('[LIVE_STREAM_AUTH]', {
        channelType: 'user_chat',
        userUid: userChatUid,
        ok: false,
      });
      return auth.response;
    }

    console.info('[LIVE_STREAM_AUTH]', {
      channelType: 'user_chat',
      userUid: userChatUid,
      uid: auth.auth.uid,
      ok: true,
    });

    return createLiveStreamResponse(
      liveRequest,
      channels,
      parseLastEventId(url.searchParams.get('lastEventId'))
    );
  }

  const playerChannels = resolvePlayerOwnedChannels(channels);
  if (playerChannels) {
    const playerUid = playerChannels[0].match(PLAYER_CHANNEL_PATTERN)?.[1] || '';
    const headerSessions = sessionIdsFromRequest(request);
    const auth = await requirePlayerOwnedLiveAuth(liveRequest, playerUid);
    if (!auth.ok) {
      logRouteSessionValidation('/api/live/stream', {
        ok: false,
        channelType: 'player_requests',
        playerUid,
        ...headerSessions,
        canonical_session_id: headerSessions.player_session_id,
        validates: 'player_session_sql',
        ...authSqlReadEnvLogFields(),
        ...auth.timing,
      });
      return auth.response;
    }

    logRouteSessionValidation('/api/live/stream', {
      ok: true,
      channelType: 'player_requests',
      playerUid,
      ...headerSessions,
      canonical_session_id: headerSessions.player_session_id,
      validates: 'player_session_sql',
      ...authSqlReadEnvLogFields(),
      ...auth.timing,
    });

    console.info('[PLAYER_LIVE_STREAM_SUBSCRIBE]', {
      playerUid,
      channels: playerChannels,
      lastEventId: parseLastEventId(url.searchParams.get('lastEventId')),
    });

    return createLiveStreamResponse(
      liveRequest,
      playerChannels,
      parseLastEventId(url.searchParams.get('lastEventId'))
    );
  }

  const carerTaskStream = resolveCarerTaskStreamChannels(channels);
  const carerJobStream = resolveCarerJobStreamChannels(channels);

  if (carerTaskStream && carerJobStream) {
    return apiError('Cannot mix task and job live channels.', 400);
  }

  if (carerTaskStream) {
    const auth = await authorizeCarerTaskStream(liveRequest, carerTaskStream);
    if (!auth.ok) {
      return auth.response;
    }

    console.info('[LIVE_STREAM_AUTH]', {
      channelType: carerTaskStream.channelType,
      carerUid: auth.auth.uid,
      coadminUid: auth.auth.coadminUid,
      ...auth.auth.timing,
    });

    return createLiveStreamResponse(
      liveRequest,
      carerTaskStream.channels,
      parseLastEventId(url.searchParams.get('lastEventId'))
    );
  }

  if (carerJobStream) {
    const auth = await authorizeCarerJobStream(liveRequest, carerJobStream);
    if (!auth.ok) {
      return auth.response;
    }

    console.info('[LIVE_STREAM_AUTH]', {
      channelType: carerJobStream.channelType,
      carerUid: auth.auth.uid,
      coadminUid: auth.auth.coadminUid,
      ...auth.auth.timing,
    });

    return createLiveStreamResponse(
      liveRequest,
      carerJobStream.channels,
      parseLastEventId(url.searchParams.get('lastEventId'))
    );
  }

  return apiError('Forbidden.', 403);
}

function createFanoutLiveStreamResponse(
  request: Request,
  allowedChannels: string[],
  lastEventId: number
) {
  console.info('[LIVE_STREAM_FANOUT_ENABLED]', {
    channels: allowedChannels,
    lastEventId,
  });

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let cursor = lastEventId;
      let closed = false;
      let replaying = true;
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
      let subscription: LiveOutboxFanoutSubscription | null = null;
      const pendingRows: LiveOutboxRow[] = [];

      const clearHeartbeatTimer = () => {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
      };

      const closeStream = (reason: string) => {
        if (closed) return;
        closed = true;
        clearHeartbeatTimer();
        subscription?.unsubscribe(reason);
        const stats = getLiveOutboxFanoutStats();
        console.info('[LIVE_STREAM_FANOUT_CLEANUP]', {
          channels: allowedChannels,
          lastEventId: subscription?.getCursor() ?? cursor,
          reason,
          activeBrowserSubscribers: stats.activeBrowserSubscribers,
          activeSubscribers: stats.activeSubscribers,
          cleanupCount: stats.cleanupCount,
        });
        try {
          controller.close();
        } catch {
          // Ignore close races.
        }
      };

      const enqueue = (chunk: string) => {
        if (closed) return false;
        try {
          controller.enqueue(encoder.encode(chunk));
          return true;
        } catch (error) {
          console.info('[LIVE_STREAM_ERROR]', {
            phase: 'fanout_enqueue',
            channels: allowedChannels,
            lastEventId: cursor,
            error,
          });
          closeStream('enqueue_failed');
          return false;
        }
      };

      const sendRow = (row: LiveOutboxRow, phase: 'replay' | 'fanout') => {
        if (closed) return false;
        if (row.outbox_id <= cursor) return true;
        const ok = enqueue(formatSseEvent(row));
        if (!ok) return false;
        cursor = Math.max(cursor, row.outbox_id);
        subscription?.advanceCursor(cursor);
        logLiveStreamDelivered(row, phase);
        if (phase === 'fanout') {
          console.info('[LIVE_STREAM_FANOUT_DELIVERED]', {
            outboxId: row.outbox_id,
            channel: row.channel,
            eventType: row.event_type,
            lastEventId: cursor,
          });
        }
        return true;
      };

      const sendHeartbeat = (phase: 'initial' | 'interval') => {
        if (closed) return;
        enqueue(formatPingEvent(allowedChannels));
        debugLog('[LIVE_STREAM_HEARTBEAT]', {
          channels: allowedChannels,
          lastEventId: cursor,
          phase,
          mode: 'fanout',
        });
      };

      subscription = subscribeLiveOutboxFanout({
        channels: allowedChannels,
        cursor: lastEventId,
        route: 'browser_live_stream',
        autoAdvance: false,
        enqueue: (row) => {
          if (closed) return false;
          if (replaying) {
            pendingRows.push(row);
            return true;
          }
          return sendRow(row, 'fanout');
        },
      });

      console.info('[LIVE_STREAM_FANOUT_SUBSCRIBED]', {
        subscriptionId: subscription.id,
        channels: allowedChannels,
        lastEventId,
      });

      const pump = async () => {
        try {
          console.info('[LIVE_STREAM_FANOUT_REPLAY_START]', {
            subscriptionId: subscription?.id,
            channels: allowedChannels,
            lastEventId,
          });
          const replayRows = await getLiveOutboxRowsAfter(allowedChannels, lastEventId, 200);
          let replayCount = 0;
          for (const row of replayRows) {
            if (!sendRow(row, 'replay')) break;
            replayCount += 1;
          }
          console.info('[LIVE_STREAM_FANOUT_REPLAY_DONE]', {
            subscriptionId: subscription?.id,
            channels: allowedChannels,
            replayCount,
            pendingCount: pendingRows.length,
            lastEventId: cursor,
          });
        } catch (error) {
          console.info('[LIVE_STREAM_ERROR]', {
            phase: 'fanout_replay',
            channels: allowedChannels,
            lastEventId: cursor,
            error,
          });
        } finally {
          replaying = false;
        }

        for (const row of pendingRows.sort((left, right) => left.outbox_id - right.outbox_id)) {
          if (!sendRow(row, 'fanout')) break;
        }
        pendingRows.length = 0;

        sendHeartbeat('initial');
        heartbeatTimer = setInterval(() => {
          sendHeartbeat('interval');
        }, HEARTBEAT_INTERVAL_MS);
      };

      request.signal.addEventListener('abort', () => closeStream('client_abort'), { once: true });
      void pump().catch((error) => {
        console.info('[LIVE_STREAM_ERROR]', {
          phase: 'fanout_pump',
          channels: allowedChannels,
          lastEventId: cursor,
          error,
        });
        closeStream('pump_failed');
      });
    },
    cancel() {
      // Abort is wired once on request.signal; client disconnect triggers abort.
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

function createLiveStreamResponse(
  request: Request,
  allowedChannels: string[],
  lastEventId: number
) {
  console.info('[LIVE_STREAM_SUBSCRIBE]', {
    channels: allowedChannels,
    lastEventId,
  });

  if (isBrowserFanoutEnabled()) {
    return createFanoutLiveStreamResponse(request, allowedChannels, lastEventId);
  }

  console.info('[LIVE_STREAM_LEGACY_POLLING_ACTIVE]', {
    channels: allowedChannels,
    lastEventId,
    pollIntervalMs: POLL_INTERVAL_MS,
  });

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let cursor = lastEventId;
      let closed = false;
      let pollInFlight = false;
      let wakeTimer: ReturnType<typeof setTimeout> | null = null;
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

      const clearWakeTimer = () => {
        if (wakeTimer) {
          clearTimeout(wakeTimer);
          wakeTimer = null;
        }
      };

      const clearHeartbeatTimer = () => {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
      };

      const sendHeartbeat = (phase: 'initial' | 'interval') => {
        if (closed) return;
        enqueue(formatPingEvent(allowedChannels));
        debugLog('[LIVE_STREAM_HEARTBEAT]', {
          channels: allowedChannels,
          lastEventId: cursor,
          phase,
        });
      };

      const closeStream = (reason: string) => {
        if (closed) return;
        closed = true;
        clearWakeTimer();
        clearHeartbeatTimer();
        console.info('[LIVE_STREAM_CLOSE]', {
          channels: allowedChannels,
          lastEventId: cursor,
          reason,
        });
        try {
          controller.close();
        } catch {
          // Ignore close races.
        }
      };

      const enqueue = (chunk: string) => {
        if (closed) return;
        controller.enqueue(encoder.encode(chunk));
      };

      const waitForPollInterval = () =>
        new Promise<void>((resolve) => {
          if (closed || request.signal.aborted) {
            resolve();
            return;
          }
          clearWakeTimer();
          wakeTimer = setTimeout(() => {
            wakeTimer = null;
            resolve();
          }, POLL_INTERVAL_MS);
        });

      const pollOnce = async () => {
        if (closed || pollInFlight) return;
        pollInFlight = true;
        try {
          const rows = await getLiveOutboxRowsAfter(allowedChannels, cursor, 100);
          for (const row of rows) {
            logLiveStreamDelivered(row, 'poll');
            enqueue(formatSseEvent(row));
            cursor = Math.max(cursor, row.outbox_id);
          }
        } catch (error) {
          console.info('[LIVE_STREAM_ERROR]', {
            phase: 'poll',
            channels: allowedChannels,
            lastEventId: cursor,
            error,
          });
        } finally {
          pollInFlight = false;
        }
      };

      const pump = async () => {
        try {
          const replayRows = await getLiveOutboxRowsAfter(allowedChannels, cursor, 200);
          for (const row of replayRows) {
            logLiveStreamDelivered(row, 'replay');
            enqueue(formatSseEvent(row));
            cursor = Math.max(cursor, row.outbox_id);
          }
        } catch (error) {
          console.info('[LIVE_STREAM_ERROR]', {
            phase: 'replay',
            channels: allowedChannels,
            lastEventId: cursor,
            error,
          });
        }

        sendHeartbeat('initial');
        heartbeatTimer = setInterval(() => {
          sendHeartbeat('interval');
        }, HEARTBEAT_INTERVAL_MS);

        while (!closed && !request.signal.aborted) {
          await pollOnce();
          if (closed || request.signal.aborted) break;
          await waitForPollInterval();
        }
      };

      request.signal.addEventListener(
        'abort',
        () => closeStream('client_abort'),
        { once: true }
      );
      void pump().finally(() => closeStream('pump_finished'));
    },
    cancel() {
      // Abort is wired once on request.signal; client disconnect triggers abort.
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
