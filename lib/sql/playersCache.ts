import 'server-only';

import type { PoolClient } from 'pg';
import type { DocumentSnapshot } from 'firebase-admin/firestore';

import { adminDb } from '@/lib/firebase/admin';
import {
  AUTH_SLOW_MS,
  isAppDebugLoggingEnabled,
} from '@/lib/server/verboseLogs';
import {
  cleanText,
  getPlayerMirrorPool,
  normalizeJson,
  numberOrNull,
  runMirrorClientQuery,
  runMirrorPoolQuery,
  type PlayerMirrorSqlTiming,
  toIsoString,
} from '@/lib/sql/playerMirrorCommon';
import {
  deactivateGameUsernameForPlayerInTxn,
  upsertGameUsernameForPlayer,
} from '@/lib/sql/gameUsernameRegistrySql';
import { attachVendorAwarenessToPlayers } from '@/lib/sql/vendorOwnershipRead';
import type { VendorAwareness } from '@/features/vendors/vendorAwareness';

export async function mirrorPlayerCache(uid: string, data: Record<string, unknown>, source = 'appbeg') {
  const db = getPlayerMirrorPool();
  const cleanUid = cleanText(uid);
  if (!db || !cleanUid) return false;
  try {
    await db.query(
      `
        INSERT INTO public.players_cache (
          uid, username, email, role, status, created_by, coadmin_uid, created_by_staff_id,
          coin, cash, promo_locked_coins, referral_code, referred_by_uid, referred_by_code,
          referral_bonus_coins, referral_created_at, referral_reward_status,
          referral_qualified_at, referral_reward_claimed_at, password_updated_at,
          password_updated_by_uid, password_updated_by_role, transferred_by_uid,
          created_at, updated_at, restored_at, raw_firestore_data, source, mirrored_at, deleted_at
        )
        VALUES (
          $1, $2, NULLIF($3, ''), $4, NULLIF($5, ''), NULLIF($6, ''), NULLIF($7, ''),
          NULLIF($8, ''), $9, $10, $11, NULLIF($12, ''), NULLIF($13, ''), NULLIF($14, ''),
          $15, $16::timestamptz, NULLIF($17, ''), $18::timestamptz, $19::timestamptz,
          $20::timestamptz, NULLIF($21, ''), NULLIF($22, ''), NULLIF($23, ''),
          $24::timestamptz, $25::timestamptz, $26::timestamptz, $27::jsonb, $28, now(), NULL
        )
        ON CONFLICT (uid) DO UPDATE SET
          username = EXCLUDED.username,
          email = EXCLUDED.email,
          role = EXCLUDED.role,
          status = EXCLUDED.status,
          created_by = EXCLUDED.created_by,
          coadmin_uid = EXCLUDED.coadmin_uid,
          created_by_staff_id = EXCLUDED.created_by_staff_id,
          coin = EXCLUDED.coin,
          cash = EXCLUDED.cash,
          promo_locked_coins = EXCLUDED.promo_locked_coins,
          referral_code = EXCLUDED.referral_code,
          referred_by_uid = EXCLUDED.referred_by_uid,
          referred_by_code = EXCLUDED.referred_by_code,
          referral_bonus_coins = EXCLUDED.referral_bonus_coins,
          referral_created_at = EXCLUDED.referral_created_at,
          referral_reward_status = EXCLUDED.referral_reward_status,
          referral_qualified_at = EXCLUDED.referral_qualified_at,
          referral_reward_claimed_at = EXCLUDED.referral_reward_claimed_at,
          password_updated_at = EXCLUDED.password_updated_at,
          password_updated_by_uid = EXCLUDED.password_updated_by_uid,
          password_updated_by_role = EXCLUDED.password_updated_by_role,
          transferred_by_uid = EXCLUDED.transferred_by_uid,
          created_at = COALESCE(public.players_cache.created_at, EXCLUDED.created_at),
          updated_at = EXCLUDED.updated_at,
          restored_at = EXCLUDED.restored_at,
          raw_firestore_data = EXCLUDED.raw_firestore_data,
          source = EXCLUDED.source,
          mirrored_at = now(),
          deleted_at = NULL
      `,
      [
        cleanUid,
        cleanText(data.username),
        cleanText(data.email),
        cleanText(data.role) || 'player',
        cleanText(data.status),
        cleanText(data.createdBy),
        cleanText(data.coadminUid),
        cleanText(data.createdByStaffId),
        numberOrNull(data.coin),
        numberOrNull(data.cash),
        numberOrNull(data.promoLockedCoins),
        cleanText(data.referralCode),
        cleanText(data.referredByUid),
        cleanText(data.referredByCode),
        numberOrNull(data.referralBonusCoins),
        toIsoString(data.referralCreatedAt),
        cleanText(data.referralRewardStatus),
        toIsoString(data.referralQualifiedAt),
        toIsoString(data.referralRewardClaimedAt),
        toIsoString(data.passwordUpdatedAt),
        cleanText(data.passwordUpdatedByUid),
        cleanText(data.passwordUpdatedByRole),
        cleanText(data.transferredByUid),
        toIsoString(data.createdAt),
        toIsoString(data.updatedAt),
        toIsoString(data.restoredAt),
        JSON.stringify(normalizeJson(data) || {}),
        source,
      ]
    );
    if (cleanText(data.role).toLowerCase() === 'player') {
      const username = cleanText(data.username);
      const coadminUid = cleanText(data.coadminUid) || cleanText(data.createdBy);
      if (username && coadminUid) {
        await upsertGameUsernameForPlayer({
          username,
          playerUid: cleanUid,
          coadminUid,
          source,
        });
      }
    }
    console.info('[PLAYERS_CACHE] mirror upsert ok', { uid: cleanUid });
    return true;
  } catch (error) {
    console.error('[PLAYERS_CACHE] mirror failed', { uid: cleanUid, error });
    return false;
  }
}

