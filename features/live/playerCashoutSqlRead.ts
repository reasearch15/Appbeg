'use client';

import type { PlayerCashoutTask } from '@/features/cashouts/playerCashoutTasks';
import { getLocalAppSessionId } from '@/features/auth/appSession';
import { getLocalPlayerSessionId } from '@/features/auth/playerSession';
import { getCachedSessionUser } from '@/features/auth/sessionUser';
import { getSqlApiReadHeaders } from '@/lib/client/sqlApiHeaders';
import {
  attachHiddenTabPollResume,
  HIDDEN_THROTTLED_POLL_MS,
  isDocumentHidden,
  logHiddenTabPollPaused,
  logHiddenTabPollThrottled,
  resolveVisiblePollIntervalMs,
} from '@/lib/client/hiddenTabPoll';
import { scheduleSafetyInterval } from '@/lib/client/snapshotPollJitter';
import { playerDebugLog, playerLiveOpsLog } from '@/lib/client/playerDebugLogs';
import { withPlayerFetchLifecycleReason } from '@/lib/client/playerFetchLifecycleContext';
import { isClientSqlReadMode, logClientFirestoreSkipped } from '@/lib/client/sqlReadMode';
import {
  subscribePlayerCashoutLiveFromPlayerStream,
  subscribePlayerCashoutLiveHealthFromPlayerStream,
} from '@/features/live/playerRequestSqlRead';

const POLL_MS = 30_000;
const SAFETY_REFETCH_MS = 60_000;
const STARTUP_CASHOUT_CACHE_COOLDOWN_MS = 2_500;
const activeCashoutLiveStreamKeys = new Set<string>();

type CashoutScope = 'player' | 'coadmin' | 'staff' | 'assigned_handler' | 'all';
type CashoutTaskList = 'pending' | 'active' | 'completed';
type CashoutLifecycleLists = {
  pending: PlayerCashoutTask[];
  active: PlayerCashoutTask[];
  completed: PlayerCashoutTask[];
};

const CASHOUT_LIVE_EVENTS = [
  'cashout_create',
  'cashout_task_created',
  'cashout_start',
  'cashout_complete',
  'cashout_decline',
] as const;

function cleanText(value: unknown) {
  return String(value || '').trim();
}

function coadminCashoutLiveChannel(coadminUid: string) {
  return `coadmin:${cleanText(coadminUid)}:cashouts`;
}

function playerCashoutLiveChannel(playerUid: string) {
  return `player:${cleanText(playerUid)}:cashouts`;
}

function logScopeEventReceived(scope: CashoutScope, eventType: string, payload: Record<string, unknown>) {
  const role = String(getCachedSessionUser()?.role || '').toLowerCase();
  const base = {
    eventType,
    taskId: cleanText(payload.taskId || payload.entityId),
    coadminUid: cleanText(payload.coadminUid),
    playerUid: cleanText(payload.playerUid),
    status: cleanText(payload.status),
    scope,
  };
  if (scope === 'coadmin' || role === 'coadmin') {
    playerDebugLog('[COADMIN_CASHOUT_EVENT_RECEIVED]', base);
  }
  if (scope === 'coadmin' || scope === 'all' || scope === 'staff' || role === 'staff') {
    playerDebugLog('[STAFF_CASHOUT_EVENT_RECEIVED]', base);
  }
  playerDebugLog('[CASHOUT_SSE_EVENT_RECEIVED]', base);
}

function logScopeListAfterEvent(scope: CashoutScope, count: number, reason: string) {
  const role = String(getCachedSessionUser()?.role || '').toLowerCase();
  const base = { scope, count, reason };
  if (scope === 'coadmin' || role === 'coadmin') {
    playerDebugLog('[COADMIN_CASHOUT_LIST_AFTER_EVENT]', base);
  }
  if (scope === 'coadmin' || scope === 'all' || scope === 'staff' || role === 'staff') {
    playerDebugLog('[STAFF_CASHOUT_LIST_AFTER_EVENT]', base);
  }
  playerDebugLog('[CASHOUT_UI_REFETCHED]', base);
}

