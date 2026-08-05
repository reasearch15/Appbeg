import type { PoolClient } from 'pg';
import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import { apiError, requireApiUser } from '@/lib/firebase/apiAuth';
import {
  isCacheSqlAuthoritative,
  logCacheFirestoreFallbackBlocked,
} from '@/lib/server/cacheSqlRead';
import { logFirestoreTouch } from '@/lib/server/firestoreTouchAudit';
import {

  acquirePlayerMirrorClient,
  cleanText,
  toDate,
} from '@/lib/sql/playerMirrorCommon';

export const runtime = 'nodejs';

const ROUTE = '/api/coadmin/players/[playerUid]/history';

const SELECTED_PLAYER_RECORD_QUERY_LIMIT = 100;
const SELECTED_PLAYER_CASHOUT_QUERY_LIMIT = 50;

const FINANCIAL_EVENTS_HISTORY_COLUMNS = `
  firebase_id,
  type,
  coadmin_uid,
  amount_npr,
  created_at
`.trim();

const CASHOUT_TASKS_HISTORY_COLUMNS = `
  firebase_id,
  completed_at,
  created_at,
  amount_npr,
  payout_method,
  payment_app_name
`.trim();

const GAME_REQUESTS_HISTORY_COLUMNS = `
  firebase_id,
  type,
  game_name,
  completed_at,
  created_at,
  amount,
  status,
  bonus_percentage
`.trim();

type PlayerRecordTab =
  | 'coin-recharge'
  | 'cashout'
  | 'coin-recharge-ingame'
  | 'redeem'
  | 'auto-bonus';

type PlayerRecordRow = {
  id: string;
  dateLabel: string;
  amountValue: number;
  amountUnit: 'coin' | 'cash';
  amountLabel: string;
  statusLabel: string;
  sourceLabel: string;
  detailLabel: string;
  sortMs: number;
};

type HistoryPayload = {
  source: 'postgres' | 'firestore';
  coadminAddedCoinTotal: number;
  cashoutTotalAmount: number;
  rows: Record<PlayerRecordTab, PlayerRecordRow[]>;
};

type SqlHistoryRow = Record<string, unknown> & {
  firebase_id?: string;
  raw_firestore_data?: Record<string, unknown> | null;
};

type RouteTiming = {
  auth_ms: number;
  scope_check_ms: number;
  sql_pool_ms: number;
  client_acquire_ms: number;
  pg_connect_ms: number;
  each_query_ms: number[];
  fallback_check_ms: number;
  serialization_ms: number;
  total_ms: number;
  poolReused: boolean | null;
  firebaseFallback: boolean;
  firebaseScopeRead: boolean;
  shared_client: boolean;
  row_width_mode: 'narrow' | 'wide';
};

function createRouteTiming(): RouteTiming {
  return {
    auth_ms: 0,
    scope_check_ms: 0,
    sql_pool_ms: 0,
    client_acquire_ms: 0,
    pg_connect_ms: 0,
    each_query_ms: [],
    fallback_check_ms: 0,
    serialization_ms: 0,
    total_ms: 0,
    poolReused: null,
    firebaseFallback: false,
    firebaseScopeRead: false,
    shared_client: false,
    row_width_mode: 'narrow',
  };
}

function logRouteTiming(routeTiming: RouteTiming, details: Record<string, unknown> = {}) {
  console.info('[COADMIN_PLAYER_HISTORY_TIMING]', {
    ...routeTiming,
    ...details,
  });
}

function timedJson(
  payload: unknown,
  totalStartedAt: number,
  routeTiming: RouteTiming,
  details: Record<string, unknown> = {},
  init?: ResponseInit
) {
  const serializeStartedAt = Date.now();
  const response = NextResponse.json(payload, init);
  routeTiming.serialization_ms = Date.now() - serializeStartedAt;
  routeTiming.total_ms = Date.now() - totalStartedAt;
  logRouteTiming(routeTiming, details);
  return response;
}

function numberValue(value: unknown) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatDateTime(value: unknown) {
  const date = toDate(value);
  if (!date) {
    return '—';
  }
  return date.toLocaleString();
}