export async function mirrorPlayerSnapshot(snap: DocumentSnapshot, source = 'appbeg') {
  if (!snap.exists) return false;
  return mirrorPlayerCache(snap.id, (snap.data() || {}) as Record<string, unknown>, source);
}

export async function mirrorPlayerById(uid: string, source = 'appbeg') {
  const cleanUid = cleanText(uid);
  if (!cleanUid) return false;
  try {
    return mirrorPlayerSnapshot(await adminDb.collection('users').doc(cleanUid).get(), source);
  } catch (error) {
    console.error('[PLAYERS_CACHE] mirror failed', { uid: cleanUid, error });
    return false;
  }
}

export async function tombstonePlayerCache(uid: string, source = 'appbeg') {
  const db = getPlayerMirrorPool();
  const cleanUid = cleanText(uid);
  if (!db || !cleanUid) return false;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query<Record<string, unknown>>(
      `
        SELECT username, role, coadmin_uid, created_by
        FROM public.players_cache
        WHERE uid = $1
        LIMIT 1
      `,
      [cleanUid]
    );
    const existingRow = existing.rows[0];
    await client.query(
      `
        INSERT INTO public.players_cache (uid, username, role, raw_firestore_data, source, mirrored_at, deleted_at)
        VALUES ($1, $1, 'player', '{}'::jsonb, $2, now(), now())
        ON CONFLICT (uid) DO UPDATE SET
          source = EXCLUDED.source,
          mirrored_at = now(),
          deleted_at = now()
      `,
      [cleanUid, source]
    );
    if (cleanText(existingRow?.role).toLowerCase() === 'player') {
      await deactivateGameUsernameForPlayerInTxn(client, {
        username: cleanText(existingRow?.username),
        playerUid: cleanUid,
        coadminUid: cleanText(existingRow?.coadmin_uid) || cleanText(existingRow?.created_by),
        reason: 'deleted',
        source,
      });
    }
    await client.query('COMMIT');
    console.info('[PLAYERS_CACHE] tombstone ok', { uid: cleanUid });
    return true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('[PLAYERS_CACHE] tombstone failed', { uid: cleanUid, error });
    return false;
  } finally {
    client.release();
  }
}

