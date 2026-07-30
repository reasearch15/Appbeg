import { NextResponse } from 'next/server';
import type { PoolClient } from 'pg';

import { adminAuth, adminDb } from '@/lib/firebase/admin';
import { verifyLiveCarerApiToken } from '@/lib/firebase/liveAuthTokenCache';
import {
  lookupAppSession,
  lookupAppSessionWithClient,
  scheduleAppSessionTouchIfDue,
  type AppSessionRow,
} from '@/lib/sql/appSessions';
import {
  acquirePlayerMirrorClient,
  cleanText,
  type PlayerMirrorAcquireContext,
} from '@/lib/sql/playerMirrorCommon';
import {
  lookupApiUserProfileFromSqlCache,
  lookupCarerProfileFromSqlCache,
  lookupPlayerProfileFromSqlCache,
  mirrorPlayerById,
  type ApiUserSqlProfileLookup,
} from '@/lib/sql/playersCache';
import {
  getCachedPlayerSessionValidation,
  writePlayerSessionAuthCache,
} from '@/lib/server/playerSessionAuthCache';
import { recordAuthCacheMetric } from '@/lib/server/logMetrics';
import {
  lookupPlayerSessionFromSqlCache,
  lookupPlayerSessionOwnerFromSql,
  mirrorPlayerSessionById,
} from '@/lib/sql/playerSessionsCache';
import { timedRechargeFirestoreRead } from '@/lib/server/rechargeFirestoreInstrumentation';
import {
  isAppbegSqlOnlyMode,
  isAuthFirestoreFallbackAllowed,
  logFirebaseAuthFallbackDisabled,
  logSqlAuthNoFirestore,
  logSqlAuthProfileRead,
  logSqlAuthSessionRead,
  shouldAuthUseSqlOnly,
} from '@/lib/server/appbegSqlOnlyMode';
import { isSqlAuthVerboseLogs } from '@/lib/server/verboseLogs';
import { logFirestoreTouch } from '@/lib/server/firestoreTouchAudit';

function logVerboseApiAuth(...args: Parameters<typeof console.info>) {
  if (isSqlAuthVerboseLogs()) {
    console.info(...args);
  }
}

export type ApiRole = 'admin' | 'coadmin' | 'staff' | 'carer' | 'player';

export type ApiUser = {
  uid: string;
  role: ApiRole;
  username: string;
  coadminUid: string | null;
  createdBy: string | null;
  canViewPlayers?: boolean;
  automationAgentId?: string | null;
};

function bearerToken(request: Request) {
  return (request.headers.get('Authorization') || '').match(/^Bearer\s+(\S+)$/i)?.[1] || '';
}

function playerSessionId(request: Request) {
  return String(request.headers.get('X-Player-Session-Id') || '').trim();
}

function appSessionIdFromRequest(request: Request) {
  return cleanText(request.headers.get('X-App-Session-Id'));
}

function isLoginAllowedStatus(status: string | null, role: string) {
  const normalizedStatus = cleanText(status).toLowerCase();
  const normalizedRole = cleanText(role).toLowerCase();
  const isActive = normalizedStatus === 'active';
  const isBlockedPlayer = normalizedStatus === 'disabled' && normalizedRole === 'player';
  return isActive || isBlockedPlayer;
}

const APP_SESSION_AUTH_CACHE_TTL_MS = 30_000;

export type AppSessionAuthTiming = {
  cookie_parse_ms: number;
  cache_lookup_ms: number;
  pool_acquire_ms: number;
  session_lookup_ms: number;
  profile_lookup_ms: number;
  client_release_ms: number;
  auth_finalize_ms: number;
  total_ms: number;
};

function emptyAppSessionAuthTiming(
  partial: Partial<AppSessionAuthTiming> = {}
): AppSessionAuthTiming {
  return {
    cookie_parse_ms: partial.cookie_parse_ms ?? 0,
    cache_lookup_ms: partial.cache_lookup_ms ?? 0,
    pool_acquire_ms: partial.pool_acquire_ms ?? 0,
    session_lookup_ms: partial.session_lookup_ms ?? 0,
    profile_lookup_ms: partial.profile_lookup_ms ?? 0,
    client_release_ms: partial.client_release_ms ?? 0,
    auth_finalize_ms: partial.auth_finalize_ms ?? 0,
    total_ms: partial.total_ms ?? 0,
  };
}

export type AppSessionVerifyResult =
  | {
      hit: false;
      sessionId: string | null;
      reason: string;
      lookupMs: number;
      timing: AppSessionAuthTiming;
    }
  | {
      hit: true;
      sessionId: string;
      uid: string;
      role: ApiRole;
      coadminUid: string | null;
      username: string;
      session: AppSessionRow;
      profile: ApiUserSqlProfileLookup;
      lookupMs: number;
      profileMs: number;
      authPath: 'app_session_sql';
      timing: AppSessionAuthTiming;
    };

type AppSessionAuthCachePayload = Omit<
  Extract<AppSessionVerifyResult, { hit: true }>,
  'timing'
>;

type AppSessionAuthCacheEntry = {
  expiresAt: number;
  result: AppSessionAuthCachePayload;
};

const appSessionAuthCache = new Map<string, AppSessionAuthCacheEntry>();

export function invalidateAppSessionAuthCache(sessionId?: string) {
  const cleanSessionId = cleanText(sessionId);
  if (!cleanSessionId) {
    appSessionAuthCache.clear();
    return;
  }
  appSessionAuthCache.delete(cleanSessionId);
}

function readAppSessionAuthCache(sessionId: string): AppSessionAuthCachePayload | null {
  const cleanSessionId = cleanText(sessionId);
  if (!cleanSessionId) {
    return null;
  }
  const cached = appSessionAuthCache.get(cleanSessionId);
  if (!cached) {
    return null;
  }
  if (cached.expiresAt <= Date.now()) {
    appSessionAuthCache.delete(cleanSessionId);
    return null;
  }
  if (new Date(cached.result.session.expiresAt).getTime() <= Date.now()) {
    appSessionAuthCache.delete(cleanSessionId);
    return null;
  }
  return cached.result;
}

function writeAppSessionAuthCache(sessionId: string, result: AppSessionAuthCachePayload) {
  const cleanSessionId = cleanText(sessionId);
  if (!cleanSessionId) {
    return;
  }
  appSessionAuthCache.set(cleanSessionId, {
    expiresAt: Date.now() + APP_SESSION_AUTH_CACHE_TTL_MS,
    result,
  });
  console.info('[AUTH_CACHE_STORE]', {
    cache: 'app_session_auth',
    uid: result.uid,
    role: result.role,
    sessionIdPrefix: cleanSessionId.slice(0, 8),
    expiresInMs: APP_SESSION_AUTH_CACHE_TTL_MS,
  });
}

function mirrorAcquireContextFromRequest(
  request: Request,
  context: string
): PlayerMirrorAcquireContext {
  try {
    return { context, route: new URL(request.url).pathname };
  } catch {
    return { context };
  }
}

