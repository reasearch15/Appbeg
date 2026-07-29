import { FieldValue, type DocumentReference } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import {
  mapTaskType,
  resolveAutomationAccessFields,
  resolveTaskTypeLabel,
} from '@/lib/automation/automationClaimPayload';
import {
  isSingleSessionAutomationGame,
  normalizeAutomationGameKey,
} from '@/lib/automation/singleSessionGames';
import {
  claimCarerTaskAsAdmin,
  resolveCurrentUsernameForTask,
  resolveGameLoginDetailsForCoadminGame,
} from '@/lib/automation/carerClaimTaskAdmin';
import { AUTOMATION_AUTO_STATE_COLLECTION } from '@/features/automation/automationAutoState';
import { verifyAutoTickBrowserToken } from '@/lib/automation/autoTickBrowserToken';
import {
  apiError,
  requireCarerApiUser,
  type ApiUser,
  type ApiUserAuthPath,
} from '@/lib/firebase/apiAuth';
import { isAuthSqlReadEnabled } from '@/lib/server/authSqlRead';
import { isAuthoritySqlWriteEnabled } from '@/lib/server/authoritySqlWrite';
import { logAuthorityAutoTickDb } from '@/lib/server/authoritySchemaAudit';
import { logFirestoreTouch } from '@/lib/server/firestoreTouchAudit';
import {
  acquireAutomationAutoTickLeaseSql,
  disableAutomationAutoStateSql,
  lookupAutomationAutoStateFromSqlCache,
  mirrorAutomationAutoStateById,
  mirrorAutomationAutoStateSnapshot,
} from '@/lib/sql/automationAutoStateCache';
import {
  getCarerActiveSingleSessionTaskFromSql,
  getPendingCarerTaskCandidatesFromSql,
  hasAutoTickTaskRecheckFields,
  lookupAutoTickTaskRecheckFromSql,
  mirrorCarerTaskById,
  type AutoTickPendingTaskCandidate,
} from '@/lib/sql/carerTasksCache';
import { getPlayerMirrorPool } from '@/lib/sql/playerMirrorCommon';
import {

  lookupApiUserProfileFromSqlCache,
  mirrorPlayerById,
} from '@/lib/sql/playersCache';
import {
  API_ROUTE_SLOW_MS,
  debugLog,
  isAppDebugLoggingEnabled,
} from '@/lib/server/verboseLogs';

export const runtime = 'nodejs';

const LEASE_TTL_MS = 70_000;
const MAX_CLAIMS_PER_TICK = 1;
const PENDING_QUERY_LIMIT = 15;

function logAutoTickTiming(step: string, startedAt: number, details: Record<string, unknown> = {}) {
  const durationMs = Date.now() - startedAt;
  if (!isAppDebugLoggingEnabled() && durationMs < API_ROUTE_SLOW_MS) {
    return;
  }
  console.info(`[AUTO_TICK_TIMING] ${step} durationMs=%s`, durationMs, details);
}

function isAgentSupportedAutomationType(value: string) {
  return (
    value === 'CREATE_USERNAME' ||
    value === 'RESET_PASSWORD' ||
    value === 'RECHARGE' ||
    value === 'REDEEM'
  );
}

async function countAutoTickDispatchRows(coadminUid: string, carerUid: string) {
  const db = getPlayerMirrorPool();
  if (!db) {
    return { pendingCount: null, activeCount: null };
  }
  try {
    const result = await db.query<{
      pending_count: string | number | null;
      active_count: string | number | null;
    }>(
      `
        SELECT
          COUNT(*) FILTER (
            WHERE status = 'pending'
              AND COALESCE(assigned_carer_uid, '') = ''
              AND COALESCE(claimed_by_uid, '') = ''
              AND COALESCE(automation_job_id, '') = ''
          ) AS pending_count,
          COUNT(*) FILTER (
            WHERE status = 'in_progress'
              AND (
                assigned_carer_uid = $2
                OR claimed_by_uid = $2
              )
          ) AS active_count
        FROM public.carer_tasks_cache
        WHERE deleted_at IS NULL
          AND coadmin_uid = $1
      `,
      [coadminUid, carerUid]
    );
    const row = result.rows[0];
    return {
      pendingCount: Number(row?.pending_count || 0),
      activeCount: Number(row?.active_count || 0),
    };
  } catch (error) {
    console.warn('[DISPATCH_COUNT_FAILED]', {
      route: '/api/carer/automation-auto-tick',
      coadminUid,
      carerUid,
      error: error instanceof Error ? error.message : String(error),
    });
    return { pendingCount: null, activeCount: null };
  }
}

function validateAutomationAgentId(agentId: string): {
  valid: boolean;
  normalized?: string;
} {
  const trimmed = String(agentId || '').trim();
  if (!trimmed || trimmed.length > 64) {
    return { valid: false };
  }
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(trimmed)) {
    return { valid: false };
  }
  return { valid: true, normalized: trimmed };
}

type AutoTickCarerProfile = {
  username: string;
  coadminUid: string;
  automationAgentId: string;
};

type AutoTickAuthSource = 'api_user_sql' | 'api_user_sql_session_sql' | 'firestore_fallback';

function mapAutoTickAuthSource(authPath: ApiUserAuthPath | null): AutoTickAuthSource {
  if (
    authPath === 'api_user_sql' ||
    authPath === 'carer_token_sql' ||
    authPath === 'carer_app_session_sql' ||
    authPath === 'app_session_sql'
  ) {
    return 'api_user_sql';
  }
  if (authPath === 'api_user_sql_session_sql' || authPath === 'app_session_sql_session_sql') {
    return 'api_user_sql_session_sql';
  }
  return 'firestore_fallback';
}

function carerProfileFieldsFromApiUser(user: ApiUser) {
  return {
    role: user.role,
    username: String(user.username || '').trim(),
    coadminUid: String(user.coadminUid || user.createdBy || '').trim(),
    automationAgentId: String(user.automationAgentId || '').trim(),
  };
}

function carerProfileFromSqlProfile(profile: {
  role: string;
  username: string;
  coadminUid: string | null;
  createdBy: string | null;
  automationAgentId: string | null;
}): AutoTickCarerProfile {
  return {
    username: String(profile.username || '').trim(),
    coadminUid: String(profile.coadminUid || profile.createdBy || '').trim(),
    automationAgentId: String(profile.automationAgentId || '').trim(),
  };
}

function hasAutoTickCarerProfileFields(fields: {
  role: string;
  coadminUid: string;
  automationAgentId: string;
}) {
  return (
    String(fields.role || '').toLowerCase() === 'carer' &&
    Boolean(fields.coadminUid) &&
    Boolean(fields.automationAgentId)
  );
}

async function resolveAutoTickCarerProfile(params: {
  carerUid: string;
  authUser: ApiUser | null;
  authPath: ApiUserAuthPath | null;
}): Promise<
  | { ok: true; profile: AutoTickCarerProfile; authSource: AutoTickAuthSource }
  | { ok: false; response: NextResponse }
