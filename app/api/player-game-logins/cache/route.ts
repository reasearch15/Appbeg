import type { QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import {
  apiError,
  requireApiUser,
  scopedCoadminUid,
  type ApiUser,
} from '@/lib/firebase/apiAuth';
import {
  isCacheSqlAuthoritative,
  logCacheFirestoreFallbackBlocked,
  logCacheSqlRead,
} from '@/lib/server/cacheSqlRead';
import {

  readPlayerGameLoginCacheByFirebaseId,
  readPlayerGameLoginsCacheByCoadmin,
  readPlayerGameLoginsCacheFullByPlayer,
  upsertPlayerGameLoginCache,
  type CachedPlayerGameLogin,
} from '@/lib/sql/playerGameLoginsCache';
import { lookupApiUserProfileFromSqlCache } from '@/lib/sql/playersCache';

export const runtime = 'nodejs';

const ROUTE = '/api/player-game-logins/cache';

function cleanText(value: unknown) {
  return String(value || '').trim();
}

function toIsoString(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const maybe = value as { toDate?: () => Date; toMillis?: () => number; seconds?: number };
  if (typeof maybe.toDate === 'function') return maybe.toDate().toISOString();
  if (typeof maybe.toMillis === 'function') return new Date(maybe.toMillis()).toISOString();
  if (typeof maybe.seconds === 'number') return new Date(maybe.seconds * 1000).toISOString();
  return null;
}

function mapFirestorePlayerGameLogin(
  docSnap: QueryDocumentSnapshot,
  requestedCoadminUid: string
): CachedPlayerGameLogin | null {
  const data = docSnap.data() as Record<string, unknown>;
  const createdBy = cleanText(data.createdBy) || requestedCoadminUid;
  const coadminUid = cleanText(data.coadminUid) || createdBy;
  const playerUid = cleanText(data.playerUid);
  const gameName = cleanText(data.gameName);

  if (!playerUid || !gameName || !coadminUid || !createdBy) {
    return null;
  }

  return {
    id: docSnap.id,
    playerUid,
    playerUsername: cleanText(data.playerUsername),
    gameName,
    gameUsername: cleanText(data.gameUsername),
    gamePassword: String(data.gamePassword || ''),
    frontendUrl: cleanText(data.frontendUrl) || undefined,
    siteUrl: cleanText(data.siteUrl) || undefined,
    coadminUid,
    createdBy,
    createdAt: toIsoString(data.createdAt),
  };
}

async function getFirestorePlayerGameLoginsByField(
  field: 'coadminUid' | 'createdBy',
  value: string,
  requestedCoadminUid: string
): Promise<CachedPlayerGameLogin[]> {
  const snapshot = await adminDb.collection('playerGameLogins').where(field, '==', value).get();
  return snapshot.docs
    .map((docSnap) => mapFirestorePlayerGameLogin(docSnap, requestedCoadminUid))
    .filter((login): login is CachedPlayerGameLogin => Boolean(login));
}

async function getFirestorePlayerGameLoginsByCoadmin(
  coadminUid: string
): Promise<CachedPlayerGameLogin[]> {
  const [coadminOwned, legacyOwned] = await Promise.all([
    getFirestorePlayerGameLoginsByField('coadminUid', coadminUid, coadminUid),
    getFirestorePlayerGameLoginsByField('createdBy', coadminUid, coadminUid),
  ]);

  return Array.from(
    new Map(
      [...coadminOwned, ...legacyOwned].map((login) => [login.id, login])
    ).values()
  );
}

function resolveExplicitCoadminUid(request: Request) {
  const url = new URL(request.url);
  return cleanText(url.searchParams.get('coadminUid'));
}

function resolvePlayerUid(request: Request) {
  const url = new URL(request.url);
  return cleanText(url.searchParams.get('playerUid'));
}

function canAccessCoadmin(authUser: ApiUser, requested: string, scoped: string | null) {
  if (authUser.role === 'admin') return true;
  if (authUser.role === 'coadmin') return requested === authUser.uid;
  return Boolean(scoped && requested === scoped);
}

async function staffCanViewPlayers(authUser: ApiUser) {
  if (authUser.role !== 'staff') {
    return true;
  }
  const fresh = await lookupApiUserProfileFromSqlCache(authUser.uid);
  return fresh.profile?.role === 'staff' && fresh.profile.canViewPlayers === true;
}

export async function GET(request: Request) {
  const startedAt = Date.now();

  const auth = await requireApiUser(request, ['admin', 'coadmin', 'staff', 'carer', 'player']);
  if ('response' in auth) {
    return auth.response;
  }

  const playerUid = resolvePlayerUid(request);
  if (playerUid) {
    if (!(await staffCanViewPlayers(auth.user))) {
      return apiError('Forbidden.', 403);
    }
    if (auth.user.role === 'player' && auth.user.uid !== playerUid) {
      return apiError('Forbidden.', 403);
    }
    if (auth.user.role !== 'admin' && auth.user.role !== 'player') {
      const scoped = scopedCoadminUid(auth.user);
      const playerProfile = await lookupApiUserProfileFromSqlCache(playerUid);
      if (
        !scoped ||
        playerProfile.profile?.role !== 'player' ||
        playerProfile.profile.coadminUid !== scoped
      ) {
        return apiError('Forbidden.', 403);
      }
    }
    try {
      const cached = await readPlayerGameLoginsCacheFullByPlayer(playerUid);
      if (cached !== null) {
        const durationMs = Date.now() - startedAt;
        logCacheSqlRead(ROUTE, { playerUid, count: cached.length, durationMs });
        return NextResponse.json({ playerGameLogins: cached, source: 'postgres' });
      }
    } catch (error) {
      console.warn('[PLAYER_GAME_LOGINS_CACHE] postgres read by player failed', { playerUid, error });
    }
    if (isCacheSqlAuthoritative()) {
      logCacheFirestoreFallbackBlocked(ROUTE, 'playerGameLogins', { playerUid });
      return NextResponse.json({ playerGameLogins: [], source: 'postgres' });
    }
    const snap = await adminDb
      .collection('playerGameLogins')
      .where('playerUid', '==', playerUid)
      .get();
    const playerGameLogins = snap.docs
      .map((docSnap) => mapFirestorePlayerGameLogin(docSnap, ''))
      .filter((login): login is CachedPlayerGameLogin => Boolean(login));
    return NextResponse.json({ playerGameLogins, source: 'firestore' });
  }

  const scoped = scopedCoadminUid(auth.user);
  const coadminUid = resolveExplicitCoadminUid(request) || scoped;
  if (!coadminUid) {
    return NextResponse.json({
      playerGameLogins: [],
      source: isCacheSqlAuthoritative() ? 'postgres' : 'firestore',
    });
  }

  if (!canAccessCoadmin(auth.user, coadminUid, scoped)) {
    return apiError('Forbidden.', 403);
  }

  if (!(await staffCanViewPlayers(auth.user))) {
    return apiError('Forbidden.', 403);
  }

  try {
    const cached = await readPlayerGameLoginsCacheByCoadmin(coadminUid);
    if (cached !== null) {
      const durationMs = Date.now() - startedAt;
      logCacheSqlRead(ROUTE, { coadminUid, count: cached.length, durationMs });
      return NextResponse.json({ playerGameLogins: cached, source: 'postgres' });
    }
  } catch (error) {
    console.warn('[PLAYER_GAME_LOGINS_CACHE] postgres read failed', { coadminUid, error });
  }

  if (isCacheSqlAuthoritative()) {
    logCacheFirestoreFallbackBlocked(ROUTE, 'playerGameLogins', { coadminUid });
    return NextResponse.json({ playerGameLogins: [], source: 'postgres' });
  }

  const playerGameLogins = await getFirestorePlayerGameLoginsByCoadmin(coadminUid);
  const durationMs = Date.now() - startedAt;
  console.info(
    `[PLAYER_GAME_LOGINS_CACHE_READ] source=firestore_fallback coadminUid=${coadminUid} count=${playerGameLogins.length} durationMs=${durationMs}`
  );
  return NextResponse.json({ playerGameLogins, source: 'firestore' });
}

export async function POST(request: Request) {
  const auth = await requireApiUser(request, ['admin', 'coadmin', 'staff', 'carer']);
  if ('response' in auth) {
    return auth.response;
  }

  const body = (await request.json().catch(() => ({}))) as {
    action?: unknown;
    playerGameLogin?: CachedPlayerGameLogin;
    id?: unknown;
  };
  const action = cleanText(body.action);
  const scoped = scopedCoadminUid(auth.user);

  if (action === 'upsert') {
    let login = body.playerGameLogin;
    if (!login?.id) {
      return apiError('Player game login id is required.', 400);
    }
    if (!cleanText(login.playerUid) || !cleanText(login.coadminUid)) {
      const existing = await readPlayerGameLoginCacheByFirebaseId(login.id);
      if (existing) {
        login = {
          ...existing,
          ...login,
          id: login.id,
          playerUid: cleanText(login.playerUid) || existing.playerUid,
          playerUsername: cleanText(login.playerUsername) || existing.playerUsername,
          gameName: cleanText(login.gameName) || existing.gameName,
          gameUsername: cleanText(login.gameUsername) || existing.gameUsername,
          gamePassword: String(login.gamePassword || existing.gamePassword || ''),
          frontendUrl: cleanText(login.frontendUrl) || existing.frontendUrl,
          siteUrl: cleanText(login.siteUrl) || existing.siteUrl,
          coadminUid: cleanText(login.coadminUid) || existing.coadminUid,
          createdBy: cleanText(login.createdBy) || existing.createdBy,
          createdAt: login.createdAt || existing.createdAt,
        };
      }
    }
    const loginScope = cleanText(login.coadminUid || login.createdBy);
    if (
      auth.user.role !== 'admin' &&
      scoped &&
      loginScope !== scoped &&
      !canAccessCoadmin(auth.user, loginScope, scoped)
    ) {
      return apiError('Forbidden.', 403);
    }

    const mirrored = await upsertPlayerGameLoginCache({
      firebaseId: login.id,
      playerUid: login.playerUid,
      playerUsername: login.playerUsername,
      gameName: login.gameName,
      gameUsername: login.gameUsername,
      gamePassword: login.gamePassword,
      frontendUrl: login.frontendUrl,
      siteUrl: login.siteUrl,
      coadminUid: login.coadminUid,
      createdBy: login.createdBy,
      createdAt: login.createdAt,
      source: 'authority_api',
      rawFirestoreData: login as unknown as Record<string, unknown>,
    });
    return NextResponse.json({ success: true, mirrored });
  }

  return apiError('Invalid player game login cache action.', 400);
}