export async function verifyAppSessionFromRequest(
  request: Request,
  options?: { mirrorClient?: PoolClient; acquireContext?: PlayerMirrorAcquireContext }
): Promise<AppSessionVerifyResult> {
  const verifyStartedAt = Date.now();
  const cookieParseStartedAt = Date.now();
  const sessionId = appSessionIdFromRequest(request);
  const timing = emptyAppSessionAuthTiming({
    cookie_parse_ms: Date.now() - cookieParseStartedAt,
  });

  if (!sessionId) {
    timing.total_ms = Date.now() - verifyStartedAt;
    console.info('[APP_SESSION_AUTH] hit=false sessionId=null reason=missing_header', timing);
    return { hit: false, sessionId: null, reason: 'missing_header', lookupMs: 0, timing };
  }

  const cacheLookupStartedAt = Date.now();
  const cachedAuth = readAppSessionAuthCache(sessionId);
  timing.cache_lookup_ms = Date.now() - cacheLookupStartedAt;

  if (cachedAuth) {
    timing.total_ms = Date.now() - verifyStartedAt;
    recordAuthCacheMetric({ route: 'app_session_auth', hit: true });
    logVerboseApiAuth('[AUTH_CACHE_HIT]', {
      cache: 'app_session_auth',
      uid: cachedAuth.uid,
      role: cachedAuth.role,
      sessionIdPrefix: sessionId.slice(0, 8),
    });
    logVerboseApiAuth('[APP_SESSION_AUTH_CACHE]', {
      hit: true,
      uid: cachedAuth.uid,
      role: cachedAuth.role,
      sessionIdPrefix: sessionId.slice(0, 8),
      durationMs: timing.total_ms,
      ...timing,
    });
    return {
      ...cachedAuth,
      lookupMs: 0,
      profileMs: 0,
      timing,
    };
  }

  recordAuthCacheMetric({ route: 'app_session_auth', hit: false });
  logVerboseApiAuth('[AUTH_CACHE_MISS]', {
    cache: 'app_session_auth',
    sessionIdPrefix: sessionId.slice(0, 8),
  });
  logVerboseApiAuth('[APP_SESSION_AUTH_CACHE]', {
    hit: false,
    uid: null,
    role: null,
    sessionIdPrefix: sessionId.slice(0, 8),
    durationMs: Date.now() - verifyStartedAt,
    cache_lookup_ms: timing.cache_lookup_ms,
  });

  const ownsMirrorClient = !options?.mirrorClient;
  const poolAcquireStartedAt = Date.now();
  const acquiredMirror = ownsMirrorClient
    ? await acquirePlayerMirrorClient(
        options?.acquireContext ?? mirrorAcquireContextFromRequest(request, 'app_session_auth')
      )
    : null;
  timing.pool_acquire_ms = ownsMirrorClient
    ? acquiredMirror?.timing.pool_acquire_ms ?? Date.now() - poolAcquireStartedAt
    : 0;
  const mirrorClient = options?.mirrorClient ?? acquiredMirror?.client ?? null;

  const lookupStartedAt = Date.now();
  const session = mirrorClient
    ? await lookupAppSessionWithClient(sessionId, mirrorClient)
    : await lookupAppSession(sessionId);
  timing.session_lookup_ms = Date.now() - lookupStartedAt;
  const lookupMs = timing.session_lookup_ms;

  if (!session) {
    const releaseStartedAt = Date.now();
    if (acquiredMirror) {
      acquiredMirror.client.release();
    }
    timing.client_release_ms = Date.now() - releaseStartedAt;
    timing.total_ms = Date.now() - verifyStartedAt;
    console.info(
      '[APP_SESSION_AUTH] hit=false uid=null role=null sessionId=%s reason=invalid_or_expired lookup_ms=%s pool_acquire_ms=%s session_lookup_ms=%s client_release_ms=%s total_ms=%s',
      sessionId,
      lookupMs,
      timing.pool_acquire_ms,
      timing.session_lookup_ms,
      timing.client_release_ms,
      timing.total_ms
    );
    return { hit: false, sessionId, reason: 'invalid_or_expired', lookupMs, timing };
  }

  const profileStartedAt = Date.now();
  let profileLookup;
  try {
    profileLookup = mirrorClient
      ? await lookupApiUserProfileFromSqlCache(session.uid, mirrorClient)
      : await lookupApiUserProfileFromSqlCache(session.uid);
  } finally {
    const releaseStartedAt = Date.now();
    if (acquiredMirror) {
      acquiredMirror.client.release();
    }
    timing.client_release_ms = Date.now() - releaseStartedAt;
  }
  timing.profile_lookup_ms = Date.now() - profileStartedAt - timing.client_release_ms;
  const profileMs = timing.profile_lookup_ms;

  if (!profileLookup.profile) {
    timing.total_ms = Date.now() - verifyStartedAt;
    logSqlAuthProfileRead({
      uid: session.uid,
      role: session.role,
      source: 'sql',
      missReason: profileLookup.missReason || 'profile_missing',
      route: 'verifyAppSessionFromRequest',
    });
    console.info(
      '[APP_SESSION_AUTH] hit=false uid=%s role=%s sessionId=%s reason=%s lookup_ms=%s profile_ms=%s pool_acquire_ms=%s session_lookup_ms=%s profile_lookup_ms=%s client_release_ms=%s total_ms=%s',
      session.uid,
      session.role,
      sessionId,
      profileLookup.missReason || 'profile_missing',
      lookupMs,
      profileMs,
      timing.pool_acquire_ms,
      timing.session_lookup_ms,
      timing.profile_lookup_ms,
      timing.client_release_ms,
      timing.total_ms
    );
    return {
      hit: false,
      sessionId,
      reason: profileLookup.missReason || 'profile_missing',
      lookupMs,
      timing,
    };
  }

  const profile = profileLookup.profile;
  logSqlAuthProfileRead({
    uid: profile.uid,
    role: profile.role,
    source: 'sql',
    route: 'verifyAppSessionFromRequest',
  });
  logSqlAuthSessionRead({
    uid: session.uid,
    sessionId,
    source: 'sql',
    route: 'verifyAppSessionFromRequest',
  });
  logSqlAuthNoFirestore('verifyAppSessionFromRequest', {
    uid: session.uid,
    role: profile.role,
    session_id: sessionId,
  });
  if (!isLoginAllowedStatus(profile.status, profile.role)) {
    timing.total_ms = Date.now() - verifyStartedAt;
    console.info(
      '[APP_SESSION_AUTH] hit=false uid=%s role=%s sessionId=%s reason=account_not_active lookup_ms=%s profile_ms=%s pool_acquire_ms=%s total_ms=%s',
      session.uid,
      profile.role,
      sessionId,
      lookupMs,
      profileMs,
      timing.pool_acquire_ms,
      timing.total_ms
    );
    return { hit: false, sessionId, reason: 'account_not_active', lookupMs, timing };
  }

  if (profile.uid !== session.uid) {
    timing.total_ms = Date.now() - verifyStartedAt;
    console.info(
      '[APP_SESSION_AUTH] hit=false uid=%s role=%s sessionId=%s reason=uid_mismatch lookup_ms=%s profile_ms=%s pool_acquire_ms=%s total_ms=%s',
      session.uid,
      session.role,
      sessionId,
      lookupMs,
      profileMs,
      timing.pool_acquire_ms,
      timing.total_ms
    );
    return { hit: false, sessionId, reason: 'uid_mismatch', lookupMs, timing };
  }

  const role = profile.role as ApiRole;
  const finalizeStartedAt = Date.now();
  const verified: AppSessionAuthCachePayload = {
    hit: true,
    sessionId,
    uid: session.uid,
    role,
    coadminUid: profile.coadminUid,
    username: profile.username,
    session,
    profile,
    lookupMs,
    profileMs,
    authPath: 'app_session_sql',
  };
  writeAppSessionAuthCache(sessionId, verified);
  timing.auth_finalize_ms = Date.now() - finalizeStartedAt;
  timing.total_ms = Date.now() - verifyStartedAt;
  scheduleAppSessionTouchIfDue(sessionId, { role });

  logVerboseApiAuth(
    '[APP_SESSION_AUTH] hit=true uid=%s role=%s sessionId=%s lookup_ms=%s profile_ms=%s shared_client=%s pool_acquire_ms=%s session_lookup_ms=%s profile_lookup_ms=%s client_release_ms=%s auth_finalize_ms=%s total_ms=%s',
    session.uid,
    role,
    sessionId,
    lookupMs,
    profileMs,
    Boolean(mirrorClient),
    timing.pool_acquire_ms,
    timing.session_lookup_ms,
    timing.profile_lookup_ms,
    timing.client_release_ms,
    timing.auth_finalize_ms,
    timing.total_ms
  );

  return { ...verified, timing };
}

export function apiError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function verifyApiTokenIdentity(
  request: Request
): Promise<{ uid: string } | { response: NextResponse }> {
  const token = bearerToken(request);
  if (!token) {
    return { response: apiError('Missing or invalid authorization.', 401) };
  }

  try {
    const decoded = await adminAuth.verifyIdToken(token);
    return { uid: decoded.uid };
  } catch {
    return { response: apiError('Invalid or expired authorization token.', 401) };
  }
}

export type PlayerLiveAuthPath =
  | 'app_session_sql_session_sql'
  | 'app_session_sql_session_firestore'
  | 'player_token_sql_session_sql'
  | 'player_token_sql_session_firestore'
  | 'player_token_firestore_session_sql'
  | 'player_token_firestore_session_firestore';

export type PlayerLiveAuthTiming = {
  auth_path: PlayerLiveAuthPath;
  verify_token_ms: number;
  sql_profile_ms: number;
  sql_profile_pool_acquire_ms: number;
  sql_profile_query_exec_ms: number;
  sql_profile_total_ms: number;
  session_sql_ms: number;
  session_sql_pool_acquire_ms: number;
  session_sql_query_exec_ms: number;
  session_sql_total_ms: number;
  /** @deprecated Use sql_profile_total_ms for SQL path; user_doc_ms for Firestore fallback */
  user_doc_ms: number;
  session_doc_ms: number;
  session_source: 'sql' | 'firestore' | 'none';
  session_check_ms: number;
  auth_ms: number;
  token_cache_hit: boolean;
  request_session_id?: string | null;
  active_session_id?: string | null;
};

type PlayerLiveAuthSuccess = {
  ok: true;
  uid: string;
  timing: PlayerLiveAuthTiming;
  profile?: ApiUserSqlProfileLookup | null;
};

function playerSessionBlockedResponse() {
  return apiError(
    'You were logged out because this account logged in on another device.',
    401
  );
}

function resolvePlayerLiveAuthPath(
  usedSqlProfile: boolean,
  sessionSource: 'sql' | 'firestore' | 'none'
): PlayerLiveAuthPath {
  const profilePart = usedSqlProfile ? 'sql' : 'firestore';
  const sessionPart = sessionSource === 'sql' ? 'sql' : 'firestore';
  return `player_token_${profilePart}_session_${sessionPart}` as PlayerLiveAuthPath;
}

export type ApiUserAuthPath =
  | 'app_session_sql'
  | 'app_session_sql_session_sql'
  | 'app_session_sql_session_firestore'
  | 'api_user_sql'
  | 'api_user_sql_session_sql'
  | 'api_user_sql_session_firestore'
  | 'api_user_firestore'
  | 'carer_app_session_sql'
  | 'carer_token_sql'
  | 'carer_token_firestore'
  | PlayerLiveAuthPath;

export type ApiUserAuthTiming = {
  auth_path: ApiUserAuthPath;
  verify_token_ms: number;
  sql_profile_ms: number;
  sql_session_ms: number;
  user_doc_ms: number;
  session_doc_ms: number;
  session_source: 'sql' | 'firestore' | 'none';
  auth_ms: number;
  token_cache_hit: boolean;
};

function apiUserFromSqlProfile(profile: ApiUserSqlProfileLookup): ApiUser {
  return {
    uid: profile.uid,
    role: profile.role as ApiRole,
    username: profile.username,
    coadminUid: profile.coadminUid,
    createdBy: profile.createdBy,
    canViewPlayers: profile.role === 'staff' ? profile.canViewPlayers : false,
    automationAgentId: profile.automationAgentId,
  };
}

function apiUserFromFirestore(uid: string, data: Record<string, unknown>): ApiUser {
  const role = String(data.role || '').toLowerCase() as ApiRole;
  return {
    uid,
    role,
    username: String(data.username || ''),
    coadminUid: String(data.coadminUid || data.createdBy || '').trim() || null,
    createdBy: String(data.createdBy || '').trim() || null,
    canViewPlayers: role === 'staff' ? Boolean(data.canViewPlayers) : false,
    automationAgentId: String(data.automationAgentId || '').trim() || null,
  };
}

type PlayerApiSessionTiming = {
  sql_session_ms?: number;
  session_doc_ms?: number;
  session_source?: 'sql' | 'firestore' | 'none';
  session_sql_ms?: number;
  session_sql_pool_acquire_ms?: number;
  session_sql_query_exec_ms?: number;
  session_sql_total_ms?: number;
};

type PlayerSessionSqlProfileHint = {
  role?: string;
  activeSessionId?: string | null;
};

async function acceptPlayerSessionBySqlProfile(
  uid: string,
  sessionId: string,
  missReason: 'row_missing' | 'postgres_unavailable' | 'lookup_failed' | 'player_mismatch' | 'inactive' | 'expired' | null,
  knownProfile?: PlayerSessionSqlProfileHint | null
) {
  if (missReason !== 'row_missing' && missReason !== 'postgres_unavailable') {
    return false;
  }

  const profile =
    knownProfile || (await lookupApiUserProfileFromSqlCache(uid)).profile || null;
  if (!profile || profile.role !== 'player') {
    return false;
  }

  return cleanText(profile.activeSessionId) === cleanText(sessionId);
}

function writePlayerSessionSqlAuthSuccess(
  appSessionId: string,
  uid: string,
  sessionId: string,
  reason: string
) {
  writePlayerSessionAuthCache(
    { appSessionId, playerSessionId: sessionId, uid },
    {
      ok: true,
      active: true,
      uid,
      activeSessionId: sessionId,
      sessionId,
      replaced: false,
      source: 'sql',
    },
    { reason }
  );
}