> {
  const { carerUid, authUser, authPath } = params;
  const userReadStartedAt = Date.now();

  if (authUser) {
    const fields = carerProfileFieldsFromApiUser(authUser);
    if (!hasAutoTickCarerProfileFields(fields)) {
      logAutoTickTiming('user_read_fallback', userReadStartedAt, {
        carerUid,
        reason: 'missing_field',
        missingAutomationAgentId: !fields.automationAgentId,
        missingCoadminUid: !fields.coadminUid,
        role: fields.role,
      });
    } else {
      logAutoTickTiming('user_read', userReadStartedAt, {
        carerUid,
        skipped: true,
        source: authPath === 'api_user_sql' ? 'auth_sql' : 'auth_user',
        durationMs: 0,
      });
      const authSource = mapAutoTickAuthSource(authPath);
      debugLog('[AUTO_TICK_AUTH_SOURCE]', { source: authSource, authPath });
      return {
        ok: true,
        profile: {
          username: fields.username,
          coadminUid: fields.coadminUid,
          automationAgentId: fields.automationAgentId,
        },
        authSource,
      };
    }
  }

  const sqlLookup = await lookupApiUserProfileFromSqlCache(carerUid);
  if (sqlLookup.profile) {
    const fields = {
      role: sqlLookup.profile.role,
      coadminUid: String(sqlLookup.profile.coadminUid || sqlLookup.profile.createdBy || '').trim(),
      automationAgentId: String(sqlLookup.profile.automationAgentId || '').trim(),
    };
    if (hasAutoTickCarerProfileFields(fields)) {
      logAutoTickTiming('user_read', userReadStartedAt, {
        carerUid,
        skipped: true,
        source: 'sql_cache',
        durationMs: Date.now() - userReadStartedAt,
      });
      debugLog('[AUTO_TICK_AUTH_SOURCE]', { source: 'api_user_sql', authPath });
      return {
        ok: true,
        profile: carerProfileFromSqlProfile(sqlLookup.profile),
        authSource: 'api_user_sql',
      };
    }
    logAutoTickTiming('user_read_fallback', userReadStartedAt, {
      carerUid,
      reason: 'missing_field',
      sqlRole: sqlLookup.profile.role,
      missingAutomationAgentId: !fields.automationAgentId,
      missingCoadminUid: !fields.coadminUid,
    });
  } else if (sqlLookup.missReason) {
    logAutoTickTiming('user_read_fallback', userReadStartedAt, {
      carerUid,
      reason: 'sql_miss',
      missReason: sqlLookup.missReason,
    });
  }

  if (isAuthSqlReadEnabled()) {
    const reason = sqlLookup.missReason || 'row_missing';
    console.info('[AUTO_TICK_AUTH_SOURCE] source=sql_blocked authPath=%s firestore_fallback=false reason=%s', authPath, reason);
    if (reason === 'postgres_unavailable' || reason === 'lookup_failed') {
      return {
        ok: false,
        response: apiError('SQL auth is unavailable. Configure DATABASE_URL on the server.', 503),
      };
    }
    return { ok: false, response: apiError('Carer profile not found in SQL cache.', 404) };
  }

  logFirestoreTouch({
    firestore_touch_type: 'legacy_read_remove_now',
    route: '/api/carer/automation-auto-tick',
    operation: 'read',
    collection: 'users',
    document_id: carerUid,
    sql_read_mode: false,
    details: { context: 'resolveAutoTickCarerProfile' },
  });
  const userSnap = await adminDb.collection('users').doc(carerUid).get();
  logAutoTickTiming('user_read', userReadStartedAt, {
    carerUid,
    exists: userSnap.exists,
    skipped: false,
    durationMs: Date.now() - userReadStartedAt,
  });
  if (!userSnap.exists) {
    return { ok: false, response: apiError('User not found.', 404) };
  }

  const userData = userSnap.data() as {
    automationAgentId?: string | null;
    username?: string | null;
    role?: string | null;
    coadminUid?: string | null;
    createdBy?: string | null;
  };
  if (String(userData.role || '').toLowerCase() !== 'carer') {
    return {
      ok: false,
      response: apiError('Automation auto-tick is only available for carer accounts.', 403),
    };
  }

  try {
    await mirrorPlayerById(carerUid, 'automation_auto_tick_hydrate');
  } catch (error) {
    logAutoTickTiming('user_read_fallback', userReadStartedAt, {
      carerUid,
      reason: 'hydrate_failed',
      error: error instanceof Error ? error.message : String(error),
    });
  }

  console.info('[AUTO_TICK_AUTH_SOURCE] source=%s authPath=%s', 'firestore_fallback', authPath);
  return {
    ok: true,
    profile: {
      username: String(userData.username || '').trim(),
      coadminUid:
        String(userData.coadminUid || '').trim() || String(userData.createdBy || '').trim(),
      automationAgentId: String(userData.automationAgentId || '').trim(),
    },
    authSource: 'firestore_fallback',
  };
}

type AutoTickStateTiming = {
  state_source: 'sql' | 'firestore';
  state_sql_ms: number;
  state_doc_ms: number;
  lease_source: 'sql' | 'firestore' | 'skipped';
  lease_sql_ms: number;
  lease_transaction_ms: number;
};

function createAutoTickStateTiming(): AutoTickStateTiming {
  return {
    state_source: 'firestore',
    state_sql_ms: 0,
    state_doc_ms: 0,
    lease_source: 'skipped',
    lease_sql_ms: 0,
    lease_transaction_ms: 0,
  };
}

function logAutoTickSources(input: {
  carerUid: string;
  auto_state_source?: 'sql' | 'firestore';
  pending_source?: 'sql' | 'firestore';
  recheck_source?: 'candidate' | 'sql' | 'firestore' | 'none';
  lease_source?: 'sql' | 'firestore' | 'skipped';
  lease_acquired?: boolean;
  firestore_fallback: boolean;
  details?: Record<string, unknown>;
}) {
  if (
    !isAppDebugLoggingEnabled() &&
    !input.firestore_fallback &&
    input.lease_acquired !== false &&
    !input.details?.error
  ) {
    return;
  }
  debugLog('[AUTO_TICK_SOURCES]', {
    carerUid: input.carerUid,
    auto_state_source: input.auto_state_source ?? null,
    pending_source: input.pending_source ?? null,
    recheck_source: input.recheck_source ?? null,
    lease_source: input.lease_source ?? null,
    lease_acquired: input.lease_acquired ?? null,
    firestore_fallback: input.firestore_fallback,
    ...(input.details || {}),
  });
}

function logAutoTickLease(input: {
  carerUid: string;
  coadminUid: string;
  instanceId: string;
  lease_source: 'sql' | 'firestore' | 'skipped';
  lease_acquired: boolean;
  firestore_fallback: boolean;
  emergency_fallback?: boolean;
  lease_sql_ms?: number;
  lease_transaction_ms?: number;
  error?: string | null;
  skipped?: boolean;
  mode?: string;
}) {
  const leaseMs = Math.max(input.lease_sql_ms ?? 0, input.lease_transaction_ms ?? 0);
  const interesting =
    isAppDebugLoggingEnabled() ||
    input.firestore_fallback ||
    input.emergency_fallback === true ||
    !input.lease_acquired ||
    Boolean(input.error) ||
    leaseMs >= API_ROUTE_SLOW_MS;
  if (!interesting) {
    return;
  }
  logAutoTickSources({
    carerUid: input.carerUid,
    lease_source: input.lease_source,
    lease_acquired: input.lease_acquired,
    firestore_fallback: input.firestore_fallback,
    details: {
      instanceId: input.instanceId,
      coadminUid: input.coadminUid,
      emergency_fallback: input.emergency_fallback ?? false,
      lease_sql_ms: input.lease_sql_ms ?? 0,
      lease_transaction_ms: input.lease_transaction_ms ?? 0,
      error: input.error ?? null,
      skipped: input.skipped ?? false,
      mode: input.mode ?? null,
    },
  });
  console.info(
    '[AUTO_TICK_LEASE] carerUid=%s instanceId=%s lease_source=%s lease_acquired=%s firestore_fallback=%s error=%s',
    input.carerUid,
    input.instanceId,
    input.lease_source,
    input.lease_acquired,
    input.firestore_fallback,
    input.error ?? '-'
  );
}

