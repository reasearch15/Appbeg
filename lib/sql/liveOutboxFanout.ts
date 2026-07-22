import 'server-only';

import { Client } from 'pg';

import { getLiveOutboxRowsAfter, type LiveOutboxRow } from '@/lib/sql/liveOutbox';
import { cleanText, getPlayerMirrorPool, toIsoString } from '@/lib/sql/playerMirrorCommon';
import { debugLog } from '@/lib/server/verboseLogs';

const LIVE_OUTBOX_NOTIFY_CHANNEL = 'live_outbox';
const FALLBACK_POLL_INTERVAL_MS = 250;
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

type LiveOutboxFanoutSubscriber = {
  id: string;
  channels: Set<string>;
  route: string;
  cursor: number;
  autoAdvance: boolean;
  closed: boolean;
  enqueue: (row: LiveOutboxRow) => boolean;
};

export type LiveOutboxFanoutSubscription = {
  id: string;
  getCursor: () => number;
  advanceCursor: (outboxId: number) => void;
  unsubscribe: (reason?: string) => void;
};

export type LiveOutboxFanoutSubscribeInput = {
  channels: string[];
  cursor: number;
  route: string;
  autoAdvance?: boolean;
  enqueue: (row: LiveOutboxRow) => boolean;
};

type LiveOutboxFanoutStats = {
  activeSubscribers: number;
  activeAgentSubscribers: number;
  activeBrowserSubscribers: number;
  activeChannelCount: number;
  cleanupCount: number;
  droppedSubscriberCount: number;
  deliveredCount: number;
  fallbackActive: boolean;
  fallbackPollCount: number;
  listenerConnected: boolean;
  listenerDegraded: boolean;
  maxSubscriberLag: number;
  notificationCount: number;
};

type LiveOutboxNotification = {
  channel?: string;
  payload?: string;
};

class LiveOutboxFanout {
  private client: Client | null = null;
  private connectPromise: Promise<void> | null = null;
  private degraded = false;
  private fallbackInFlight = false;
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private fallbackWasActive = false;
  private listenerConnected = false;
  private metricsTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private subscriberSeq = 0;
  private readonly subscribersByChannel = new Map<string, Map<string, LiveOutboxFanoutSubscriber>>();
  private readonly subscribersById = new Map<string, LiveOutboxFanoutSubscriber>();
  private readonly stats: LiveOutboxFanoutStats = {
    activeSubscribers: 0,
    activeAgentSubscribers: 0,
    activeBrowserSubscribers: 0,
    activeChannelCount: 0,
    cleanupCount: 0,
    droppedSubscriberCount: 0,
    deliveredCount: 0,
    fallbackActive: false,
    fallbackPollCount: 0,
    listenerConnected: false,
    listenerDegraded: false,
    maxSubscriberLag: 0,
    notificationCount: 0,
  };

  subscribe(input: LiveOutboxFanoutSubscribeInput): LiveOutboxFanoutSubscription {
    const channels = Array.from(new Set(input.channels.map(cleanText).filter(Boolean)));
    const id = `live-outbox-sub-${Date.now()}-${++this.subscriberSeq}`;
    const subscriber: LiveOutboxFanoutSubscriber = {
      id,
      channels: new Set(channels),
      route: cleanText(input.route) || 'unknown',
      cursor: Math.max(0, Math.trunc(input.cursor || 0)),
      autoAdvance: input.autoAdvance !== false,
      closed: false,
      enqueue: input.enqueue,
    };

    this.subscribersById.set(id, subscriber);
    for (const channel of subscriber.channels) {
      let channelSubscribers = this.subscribersByChannel.get(channel);
      if (!channelSubscribers) {
        channelSubscribers = new Map();
        this.subscribersByChannel.set(channel, channelSubscribers);
      }
      channelSubscribers.set(id, subscriber);
    }

    this.updateStats();
    console.info('[LIVE_OUTBOX_FANOUT_SUBSCRIBED]', {
      subscriberId: id,
      route: subscriber.route,
      channelCount: subscriber.channels.size,
      activeSubscribers: this.stats.activeSubscribers,
      activeBrowserSubscribers: this.stats.activeBrowserSubscribers,
      activeAgentSubscribers: this.stats.activeAgentSubscribers,
      cursor: subscriber.cursor,
    });

    void this.ensureStarted();
    this.ensureFallbackLoop();
    this.ensureMetricsLoop();

    return {
      id,
      getCursor: () => subscriber.cursor,
      advanceCursor: (outboxId: number) => {
        subscriber.cursor = Math.max(subscriber.cursor, Math.max(0, Math.trunc(outboxId || 0)));
      },
      unsubscribe: (reason = 'unsubscribe') => {
        this.unsubscribe(id, reason);
      },
    };
  }

