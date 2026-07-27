import { NextResponse } from 'next/server';

import { apiError, requireCarerOwnedLiveAuth } from '@/lib/firebase/apiAuth';
import {
  logSnapshotFullQueryRun,
  trySnapshotNoChangeResponse,
} from '@/lib/server/snapshotNoChange';
import {
  carerTaskLiveChannel,
  coadminTaskLiveChannel,
  getLatestOutboxIdForChannels,
} from '@/lib/sql/liveOutbox';
import {

  acquirePlayerMirrorClient,
  cleanText,
  createPlayerMirrorSqlTiming,
  getPlayerMirrorPool,
  runMirrorClientQuery,
  toIsoString,
} from '@/lib/sql/playerMirrorCommon';
import { logSqlExplainSummary } from '@/lib/sql/sqlExplainSummary';
import { attachVendorAwarenessToPlayers } from '@/lib/sql/vendorOwnershipRead';
import type { VendorAwareness } from '@/features/vendors/vendorAwareness';

export const runtime = 'nodejs';

export const dynamic = 'force-dynamic';

const CARER_TASK_RECENT_COMPLETED_LIMIT = 30;
const CARER_TASK_ACTIVE_STATUSES = ['pending', 'in_progress', 'urgent', 'pending_review'];
const VERBOSE_CARER_SNAPSHOT_AUDIT = process.env.VERBOSE_CARER_SNAPSHOT_AUDIT === '1';

const RECOMMENDED_SNAPSHOT_INDEXES = [
  'carer_tasks_cache(coadmin_uid, created_at DESC) WHERE deleted_at IS NULL',
  'carer_tasks_cache(coadmin_uid, status, created_at DESC) WHERE deleted_at IS NULL',
  'carer_tasks_cache(assigned_carer_uid, status, created_at DESC) WHERE deleted_at IS NULL',
  'carer_tasks_cache(coadmin_uid, status, completed_at DESC) WHERE deleted_at IS NULL',
  'live_outbox(channel, outbox_id) WHERE deleted_at IS NULL',
];

const SNAPSHOT_TASK_COLUMNS = `
  firebase_id,
  coadmin_uid,
  player_uid,
  type,
  status,
  automation_status,
  game_name,
  amount,
  request_id,
  assigned_carer_uid,
  assigned_carer_username,
  claimed_by_uid,
  claimed_by_username,
  created_at,
  claimed_at,
  started_at,
  updated_at,
  completed_at,
  completed_by_carer_uid,
  completed_by_carer_username
`;

type SnapshotTask = {
  id: string;
  taskId: string;
  coadminUid: string;
  playerUid: string;
  type: string;
  status: string;
  automationStatus: string | null;
  gameName: string;
  amount: number | null;
  requestId: string | null;
  assignedCarerUid: string | null;
  assignedCarerUsername: string | null;
  claimedByUid: string | null;
  claimedByUsername: string | null;
  createdAt: string | null;
  claimedAt: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
  completedByCarerUid: string | null;
  completedByCarerUsername: string | null;
  vendor?: VendorAwareness | null;
};

function mapSnapshotRow(row: Record<string, unknown>): SnapshotTask {
  return {
    id: cleanText(row.firebase_id),
    taskId: cleanText(row.firebase_id),
    coadminUid: cleanText(row.coadmin_uid),
    playerUid: cleanText(row.player_uid),
    type: cleanText(row.type),
    status: cleanText(row.status),
    automationStatus: cleanText(row.automation_status) || null,
    gameName: cleanText(row.game_name),
    amount: Number.isFinite(Number(row.amount)) ? Number(row.amount) : null,
    requestId: cleanText(row.request_id) || null,
    assignedCarerUid: cleanText(row.assigned_carer_uid) || null,
    assignedCarerUsername: cleanText(row.assigned_carer_username) || null,
    claimedByUid: cleanText(row.claimed_by_uid) || null,
    claimedByUsername: cleanText(row.claimed_by_username) || null,
    createdAt: toIsoString(row.created_at),
    claimedAt: toIsoString(row.claimed_at),
    startedAt: toIsoString(row.started_at),
    updatedAt: toIsoString(row.updated_at),
    completedAt: toIsoString(row.completed_at),
    completedByCarerUid: cleanText(row.completed_by_carer_uid) || null,
    completedByCarerUsername: cleanText(row.completed_by_carer_username) || null,
  };
}