function applyPlayerSessionAuthCacheHit(
  timing: PlayerApiSessionTiming,
  sessionSource: 'sql' | 'firestore'
) {
  if ('sql_session_ms' in timing) {
    timing.sql_session_ms = 0;
  }
  if ('session_doc_ms' in timing) {
    timing.session_doc_ms = 0;
  }
  timing.session_source = sessionSource;
  if ('session_sql_ms' in timing) {
    timing.session_sql_ms = 0;
    timing.session_sql_pool_acquire_ms = 0;
    timing.session_sql_query_exec_ms = 0;
    timing.session_sql_total_ms = 0;
  }
}

async function validatePlayerApiSession(
  uid: string,
  sessionId: string,
  timing: PlayerApiSessionTiming,
  options?: {
    appSessionId?: string;
    knownProfile?: PlayerSessionSqlProfileHint | null;
    rechargeFirestoreInstrumentation?: boolean;
    sqlOnly?: boolean;
  }
): Promise<{ ok: true; sessionSource: 'sql' | 'firestore' } | { ok: false; response: NextResponse }> {
  const appSessionId = cleanText(options?.appSessionId);
  const cached = getCachedPlayerSessionValidation({
    appSessionId,
    playerSessionId: sessionId,
    uid,
  });
  if (cached.hit) {
    if (!cached.validation.ok) {
      applyPlayerSessionAuthCacheHit(timing, cached.validation.sessionSource);
      console.info('[API_AUTH] player request blocked', {
        uid,
        reason: cached.validation.reason || 'cached_session_invalid',
        sessionId,
        context: 'api_user_session',
        cache_hit: true,
      });
      return { ok: false, response: playerSessionBlockedResponse() };
    }

    applyPlayerSessionAuthCacheHit(timing, cached.validation.sessionSource);
    return { ok: true, sessionSource: cached.validation.sessionSource };
  }

  const sessionSqlStartedAt = Date.now();
  const sessionSqlLookup = await lookupPlayerSessionFromSqlCache(sessionId, uid);
  const sessionSqlMs = Date.now() - sessionSqlStartedAt;
  if ('sql_session_ms' in timing) {
    timing.sql_session_ms = sessionSqlMs;
  }
  if ('session_sql_ms' in timing) {
    timing.session_sql_ms = sessionSqlMs;
    timing.session_sql_pool_acquire_ms = sessionSqlLookup.timing.pool_acquire_ms;
    timing.session_sql_query_exec_ms = sessionSqlLookup.timing.query_exec_ms;
    timing.session_sql_total_ms = sessionSqlLookup.timing.total_ms;
  }

  if (sessionSqlLookup.missReason === null) {
    timing.session_source = 'sql';
    logSqlAuthSessionRead({
      uid,
      sessionId,
      source: 'sql',
      route: 'validatePlayerApiSession',
    });
    writePlayerSessionSqlAuthSuccess(appSessionId, uid, sessionId, 'api_auth_sql_success');
    return { ok: true, sessionSource: 'sql' };
  }

  if (
    (options?.sqlOnly || shouldAuthUseSqlOnly()) &&
    (await acceptPlayerSessionBySqlProfile(
      uid,
      sessionId,
      sessionSqlLookup.missReason,
      options?.knownProfile ?? null
    ))
  ) {
    timing.session_source = 'sql';
    writePlayerSessionSqlAuthSuccess(
      appSessionId,
      uid,
      sessionId,
      'api_auth_sql_profile_authority'
    );
    console.info('[API_AUTH] player session accepted via sql profile authority', {
      uid,
      sessionId,
      missReason: sessionSqlLookup.missReason,
      context: 'api_user_session_sql_only',
    });
    return { ok: true, sessionSource: 'sql' };
  }

  console.info(
    '[API_AUTH_FIRESTORE_FALLBACK] reason=%s uid=%s sessionId=%s context=api_user_session',
    sessionSqlLookup.missReason,
    uid,
    sessionId
  );

  if (options?.sqlOnly || shouldAuthUseSqlOnly()) {
    const sessionRow = sessionSqlLookup.session;
    timing.session_source = 'none';
    logSqlAuthSessionRead({
      uid,
      sessionId,
      source: 'sql',
      missReason: sessionSqlLookup.missReason || 'sql_session_missing',
      route: 'validatePlayerApiSession',
    });
    logSqlAuthNoFirestore('validatePlayerApiSession', {
      uid,
      session_id: sessionId,
      miss_reason: sessionSqlLookup.missReason || 'sql_session_missing',
    });
    console.info('[API_AUTH] player request blocked', {
      uid,
      reason: sessionSqlLookup.missReason || 'sql_session_missing',
      sessionId,
      context: 'api_user_session_sql_only',
      session_source: 'none',
      sql_query_session_id: sessionId,
      sql_query_uid: uid,
      sql_row_player_uid: sessionRow?.playerUid ?? null,
      sql_row_active: sessionRow?.active ?? null,
      sql_row_expires_at: sessionRow?.expiresAt ?? null,
      sql_row_ended_at: sessionRow?.endedAt ?? null,
      profile_active_session_id: cleanText(options?.knownProfile?.activeSessionId) || null,
    });
    return {
      ok: false,
      response: apiError('Player session not found in SQL.', 401),
    };
  }

  if (!isAuthFirestoreFallbackAllowed()) {
    logFirebaseAuthFallbackDisabled('validatePlayerApiSession', 'auth_firestore_fallback_disabled', {
      uid,
      session_id: sessionId,
      miss_reason: sessionSqlLookup.missReason,
    });
    timing.session_source = 'none';
    return {
      ok: false,
      response: apiError('Player session not found in SQL.', 401),
    };
  }

  logFirestoreTouch({
    firestore_touch_type: 'legacy_read_remove_now',
    route: 'lib/firebase/apiAuth.validatePlayerApiSession',
    operation: 'read',
    collection: 'playerSessions',
    document_id: sessionId,
    sql_read_mode: Boolean(options?.sqlOnly),
    details: { uid },
  });
  const sessionDocStartedAt = Date.now();
  const sessionSnap = options?.rechargeFirestoreInstrumentation
    ? await timedRechargeFirestoreRead(
        {
          stage: 'auth_player_session',
          collection: 'playerSessions',
          document: sessionId,
        },
        () => adminDb.collection('playerSessions').doc(sessionId).get()
      )
    : await adminDb.collection('playerSessions').doc(sessionId).get();
  timing.session_doc_ms = Date.now() - sessionDocStartedAt;
  timing.session_source = 'firestore';

  const sessionData = sessionSnap.data() || {};
  if (
    !sessionSnap.exists ||
    String(sessionData.playerUid || '') !== uid ||
    sessionData.active !== true
  ) {
    const reason = !sessionSnap.exists
      ? 'session_doc_missing'
      : String(sessionData.playerUid || '') !== uid
        ? 'session_uid_mismatch'
        : 'session_doc_inactive';
    writePlayerSessionAuthCache(
      { appSessionId, playerSessionId: sessionId, uid },
      {
        ok: false,
        reason: 'session_inactive',
        uid,
        activeSessionId: sessionId,
        sessionId,
        source: 'firestore_fallback',
      },
      { reason: 'api_auth_firestore_inactive' }
    );
    console.info('[API_AUTH] player request blocked', {
      uid,
      reason,
      sessionId,
      context: 'api_user_session',
    });
    return { ok: false, response: playerSessionBlockedResponse() };
  }

  try {
    const mirrored = await mirrorPlayerSessionById(sessionId, 'api_user_session_hydrate');
    if (!mirrored) {
      console.info(
        '[API_AUTH_FIRESTORE_FALLBACK] reason=hydrate_failed uid=%s sessionId=%s context=api_user_session',
        uid,
        sessionId
      );
    }
  } catch (error) {
    console.info(
      '[API_AUTH_FIRESTORE_FALLBACK] reason=hydrate_failed uid=%s sessionId=%s error=%s context=api_user_session',
      uid,
      sessionId,
      error
    );
  }

  writePlayerSessionAuthCache(
    { appSessionId, playerSessionId: sessionId, uid },
    {
      ok: true,
      active: true,
      uid,
      activeSessionId: sessionId,
      sessionId,
      replaced: false,
      source: 'firestore_fallback',
    },
    { reason: 'api_auth_firestore_success' }
  );
  return { ok: true, sessionSource: 'firestore' };
}

async function authenticateApiUserFromAppSession(
  request: Request,
  allowedRoles: ApiRole[],
  timing: ApiUserAuthTiming,
  options?: { rechargeFirestoreInstrumentation?: boolean }
): Promise<{ user: ApiUser; authPath: ApiUserAuthPath } | { response: NextResponse } | null> {
  const sessionId = appSessionIdFromRequest(request);
  if (!sessionId) {
    return null;
  }

  const appSessionAuth = await verifyAppSessionFromRequest(request, {
    acquireContext: mirrorAcquireContextFromRequest(request, 'api_user_auth'),
  });
  if (!appSessionAuth.hit) {
    console.info('[APP_SESSION_AUTH] api_user_path_skipped', {
      reason: appSessionAuth.reason,
      sessionIdPrefix: sessionId.slice(0, 8),
    });
    return null;
  }

  const { profile, session } = appSessionAuth;
  timing.sql_profile_ms = appSessionAuth.profileMs;
  const role = profile.role as ApiRole;

  if (!allowedRoles.includes(role)) {
    console.info('[API_AUTH] request blocked', {
      uid: session.uid,
      role,
      allowedRoles,
      auth_path: 'app_session_sql',
      reason: 'role_not_allowed',
    });
    return { response: apiError('Forbidden.', 403) };
  }

  if (role === 'player') {
    const sessionHeaderId = playerSessionId(request);
    if (!sessionHeaderId) {
      console.info('[API_AUTH] player request blocked', {
        uid: session.uid,
        role,
        reason: 'missing_player_session_header',
        auth_path: 'app_session_sql',
        app_session_id: sessionId,
        player_session_id: null,
        validates: 'player_session_sql',
      });
      return { response: apiError('X-Player-Session-Id header is required.', 401) };
    }

    const sqlReadMode = shouldAuthUseSqlOnly();
    const profileActiveSessionId = String(profile.activeSessionId || '').trim();
    const sessionValidation = await validatePlayerApiSession(session.uid, sessionHeaderId, timing, {
      appSessionId: sessionId,
      knownProfile: profile,
      rechargeFirestoreInstrumentation: options?.rechargeFirestoreInstrumentation,
      sqlOnly: sqlReadMode,
    });
    if (!sessionValidation.ok) {
      console.info('[API_AUTH] player request blocked', {
        uid: session.uid,
        reason: 'session_validation_failed',
        auth_path: 'app_session_sql',
        canonical_session_id: sessionHeaderId,
        app_session_id: sessionId,
        player_session_id: sessionHeaderId,
        profile_active_session_id: profileActiveSessionId || null,
        validates: 'player_session_sql',
      });
      return { response: sessionValidation.response };
    }

    const authPath: ApiUserAuthPath =
      sessionValidation.sessionSource === 'sql'
        ? 'app_session_sql_session_sql'
        : 'app_session_sql_session_firestore';
    timing.auth_path = authPath;
    timing.session_source = sessionValidation.sessionSource;

    const user = apiUserFromSqlProfile(profile);
    logVerboseApiAuth('[API_AUTH] player request allowed', {
      uid: session.uid,
      reason: 'session_match',
      auth_path: authPath,
      session_source: timing.session_source,
      canonical_session_id: sessionHeaderId,
      app_session_id: sessionId,
      player_session_id: sessionHeaderId,
      validates: 'player_session_sql',
    });
    return { user, authPath };
  }

  timing.auth_path = 'app_session_sql';
  const user = apiUserFromSqlProfile(profile);
  return { user, authPath: 'app_session_sql' };
}

