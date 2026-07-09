import {
  type CarerTask,
  type CarerTaskStatus,
  getEffectiveCarerTaskStatus,
  getVisibleTaskForCarer,
} from '@/features/games/carerTasks';
import { logCarerPageStartup, markCarerPageStartupStreamConnected } from '@/features/carer/carerStartupLogs';
import { getLocalAppSessionId } from '@/features/auth/appSession';
import { getSqlApiReadHeaders } from '@/lib/client/sqlApiHeaders';
import {
  buildLiveSnapshotPath,
  parseLiveSnapshotResponse,
} from '@/lib/client/liveSnapshotFetch';
import {
  buildCarerTaskStreamKey,
  createLiveStreamClientInstanceId,
  getLiveStreamClientRecentReleaseDelayMs,
  LIVE_STREAM_CLIENT_CLEANUP_DELAY_MS,
  logLiveStreamClientConnect,
  logLiveStreamClientDisconnect,
  logLiveStreamClientReconnect,
  registerLiveStreamClientOwner,
  releaseLiveStreamClientOwner,
} from '@/lib/client/liveStreamClientRegistry';
import {
  reconnectRecoveryDelayMs,
  scheduleSafetyInterval,
  visibilityRefetchDelayMs,
  waitMs,
} from '@/lib/client/snapshotPollJitter';
import { isPublicCarerTasksSqlReadEnabled } from '@/lib/client/sqlPublicFlags';
import {
  type CarerTaskFastDispatchSignal,
  shouldFastDispatchForCarerTaskLiveEvent,
} from '@/features/live/carerTaskFastDispatch';

export const CARER_TASKS_SQL_READ_ENABLED = isPublicCarerTasksSqlReadEnabled();

export type CarerTaskSqlReadListenerOptions = {
  onFastDispatchSignal?: (signal: CarerTaskFastDispatchSignal) => void;
};

type SqlSnapshotTask = {
  id?: string;
  taskId?: string;
  coadminUid?: string;
  playerUid?: string;
  type?: string;
  status?: string;
  automationStatus?: string | null;
  gameName?: string;
  amount?: number | null;
  requestId?: string | null;
  assignedCarerUid?: string | null;
  assignedCarerUsername?: string | null;
  claimedByUid?: string | null;
  claimedByUsername?: string | null;
  createdAt?: string | null;
  claimedAt?: string | null;
  startedAt?: string | null;
  updatedAt?: string | null;
  completedAt?: string | null;
  completedByCarerUid?: string | null;
  completedByCarerUsername?: string | null;
};

type SqlSnapshotResponse = {
  tasks?: SqlSnapshotTask[];
  latestOutboxId?: number;
  source?: string;
};

type SqlTaskPayload = {
  entityId?: unknown;
  taskId?: unknown;
  coadminUid?: unknown;
  assignedCarerUid?: unknown;
  claimedByUid?: unknown;
  playerUid?: unknown;
  type?: unknown;
  status?: unknown;
  automationStatus?: unknown;
  gameName?: unknown;
  amount?: unknown;
  requestId?: unknown;
  updatedAt?: unknown;
  claimedAt?: unknown;
  startedAt?: unknown;
  completedAt?: unknown;
};

function cleanText(value: unknown) {
  return String(value || '').trim();
}

function carerTaskLiveChannel(carerUid: string) {
  return `carer:${cleanText(carerUid)}:tasks`;
}

function coadminTaskLiveChannel(coadminUid: string) {
  return `coadmin:${cleanText(coadminUid)}:tasks`;
}

const CARER_TASK_UPSERT_EVENTS = new Set([
  'task.upserted',
  'task.returned_to_pending',
  'task.claimed',
  'recharge_task_create',
  'redeem_task_create',
  'recharge_create',
  'redeem_create',
  'game_request_task_complete',
]);

const GAME_REQUEST_CREATE_EVENTS = new Set(['recharge_create', 'redeem_create']);

const CARER_TASK_REMOVE_EVENTS = new Set([
  'task.tombstoned',
  'task.deleted_from_pending',
  'recharge_task_dismiss',
  'redeem_task_dismiss',
]);

const CARER_TASK_IMMEDIATE_REFETCH_EVENTS = new Set([
  'task.dismissed',
  'job.dismissed',
  'task.completed',
  'job.completed',
  'request.completed',
  'game_request_task_complete',
  'game_request_complete',
  'recharge_completed',
  'redeem_completed',
  'recharge_dismiss',
  'redeem_dismiss',
  'request.dismissed',
]);

const ALL_LIVE_TASK_SSE_EVENTS = Array.from(
  new Set([
    ...CARER_TASK_UPSERT_EVENTS,
    ...CARER_TASK_REMOVE_EVENTS,
    ...GAME_REQUEST_CREATE_EVENTS,
    ...CARER_TASK_IMMEDIATE_REFETCH_EVENTS,
    'task.upserted',
  ])
);

const SAFETY_REFETCH_MS = 45_000;
const STALL_TIMEOUT_MS = 90_000;
const INITIAL_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 30_000;
const LIVE_REFETCH_DEBOUNCE_MS = 120;