function isoToTimestamp(iso: string | null | undefined): Date | null {
  if (!iso) {
    return null;
  }
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

function mapCachedTask(row: Record<string, unknown>): PlayerCashoutTask {
  return {
    id: String(row.id || ''),
    coadminUid: String(row.coadminUid || ''),
    playerUid: String(row.playerUid || ''),
    playerUsername: String(row.playerUsername || ''),
    amountNpr: Number(row.amountNpr || 0),
    paymentDetails: String(row.paymentDetails || ''),
    payoutMethod: (row.payoutMethod as PlayerCashoutTask['payoutMethod']) || null,
    qrImageUrl: String(row.qrImageUrl || '').trim() || null,
    paymentAppName: String(row.paymentAppName || '').trim() || null,
    paymentAppCashTag: String(row.paymentAppCashTag || '').trim() || null,
    paymentAppAccountName: String(row.paymentAppAccountName || '').trim() || null,
    cashDeductedOnRequest:
      typeof row.cashDeductedOnRequest === 'boolean' ? row.cashDeductedOnRequest : undefined,
    declinedByUids: Array.isArray(row.declinedByUids)
      ? row.declinedByUids.map((entry) => String(entry))
      : [],
    status: (String(row.status || 'pending') as PlayerCashoutTask['status']) || 'pending',
    assignedHandlerUid: String(row.assignedHandlerUid || '').trim() || null,
    assignedHandlerUsername: String(row.assignedHandlerUsername || '').trim() || null,
    startedAt: isoToTimestamp(String(row.startedAt || '') || null),
    expiresAt: isoToTimestamp(String(row.expiresAt || '') || null),
    createdAt: isoToTimestamp(String(row.createdAt || '') || null),
    completedAt: isoToTimestamp(String(row.completedAt || '') || null),
  };
}

async function fetchCashoutTasks(
  scope: CashoutScope,
  uid: string,
  limit: number,
  list?: CashoutTaskList
) {
  const params = new URLSearchParams({
    scope,
    limit: String(limit),
  });
  if (scope !== 'all') {
    params.set('uid', uid);
  }
  if ((scope === 'staff' || scope === 'coadmin') && list) {
    params.set('list', list);
  }

  playerDebugLog('[CASHOUT_LIST_QUERY]', {
    scope,
    uid: scope === 'all' ? null : uid,
    limit,
  });

  const response = await fetch(`/api/player-cashout-tasks/cache?${params.toString()}`, {
    method: 'GET',
    headers: await getSqlApiReadHeaders(false),
    cache: 'no-store',
  });
  const payload = (await response.json().catch(() => ({}))) as {
    tasks?: Array<Record<string, unknown>>;
    error?: string;
  };
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to load cashout tasks.');
  }

  const tasks = (payload.tasks || []).map(mapCachedTask);
  playerDebugLog('[CASHOUT_LIST_RESULT]', {
    scope,
    uid: scope === 'all' ? null : uid,
    count: tasks.length,
  });
  return tasks;
}

async function fetchCashoutLifecycleTasks(
  scope: 'staff' | 'coadmin',
  uid: string,
  limit: number
): Promise<CashoutLifecycleLists | null> {
  const params = new URLSearchParams({
    scope,
    uid,
    limit: String(limit),
    list: 'lifecycle',
  });

  playerDebugLog('[CASHOUT_LIFECYCLE_QUERY]', {
    scope,
    uid,
    limit,
    mode: 'combined',
  });

  const response = await fetch(`/api/player-cashout-tasks/cache?${params.toString()}`, {
    method: 'GET',
    headers: await getSqlApiReadHeaders(false),
    cache: 'no-store',
  });
  const payload = (await response.json().catch(() => ({}))) as {
    lifecycle?: {
      pending?: Array<Record<string, unknown>>;
      active?: Array<Record<string, unknown>>;
      completed?: Array<Record<string, unknown>>;
    };
    error?: string;
  };
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to load cashout lifecycle tasks.');
  }
  if (!payload.lifecycle) {
    return null;
  }

  const lists = {
    pending: (payload.lifecycle.pending || []).map(mapCachedTask),
    active: (payload.lifecycle.active || []).map(mapCachedTask),
    completed: (payload.lifecycle.completed || []).map(mapCachedTask),
  };
  playerDebugLog('[CASHOUT_LIFECYCLE_RESULT]', {
    scope,
    uid,
    pendingCount: lists.pending.length,
    activeCount: lists.active.length,
    completedCount: lists.completed.length,
    mode: 'combined',
  });
  return lists;
}

