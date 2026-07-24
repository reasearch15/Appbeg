import 'server-only';

import type { DocumentSnapshot } from 'firebase-admin/firestore';

import { adminDb } from '@/lib/firebase/admin';
import {
  cleanText,
  getPlayerMirrorPool,
  normalizeJson,
  runMirrorPoolQuery,
  type PlayerMirrorSqlTiming,
  toIsoString,
} from '@/lib/sql/playerMirrorCommon';

function logPlayerCacheInfo(message: string, details?: unknown) {
  if (process.env.NODE_ENV === 'production') {
    return;
  }
  if (details === undefined) {
    console.info(message);
    return;
  }
  console.info(message, details);
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

async function lookupCoadminUidForPlayer(playerUid: string) {
  const db = getPlayerMirrorPool();
  const cleanUid = cleanText(playerUid);
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

export type PlayerSessionSqlLookup = {
  sessionId: string;
  playerUid: string;
  coadminUid: string | null;
  active: boolean;
  endedAt: string | null;
  expiresAt: string | null;
};

export type PlayerSessionSqlLookupResult = {
  session: PlayerSessionSqlLookup | null;
  timing: PlayerMirrorSqlTiming;
  missReason:
    | 'row_missing'
    | 'player_mismatch'
    | 'inactive'
    | 'expired'
    | 'postgres_unavailable'
    | 'lookup_failed'
    | null;
};

function sessionStatus(active: boolean, endedAt: string | null) {
  if (endedAt) {
    return 'ended';
  }
  return active ? 'active' : 'inactive';
}

export async function upsertPlayerSessionCache(
  sessionId: string,
  data: Record<string, unknown>,
  source = 'appbeg',
  coadminUid?: string | null
) {
  const db = getPlayerMirrorPool();
  const cleanSessionId = cleanText(sessionId);
  const playerUid = cleanText(data.playerUid);
  if (!db || !cleanSessionId || !playerUid) {
    return false;
  }

  const active = booleanOrNull(data.active) ?? true;
  const endedAt = toIsoString(data.endedAt);
  const resolvedCoadminUid =
    cleanText(coadminUid) || (await lookupCoadminUidForPlayer(playerUid));

  try {
    await db.query(
      `
        INSERT INTO public.player_sessions_cache (
          session_id, player_uid, coadmin_uid, device_id, active, status,
          started_at, last_seen_at, ended_at, ended_reason, expires_at,
          created_at, updated_at, raw_firestore_data, source, mirrored_at, deleted_at
        )
        VALUES (
          $1, $2, NULLIF($3, ''), NULLIF($4, ''), $5, NULLIF($6, ''),
          $7::timestamptz, $8::timestamptz, $9::timestamptz, NULLIF($10, ''),
          $11::timestamptz, $12::timestamptz, $13::timestamptz,
          $14::jsonb, $15, now(), NULL
        )
        ON CONFLICT (session_id) DO UPDATE SET
          player_uid = EXCLUDED.player_uid,
          coadmin_uid = EXCLUDED.coadmin_uid,
          device_id = EXCLUDED.device_id,
          active = EXCLUDED.active,
          status = EXCLUDED.status,
          started_at = COALESCE(public.player_sessions_cache.started_at, EXCLUDED.started_at),
          last_seen_at = EXCLUDED.last_seen_at,
          ended_at = EXCLUDED.ended_at,
          ended_reason = EXCLUDED.ended_reason,
          expires_at = EXCLUDED.expires_at,
          created_at = COALESCE(public.player_sessions_cache.created_at, EXCLUDED.created_at),
          updated_at = EXCLUDED.updated_at,
          raw_firestore_data = EXCLUDED.raw_firestore_data,
          source = EXCLUDED.source,
          mirrored_at = now(),
          deleted_at = NULL
      `,
      [
        cleanSessionId,
        playerUid,
        resolvedCoadminUid,
        cleanText(data.deviceId),
        active,
        sessionStatus(active, endedAt),
        toIsoString(data.startedAt),
        toIsoString(data.lastSeenAt),
        endedAt,
        cleanText(data.endedReason),
        toIsoString(data.expiresAt),
        toIsoString(data.startedAt),
        toIsoString(data.lastSeenAt) || toIsoString(data.endedAt),
        JSON.stringify(normalizeJson(data) || {}),
        source,
      ]
    );
    logPlayerCacheInfo('[PLAYER_SESSIONS_CACHE] mirror upsert ok', {
      sessionId: cleanSessionId,
      playerUid,
    });
    return true;
  } catch (error) {
    console.error('[PLAYER_SESSIONS_CACHE] mirror failed', {
      sessionId: cleanSessionId,
      playerUid,
      error,
    });
    return false;
  }
}

export async function mirrorPlayerSessionSnapshot(
  snap: DocumentSnapshot,
  source = 'appbeg',
  coadminUid?: string | null
) {
  if (!snap.exists) {
    return false;
  }
  return upsertPlayerSessionCache(
    snap.id,
    (snap.data() || {}) as Record<string, unknown>,
    source,
    coadminUid
  );
}

export async function mirrorPlayerSessionById(sessionId: string, source = 'appbeg') {
  const cleanSessionId = cleanText(sessionId);
  if (!cleanSessionId) {
    return false;
  }
  try {
    const snap = await adminDb.collection('playerSessions').doc(cleanSessionId).get();
    if (!snap.exists) {
      return false;
    }
    const data = (snap.data() || {}) as Record<string, unknown>;
    const coadminUid = await lookupCoadminUidForPlayer(cleanText(data.playerUid));
    return mirrorPlayerSessionSnapshot(snap, source, coadminUid);
  } catch (error) {
    console.error('[PLAYER_SESSIONS_CACHE] mirror failed', { sessionId: cleanSessionId, error });
    return false;
  }
}

export async function lookupPlayerSessionOwnerFromSql(sessionId: string) {
  const cleanSessionId = cleanText(sessionId);
  const db = getPlayerMirrorPool();
  if (!db || !cleanSessionId) {
    return null;
  }

  try {
    const result = await db.query<Record<string, unknown>>(
      `
        SELECT session_id, player_uid, active, ended_at, expires_at
        FROM public.player_sessions_cache
        WHERE session_id = $1
          AND deleted_at IS NULL
        LIMIT 1
      `,
      [cleanSessionId]
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return {
      sessionId: cleanText(row.session_id),
      playerUid: cleanText(row.player_uid),
      active: row.active === true,
      endedAt: toIsoString(row.ended_at),
      expiresAt: toIsoString(row.expires_at),
    };
  } catch (error) {
    logPlayerCacheInfo('[PLAYER_SESSIONS_CACHE] owner_lookup_failed', {
      sessionId: cleanSessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function lookupPlayerSessionFromSqlCache(
  sessionId: string,
  expectedPlayerUid: string
): Promise<PlayerSessionSqlLookupResult> {
  const startedAt = Date.now();
  const cleanSessionId = cleanText(sessionId);
  const cleanPlayerUid = cleanText(expectedPlayerUid);
  const db = getPlayerMirrorPool();

  if (!db || !cleanSessionId || !cleanPlayerUid) {
    const timing = {
      pool_acquire_ms: 0,
      query_exec_ms: 0,
      total_ms: Date.now() - startedAt,
    };
    console.info(
      '[LIVE_AUTH_SESSION_SQL] hit=false sessionId=%s playerUid=%s active=%s expired=%s reason=%s',
      cleanSessionId || null,
      cleanPlayerUid || null,
      null,
      null,
      'postgres_unavailable'
    );
    return { session: null, timing, missReason: 'postgres_unavailable' };
  }

  const sessionSql = `
    SELECT session_id, player_uid, coadmin_uid, active, ended_at, expires_at
    FROM public.player_sessions_cache
    WHERE session_id = $1
      AND deleted_at IS NULL
    LIMIT 1
  `;

  try {
    const { rows, timing } = await runMirrorPoolQuery<Record<string, unknown>>(db, sessionSql, [
      cleanSessionId,
    ]);

    if (!rows.length) {
      console.info(
        '[LIVE_AUTH_SESSION_SQL] hit=false sessionId=%s playerUid=%s active=%s expired=%s reason=%s pool_acquire_ms=%s query_exec_ms=%s total_ms=%s',
        cleanSessionId,
        cleanPlayerUid,
        null,
        null,
        'row_missing',
        timing.pool_acquire_ms,
        timing.query_exec_ms,
        timing.total_ms
      );
      return { session: null, timing, missReason: 'row_missing' };
    }

    const row = rows[0];
    const session = {
      sessionId: cleanText(row.session_id),
      playerUid: cleanText(row.player_uid),
      coadminUid: cleanText(row.coadmin_uid) || null,
      active: row.active === true,
      endedAt: toIsoString(row.ended_at),
      expiresAt: toIsoString(row.expires_at),
    } satisfies PlayerSessionSqlLookup;

    const expiredByEndedAt = Boolean(session.endedAt);
    const expiredByExpiresAt =
      Boolean(session.expiresAt) && Date.parse(session.expiresAt!) <= Date.now();

    if (session.playerUid !== cleanPlayerUid) {
      console.info(
        '[LIVE_AUTH_SESSION_SQL] hit=false sessionId=%s playerUid=%s active=%s expired=%s reason=%s',
        cleanSessionId,
        cleanPlayerUid,
        session.active,
        expiredByEndedAt || expiredByExpiresAt,
        'player_mismatch'
      );
      return { session, timing, missReason: 'player_mismatch' };
    }

    if (!session.active) {
      console.info(
        '[LIVE_AUTH_SESSION_SQL] hit=false sessionId=%s playerUid=%s active=%s expired=%s reason=%s',
        cleanSessionId,
        cleanPlayerUid,
        false,
        expiredByEndedAt || expiredByExpiresAt,
        'inactive'
      );
      return { session, timing, missReason: 'inactive' };
    }

    if (expiredByEndedAt || expiredByExpiresAt) {
      console.info(
        '[LIVE_AUTH_SESSION_SQL] hit=false sessionId=%s playerUid=%s active=%s expired=%s reason=%s',
        cleanSessionId,
        cleanPlayerUid,
        session.active,
        true,
        'expired'
      );
      return { session, timing, missReason: 'expired' };
    }

    console.info(
      '[LIVE_AUTH_SESSION_SQL] hit=true sessionId=%s playerUid=%s active=%s expired=%s pool_acquire_ms=%s query_exec_ms=%s total_ms=%s',
      cleanSessionId,
      cleanPlayerUid,
      session.active,
      false,
      timing.pool_acquire_ms,
      timing.query_exec_ms,
      timing.total_ms
    );
    return { session, timing, missReason: null };
  } catch (error) {
    const timing = {
      pool_acquire_ms: 0,
      query_exec_ms: 0,
      total_ms: Date.now() - startedAt,
    };
    console.info(
      '[LIVE_AUTH_SESSION_SQL] hit=false sessionId=%s playerUid=%s active=%s expired=%s reason=%s error=%s',
      cleanSessionId,
      cleanPlayerUid,
      null,
      null,
      'lookup_failed',
      error instanceof Error ? error.message : String(error)
    );
    return { session: null, timing, missReason: 'lookup_failed' };
  }
}