export type CarerSqlProfileLookup = {
  role: string;
  coadminUid: string | null;
};

export type CarerSqlProfileLookupResult = {
  profile: CarerSqlProfileLookup | null;
  /** @deprecated Use timing.total_ms */
  queryMs: number;
  timing: PlayerMirrorSqlTiming;
  missReason: 'row_missing' | 'role_mismatch' | 'postgres_unavailable' | 'lookup_failed' | null;
};

export type PlayerSqlProfileLookup = {
  role: string;
  coadminUid: string | null;
  activeSessionId: string | null;
};

export type PlayerSqlProfileLookupResult = {
  profile: PlayerSqlProfileLookup | null;
  timing: PlayerMirrorSqlTiming;
  missReason: 'row_missing' | 'role_mismatch' | 'postgres_unavailable' | 'lookup_failed' | null;
};

function activeSessionIdFromRawFirestore(raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  return cleanText((raw as Record<string, unknown>).activeSessionId) || null;
}

function resolveActiveSessionId(row: Record<string, unknown>) {
  return cleanText(row.active_session_id) || activeSessionIdFromRawFirestore(row.raw_firestore_data);
}

function fieldFromRawFirestore(raw: unknown, field: string) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  return cleanText((raw as Record<string, unknown>)[field]) || null;
}

export type ApiUserSqlProfileLookup = {
  uid: string;
  role: string;
  username: string;
  status: string | null;
  coadminUid: string | null;
  createdBy: string | null;
  automationAgentId: string | null;
  activeSessionId: string | null;
};

export type ApiUserSqlProfileLookupResult = {
  profile: ApiUserSqlProfileLookup | null;
  timing: PlayerMirrorSqlTiming;
  missReason: 'row_missing' | 'postgres_unavailable' | 'lookup_failed' | null;
};

export type CachedPlayer = {
  id: string;
  uid: string;
  username: string;
  email: string;
  role: 'player';
  status: 'active' | 'disabled';
  createdBy: string | null;
  coadminUid?: string | null;
  coin?: number;
  cash?: number;
  vendor?: VendorAwareness | null;
  createdAt?: string | null;
};

function mapCachedPlayerRow(
  row: Record<string, unknown>,
  requestedCoadminUid: string
): CachedPlayer | null {
  const uid = cleanText(row.uid);
  if (!uid) {
    return null;
  }

  const createdBy = cleanText(row.created_by) || null;
  const storedCoadminUid = cleanText(row.coadmin_uid) || null;
  const coadminUid =
    storedCoadminUid ||
    (createdBy === requestedCoadminUid ? requestedCoadminUid : null) ||
    undefined;
  const status = (cleanText(row.status) || 'active') as 'active' | 'disabled';

  return {
    id: uid,
    uid,
    username: cleanText(row.username),
    email: cleanText(row.email),
    role: 'player',
    status,
    createdBy,
    coadminUid,
    coin: numberOrNull(row.coin) ?? undefined,
    cash: numberOrNull(row.cash) ?? undefined,
    createdAt: toIsoString(row.created_at),
  };
}

const PLAYERS_BY_COADMIN_SQL = `
  SELECT DISTINCT ON (uid)
    uid,
    username,
    email,
    role,
    status,
    created_by,
    coadmin_uid,
    coin,
    cash,
    created_at,
    updated_at,
    mirrored_at
  FROM public.players_cache
  WHERE deleted_at IS NULL
    AND role = 'player'
    AND COALESCE(status, 'active') <> 'disabled'
    AND (coadmin_uid = $1 OR created_by = $1)
  ORDER BY uid, COALESCE(updated_at, created_at, mirrored_at) DESC
`;

function sortCachedPlayers(players: CachedPlayer[]) {
  return players.sort((left, right) => {
    const leftTime = left.createdAt ? new Date(left.createdAt).getTime() : 0;
    const rightTime = right.createdAt ? new Date(right.createdAt).getTime() : 0;
    return rightTime - leftTime;
  });
}