function sanitizePendingCashoutTasks(tasks: PlayerCashoutTask[]): PlayerCashoutTask[] {
  return tasks.filter(
    (task) =>
      String(task.status || '').toLowerCase() === 'pending' &&
      !cleanText(task.assignedHandlerUid)
  );
}

function attachCashoutSqlPoll(input: {
  scope: CashoutScope;
  uid: string;
  limit?: number;
  onChange: (tasks: PlayerCashoutTask[]) => void;
  onError?: (error: Error) => void;
  liveChannel?: string | null;
}) {
  logClientFirestoreSkipped('player_cashout_tasks_listener', {
    scope: input.scope,
    uid: input.uid,
    liveChannel: input.liveChannel || null,
  });
  playerDebugLog('[POLLER_RETAINED]', {
    pollName: 'player_cashout_tasks',
    scope: input.scope,
    reason: input.liveChannel
      ? 'SSE triggers immediate refetch; safety poll retained for missed events/reconnects'
      : 'no live channel available for this scope',
    safetyRefetchMs: input.liveChannel ? SAFETY_REFETCH_MS : null,
  });

  let disposed = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let safetyRefetchStop: (() => void) | null = null;
  let eventSource: EventSource | null = null;
  let sharedStreamUnsubscribe: (() => void) | null = null;
  let sharedStreamHealthUnsubscribe: (() => void) | null = null;
  let cashoutStreamHealthy = false;
  let lastEventId = 0;
  let refetchInFlight = false;
  let refetchQueued = false;
  let lastFetchFinishedAt = 0;
  let activeLiveStreamKey: string | null = null;
  const startedAt = Date.now();

  const isStartupCooldownActive = () =>
    Date.now() - startedAt < STARTUP_CASHOUT_CACHE_COOLDOWN_MS;

  const logCashoutCacheDeduped = (reason: string, detail: string) => {
    playerDebugLog('[PLAYER_CASHOUT_CACHE_DEDUPED]', {
      scope: input.scope,
      uid: input.scope === 'all' ? null : input.uid,
      reason,
      detail,
      lastEventId,
      startupAgeMs: Date.now() - startedAt,
    });
  };

  const isCashoutSafetyOnlyMode = () =>
    input.scope === 'player' &&
    Boolean(sharedStreamUnsubscribe) &&
    cashoutStreamHealthy;

  const scheduleNextCashoutPoll = () => {
    if (disposed) {
      return;
    }
    if (isCashoutSafetyOnlyMode()) {
      playerDebugLog('[CASHOUT_STREAM_HEALTHY_SAFETY_ONLY]', {
        scope: input.scope,
        uid: input.uid,
        safetyRefetchMs: SAFETY_REFETCH_MS,
      });
      return;
    }
    playerDebugLog('[CASHOUT_POLL_FAST_MODE]', {
      scope: input.scope,
      uid: input.scope === 'all' ? null : input.uid,
      intervalMs: resolveVisiblePollIntervalMs(POLL_MS),
    });
    pollTimer = setTimeout(() => {
      void runPoll('poll_interval');
    }, resolveVisiblePollIntervalMs(POLL_MS));
  };

  const runPoll = async (reason: string) => {
    if (disposed) {
      return;
    }
    if (
      input.scope === 'player' &&
      isDocumentHidden() &&
      sharedStreamUnsubscribe
    ) {
      logHiddenTabPollThrottled('player_cashout_tasks', HIDDEN_THROTTLED_POLL_MS);
      if (!disposed) {
        pollTimer = setTimeout(() => {
          void runPoll('poll_interval_hidden_wait');
        }, HIDDEN_THROTTLED_POLL_MS);
      }
      return;
    }
    if (refetchInFlight) {
      if (isStartupCooldownActive()) {
        logCashoutCacheDeduped(reason, 'in_flight_startup_refetch_suppressed');
        return;
      }
      refetchQueued = true;
      return;
    }
    refetchInFlight = true;
    try {
      const tasks = await withPlayerFetchLifecycleReason(reason, () =>
        fetchCashoutTasks(input.scope, input.uid, input.limit || 50)
      );
      if (!disposed) {
        input.onChange(tasks);
        logScopeListAfterEvent(input.scope, tasks.length, reason);
        playerDebugLog('[CASHOUT_UI_UPDATED]', {
          scope: input.scope,
          uid: input.scope === 'all' ? null : input.uid,
          count: tasks.length,
          reason,
        });
      }
    } catch (error) {
      if (!disposed) {
        input.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      refetchInFlight = false;
      lastFetchFinishedAt = Date.now();
      if (!disposed && refetchQueued) {
        refetchQueued = false;
        if (isStartupCooldownActive()) {
          logCashoutCacheDeduped('queued', 'queued_startup_refetch_suppressed');
          if (!disposed) {
            scheduleNextCashoutPoll();
          }
          return;
        }
        void runPoll('queued');
        return;
      }
      scheduleNextCashoutPoll();
    }
  };

  const scheduleImmediateRefetch = (reason: string) => {
    if (disposed) {
      return;
    }
    if (
      isStartupCooldownActive() &&
      lastFetchFinishedAt > 0 &&
      Date.now() - lastFetchFinishedAt < STARTUP_CASHOUT_CACHE_COOLDOWN_MS
    ) {
      logCashoutCacheDeduped(reason, 'recent_startup_fetch_suppressed');
      return;
    }
    playerDebugLog('[CASHOUT_LIVE_EVENT_RECEIVED]', {
      scope: input.scope,
      uid: input.scope === 'all' ? null : input.uid,
      reason,
      lastEventId,
    });
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    void runPoll(reason);
  };

  const handleLiveEvent = (eventName: string, rawData: string, outboxId: number) => {
    if (eventName === 'ping') {
      return;
    }
    if (outboxId > 0) {
      lastEventId = Math.max(lastEventId, outboxId);
    }
    try {
      const payload = JSON.parse(rawData) as Record<string, unknown>;
      logScopeEventReceived(input.scope, eventName, payload);
      playerDebugLog('[CASHOUT_LIVE_EVENT_RECEIVED]', {
        eventType: eventName,
        taskId: cleanText(payload.taskId || payload.entityId),
        coadminUid: cleanText(payload.coadminUid),
        playerUid: cleanText(payload.playerUid),
        status: cleanText(payload.status),
        outboxId,
      });
    } catch {
      playerDebugLog('[CASHOUT_LIVE_EVENT_RECEIVED]', {
        eventType: eventName,
        outboxId,
      });
    }
    scheduleImmediateRefetch(`live:${eventName}`);
  };

  const closeEventSource = () => {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    if (activeLiveStreamKey) {
      activeCashoutLiveStreamKeys.delete(activeLiveStreamKey);
      activeLiveStreamKey = null;
    }
  };

  const connectEventSource = () => {
    if (!input.liveChannel || disposed) {
      return;
    }

    if (input.scope === 'player') {
      if (sharedStreamUnsubscribe) {
        playerDebugLog('[PLAYER_LIVE_STREAM_SINGLETON_REUSED]', {
          playerUid: input.uid,
          subscriber: 'cashout',
          reason: 'already_registered',
        });
        return;
      }
      sharedStreamUnsubscribe = subscribePlayerCashoutLiveFromPlayerStream(input.uid, ({
        eventName,
        rawData,
        outboxId,
      }) => {
        handleLiveEvent(eventName, rawData, outboxId);
      });
      sharedStreamHealthUnsubscribe = subscribePlayerCashoutLiveHealthFromPlayerStream(
        input.uid,
        (healthy, reason) => {
          const wasHealthy = cashoutStreamHealthy;
          cashoutStreamHealthy = healthy;
          if (healthy) {
            playerDebugLog('[CASHOUT_STREAM_HEALTHY_SAFETY_ONLY]', {
              scope: input.scope,
              uid: input.uid,
              reason,
              safetyRefetchMs: SAFETY_REFETCH_MS,
            });
            if (pollTimer) {
              clearTimeout(pollTimer);
              pollTimer = null;
            }
          } else if (wasHealthy) {
            playerLiveOpsLog('[CASHOUT_STREAM_UNHEALTHY_RESUME_POLL]', {
              scope: input.scope,
              uid: input.uid,
              reason,
              intervalMs: POLL_MS,
            });
            scheduleNextCashoutPoll();
          }
        }
      );
      playerDebugLog('[PLAYER_LIVE_STREAM_SINGLETON_REUSED]', {
        playerUid: input.uid,
        subscriber: 'cashout',
        channel: input.liveChannel,
      });
      return;
    }

    closeEventSource();
    const params = new URLSearchParams({
      channels: input.liveChannel,
      lastEventId: String(Math.max(0, lastEventId)),
    });
    const appSessionId = cleanText(getLocalAppSessionId());
    if (appSessionId) {
      params.set('appSessionId', appSessionId);
    }
    const url = `/api/live/stream?${params.toString()}`;
    const streamKey = `cashout:${input.scope}:${input.liveChannel}`;
    if (activeCashoutLiveStreamKeys.has(streamKey)) {
      playerDebugLog('[PLAYER_SSE_DEDUPED]', {
        streamKey,
        scope: input.scope,
        uid: input.scope === 'all' ? null : input.uid,
        reason: 'cashout_live_stream_already_active',
      });
      return;
    }
    activeCashoutLiveStreamKeys.add(streamKey);
    activeLiveStreamKey = streamKey;
    const source = new EventSource(url);
    eventSource = source;

    source.addEventListener('ping', (ev: Event) => {
      const message = ev as MessageEvent<string>;
      handleLiveEvent('ping', String(message.data || ''), Number(message.lastEventId) || 0);
    });

    for (const eventName of CASHOUT_LIVE_EVENTS) {
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
      closeEventSource();
      scheduleImmediateRefetch('sse_error');
    };
  };

  const detachHiddenResume = attachHiddenTabPollResume('player_cashout_tasks', () => {
    scheduleImmediateRefetch('hidden_tab_resume');
  });
  const onActionRefetch = (event: Event) => {
    if (input.scope !== 'player') {
      return;
    }
    const detail = (event as CustomEvent<{ reason?: string }>).detail || {};
    scheduleImmediateRefetch(`action:${cleanText(detail.reason) || 'cashout'}`);
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('appbeg:player-cashout-refetch', onActionRefetch);
  }
  void runPoll('initial');
  connectEventSource();
  safetyRefetchStop = scheduleSafetyInterval({
    baseMs: SAFETY_REFETCH_MS,
    pollName: 'player_cashout_safety',
    onTick: () => {
      if (input.scope === 'player' && isDocumentHidden() && sharedStreamUnsubscribe) {
        logHiddenTabPollPaused('player_cashout_safety');
        return;
      }
      playerDebugLog('[CASHOUT_SAFETY_REFETCH]', {
        scope: input.scope,
        uid: input.scope === 'all' ? null : input.uid,
        streamHealthy: cashoutStreamHealthy,
      });
      scheduleImmediateRefetch('safety_interval');
    },
  });

  return () => {
    disposed = true;
    detachHiddenResume();
    if (typeof window !== 'undefined') {
      window.removeEventListener('appbeg:player-cashout-refetch', onActionRefetch);
    }
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    safetyRefetchStop?.();
    safetyRefetchStop = null;
    closeEventSource();
    sharedStreamHealthUnsubscribe?.();
    sharedStreamHealthUnsubscribe = null;
    sharedStreamUnsubscribe?.();
    sharedStreamUnsubscribe = null;
    cashoutStreamHealthy = false;
  };
}

export function attachStaffCashoutLifecyclePoll(input: {
  coadminUid: string;
  limit?: number;
  onPendingChange: (tasks: PlayerCashoutTask[]) => void;
  onActiveChange: (tasks: PlayerCashoutTask[]) => void;
  onCompletedChange: (tasks: PlayerCashoutTask[]) => void;
  onError?: (error: Error) => void;
}): { dispose: () => void; refetchNow: () => void } {
  return attachScopedCashoutLifecyclePoll({
    scope: 'staff',
    ...input,
  });
}

export function attachCoadminCashoutLifecyclePoll(input: {
  coadminUid: string;
  limit?: number;
  onPendingChange: (tasks: PlayerCashoutTask[]) => void;
  onActiveChange: (tasks: PlayerCashoutTask[]) => void;
  onCompletedChange: (tasks: PlayerCashoutTask[]) => void;
  onError?: (error: Error) => void;
}): { dispose: () => void; refetchNow: () => void } {
  return attachScopedCashoutLifecyclePoll({
    scope: 'coadmin',
    ...input,
  });
}

function attachScopedCashoutLifecyclePoll(input: {
  scope: 'staff' | 'coadmin';
  coadminUid: string;
  limit?: number;
  onPendingChange: (tasks: PlayerCashoutTask[]) => void;
  onActiveChange: (tasks: PlayerCashoutTask[]) => void;
  onCompletedChange: (tasks: PlayerCashoutTask[]) => void;
  onError?: (error: Error) => void;
}): { dispose: () => void; refetchNow: () => void } {
  const limit = input.limit || 50;
  let disposed = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let safetyRefetchStop: (() => void) | null = null;
  let eventSource: EventSource | null = null;
  let lastEventId = 0;
  let refetchInFlight = false;
  let refetchQueued = false;
  const liveChannel = coadminCashoutLiveChannel(input.coadminUid);

  const pollName = `${input.scope}_cashout_lifecycle`;

  const runPoll = async (reason: string) => {
    if (disposed) {
      return;
    }
    if (isDocumentHidden() && eventSource?.readyState === EventSource.OPEN) {
      logHiddenTabPollThrottled(pollName, HIDDEN_THROTTLED_POLL_MS);
      pollTimer = setTimeout(() => {
        void runPoll('hidden_throttled');
      }, HIDDEN_THROTTLED_POLL_MS);
      return;
    }
    if (refetchInFlight) {
      refetchQueued = true;
      return;
    }
    refetchInFlight = true;
    try {
      await withPlayerFetchLifecycleReason(reason, async () => {
      const combined = await fetchCashoutLifecycleTasks(
        input.scope,
        input.coadminUid,
        limit
      ).catch((error) => {
        console.warn('[CASHOUT_LIFECYCLE_FALLBACK]', {
          scope: input.scope,
          uid: input.coadminUid,
          reason: error instanceof Error ? error.message : String(error),
        });
        return null;
      });
      const [pending, active, completed] =
        combined
          ? [combined.pending, combined.active, combined.completed]
          : await Promise.all([
              fetchCashoutTasks(input.scope, input.coadminUid, limit, 'pending'),
              fetchCashoutTasks(input.scope, input.coadminUid, limit, 'active'),
              fetchCashoutTasks(input.scope, input.coadminUid, limit, 'completed'),
            ]);
      if (!disposed) {
        const sanitizedPending = sanitizePendingCashoutTasks(pending);
        input.onPendingChange(sanitizedPending);
        input.onActiveChange(active);
        input.onCompletedChange(completed);
        const loadedLog =
          input.scope === 'staff' ? '[STAFF_COMPLETED_TASKS] loaded' : '[COADMIN_COMPLETED_TASKS] loaded';
        playerDebugLog('[STAFF_CASHOUT_TASKS] pendingLoaded', {
          scope: input.scope,
          count: sanitizedPending.length,
          rawCount: pending.length,
          reason,
        });
        playerDebugLog('[STAFF_CASHOUT_TASKS] activeLoaded', { scope: input.scope, count: active.length, reason });
        playerDebugLog(loadedLog, { scope: input.scope, count: completed.length, reason });
      }
      });
    } catch (error) {
      if (!disposed) {
        input.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      refetchInFlight = false;
      if (!disposed && refetchQueued) {
        refetchQueued = false;
        void runPoll('queued');
        return;
      }
      if (!disposed) {
        pollTimer = setTimeout(() => {
          void runPoll('poll_interval');
        }, resolveVisiblePollIntervalMs(POLL_MS));
      }
    }
  };

  const refetchNow = (reason = 'manual') => {
    if (disposed) {
      return;
    }
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    void runPoll(reason);
  };

  const scheduleImmediateRefetch = (reason: string) => {
    if (disposed) {
      return;
    }
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    refetchNow(reason);
  };

  const closeEventSource = () => {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
  };

  const connectEventSource = () => {
    if (disposed) {
      return;
    }
    closeEventSource();
    const params = new URLSearchParams({
      channels: liveChannel,
      lastEventId: String(Math.max(0, lastEventId)),
    });
    const appSessionId = cleanText(getLocalAppSessionId());
    if (appSessionId) {
      params.set('appSessionId', appSessionId);
    }
    const source = new EventSource(`/api/live/stream?${params.toString()}`);
    eventSource = source;

    const handleLiveEvent = (eventName: string, rawData: string, outboxId: number) => {
      if (eventName === 'ping') {
        return;
      }
      if (outboxId > 0) {
        lastEventId = Math.max(lastEventId, outboxId);
      }
      try {
        const payload = JSON.parse(rawData) as Record<string, unknown>;
        logScopeEventReceived(input.scope, eventName, payload);
      } catch {
        // Ignore malformed SSE payloads; still refetch lists.
      }
      scheduleImmediateRefetch(`live:${eventName}`);
    };

    source.addEventListener('ping', (ev: Event) => {
      const message = ev as MessageEvent<string>;
      handleLiveEvent('ping', String(message.data || ''), Number(message.lastEventId) || 0);
    });

    for (const eventName of CASHOUT_LIVE_EVENTS) {
      source.addEventListener(eventName, (ev: Event) => {
        const message = ev as MessageEvent<string>;
        try {
          handleLiveEvent(
            eventName,
            String(message.data || ''),
            Number(message.lastEventId) || 0
          );
        } catch {
          scheduleImmediateRefetch(`live:${eventName}`);
        }
      });
    }

    source.onerror = () => {
      closeEventSource();
      scheduleImmediateRefetch('sse_error');
    };
  };

  const detachScopedHiddenResume = attachHiddenTabPollResume(pollName, () => {
    refetchNow('hidden_tab_resume');
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
      scheduleImmediateRefetch('safety_interval');
    },
  });

  const dispose = () => {
    disposed = true;
    detachScopedHiddenResume();
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    safetyRefetchStop?.();
    safetyRefetchStop = null;
    closeEventSource();
  };

  return { dispose, refetchNow };
}

export function attachPlayerCashoutTasksSqlPoll(input: {
  scope: CashoutScope;
  uid: string;
  limit?: number;
  onChange: (tasks: PlayerCashoutTask[]) => void;
  onError?: (error: Error) => void;
}) {
  const liveChannel =
    input.scope === 'coadmin' || input.scope === 'staff'
      ? coadminCashoutLiveChannel(input.uid)
      : input.scope === 'player'
        ? playerCashoutLiveChannel(input.uid)
        : null;

  return attachCashoutSqlPoll({
    ...input,
    liveChannel,
  });
}

export function isPlayerCashoutSqlReadEnabled() {
  return isClientSqlReadMode();
}