function normalizeTaskType(value: unknown): CarerTask['type'] {
  const normalized = cleanText(value).toLowerCase();
  if (normalized === 'redeem') return 'redeem';
  if (normalized === 'recharge') return 'recharge';
  if (normalized === 'reset_password') return 'reset_password';
  if (normalized === 'recreate_username') return 'recreate_username';
  if (normalized === 'create_game_username') return 'create_game_username';
  return (normalized || 'recharge') as CarerTask['type'];
}

function requestLinkedCarerTaskId(requestId: string) {
  const cleanRequestId = cleanText(requestId);
  if (!cleanRequestId) return '';
  return cleanRequestId.startsWith('request__')
    ? cleanRequestId
    : `request__${cleanRequestId}`;
}

function resolveCarerTaskIdFromEvent(
  event: string,
  payload: SqlTaskPayload,
  rawEntityId: string
): string {
  const explicitTaskId = cleanText(payload.taskId);
  if (explicitTaskId) {
    return explicitTaskId;
  }
  const requestId = cleanText(payload.requestId);
  if (GAME_REQUEST_CREATE_EVENTS.has(event)) {
    return requestLinkedCarerTaskId(requestId || rawEntityId);
  }
  if (requestId && !rawEntityId.startsWith('request__')) {
    return requestLinkedCarerTaskId(requestId);
  }
  return rawEntityId;
}

function enrichPayloadForSseEvent(
  event: string,
  payload: SqlTaskPayload,
  fallbackCoadminUid: string
): SqlTaskPayload {
  const enriched: SqlTaskPayload = { ...payload };
  if (!cleanText(enriched.coadminUid)) {
    enriched.coadminUid = fallbackCoadminUid;
  }
  if (!cleanText(enriched.type)) {
    if (
      event === 'recharge_task_create' ||
      event === 'recharge_create'
    ) {
      enriched.type = 'recharge';
    } else if (
      event === 'redeem_task_create' ||
      event === 'redeem_create'
    ) {
      enriched.type = 'redeem';
    }
  } else {
    enriched.type = normalizeTaskType(enriched.type);
  }
  if (GAME_REQUEST_CREATE_EVENTS.has(event) && !cleanText(enriched.status)) {
    enriched.status = 'pending';
  }
  if (event === 'game_request_task_complete') {
    enriched.status = 'completed';
  }
  const taskId = resolveCarerTaskIdFromEvent(event, enriched, cleanText(enriched.entityId || enriched.taskId));
  if (taskId) {
    enriched.entityId = taskId;
    enriched.taskId = taskId;
  }
  return enriched;
}

function isoToTimestamp(iso: string | null | undefined): Date | null {
  if (!iso) {
    return null;
  }
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    return null;
  }
  return new Date(ms);
}