function mapCachedPlayerRows(
  rows: Record<string, unknown>[],
  requestedCoadminUid: string
): CachedPlayer[] {
  return sortCachedPlayers(
    rows
      .map((row) => mapCachedPlayerRow(row, requestedCoadminUid))
      .filter((player): player is CachedPlayer => Boolean(player))
  );
}

export async function readPlayersCacheByCoadminWithClient(
  client: PoolClient,
  coadminUid: string
): Promise<CachedPlayer[]> {
  const cleanCoadminUid = cleanText(coadminUid);
  const { rows } = await runMirrorClientQuery<Record<string, unknown>>(
    client,
    PLAYERS_BY_COADMIN_SQL,
    [cleanCoadminUid]
  );
  return attachVendorAwarenessToPlayers(mapCachedPlayerRows(rows, cleanCoadminUid));
}

const PLAYERS_BY_REFERRER_SQL = `
  SELECT DISTINCT ON (uid)
    uid,
    username
  FROM public.players_cache
  WHERE deleted_at IS NULL
    AND role = 'player'
    AND LOWER(COALESCE(status, '')) = 'active'
    AND referred_by_uid = $1
  ORDER BY uid, COALESCE(updated_at, created_at, mirrored_at) DESC
`;

export type ReferredPlayerCacheRow = {
  uid: string;
  username: string;
};

export async function readPlayersCacheByReferrerUidWithClient(
  client: PoolClient,
  referrerUid: string
): Promise<ReferredPlayerCacheRow[]> {
  const cleanReferrerUid = cleanText(referrerUid);
  const { rows } = await runMirrorClientQuery<Record<string, unknown>>(
    client,
    PLAYERS_BY_REFERRER_SQL,
    [cleanReferrerUid]
  );
  return rows.map((row) => ({
    uid: cleanText(row.uid),
    username: cleanText(row.username),
  }));
}

export async function readPlayersCacheByReferrerUid(
  referrerUid: string
): Promise<ReferredPlayerCacheRow[] | null> {
  const cleanReferrerUid = cleanText(referrerUid);
  const db = getPlayerMirrorPool();
  if (!db || !cleanReferrerUid) {
    return null;
  }

  try {
    const startedAt = Date.now();
    const { rows } = await runMirrorPoolQuery<Record<string, unknown>>(
      db,
      PLAYERS_BY_REFERRER_SQL,
      [cleanReferrerUid]
    );
    console.info('[PLAYERS_CACHE] referred_by read ok', {
      referrerUid: cleanReferrerUid,
      count: rows.length,
      durationMs: Date.now() - startedAt,
    });
    return rows.map((row) => ({
      uid: cleanText(row.uid),
      username: cleanText(row.username),
    }));
  } catch (error) {
    console.warn('[PLAYERS_CACHE] referred_by postgres read failed', {
      referrerUid: cleanReferrerUid,
      error,
    });
    return null;
  }
}

export async function readPlayersCacheByCoadmin(
  coadminUid: string
): Promise<CachedPlayer[] | null> {
  const cleanCoadminUid = cleanText(coadminUid);
  const db = getPlayerMirrorPool();
  if (!db || !cleanCoadminUid) {
    return null;
  }

  try {
    const { rows } = await runMirrorPoolQuery<Record<string, unknown>>(
      db,
      PLAYERS_BY_COADMIN_SQL,
      [cleanCoadminUid]
    );
    return attachVendorAwarenessToPlayers(mapCachedPlayerRows(rows, cleanCoadminUid));
  } catch (error) {
    console.warn('[PLAYERS_CACHE] postgres read failed', {
      coadminUid: cleanCoadminUid,
      error,
    });
    return null;
  }
}

