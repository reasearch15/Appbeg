import { NextResponse } from 'next/server';

import { verifyAppSessionFromRequest } from '@/lib/firebase/apiAuth';
import { recordRouteMetric } from '@/lib/server/logMetrics';
import { logSqlAuthNoFirestore, logSqlAuthProfileRead, logSqlAuthSessionRead } from '@/lib/server/appbegSqlOnlyMode';
import { AUTH_SLOW_MS, isSqlAuthVerboseLogs } from '@/lib/server/verboseLogs';
import { readSessionMePlayerExtras } from '@/lib/server/sessionMeExtras';
import { cleanText } from '@/lib/sql/playerMirrorCommon';
import { lookupApiUserProfileFromSqlCache } from '@/lib/sql/playersCache';

export const runtime = 'nodejs';

export const dynamic = 'force-dynamic';

const SESSION_ME_ROUTE_CACHE_TTL_MS = 20_000;

type SessionMeStableBody = {
  ok: true;
  uid: string;
  role: string;
  coadminUid: string | null;
  username: string;
  status: string | null;
  canViewPlayers?: boolean;
  expiresAt: string;
  appSessionId: string;
  sessionSource: 'sql';
  playerSessionId?: string;
  canonicalSessionId?: string;
};

type SessionMeRouteCacheEntry = {
  expiresAt: number;
  cachedAt: number;
  body: SessionMeStableBody;
};

const globalSessionMeCache = globalThis as typeof globalThis & {
  __appbegSessionMeRouteCache?: Map<string, SessionMeRouteCacheEntry>;
};

function sessionMeRouteCache() {
  if (!globalSessionMeCache.__appbegSessionMeRouteCache) {
    globalSessionMeCache.__appbegSessionMeRouteCache = new Map();
  }
  return globalSessionMeCache.__appbegSessionMeRouteCache;
}

function sessionIdFromRequest(request: Request) {
  return cleanText(request.headers.get('X-App-Session-Id'));
}

function buildSessionMeCacheKey(input: { sessionId: string; uid: string; role: string }) {
  return `${cleanText(input.sessionId)}:${cleanText(input.uid)}:${cleanText(input.role).toLowerCase()}`;
}

function readSessionMeRouteCache(input: {
  sessionId: string;
  uid: string;
  role: string;
  expiresAt: string;
}) {
  const cacheKey = buildSessionMeCacheKey(input);
  const cached = sessionMeRouteCache().get(cacheKey);
  if (!cached) {
    if (isSqlAuthVerboseLogs()) {
      console.info('[SESSION_ME_CACHE_MISS]', {
        uid: input.uid,
        role: input.role,
        sessionIdPrefix: input.sessionId.slice(0, 8),
        reason: 'empty',
      });
    }
    return null;
  }
  if (
    cached.expiresAt <= Date.now() ||
    new Date(input.expiresAt).getTime() <= Date.now()
  ) {
    sessionMeRouteCache().delete(cacheKey);
    if (isSqlAuthVerboseLogs()) {
      console.info('[SESSION_ME_CACHE_MISS]', {
        uid: input.uid,
        role: input.role,
        sessionIdPrefix: input.sessionId.slice(0, 8),
        reason: 'expired',
      });
    }
    return null;
  }
  if (isSqlAuthVerboseLogs()) {
    console.info('[SESSION_ME_CACHE_HIT]', {
      uid: input.uid,
      role: input.role,
      sessionIdPrefix: input.sessionId.slice(0, 8),
      ageMs: Date.now() - cached.cachedAt,
      expiresInMs: cached.expiresAt - Date.now(),
    });
  }
  return cached.body;
}

function writeSessionMeRouteCache(input: {
  sessionId: string;
  uid: string;
  role: string;
  body: SessionMeStableBody;
}) {
  const cacheKey = buildSessionMeCacheKey(input);
  const now = Date.now();
  sessionMeRouteCache().set(cacheKey, {
    cachedAt: now,
    expiresAt: now + SESSION_ME_ROUTE_CACHE_TTL_MS,
    body: input.body,
  });
  if (isSqlAuthVerboseLogs()) {
    console.info('[SESSION_ME_CACHE_STORE]', {
      uid: input.uid,
      role: input.role,
      sessionIdPrefix: input.sessionId.slice(0, 8),
      expiresInMs: SESSION_ME_ROUTE_CACHE_TTL_MS,
      cachedFields: 'stable_session_profile_metadata',
    });
  }
}

