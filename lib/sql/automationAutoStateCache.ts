import 'server-only';

import type { DocumentSnapshot } from 'firebase-admin/firestore';
import type { PoolClient } from 'pg';

import { AUTOMATION_AUTO_STATE_COLLECTION } from '@/features/automation/automationAutoState';
import { adminDb } from '@/lib/firebase/admin';
import {
  API_ROUTE_SLOW_MS,
  debugLog,
  isAppDebugLoggingEnabled,
} from '@/lib/server/verboseLogs';
import {
  cleanText,
  getPlayerMirrorPool,
  isPgPoolExhaustedError,
  normalizeJson,
  runMirrorPoolQuery,
  type PlayerMirrorSqlTiming,
  toIsoString,
} from '@/lib/sql/playerMirrorCommon';

function booleanOrFalse(value: unknown) {
  return value === true;
}

async function lookupCoadminUidForCarer(carerUid: string) {
  const db = getPlayerMirrorPool();
  const cleanUid = cleanText(carerUid);
  if (!db || !cleanUid) {
    return null;
  }
  try {
    const result = await db.query(
      `
        SELECT coadmin_uid, created_by
        FROM public.players_cache
        WHERE uid = $1
          AND deleted_at IS NULL
        LIMIT 1
      `,
      [cleanUid]
    );
    const row = result.rows[0] as { coadmin_uid?: unknown; created_by?: unknown } | undefined;
    if (!row) {
      return null;
    }
    return cleanText(row.coadmin_uid) || cleanText(row.created_by) || null;
  } catch {
    return null;
  }
}

export type AutomationAutoStateSqlLookup = {
  carerUid: string;
  coadminUid: string | null;
  enabled: boolean;
  automationAgentId: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
};

export type AutomationAutoStateSqlLookupResult = {
  state: AutomationAutoStateSqlLookup | null;
  timing: PlayerMirrorSqlTiming;
  missReason: 'row_missing' | 'postgres_unavailable' | 'pool_exhausted' | 'lookup_failed' | null;
};

export type AutomationAutoTickLeaseSqlResult =
  | { ok: true; timing: PlayerMirrorSqlTiming }
  | {
      ok: false;
      reason:
        | 'STATE_GONE'
        | 'DISABLED'
        | 'LEASE_HELD'
        | 'lookup_failed'
        | 'pool_exhausted'
        | 'postgres_unavailable';
      timing: PlayerMirrorSqlTiming;
    };

function leaseExpired(leaseExpiresAt: string | null) {
  if (!leaseExpiresAt) {
    return true;
  }
  const expiresMs = Date.parse(leaseExpiresAt);
  if (!Number.isFinite(expiresMs)) {
    return true;
  }
  return expiresMs <= Date.now();
}

export async function upsertAutomationAutoStateCache(
  carerUid: string,
  data: Record<string, unknown>,
  source = 'appbeg',
  coadminUid?: string | null
) {
  const db = getPlayerMirrorPool();
  const cleanCarerUid = cleanText(carerUid);
  if (!db || !cleanCarerUid) {
    return false;
  }

  const resolvedCoadminUid =
    cleanText(coadminUid) ||
    cleanText(data.coadminUid) ||
    (await lookupCoadminUidForCarer(cleanCarerUid));
  const enabled = booleanOrFalse(data.enabled);
  const leaseOwner = cleanText(data.tickLeaseHolderId);
  const leaseExpiresAt = toIsoString(data.tickLeaseExpiresAt);
  const automationAgentId = cleanText(data.automationAgentId);

  try {
    await db.query(
      `
        INSERT INTO public.automation_auto_state_cache (
          carer_uid, coadmin_uid, enabled, automation_agent_id, lease_owner,
          lease_expires_at, updated_at, raw_firestore_data, source, mirrored_at, deleted_at
        )
        VALUES (
          $1, NULLIF($2::text, ''), $3::boolean, NULLIF($4::text, ''), NULLIF($5::text, ''),
          $6::timestamptz, $7::timestamptz, $8::jsonb, $9::text, now(), NULL
        )
        ON CONFLICT (carer_uid) DO UPDATE SET
          coadmin_uid = EXCLUDED.coadmin_uid,
          enabled = EXCLUDED.enabled,
          automation_agent_id = EXCLUDED.automation_agent_id,
          lease_owner = EXCLUDED.lease_owner,
          lease_expires_at = EXCLUDED.lease_expires_at,
          updated_at = EXCLUDED.updated_at,
          raw_firestore_data = EXCLUDED.raw_firestore_data,
          source = EXCLUDED.source,
          mirrored_at = now(),
          deleted_at = NULL
      `,
      [
        cleanCarerUid,
        resolvedCoadminUid,
        enabled,
        automationAgentId,
        leaseOwner,
        leaseExpiresAt,
        toIsoString(data.updatedAt),
        JSON.stringify(normalizeJson(data) || {}),
        source,
      ]
    );
    console.info('[AUTOMATION_AUTO_STATE_CACHE] mirror upsert ok', { carerUid: cleanCarerUid });
    console.info('[AUTOMATION_AUTO_STATE_SET]', {
      carerUid: cleanCarerUid,
      coadminUid: resolvedCoadminUid,
      enabled,
      automationAgentId: automationAgentId || null,
      source,
    });
    return true;
  } catch (error) {
    console.error('[AUTOMATION_AUTO_STATE_CACHE] mirror failed', {
      carerUid: cleanCarerUid,
      error,
    });
    return false;
  }
}