function isVisibleCarerTaskForCarer(task: SnapshotTask, carerUid: string) {
  const status = cleanText(task.status).toLowerCase();
  const assignedCarerUid = cleanText(task.assignedCarerUid);

  if (status === 'completed') {
    return true;
  }
  if (status === 'failed') {
    return false;
  }
  if (status === 'urgent') {
    return assignedCarerUid === carerUid;
  }
  if (status === 'pending') {
    return !assignedCarerUid || assignedCarerUid === carerUid;
  }
  return assignedCarerUid === carerUid;
}

function snapshotRowHiddenReason(task: SnapshotTask, carerUid: string): string | null {
  if (isVisibleCarerTaskForCarer(task, carerUid)) {
    return null;
  }
  const status = cleanText(task.status).toLowerCase();
  const assignedCarerUid = cleanText(task.assignedCarerUid);
  if (status === 'failed') {
    return 'status_failed';
  }
  if (status === 'urgent' && assignedCarerUid !== carerUid) {
    return 'urgent_assigned_to_other_carer';
  }
  if (status === 'pending' && assignedCarerUid && assignedCarerUid !== carerUid) {
    return 'pending_assigned_to_other_carer';
  }
  if (assignedCarerUid && assignedCarerUid !== carerUid) {
    return 'assigned_to_other_carer';
  }
  return 'not_visible_to_carer';
}

function logCarerSnapshotRowAudit(input: {
  task: SnapshotTask;
  carerUid: string;
  includedInRawRows: boolean;
  includedInVisibleRows: boolean;
  hiddenReason: string | null;
}) {
  if (!VERBOSE_CARER_SNAPSHOT_AUDIT) {
    return;
  }
  const taskType = cleanText(input.task.type).toLowerCase();
  if (taskType !== 'recharge' && taskType !== 'redeem') {
    return;
  }
  console.info('[CARER_SNAPSHOT_ROW_AUDIT]', {
    taskId: input.task.id,
    taskType,
    status: input.task.status,
    playerUid: input.task.playerUid,
    coadminUid: input.task.coadminUid,
    assignedCarerUid: input.task.assignedCarerUid,
    deletedAt: null,
    includedInRawRows: input.includedInRawRows,
    includedInVisibleRows: input.includedInVisibleRows,
    hiddenReason: input.hiddenReason,
  });
}

function countSnapshotStatuses(tasks: SnapshotTask[]) {
  let pendingCount = 0;
  let inProgressCount = 0;
  let completedCount = 0;

  for (const task of tasks) {
    const status = cleanText(task.status).toLowerCase();
    if (status === 'pending') {
      pendingCount += 1;
    } else if (status === 'in_progress') {
      inProgressCount += 1;
    } else if (status === 'completed') {
      completedCount += 1;
    }
  }

  return { pendingCount, inProgressCount, completedCount };
}

function sortByNewest(rows: SnapshotTask[]) {
  return [...rows].sort((left, right) => {
    const leftMs = left.updatedAt ? new Date(left.updatedAt).getTime() : 0;
    const rightMs = right.updatedAt ? new Date(right.updatedAt).getTime() : 0;
    if (rightMs !== leftMs) return rightMs - leftMs;
    const leftCreated = left.createdAt ? new Date(left.createdAt).getTime() : 0;
    const rightCreated = right.createdAt ? new Date(right.createdAt).getTime() : 0;
    return rightCreated - leftCreated;
  });
}

function logSnapshotTiming(details: Record<string, unknown>) {
  console.info('[LIVE_CARER_TASKS_SNAPSHOT_TIMING]', {
    recommendedIndexes: RECOMMENDED_SNAPSHOT_INDEXES,
    shadowLimitation:
      'Unassigned pending/urgent outbox events use coadmin:{coadminUid}:tasks; carer SSE may lag pool tasks until assigned.',
    ...details,
  });
}