function responseSizeBytes(body: unknown) {
  return Buffer.byteLength(JSON.stringify(body), 'utf8');
}

export async function GET(request: Request) {

  const totalStartedAt = Date.now();
  const sessionId = sessionIdFromRequest(request);

  const auth = await verifyAppSessionFromRequest(request, {
    acquireContext: { context: 'app_session_auth', route: '/api/auth/session/me' },
  });

  const authTiming = auth.timing;

  if (!auth.hit) {

    const total_ms = Date.now() - totalStartedAt;
    recordRouteMetric({
      route: '/api/auth/session/me',
      durationMs: total_ms,
      ok: false,
      slowThresholdMs: AUTH_SLOW_MS,
    });

    console.info('[APP_SESSION_ME]', {

      ok: false,

      reason: auth.reason,

      durationMs: total_ms,

    });

    console.info('[APP_SESSION_ME_TIMING]', {

      ok: false,

      reason: auth.reason,

      cookie_parse_ms: authTiming.cookie_parse_ms,

      session_lookup_ms: authTiming.session_lookup_ms,

      profile_lookup_ms: authTiming.profile_lookup_ms,

      pool_acquire_ms: authTiming.pool_acquire_ms,

      cache_lookup_ms: authTiming.cache_lookup_ms,

      client_release_ms: authTiming.client_release_ms,

      auth_finalize_ms: authTiming.auth_finalize_ms,

      auth_total_ms: authTiming.total_ms,

      serialization_ms: 0,

      response_ms: 0,

      total_ms,

      unaccounted_ms: Math.max(

        0,

        total_ms -

          authTiming.cookie_parse_ms -

          authTiming.cache_lookup_ms -

          authTiming.pool_acquire_ms -

          authTiming.session_lookup_ms -

          authTiming.profile_lookup_ms -

          authTiming.client_release_ms -

          authTiming.auth_finalize_ms

      ),

    });
    console.info('[SESSION_ME_TIMING]', {
      ok: false,
      reason: auth.reason,
      session_lookup_ms: authTiming.session_lookup_ms,
      auth_validation_ms: authTiming.total_ms,
      profile_lookup_ms: authTiming.profile_lookup_ms,
      player_session_ms: 0,
      cache_lookup_ms: authTiming.cache_lookup_ms,
      player_extras_ms: 0,
      serialization_ms: 0,
      response_ms: 0,
      total_ms,
    });
    console.info('[SESSION_ME_RESPONSE_SIZE]', {
      ok: false,
      bytes: responseSizeBytes({ ok: false, reason: auth.reason }),
    });

    return NextResponse.json(

      { ok: false, reason: auth.reason },

      { status: auth.reason === 'missing_header' ? 401 : 401 }

    );

  }

  const cacheReadStartedAt = Date.now();
  const cachedStableBody =
    auth.role === 'staff'
      ? null
      : readSessionMeRouteCache({
          sessionId,
          uid: auth.uid,
          role: auth.role,
          expiresAt: auth.session.expiresAt,
        });
  const sessionMeCacheLookupMs = Date.now() - cacheReadStartedAt;

  if (cachedStableBody) {
    if (isSqlAuthVerboseLogs()) {
      console.info('[SESSION_ME_PROFILE_REUSED]', {
        uid: auth.uid,
        role: auth.role,
        source: 'session_me_route_cache',
      });
    }
  }

  if (auth.role === 'player') {
    if (isSqlAuthVerboseLogs()) {
      console.info('[SESSION_ME_DUPLICATE_READ]', {
        uid: auth.uid,
        table: 'players_cache',
        reason: 'player_extras_requires_live_balance_and_notice_fields',
        profileReused: Boolean(cachedStableBody),
      });
    }
  }

  const freshStaffProfile =
    auth.role === 'staff'
      ? (await lookupApiUserProfileFromSqlCache(auth.uid)).profile
      : null;

  const playerExtrasStartedAt = Date.now();

  const playerExtras =
    auth.role === 'player'
      ? await readSessionMePlayerExtras({
          uid: auth.uid,
          coadminUid: auth.coadminUid,
        })
      : null;
  const player_extras_ms = Date.now() - playerExtrasStartedAt;

  const playerSessionId =
    auth.role === 'player'
      ? String(auth.profile.activeSessionId || '').trim() || null
      : null;

  const stableBody =
    cachedStableBody ||
    ({

      ok: true as const,

      uid: auth.uid,

      role: auth.role,

      coadminUid: auth.coadminUid,

      username: auth.username,

      status: auth.profile.status,
      ...(auth.role === 'staff'
        ? { canViewPlayers: Boolean(freshStaffProfile?.canViewPlayers) }
        : {}),

      expiresAt: auth.session.expiresAt,

      appSessionId: auth.sessionId,

      sessionSource: 'sql' as const,

      ...(playerSessionId
        ? {
            playerSessionId,
            canonicalSessionId: playerSessionId,
          }
        : {}),

    } satisfies SessionMeStableBody);

  if (!cachedStableBody && auth.role !== 'staff') {
    writeSessionMeRouteCache({
      sessionId,
      uid: auth.uid,
      role: auth.role,
      body: stableBody,
    });
  }

  const serializationStartedAt = Date.now();
  const body = {
    ...stableBody,
    ...(playerExtras
      ? {
          player: playerExtras,
        }
      : {}),

  };

  const serialization_ms = Date.now() - serializationStartedAt;
  const response_size_bytes = responseSizeBytes(body);

  const responseStartedAt = Date.now();

  const response = NextResponse.json(body);

  const response_ms = Date.now() - responseStartedAt;

  const total_ms = Date.now() - totalStartedAt;
  recordRouteMetric({
    route: '/api/auth/session/me',
    durationMs: total_ms,
    ok: true,
    slowThresholdMs: AUTH_SLOW_MS,
  });

  if (isSqlAuthVerboseLogs() || total_ms >= AUTH_SLOW_MS) {
  console.info('[APP_SESSION_ME]', {

    ok: true,

    uid: auth.uid,

    role: auth.role,

    source: 'sql',

    firestore_fallback: false,

    user_doc_ms: 0,

    durationMs: total_ms,

  });
  logSqlAuthProfileRead({
    uid: auth.uid,
    role: auth.role,
    source: 'sql',
    route: '/api/auth/session/me',
  });
  logSqlAuthSessionRead({
    uid: auth.uid,
    sessionId: auth.sessionId,
    source: 'sql',
    route: '/api/auth/session/me',
  });
  logSqlAuthNoFirestore('/api/auth/session/me', {
    uid: auth.uid,
    role: auth.role,
    app_session_id: auth.sessionId,
  });

  console.info('[APP_SESSION_ME_TIMING]', {

    ok: true,

    uid: auth.uid,

    role: auth.role,

    cookie_parse_ms: authTiming.cookie_parse_ms,

    session_lookup_ms: authTiming.session_lookup_ms,

    profile_lookup_ms: authTiming.profile_lookup_ms,

    pool_acquire_ms: authTiming.pool_acquire_ms,

    cache_lookup_ms: authTiming.cache_lookup_ms,

    client_release_ms: authTiming.client_release_ms,

    auth_finalize_ms: authTiming.auth_finalize_ms,

    auth_total_ms: authTiming.total_ms,

    serialization_ms,

    response_ms,

    total_ms,

    unaccounted_ms: Math.max(

      0,

      total_ms -

        authTiming.total_ms -

        serialization_ms -

        response_ms

    ),

  });
  console.info('[SESSION_ME_TIMING]', {
    ok: true,
    uid: auth.uid,
    role: auth.role,
    session_lookup_ms: authTiming.session_lookup_ms,
    auth_validation_ms: authTiming.total_ms,
    profile_lookup_ms: authTiming.profile_lookup_ms,
    player_session_ms: 0,
    cache_lookup_ms: authTiming.cache_lookup_ms + sessionMeCacheLookupMs,
    player_extras_ms,
    serialization_ms,
    response_ms,
    total_ms,
    unaccounted_ms: Math.max(
      0,
      total_ms -
        authTiming.total_ms -
        sessionMeCacheLookupMs -
        player_extras_ms -
        serialization_ms -
        response_ms
    ),
  });
  console.info('[SESSION_ME_RESPONSE_SIZE]', {
    ok: true,
    uid: auth.uid,
    role: auth.role,
    bytes: response_size_bytes,
    hasPlayerExtras: Boolean(playerExtras),
  });
  }

  return response;

}