export async function requirePlayerOwnedLiveAuth(
  request: Request,
  expectedPlayerUid: string
): Promise<
  | PlayerLiveAuthSuccess
  | { ok: false; response: NextResponse; timing: PlayerLiveAuthTiming }
> {
  const authStartedAt = Date.now();
  const expectedUid = String(expectedPlayerUid || '').trim();
  const sqlReadMode = shouldAuthUseSqlOnly();
  const timing: PlayerLiveAuthTiming = {
    auth_path: sqlReadMode
      ? 'player_token_sql_session_sql'
      : 'player_token_firestore_session_firestore',
    verify_token_ms: 0,
    sql_profile_ms: 0,
    sql_profile_pool_acquire_ms: 0,
    sql_profile_query_exec_ms: 0,
    sql_profile_total_ms: 0,
    session_sql_ms: 0,
    session_sql_pool_acquire_ms: 0,
    session_sql_query_exec_ms: 0,
    session_sql_total_ms: 0,
    user_doc_ms: 0,
    session_doc_ms: 0,
    session_source: 'none',
    session_check_ms: 0,
    auth_ms: 0,
    token_cache_hit: false,
  };

  if (!expectedUid) {
    timing.auth_ms = Date.now() - authStartedAt;
    return { ok: false, response: apiError('Forbidden.', 403), timing };
  }

  const sessionId = playerSessionId(request);
  const appSessionId = appSessionIdFromRequest(request);
  timing.request_session_id = sessionId || null;

  const logPlayerLiveAuthBlocked = (
    uid: string,
    reason: string,
    extra?: { activeSessionId?: string | null }
  ) => {
    if (extra?.activeSessionId !== undefined) {
      timing.active_session_id = extra.activeSessionId;
    }
    console.info('[API_AUTH] player request blocked', {
      uid,
      reason,
      auth_path: timing.auth_path,
      session_source: timing.session_source,
      request_session_id: timing.request_session_id,
      active_session_id: timing.active_session_id ?? null,
      sql_read_mode: sqlReadMode,
    });
  };

  const finishPlayerLiveAuth = (
    uid: string,
    authPath: PlayerLiveAuthPath,
    sessionSource: 'sql' | 'firestore',
    activeSessionId?: string | null,
    profile?: ApiUserSqlProfileLookup | null
  ) => {
    timing.auth_path = authPath;
    timing.session_source = sessionSource;
    timing.active_session_id = activeSessionId ?? sessionId ?? null;
    logVerboseApiAuth('[API_AUTH] player request allowed', {
      uid,
      reason: 'session_match',
      auth_path: timing.auth_path,
      session_source: timing.session_source,
      request_session_id: timing.request_session_id,
      active_session_id: timing.active_session_id,
      token_cache_hit: timing.token_cache_hit,
      sql_profile_ms: timing.sql_profile_total_ms,
      session_sql_ms: timing.session_sql_total_ms,
      user_doc_ms: timing.user_doc_ms,
      session_doc_ms: timing.session_doc_ms,
      sql_read_mode: sqlReadMode,
    });
    timing.auth_ms = Date.now() - authStartedAt;
    return { ok: true as const, uid, timing, profile: profile ?? null };
  };

  const attemptAppSessionPlayerAuth = async () => {
    timing.auth_path = 'app_session_sql_session_sql';
    const appSessionAuth = await verifyAppSessionFromRequest(request);
    if (!appSessionAuth.hit) {
      console.info('[API_AUTH] player live auth app_session_miss', {
        expected_uid: expectedUid,
        app_session_id: appSessionId,
        player_session_id: sessionId || null,
        reason: appSessionAuth.reason,
        session_source: 'none',
      });
      timing.auth_ms = Date.now() - authStartedAt;
      return {
        ok: false as const,
        response: apiError('Invalid or expired app session.', 401),
        timing,
      };
    }

    if (appSessionAuth.profile.role !== 'player') {
      timing.auth_ms = Date.now() - authStartedAt;
      return { ok: false as const, response: apiError('Forbidden.', 403), timing };
    }

    const authUid = appSessionAuth.uid;
    if (authUid !== expectedUid) {
      console.info('[API_AUTH] player live auth uid_mismatch', {
        expected_uid: expectedUid,
        app_session_uid: authUid,
        app_session_id: appSessionId,
        player_session_id: sessionId || null,
      });
      timing.auth_ms = Date.now() - authStartedAt;
      return { ok: false as const, response: apiError('Forbidden.', 403), timing };
    }

    if (!sessionId) {
      console.info('[API_AUTH] player request blocked', {
        uid: authUid,
        reason: 'missing_session_header',
        sessionId: null,
        auth_path: 'app_session_sql_session_sql',
        app_session_id: appSessionId,
      });
      timing.auth_ms = Date.now() - authStartedAt;
      return {
        ok: false as const,
        response: apiError('X-Player-Session-Id header is required.', 401),
        timing,
      };
    }

    const sessionCheckStartedAt = Date.now();
    const sessionValidation = await validatePlayerApiSession(authUid, sessionId, timing, {
      appSessionId: appSessionAuth.sessionId,
      knownProfile: appSessionAuth.profile,
      sqlOnly: sqlReadMode,
    });
    timing.session_check_ms = Date.now() - sessionCheckStartedAt;
    if (!sessionValidation.ok) {
      timing.auth_path =
        timing.session_source === 'firestore'
          ? 'app_session_sql_session_firestore'
          : 'app_session_sql_session_sql';
      timing.auth_ms = Date.now() - authStartedAt;
      return { ok: false as const, response: sessionValidation.response, timing };
    }

    return finishPlayerLiveAuth(
      authUid,
      sessionValidation.sessionSource === 'sql'
        ? 'app_session_sql_session_sql'
        : 'app_session_sql_session_firestore',
      sessionValidation.sessionSource,
      undefined,
      appSessionAuth.profile
    );
  };

  if (appSessionId) {
    return await attemptAppSessionPlayerAuth();
  }

  const token = bearerToken(request);
  if (!token) {
    timing.auth_ms = Date.now() - authStartedAt;
    return { ok: false, response: apiError('Missing or invalid authorization.', 401), timing };
  }

  const verifyStartedAt = Date.now();
  let identityUid = '';
  try {
    const verified = await verifyLiveCarerApiToken(token);
    identityUid = verified.uid;
    timing.token_cache_hit = verified.cacheHit;
  } catch {
    timing.verify_token_ms = Date.now() - verifyStartedAt;
    timing.auth_ms = Date.now() - authStartedAt;
    return { ok: false, response: apiError('Invalid or expired authorization token.', 401), timing };
  }
  timing.verify_token_ms = Date.now() - verifyStartedAt;

  if (identityUid !== expectedUid) {
    timing.auth_ms = Date.now() - authStartedAt;
    return { ok: false, response: apiError('Forbidden.', 403), timing };
  }

  if (!sessionId) {
    console.info('[API_AUTH] player request blocked', {
      uid: identityUid,
      reason: 'missing_session_header',
      sessionId: null,
      activeSessionId: null,
    });
    timing.auth_ms = Date.now() - authStartedAt;
    return {
      ok: false,
      response: apiError('X-Player-Session-Id header is required.', 401),
      timing,
    };
  }

  const sqlProfileStartedAt = Date.now();
  const sqlProfileLookup = await lookupPlayerProfileFromSqlCache(identityUid);
  timing.sql_profile_ms = Date.now() - sqlProfileStartedAt;
  timing.sql_profile_pool_acquire_ms = sqlProfileLookup.timing.pool_acquire_ms;
  timing.sql_profile_query_exec_ms = sqlProfileLookup.timing.query_exec_ms;
  timing.sql_profile_total_ms = sqlProfileLookup.timing.total_ms;

  if (sqlReadMode) {
    logSqlAuthNoFirestore('requirePlayerOwnedLiveAuth', { uid: identityUid, branch: 'bearer_token' });
    if (!sqlProfileLookup.profile || sqlProfileLookup.missReason) {
      const reason = sqlProfileLookup.missReason || 'row_missing';
      logSqlAuthProfileRead({
        uid: identityUid,
        source: 'sql',
        missReason: reason,
        route: 'requirePlayerOwnedLiveAuth',
      });
      console.info('[LIVE_AUTH_PLAYER_SQL] blocked uid=%s reason=%s', identityUid, reason);
      timing.auth_ms = Date.now() - authStartedAt;
      if (reason === 'postgres_unavailable') {
        return {
          ok: false,
          response: apiError('SQL auth is unavailable. Configure DATABASE_URL on the server.', 503),
          timing,
        };
      }
      return {
        ok: false,
        response: apiError(
          'User profile not found in SQL cache. Ensure players_cache is populated for this user.',
          404
        ),
        timing,
      };
    }

    if (sqlProfileLookup.profile.role !== 'player') {
      timing.auth_ms = Date.now() - authStartedAt;
      return { ok: false, response: apiError('Forbidden.', 403), timing };
    }

    const sessionCheckStartedAt = Date.now();
    const sessionValidation = await validatePlayerApiSession(identityUid, sessionId, timing, {
      appSessionId,
      knownProfile: sqlProfileLookup.profile,
      sqlOnly: true,
    });
    timing.session_check_ms = Date.now() - sessionCheckStartedAt;
    if (!sessionValidation.ok) {
      timing.auth_ms = Date.now() - authStartedAt;
      return { ok: false, response: sessionValidation.response, timing };
    }

    return finishPlayerLiveAuth(
      identityUid,
      sessionValidation.sessionSource === 'sql'
        ? 'player_token_sql_session_sql'
        : 'player_token_sql_session_firestore',
      sessionValidation.sessionSource
    );
  }

  const usedSqlProfile = sqlProfileLookup.profile?.role === 'player';
  const sqlActiveSessionId = usedSqlProfile
    ? String(sqlProfileLookup.profile?.activeSessionId || '').trim()
    : '';

  if (!usedSqlProfile) {
    if (sqlProfileLookup.profile && sqlProfileLookup.profile.role !== 'player') {
      timing.auth_ms = Date.now() - authStartedAt;
      return { ok: false, response: apiError('Forbidden.', 403), timing };
    }

    if (sqlProfileLookup.missReason) {
      console.info('[LIVE_AUTH_PLAYER_FALLBACK] reason=%s uid=%s', sqlProfileLookup.missReason, identityUid);
    }

    if (!isAuthFirestoreFallbackAllowed()) {
      logFirebaseAuthFallbackDisabled('requirePlayerOwnedLiveAuth', 'auth_firestore_fallback_disabled', {
        uid: identityUid,
        miss_reason: sqlProfileLookup.missReason || 'row_missing',
      });
      timing.auth_ms = Date.now() - authStartedAt;
      return {
        ok: false,
        response: apiError(
          'User profile not found in SQL cache. Ensure players_cache is populated for this user.',
          404
        ),
        timing,
      };
    }

    logFirestoreTouch({
      firestore_touch_type: 'legacy_read_remove_now',
      route: 'lib/firebase/apiAuth.requirePlayerOwnedLiveAuth',
      operation: 'read',
      collection: 'users',
      document_id: identityUid,
      sql_read_mode: false,
    });
    const userDocStartedAt = Date.now();
    const userSnap = await adminDb.collection('users').doc(identityUid).get();
    timing.user_doc_ms = Date.now() - userDocStartedAt;

    if (!userSnap.exists) {
      timing.auth_ms = Date.now() - authStartedAt;
      return { ok: false, response: apiError('User profile not found.', 401), timing };
    }

    const data = userSnap.data() || {};
    const role = String(data.role || '').toLowerCase() as ApiRole;
    if (role !== 'player') {
      timing.auth_ms = Date.now() - authStartedAt;
      return { ok: false, response: apiError('Forbidden.', 403), timing };
    }

    try {
      await mirrorPlayerById(identityUid, 'player_live_auth_hydrate');
    } catch (error) {
      console.info('[LIVE_AUTH_PLAYER_FALLBACK] hydrate_failed uid=%s error=%s', identityUid, error);
    }
  }

  const sessionCheckStartedAt = Date.now();
  const sessionValidation = await validatePlayerApiSession(identityUid, sessionId, timing, {
    appSessionId,
    knownProfile: sqlProfileLookup.profile,
    sqlOnly: shouldAuthUseSqlOnly(),
  });
  timing.session_check_ms = Date.now() - sessionCheckStartedAt;

  if (!sessionValidation.ok) {
    timing.auth_path = resolvePlayerLiveAuthPath(usedSqlProfile, timing.session_source);
    logPlayerLiveAuthBlocked(identityUid, 'session_validation_failed', {
      activeSessionId: sqlActiveSessionId || null,
    });
    timing.auth_ms = Date.now() - authStartedAt;
    return { ok: false, response: sessionValidation.response, timing };
  }

  return finishPlayerLiveAuth(
    identityUid,
    resolvePlayerLiveAuthPath(usedSqlProfile, sessionValidation.sessionSource),
    sessionValidation.sessionSource,
    sessionId
  );
}