export async function lookupApiUserProfileFromSqlCache(
  uid: string,
  mirrorClient?: PoolClient
): Promise<ApiUserSqlProfileLookupResult> {
  const startedAt = Date.now();
  const cleanUid = cleanText(uid);
  const db = getPlayerMirrorPool();
  if (!db || !cleanUid) {
    const timing = {
      pool_acquire_ms: 0,
      query_exec_ms: 0,
      total_ms: Date.now() - startedAt,
    };
    console.warn(
      '[API_AUTH_SQL_PROFILE] hit=false uid=%s source=players_cache reason=postgres_unavailable',
      cleanUid || null
    );
    return { profile: null, timing, missReason: 'postgres_unavailable' };
  }

  const profileSql = `
    SELECT uid, username, role, status, coadmin_uid, created_by, active_session_id, raw_firestore_data
    FROM public.players_cache
    WHERE uid = $1
      AND deleted_at IS NULL
    LIMIT 1
  `;

  try {
    const { rows, timing } = mirrorClient
      ? await runMirrorClientQuery<Record<string, unknown>>(mirrorClient, profileSql, [cleanUid])
      : await runMirrorPoolQuery<Record<string, unknown>>(db, profileSql, [cleanUid]);

    if (!rows.length) {
      if (isAppDebugLoggingEnabled() || timing.total_ms >= AUTH_SLOW_MS) {
        console.info(
          '[API_AUTH_SQL_PROFILE] hit=false uid=%s source=players_cache reason=row_missing total_ms=%s',
          cleanUid,
          timing.total_ms
        );
      }
      return { profile: null, timing, missReason: 'row_missing' };
    }

    const row = rows[0];
    const raw = row.raw_firestore_data;
    const profile = {
      uid: cleanText(row.uid) || cleanUid,
      role: cleanText(row.role).toLowerCase(),
      username: cleanText(row.username),
      status: cleanText(row.status) || null,
      coadminUid: cleanText(row.coadmin_uid) || cleanText(row.created_by) || null,
      createdBy: cleanText(row.created_by) || null,
      automationAgentId: fieldFromRawFirestore(raw, 'automationAgentId'),
      activeSessionId: resolveActiveSessionId(row),
    } satisfies ApiUserSqlProfileLookup;

    if (isAppDebugLoggingEnabled() || timing.total_ms >= AUTH_SLOW_MS) {
      console.info(
        '[API_AUTH_SQL_PROFILE] hit=true uid=%s role=%s source=players_cache total_ms=%s shared_client=%s',
        profile.uid,
        profile.role,
        timing.total_ms,
        Boolean(mirrorClient)
      );
    }
    return { profile, timing, missReason: null };
  } catch (error) {
    const timing = {
      pool_acquire_ms: 0,
      query_exec_ms: 0,
      total_ms: Date.now() - startedAt,
    };
    console.warn(
      '[API_AUTH_SQL_PROFILE] hit=false uid=%s source=players_cache reason=lookup_failed error=%s',
      cleanUid,
      error instanceof Error ? error.message : String(error)
    );
    return { profile: null, timing, missReason: 'lookup_failed' };
  }
}

export async function lookupApiUserProfileByUsernameFromSqlCache(
  username: string
): Promise<ApiUserSqlProfileLookupResult> {
  const startedAt = Date.now();
  const cleanUsername = cleanText(username);
  const db = getPlayerMirrorPool();
  if (!db || !cleanUsername) {
    const timing = {
      pool_acquire_ms: 0,
      query_exec_ms: 0,
      total_ms: Date.now() - startedAt,
    };
    return { profile: null, timing, missReason: 'postgres_unavailable' };
  }

  const profileSql = `
    SELECT uid, username, role, status, coadmin_uid, created_by, active_session_id, raw_firestore_data
    FROM public.players_cache
    WHERE deleted_at IS NULL
      AND LOWER(username) = LOWER($1)
    LIMIT 1
  `;

  try {
    const { rows, timing } = await runMirrorPoolQuery<Record<string, unknown>>(db, profileSql, [
      cleanUsername,
    ]);

    if (!rows.length) {
      return { profile: null, timing, missReason: 'row_missing' };
    }

    const row = rows[0];
    const raw = row.raw_firestore_data;
    const profile = {
      uid: cleanText(row.uid),
      role: cleanText(row.role).toLowerCase(),
      username: cleanText(row.username),
      status: cleanText(row.status) || null,
      coadminUid: cleanText(row.coadmin_uid) || cleanText(row.created_by) || null,
      createdBy: cleanText(row.created_by) || null,
      automationAgentId: fieldFromRawFirestore(raw, 'automationAgentId'),
      activeSessionId: resolveActiveSessionId(row),
    } satisfies ApiUserSqlProfileLookup;

    return { profile, timing, missReason: null };
  } catch {
    const timing = {
      pool_acquire_ms: 0,
      query_exec_ms: 0,
      total_ms: Date.now() - startedAt,
    };
    return { profile: null, timing, missReason: 'lookup_failed' };
  }
}