function formatPlayerRecordAmount(value: number, unit: 'coin' | 'cash') {
  const rounded = Math.max(0, Math.floor(Number(value || 0))).toLocaleString();
  return unit === 'cash' ? `USD ${Math.round(value || 0).toLocaleString()}` : `${rounded} coin`;
}

function toMillis(value: unknown) {
  return toDate(value)?.getTime() || 0;
}

function titleStatus(value: unknown) {
  return String(value || 'pending')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function raw(row: SqlHistoryRow) {
  const value = row.raw_firestore_data;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function sqlValue(row: SqlHistoryRow, column: string, rawField: string = column) {
  const rowValue = row[column];
  if (rowValue !== undefined && rowValue !== null && rowValue !== '') return rowValue;
  return raw(row)[rawField];
}

function baseRows(): Record<PlayerRecordTab, PlayerRecordRow[]> {
  return {
    'coin-recharge': [],
    cashout: [],
    'coin-recharge-ingame': [],
    redeem: [],
    'auto-bonus': [],
  };
}

async function playerBelongsToCoadminScope(
  playerUid: string,
  coadminUid: string,
  client: PoolClient | null,
  routeTiming: RouteTiming
) {
  const sqlReadMode = isCacheSqlAuthoritative();

  const matchesScope = (row: { coadmin_uid?: unknown; created_by?: unknown } | undefined) => {
    if (!row) return null;
    return (
      cleanText(row.coadmin_uid) === coadminUid || cleanText(row.created_by) === coadminUid
    );
  };

  if (client) {
    try {
      const queryStartedAt = Date.now();
      const result = await client.query(
        `
          SELECT coadmin_uid, created_by
          FROM public.players_cache
          WHERE uid = $1 AND deleted_at IS NULL
          LIMIT 1
        `,
        [playerUid]
      );
      routeTiming.each_query_ms.push(Date.now() - queryStartedAt);
      const playerRow = result.rows[0] as { coadmin_uid?: unknown; created_by?: unknown } | undefined;
      const playerMatch = matchesScope(playerRow);
      if (playerMatch !== null) {
        return playerMatch;
      }

      const balanceStartedAt = Date.now();
      const balanceResult = await client.query(
        `
          SELECT coadmin_uid, created_by
          FROM public.user_balance_snapshots_cache
          WHERE firebase_id = $1 AND deleted_at IS NULL
          LIMIT 1
        `,
        [playerUid]
      );
      routeTiming.each_query_ms.push(Date.now() - balanceStartedAt);
      const balanceRow = balanceResult.rows[0] as
        | { coadmin_uid?: unknown; created_by?: unknown }
        | undefined;
      const balanceMatch = matchesScope(balanceRow);
      if (balanceMatch !== null) {
        return balanceMatch;
      }
    } catch {
      if (sqlReadMode) {
        return false;
      }
    }
  }

  if (sqlReadMode) {
    logFirestoreTouch({
      firestore_touch_type: 'legacy_read_remove_now',
      route: '/api/coadmin/players/[playerUid]/history',
      operation: 'read',
      collection: 'users',
      document_id: playerUid,
      skipped: true,
      sql_read_mode: true,
      details: { context: 'scope_check' },
    });
    return false;
  }

  routeTiming.firebaseScopeRead = true;
  logFirestoreTouch({
    firestore_touch_type: 'legacy_read_remove_now',
    route: '/api/coadmin/players/[playerUid]/history',
    operation: 'read',
    collection: 'users',
    document_id: playerUid,
    sql_read_mode: false,
    details: { context: 'scope_check' },
  });
  const playerSnap = await adminDb.collection('users').doc(playerUid).get();
  if (!playerSnap.exists) return false;
  const player = playerSnap.data() || {};
  return cleanText(player.coadminUid) === coadminUid || cleanText(player.createdBy) === coadminUid;
}

function mapFinancialRows(rows: SqlHistoryRow[], callerCoadminUid: string | null) {
  const mappedRows: PlayerRecordRow[] = [];
  const autoBonusRows: PlayerRecordRow[] = [];

  rows.forEach((row) => {
    const eventType = cleanText(sqlValue(row, 'type'));
    const eventCoadminUid = cleanText(sqlValue(row, 'coadmin_uid', 'coadminUid'));
    const amount = numberValue(sqlValue(row, 'amount_npr', 'amountNpr'));
    const createdAt = sqlValue(row, 'created_at', 'createdAt');

    if (eventType === 'automatic_recharge_bonus') {
      if (callerCoadminUid && eventCoadminUid && eventCoadminUid !== callerCoadminUid) return;
      autoBonusRows.push({
        id: `auto-bonus-${cleanText(row.firebase_id)}`,
        dateLabel: formatDateTime(createdAt),
        amountValue: amount,
        amountUnit: 'coin',
        amountLabel: formatPlayerRecordAmount(amount, 'coin'),
        statusLabel: 'Granted',
        sourceLabel: 'Automatic Recharge Bonus',
        detailLabel: 'Promo-locked auto bonus grant',
        sortMs: toMillis(createdAt),
      });
      return;
    }

    if (eventType !== 'coadmin_coin_add') return;
    if (callerCoadminUid && eventCoadminUid && eventCoadminUid !== callerCoadminUid) return;

    mappedRows.push({
      id: `coin-recharge-${cleanText(row.firebase_id)}`,
      dateLabel: formatDateTime(createdAt),
      amountValue: amount,
      amountUnit: 'coin',
      amountLabel: formatPlayerRecordAmount(amount, 'coin'),
      statusLabel: 'Completed',
      sourceLabel: eventCoadminUid ? 'App / Coadmin' : 'App',
      detailLabel: 'Manual coin recharge',
      sortMs: toMillis(createdAt),
    });
  });

  return {
    coinRechargeRows: mappedRows.sort((left, right) => right.sortMs - left.sortMs),
    autoBonusRows: autoBonusRows.sort((left, right) => right.sortMs - left.sortMs),
  };
}

function mapCashoutRows(rows: SqlHistoryRow[]) {
  return rows
    .map((row) => {
      const completedAt = sqlValue(row, 'completed_at', 'completedAt');
      const createdAt = sqlValue(row, 'created_at', 'createdAt');
      const timeValue = completedAt || createdAt || null;
      const amount = numberValue(sqlValue(row, 'amount_npr', 'amountNpr'));
      const payoutMethod = cleanText(sqlValue(row, 'payout_method', 'payoutMethod'));
      const paymentAppName = cleanText(sqlValue(row, 'payment_app_name', 'paymentAppName'));

      return {
        id: `cashout-${cleanText(row.firebase_id)}`,
        dateLabel: formatDateTime(timeValue),
        amountValue: amount,
        amountUnit: 'cash',
        amountLabel: formatPlayerRecordAmount(amount, 'cash'),
        statusLabel: 'Completed',
        sourceLabel:
          payoutMethod === 'app'
            ? paymentAppName
              ? `App / ${paymentAppName}`
              : 'App'
            : payoutMethod === 'qr'
              ? 'QR'
              : 'Cashout',
        detailLabel: 'Player cashout',
        sortMs: toMillis(timeValue),
      } satisfies PlayerRecordRow;
    })
    .sort((left, right) => right.sortMs - left.sortMs);
}

function mapGameRequestRows(rows: SqlHistoryRow[]) {
  const inGameRechargeRows: PlayerRecordRow[] = [];
  const redeemRows: PlayerRecordRow[] = [];

  rows.forEach((row) => {
    const type = cleanText(sqlValue(row, 'type'));
    const gameName = cleanText(sqlValue(row, 'game_name', 'gameName')) || 'Unknown game';
    const completedAt = sqlValue(row, 'completed_at', 'completedAt');
    const createdAt = sqlValue(row, 'created_at', 'createdAt');
    const timeValue = completedAt || createdAt || null;
    const amount = numberValue(sqlValue(row, 'amount'));
    const commonRow = {
      dateLabel: formatDateTime(timeValue),
      amountValue: amount,
      amountUnit: 'coin' as const,
      amountLabel: formatPlayerRecordAmount(amount, 'coin'),
      statusLabel: titleStatus(sqlValue(row, 'status')),
      sourceLabel: gameName,
      sortMs: toMillis(timeValue),
    };

    if (type === 'recharge') {
      const bonusPercentage = numberValue(sqlValue(row, 'bonus_percentage', 'bonusPercentage'));
      inGameRechargeRows.push({
        id: `ingame-recharge-${cleanText(row.firebase_id)}`,
        ...commonRow,
        detailLabel:
          bonusPercentage > 0 ? `Bonus ${Math.round(bonusPercentage)}% applied` : 'Game recharge',
      });
    }

    if (type === 'redeem') {
      redeemRows.push({
        id: `redeem-${cleanText(row.firebase_id)}`,
        ...commonRow,
        detailLabel: 'Game redeem',
      });
    }
  });

  inGameRechargeRows.sort((left, right) => right.sortMs - left.sortMs);
  redeemRows.sort((left, right) => right.sortMs - left.sortMs);
  return { inGameRechargeRows, redeemRows };
}

function buildHistoryPayload(
  source: 'postgres' | 'firestore',
  financialRows: SqlHistoryRow[],
  cashoutRowsInput: SqlHistoryRow[],
  gameRequestRows: SqlHistoryRow[],
  callerCoadminUid: string | null
): HistoryPayload {
  const { coinRechargeRows, autoBonusRows } = mapFinancialRows(
    financialRows,
    callerCoadminUid
  );
  const cashoutRows = mapCashoutRows(cashoutRowsInput);
  const { inGameRechargeRows, redeemRows } = mapGameRequestRows(gameRequestRows);

  return {
    source,
    coadminAddedCoinTotal: Math.round(
      coinRechargeRows.reduce((total, row) => total + Math.max(0, Number(row.amountValue || 0)), 0)
    ),
    cashoutTotalAmount: Math.round(
      cashoutRows.reduce((total, row) => total + Math.max(0, Number(row.amountValue || 0)), 0)
    ),
    rows: {
      'coin-recharge': coinRechargeRows,
      cashout: cashoutRows,
      'coin-recharge-ingame': inGameRechargeRows,
      redeem: redeemRows,
      'auto-bonus': autoBonusRows,
    },
  };
}

async function getPostgresHistory(
  playerUid: string,
  callerCoadminUid: string | null,
  client: PoolClient,
  routeTiming: RouteTiming
) {
  const [financialEvents, completedCashouts, playerGameRequests, autoBonusEvents] =
    await Promise.all([
    (async () => {
      const queryStartedAt = Date.now();
      const result = await client.query(
        `
          SELECT ${FINANCIAL_EVENTS_HISTORY_COLUMNS}
          FROM public.financial_events_cache
          WHERE player_uid = $1 AND deleted_at IS NULL
          ORDER BY created_at DESC NULLS LAST
          LIMIT $2
        `,
        [playerUid, SELECTED_PLAYER_RECORD_QUERY_LIMIT]
      );
      routeTiming.each_query_ms.push(Date.now() - queryStartedAt);
      return result;
    })(),
    (async () => {
      const queryStartedAt = Date.now();
      const result = await client.query(
        `
          SELECT ${CASHOUT_TASKS_HISTORY_COLUMNS}
          FROM public.player_cashout_tasks_cache
          WHERE player_uid = $1 AND status = 'completed' AND deleted_at IS NULL
          ORDER BY completed_at DESC NULLS LAST
          LIMIT $2
        `,
        [playerUid, SELECTED_PLAYER_CASHOUT_QUERY_LIMIT]
      );
      routeTiming.each_query_ms.push(Date.now() - queryStartedAt);
      return result;
    })(),
    (async () => {
      const queryStartedAt = Date.now();
      const result = await client.query(
        `
          SELECT ${GAME_REQUESTS_HISTORY_COLUMNS}
          FROM public.player_game_requests_cache
          WHERE player_uid = $1 AND deleted_at IS NULL
          ORDER BY created_at DESC NULLS LAST
          LIMIT $2
        `,
        [playerUid, SELECTED_PLAYER_RECORD_QUERY_LIMIT]
      );
      routeTiming.each_query_ms.push(Date.now() - queryStartedAt);
      return result;
    })(),
    (async () => {
      const queryStartedAt = Date.now();
      const result = await client.query(
        `
          SELECT ${FINANCIAL_EVENTS_HISTORY_COLUMNS}
          FROM public.financial_events_cache
          WHERE player_uid = $1
            AND type = 'automatic_recharge_bonus'
            AND deleted_at IS NULL
          ORDER BY created_at DESC NULLS LAST
          LIMIT $2
        `,
        [playerUid, SELECTED_PLAYER_RECORD_QUERY_LIMIT]
      );
      routeTiming.each_query_ms.push(Date.now() - queryStartedAt);
      return result;
    })(),
  ]);

  return buildHistoryPayload(
    'postgres',
    [...financialEvents.rows, ...autoBonusEvents.rows],
    completedCashouts.rows,
    playerGameRequests.rows,
    callerCoadminUid
  );
}

async function getFirestoreHistory(playerUid: string, callerCoadminUid: string | null) {
  const [financialEventsSnap, completedCashoutSnap, playerGameRequestsSnap] = await Promise.all([
    adminDb
      .collection('financialEvents')
      .where('playerUid', '==', playerUid)
      .orderBy('createdAt', 'desc')
      .limit(SELECTED_PLAYER_RECORD_QUERY_LIMIT)
      .get(),
    adminDb
      .collection('playerCashoutTasks')
      .where('playerUid', '==', playerUid)
      .where('status', '==', 'completed')
      .orderBy('completedAt', 'desc')
      .limit(SELECTED_PLAYER_CASHOUT_QUERY_LIMIT)
      .get(),
    adminDb
      .collection('playerGameRequests')
      .where('playerUid', '==', playerUid)
      .orderBy('createdAt', 'desc')
      .limit(SELECTED_PLAYER_RECORD_QUERY_LIMIT)
      .get(),
  ]);

  return buildHistoryPayload(
    'firestore',
    financialEventsSnap.docs.map((docSnap) => ({
      firebase_id: docSnap.id,
      raw_firestore_data: docSnap.data() as Record<string, unknown>,
    })),
    completedCashoutSnap.docs.map((docSnap) => ({
      firebase_id: docSnap.id,
      raw_firestore_data: docSnap.data() as Record<string, unknown>,
    })),
    playerGameRequestsSnap.docs.map((docSnap) => ({
      firebase_id: docSnap.id,
      raw_firestore_data: docSnap.data() as Record<string, unknown>,
    })),
    callerCoadminUid
  );
}

function rowCount(payload: HistoryPayload) {
  return Object.values(payload.rows).reduce((total, rows) => total + rows.length, 0);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ playerUid: string }> }
) {
  const totalStartedAt = Date.now();
  const routeTiming = createRouteTiming();

  const authStartedAt = Date.now();
  const auth = await requireApiUser(request, ['admin', 'coadmin']);
  routeTiming.auth_ms = Date.now() - authStartedAt;
  if ('response' in auth) {
    routeTiming.total_ms = Date.now() - totalStartedAt;
    logRouteTiming(routeTiming, { reason: 'auth_response' });
    return auth.response;
  }

  const { playerUid: rawPlayerUid } = await params;
  const playerUid = cleanText(decodeURIComponent(rawPlayerUid || ''));
  if (!playerUid || playerUid.includes('/')) {
    routeTiming.total_ms = Date.now() - totalStartedAt;
    logRouteTiming(routeTiming, { reason: 'invalid_player_uid' });
    return apiError('Player uid is required.', 400);
  }

  const callerCoadminUid = auth.user.role === 'coadmin' ? auth.user.uid : null;
  const sqlReadMode = isCacheSqlAuthoritative();

  const clientAcquireStartedAt = Date.now();
  const acquired = await acquirePlayerMirrorClient({
    context: 'coadmin_player_history',
    route: '/api/coadmin/players/[playerUid]/history',
  });
  routeTiming.client_acquire_ms = Date.now() - clientAcquireStartedAt;
  routeTiming.sql_pool_ms = routeTiming.client_acquire_ms;
  routeTiming.shared_client = Boolean(acquired);
  const sharedClient = acquired?.client ?? null;

  try {
    if (callerCoadminUid) {
      const scopeStartedAt = Date.now();
      const inScope = await playerBelongsToCoadminScope(
        playerUid,
        callerCoadminUid,
        sharedClient,
        routeTiming
      );
      routeTiming.scope_check_ms = Date.now() - scopeStartedAt;
      if (!inScope) {
        routeTiming.total_ms = Date.now() - totalStartedAt;
        logRouteTiming(routeTiming, { reason: 'forbidden', playerUid });
        return apiError('Forbidden.', 403);
      }
    }

    if (sharedClient) {
      try {
        const postgresPayload = await getPostgresHistory(
          playerUid,
          callerCoadminUid,
          sharedClient,
          routeTiming
        );
        console.info('[COADMIN_PLAYER_HISTORY] postgres hit', {
          playerUid,
          rowCount: rowCount(postgresPayload),
        });

        if (rowCount(postgresPayload) === 0 && sqlReadMode) {
          logCacheFirestoreFallbackBlocked(ROUTE, 'financialEvents,playerCashoutTasks,playerGameRequests', {
            playerUid,
            reason: 'postgres_empty',
          });
        }

        return timedJson(postgresPayload, totalStartedAt, routeTiming, {
          playerUid,
          source: 'postgres',
        });
      } catch (error) {
        if (sqlReadMode) {
          logCacheFirestoreFallbackBlocked(ROUTE, 'financialEvents,playerCashoutTasks,playerGameRequests', {
            playerUid,
            reason: 'postgres_read_failed',
          });
          return timedJson(
            {
              source: 'postgres',
              coadminAddedCoinTotal: 0,
              cashoutTotalAmount: 0,
              rows: baseRows(),
              error: 'Failed to load player history from SQL cache.',
            },
            totalStartedAt,
            routeTiming,
            { playerUid, source: 'postgres', reason: 'postgres_read_failed' },
            { status: 503 }
          );
        }
        console.info('[COADMIN_PLAYER_HISTORY] postgres fallback firestore', {
          playerUid,
          reason: 'postgres_read_failed',
          error,
        });
      }
    } else if (sqlReadMode) {
      logCacheFirestoreFallbackBlocked(ROUTE, 'financialEvents,playerCashoutTasks,playerGameRequests', {
        playerUid,
        reason: 'postgres_unavailable',
      });
      return timedJson(
        {
          source: 'postgres',
          coadminAddedCoinTotal: 0,
          cashoutTotalAmount: 0,
          rows: baseRows(),
          error: 'SQL cache is unavailable.',
        },
        totalStartedAt,
        routeTiming,
        { playerUid, source: 'postgres', reason: 'postgres_unavailable' },
        { status: 503 }
      );
    } else {
      console.info('[COADMIN_PLAYER_HISTORY] postgres fallback firestore', {
        playerUid,
        reason: 'postgres_unavailable',
      });
    }
  } finally {
    sharedClient?.release();
  }

  if (sqlReadMode) {
    logCacheFirestoreFallbackBlocked(ROUTE, 'financialEvents,playerCashoutTasks,playerGameRequests', {
      playerUid,
      reason: 'sql_cache_authoritative',
    });
    return timedJson(
      {
        source: 'postgres',
        coadminAddedCoinTotal: 0,
        cashoutTotalAmount: 0,
        rows: baseRows(),
      },
      totalStartedAt,
      routeTiming,
      { playerUid, source: 'postgres', reason: 'sql_cache_authoritative' }
    );
  }

  const fallbackStartedAt = Date.now();
  routeTiming.firebaseFallback = true;
  routeTiming.row_width_mode = 'wide';
  try {
    const firestorePayload = await getFirestoreHistory(playerUid, callerCoadminUid);
    routeTiming.fallback_check_ms = Date.now() - fallbackStartedAt;
    return timedJson(firestorePayload, totalStartedAt, routeTiming, {
      playerUid,
      source: 'firestore',
    });
  } catch (error) {
    routeTiming.fallback_check_ms = Date.now() - fallbackStartedAt;
    console.warn('[COADMIN_PLAYER_HISTORY] firestore fallback failed', {
      playerUid,
      error,
    });
    return timedJson(
      {
        source: 'firestore',
        coadminAddedCoinTotal: 0,
        cashoutTotalAmount: 0,
        rows: baseRows(),
        error: 'Failed to load player history.',
      },
      totalStartedAt,
      routeTiming,
      { playerUid, source: 'firestore', reason: 'firestore_read_failed' },
      { status: 200 }
    );
  }
}