function toDateMs(value: unknown) {
  if (!value) {
    return 0;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  const maybe = value as { toMillis?: () => number; toDate?: () => Date; seconds?: number };
  if (typeof maybe.toMillis === 'function') {
    return maybe.toMillis();
  }
  if (typeof maybe.toDate === 'function') {
    return maybe.toDate().getTime();
  }
  if (typeof maybe.seconds === 'number') {
    return maybe.seconds * 1000;
  }
  return 0;
}

function normalizeCarerTaskStatus(status: unknown): CarerTaskStatus {
  const normalized = cleanText(status).toLowerCase();
  if (
    normalized === 'pending' ||
    normalized === 'in_progress' ||
    normalized === 'completed' ||
    normalized === 'failed' ||
    normalized === 'urgent'
  ) {
    return normalized;
  }
  return 'pending';
}

function isSqlEventVisibleToCarer(
  payload: SqlTaskPayload,
  carerUid: string,
  coadminUid: string
) {
  const payloadCoadminUid = cleanText(payload.coadminUid);
  if (payloadCoadminUid && payloadCoadminUid !== coadminUid) {
    return false;
  }

  const assignedCarerUid =
    cleanText(payload.assignedCarerUid) || cleanText(payload.claimedByUid);
  if (assignedCarerUid && assignedCarerUid !== carerUid) {
    return false;
  }

  return true;
}

function mapSnapshotRowToCarerTask(row: SqlSnapshotTask, fallbackCoadminUid: string): CarerTask {
  const id = cleanText(row.id || row.taskId);
  return {
    id,
    coadminUid: cleanText(row.coadminUid) || fallbackCoadminUid,
    type: normalizeTaskType(row.type || 'recharge'),
    playerUid: cleanText(row.playerUid),
    playerUsername: 'Player',
    gameName: cleanText(row.gameName) || 'Unknown Game',
    amount: Number.isFinite(Number(row.amount)) ? Number(row.amount) : null,
    requestId: cleanText(row.requestId) || null,
    status: normalizeCarerTaskStatus(row.status),
    assignedCarerUid: cleanText(row.assignedCarerUid) || null,
    assignedCarerUsername: cleanText(row.assignedCarerUsername) || null,
    claimedByUid: cleanText(row.claimedByUid) || null,
    claimedByUsername: cleanText(row.claimedByUsername) || null,
    automationStatus: (cleanText(row.automationStatus) || null) as CarerTask['automationStatus'],
    createdAt: isoToTimestamp(row.createdAt),
    claimedAt: isoToTimestamp(row.claimedAt),
    startedAt: isoToTimestamp(row.startedAt),
    completedAt: isoToTimestamp(row.completedAt),
    completedByCarerUid: cleanText(row.completedByCarerUid) || null,
    completedByCarerUsername: cleanText(row.completedByCarerUsername) || null,
  };
}

function sortTasksByNewest(tasks: CarerTask[]) {
  return [...tasks].sort((left, right) => {
    const leftTime =
      toDateMs(left.completedAt) ||
      toDateMs(left.createdAt);
    const rightTime =
      toDateMs(right.completedAt) ||
      toDateMs(right.createdAt);
    return rightTime - leftTime;
  });
}

export function attachCarerTaskSqlReadListener(
  carerUid: string,
  coadminUid: string,
  onTasksChange: (tasks: CarerTask[]) => void,
  onFallback: (reason: string) => void,
  options?: CarerTaskSqlReadListenerOptions
) {
  const onFastDispatchSignal = options?.onFastDispatchSignal;
  const cleanCarerUid = cleanText(carerUid);
  const cleanCoadminUid = cleanText(coadminUid);
  const instanceId = createLiveStreamClientInstanceId('carer_tasks');
  const streamKey = buildCarerTaskStreamKey(cleanCarerUid, cleanCoadminUid);
  let lastEventId = 0;
  let eventSource: EventSource | null = null;
  let connectGeneration = 0;
  let streamLoopPromise: Promise<void> | null = null;
  let disposed = false;
  let fellBack = false;
  let refetchTimer: ReturnType<typeof setTimeout> | null = null;
  let refetchInFlight = false;
  let queuedRefetchReason: string | null = null;
  let recoveryForceFullUsed = false;
  let initialSnapshotLoaded = false;
  let lastSnapshotOutboxId = 0;
  let reconnectAttempt = 0;
  let reconnectBackoffMs = INITIAL_RECONNECT_MS;
  let lastSseActivityAt = Date.now();
  let safetyRefetchStop: (() => void) | null = null;
  let stallWatchTimer: ReturnType<typeof setInterval> | null = null;
  let streamConnectResolve: (() => void) | null = null;
  const tasksById = new Map<string, CarerTask>();
  const streamChannels = [
    carerTaskLiveChannel(cleanCarerUid),
    coadminTaskLiveChannel(cleanCoadminUid),
  ];

  const forceDisposeFromRegistry = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    stopMaintenanceTimers();
    if (refetchTimer) {
      clearTimeout(refetchTimer);
      refetchTimer = null;
    }
    closeEventSource('superseded');
    releaseLiveStreamClientOwner({
      streamType: 'carer_tasks',
      streamKey,
      instanceId,
      reason: 'superseded',
    });
    tasksById.clear();
  };

  registerLiveStreamClientOwner({
    streamType: 'carer_tasks',
    streamKey,
    instanceId,
    reason: 'attach',
    supersede: forceDisposeFromRegistry,
  });

  const emitTasks = (reason = 'live_merge') => {
    if (fellBack || disposed) {
      return;
    }
    const nextTasks = sortTasksByNewest(Array.from(tasksById.values()));
    console.info('[CARER_TASKS_STATE_UPDATED]', {
      reason,
      count: nextTasks.length,
      latestOutboxId: lastSnapshotOutboxId,
      pendingCount: nextTasks.filter((task) => cleanText(task.status).toLowerCase() === 'pending')
        .length,
      inProgressCount: nextTasks.filter(
        (task) => cleanText(task.status).toLowerCase() === 'in_progress'
      ).length,
    });
    onTasksChange(nextTasks);
  };

  const shouldRefetchForLiveEvent = (event: string, entityType: string) => {
    if (entityType === 'carer_task') {
      return true;
    }
    if (entityType === 'player_game_request') {
      return (
        CARER_TASK_UPSERT_EVENTS.has(event) ||
        GAME_REQUEST_CREATE_EVENTS.has(event) ||
        CARER_TASK_REMOVE_EVENTS.has(event)
      );
    }
    return (
      CARER_TASK_UPSERT_EVENTS.has(event) ||
      GAME_REQUEST_CREATE_EVENTS.has(event) ||
      CARER_TASK_REMOVE_EVENTS.has(event)
    );
  };

  const shouldForceFullSnapshot = (reason: string) => {
    if (!initialSnapshotLoaded && reason === 'bootstrap') {
      return true;
    }
    const recoveryReason =
      reason === 'visibility' ||
      reason === 'stall_timeout' ||
      reason === 'sse_error' ||
      /^reconnect_attempt_/i.test(reason);
    if (recoveryReason && !recoveryForceFullUsed) {
      recoveryForceFullUsed = true;
      return true;
    }
    return false;
  };

  const logCursorUpdate = (previousLatestOutboxId: number, newLatestOutboxId: number) => {
    if (newLatestOutboxId === previousLatestOutboxId) {
      return;
    }
    console.info('[CARER_TASK_SNAPSHOT_CURSOR_UPDATED]', {
      previousLatestOutboxId,
      newLatestOutboxId,
    });
  };

  const updateSnapshotCursor = (nextOutboxId: number) => {
    const normalizedNextOutboxId = Math.max(0, Number(nextOutboxId || 0));
    const previousLatestOutboxId = lastSnapshotOutboxId;
    lastSnapshotOutboxId = Math.max(lastSnapshotOutboxId, normalizedNextOutboxId);
    lastEventId = Math.max(lastEventId, lastSnapshotOutboxId);
    logCursorUpdate(previousLatestOutboxId, lastSnapshotOutboxId);
  };

  const queueRefetchAfterInFlight = (reason: string) => {
    queuedRefetchReason = queuedRefetchReason || reason;
    console.info('[CARER_TASK_SNAPSHOT_SKIP]', {
      reason,
      skipReason: 'request_in_flight_queued',
      queuedReason: queuedRefetchReason,
    });
  };

  const flushQueuedRefetch = () => {
    if (fellBack || disposed || refetchInFlight || refetchTimer || !queuedRefetchReason) {
      return;
    }
    const reason = queuedRefetchReason;
    queuedRefetchReason = null;
    scheduleLiveRefetch(reason);
  };

  const loadSnapshot = async (
    headers: Record<string, string>,
    reason: string
  ): Promise<boolean> => {
    const snapshotStartedAt = Date.now();
    console.info('[CARER_TASKS_LIVE_REFETCH_START]', {
      reason,
      carerUid: cleanCarerUid,
      coadminUid: cleanCoadminUid,
      lastEventId,
      latestSnapshotOutboxId: lastSnapshotOutboxId,
    });
    const requireFull = shouldForceFullSnapshot(reason);
    console.info('[CARER_TASK_SNAPSHOT_REQUEST]', {
      forceFull: requireFull,
      latestOutboxId: requireFull ? null : lastSnapshotOutboxId,
      reason,
    });
    const snapshotPath = buildLiveSnapshotPath(
      `/api/live/snapshot/carer/${encodeURIComponent(cleanCarerUid)}/tasks`,
      {
        latestOutboxId: lastSnapshotOutboxId,
        requireFull,
      }
    );
    const snapshotHeaders = {
      ...headers,
      ...(!requireFull ? { 'If-None-Match': `"${lastSnapshotOutboxId}"` } : {}),
    };
    const snapshotResponse = await fetch(snapshotPath, {
      headers: snapshotHeaders,
      cache: 'no-store',
    });
    const parsed = await parseLiveSnapshotResponse<SqlSnapshotResponse>(snapshotResponse);
    if (parsed.unchanged) {
      const unchangedOutboxId = Number(parsed.snapshot?.latestOutboxId ?? lastSnapshotOutboxId);
      updateSnapshotCursor(unchangedOutboxId);
      console.info('[CARER_TASKS_LIVE_REFETCH_RESULT]', {
        reason,
        ok: true,
        unchanged: true,
        count: tasksById.size,
        latestOutboxId: lastSnapshotOutboxId,
      });
      console.info('[CARER_SNAPSHOT_REFRESH]', {
        reason,
        ok: true,
        unchanged: true,
        count: tasksById.size,
        latestOutboxId: lastSnapshotOutboxId,
        durationMs: Date.now() - snapshotStartedAt,
      });
      return true;
    }
    const snapshot = parsed.snapshot;
    if (!snapshot) {
      console.info('[CARER_TASKS_LIVE_REFETCH_RESULT]', {
        reason,
        ok: false,
        status: snapshotResponse.status,
      });
      return false;
    }
    const source = cleanText(snapshot.source);
    const ok =
      snapshotResponse.ok &&
      source !== 'postgres_snapshot_failed' &&
      source !== 'postgres_snapshot_unavailable';
    const rows = Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
    console.info('[CARER_TASKS_LIVE_REFETCH_RESULT]', {
      reason,
      ok,
      status: snapshotResponse.status,
      count: rows.length,
      latestOutboxId: Number(snapshot.latestOutboxId || 0),
      source: source || 'unknown',
    });
    console.info('[CARER_SNAPSHOT_REFRESH]', {
      reason,
      ok,
      status: snapshotResponse.status,
      count: rows.length,
      latestOutboxId: Number(snapshot.latestOutboxId || 0),
      source: source || 'unknown',
      durationMs: Date.now() - snapshotStartedAt,
    });
    if (!ok) {
      return false;
    }
    updateSnapshotCursor(Number(snapshot.latestOutboxId || 0));
    tasksById.clear();
    for (const row of rows) {
      const mapped = mapSnapshotRowToCarerTask(row, cleanCoadminUid);
      if (!mapped.id) {
        continue;
      }
      applyVisibleTask(mapped, reason);
    }
    initialSnapshotLoaded = true;
    emitTasks(reason);
    return true;
  };

  const refetchSnapshotNow = async (
    reason: string,
    priority = false
  ): Promise<boolean> => {
    if (fellBack || disposed) {
      console.info('[CARER_TASK_SNAPSHOT_SKIP]', {
        reason,
        skipReason: disposed ? 'disposed' : 'fallback_active',
      });
      return false;
    }
    if (refetchTimer) {
      clearTimeout(refetchTimer);
      refetchTimer = null;
    }
    if (refetchInFlight) {
      console.info('[CARER_TASK_SNAPSHOT_SKIP]', {
        reason,
        skipReason: 'request_in_flight',
        priority,
      });
      return false;
    }
    refetchInFlight = true;
    try {
      const headers = await getSqlApiReadHeaders(false);
      return await loadSnapshot(headers, reason);
    } catch (error) {
      console.info('[CARER_TASKS_LIVE_REFETCH_RESULT]', {
        reason,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      refetchInFlight = false;
      flushQueuedRefetch();
    }
  };

  const scheduleLiveRefetch = (reason: string) => {
    if (fellBack || disposed) {
      console.info('[CARER_TASK_SNAPSHOT_SKIP]', {
        reason,
        skipReason: disposed ? 'disposed' : 'fallback_active',
      });
      return;
    }
    if (refetchInFlight) {
      queueRefetchAfterInFlight(reason);
      return;
    }
    if (refetchTimer) {
      console.info('[CARER_TASK_SNAPSHOT_SKIP]', {
        reason,
        skipReason: 'debounce_coalesced',
      });
      return;
    }
    refetchTimer = setTimeout(() => {
      refetchTimer = null;
      if (fellBack || disposed || refetchInFlight) {
        console.info('[CARER_TASK_SNAPSHOT_SKIP]', {
          reason,
          skipReason: disposed
            ? 'disposed'
            : fellBack
              ? 'fallback_active'
              : 'request_in_flight',
        });
        return;
      }
      refetchInFlight = true;
      void (async () => {
        try {
          const headers = await getSqlApiReadHeaders(false);
          await loadSnapshot(headers, reason);
        } catch (error) {
          console.info('[CARER_TASKS_LIVE_REFETCH_RESULT]', {
            reason,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          refetchInFlight = false;
          flushQueuedRefetch();
        }
      })();
    }, LIVE_REFETCH_DEBOUNCE_MS);
  };

  const applyVisibleTask = (task: CarerTask, mergeReason: string) => {
    const normalizedStatus = cleanText(task.status).toLowerCase();
    const hadTask = tasksById.has(task.id);
    const previousStatus = hadTask
      ? getEffectiveCarerTaskStatus(tasksById.get(task.id)!)
      : null;

    if (normalizedStatus === 'deleted') {
      tasksById.delete(task.id);
      console.info('[CARER_TASK_LIVE_MERGE]', {
        taskId: task.id,
        status: task.status,
        assignedCarerUid: task.assignedCarerUid || null,
        addedToPending: false,
        addedToInProgress: false,
        removed: true,
        reason: mergeReason || 'status_deleted',
      });
      return;
    }

    const visible = getVisibleTaskForCarer(task, cleanCarerUid);
    const effectiveStatus = visible
      ? getEffectiveCarerTaskStatus(visible)
      : getEffectiveCarerTaskStatus(task);
    const pendingSection = effectiveStatus === 'pending';
    const mineSection = effectiveStatus === 'in_progress';
    const completedSection = effectiveStatus === 'completed';

    console.info('[CARER_TASK_VISIBILITY_FILTER]', {
      taskId: task.id,
      taskType: task.type,
      status: task.status,
      assignedCarerUid: task.assignedCarerUid || null,
      coadminUid: task.coadminUid || cleanCoadminUid,
      deletedAt: null,
      included: Boolean(visible),
      section: visible
        ? pendingSection
          ? 'pending'
          : mineSection
            ? 'mine'
            : completedSection
              ? 'completed'
              : 'other'
        : null,
      reason: visible ? mergeReason : mergeReason || 'not_visible_to_carer',
    });

    if (!visible) {
      tasksById.delete(task.id);
      console.info('[CARER_TASK_LIVE_MERGE]', {
        taskId: task.id,
        status: task.status,
        assignedCarerUid: task.assignedCarerUid || null,
        addedToPending: false,
        addedToInProgress: false,
        removed: hadTask,
        reason: mergeReason || 'not_visible_to_carer',
      });
      return;
    }
    const addedToPending =
      effectiveStatus === 'pending' && (!hadTask || previousStatus !== 'pending');
    const addedToInProgress =
      effectiveStatus === 'in_progress' &&
      (!hadTask || previousStatus !== 'in_progress');

    tasksById.set(task.id, visible);
    console.info('[CARER_TASK_LIVE_MERGE]', {
      taskId: task.id,
      status: visible.status,
      assignedCarerUid: visible.assignedCarerUid || null,
      addedToPending,
      addedToInProgress,
      removed: false,
      reason: mergeReason,
    });
  };

  const buildStreamUrl = () => {
    const appSessionId = cleanText(getLocalAppSessionId());
    const params = new URLSearchParams({
      channels: streamChannels.join(','),
      lastEventId: String(Math.max(0, lastEventId)),
    });
    if (appSessionId) {
      params.set('appSessionId', appSessionId);
    }
    return `/api/live/stream?${params.toString()}`;
  };

  const closeEventSource = (reason: string) => {
    connectGeneration += 1;
    if (!eventSource) {
      return;
    }
    const closingSource = eventSource;
    const readyState = closingSource.readyState;
    closingSource.onopen = null;
    closingSource.onerror = null;
    closingSource.onmessage = null;
    closingSource.close();
    eventSource = null;
    logLiveStreamClientDisconnect({
      streamType: 'carer_tasks',
      streamKey,
      instanceId,
      reason,
    });
    console.info('[CARER_LIVE_STREAM_RECONNECT]', {
      phase: 'close',
      reason,
      readyState,
      carerUid: cleanCarerUid,
      coadminUid: cleanCoadminUid,
      lastEventId,
      instanceId,
    });
    streamConnectResolve?.();
    streamConnectResolve = null;
  };

  const connectEventSource = async (connectReason: string) => {
    if (disposed || fellBack) {
      return;
    }

    closeEventSource('replace_existing');
    await waitMs(
      Math.max(LIVE_STREAM_CLIENT_CLEANUP_DELAY_MS, getLiveStreamClientRecentReleaseDelayMs(streamKey))
    );
    if (disposed || fellBack) {
      return;
    }

    if (disposed || fellBack) {
      return;
    }

    connectGeneration += 1;
    const generation = connectGeneration;

    await new Promise<void>((resolve) => {
      if (disposed || fellBack || generation !== connectGeneration) {
        resolve();
        return;
      }

      streamConnectResolve = resolve;

      const url = buildStreamUrl();
      logLiveStreamClientConnect({
        streamType: 'carer_tasks',
        instanceId,
        reason: connectReason,
        streamKey,
      });
      console.info('[CARER_TASK_STREAM_SUBSCRIPTIONS]', {
        carerUid: cleanCarerUid,
        coadminUid: cleanCoadminUid,
        channels: streamChannels,
        lastEventId,
        url,
        instanceId,
      });

      const source = new EventSource(url);
      eventSource = source;

      source.onopen = () => {
        if (disposed || fellBack || generation !== connectGeneration || eventSource !== source) {
          return;
        }
        lastSseActivityAt = Date.now();
        reconnectAttempt = 0;
        reconnectBackoffMs = INITIAL_RECONNECT_MS;
        console.info('[CARER_LIVE_STREAM_OPEN]', {
          carerUid: cleanCarerUid,
          coadminUid: cleanCoadminUid,
          channels: streamChannels,
          lastEventId,
          readyState: source.readyState,
          instanceId,
        });
        markCarerPageStartupStreamConnected('carer_tasks');
      };

      source.addEventListener('ping', (ev: Event) => {
        if (disposed || fellBack || generation !== connectGeneration || eventSource !== source) {
          return;
        }
        const message = ev as MessageEvent<string>;
        handleStreamMessage('ping', String(message.data || ''), Number(message.lastEventId) || 0);
      });

      for (const eventName of ALL_LIVE_TASK_SSE_EVENTS) {
        source.addEventListener(eventName, (ev: Event) => {
          if (disposed || fellBack || generation !== connectGeneration || eventSource !== source) {
            return;
          }
          const message = ev as MessageEvent<string>;
          handleStreamMessage(
            eventName,
            String(message.data || ''),
            Number(message.lastEventId) || 0
          );
        });
      }

      source.onmessage = (ev: MessageEvent<string>) => {
        if (disposed || fellBack || generation !== connectGeneration || eventSource !== source) {
          return;
        }
        handleStreamMessage('message', String(ev.data || ''), Number(ev.lastEventId) || 0);
      };

      source.onerror = () => {
        if (generation !== connectGeneration || eventSource !== source) {
          return;
        }
        console.info('[CARER_LIVE_STREAM_ERROR]', {
          carerUid: cleanCarerUid,
          coadminUid: cleanCoadminUid,
          readyState: source.readyState,
          lastEventId,
          idleMs: Date.now() - lastSseActivityAt,
          instanceId,
        });
        closeEventSource('sse_error');
        void refetchSnapshotNow('sse_error', true).finally(() => {
          resolve();
        });
      };
    });
  };

  const handleStreamMessage = (eventName: string, rawData: string, outboxId: number) => {
    lastSseActivityAt = Date.now();

    if (eventName === 'ping') {
      let pingPayload: Record<string, unknown> = {};
      try {
        pingPayload = JSON.parse(rawData) as Record<string, unknown>;
      } catch {
        pingPayload = {};
      }
      console.info('[CARER_LIVE_STREAM_PING]', {
        carerUid: cleanCarerUid,
        coadminUid: cleanCoadminUid,
        lastEventId,
        now: pingPayload.now || null,
        channels: pingPayload.channels || streamChannels,
      });
      return;
    }

    let payload: SqlTaskPayload = {};
    try {
      payload = JSON.parse(rawData) as SqlTaskPayload;
    } catch {
      return;
    }

    const entityId = cleanText(payload.entityId || payload.taskId);
    console.info('[CARER_LIVE_STREAM_EVENT]', {
      outboxId,
      eventType: eventName,
      entityId: entityId || null,
      carerUid: cleanCarerUid,
      coadminUid: cleanCoadminUid,
    });
    console.info('[CARER_SSE_EVENT_RECEIVED]', {
      outboxId,
      eventType: eventName,
      entityId: entityId || null,
      taskId: cleanText(payload.taskId) || null,
      carerUid: cleanCarerUid,
      coadminUid: cleanCoadminUid,
    });

    if (outboxId > 0) {
      lastEventId = Math.max(lastEventId, outboxId);
    }

    const enrichedPayload = enrichPayloadForSseEvent(eventName, payload, cleanCoadminUid);
    const taskId = entityId
      ? resolveCarerTaskIdFromEvent(eventName, enrichedPayload, entityId)
      : '';
    const entityType =
      eventName.startsWith('task.') || eventName.endsWith('_task_create')
        ? 'carer_task'
        : GAME_REQUEST_CREATE_EVENTS.has(eventName)
          ? 'player_game_request'
          : 'live_event';

    if (eventName === 'task.completed') {
      console.info('[CARER_TASK_COMPLETED_EVENT]', {
        taskId: taskId || entityId || null,
        carerUid: cleanCarerUid,
        coadminUid: cleanCoadminUid,
        outboxId,
      });
    }

    if (
      onFastDispatchSignal &&
      shouldFastDispatchForCarerTaskLiveEvent(eventName, enrichedPayload) &&
      isSqlEventVisibleToCarer(enrichedPayload, cleanCarerUid, cleanCoadminUid)
    ) {
      onFastDispatchSignal({
        eventName,
        taskId: taskId || entityId || '',
        outboxId,
        receivedAt: Date.now(),
      });
    }

    if (shouldRefetchForLiveEvent(eventName, entityType)) {
      scheduleLiveRefetch(`live_event:${eventName}`);
    } else if (CARER_TASK_IMMEDIATE_REFETCH_EVENTS.has(eventName)) {
      scheduleLiveRefetch(`live_event:${eventName}`);
    }

    if (!entityId || !taskId) {
      return;
    }

    const visibleToCarer = isSqlEventVisibleToCarer(enrichedPayload, cleanCarerUid, cleanCoadminUid);
    const upsertLike =
      CARER_TASK_UPSERT_EVENTS.has(eventName) || GAME_REQUEST_CREATE_EVENTS.has(eventName);
    const removeLike = CARER_TASK_REMOVE_EVENTS.has(eventName);
    const accepted = visibleToCarer && (upsertLike || removeLike);

    if (!visibleToCarer || !accepted) {
      return;
    }

    if (removeLike) {
      tasksById.delete(taskId);
      emitTasks(`live_event:${eventName}`);
    }
  };

  const runSafetyRefetch = () => {
    if (disposed || fellBack) {
      return;
    }
    console.info('[CARER_TASKS_SAFETY_REFETCH]', {
      carerUid: cleanCarerUid,
      coadminUid: cleanCoadminUid,
      lastEventId,
      latestSnapshotOutboxId: lastSnapshotOutboxId,
      idleMs: Date.now() - lastSseActivityAt,
    });
    if (eventSource && Date.now() - lastSseActivityAt < STALL_TIMEOUT_MS) {
      console.info('[CARER_TASK_SNAPSHOT_SKIP]', {
        reason: 'safety_interval',
        skipReason: 'sse_healthy',
        idleMs: Date.now() - lastSseActivityAt,
      });
      return;
    }
    void refetchSnapshotNow('safety_interval', true);
  };

  const checkStreamStall = () => {
    if (disposed || fellBack || !eventSource) {
      return;
    }
    const idleMs = Date.now() - lastSseActivityAt;
    if (idleMs < STALL_TIMEOUT_MS) {
      return;
    }
    console.info('[CARER_LIVE_STREAM_ERROR]', {
      carerUid: cleanCarerUid,
      coadminUid: cleanCoadminUid,
      reason: 'stall_timeout',
      idleMs,
      lastEventId,
    });
    closeEventSource('stall_timeout');
    void refetchSnapshotNow('stall_timeout', true).then(() => {
      console.info('[CARER_LIVE_STREAM_RECONNECT]', {
        phase: 'stall_recovery',
        carerUid: cleanCarerUid,
        coadminUid: cleanCoadminUid,
        lastEventId,
      });
    });
  };

  const handleVisibilityRefresh = () => {
    if (disposed || fellBack || document.visibilityState !== 'visible') {
      return;
    }
    console.info('[CARER_TASKS_VISIBILITY_REFETCH]', {
      carerUid: cleanCarerUid,
      coadminUid: cleanCoadminUid,
      lastEventId,
      latestSnapshotOutboxId: lastSnapshotOutboxId,
    });
    reconnectAttempt = 0;
    reconnectBackoffMs = INITIAL_RECONNECT_MS;
    closeEventSource('visibility_refresh');
    void (async () => {
      await waitMs(visibilityRefetchDelayMs());
      if (disposed || fellBack) {
        return;
      }
      void refetchSnapshotNow('visibility', true).then(() => {
        console.info('[CARER_LIVE_STREAM_RECONNECT]', {
          phase: 'visibility',
          carerUid: cleanCarerUid,
          coadminUid: cleanCoadminUid,
          lastEventId,
          latestSnapshotOutboxId: lastSnapshotOutboxId,
        });
      });
    })();
  };

  const runLiveStreamLoop = async () => {
    while (!disposed && !fellBack) {
      const connectReason =
        reconnectAttempt === 0 ? 'bootstrap' : `reconnect_attempt_${reconnectAttempt}`;
      if (reconnectAttempt > 0) {
        logLiveStreamClientReconnect({
          streamType: 'carer_tasks',
          instanceId,
          reason: connectReason,
          streamKey,
          extra: {
            backoffMs: reconnectBackoffMs,
            carerUid: cleanCarerUid,
            coadminUid: cleanCoadminUid,
            lastEventId,
          },
        });
      }
      await connectEventSource(connectReason);
      if (disposed || fellBack) {
        break;
      }
      reconnectAttempt += 1;
      console.info('[CARER_LIVE_STREAM_RECONNECT]', {
        phase: 'backoff',
        attempt: reconnectAttempt,
        backoffMs: reconnectBackoffMs,
        carerUid: cleanCarerUid,
        coadminUid: cleanCoadminUid,
        lastEventId,
        instanceId,
      });
      await new Promise((resolve) => setTimeout(resolve, reconnectBackoffMs));
      reconnectBackoffMs = Math.min(reconnectBackoffMs * 2, MAX_RECONNECT_MS);
      await waitMs(reconnectRecoveryDelayMs());
      await refetchSnapshotNow(`reconnect_attempt_${reconnectAttempt}`, true);
    }
  };

  const startLiveStreamLoop = () => {
    if (streamLoopPromise) {
      return;
    }
    streamLoopPromise = runLiveStreamLoop().finally(() => {
      streamLoopPromise = null;
    });
  };

  const startMaintenanceTimers = () => {
    if (typeof window === 'undefined') {
      return;
    }
    safetyRefetchStop = scheduleSafetyInterval({
      baseMs: SAFETY_REFETCH_MS,
      pollName: 'carer_task_snapshot_safety',
      onTick: runSafetyRefetch,
    });
    stallWatchTimer = setInterval(checkStreamStall, 15_000);
    document.addEventListener('visibilitychange', handleVisibilityRefresh);
    window.addEventListener('focus', handleVisibilityRefresh);
  };

  const stopMaintenanceTimers = () => {
    safetyRefetchStop?.();
    safetyRefetchStop = null;
    if (stallWatchTimer) {
      clearInterval(stallWatchTimer);
      stallWatchTimer = null;
    }
    if (typeof window !== 'undefined') {
      document.removeEventListener('visibilitychange', handleVisibilityRefresh);
      window.removeEventListener('focus', handleVisibilityRefresh);
    }
  };

  const triggerFallback = (reason: string) => {
    if (fellBack || disposed) {
      return;
    }
    fellBack = true;
    stopMaintenanceTimers();
    closeEventSource('fallback');
    console.info('[CARER_TASKS_SQL_READ] fallback_to_firebase reason=%s', reason);
    onFallback(reason);
  };

  const bootstrap = async () => {
    console.info('[CARER_TASKS_SQL_READ] enabled');
    const bootstrapStartedAt = Date.now();
    try {
      const headers = await getSqlApiReadHeaders(false);
      const snapshotStartedAt = Date.now();
      logCarerPageStartup({
        stage: 'tasks_snapshot_start',
        ok: true,
        uid: cleanCarerUid,
        role: 'carer',
      });
      const snapshotOk = await loadSnapshot(headers, 'bootstrap');
      if (!snapshotOk) {
        logCarerPageStartup({
          stage: 'tasks_snapshot_done',
          ok: false,
          uid: cleanCarerUid,
          role: 'carer',
          durationMs: Date.now() - snapshotStartedAt,
          reason: 'snapshot_load_failed',
        });
        triggerFallback('snapshot_load_failed');
        return;
      }

      logCarerPageStartup({
        stage: 'tasks_snapshot_done',
        ok: true,
        uid: cleanCarerUid,
        role: 'carer',
        durationMs: Date.now() - snapshotStartedAt,
        extra: {
          count: tasksById.size,
          latestOutboxId: lastSnapshotOutboxId,
        },
      });
      console.info(
        '[CARER_TASKS_SQL_READ] snapshot_loaded count=%s latestOutboxId=%s',
        tasksById.size,
        lastSnapshotOutboxId
      );

      lastSseActivityAt = Date.now();
      startMaintenanceTimers();
      startLiveStreamLoop();

      logCarerPageStartup({
        stage: 'sse_start',
        ok: true,
        uid: cleanCarerUid,
        role: 'carer',
        durationMs: Date.now() - bootstrapStartedAt,
        extra: { channel: 'carer_tasks', transport: 'eventsource' },
      });
    } catch (error) {
      if (!disposed) {
        const reason =
          error instanceof Error ? error.message : 'bootstrap_or_sse_failed';
        logCarerPageStartup({
          stage: 'tasks_snapshot_done',
          ok: false,
          uid: cleanCarerUid,
          role: 'carer',
          durationMs: Date.now() - bootstrapStartedAt,
          reason,
        });
        triggerFallback(reason);
      }
    }
  };

  void bootstrap();

  return {
    dispose() {
      disposed = true;
      connectGeneration += 1;
      stopMaintenanceTimers();
      if (refetchTimer) {
        clearTimeout(refetchTimer);
        refetchTimer = null;
      }
      closeEventSource('dispose');
      releaseLiveStreamClientOwner({
        streamType: 'carer_tasks',
        streamKey,
        instanceId,
        reason: 'dispose',
      });
      tasksById.clear();
    },
    hasFallenBack() {
      return fellBack;
    },
  };
}