export type CarerLiveAuthTiming = {
  auth_path: 'carer_app_session_sql' | 'carer_token_sql' | 'carer_token_firestore';
  auth_ms: number;
  verify_token_ms: number;
  sql_profile_ms: number;
  /** @deprecated Use sql_profile_total_ms */
  sql_profile_query_ms: number;
  sql_profile_pool_acquire_ms: number;
  sql_profile_query_exec_ms: number;
  sql_profile_total_ms: number;
  user_doc_ms: number;
  token_cache_hit: boolean;
  firestore_fallback: boolean;
  source: 'sql' | 'firestore';
};

function emptyCarerLiveAuthTiming(): CarerLiveAuthTiming {
  return {
    auth_path: 'carer_token_firestore',
    auth_ms: 0,
    verify_token_ms: 0,
    sql_profile_ms: 0,
    sql_profile_query_ms: 0,
    sql_profile_pool_acquire_ms: 0,
    sql_profile_query_exec_ms: 0,
    sql_profile_total_ms: 0,
    user_doc_ms: 0,
    token_cache_hit: false,
    firestore_fallback: false,
    source: 'sql',
  };
}

function carerAuthPathToApiUserAuthPath(
  path: CarerLiveAuthTiming['auth_path']
): ApiUserAuthPath {
  if (path === 'carer_app_session_sql') return 'carer_app_session_sql';
  if (path === 'carer_token_sql') return 'carer_token_sql';
  return 'carer_token_firestore';
}

function carerLiveAuthTimingToApiUserTiming(timing: CarerLiveAuthTiming): ApiUserAuthTiming {
  return {
    auth_path: carerAuthPathToApiUserAuthPath(timing.auth_path),
    verify_token_ms: timing.verify_token_ms,
    sql_profile_ms: timing.sql_profile_total_ms || timing.sql_profile_ms,
    sql_session_ms: 0,
    user_doc_ms: timing.user_doc_ms,
    session_doc_ms: 0,
    session_source: timing.source === 'firestore' ? 'firestore' : 'sql',
    auth_ms: timing.auth_ms,
    token_cache_hit: timing.token_cache_hit,
  };
}

async function resolveCarerRouteAuthUid(request: Request) {
  const appSessionId = appSessionIdFromRequest(request);
  if (appSessionId) {
    const appAuth = await verifyAppSessionFromRequest(request);
    if (appAuth.hit && appAuth.profile.role === 'carer') {
      return { uid: appAuth.uid, branch: 'app_session_sql' as const };
    }
    console.info('[API_AUTH] carer_api_user resolve_failed', {
      branch: 'app_session_invalid',
      app_session_id: appSessionId,
      reason: appAuth.hit ? 'role_not_carer' : appAuth.reason,
    });
    return null;
  }

  const token = bearerToken(request);
  if (!token) {
    return null;
  }

  try {
    const verified = await verifyLiveCarerApiToken(token);
    return { uid: verified.uid, branch: 'bearer_token' as const };
  } catch {
    return null;
  }
}

export async function requireCarerOwnedLiveAuth(
  request: Request,
  expectedCarerUid: string,
  options?: { mirrorClient?: PoolClient }
): Promise<
  | { ok: true; uid: string; coadminUid: string | null; timing: CarerLiveAuthTiming }
  | { ok: false; response: NextResponse; timing: CarerLiveAuthTiming }