  getStats() {
    this.updateStats();
    return { ...this.stats };
  }

  private async ensureStarted() {
    if (this.listenerConnected || this.connectPromise) return;

    const connectionString = cleanText(process.env.DATABASE_URL || process.env.POSTGRES_URL);
    if (!connectionString) {
      this.markDegraded('missing_database_url');
      console.info('[LIVE_OUTBOX_FANOUT_ERROR]', { reason: 'missing_database_url' });
      return;
    }

    console.info('[LIVE_OUTBOX_FANOUT_START]', {
      activeSubscribers: this.subscribersById.size,
    });

    this.connectPromise = this.connectListener(connectionString).finally(() => {
      this.connectPromise = null;
    });
    await this.connectPromise;
  }

  private async connectListener(connectionString: string) {
    const client = new Client({
      application_name: 'appbeg_live_outbox_fanout',
      connectionString,
    });
    this.client = client;

    client.on('notification', (message: LiveOutboxNotification) => {
      this.handleNotification(message);
    });
    client.on('error', (error) => {
      console.info('[LIVE_OUTBOX_FANOUT_ERROR]', {
        phase: 'listener_error',
        error,
      });
      this.handleListenerClosed('listener_error');
    });
    client.on('end', () => {
      this.handleListenerClosed('listener_end');
    });

    try {
      await client.connect();
      await client.query(`LISTEN ${LIVE_OUTBOX_NOTIFY_CHANNEL}`);
      this.listenerConnected = true;
      this.degraded = false;
      this.reconnectAttempt = 0;
      this.updateStats();
      this.stopFallbackLoop('listener_connected');
      console.info('[LIVE_OUTBOX_FANOUT_LISTENING]', {
        channel: LIVE_OUTBOX_NOTIFY_CHANNEL,
        activeSubscribers: this.subscribersById.size,
      });
    } catch (error) {
      console.info('[LIVE_OUTBOX_FANOUT_ERROR]', {
        phase: 'listener_connect',
        error,
      });
      try {
        await client.end();
      } catch {
        // Ignore close races while failing over to fallback polling.
      }
      if (this.client === client) {
        this.client = null;
      }
      this.markDegraded('listener_connect_failed');
      this.scheduleReconnect();
    }
  }

  private handleListenerClosed(reason: string) {
    if (!this.listenerConnected && this.degraded) return;
    this.listenerConnected = false;
    this.client = null;
    this.markDegraded(reason);
    this.scheduleReconnect();
  }

  private markDegraded(reason: string) {
    this.degraded = true;
    this.updateStats();
    console.info('[LIVE_OUTBOX_FANOUT_ERROR]', {
      phase: 'listener_degraded',
      reason,
      activeSubscribers: this.subscribersById.size,
    });
    this.ensureFallbackLoop();
  }