export async function mirrorAutomationAutoStateSnapshot(
  snap: DocumentSnapshot,
  source = 'appbeg',
  coadminUid?: string | null
) {
  if (!snap.exists) {
    return false;
  }
  return upsertAutomationAutoStateCache(
    snap.id,
    (snap.data() || {}) as Record<string, unknown>,
    source,
    coadminUid
  );
}

export async function mirrorAutomationAutoStateById(carerUid: string, source = 'appbeg') {
  const cleanCarerUid = cleanText(carerUid);
  if (!cleanCarerUid) {
    return false;
  }
  try {
    const snap = await adminDb.collection(AUTOMATION_AUTO_STATE_COLLECTION).doc(cleanCarerUid).get();
    if (!snap.exists) {
      return false;
    }
    const coadminUid = await lookupCoadminUidForCarer(cleanCarerUid);
    return mirrorAutomationAutoStateSnapshot(snap, source, coadminUid);
  } catch (error) {
    console.error('[AUTOMATION_AUTO_STATE_CACHE] mirror failed', { carerUid: cleanCarerUid, error });
    return false;
  }
}

export async function listEnabledAutomationCarersForCoadmin(
  coadminUid: string
): Promise<AutomationAutoStateSqlLookup[]> {
  const cleanCoadminUid = cleanText(coadminUid);
  const db = getPlayerMirrorPool();
  if (!db || !cleanCoadminUid) {
    return [];
  }

  try {
    const result = await db.query(
      `
        SELECT carer_uid, coadmin_uid, enabled, automation_agent_id, lease_owner, lease_expires_at
        FROM public.automation_auto_state_cache
        WHERE deleted_at IS NULL
          AND enabled = true
          AND (
            coadmin_uid = $1
            OR coadmin_uid IS NULL
            OR coadmin_uid = ''
          )
        ORDER BY updated_at DESC NULLS LAST, carer_uid ASC
      `,
      [cleanCoadminUid]
    );

    const enabledCarers: AutomationAutoStateSqlLookup[] = [];
    for (const row of result.rows) {
      const record = row as Record<string, unknown>;
      const carerUid = cleanText(record.carer_uid);
      if (!carerUid) {
        continue;
      }
      const rowCoadminUid = cleanText(record.coadmin_uid);
      if (rowCoadminUid && rowCoadminUid !== cleanCoadminUid) {
        continue;
      }
      enabledCarers.push({
        carerUid,
        coadminUid: rowCoadminUid || cleanCoadminUid,
        enabled: record.enabled === true,
        automationAgentId: cleanText(record.automation_agent_id) || null,
        leaseOwner: cleanText(record.lease_owner) || null,
        leaseExpiresAt: toIsoString(record.lease_expires_at),
      });
    }
    return enabledCarers;
  } catch (error) {
    console.error('[AUTOMATION_AUTO_STATE_CACHE] list enabled carers failed', {
      coadminUid: cleanCoadminUid,
      error,
    });
    return [];
  }
}