export async function lookupPlayerProfileFromSqlCache(
  playerUid: string,
  mirrorClient?: PoolClient
): Promise<PlayerSqlProfileLookupResult> {
  const startedAt = Date.now();
  const cleanUid = cleanText(playerUid);
  const db = getPlayerMirrorPool();
  if (!db || !cleanUid) {
    const timing = {
      pool_acquire_ms: 0,
      query_exec_ms: 0,
      total_ms: Date.now() - startedAt,
    };
    console.info(
      '[LIVE_AUTH_PLAYER_SQL] hit=false uid=%s reason=%s pool_acquire_ms=%s query_exec_ms=%s total_ms=%s',
      cleanUid || null,
      'postgres_unavailable',
      timing.pool_acquire_ms,
      timing.query_exec_ms,
      timing.total_ms
    );
    return { profile: null, timing, missReason: 'postgres_unavailable' };
  }

  const profileSql = `
    SELECT role, coadmin_uid, created_by, active_session_id, raw_firestore_data
    FROM public.players_cache
    WHERE uid = $1
      AND deleted_at IS NULL
    LIMIT 1
  `;

  try {
    const { rows, timing } = mirrorClient
      ? await runMirrorClientQuery<Record<string, unknown>>(mirrorClient, profileSql, [cleanUid])
      : await runMirrorPoolQuery<Record<string, unknown>>(db, profileSql, [cleanUid]);

    if (!rows.length) {
      console.info(
        '[LIVE_AUTH_PLAYER_SQL] hit=false uid=%s reason=%s pool_acquire_ms=%s query_exec_ms=%s total_ms=%s',
        cleanUid,
        'row_missing',
        timing.pool_acquire_ms,
        timing.query_exec_ms,
        timing.total_ms
      );
      return { profile: null, timing, missReason: 'row_missing' };
    }

    const row = rows[0];
    const profile = {
      role: cleanText(row.role).toLowerCase(),
      coadminUid:
        cleanText(row.coadmin_uid) || cleanText(row.created_by) || null,
      activeSessionId: resolveActiveSessionId(row),
    } satisfies PlayerSqlProfileLookup;

    if (profile.role !== 'player') {
      console.info(
        '[LIVE_AUTH_PLAYER_SQL] hit=false uid=%s role=%s coadminUid=%s reason=%s pool_acquire_ms=%s query_exec_ms=%s total_ms=%s',
        cleanUid,
        profile.role || null,
        profile.coadminUid,
        'role_mismatch',
        timing.pool_acquire_ms,
        timing.query_exec_ms,
        timing.total_ms
      );
      return { profile, timing, missReason: 'role_mismatch' };
    }

    console.info(
      '[LIVE_AUTH_PLAYER_SQL] hit=true uid=%s role=%s coadminUid=%s activeSessionId=%s pool_acquire_ms=%s query_exec_ms=%s total_ms=%s shared_client=%s',
      cleanUid,
      profile.role,
      profile.coadminUid,
      profile.activeSessionId,
      timing.pool_acquire_ms,
      timing.query_exec_ms,
      timing.total_ms,
      Boolean(mirrorClient)
    );
    return { profile, timing, missReason: null };
  } catch (error) {
    const timing = {
      pool_acquire_ms: 0,
      query_exec_ms: 0,
      total_ms: Date.now() - startedAt,
    };
    console.info(
      '[LIVE_AUTH_PLAYER_SQL] hit=false uid=%s reason=%s total_ms=%s error=%s',
      cleanUid,
      'lookup_failed',
      timing.total_ms,
      error instanceof Error ? error.message : String(error)
    );
    return { profile: null, timing, missReason: 'lookup_failed' };
  }
}