async function acquireAutomationAutoTickLeaseFirestore(
  stateRef: DocumentReference,
  instanceId: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (isAuthSqlReadEnabled()) {
    console.info('[AUTO_TICK_LEASE] firestore lease blocked', {
      carerUid: stateRef.id,
      instanceId,
      reason: 'sql_read_mode',
      firestore_fallback: false,
    });
    return { ok: false, reason: 'SQL_READ_MODE' };
  }

  logFirestoreTouch({
    firestore_touch_type: 'authority_write_keep_for_now',
    route: '/api/carer/automation-auto-tick',
    operation: 'transaction',
    collection: AUTOMATION_AUTO_STATE_COLLECTION,
    document_id: stateRef.id,
    skipped: false,
    sql_read_mode: isAuthSqlReadEnabled(),
    details: { context: 'tick_lease', instanceId },
  });
  try {
    await adminDb.runTransaction(async (tx) => {
      const snap = await tx.get(stateRef);
      if (!snap.exists) {
        throw new Error('STATE_GONE');
      }
      const d = snap.data() as {
        enabled?: boolean;
        tickLeaseHolderId?: string;
        tickLeaseExpiresAt?: { toMillis?: () => number } | null;
      };
      if (!d.enabled) {
        throw new Error('DISABLED');
      }
      const now = Date.now();
      const exp =
        typeof d.tickLeaseExpiresAt?.toMillis === 'function'
          ? d.tickLeaseExpiresAt.toMillis()
          : 0;
      const holder = String(d.tickLeaseHolderId || '');
      if (holder && holder !== instanceId && exp > now) {
        throw new Error('LEASE_HELD');
      }
      tx.update(stateRef, {
        tickLeaseHolderId: instanceId,
        tickLeaseExpiresAt: new Date(now + LEASE_TTL_MS),
        automationTickLastAt: FieldValue.serverTimestamp(),
      });
    });
    void mirrorAutomationAutoStateById(stateRef.id, 'automation_auto_tick_lease_hydrate');
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

async function resolveAutomationAutoTickState(
  carerUid: string,
  stateRef: DocumentReference | null,
  stateTiming: AutoTickStateTiming
): Promise<
  | {
      ok: true;
      enabled: boolean;
      stateExists: boolean;
      stateCoadminUidIgnored: string | null;
      usedSqlState: boolean;
    }
  | { ok: false; response: NextResponse }
> {
  const stateReadStartedAt = Date.now();
  const sqlStateLookup = await lookupAutomationAutoStateFromSqlCache(carerUid);
  stateTiming.state_sql_ms = Date.now() - stateReadStartedAt;

  if (sqlStateLookup.state) {
    stateTiming.state_source = 'sql';
    logAutoTickSources({
      carerUid,
      auto_state_source: 'sql',
      firestore_fallback: false,
      details: {
        enabled: sqlStateLookup.state.enabled,
        state_sql_ms: stateTiming.state_sql_ms,
      },
    });
    logAutoTickTiming('state_read', stateReadStartedAt, {
      carerUid,
      exists: true,
      state_source: stateTiming.state_source,
      state_sql_ms: stateTiming.state_sql_ms,
      state_doc_ms: 0,
      enabled: sqlStateLookup.state.enabled,
      firestore_fallback: false,
    });
    debugLog('[AUTO_TICK_STATE_SQL]', {
      carerUid,
      enabled: sqlStateLookup.state.enabled,
      coadminUid: sqlStateLookup.state.coadminUid,
    });
    return {
      ok: true,
      enabled: sqlStateLookup.state.enabled,
      stateExists: true,
      stateCoadminUidIgnored: sqlStateLookup.state.coadminUid,
      usedSqlState: true,
    };
  }

  if (sqlStateLookup.missReason) {
    console.info(
      '[AUTO_TICK_STATE_FALLBACK] reason=%s carerUid=%s firestore_fallback=%s',
      sqlStateLookup.missReason,
      carerUid,
      !isAuthSqlReadEnabled()
    );
    if (sqlStateLookup.missReason === 'pool_exhausted') {
      console.warn('[AUTO_TICK_STATE_SQL_BLOCKED_POOL_EXHAUSTED]', {
        carerUid,
        state_sql_ms: stateTiming.state_sql_ms,
        reason: sqlStateLookup.missReason,
      });
    }
  }

  if (isAuthSqlReadEnabled()) {
    stateTiming.state_source = 'sql';
    logAutoTickSources({
      carerUid,
      auto_state_source: 'sql',
      firestore_fallback: false,
      details: {
        exists: false,
        missReason: sqlStateLookup.missReason || 'row_missing',
        state_sql_ms: stateTiming.state_sql_ms,
      },
    });
    logAutoTickTiming('state_read', stateReadStartedAt, {
      carerUid,
      exists: false,
      state_source: stateTiming.state_source,
      state_sql_ms: stateTiming.state_sql_ms,
      state_doc_ms: 0,
      firestore_fallback: false,
      missReason: sqlStateLookup.missReason || 'row_missing',
    });
    return {
      ok: true,
      enabled: false,
      stateExists: false,
      stateCoadminUidIgnored: null,
      usedSqlState: true,
    };
  }

  if (!stateRef) {
    return {
      ok: true,
      enabled: false,
      stateExists: false,
      stateCoadminUidIgnored: null,
      usedSqlState: false,
    };
  }

  logFirestoreTouch({
    firestore_touch_type: 'legacy_read_remove_now',
    route: '/api/carer/automation-auto-tick',
    operation: 'read',
    collection: AUTOMATION_AUTO_STATE_COLLECTION,
    document_id: carerUid,
    sql_read_mode: false,
    details: { context: 'resolveAutomationAutoTickState' },
  });
  const stateDocStartedAt = Date.now();
  const stateSnap = await stateRef.get();
  stateTiming.state_doc_ms = Date.now() - stateDocStartedAt;
  stateTiming.state_source = 'firestore';
  logAutoTickTiming('state_read', stateReadStartedAt, {
    carerUid,
    exists: stateSnap.exists,
    state_source: stateTiming.state_source,
    state_sql_ms: stateTiming.state_sql_ms,
    state_doc_ms: stateTiming.state_doc_ms,
  });

  if (stateSnap.exists) {
    try {
      const mirrored = await mirrorAutomationAutoStateSnapshot(
        stateSnap,
        'automation_auto_tick_state_hydrate'
      );
      if (!mirrored) {
        console.info(
          '[AUTO_TICK_STATE_FALLBACK] reason=hydrate_failed carerUid=%s context=state_read',
          carerUid
        );
      }
    } catch (error) {
      console.info(
        '[AUTO_TICK_STATE_FALLBACK] reason=hydrate_failed carerUid=%s error=%s context=state_read',
        carerUid,
        error
      );
    }
  }

  const state = stateSnap.exists
    ? (stateSnap.data() as { enabled?: boolean; coadminUid?: string })
    : null;

  return {
    ok: true,
    enabled: Boolean(state?.enabled),
    stateExists: stateSnap.exists,
    stateCoadminUidIgnored: String(state?.coadminUid || '').trim() || null,
    usedSqlState: false,
  };
}

type AutoTickPendingTiming = {
  pending_source: 'sql' | 'firestore';
  pending_sql_ms: number;
  pending_firestore_ms: number;
};

async function resolveAutoTickPendingCandidates(
  coadminUid: string,
  carerUid: string,
  limit: number,
  options?: { excludeRetryPending?: boolean; excludeReturnCooldown?: boolean }
): Promise<{
  candidates: AutoTickPendingTaskCandidate[];
  timing: AutoTickPendingTiming;
}> {
  const sqlStartedAt = Date.now();
  debugLog('[AUTO_TICK_SQL_PENDING_SCAN_START]', {
    carerUid,
    coadminUid,
    limit,
    excludeRetryPending: options?.excludeRetryPending !== false,
    excludeReturnCooldown:
      options?.excludeReturnCooldown ?? (options?.excludeRetryPending !== false),
  });
  const sqlResult = await getPendingCarerTaskCandidatesFromSql(
    coadminUid,
    limit,
    carerUid,
    {
      excludeRetryPending: options?.excludeRetryPending,
      excludeReturnCooldown: options?.excludeReturnCooldown,
    }
  );
  const pending_sql_ms = Date.now() - sqlStartedAt;

  if (sqlResult.hit) {
    if (sqlResult.candidates.length > 0) {
      console.info(
        '[AUTO_TICK_SQL_PENDING_SCAN_RESULT] carerUid=%s coadminUid=%s candidateCount=%s pending_sql_ms=%s',
        carerUid,
        coadminUid,
        sqlResult.candidates.length,
        pending_sql_ms
      );
    } else {
      debugLog('[AUTO_TICK_SQL_PENDING_SCAN_RESULT]', {
        carerUid,
        coadminUid,
        candidateCount: 0,
        pending_sql_ms,
      });
    }
    logAutoTickSources({
      carerUid,
      pending_source: 'sql',
      firestore_fallback: false,
      details: {
        coadminUid,
        candidateCount: sqlResult.candidates.length,
        pending_sql_ms,
      },
    });
    return {
      candidates: sqlResult.candidates,
      timing: {
        pending_source: 'sql',
        pending_sql_ms,
        pending_firestore_ms: 0,
      },
    };
  }

  console.info(
    '[AUTO_TICK_PENDING_FALLBACK] reason=%s coadminUid=%s carerUid=%s firestore_fallback=%s',
    sqlResult.missReason || 'lookup_failed',
    coadminUid,
    carerUid,
    !isAuthSqlReadEnabled()
  );

  if (isAuthSqlReadEnabled()) {
    logAutoTickSources({
      carerUid,
      pending_source: 'sql',
      firestore_fallback: false,
      details: {
        coadminUid,
        candidateCount: 0,
        missReason: sqlResult.missReason || 'lookup_failed',
        pending_sql_ms,
      },
    });
    return {
      candidates: [],
      timing: {
        pending_source: 'sql',
        pending_sql_ms,
        pending_firestore_ms: 0,
      },
    };
  }

  logFirestoreTouch({
    firestore_touch_type: 'legacy_read_remove_now',
    route: '/api/carer/automation-auto-tick',
    operation: 'read',
    collection: 'carerTasks',
    sql_read_mode: false,
    details: { context: 'resolveAutoTickPendingCandidates', coadminUid, carerUid },
  });
  const firestoreStartedAt = Date.now();
  const pendingSnap = await adminDb
    .collection('carerTasks')
    .where('coadminUid', '==', coadminUid)
    .where('status', '==', 'pending')
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get();
  const pending_firestore_ms = Date.now() - firestoreStartedAt;

  const candidates = pendingSnap.docs.map((docSnap) => ({
    id: docSnap.id,
    ...(docSnap.data() as Record<string, unknown>),
  }));

  return {
    candidates,
    timing: {
      pending_source: 'firestore',
      pending_sql_ms,
      pending_firestore_ms,
    },
  };
}

function taskDebugFields(task: Record<string, unknown>) {
  return {
    status: String(task['status'] || '').trim() || null,
    assignedCarerUid: String(task['assignedCarerUid'] || '').trim() || null,
    assignedCarerUsername: String(task['assignedCarerUsername'] || task['assignedCarer'] || '').trim() || null,
    claimedByUid: String(task['claimedByUid'] || '').trim() || null,
    automationJobId: String(task['automationJobId'] || '').trim() || null,
  };
}

type AutoTickTaskRecheckTiming = {
  task_recheck_source: 'candidate' | 'sql' | 'firestore' | 'none';
  task_recheck_sql_ms: number;
  task_recheck_firestore_ms: number;
};

async function resolveAutoTickTaskRecheck(
  carerUid: string,
  taskId: string,
  candidateTask: AutoTickPendingTaskCandidate,
  pendingSource: AutoTickPendingTiming['pending_source']
): Promise<{
  latestFields: ReturnType<typeof taskDebugFields> | null;
  timing: AutoTickTaskRecheckTiming;
}> {
  const timing: AutoTickTaskRecheckTiming = {
    task_recheck_source: 'none',
    task_recheck_sql_ms: 0,
    task_recheck_firestore_ms: 0,
  };

  if (hasAutoTickTaskRecheckFields(candidateTask)) {
    timing.task_recheck_source = 'candidate';
    console.info('[AUTO_TICK_TASK_RECHECK_SQL]', {
      taskId,
      source: 'candidate',
      pending_source: pendingSource,
      durationMs: 0,
    });
    return {
      latestFields: taskDebugFields(candidateTask),
      timing,
    };
  }

  const sqlStartedAt = Date.now();
  const sqlResult = await lookupAutoTickTaskRecheckFromSql(taskId);
  timing.task_recheck_sql_ms = Date.now() - sqlStartedAt;

  if (sqlResult.hit && sqlResult.task) {
    timing.task_recheck_source = 'sql';
    logAutoTickSources({
      carerUid,
      recheck_source: 'sql',
      firestore_fallback: false,
      details: {
        taskId,
        pending_source: pendingSource,
        durationMs: timing.task_recheck_sql_ms,
      },
    });
    console.info('[AUTO_TICK_TASK_RECHECK_SQL]', {
      taskId,
      recheck_source: 'sql',
      pending_source: pendingSource,
      durationMs: timing.task_recheck_sql_ms,
      firestore_fallback: false,
      pool_acquire_ms: sqlResult.timing.pool_acquire_ms,
      query_exec_ms: sqlResult.timing.query_exec_ms,
    });
    return {
      latestFields: taskDebugFields(sqlResult.task),
      timing,
    };
  }

  if (isAuthSqlReadEnabled()) {
    timing.task_recheck_source = 'sql';
    logAutoTickSources({
      carerUid,
      recheck_source: 'sql',
      firestore_fallback: false,
      details: {
        taskId,
        pending_source: pendingSource,
        sql_miss_reason: sqlResult.missReason,
      },
    });
    console.info('[AUTO_TICK_TASK_RECHECK_SQL]', {
      taskId,
      recheck_source: 'sql',
      pending_source: pendingSource,
      durationMs: timing.task_recheck_sql_ms,
      sql_miss_reason: sqlResult.missReason,
      firestore_fallback: false,
    });
    return {
      latestFields: null,
      timing,
    };
  }

  logFirestoreTouch({
    firestore_touch_type: 'legacy_read_remove_now',
    route: '/api/carer/automation-auto-tick',
    operation: 'read',
    collection: 'carerTasks',
    document_id: taskId,
    sql_read_mode: false,
    details: { context: 'resolveAutoTickTaskRecheck' },
  });
  const firestoreStartedAt = Date.now();
  const latestTaskSnap = await adminDb.collection('carerTasks').doc(taskId).get();
  timing.task_recheck_firestore_ms = Date.now() - firestoreStartedAt;
  timing.task_recheck_source = 'firestore';
  const latestTask = latestTaskSnap.exists
    ? (latestTaskSnap.data() as Record<string, unknown>)
    : null;
  console.info('[AUTO_TICK_TASK_RECHECK_FALLBACK]', {
    taskId,
    pending_source: pendingSource,
    durationMs: timing.task_recheck_firestore_ms,
    sql_miss_reason: sqlResult.missReason,
    exists: latestTaskSnap.exists,
  });
  return {
    latestFields: latestTask ? taskDebugFields(latestTask) : null,
    timing,
  };
}

export async function POST(request: Request) {
  const routeStartedAt = Date.now();
  debugLog('[AUTO_TICK_ROUTE_ENTER]', { at: routeStartedAt });
  debugLog('[AUTO_TICK] route called', {});

  let body: {
    carerUid?: unknown;
    agentId?: unknown;
    instanceId?: unknown;
    allowRetryPendingClaim?: unknown;
    source?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return apiError('Invalid JSON body.', 400);
  }

  const carerUid = String(body.carerUid || '').trim();
  const agentId = String(body.agentId || '').trim();
  const instanceId = String(body.instanceId || '').trim();
  const allowRetryPendingClaim = body.allowRetryPendingClaim === true;
  const dispatchSource = String(body.source || 'unknown').trim() || 'unknown';
  if (!carerUid || !agentId || !instanceId) {
    return apiError('carerUid, agentId, and instanceId are required.', 400);
  }

  const expected = String(process.env.CARER_AUTOMATION_TICK_SECRET || '').trim();
  const provided = String(request.headers.get('x-carer-automation-tick-secret') || '').trim();
  const browserToken = String(request.headers.get('x-carer-auto-tick-token') || '').trim();
  const hasValidSecret = Boolean(expected && provided && provided === expected);
  const authStartedAt = Date.now();
  const tokenCheck = !hasValidSecret && browserToken ? verifyAutoTickBrowserToken(browserToken) : null;
  const hasValidBrowserToken =
    Boolean(tokenCheck?.ok) &&
    tokenCheck?.ok === true &&
    tokenCheck.payload.carerUid === carerUid &&
    tokenCheck.payload.automationAgentId === agentId;
  const auth = hasValidSecret || hasValidBrowserToken
    ? null
    : await requireCarerApiUser(request);
  logAutoTickTiming('auth', authStartedAt, {
    authMode: hasValidSecret ? 'secret' : hasValidBrowserToken ? 'browser_token' : 'firebase',
    ok: !(auth && 'response' in auth),
    tokenReason: tokenCheck && !tokenCheck.ok ? tokenCheck.reason : null,
  });
  if (auth && 'response' in auth) {
    return auth.response;
  }
  if (auth && 'user' in auth && auth.user.uid !== carerUid) {
    return apiError('Forbidden: cannot tick automation for another carer.', 403);
  }

  const profileResult = await resolveAutoTickCarerProfile({
    carerUid,
    authUser: auth && 'user' in auth ? auth.user : null,
    authPath: auth && 'authPath' in auth ? auth.authPath : null,
  });
  if (!profileResult.ok) {
    return profileResult.response;
  }
  const { profile: carerProfile } = profileResult;
  const coadminUid = carerProfile.coadminUid;
  if (!coadminUid) {
    console.info('[AUTO_TICK] skipped auto tick', {
      carerUid,
      reason: 'missing_profile_coadmin_uid',
    });
    return NextResponse.json({ ok: true, claimed: false, reason: 'missing_coadmin_uid' });
  }
  debugLog('[AUTO_TICK] request received', {
    carerUid,
    agentId,
    instanceId,
  });
  const linked = validateAutomationAgentId(carerProfile.automationAgentId);
  const bodyAgent = validateAutomationAgentId(agentId);
  if (
    !linked.valid ||
    !linked.normalized ||
    !bodyAgent.valid ||
    !bodyAgent.normalized ||
    linked.normalized !== bodyAgent.normalized
  ) {
    return apiError('agentId does not match the linked automation agent for this carer.', 403);
  }

  const sqlReadMode = isAuthSqlReadEnabled();
  if (sqlReadMode) {
    debugLog('[AUTO_TICK_SQL_START]', {
      carerUid,
      coadminUid,
      agentId,
      instanceId,
      allowRetryPendingClaim,
    });
  }
  const stateRef = sqlReadMode
    ? null
    : adminDb.collection(AUTOMATION_AUTO_STATE_COLLECTION).doc(carerUid);
  const stateTiming = createAutoTickStateTiming();
  const stateResult = await resolveAutomationAutoTickState(carerUid, stateRef, stateTiming);
  if (!stateResult.ok) {
    return stateResult.response;
  }
  debugLog('[AUTO_TICK] automation enabled state', {
    carerUid,
    stateExists: stateResult.stateExists,
    enabled: stateResult.enabled,
    coadminUid,
    auto_state_source: stateTiming.state_source,
  });
  if (!stateResult.enabled) {
    console.info('[AUTO_DISPATCH_SKIPPED_AUTOMATION_OFF]', {
      route: '/api/carer/automation-auto-tick',
      carerUid,
      coadminUid,
      agentId,
      instanceId,
      authMode: hasValidSecret ? 'secret' : hasValidBrowserToken ? 'browser_token' : 'firebase',
      enabled: false,
      reason: 'automation_disabled',
    });
    console.info('[AUTO_TICK] skipped auto tick', {
      carerUid,
      reason: 'automation_disabled',
    });
    return NextResponse.json({ ok: true, claimed: false, reason: 'disabled' });
  }

  const leaseStartedAt = Date.now();
  const isBrowserAutoTick = !hasValidSecret && instanceId.startsWith('carer-ui-');
  const useSqlLease = sqlReadMode || stateResult.usedSqlState;

  const handleLeaseFailure = (msg: string) => {
    if (msg === 'LEASE_HELD') {
      console.info('[AUTO_TICK] skipped auto tick', {
        carerUid,
        reason: 'lease_held',
        instanceId,
      });
      return NextResponse.json({ ok: true, claimed: false, reason: 'lease_held' });
    }
    if (msg === 'DISABLED' || msg === 'STATE_GONE') {
      console.info('[AUTO_TICK] skipped auto tick', {
        carerUid,
        reason: msg === 'STATE_GONE' ? 'state_gone' : 'disabled_during_lease',
      });
      return NextResponse.json({ ok: true, claimed: false, reason: 'disabled' });
    }
    if (msg === 'SQL_READ_MODE' || msg === 'postgres_unavailable' || msg === 'lookup_failed') {
      console.info('[AUTO_TICK] skipped auto tick', {
        carerUid,
        reason: 'lease_unavailable',
        instanceId,
        detail: msg,
      });
      return NextResponse.json({ ok: true, claimed: false, reason: 'lease_unavailable' });
    }
    throw new Error(msg);
  };

  if (isBrowserAutoTick) {
    stateTiming.lease_source = 'skipped';
    logAutoTickLease({
      carerUid,
      coadminUid,
      instanceId,
      lease_source: 'skipped',
      lease_acquired: true,
      firestore_fallback: false,
      skipped: true,
      mode: 'browser_claim_transaction_guard',
    });
    logAutoTickTiming('lease_transaction', leaseStartedAt, {
      carerUid,
      coadminUid,
      instanceId,
      acquired: true,
      skipped: true,
      mode: 'browser_claim_transaction_guard',
      lease_source: stateTiming.lease_source,
      lease_sql_ms: 0,
      lease_transaction_ms: 0,
    });
  } else if (useSqlLease) {
    const sqlLeaseResult = await acquireAutomationAutoTickLeaseSql(
      carerUid,
      instanceId,
      LEASE_TTL_MS
    );
    stateTiming.lease_sql_ms = sqlLeaseResult.timing.total_ms;
    if (sqlLeaseResult.ok) {
      stateTiming.lease_source = 'sql';
      logAutoTickLease({
        carerUid,
        coadminUid,
        instanceId,
        lease_source: 'sql',
        lease_acquired: true,
        firestore_fallback: false,
        lease_sql_ms: stateTiming.lease_sql_ms,
      });
      logAutoTickTiming('lease_transaction', leaseStartedAt, {
        carerUid,
        coadminUid,
        instanceId,
        acquired: true,
        mode: 'sql',
        lease_source: stateTiming.lease_source,
        lease_sql_ms: stateTiming.lease_sql_ms,
        lease_transaction_ms: 0,
      });
    } else if (
      !sqlReadMode &&
      (sqlLeaseResult.reason === 'postgres_unavailable' ||
        sqlLeaseResult.reason === 'lookup_failed')
    ) {
      if (!stateRef) {
        return handleLeaseFailure(sqlLeaseResult.reason);
      }
      console.info('[AUTO_TICK_STATE_FALLBACK] reason=%s carerUid=%s context=lease legacy_emergency_fallback=true', {
        reason: sqlLeaseResult.reason,
        carerUid,
      });
      const firestoreLease = await acquireAutomationAutoTickLeaseFirestore(stateRef, instanceId);
      stateTiming.lease_transaction_ms = Date.now() - leaseStartedAt;
      stateTiming.lease_source = 'firestore';
      logAutoTickLease({
        carerUid,
        coadminUid,
        instanceId,
        lease_source: 'firestore',
        lease_acquired: firestoreLease.ok,
        firestore_fallback: true,
        emergency_fallback: true,
        lease_sql_ms: stateTiming.lease_sql_ms,
        lease_transaction_ms: stateTiming.lease_transaction_ms,
        error: firestoreLease.ok ? null : firestoreLease.reason,
        mode: 'legacy_emergency_fallback',
      });
      logAutoTickTiming('lease_transaction', leaseStartedAt, {
        carerUid,
        coadminUid,
        instanceId,
        acquired: firestoreLease.ok,
        mode: 'legacy_emergency_fallback',
        lease_source: stateTiming.lease_source,
        lease_sql_ms: stateTiming.lease_sql_ms,
        lease_transaction_ms: stateTiming.lease_transaction_ms,
        error: firestoreLease.ok ? null : firestoreLease.reason,
      });
      if (!firestoreLease.ok) {
        return handleLeaseFailure(firestoreLease.reason);
      }
    } else {
      stateTiming.lease_source = 'sql';
      logAutoTickLease({
        carerUid,
        coadminUid,
        instanceId,
        lease_source: 'sql',
        lease_acquired: false,
        firestore_fallback: false,
        lease_sql_ms: stateTiming.lease_sql_ms,
        error: sqlLeaseResult.reason,
        mode: 'sql',
      });
      logAutoTickTiming('lease_transaction', leaseStartedAt, {
        carerUid,
        coadminUid,
        instanceId,
        acquired: false,
        mode: 'sql',
        lease_source: stateTiming.lease_source,
        lease_sql_ms: stateTiming.lease_sql_ms,
        lease_transaction_ms: 0,
        error: sqlLeaseResult.reason,
      });
      return handleLeaseFailure(sqlLeaseResult.reason);
    }
  } else if (stateRef) {
    const firestoreLease = await acquireAutomationAutoTickLeaseFirestore(stateRef, instanceId);
    stateTiming.lease_transaction_ms = Date.now() - leaseStartedAt;
    stateTiming.lease_source = 'firestore';
    logAutoTickLease({
      carerUid,
      coadminUid,
      instanceId,
      lease_source: 'firestore',
      lease_acquired: firestoreLease.ok,
      firestore_fallback: true,
      lease_transaction_ms: stateTiming.lease_transaction_ms,
      error: firestoreLease.ok ? null : firestoreLease.reason,
      mode: 'legacy_firestore',
    });
    logAutoTickTiming('lease_transaction', leaseStartedAt, {
      carerUid,
      coadminUid,
      instanceId,
      acquired: firestoreLease.ok,
      mode: 'legacy_firestore',
      lease_source: stateTiming.lease_source,
      lease_sql_ms: 0,
      lease_transaction_ms: stateTiming.lease_transaction_ms,
      error: firestoreLease.ok ? null : firestoreLease.reason,
    });
    if (!firestoreLease.ok) {
      return handleLeaseFailure(firestoreLease.reason);
    }
  }

  const pendingStartedAt = Date.now();
  const dispatchCounts = await countAutoTickDispatchRows(coadminUid, carerUid);
  debugLog('[DISPATCH_TRIGGER]', {
    route: '/api/carer/automation-auto-tick',
    source: dispatchSource,
    carerUid,
    coadminUid,
    pendingCount: dispatchCounts.pendingCount,
    activeCount: dispatchCounts.activeCount,
  });
  const pendingResult = await resolveAutoTickPendingCandidates(
    coadminUid,
    carerUid,
    PENDING_QUERY_LIMIT,
    {
      excludeRetryPending: !allowRetryPendingClaim,
      excludeReturnCooldown: !allowRetryPendingClaim,
    }
  );
  const pendingCandidates = pendingResult.candidates;
  logAutoTickTiming('pending_query', pendingStartedAt, {
    carerUid,
    coadminUid,
    resultCount: pendingCandidates.length,
    pending_source: pendingResult.timing.pending_source,
    pending_sql_ms: pendingResult.timing.pending_sql_ms,
    pending_firestore_ms: pendingResult.timing.pending_firestore_ms,
  });

  if (pendingCandidates.length > 0) {
    console.info(
      '[AUTO_TICK] pending query result carerUid=%s coadminUid=%s candidateCount=%s pending_source=%s',
      carerUid,
      coadminUid,
      pendingCandidates.length,
      pendingResult.timing.pending_source
    );
  } else {
    debugLog('[AUTO_TICK] pending query result', {
      carerUid,
      coadminUid,
      candidateCount: 0,
      pending_source: pendingResult.timing.pending_source,
    });
  }

  if (pendingCandidates.length === 0) {
    debugLog('[DISPATCH_REFILL]', {
      route: '/api/carer/automation-auto-tick',
      source: dispatchSource,
      started: 0,
      skipped: 0,
      pendingCount: dispatchCounts.pendingCount,
      activeCount: dispatchCounts.activeCount,
      reason: 'no_pending_tasks',
    });
    if (sqlReadMode) {
      debugLog('[AUTO_TICK_SQL_NO_PENDING]', {
        carerUid,
        coadminUid,
        pending_source: pendingResult.timing.pending_source,
      });
    }
    debugLog('[AUTO_TICK_NO_TASKS]', {
      carerUid,
      coadminUid,
      reason: 'no_pending_tasks',
      pending_source: pendingResult.timing.pending_source,
    });
    logAutoTickTiming('total', routeStartedAt, {
      carerUid,
      coadminUid,
      claimed: false,
      claimedCount: 0,
      reason: 'no_pending_tasks',
    });
    return NextResponse.json({
      ok: true,
      claimed: false,
      claimedCount: 0,
      claimedJobs: [],
      reason: 'no_pending_tasks',
    });
  }

  if (sqlReadMode) {
    console.info('[AUTO_TICK_SQL_PENDING_SCAN]', {
      carerUid,
      coadminUid,
      candidateCount: pendingCandidates.length,
      pending_source: pendingResult.timing.pending_source,
    });
    for (const task of pendingCandidates) {
      const rawType = String(task['type'] || task['kind'] || '').trim();
      const taskTypeLabel = resolveTaskTypeLabel(task);
      const mapped = mapTaskType(taskTypeLabel);
      console.info('[AUTO_TICK_SQL_PENDING_TASK_ROW]', {
        taskId: task.id,
        type: rawType || null,
        mappedType: mapped,
        status: String(task['status'] || '').trim() || null,
        retryPending: task['retryPending'] === true,
      });
      console.info('[AUTO_TICK_SQL_TASK_TYPE_NORMALIZED]', {
        taskId: task.id,
        rawType: rawType || null,
        typeLabel: taskTypeLabel,
        normalized: mapped,
      });
      if (mapped === 'CREATE_USERNAME') {
        console.info('[AUTO_TICK_SQL_CREATE_USERNAME_ELIGIBLE]', {
          taskId: task.id,
          carerUid,
          coadminUid,
        });
      }
    }
  }

  if (sqlReadMode && pendingCandidates.length > 0) {
    console.info('[AUTO_TICK_SQL_PENDING_FOUND]', {
      carerUid,
      coadminUid,
      candidateCount: pendingCandidates.length,
      candidateTaskIds: pendingCandidates.map((task) => task.id),
      pending_source: pendingResult.timing.pending_source,
    });
  }

  const claimedJobs: Array<{
    taskId: string;
    jobId: string;
    reusedExistingJob: boolean;
  }> = [];
  const skippedTasks: Array<{
    taskId: string;
    reason: string;
    message?: string;
    mapped?: string;
    remainingCooldownMs?: number;
  }> = [];

  for (const task of pendingCandidates) {
    const taskId = task.id;
    if (claimedJobs.length >= MAX_CLAIMS_PER_TICK) {
      console.info('[AUTO_TICK] claim batch limit reached', {
        carerUid,
        coadminUid,
        claimedCount: claimedJobs.length,
        maxClaimsPerTick: MAX_CLAIMS_PER_TICK,
      });
      break;
    }

    console.info('[AUTO_TICK] pending task from query', {
      taskId,
      fields: taskDebugFields(task),
      pending_source: pendingResult.timing.pending_source,
    });
    const retryPending = task['retryPending'] === true;
    const returnedToPendingAt = String(task['returnedToPendingAt'] || '').trim();
    const returnedMs = returnedToPendingAt ? Date.parse(returnedToPendingAt) : NaN;
    const withinReturnCooldown =
      Number.isFinite(returnedMs) && Date.now() - returnedMs < 30_000;
    const remainingCooldownMs = withinReturnCooldown
      ? Math.max(0, 30_000 - (Date.now() - returnedMs))
      : 0;
    // Keep return cooldown for auto-tick thrash protection. allowRetryPendingClaim only
    // unlocks retryPending after the cooldown window (matches continuous automation consumer).
    if (withinReturnCooldown || (retryPending && !allowRetryPendingClaim)) {
      console.info('[AUTO_TICK_RECLAIM_AFTER_RETURN_BLOCKED]', {
        taskId,
        carerUid,
        coadminUid,
        retryPending,
        returnedToPendingAt: returnedToPendingAt || null,
        withinReturnCooldown,
        remainingCooldownMs,
        allowRetryPendingClaim,
      });
      if (withinReturnCooldown) {
        console.info('[AUTO_TICK_SQL_SKIPPED_COOLDOWN]', {
          taskId,
          carerUid,
          coadminUid,
          returnedToPendingAt,
          cooldownMs: 30_000,
          remainingCooldownMs,
          retryPending,
        });
        console.info('[AUTO_TICK_SKIP_RECENTLY_RETURNED_TASK]', {
          taskId,
          carerUid,
          coadminUid,
          returnedToPendingAt,
          cooldownMs: 30_000,
          remainingCooldownMs,
        });
      } else if (retryPending) {
        console.info('[AUTO_TICK_SQL_SKIPPED_RETRY_PENDING]', {
          taskId,
          carerUid,
          coadminUid,
          retryPending,
          allowRetryPendingClaim,
          returnedToPendingAt: returnedToPendingAt || null,
        });
      }
      skippedTasks.push({
        taskId,
        reason: withinReturnCooldown
          ? 'returned_to_pending_cooldown'
          : 'retry_pending_requires_start_automation',
        remainingCooldownMs: withinReturnCooldown ? remainingCooldownMs : undefined,
      });
      continue;
    }

    console.info('[AUTO_TICK_PENDING_TASK_FOUND]', {
      taskId,
      carerUid,
      coadminUid,
      mappedTypePreview: mapTaskType(resolveTaskTypeLabel(task)),
      pending_source: pendingResult.timing.pending_source,
      retryPending,
      allowRetryPendingClaim,
    });
    const mapped = mapTaskType(resolveTaskTypeLabel(task));
    console.info('[AUTO_TICK_SQL_TASK_TYPE_NORMALIZED]', {
      taskId,
      rawType: String(task['type'] || task['kind'] || '').trim() || null,
      typeLabel: resolveTaskTypeLabel(task),
      normalized: mapped,
    });
    if (!isAgentSupportedAutomationType(mapped)) {
      console.info('[AUTO_TICK_SQL_SKIPPED_TYPE]', {
        taskId,
        mapped,
        reason: 'unsupported_automation_type',
      });
      console.info('[AUTO_TICK] skipped task (unsupported type)', {
        taskId,
        reason: 'unsupported_automation_type',
        mapped,
      });
      skippedTasks.push({
        taskId,
        reason: 'unsupported_automation_type',
        mapped,
      });
      continue;
    }
    const gameName = String(task['gameName'] || task['game'] || '').trim();
    const playerUid = String(task['playerUid'] || '').trim();
    if (!gameName || !playerUid) {
      console.info('[AUTO_TICK] skipped task (missing game or player)', {
        taskId,
        reason: 'missing_game_or_player',
      });
      skippedTasks.push({
        taskId,
        reason: 'missing_game_or_player',
      });
      continue;
    }

    const gameKey = normalizeAutomationGameKey(gameName);
    if (isSingleSessionAutomationGame(gameName)) {
      const singleSessionStartedAt = Date.now();
      const activeSameGame = await getCarerActiveSingleSessionTaskFromSql(
        coadminUid,
        carerUid,
        gameKey
      );
      logAutoTickTiming('single_session_in_progress_query', singleSessionStartedAt, {
        carerUid,
        coadminUid,
        gameName,
        gameKey,
        resultCount: activeSameGame.hit ? 1 : 0,
        activeTaskId: activeSameGame.taskId,
        activeJobId: activeSameGame.jobId,
        activeJobStatus: activeSameGame.jobStatus,
        in_progress_sql_ms: activeSameGame.timing.total_ms,
      });
      if (activeSameGame.hit) {
        console.info('[AUTO_TICK_SINGLE_SESSION_BLOCKED]', {
          taskId,
          carerUid,
          coadminUid,
          gameName,
          gameKey,
          activeTaskId: activeSameGame.taskId,
          activeJobId: activeSameGame.jobId,
          activeJobStatus: activeSameGame.jobStatus,
          reason: 'single_session_game_active',
        });
        console.info('[AUTO_TICK_SINGLE_SESSION_BLOCKED_GAME]', {
          message: `skipped ${gameName} because ${gameName} already active`,
          taskId,
          carerUid,
          coadminUid,
          gameName,
          gameKey,
          activeTaskId: activeSameGame.taskId,
          activeJobId: activeSameGame.jobId,
          activeJobStatus: activeSameGame.jobStatus,
        });
        skippedTasks.push({
          taskId,
          reason: 'single_session_game_active',
          message: `${gameName} already has an active automation task.`,
          mapped,
        });
        continue;
      }
    }

    const taskAccess = resolveAutomationAccessFields(task);
    const hasEmbeddedGameLoginDetails = Boolean(
      taskAccess.loginUrl &&
        taskAccess.gameCredentialUsername &&
        taskAccess.gameCredentialPassword
    );
    const gameLoginStartedAt = Date.now();
    const gameLoginDetails = hasEmbeddedGameLoginDetails
      ? null
      : await resolveGameLoginDetailsForCoadminGame(coadminUid, gameName);
    if (hasEmbeddedGameLoginDetails) {
      console.info(
        '[AUTO_TICK_RESOLVER_SQL] type=game_login hit=true source=task_embedded durationMs=0 coadminUid=%s playerUid=%s gameName=%s taskId=%s',
        coadminUid,
        playerUid,
        gameName,
        taskId
      );
    }
    logAutoTickTiming('resolve_game_login_details', gameLoginStartedAt, {
      taskId,
      coadminUid,
      gameName,
      found: Boolean(gameLoginDetails) || hasEmbeddedGameLoginDetails,
      skipped: hasEmbeddedGameLoginDetails,
      reason: hasEmbeddedGameLoginDetails ? 'task_already_has_access_fields' : null,
    });
    const embeddedCurrentUsername =
      String(
        (typeof task['currentUsername'] === 'string' ? task['currentUsername'] : '') ||
          (typeof task['gameAccountUsername'] === 'string' ? task['gameAccountUsername'] : '') ||
          ''
      ).trim() || null;
    const usernameStartedAt = Date.now();
    const fromLogin = embeddedCurrentUsername
      ? null
      : await resolveCurrentUsernameForTask(coadminUid, playerUid, gameName, {
          taskType: mapped,
        });
    if (mapped === 'CREATE_USERNAME' && !embeddedCurrentUsername) {
      console.info('[CLAIM_TASK_SQL_GAME_LOGIN_MISSING_ALLOWED]', {
        taskId,
        carerUid,
        coadminUid,
        playerUid,
        gameName,
        type: mapped,
        reason: 'create_username_has_no_existing_player_game_login',
      });
    }
    if (embeddedCurrentUsername) {
      console.info(
        '[AUTO_TICK_RESOLVER_SQL] type=username hit=true source=task_embedded durationMs=0 coadminUid=%s playerUid=%s gameName=%s taskId=%s',
        coadminUid,
        playerUid,
        gameName,
        taskId
      );
    }
    logAutoTickTiming('resolve_current_username', usernameStartedAt, {
      taskId,
      coadminUid,
      playerUid,
      gameName,
      found: Boolean(fromLogin || embeddedCurrentUsername),
      skipped: Boolean(embeddedCurrentUsername),
      reason: embeddedCurrentUsername ? 'task_already_has_current_username' : null,
    });
    const currentUsername =
      embeddedCurrentUsername ||
      fromLogin ||
      null;
    if (!currentUsername && mapped !== 'CREATE_USERNAME') {
      const missingLoginMessage = 'Game login not found in SQL cache.';
      console.info('[AUTO_TICK] skipped task (missing sql player game login)', {
        taskId,
        carerUid,
        coadminUid,
        playerUid,
        gameName,
        mapped,
        reason: 'player_game_login_missing_sql',
        message: missingLoginMessage,
      });
      skippedTasks.push({
        taskId,
        reason: 'player_game_login_missing_sql',
        message: missingLoginMessage,
        mapped,
      });
      continue;
    }

    const carerName = carerProfile.username || 'Carer';

    console.info('[AUTO_TICK] attempting claim for pending task', {
      taskId,
      selectedTaskId: taskId,
      gameName,
      playerUid,
      beforeFields: taskDebugFields(task),
    });
    console.info('[AUTO_TICK_CLAIM_START]', {
      taskId,
      carerUid,
      coadminUid,
      agentId: linked.normalized,
      gameName,
      playerUid,
    });
    if (sqlReadMode) {
      console.info('[AUTO_TICK_SQL_CLAIM_ATTEMPT]', {
        taskId,
        carerUid,
        coadminUid,
        agentId: linked.normalized,
        gameName,
        playerUid,
      });
    }
    console.info('[AUTO_TICK_CLAIM_PENDING_TASK]', {
      taskId,
      carerUid,
      coadminUid,
      allowRetryPendingClaim,
      retryPending,
      returnedToPendingAt: returnedToPendingAt || null,
      cooldownPassed: !withinReturnCooldown,
    });

    if (isAuthoritySqlWriteEnabled()) {
      await logAuthorityAutoTickDb({
        route: '/api/carer/automation-auto-tick',
        taskId,
      });
    }

    const claimStartedAt = Date.now();
    try {
      const result = await claimCarerTaskAsAdmin({
        carerUid,
        carerCoadminUid: coadminUid,
        taskId,
        currentUsername,
        carerName,
        gameLoginDetails,
        trustedUser: {
          username: carerProfile.username || null,
          automationAgentId: linked.normalized,
        },
        skipLocked: isAuthoritySqlWriteEnabled(),
        allowRetryPendingClaim,
        requireAutomationEnabled: true,
      });
      logAutoTickTiming('claimCarerTaskAsAdmin_total', claimStartedAt, {
        taskId,
        carerUid,
        ok: true,
        jobId: result.jobId,
        reusedExistingJob: result.reusedExistingJob,
      });
      console.info('[AUTO_TICK] claimed pending task as in_progress', {
        taskId: result.taskId,
        jobId: result.jobId,
        carerUid,
        reusedExistingJob: result.reusedExistingJob,
        automationJobCreated: !result.reusedExistingJob,
        originalTaskUpdatedToInProgress: true,
      });
      const claimTime = new Date().toISOString();
      console.info('[AUTO_TASK_CLAIM]', {
        taskId: result.taskId,
        player: playerUid || null,
        automationUser: carerUid,
        claimTime,
        jobId: result.jobId,
        source: 'automation_auto_tick',
      });
      console.info('[AUTO_TASK_STARTED]', {
        taskId: result.taskId,
        player: playerUid || null,
        automationUser: carerUid,
        claimTime,
        jobId: result.jobId,
        source: 'automation_auto_tick',
      });
      console.info('[AUTO_TICK_CLAIMED_IN_PROGRESS]', {
        taskId: result.taskId,
        jobId: result.jobId,
        carerUid,
        coadminUid,
        agentId: linked.normalized,
        status: 'in_progress',
        reusedExistingJob: result.reusedExistingJob,
      });
      if (sqlReadMode) {
        console.info('[AUTO_TICK_SQL_CLAIMED]', {
          taskId: result.taskId,
          jobId: result.jobId,
          carerUid,
          coadminUid,
          agentId: linked.normalized,
          reusedExistingJob: result.reusedExistingJob,
        });
      }
      if (!result.reusedExistingJob) {
        console.info('[AUTO_TICK_JOB_QUEUED]', {
          taskId: result.taskId,
          jobId: result.jobId,
          carerUid,
          coadminUid,
          agentId: linked.normalized,
          jobStatus: result.status,
        });
      }
      if (!sqlReadMode && !isAuthoritySqlWriteEnabled()) {
        void mirrorCarerTaskById(result.taskId, 'appbeg_automation_auto_tick');
      }
      claimedJobs.push({
        taskId: result.taskId,
        jobId: result.jobId,
        reusedExistingJob: result.reusedExistingJob,
      });
    } catch (err) {
      logAutoTickTiming('claimCarerTaskAsAdmin_total', claimStartedAt, {
        taskId,
        carerUid,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
      const message = err instanceof Error ? err.message : String(err);
      if (
        message.includes('Automation job already exists') ||
        message.includes('Task already claimed') ||
        message.includes('not reclaimable') ||
        message.includes('returned to pending') ||
        message.includes('unsupported') ||
        message.includes('No automation agent') ||
        message.includes('Start Automation is off') ||
        message.includes('already has an active automation task')
      ) {
        const taskRecheck = await resolveAutoTickTaskRecheck(
          carerUid,
          taskId,
          task,
          pendingResult.timing.pending_source
        );
        console.info('[AUTO_TICK] skipped task after claim attempt', {
          taskId,
          reason: 'claim_rejected',
          message,
          latestFields: taskRecheck.latestFields,
          task_recheck_source: taskRecheck.timing.task_recheck_source,
          task_recheck_sql_ms: taskRecheck.timing.task_recheck_sql_ms,
          task_recheck_firestore_ms: taskRecheck.timing.task_recheck_firestore_ms,
        });
        skippedTasks.push({
          taskId,
          reason: 'claim_rejected',
          message,
        });
        continue;
      }
      const lower = message.toLowerCase();
      if (lower.includes('resource_exhausted') || lower.includes('quota exceeded')) {
        if (sqlReadMode) {
          console.info('[AUTO_TICK] quota disable via sql', {
            carerUid,
            auto_state_source: 'sql',
            firestore_fallback: false,
          });
          await disableAutomationAutoStateSql(carerUid, 'firestore_quota');
        } else if (stateRef) {
          logFirestoreTouch({
            firestore_touch_type: 'authority_write_keep_for_now',
            route: '/api/carer/automation-auto-tick',
            operation: 'write',
            collection: AUTOMATION_AUTO_STATE_COLLECTION,
            document_id: carerUid,
            details: { context: 'quota_auto_disable' },
          });
          await stateRef.set(
            {
              enabled: false,
              updatedAt: FieldValue.serverTimestamp(),
              stoppedAt: FieldValue.serverTimestamp(),
              autoDisabledReason: 'firestore_quota',
            },
            { merge: true }
          );
          void disableAutomationAutoStateSql(carerUid, 'firestore_quota');
          void mirrorAutomationAutoStateById(carerUid, 'automation_auto_tick_quota_hydrate');
        }
        return NextResponse.json({ ok: false, claimed: false, reason: 'quota', error: message }, { status: 429 });
      }
      console.error('[AUTO_TICK] unexpected claim error', { taskId, message });
      return NextResponse.json({ ok: false, claimed: false, error: message }, { status: 500 });
    }
  }

  if (claimedJobs.length > 0) {
    console.info('[DISPATCH_REFILL]', {
      route: '/api/carer/automation-auto-tick',
      source: dispatchSource,
      started: claimedJobs.length,
      skipped: skippedTasks.length,
      pendingCount: dispatchCounts.pendingCount,
      activeCount: dispatchCounts.activeCount,
      maxClaimsPerTick: MAX_CLAIMS_PER_TICK,
    });
    console.info('[AUTO_TICK] claim batch complete', {
      carerUid,
      coadminUid,
      claimedCount: claimedJobs.length,
      claimedTaskIds: claimedJobs.map((job) => job.taskId),
      claimedJobIds: claimedJobs.map((job) => job.jobId),
      skippedCount: skippedTasks.length,
      skippedTasks,
    });
    logAutoTickTiming('total', routeStartedAt, {
      carerUid,
      coadminUid,
      claimed: true,
      claimedCount: claimedJobs.length,
      skippedCount: skippedTasks.length,
    });
    return NextResponse.json({
      ok: true,
      claimed: true,
      claimedCount: claimedJobs.length,
      claimedJobs,
      claimedTaskIds: claimedJobs.map((job) => job.taskId),
      claimedJobIds: claimedJobs.map((job) => job.jobId),
      skippedCount: skippedTasks.length,
      skippedTasks,
      taskId: claimedJobs[0]?.taskId || null,
      jobId: claimedJobs[0]?.jobId || null,
      reusedExistingJob: claimedJobs[0]?.reusedExistingJob || false,
    });
  }

  if (skippedTasks.length > 0) {
    console.info(
      '[AUTO_TICK_NO_TASKS] carerUid=%s coadminUid=%s reason=no_claimable_pending_task candidateCount=%s skippedCount=%s',
      carerUid,
      coadminUid,
      pendingCandidates.length,
      skippedTasks.length
    );
  } else {
    debugLog('[AUTO_TICK_NO_TASKS]', {
      carerUid,
      coadminUid,
      reason: 'no_claimable_pending_task',
      candidateCount: pendingCandidates.length,
      skippedCount: 0,
    });
  }
  debugLog('[DISPATCH_REFILL]', {
    route: '/api/carer/automation-auto-tick',
    source: dispatchSource,
    started: 0,
    skipped: skippedTasks.length,
    pendingCount: dispatchCounts.pendingCount,
    activeCount: dispatchCounts.activeCount,
    reason: 'no_claimable_task',
  });
  if (Number(dispatchCounts.pendingCount || 0) > 0) {
    console.info('[DISPATCH_IDLE_WITH_PENDING]', {
      route: '/api/carer/automation-auto-tick',
      source: dispatchSource,
      pendingCount: dispatchCounts.pendingCount,
      activeCount: dispatchCounts.activeCount,
      skippedCount: skippedTasks.length,
      skippedTasks,
    });
  }
  console.info('[AUTO_TICK] no claimable pending task after scanning candidates', {
    candidateCount: pendingCandidates.length,
    skippedCount: skippedTasks.length,
    skippedTasks,
  });
  logAutoTickTiming('total', routeStartedAt, {
    carerUid,
    coadminUid,
    claimed: false,
    claimedCount: 0,
    skippedCount: skippedTasks.length,
    reason: 'no_claimable_task',
  });
  return NextResponse.json({
    ok: true,
    claimed: false,
    claimedCount: 0,
    claimedJobs: [],
    claimedTaskIds: [],
    claimedJobIds: [],
    skippedCount: skippedTasks.length,
    skippedTasks,
    reason: 'no_claimable_task',
  });
}