export async function lookupAutomationAutoStateFromSqlCache(
  carerUid: string
): Promise<AutomationAutoStateSqlLookupResult> {
  const startedAt = Date.now();
  const cleanCarerUid = cleanText(carerUid);
  const db = getPlayerMirrorPool();
  if (!db || !cleanCarerUid) {
    const timing = {
      pool_acquire_ms: 0,
      query_exec_ms: 0,
      total_ms: Date.now() - startedAt,
    };
    console.warn(
      '[AUTO_TICK_STATE_SQL] hit=false carerUid=%s reason=%s',
      cleanCarerUid || null,
      'postgres_unavailable'
    );
    return { state: null, timing, missReason: 'postgres_unavailable' };
  }

  const stateSql = `
    SELECT carer_uid, coadmin_uid, enabled, automation_agent_id, lease_owner, lease_expires_at
    FROM public.automation_auto_state_cache
    WHERE carer_uid = $1
      AND deleted_at IS NULL
    LIMIT 1
  `;

  try {
    const { rows, timing } = await runMirrorPoolQuery<Record<string, unknown>>(db, stateSql, [
      cleanCarerUid,
    ]);

    if (!rows.length) {
      debugLog('[AUTO_TICK_STATE_SQL]', {
        hit: false,
        carerUid: cleanCarerUid,
        reason: 'row_missing',
        pool_acquire_ms: timing.pool_acquire_ms,
        query_exec_ms: timing.query_exec_ms,
        total_ms: timing.total_ms,
      });
      return { state: null, timing, missReason: 'row_missing' };
    }

    const row = rows[0];
    const leaseExpiresAt = toIsoString(row.lease_expires_at);
    const leaseOwner = cleanText(row.lease_owner) || null;
    const state = {
      carerUid: cleanText(row.carer_uid) || cleanCarerUid,
      coadminUid: cleanText(row.coadmin_uid) || null,
      enabled: row.enabled === true,
      automationAgentId: cleanText(row.automation_agent_id) || null,
      leaseOwner,
      leaseExpiresAt,
    } satisfies AutomationAutoStateSqlLookup;

    if (isAppDebugLoggingEnabled() || timing.total_ms >= API_ROUTE_SLOW_MS) {
      console.info(
        '[AUTO_TICK_STATE_SQL] hit=true carerUid=%s enabled=%s leaseExpired=%s total_ms=%s',
        state.carerUid,
        state.enabled,
        leaseExpired(leaseExpiresAt),
        timing.total_ms
      );
    }
    return { state, timing, missReason: null };
  } catch (error) {
    const timing = {
      pool_acquire_ms: 0,
      query_exec_ms: 0,
      total_ms: Date.now() - startedAt,
    };
    const missReason = isPgPoolExhaustedError(error) ? 'pool_exhausted' : 'lookup_failed';
    console.warn(
      '[AUTO_TICK_STATE_SQL] hit=false carerUid=%s reason=%s error=%s',
      cleanCarerUid,
      missReason,
      error instanceof Error ? error.message : String(error)
    );
    return { state: null, timing, missReason };
  }
}

