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
import { readPlayersCacheByCoadmin, type CachedPlayer } from '@/lib/sql/playersCache';
import { lookupApiUserProfileFromSqlCache } from '@/lib/sql/playersCache';

export const runtime = 'nodejs';

const ROUTE = '/api/players/cache';

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

function mapFirestorePlayer(
  docSnap: QueryDocumentSnapshot,
  requestedCoadminUid: string
): CachedPlayer | null {
  const data = docSnap.data() as Record<string, unknown>;
  const role = cleanText(data.role);
  const status = (cleanText(data.status) || 'active') as 'active' | 'disabled';
  if (role !== 'player' || status === 'disabled') {
    return null;
  }

  const createdBy = cleanText(data.createdBy) || null;
  const storedCoadminUid = cleanText(data.coadminUid) || null;
  const coadminUid =
    storedCoadminUid ||
    (createdBy === requestedCoadminUid ? requestedCoadminUid : null) ||
    undefined;

  return {
    id: docSnap.id,
    uid: docSnap.id,
    username: cleanText(data.username),
    email: cleanText(data.email),
    role: 'player',
    status,
    createdBy,
    coadminUid,
    coin: typeof data.coin === 'number' ? data.coin : undefined,
    cash: typeof data.cash === 'number' ? data.cash : undefined,
    createdAt: toIsoString(data.createdAt),
  };
}

async function getFirestorePlayersByCoadmin(coadminUid: string): Promise<CachedPlayer[]> {
  const [scopedSnapshot, legacySnapshot] = await Promise.all([
    adminDb
      .collection('users')
      .where('role', '==', 'player')
      .where('coadminUid', '==', coadminUid)
      .get(),
    adminDb
      .collection('users')
      .where('role', '==', 'player')
      .where('createdBy', '==', coadminUid)
      .get(),
  ]);

  return Array.from(
    new Map(
      [...scopedSnapshot.docs, ...legacySnapshot.docs]
        .map((docSnap) => mapFirestorePlayer(docSnap, coadminUid))
        .filter((player): player is CachedPlayer => Boolean(player))
        .map((player) => [player.id, player])
    ).values()
  );
}

function resolveExplicitCoadminUid(request: Request) {
  const url = new URL(request.url);
  return cleanText(url.searchParams.get('coadminUid'));
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

  const auth = await requireApiUser(request, ['admin', 'coadmin', 'staff', 'carer']);
  if ('response' in auth) {
    return auth.response;
  }

  const scoped = scopedCoadminUid(auth.user);
  const coadminUid = resolveExplicitCoadminUid(request) || scoped;
  if (!coadminUid) {
    return NextResponse.json({
      players: [],
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
    const cached = await readPlayersCacheByCoadmin(coadminUid);
    if (cached !== null) {
      const durationMs = Date.now() - startedAt;
      logCacheSqlRead(ROUTE, { coadminUid, count: cached.length, durationMs });
      return NextResponse.json({ players: cached, source: 'postgres' });
    }
  } catch (error) {
    console.warn('[PLAYERS_CACHE] postgres read failed', { coadminUid, error });
  }

  if (isCacheSqlAuthoritative()) {
    logCacheFirestoreFallbackBlocked(ROUTE, 'users', { coadminUid });
    return NextResponse.json({ players: [], source: 'postgres' });
  }

  const players = await getFirestorePlayersByCoadmin(coadminUid);
  const durationMs = Date.now() - startedAt;
  console.info(
    `[PLAYERS_CACHE_READ] source=firestore_fallback coadminUid=${coadminUid} count=${players.length} durationMs=${durationMs}`
  );
  return NextResponse.json({ players, source: 'firestore' });
}