  private scheduleReconnect() {
    if (this.reconnectTimer || !this.subscribersById.size) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.ensureStarted();
    }, delay);
  }

  private handleNotification(message: LiveOutboxNotification) {
    if (message.channel !== LIVE_OUTBOX_NOTIFY_CHANNEL) return;
    const outboxId = Number.parseInt(cleanText(message.payload), 10);
    if (!Number.isFinite(outboxId) || outboxId <= 0) {
      console.info('[LIVE_OUTBOX_FANOUT_ERROR]', {
        phase: 'notify_parse',
        payloadPresent: Boolean(message.payload),
      });
      return;
    }

    this.stats.notificationCount += 1;
    console.info('[LIVE_OUTBOX_FANOUT_NOTIFY]', {
      outboxId,
      notificationCount: this.stats.notificationCount,
    });
    void this.fetchAndRouteOutboxId(outboxId, 'notify');
  }

  private async fetchAndRouteOutboxId(outboxId: number, phase: 'notify' | 'fallback') {
    const row = await this.fetchRowByOutboxId(outboxId);
    if (!row) return;
    this.routeRow(row, phase);
  }

  private async fetchRowByOutboxId(outboxId: number): Promise<LiveOutboxRow | null> {
    const db = getPlayerMirrorPool();
    if (!db) return null;

    try {
      const result = await db.query(
        `
          SELECT
            outbox_id,
            channel,
            event_type,
            entity_type,
            entity_id,
            payload,
            payload_hash,
            source,
            mirrored_at,
            created_at
          FROM public.live_outbox
          WHERE outbox_id = $1
            AND deleted_at IS NULL
          LIMIT 1
        `,
        [Math.max(0, Math.trunc(outboxId || 0))]
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        outbox_id: Number(row.outbox_id),
        channel: cleanText(row.channel),
        event_type: cleanText(row.event_type),
        entity_type: cleanText(row.entity_type),
        entity_id: cleanText(row.entity_id),
        payload:
          row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
            ? (row.payload as Record<string, unknown>)
            : {},
        payload_hash: cleanText(row.payload_hash) || null,
        source: cleanText(row.source) || 'mirror',
        mirrored_at: toIsoString(row.mirrored_at),
        created_at: toIsoString(row.created_at) || new Date().toISOString(),
      };
    } catch (error) {
      console.info('[LIVE_OUTBOX_FANOUT_ERROR]', {
        phase: 'fetch_row',
        outboxId,
        error,
      });
      return null;
    }
  }

  private routeRow(row: LiveOutboxRow, phase: 'notify' | 'fallback') {
    const channelSubscribers = this.subscribersByChannel.get(row.channel);
    if (!channelSubscribers?.size) return;

    let delivered = 0;
    for (const subscriber of Array.from(channelSubscribers.values())) {
      if (subscriber.closed || row.outbox_id <= subscriber.cursor) continue;
      let ok = false;
      try {
        ok = subscriber.enqueue(row);
      } catch (error) {
        console.info('[LIVE_OUTBOX_FANOUT_ERROR]', {
          phase: 'enqueue',
          subscriberId: subscriber.id,
          route: subscriber.route,
          outboxId: row.outbox_id,
          error,
        });
      }
      if (!ok) {
        this.stats.droppedSubscriberCount += 1;
        this.unsubscribe(subscriber.id, 'enqueue_failed');
        continue;
      }
      if (subscriber.autoAdvance) {
        subscriber.cursor = Math.max(subscriber.cursor, row.outbox_id);
      }
      delivered += 1;
      this.stats.deliveredCount += 1;
    }

    if (delivered > 0) {
      console.info('[LIVE_OUTBOX_FANOUT_DELIVERED]', {
        outboxId: row.outbox_id,
        channel: row.channel,
        eventType: row.event_type,
        phase,
        delivered,
        deliveredCount: this.stats.deliveredCount,
        activeSubscribers: this.subscribersById.size,
      });
    }
  }

  private ensureFallbackLoop() {
    if (!this.degraded || this.listenerConnected || this.fallbackTimer || !this.subscribersById.size) {
      this.updateFallbackActive(false);
      return;
    }

    this.updateFallbackActive(true);
    this.fallbackTimer = setTimeout(() => {
      this.fallbackTimer = null;
      void this.runFallbackPoll().finally(() => {
        this.ensureFallbackLoop();
      });
    }, FALLBACK_POLL_INTERVAL_MS);
  }

  private async runFallbackPoll() {
    if (this.fallbackInFlight || !this.subscribersById.size || this.listenerConnected || !this.degraded) {
      return;
    }

    const activeChannels = Array.from(this.subscribersByChannel.entries())
      .filter(([, subscribers]) => subscribers.size > 0)
      .map(([channel]) => channel);
    if (!activeChannels.length) return;

    const minCursor = Math.min(
      ...Array.from(this.subscribersById.values()).map((subscriber) => subscriber.cursor)
    );

    this.fallbackInFlight = true;
    try {
      let pageCursor = minCursor;
      let pageCount = 0;
      let rowCount = 0;
      for (;;) {
        const rows = await getLiveOutboxRowsAfter(activeChannels, pageCursor, 500);
        this.stats.fallbackPollCount += 1;
        pageCount += 1;
        rowCount += rows.length;
        console.info('[LIVE_OUTBOX_FANOUT_FALLBACK_POLL]', {
          activeChannels: activeChannels.length,
          minCursor: pageCursor,
          rowCount: rows.length,
          pageCount,
          fallbackPollCount: this.stats.fallbackPollCount,
        });
        for (const row of rows) {
          this.routeRow(row, 'fallback');
          pageCursor = Math.max(pageCursor, row.outbox_id);
        }
        if (rows.length < 500) break;
      }
      if (pageCount > 1 || rowCount > 0) {
        console.info('[LIVE_OUTBOX_FANOUT_FALLBACK_DRAINED]', {
          activeChannels: activeChannels.length,
          pageCount,
          rowCount,
        });
      }
    } catch (error) {
      console.info('[LIVE_OUTBOX_FANOUT_ERROR]', {
        phase: 'fallback_poll',
        activeChannels: activeChannels.length,
        error,
      });
    } finally {
      this.fallbackInFlight = false;
    }
  }

  private stopFallbackLoop(reason: string) {
    if (this.fallbackTimer) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }
    const wasActive = this.fallbackWasActive;
    this.updateFallbackActive(false);
    if (wasActive) {
      console.info('[LIVE_OUTBOX_FANOUT_FALLBACK_RECOVERED]', {
        reason,
        activeSubscribers: this.subscribersById.size,
      });
    }
  }

  private updateFallbackActive(active: boolean) {
    if (this.fallbackWasActive !== active) {
      if (active) {
        console.info('[LIVE_OUTBOX_FANOUT_FALLBACK_ACTIVE]', {
          activeSubscribers: this.subscribersById.size,
          activeChannelCount: this.subscribersByChannel.size,
        });
      }
    }
    this.fallbackWasActive = active;
    this.updateStats();
  }

  private unsubscribe(id: string, reason: string) {
    const subscriber = this.subscribersById.get(id);
    if (!subscriber || subscriber.closed) return;

    subscriber.closed = true;
    this.subscribersById.delete(id);
    for (const channel of subscriber.channels) {
      const channelSubscribers = this.subscribersByChannel.get(channel);
      channelSubscribers?.delete(id);
      if (channelSubscribers && channelSubscribers.size === 0) {
        this.subscribersByChannel.delete(channel);
      }
    }

    this.stats.cleanupCount += 1;
    this.updateStats();
    console.info('[LIVE_OUTBOX_FANOUT_UNSUBSCRIBED]', {
      subscriberId: id,
      route: subscriber.route,
      reason,
      activeSubscribers: this.stats.activeSubscribers,
      activeBrowserSubscribers: this.stats.activeBrowserSubscribers,
      activeAgentSubscribers: this.stats.activeAgentSubscribers,
      cleanupCount: this.stats.cleanupCount,
      cursor: subscriber.cursor,
    });

    if (!this.subscribersById.size) {
      this.stopFallbackLoop('no_subscribers');
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.stopMetricsLoop();
    }
  }

  private updateStats() {
    let activeAgentSubscribers = 0;
    let activeBrowserSubscribers = 0;
    let maxCursor = 0;
    let minCursor = Number.POSITIVE_INFINITY;
    for (const subscriber of this.subscribersById.values()) {
      if (subscriber.route.includes('agent')) {
        activeAgentSubscribers += 1;
      } else {
        activeBrowserSubscribers += 1;
      }
      maxCursor = Math.max(maxCursor, subscriber.cursor);
      minCursor = Math.min(minCursor, subscriber.cursor);
    }
    this.stats.activeSubscribers = this.subscribersById.size;
    this.stats.activeAgentSubscribers = activeAgentSubscribers;
    this.stats.activeBrowserSubscribers = activeBrowserSubscribers;
    this.stats.activeChannelCount = this.subscribersByChannel.size;
    this.stats.fallbackActive = this.fallbackWasActive;
    this.stats.listenerConnected = this.listenerConnected;
    this.stats.listenerDegraded = this.degraded;
    this.stats.maxSubscriberLag =
      this.subscribersById.size > 1 && Number.isFinite(minCursor) ? maxCursor - minCursor : 0;
  }

  private ensureMetricsLoop() {
    if (this.metricsTimer || !this.subscribersById.size) return;
    this.metricsTimer = setInterval(() => {
      if (!this.subscribersById.size) {
        this.stopMetricsLoop();
        return;
      }
      this.logMetrics('interval');
    }, 60_000);
    this.logMetrics('subscribe');
  }

  private stopMetricsLoop() {
    if (!this.metricsTimer) return;
    clearInterval(this.metricsTimer);
    this.metricsTimer = null;
    this.logMetrics('stop');
  }

  private logMetrics(phase: 'subscribe' | 'interval' | 'stop') {
    this.updateStats();
    const unhealthy =
      !this.stats.listenerConnected ||
      this.stats.listenerDegraded ||
      this.stats.fallbackActive ||
      this.stats.droppedSubscriberCount > 0;
    if (unhealthy) {
      console.warn('[LIVE_OUTBOX_FANOUT_METRICS]', {
        phase,
        ...this.stats,
      });
      return;
    }
    debugLog('[LIVE_OUTBOX_FANOUT_METRICS]', {
      phase,
      ...this.stats,
    });
  }
}

type LiveOutboxFanoutGlobal = typeof globalThis & {
  __appbegLiveOutboxFanout?: LiveOutboxFanout;
};

function getLiveOutboxFanout() {
  const globalFanout = globalThis as LiveOutboxFanoutGlobal;
  if (!globalFanout.__appbegLiveOutboxFanout) {
    globalFanout.__appbegLiveOutboxFanout = new LiveOutboxFanout();
  }
  return globalFanout.__appbegLiveOutboxFanout;
}

export function subscribeLiveOutboxFanout(input: LiveOutboxFanoutSubscribeInput) {
  return getLiveOutboxFanout().subscribe(input);
}

export function getLiveOutboxFanoutStats() {
  return getLiveOutboxFanout().getStats();
}