function authTimingDetails(timing: {
  auth_path: string;
  auth_ms: number;
  verify_token_ms: number;
  sql_profile_ms: number;
  sql_profile_query_ms: number;
  sql_profile_pool_acquire_ms: number;
  sql_profile_query_exec_ms: number;
  sql_profile_total_ms: number;
  user_doc_ms: number;
  token_cache_hit: boolean;
  firestore_fallback?: boolean;
  source?: string;
}) {
  return {
    auth_path: timing.auth_path,
    auth_ms: timing.auth_ms,
    verify_token_ms: timing.verify_token_ms,
    token_cache_hit: timing.token_cache_hit,
    sql_profile_ms: timing.sql_profile_ms,
    sql_profile_query_ms: timing.sql_profile_query_ms,
    sql_profile_pool_acquire_ms: timing.sql_profile_pool_acquire_ms,
    sql_profile_query_exec_ms: timing.sql_profile_query_exec_ms,
    sql_profile_total_ms: timing.sql_profile_total_ms,
    user_doc_ms: timing.user_doc_ms,
    source: timing.source || (timing.firestore_fallback ? 'firestore' : 'sql'),
    firestore_fallback: timing.firestore_fallback ?? timing.user_doc_ms > 0,
  };
}

async function fetchSnapshotRowsWithClient(
  client: import('pg').PoolClient,
  coadminUid: string
) {
  const totalStartedAt = Date.now();
  const snapshotSql = `
    WITH active_rows AS (
      SELECT ${SNAPSHOT_TASK_COLUMNS}, 'active'::text AS snapshot_bucket
      FROM public.carer_tasks_cache
      WHERE coadmin_uid = $1
        AND deleted_at IS NULL
        AND status = ANY($2::text[])
      ORDER BY created_at DESC
    ),
    completed_rows AS (
      SELECT ${SNAPSHOT_TASK_COLUMNS}, 'completed'::text AS snapshot_bucket
      FROM public.carer_tasks_cache
      WHERE coadmin_uid = $1
        AND deleted_at IS NULL
        AND status = 'completed'
      ORDER BY completed_at DESC
      LIMIT $3
    )
    SELECT *
    FROM active_rows
    UNION ALL
    SELECT *
    FROM completed_rows
  `;
  const snapshotPack = await runMirrorClientQuery<Record<string, unknown>>(
    client,
    snapshotSql,
    [coadminUid, CARER_TASK_ACTIVE_STATUSES, CARER_TASK_RECENT_COMPLETED_LIMIT]
  );
  await logSqlExplainSummary({
    client,
    route: '/api/live/snapshot/carer/[carerUid]/tasks',
    queryName: 'carer_tasks_snapshot_combined',
    sql: snapshotSql,
    params: [coadminUid, CARER_TASK_ACTIVE_STATUSES, CARER_TASK_RECENT_COMPLETED_LIMIT],
    rowsReturned: snapshotPack.rows.length,
  });
  const activeRows = snapshotPack.rows.filter((row) => cleanText(row.snapshot_bucket) === 'active');
  const completedRows = snapshotPack.rows.filter(
    (row) => cleanText(row.snapshot_bucket) === 'completed'
  );

  const timing = createPlayerMirrorSqlTiming({
    pool_acquire_ms: 0,
    query_exec_ms: snapshotPack.timing.query_exec_ms,
    total_ms: Date.now() - totalStartedAt,
  });

  const merged = new Map<string, Record<string, unknown>>();
  for (const row of [...activeRows, ...completedRows]) {
    const firebaseId = cleanText(row.firebase_id);
    if (firebaseId) {
      merged.set(firebaseId, row);
    }
  }
  const activeBreakdown = countSnapshotStatuses(activeRows.map(mapSnapshotRow));
  const completedBreakdown = countSnapshotStatuses(completedRows.map(mapSnapshotRow));

  return {
    rows: Array.from(merged.values()),
    timing,
    recentRowCount: completedRows.length,
    completedRowCount: completedRows.length,
    activeRowCount: activeRows.length,
    rawRowCount: merged.size,
    recent_query_exec_ms: 0,
    completed_query_exec_ms: 0,
    active_query_exec_ms: snapshotPack.timing.query_exec_ms,
    combined_query_exec_ms: snapshotPack.timing.query_exec_ms,
    activePendingCount: activeBreakdown.pendingCount,
    activeInProgressCount: activeBreakdown.inProgressCount,
    activeCompletedCount: activeBreakdown.completedCount,
    completedPendingCount: completedBreakdown.pendingCount,
    completedInProgressCount: completedBreakdown.inProgressCount,
    completedCompletedCount: completedBreakdown.completedCount,
  };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ carerUid: string }> }
) {
  const totalStartedAt = Date.now();

  const { carerUid: rawCarerUid } = await params;
  const carerUid = cleanText(decodeURIComponent(rawCarerUid || ''));
  if (!carerUid || carerUid.includes('/')) {
    logSnapshotTiming({
      auth_ms: 0,
      sql_connection_acquire_ms: 0,
      sql_tasks_ms: 0,
      sql_latest_outbox_ms: 0,
      merge_ms: 0,
      total_ms: Date.now() - totalStartedAt,
      reason: 'invalid_carer_uid',
    });
    return apiError('Carer uid is required.', 400);
  }

  const auth = await requireCarerOwnedLiveAuth(request, carerUid);
  if (!auth.ok) {
    logSnapshotTiming({
      ...authTimingDetails(auth.timing),
      sql_connection_acquire_ms: 0,
      sql_tasks_ms: 0,
      sql_latest_outbox_ms: 0,
      merge_ms: 0,
      total_ms: Date.now() - totalStartedAt,
      reason: 'auth_response',
      carerUid,
    });
    return auth.response;
  }

  if (!auth.coadminUid) {
    logSnapshotTiming({
      ...authTimingDetails(auth.timing),
      sql_connection_acquire_ms: 0,
      sql_tasks_ms: 0,
      sql_latest_outbox_ms: 0,
      merge_ms: 0,
      total_ms: Date.now() - totalStartedAt,
      reason: 'missing_coadmin_scope',
      carerUid,
    });
    return NextResponse.json({
      tasks: [],
      snapshotAt: new Date().toISOString(),
      latestOutboxId: 0,
      source: 'postgres_snapshot_unscoped',
    });
  }

  if (!getPlayerMirrorPool()) {
    logSnapshotTiming({
      ...authTimingDetails(auth.timing),
      sql_connection_acquire_ms: 0,
      sql_tasks_ms: 0,
      sql_latest_outbox_ms: 0,
      merge_ms: 0,
      total_ms: Date.now() - totalStartedAt,
      reason: 'postgres_unavailable',
      carerUid,
      coadminUid: auth.coadminUid,
    });
    return NextResponse.json({
      tasks: [],
      snapshotAt: new Date().toISOString(),
      latestOutboxId: 0,
      source: 'postgres_snapshot_unavailable',
    });
  }

  const acquired = await acquirePlayerMirrorClient({
    context: 'live_carer_tasks_snapshot',
    route: '/api/live/snapshot/carer/[carerUid]/tasks',
  });
  if (!acquired) {
    logSnapshotTiming({
      ...authTimingDetails(auth.timing),
      sql_connection_acquire_ms: 0,
      sql_tasks_ms: 0,
      sql_latest_outbox_ms: 0,
      merge_ms: 0,
      total_ms: Date.now() - totalStartedAt,
      reason: 'postgres_unavailable',
      carerUid,
      coadminUid: auth.coadminUid,
    });
    return NextResponse.json({
      tasks: [],
      snapshotAt: new Date().toISOString(),
      latestOutboxId: 0,
      source: 'postgres_snapshot_unavailable',
    });
  }

  const { client } = acquired;
  const sqlConnectionAcquireMs = acquired.timing.pool_acquire_ms;

  try {
    const route = '/api/live/snapshot/carer/[carerUid]/tasks';
    const streamChannels = [
      carerTaskLiveChannel(carerUid),
      coadminTaskLiveChannel(auth.coadminUid),
    ];

    const noChange = await trySnapshotNoChangeResponse({
      request,
      route,
      channels: streamChannels,
      carerUid,
    });
    if (noChange instanceof Response) {
      return noChange;
    }

    const snapshotPack = await fetchSnapshotRowsWithClient(client, auth.coadminUid);
    const outboxPack =
      noChange.kind === 'full' && noChange.latestOutboxId != null
        ? {
            latestOutboxId: noChange.latestOutboxId,
            timing: { total_ms: 0, pool_acquire_ms: 0, query_exec_ms: 0 },
          }
        : await getLatestOutboxIdForChannels(streamChannels, {
            mirrorClient: client,
          });
    logSnapshotFullQueryRun({
      route,
      carerUid,
      coadminUid: auth.coadminUid,
      reusedOutboxLookup: noChange.latestOutboxId != null,
    });

    const mergeStartedAt = Date.now();
    const mapped = snapshotPack.rows.map(mapSnapshotRow).filter((row) => row.id);
    const visible = mapped.filter((task) => {
      const included = isVisibleCarerTaskForCarer(task, carerUid);
      logCarerSnapshotRowAudit({
        task,
        carerUid,
        includedInRawRows: true,
        includedInVisibleRows: included,
        hiddenReason: included ? null : snapshotRowHiddenReason(task, carerUid),
      });
      return included;
    });
    const tasks = await attachVendorAwarenessToPlayers(sortByNewest(visible), { client });
    const mergeMs = Date.now() - mergeStartedAt;
    const totalMs = Date.now() - totalStartedAt;
    const snapshotCounts = countSnapshotStatuses(tasks);

    console.info('[CARER_SNAPSHOT_SUMMARY]', {
      ...snapshotCounts,
      totalRows: tasks.length,
      rawRowCount: snapshotPack.rawRowCount,
      mappedRowCount: mapped.length,
      durationMs: totalMs,
      latestOutboxId: outboxPack.latestOutboxId,
    });
    console.info('[SNAPSHOT_QUERY_BREAKDOWN]', {
      activeRows: snapshotPack.activeRowCount,
      completedRows: snapshotPack.completedRowCount,
      pendingRows: snapshotPack.activePendingCount,
      inProgressRows: snapshotPack.activeInProgressCount,
      activeCompletedRows: snapshotPack.activeCompletedCount,
      completedWindowRows: snapshotPack.completedCompletedCount,
      queryMs: snapshotPack.timing.query_exec_ms,
      combinedQueryMs: snapshotPack.combined_query_exec_ms,
      activeQueryMs: snapshotPack.active_query_exec_ms,
      completedQueryMs: snapshotPack.completed_query_exec_ms,
      completedLimit: CARER_TASK_RECENT_COMPLETED_LIMIT,
    });

    logSnapshotTiming({
      ...authTimingDetails(auth.timing),
      sql_connection_acquire_ms: sqlConnectionAcquireMs,
      sql_connection_shared: false,
      auth_before_snapshot_acquire: true,
      sql_tasks_ms: snapshotPack.timing.total_ms,
      sql_tasks_pool_acquire_ms: snapshotPack.timing.pool_acquire_ms,
      sql_tasks_query_exec_ms: snapshotPack.timing.query_exec_ms,
      sql_tasks_recent_query_exec_ms: snapshotPack.recent_query_exec_ms,
      sql_tasks_completed_query_exec_ms: snapshotPack.completed_query_exec_ms,
      sql_tasks_active_query_exec_ms: snapshotPack.active_query_exec_ms,
      sql_latest_outbox_ms: outboxPack.timing.total_ms,
      sql_latest_outbox_pool_acquire_ms: outboxPack.timing.pool_acquire_ms,
      sql_latest_outbox_query_exec_ms: outboxPack.timing.query_exec_ms,
      merge_ms: mergeMs,
      total_ms: totalMs,
      carerUid,
      coadminUid: auth.coadminUid,
      recentRowCount: snapshotPack.recentRowCount,
      recentCompletedLimit: CARER_TASK_RECENT_COMPLETED_LIMIT,
      completedRowCount: snapshotPack.completedRowCount,
      activeRowCount: snapshotPack.activeRowCount,
      activePendingCount: snapshotPack.activePendingCount,
      activeInProgressCount: snapshotPack.activeInProgressCount,
      rawRowCount: snapshotPack.rawRowCount,
      mappedRowCount: mapped.length,
      visibleRowCount: visible.length,
      mergedRowCount: tasks.length,
      latestOutboxId: outboxPack.latestOutboxId,
    });

    return NextResponse.json({
      tasks,
      snapshotAt: new Date().toISOString(),
      latestOutboxId: outboxPack.latestOutboxId,
      source: 'postgres_snapshot',
    }, {
      headers: {
        ETag: `"${outboxPack.latestOutboxId}"`,
        'Cache-Control': 'no-cache, no-transform',
      },
    });
  } catch (error) {
    console.info('[LIVE_OUTBOX] failed', { reason: 'carer_tasks_snapshot', carerUid, error });
    logSnapshotTiming({
      sql_connection_acquire_ms: sqlConnectionAcquireMs,
      sql_connection_shared: true,
      sql_tasks_ms: 0,
      sql_latest_outbox_ms: 0,
      merge_ms: 0,
      total_ms: Date.now() - totalStartedAt,
      reason: 'postgres_snapshot_failed',
      carerUid,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({
      tasks: [],
      snapshotAt: new Date().toISOString(),
      latestOutboxId: 0,
      source: 'postgres_snapshot_failed',
    });
  } finally {
    client.release();
  }
}