> {
  const authStartedAt = Date.now();
  const expectedUid = String(expectedCarerUid || '').trim();
  const sqlReadMode = shouldAuthUseSqlOnly();
  const timing = emptyCarerLiveAuthTiming();

  if (!expectedUid) {
    timing.auth_ms = Date.now() - authStartedAt;
    return { ok: false, response: apiError('Forbidden.', 403), timing };
  }

  if (appSessionIdFromRequest(request)) {
    const appSessionAuth = await verifyAppSessionFromRequest(request, options);
    if (
      appSessionAuth.hit &&
      appSessionAuth.role === 'carer' &&
      appSessionAuth.uid === expectedUid
    ) {
      timing.auth_path = 'carer_app_session_sql';
      timing.sql_profile_ms = appSessionAuth.profileMs;
      timing.sql_profile_total_ms = appSessionAuth.profileMs;
      timing.source = 'sql';
      timing.firestore_fallback = false;
      timing.auth_ms = Date.now() - authStartedAt;
      console.info('[API_AUTH] carer live auth allowed', {
        uid: expectedUid,
        auth_path: timing.auth_path,
        source: timing.source,
        firestore_fallback: timing.firestore_fallback,
        sql_profile_ms: timing.sql_profile_ms,
        user_doc_ms: 0,
        sql_read_mode: sqlReadMode,
      });
      return {
        ok: true,
        uid: expectedUid,
        coadminUid: appSessionAuth.coadminUid,
        timing,
      };
    }
  }

  const token = bearerToken(request);
  if (!token) {
    timing.auth_ms = Date.now() - authStartedAt;
    return { ok: false, response: apiError('Missing or invalid authorization.', 401), timing };
  }

  const verifyStartedAt = Date.now();
  let identityUid = '';
  try {
    const verified = await verifyLiveCarerApiToken(token);
    identityUid = verified.uid;
    timing.token_cache_hit = verified.cacheHit;
  } catch {
    timing.verify_token_ms = Date.now() - verifyStartedAt;
    timing.auth_ms = Date.now() - authStartedAt;
    return { ok: false, response: apiError('Invalid or expired authorization token.', 401), timing };
  }
  timing.verify_token_ms = Date.now() - verifyStartedAt;

  if (identityUid !== expectedUid) {
    timing.auth_ms = Date.now() - authStartedAt;
    return { ok: false, response: apiError('Forbidden.', 403), timing };
  }

  const sqlProfileStartedAt = Date.now();
  const sqlProfileLookup = await lookupCarerProfileFromSqlCache(identityUid, options?.mirrorClient);
  timing.sql_profile_ms = Date.now() - sqlProfileStartedAt;
  timing.sql_profile_query_ms = sqlProfileLookup.timing.total_ms;
  timing.sql_profile_pool_acquire_ms = sqlProfileLookup.timing.pool_acquire_ms;
  timing.sql_profile_query_exec_ms = sqlProfileLookup.timing.query_exec_ms;
  timing.sql_profile_total_ms = sqlProfileLookup.timing.total_ms;

  const finishCarerSqlAuth = (coadminUid: string | null) => {
    timing.auth_path = 'carer_token_sql';
    timing.source = 'sql';
    timing.firestore_fallback = false;
    timing.auth_ms = Date.now() - authStartedAt;
    console.info('[API_AUTH] carer live auth allowed', {
      uid: identityUid,
      auth_path: timing.auth_path,
      source: timing.source,
      firestore_fallback: timing.firestore_fallback,
      sql_profile_ms: timing.sql_profile_ms,
      user_doc_ms: 0,
      sql_read_mode: sqlReadMode,
    });
    return {
      ok: true as const,
      uid: identityUid,
      coadminUid,
      timing,
    };
  };

  if (sqlProfileLookup.profile?.role === 'carer') {
    logSqlAuthProfileRead({
      uid: identityUid,
      role: 'carer',
      source: 'sql',
      route: 'requireCarerOwnedLiveAuth',
    });
    return finishCarerSqlAuth(sqlProfileLookup.profile.coadminUid);
  }

  if (sqlReadMode) {
    logSqlAuthNoFirestore('requireCarerOwnedLiveAuth', { uid: identityUid });
    if (
      !isAppbegSqlOnlyMode() &&
      (sqlProfileLookup.missReason === 'row_missing' ||
        sqlProfileLookup.missReason === 'role_mismatch')
    ) {
      try {
        await mirrorPlayerById(identityUid, 'carer_live_auth_hydrate');
      } catch (error) {
        console.info('[API_AUTH] carer live auth hydrate_failed', {
          uid: identityUid,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      const retryLookup = await lookupCarerProfileFromSqlCache(identityUid, options?.mirrorClient);
      timing.sql_profile_ms = Date.now() - sqlProfileStartedAt;
      timing.sql_profile_query_ms = retryLookup.timing.total_ms;
      timing.sql_profile_pool_acquire_ms = retryLookup.timing.pool_acquire_ms;
      timing.sql_profile_query_exec_ms = retryLookup.timing.query_exec_ms;
      timing.sql_profile_total_ms = retryLookup.timing.total_ms;
      if (retryLookup.profile?.role === 'carer') {
        return finishCarerSqlAuth(retryLookup.profile.coadminUid);
      }
    }

    const reason = sqlProfileLookup.missReason || 'row_missing';
    logSqlAuthProfileRead({
      uid: identityUid,
      source: 'sql',
      missReason: reason,
      route: 'requireCarerOwnedLiveAuth',
    });
    timing.source = 'sql';
    timing.firestore_fallback = false;
    timing.auth_ms = Date.now() - authStartedAt;
    console.info('[API_AUTH] carer live auth blocked', {
      uid: identityUid,
      reason,
      auth_path: timing.auth_path,
      source: timing.source,
      firestore_fallback: timing.firestore_fallback,
      sql_profile_ms: timing.sql_profile_ms,
      user_doc_ms: 0,
      sql_read_mode: sqlReadMode,
    });
    if (reason === 'postgres_unavailable' || reason === 'lookup_failed') {
      return {
        ok: false,
        response: apiError('SQL auth is unavailable. Configure DATABASE_URL on the server.', 503),
        timing,
      };
    }
    return {
      ok: false,
      response: apiError(
        'Carer profile not found in SQL cache. Ensure players_cache is populated for this user.',
        404
      ),
      timing,
    };
  }

  console.info('[API_AUTH_FIRESTORE_FALLBACK] reason=%s uid=%s context=carer_live_auth', {
    reason: sqlProfileLookup.missReason || 'row_missing',
    uid: identityUid,
    firestore_fallback: true,
  });

  if (!isAuthFirestoreFallbackAllowed()) {
    logFirebaseAuthFallbackDisabled('requireCarerOwnedLiveAuth', 'auth_firestore_fallback_disabled', {
      uid: identityUid,
      miss_reason: sqlProfileLookup.missReason || 'row_missing',
    });
    timing.auth_ms = Date.now() - authStartedAt;
    return {
      ok: false,
      response: apiError(
        'Carer profile not found in SQL cache. Ensure players_cache is populated for this user.',
        404
      ),
      timing,
    };
  }

  logFirestoreTouch({
    firestore_touch_type: 'legacy_read_remove_now',
    route: 'lib/firebase/apiAuth.requireCarerOwnedLiveAuth',
    operation: 'read',
    collection: 'users',
    document_id: identityUid,
    sql_read_mode: false,
  });
  const userDocStartedAt = Date.now();
  const userSnap = await adminDb.collection('users').doc(identityUid).get();
  timing.user_doc_ms = Date.now() - userDocStartedAt;

  if (!userSnap.exists) {
    timing.auth_ms = Date.now() - authStartedAt;
    return { ok: false, response: apiError('User profile not found.', 401), timing };
  }

  const data = userSnap.data() || {};
  const role = String(data.role || '').toLowerCase() as ApiRole;
  if (role !== 'carer') {
    timing.auth_ms = Date.now() - authStartedAt;
    return { ok: false, response: apiError('Forbidden.', 403), timing };
  }

  const coadminUid =
    String(data.coadminUid || data.createdBy || '').trim() || null;
  try {
    await mirrorPlayerById(identityUid, 'carer_live_auth_hydrate');
    console.info('[LIVE_AUTH_SQL_PROFILE] hydrate uid=%s coadminUid=%s', identityUid, coadminUid);
  } catch (error) {
    console.info('[LIVE_AUTH_SQL_PROFILE] hydrate_failed uid=%s', identityUid, error);
  }

  timing.auth_path = 'carer_token_firestore';
  timing.source = 'firestore';
  timing.firestore_fallback = true;
  timing.auth_ms = Date.now() - authStartedAt;
  console.info('[API_AUTH] carer live auth allowed', {
    uid: identityUid,
    auth_path: timing.auth_path,
    source: timing.source,
    firestore_fallback: timing.firestore_fallback,
    sql_profile_ms: timing.sql_profile_ms,
    user_doc_ms: timing.user_doc_ms,
    sql_read_mode: sqlReadMode,
  });
  return {
    ok: true,
    uid: identityUid,
    coadminUid,
    timing,
  };
}

export async function requireCarerApiUser(
  request: Request
): Promise<
  | { user: ApiUser; authPath: ApiUserAuthPath; timing: CarerLiveAuthTiming }
  | { response: NextResponse; timing: CarerLiveAuthTiming }
> {
  const authStartedAt = Date.now();
  const sqlReadMode = shouldAuthUseSqlOnly();
  const resolved = await resolveCarerRouteAuthUid(request);
  if (!resolved) {
    const timing = emptyCarerLiveAuthTiming();
    timing.auth_ms = Date.now() - authStartedAt;
    console.info('[API_AUTH] carer_api_user blocked', {
      branch: 'missing_credentials',
      reason: 'unable_to_resolve_carer_uid',
      sql_read_mode: sqlReadMode,
    });
    return {
      response: apiError('Missing or invalid authorization.', 401),
      timing,
    };
  }

  console.info('[API_AUTH] carer_api_user resolve', {
    branch: resolved.branch,
    uid: resolved.uid,
    app_session_id: appSessionIdFromRequest(request) || null,
    sql_read_mode: sqlReadMode,
  });

  const auth = await requireCarerOwnedLiveAuth(request, resolved.uid);
  if (!auth.ok) {
    console.info('[API_AUTH] carer_api_user blocked', {
      branch: resolved.branch,
      uid: resolved.uid,
      reason: 'live_auth_denied',
      auth_path: auth.timing.auth_path,
      source: auth.timing.source,
      firestore_fallback: auth.timing.firestore_fallback,
    });
    return { response: auth.response, timing: auth.timing };
  }

  let profileLookup = await lookupApiUserProfileFromSqlCache(auth.uid);
  if (!profileLookup.profile && !isAppbegSqlOnlyMode()) {
    try {
      await mirrorPlayerById(auth.uid, 'carer_api_auth_hydrate');
    } catch (error) {
      console.info('[API_AUTH] carer_api_user hydrate_failed', {
        uid: auth.uid,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    profileLookup = await lookupApiUserProfileFromSqlCache(auth.uid);
  }

  if (!profileLookup.profile || profileLookup.profile.role !== 'carer') {
    const reason = profileLookup.missReason || 'row_missing';
    logSqlAuthProfileRead({
      uid: auth.uid,
      role: profileLookup.profile?.role ?? null,
      source: 'sql',
      missReason: reason,
      route: 'requireCarerApiUser',
    });
    logSqlAuthNoFirestore('requireCarerApiUser', { uid: auth.uid, reason });
    console.info('[API_AUTH] carer_api_user blocked', {
      branch: resolved.branch,
      uid: auth.uid,
      reason,
      auth_path: auth.timing.auth_path,
      source: 'sql',
      firestore_fallback: false,
      sql_read_mode: sqlReadMode,
    });
    if (reason === 'postgres_unavailable' || reason === 'lookup_failed') {
      return {
        response: apiError('SQL auth is unavailable. Configure DATABASE_URL on the server.', 503),
        timing: auth.timing,
      };
    }
    return {
      response: apiError(
        'Carer profile not found in SQL cache. Ensure players_cache is populated for this user.',
        404
      ),
      timing: auth.timing,
    };
  }

  const authPath = carerAuthPathToApiUserAuthPath(auth.timing.auth_path);
  auth.timing.auth_ms = Date.now() - authStartedAt;
  console.info('[API_AUTH] carer_api_user allowed', {
    branch: resolved.branch,
    uid: auth.uid,
    auth_path: authPath,
    source: auth.timing.source,
    firestore_fallback: auth.timing.firestore_fallback,
    sql_profile_ms: auth.timing.sql_profile_ms,
    user_doc_ms: auth.timing.user_doc_ms,
    sql_read_mode: sqlReadMode,
    auth_ms: auth.timing.auth_ms,
  });

  return {
    user: apiUserFromSqlProfile(profileLookup.profile),
    authPath,
    timing: auth.timing,
  };
}

export function apiUserAuthSqlMs(timing: ApiUserAuthTiming) {
  return timing.sql_profile_ms + timing.sql_session_ms;
}

export function apiUserAuthFirestoreMs(timing: ApiUserAuthTiming) {
  return timing.session_doc_ms + timing.user_doc_ms;
}

function playerLiveAuthTimingToApiUserTiming(timing: PlayerLiveAuthTiming): ApiUserAuthTiming {
  return {
    auth_path: timing.auth_path,
    verify_token_ms: timing.verify_token_ms,
    sql_profile_ms: timing.sql_profile_total_ms || timing.sql_profile_ms,
    sql_session_ms: timing.session_sql_ms,
    user_doc_ms: timing.user_doc_ms,
    session_doc_ms: timing.session_doc_ms,
    session_source: timing.session_source,
    auth_ms: timing.auth_ms,
    token_cache_hit: timing.token_cache_hit,
  };
}

function emptyPlayerLiveAuthTiming(sqlReadMode: boolean): PlayerLiveAuthTiming {
  return {
    auth_path: sqlReadMode
      ? 'player_token_sql_session_sql'
      : 'player_token_firestore_session_firestore',
    verify_token_ms: 0,
    sql_profile_ms: 0,
    sql_profile_pool_acquire_ms: 0,
    sql_profile_query_exec_ms: 0,
    sql_profile_total_ms: 0,
    session_sql_ms: 0,
    session_sql_pool_acquire_ms: 0,
    session_sql_query_exec_ms: 0,
    session_sql_total_ms: 0,
    user_doc_ms: 0,
    session_doc_ms: 0,
    session_source: 'none',
    session_check_ms: 0,
    auth_ms: 0,
    token_cache_hit: false,
  };
}

export type PlayerApiAuthResult =
  | { user: ApiUser; authPath: PlayerLiveAuthPath; timing: PlayerLiveAuthTiming }
  | { response: NextResponse; timing: PlayerLiveAuthTiming };

async function resolvePlayerRouteAuthUid(request: Request) {
  const appSessionId = appSessionIdFromRequest(request);
  const playerSessionHeaderId = playerSessionId(request);

  if (appSessionId) {
    const appAuth = await verifyAppSessionFromRequest(request);
    if (appAuth.hit && appAuth.profile.role === 'player') {
      return { uid: appAuth.uid, branch: 'app_session_sql' as const };
    }
    console.info('[API_AUTH] player_api_user resolve_failed', {
      branch: 'app_session_invalid',
      app_session_id: appSessionId,
      player_session_id: playerSessionHeaderId || null,
      reason: appAuth.hit ? 'role_not_player' : appAuth.reason,
    });
    return null;
  }

  if (playerSessionHeaderId) {
    const owner = await lookupPlayerSessionOwnerFromSql(playerSessionHeaderId);
    if (owner?.playerUid && owner.active) {
      return { uid: owner.playerUid, branch: 'player_session_sql' as const };
    }
    console.info('[API_AUTH] player_api_user resolve_failed', {
      branch: 'player_session_owner_missing',
      player_session_id: playerSessionHeaderId,
      owner_uid: owner?.playerUid || null,
      owner_active: owner?.active ?? null,
      owner_expires_at: owner?.expiresAt ?? null,
      owner_ended_at: owner?.endedAt ?? null,
    });
  }

  const token = bearerToken(request);
  if (!token) {
    return null;
  }

  try {
    const verified = await verifyLiveCarerApiToken(token);
    return { uid: verified.uid, branch: 'bearer_token' as const };
  } catch {
    return null;
  }
}

export async function requirePlayerApiUser(
  request: Request,
  options?: { rechargeFirestoreInstrumentation?: boolean }
): Promise<PlayerApiAuthResult> {
  void options;
  const sqlReadMode = shouldAuthUseSqlOnly();
  const authStartedAt = Date.now();

  const resolved = await resolvePlayerRouteAuthUid(request);
  if (!resolved) {
    const timing = emptyPlayerLiveAuthTiming(sqlReadMode);
    timing.auth_ms = Date.now() - authStartedAt;
    console.info('[API_AUTH] player_api_user blocked', {
      branch: 'missing_credentials',
      reason: 'unable_to_resolve_player_uid',
      auth_path: timing.auth_path,
      app_session_id: appSessionIdFromRequest(request) || null,
      player_session_id: playerSessionId(request) || null,
    });
    return {
      response: apiError('Missing or invalid authorization.', 401),
      timing,
    };
  }

  const playerUid = resolved.uid;
  const resolveBranch = resolved.branch;
  logVerboseApiAuth('[API_AUTH] player_api_user resolve', {
    branch: resolveBranch,
    uid: playerUid,
    app_session_id: appSessionIdFromRequest(request) || null,
    player_session_id: playerSessionId(request) || null,
    canonical_session_id: playerSessionId(request) || null,
    sql_read_mode: sqlReadMode,
  });

  const auth = await requirePlayerOwnedLiveAuth(request, playerUid);
  if (!auth.ok) {
    console.info('[API_AUTH] player_api_user blocked', {
      branch: resolveBranch,
      uid: playerUid,
      reason: 'live_auth_denied',
      auth_path: auth.timing.auth_path,
      session_source: auth.timing.session_source,
      request_session_id: auth.timing.request_session_id ?? null,
      active_session_id: auth.timing.active_session_id ?? null,
    });
    return { response: auth.response, timing: auth.timing };
  }

  const reusedProfile = auth.profile?.role === 'player' ? auth.profile : null;
  let profileLookup: Awaited<ReturnType<typeof lookupApiUserProfileFromSqlCache>>;
  if (reusedProfile) {
    logVerboseApiAuth('[AUTH_PROFILE_REUSED]', {
      uid: auth.uid,
      role: reusedProfile.role,
      source: 'requirePlayerOwnedLiveAuth',
      route: 'requirePlayerApiUser',
    });
    profileLookup = {
      profile: reusedProfile,
      timing: {
        pool_acquire_ms: 0,
        query_exec_ms: 0,
        total_ms: 0,
      },
      missReason: null,
    };
  } else {
    console.info('[AUTH_PROFILE_SQL_LOOKUP]', {
      uid: auth.uid,
      reason: 'profile_not_available_from_live_auth',
      route: 'requirePlayerApiUser',
    });
    profileLookup = await lookupApiUserProfileFromSqlCache(auth.uid);
  }
  if (!profileLookup.profile && !isAppbegSqlOnlyMode()) {
    try {
      await mirrorPlayerById(auth.uid, 'player_api_auth_hydrate');
    } catch (error) {
      console.info('[API_AUTH] player_api_user hydrate_failed', {
        uid: auth.uid,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    console.info('[AUTH_PROFILE_SQL_LOOKUP]', {
      uid: auth.uid,
      reason: 'post_hydrate_retry',
      route: 'requirePlayerApiUser',
    });
    profileLookup = await lookupApiUserProfileFromSqlCache(auth.uid);
  }

  if (!profileLookup.profile || profileLookup.profile.role !== 'player') {
    const reason = profileLookup.missReason || 'row_missing';
    logSqlAuthProfileRead({
      uid: auth.uid,
      role: profileLookup.profile?.role ?? null,
      source: 'sql',
      missReason: reason,
      route: 'requirePlayerApiUser',
    });
    logSqlAuthNoFirestore('requirePlayerApiUser', { uid: auth.uid, reason });
    console.info('[API_AUTH] player_api_user blocked', {
      branch: resolveBranch,
      uid: auth.uid,
      reason,
      auth_path: auth.timing.auth_path,
      sql_read_mode: sqlReadMode,
    });
    if (reason === 'postgres_unavailable') {
      return {
        response: apiError('SQL auth is unavailable. Configure DATABASE_URL on the server.', 503),
        timing: auth.timing,
      };
    }
    return {
      response: apiError(
        'User profile not found in SQL cache. Ensure players_cache is populated for this user.',
        404
      ),
      timing: auth.timing,
    };
  }

  logVerboseApiAuth('[API_AUTH] player_api_user allowed', {
    branch: resolveBranch,
    uid: auth.uid,
    auth_path: auth.timing.auth_path,
    session_source: auth.timing.session_source,
    canonical_session_id: auth.timing.request_session_id ?? null,
    app_session_id: appSessionIdFromRequest(request) || null,
    player_session_id: auth.timing.request_session_id ?? null,
    sql_read_mode: sqlReadMode,
    auth_ms: Date.now() - authStartedAt,
  });
  logSqlAuthProfileRead({
    uid: auth.uid,
    role: 'player',
    source: 'sql',
    route: 'requirePlayerApiUser',
  });
  logSqlAuthNoFirestore('requirePlayerApiUser', { uid: auth.uid, allowed: true });

  return {
    user: apiUserFromSqlProfile(profileLookup.profile),
    authPath: auth.timing.auth_path,
    timing: auth.timing,
  };
}

export async function requireApiUser(
  request: Request,
  allowedRoles: ApiRole[],
  options?: { rechargeFirestoreInstrumentation?: boolean }
): Promise<
  | { user: ApiUser; authPath: ApiUserAuthPath; timing: ApiUserAuthTiming }
  | { response: NextResponse; timing: ApiUserAuthTiming }
> {
  const authStartedAt = Date.now();
  const timing: ApiUserAuthTiming = {
    auth_path: 'api_user_firestore',
    verify_token_ms: 0,
    sql_profile_ms: 0,
    sql_session_ms: 0,
    user_doc_ms: 0,
    session_doc_ms: 0,
    session_source: 'none',
    auth_ms: 0,
    token_cache_hit: false,
  };

  if (allowedRoles.length === 1 && allowedRoles[0] === 'carer') {
    const carerAuth = await requireCarerApiUser(request);
    if ('response' in carerAuth) {
      return {
        response: carerAuth.response,
        timing: carerLiveAuthTimingToApiUserTiming(carerAuth.timing),
      };
    }
    const carerTiming = carerLiveAuthTimingToApiUserTiming(carerAuth.timing);
    carerTiming.auth_ms = Date.now() - authStartedAt;
    logVerboseApiAuth('[API_AUTH] request allowed', {
      uid: carerAuth.user.uid,
      role: carerAuth.user.role,
      auth_path: carerAuth.authPath,
      source: carerAuth.timing.source,
      firestore_fallback: carerAuth.timing.firestore_fallback,
      session_source: carerTiming.session_source,
      token_cache_hit: carerTiming.token_cache_hit,
      verify_token_ms: carerTiming.verify_token_ms,
      sql_profile_ms: carerTiming.sql_profile_ms,
      sql_session_ms: 0,
      user_doc_ms: carerTiming.user_doc_ms,
      session_doc_ms: 0,
      auth_ms: carerTiming.auth_ms,
    });
    return {
      user: carerAuth.user,
      authPath: carerAuth.authPath,
      timing: carerTiming,
    };
  }

  if (allowedRoles.length === 1 && allowedRoles[0] === 'player') {
    const playerAuth = await requirePlayerApiUser(request, options);
    if ('response' in playerAuth) {
      return {
        response: playerAuth.response,
        timing: playerLiveAuthTimingToApiUserTiming(playerAuth.timing),
      };
    }
    const playerTiming = playerLiveAuthTimingToApiUserTiming(playerAuth.timing);
    playerTiming.auth_path = playerAuth.authPath;
    playerTiming.auth_ms = Date.now() - authStartedAt;
    logVerboseApiAuth('[API_AUTH] request allowed', {
      uid: playerAuth.user.uid,
      role: playerAuth.user.role,
      auth_path: playerAuth.authPath,
      session_source: playerTiming.session_source,
      token_cache_hit: playerTiming.token_cache_hit,
      verify_token_ms: playerTiming.verify_token_ms,
      sql_profile_ms: playerTiming.sql_profile_ms,
      sql_session_ms: playerTiming.sql_session_ms,
      user_doc_ms: 0,
      session_doc_ms: playerTiming.session_doc_ms,
      auth_ms: playerTiming.auth_ms,
      validates: 'player_session_sql',
    });
    return {
      user: playerAuth.user,
      authPath: playerAuth.authPath,
      timing: playerTiming,
    };
  }

  const appSessionAuthResult = await authenticateApiUserFromAppSession(
    request,
    allowedRoles,
    timing,
    options
  );
  if (appSessionAuthResult) {
    if ('response' in appSessionAuthResult) {
      timing.auth_ms = Date.now() - authStartedAt;
      return { response: appSessionAuthResult.response, timing };
    }
    timing.auth_ms = Date.now() - authStartedAt;
    logVerboseApiAuth('[API_AUTH] request allowed', {
      uid: appSessionAuthResult.user.uid,
      role: appSessionAuthResult.user.role,
      auth_path: appSessionAuthResult.authPath,
      session_source: timing.session_source,
      token_cache_hit: false,
      verify_token_ms: 0,
      sql_profile_ms: timing.sql_profile_ms,
      sql_session_ms: timing.sql_session_ms,
      user_doc_ms: 0,
      session_doc_ms: timing.session_doc_ms,
      auth_ms: timing.auth_ms,
    });
    return {
      user: appSessionAuthResult.user,
      authPath: appSessionAuthResult.authPath,
      timing,
    };
  }

  const token = bearerToken(request);
  if (!token) {
    timing.auth_ms = Date.now() - authStartedAt;
    return { response: apiError('Missing or invalid authorization.', 401), timing };
  }

  const verifyStartedAt = Date.now();
  let identityUid = '';
  try {
    const verified = await verifyLiveCarerApiToken(token);
    identityUid = verified.uid;
    timing.token_cache_hit = verified.cacheHit;
  } catch {
    timing.verify_token_ms = Date.now() - verifyStartedAt;
    timing.auth_ms = Date.now() - authStartedAt;
    return { response: apiError('Invalid or expired authorization token.', 401), timing };
  }
  timing.verify_token_ms = Date.now() - verifyStartedAt;

  const sqlProfileStartedAt = Date.now();
  const sqlProfileLookup = await lookupApiUserProfileFromSqlCache(identityUid);
  timing.sql_profile_ms = Date.now() - sqlProfileStartedAt;

  let user: ApiUser | null = null;
  let usedSqlProfile = false;
  let activeSessionId = '';

  if (sqlProfileLookup.profile) {
    const role = sqlProfileLookup.profile.role as ApiRole;
    logSqlAuthProfileRead({
      uid: identityUid,
      role,
      source: 'sql',
      route: 'requireApiUser',
    });
    if (!allowedRoles.includes(role)) {
      timing.auth_ms = Date.now() - authStartedAt;
      console.info('[API_AUTH] request blocked', {
        uid: identityUid,
        role,
        allowedRoles,
        auth_path: timing.auth_path,
        reason: 'role_not_allowed',
      });
      return { response: apiError('Forbidden.', 403), timing };
    }

    if (role === 'player') {
      usedSqlProfile = true;
      user = apiUserFromSqlProfile(sqlProfileLookup.profile);
      timing.auth_path = 'api_user_sql';
      activeSessionId = String(sqlProfileLookup.profile.activeSessionId || '').trim();
    } else {
      usedSqlProfile = true;
      user = apiUserFromSqlProfile(sqlProfileLookup.profile);
      timing.auth_path = 'api_user_sql';
    }
  } else if (sqlProfileLookup.missReason) {
    console.info(
      '[API_AUTH_FIRESTORE_FALLBACK] reason=%s uid=%s context=api_user_profile',
      sqlProfileLookup.missReason,
      identityUid
    );
  }

  if (!usedSqlProfile) {
    if (shouldAuthUseSqlOnly()) {
      const reason = sqlProfileLookup.missReason || 'row_missing';
      logSqlAuthProfileRead({
        uid: identityUid,
        source: 'sql',
        missReason: reason,
        route: 'requireApiUser',
      });
      logSqlAuthNoFirestore('requireApiUser', { uid: identityUid, reason });
      timing.auth_ms = Date.now() - authStartedAt;
      console.info('[API_AUTH] request blocked', {
        uid: identityUid,
        allowedRoles,
        reason,
        auth_path: timing.auth_path,
        source: 'sql',
        firestore_fallback: false,
        sql_profile_ms: timing.sql_profile_ms,
        user_doc_ms: 0,
        sql_read_mode: true,
      });
      if (reason === 'postgres_unavailable' || reason === 'lookup_failed') {
        return {
          response: apiError('SQL auth is unavailable. Configure DATABASE_URL on the server.', 503),
          timing,
        };
      }
      return {
        response: apiError(
          'User profile not found in SQL cache. Ensure players_cache is populated for this user.',
          404
        ),
        timing,
      };
    }

    console.info('[API_AUTH_FIRESTORE_FALLBACK]', {
      reason: sqlProfileLookup.missReason || 'row_missing',
      uid: identityUid,
      context: 'api_user_profile',
      firestore_fallback: true,
    });

    if (!isAuthFirestoreFallbackAllowed()) {
      logFirebaseAuthFallbackDisabled('requireApiUser', 'auth_firestore_fallback_disabled', {
        uid: identityUid,
        miss_reason: sqlProfileLookup.missReason || 'row_missing',
      });
      timing.auth_ms = Date.now() - authStartedAt;
      return {
        response: apiError(
          'User profile not found in SQL cache. Ensure players_cache is populated for this user.',
          404
        ),
        timing,
      };
    }

    logFirestoreTouch({
      firestore_touch_type: 'legacy_read_remove_now',
      route: 'lib/firebase/apiAuth.requireApiUser',
      operation: 'read',
      collection: 'users',
      document_id: identityUid,
      sql_read_mode: false,
    });
    const userDocStartedAt = Date.now();
    const snap = await adminDb.collection('users').doc(identityUid).get();
    timing.user_doc_ms = Date.now() - userDocStartedAt;

    if (!snap.exists) {
      timing.auth_ms = Date.now() - authStartedAt;
      return { response: apiError('User profile not found.', 401), timing };
    }

    const data = snap.data() || {};
    const role = String(data.role || '').toLowerCase() as ApiRole;
    if (!allowedRoles.includes(role)) {
      timing.auth_ms = Date.now() - authStartedAt;
      return { response: apiError('Forbidden.', 403), timing };
    }

    user = apiUserFromFirestore(identityUid, data);
    activeSessionId = String(data.activeSessionId || '').trim();
    timing.auth_path = 'api_user_firestore';
    timing.session_source = 'firestore';

    try {
      await mirrorPlayerById(identityUid, 'api_user_auth_hydrate');
    } catch (error) {
      console.info(
        '[API_AUTH_FIRESTORE_FALLBACK] reason=hydrate_failed uid=%s error=%s context=api_user_profile',
        identityUid,
        error
      );
    }
  }

  if (!user) {
    timing.auth_ms = Date.now() - authStartedAt;
    return { response: apiError('User profile not found.', 401), timing };
  }

  if (user.role === 'player') {
    const sessionId = playerSessionId(request);
    const appSessionId = appSessionIdFromRequest(request);
    if (!sessionId) {
      console.info('[API_AUTH] player request blocked', {
        uid: identityUid,
        reason: 'missing_session_header',
        canonical_session_id: null,
        app_session_id: appSessionId || null,
        player_session_id: null,
        profile_active_session_id: activeSessionId || null,
        auth_path: timing.auth_path,
        validates: 'player_session_sql',
      });
      timing.auth_ms = Date.now() - authStartedAt;
      return { response: apiError('X-Player-Session-Id header is required.', 401), timing };
    }

    const sessionValidation = await validatePlayerApiSession(identityUid, sessionId, timing, {
      appSessionId,
      knownProfile: sqlProfileLookup.profile,
      sqlOnly: shouldAuthUseSqlOnly(),
      rechargeFirestoreInstrumentation: options?.rechargeFirestoreInstrumentation,
    });
    if (!sessionValidation.ok) {
      console.info('[API_AUTH] player request blocked', {
        uid: identityUid,
        reason: 'session_validation_failed',
        canonical_session_id: sessionId,
        app_session_id: appSessionId || null,
        player_session_id: sessionId,
        profile_active_session_id: activeSessionId || null,
        auth_path: timing.auth_path,
        session_source: timing.session_source,
        validates: 'player_session_sql',
      });
      timing.auth_ms = Date.now() - authStartedAt;
      return { response: sessionValidation.response, timing };
    }

    if (usedSqlProfile && sessionValidation.sessionSource === 'sql') {
      timing.auth_path = 'api_user_sql_session_sql';
    } else if (usedSqlProfile) {
      timing.auth_path = 'api_user_sql_session_firestore';
    }

    logVerboseApiAuth('[API_AUTH] player request allowed', {
      uid: identityUid,
      reason: 'session_match',
      auth_path: timing.auth_path,
      session_source: timing.session_source,
      canonical_session_id: sessionId,
      app_session_id: appSessionId || null,
      player_session_id: sessionId,
      validates: 'player_session_sql',
    });
  }

  timing.auth_ms = Date.now() - authStartedAt;
  logSqlAuthNoFirestore('requireApiUser', {
    uid: user.uid,
    role: user.role,
    auth_path: timing.auth_path,
  });
  logVerboseApiAuth('[API_AUTH] request allowed', {
    uid: user.uid,
    role: user.role,
    auth_path: timing.auth_path,
    source: timing.auth_path === 'api_user_firestore' ? 'firestore' : 'sql',
    firestore_fallback: timing.auth_path === 'api_user_firestore',
    session_source: timing.session_source,
    token_cache_hit: timing.token_cache_hit,
    verify_token_ms: timing.verify_token_ms,
    sql_profile_ms: timing.sql_profile_ms,
    sql_session_ms: timing.sql_session_ms,
    user_doc_ms: timing.user_doc_ms,
    session_doc_ms: timing.session_doc_ms,
    auth_ms: timing.auth_ms,
  });

  return { user, authPath: timing.auth_path, timing };
}

export function scopedCoadminUid(user: ApiUser) {
  if (user.role === 'coadmin') {
    return user.uid;
  }
  return user.coadminUid || user.createdBy || null;
}

export function belongsToScope(
  target: { coadminUid?: unknown; createdBy?: unknown },
  coadminUid: string
) {
  return (
    String(target.coadminUid || '').trim() === coadminUid ||
    String(target.createdBy || '').trim() === coadminUid
  );
}