export async function acquireAutomationAutoTickLeaseSql(
  carerUid: string,
  instanceId: string,
  leaseTtlMs: number,
  options?: { allowDisabledLease?: boolean }
): Promise<AutomationAutoTickLeaseSqlResult> {
  const startedAt = Date.now();
  const cleanCarerUid = cleanText(carerUid);
  const cleanInstanceId = cleanText(instanceId);
  const db = getPlayerMirrorPool();
  if (!db || !cleanCarerUid || !cleanInstanceId) {
    return {
      ok: false,
      reason: 'postgres_unavailable',
      timing: {
        pool_acquire_ms: 0,
        query_exec_ms: 0,
        total_ms: Date.now() - startedAt,
      },
    };
  }

  const acquireStartedAt = Date.now();
  let client: PoolClient;
  try {
    client = await db.connect();
  } catch (error) {
    const reason = isPgPoolExhaustedError(error) ? 'pool_exhausted' : 'lookup_failed';
    console.warn('[AUTOMATION_AUTO_STATE_CACHE] lease connect failed', {
      carerUid: cleanCarerUid,
      instanceId: cleanInstanceId,
      reason,
      error: error instanceof Error ? error.message : String(error),
      totalCount: db.totalCount,
      idleCount: db.idleCount,
      waitingCount: db.waitingCount,
    });
    return {
      ok: false,
      reason,
      timing: {
        pool_acquire_ms: Date.now() - acquireStartedAt,
        query_exec_ms: 0,
        total_ms: Date.now() - startedAt,
      },
    };
  }
  const pool_acquire_ms = Date.now() - acquireStartedAt;
  const queryStartedAt = Date.now();

  try {
    await client.query('BEGIN');
    const locked = await client.query(
      `
        SELECT enabled, lease_owner, lease_expires_at, raw_firestore_data
        FROM public.automation_auto_state_cache
        WHERE carer_uid = $1
          AND deleted_at IS NULL
        FOR UPDATE
      `,
      [cleanCarerUid]
    );
    const query_exec_ms = Date.now() - queryStartedAt;
    const timing = {
      pool_acquire_ms,
      query_exec_ms,
      total_ms: Date.now() - startedAt,
    };

    if (!locked.rows.length) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'STATE_GONE', timing };
    }

    const row = locked.rows[0] as Record<string, unknown>;
    if (row.enabled !== true && options?.allowDisabledLease !== true) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'DISABLED', timing };
    }

    const holder = cleanText(row.lease_owner);
    const leaseExpiresAt = toIsoString(row.lease_expires_at);
    const expiresMs = leaseExpiresAt ? Date.parse(leaseExpiresAt) : 0;
    if (holder && holder !== cleanInstanceId && Number.isFinite(expiresMs) && expiresMs > Date.now()) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'LEASE_HELD', timing };
    }

    const nextExpiresAt = new Date(Date.now() + leaseTtlMs).toISOString();
    const raw =
      row.raw_firestore_data && typeof row.raw_firestore_data === 'object' && !Array.isArray(row.raw_firestore_data)
        ? { ...(row.raw_firestore_data as Record<string, unknown>) }
        : {};
    raw.tickLeaseHolderId = cleanInstanceId;
    raw.tickLeaseExpiresAt = nextExpiresAt;

    await client.query(
      `
        UPDATE public.automation_auto_state_cache
        SET
          lease_owner = $2,
          lease_expires_at = $3::timestamptz,
          updated_at = now(),
          mirrored_at = now(),
          raw_firestore_data = $4::jsonb
        WHERE carer_uid = $1
          AND deleted_at IS NULL
      `,
      [cleanCarerUid, cleanInstanceId, nextExpiresAt, JSON.stringify(normalizeJson(raw) || {})]
    );
    await client.query('COMMIT');
    if (isAppDebugLoggingEnabled() || timing.total_ms >= API_ROUTE_SLOW_MS) {
      console.info(
        '[AUTO_TICK_LEASE_SQL] carerUid=%s lease_acquired=true total_ms=%s',
        cleanCarerUid,
        timing.total_ms
      );
    }
    return { ok: true, timing };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    console.error('[AUTOMATION_AUTO_STATE_CACHE] lease failed', {
      carerUid: cleanCarerUid,
      instanceId: cleanInstanceId,
      error,
    });
    return {
      ok: false,
      reason: 'lookup_failed',
      timing: {
        pool_acquire_ms,
        query_exec_ms: Date.now() - queryStartedAt,
        total_ms: Date.now() - startedAt,
      },
    };
  } finally {
    client.release();
  }
}

export async function disableAutomationAutoStateSql(
  carerUid: string,
  reason: string,
  source = 'appbeg_automation_quota'
) {
  const db = getPlayerMirrorPool();
  const cleanCarerUid = cleanText(carerUid);
  if (!db || !cleanCarerUid) {
    return false;
  }
  try {
    await db.query(
      `
        UPDATE public.automation_auto_state_cache
        SET
          enabled = FALSE,
          updated_at = now(),
          mirrored_at = now(),
          raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb)
            || jsonb_build_object(
              'enabled', false,
              'autoDisabledReason', $2::text
            )
        WHERE carer_uid = $1
          AND deleted_at IS NULL
      `,
      [cleanCarerUid, reason]
    );
    return true;
  } catch (error) {
    console.error('[AUTOMATION_AUTO_STATE_CACHE] disable failed', { carerUid: cleanCarerUid, error });
    return false;
  }
}
