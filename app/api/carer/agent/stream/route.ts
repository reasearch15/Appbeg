import { verifyAgentTickSecret } from '@/lib/automation/agentApiAuth';
import { apiError } from '@/lib/firebase/apiAuth';
import { isAuthoritySqlWriteEnabled } from '@/lib/server/authoritySqlWrite';
import { verifyAgentLinkedToCarerInSql } from '@/lib/sql/authorityAgentJobs';
import {
  getLiveOutboxFanoutStats,
  subscribeLiveOutboxFanout,
  type LiveOutboxFanoutSubscription,
} from '@/lib/sql/liveOutboxFanout';
import { agentJobLiveChannel, getLiveOutboxRowsAfter, type LiveOutboxRow } from '@/lib/sql/liveOutbox';
import { cleanText } from '@/lib/sql/playerMirrorCommon';
import { warnIfFanoutRequiredButDisabled } from '@/lib/server/liveStreamFanoutGuard';
import { debugLog } from '@/lib/server/verboseLogs';

export const runtime = 'nodejs';

export const dynamic = 'force-dynamic';

const POLL_INTERVAL_MS = 250;
const HEARTBEAT_INTERVAL_MS = 25_000;

function parseLastEventId(raw: string | null) {
  const parsed = Number.parseInt(String(raw || '0'), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function formatSseEvent(row: LiveOutboxRow) {
  return `id: ${row.outbox_id}\nevent: ${row.event_type}\ndata: ${JSON.stringify(row.payload)}\n\n`;
}

function formatPingEvent(channel: string) {
  return `event: ping\ndata: ${JSON.stringify({
    now: new Date().toISOString(),
    channel,
  })}\n\n`;
}

function isAgentFanoutEnabled() {
  return (
    String(process.env.LIVE_OUTBOX_FANOUT_ENABLED || '').trim() === '1' &&
    String(process.env.LIVE_OUTBOX_FANOUT_AGENT_ENABLED || '').trim() === '1'
  );
}

function logAgentStreamDelivered(row: LiveOutboxRow, phase: 'poll' | 'replay' | 'fanout') {
  if (row.event_type !== 'job_available') return;
  console.info('[AGENT_STREAM_EVENT_DELIVERED]', {
    outboxId: row.outbox_id,
    channel: row.channel,
    eventType: row.event_type,
    entityId: row.entity_id,
    jobId: row.payload?.jobId || null,
    taskId: row.payload?.taskId || null,
    phase,
  });
}

function createFanoutAgentStreamResponse(input: {
  request: Request;
  carerUid: string;
  agentId: string;
  channel: string;
  lastEventId: number;
}) {
  const { request, carerUid, agentId, channel, lastEventId } = input;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
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
        console.info('[AGENT_STREAM_CLOSE]', {
          carerUid,
          agentId,
          channel,
          lastEventId: subscription?.getCursor() ?? lastEventId,
          reason,
          mode: 'fanout',
          activeAgentSubscribers: stats.activeAgentSubscribers,
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
          console.info('[AGENT_STREAM_ERROR]', {
            phase: 'enqueue',
            carerUid,
            agentId,
            channel,
            error,
          });
          closeStream('enqueue_failed');
          return false;
        }
      };

      const sendRow = (row: LiveOutboxRow, phase: 'replay' | 'fanout') => {
        if (closed) return false;
        if (subscription && row.outbox_id <= subscription.getCursor()) return true;
        const ok = enqueue(formatSseEvent(row));
        if (!ok) return false;
        subscription?.advanceCursor(row.outbox_id);
        logAgentStreamDelivered(row, phase);
        return true;
      };

      const sendHeartbeat = (phase: 'initial' | 'interval') => {
        if (closed) return;
        enqueue(formatPingEvent(channel));
        debugLog('[AGENT_STREAM_HEARTBEAT]', {
          carerUid,
          agentId,
          channel,
          lastEventId: subscription?.getCursor() ?? lastEventId,
          phase,
          mode: 'fanout',
        });
      };

      subscription = subscribeLiveOutboxFanout({
        channels: [channel],
        cursor: lastEventId,
        route: 'carer_agent_stream',
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

      const pump = async () => {
        try {
          const replayRows = await getLiveOutboxRowsAfter([channel], lastEventId, 100);
          console.info('[AGENT_STREAM_REPLAY]', {
            carerUid,
            agentId,
            channel,
            replayCount: replayRows.length,
            mode: 'fanout',
          });
          for (const row of replayRows) {
            if (!sendRow(row, 'replay')) break;
          }
        } catch (error) {
          console.info('[AGENT_STREAM_ERROR]', {
            phase: 'replay',
            carerUid,
            agentId,
            channel,
            lastEventId: subscription?.getCursor() ?? lastEventId,
            mode: 'fanout',
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
        console.info('[AGENT_STREAM_ERROR]', {
          phase: 'fanout_pump',
          carerUid,
          agentId,
          channel,
          error,
        });
        closeStream('pump_failed');
      });
    },
    cancel() {
      // Abort is wired once on request.signal.
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

export async function GET(request: Request) {
  warnIfFanoutRequiredButDisabled('agent_stream');
  const url = new URL(request.url);
  const carerUid = cleanText(url.searchParams.get('carerUid'));
  const agentId = cleanText(url.searchParams.get('agentId'));
  const lastEventId = parseLastEventId(url.searchParams.get('lastEventId'));

  if (!isAuthoritySqlWriteEnabled()) {
    return apiError('SQL authority writes are disabled.', 503);
  }
  if (!verifyAgentTickSecret(request)) {
    return apiError('Unauthorized.', 401);
  }
  if (!carerUid || !agentId) {
    return apiError('carerUid and agentId are required.', 400);
  }

  try {
    await verifyAgentLinkedToCarerInSql(carerUid, agentId);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Agent is not linked to this carer.';
    return apiError(message, 403);
  }

  const channel = agentJobLiveChannel(carerUid, agentId);

  console.info('[AGENT_STREAM_SUBSCRIBE]', {
    carerUid,
    agentId,
    channel,
    lastEventId,
    mode: isAgentFanoutEnabled() ? 'fanout' : 'poll',
  });

  if (isAgentFanoutEnabled()) {
    return createFanoutAgentStreamResponse({
      request,
      carerUid,
      agentId,
      channel,
      lastEventId,
    });
  }

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

      const closeStream = (reason: string) => {
        if (closed) return;
        closed = true;
        clearWakeTimer();
        clearHeartbeatTimer();
        console.info('[AGENT_STREAM_CLOSE]', {
          carerUid,
          agentId,
          channel,
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

      const sendHeartbeat = (phase: 'initial' | 'interval') => {
        if (closed) return;
        enqueue(formatPingEvent(channel));
        debugLog('[AGENT_STREAM_HEARTBEAT]', {
          carerUid,
          agentId,
          channel,
          lastEventId: cursor,
          phase,
        });
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
          const rows = await getLiveOutboxRowsAfter([channel], cursor, 50);
          for (const row of rows) {
            logAgentStreamDelivered(row, 'poll');
            enqueue(formatSseEvent(row));
            cursor = Math.max(cursor, row.outbox_id);
          }
        } catch (error) {
          console.info('[AGENT_STREAM_ERROR]', {
            phase: 'poll',
            carerUid,
            agentId,
            channel,
            lastEventId: cursor,
            error,
          });
        } finally {
          pollInFlight = false;
        }
      };

      const pump = async () => {
        try {
          const replayRows = await getLiveOutboxRowsAfter([channel], cursor, 100);
          for (const row of replayRows) {
            logAgentStreamDelivered(row, 'replay');
            enqueue(formatSseEvent(row));
            cursor = Math.max(cursor, row.outbox_id);
          }
        } catch (error) {
          console.info('[AGENT_STREAM_ERROR]', {
            phase: 'replay',
            carerUid,
            agentId,
            channel,
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

      request.signal.addEventListener('abort', () => closeStream('client_abort'), { once: true });
      void pump().finally(() => closeStream('pump_finished'));
    },
    cancel() {
      // Abort is wired once on request.signal.
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