export async function lookupCarerProfileFromSqlCache(
  carerUid: string,
  mirrorClient?: PoolClient
): Promise<CarerSqlProfileLookupResult> {
  const startedAt = Date.now();
  const cleanUid = cleanText(carerUid);
  const db = getPlayerMirrorPool();
  if (!db || !cleanUid) {
    const timing = {
      pool_acquire_ms: 0,
      query_exec_ms: 0,
      total_ms: Date.now() - startedAt,
    };
    console.info(
      '[LIVE_AUTH_SQL_PROFILE] miss reason=%s uid=%s durationMs=%s pool_acquire_ms=%s query_exec_ms=%s',
      'postgres_unavailable',
      cleanUid || null,
      timing.total_ms,
      timing.pool_acquire_ms,
      timing.query_exec_ms
    );
    return {
      profile: null,
      queryMs: 0,
      timing,
      missReason: 'postgres_unavailable',
    };
  }

  const profileSql = `
    SELECT role, coadmin_uid, created_by
    FROM public.players_cache
    WHERE uid = $1
      AND deleted_at IS NULL
    LIMIT 1
  `;

  try {
    const { rows, timing } = mirrorClient
      ? await runMirrorClientQuery<Record<string, unknown>>(mirrorClient, profileSql, [cleanUid])
      : await runMirrorPoolQuery<Record<string, unknown>>(db, profileSql, [cleanUid]);

    if (!rows.length) {
      console.info(
        '[LIVE_AUTH_SQL_PROFILE] miss reason=%s uid=%s pool_acquire_ms=%s query_exec_ms=%s total_ms=%s',
        'row_missing',
        cleanUid,
        timing.pool_acquire_ms,
        timing.query_exec_ms,
        timing.total_ms
      );
      return { profile: null, queryMs: timing.total_ms, timing, missReason: 'row_missing' };
    }

    const row = rows[0];
    const profile = {
      role: cleanText(row.role).toLowerCase(),
      coadminUid:
        cleanText(row.coadmin_uid) || cleanText(row.created_by) || null,
    } satisfies CarerSqlProfileLookup;

    if (profile.role !== 'carer') {
      console.info(
        '[LIVE_AUTH_SQL_PROFILE] miss reason=%s uid=%s role=%s coadminUid=%s pool_acquire_ms=%s query_exec_ms=%s total_ms=%s',
        'role_mismatch',
        cleanUid,
        profile.role || null,
        profile.coadminUid,
        timing.pool_acquire_ms,
        timing.query_exec_ms,
        timing.total_ms
      );
      return { profile, queryMs: timing.total_ms, timing, missReason: 'role_mismatch' };
    }

    console.info(
      '[LIVE_AUTH_SQL_PROFILE] hit=true uid=%s role=%s coadminUid=%s pool_acquire_ms=%s query_exec_ms=%s total_ms=%s shared_client=%s',
      cleanUid,
      profile.role,
      profile.coadminUid,
      timing.pool_acquire_ms,
      timing.query_exec_ms,
      timing.total_ms,
      Boolean(mirrorClient)
    );
    return { profile, queryMs: timing.total_ms, timing, missReason: null };
  } catch (error) {
    const timing = {
      pool_acquire_ms: 0,
      query_exec_ms: 0,
      total_ms: Date.now() - startedAt,
    };
    console.info(
      '[LIVE_AUTH_SQL_PROFILE] miss reason=%s uid=%s total_ms=%s error=%s',
      'lookup_failed',
      cleanUid,
      timing.total_ms,
      error instanceof Error ? error.message : String(error)
    );
    return {
      profile: null,
      queryMs: timing.total_ms,
      timing,
      missReason: 'lookup_failed',
    };
  }
}
