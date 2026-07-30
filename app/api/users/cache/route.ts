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

  readUsersCacheByRole,
  type CachedDirectoryUser,
  type DirectoryRole,
} from '@/lib/sql/usersCache';
import { lookupApiUserProfileFromSqlCache } from '@/lib/sql/playersCache';

export const runtime = 'nodejs';

const ROUTE = '/api/users/cache';

const DIRECTORY_ROLES = new Set<DirectoryRole>(['admin', 'staff', 'carer', 'coadmin', 'player']);

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

function numberOrNull(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function mapFirestoreDirectoryUser(
  docSnap: QueryDocumentSnapshot,
  role: DirectoryRole,
  requestedCoadminUid: string | null
): CachedDirectoryUser | null {
  const data = docSnap.data() as Record<string, unknown>;
  const docRole = cleanText(data.role) as DirectoryRole;
  if (docRole !== role) {
    return null;
  }

  const createdBy = cleanText(data.createdBy) || null;
  const storedCoadminUid = cleanText(data.coadminUid) || null;
  const coadminUid =
    storedCoadminUid ||
    (requestedCoadminUid && createdBy === requestedCoadminUid ? requestedCoadminUid : null) ||
    undefined;

  if (requestedCoadminUid) {
    const belongs =
      storedCoadminUid === requestedCoadminUid || createdBy === requestedCoadminUid;
    if (!belongs) {
      return null;
    }
  }

  const status = (cleanText(data.status) || 'active') as 'active' | 'disabled';

  return {
    id: docSnap.id,
    uid: docSnap.id,
    username: cleanText(data.username),
    email: cleanText(data.email),
    role,
    status,
    createdBy,
    coadminUid,
    cashBoxNpr: numberOrNull(data.cashBoxNpr),
    canViewPlayers: role === 'staff' ? Boolean(data.canViewPlayers) : false,
    paymentQrUrl: cleanText(data.paymentQrUrl) || null,
    paymentQrPublicId: cleanText(data.paymentQrPublicId) || null,
    paymentDetails: cleanText(data.paymentDetails) || null,
    paymentDetailPhotoUrls: Array.isArray(data.paymentDetailPhotoUrls)
      ? data.paymentDetailPhotoUrls.map((entry) => String(entry))
      : null,
    paymentDetailPhotos: Array.isArray(data.paymentDetailPhotos)
      ? data.paymentDetailPhotos
          .map((entry) => {
            if (!entry || typeof entry !== 'object') return null;
            const photo = entry as Record<string, unknown>;
            const imageUrl = cleanText(photo.imageUrl);
            const imagePublicId = cleanText(photo.imagePublicId);
            if (!imageUrl || !imagePublicId) return null;
            return { imageUrl, imagePublicId };
          })
          .filter((entry): entry is { imageUrl: string; imagePublicId: string } => Boolean(entry))
      : null,
    coin: numberOrNull(data.coin),
    cash: numberOrNull(data.cash),
    totalRechargeAmount: numberOrNull(data.totalRechargeAmount),
    totalRedeemAmount: numberOrNull(data.totalRedeemAmount),
    totalRechargeCount: numberOrNull(data.totalRechargeCount),
    totalRedeemCount: numberOrNull(data.totalRedeemCount),
    createdAt: toIsoString(data.createdAt),
  };
}

async function getFirestoreUsersByRole(
  role: DirectoryRole,
  coadminUid: string | null,
  status: 'active' | 'disabled' | null,
  includeDisabled: boolean
): Promise<CachedDirectoryUser[]> {
  const snapshot = await adminDb.collection('users').where('role', '==', role).get();

  return snapshot.docs
    .map((docSnap) => mapFirestoreDirectoryUser(docSnap, role, coadminUid))
    .filter((user): user is CachedDirectoryUser => {
      if (!user) return false;
      if (status && user.status !== status) return false;
      if (!status && !includeDisabled && user.status === 'disabled') return false;
      return true;
    })
    .sort((left, right) => {
      const leftTime = left.createdAt ? new Date(left.createdAt).getTime() : 0;
      const rightTime = right.createdAt ? new Date(right.createdAt).getTime() : 0;
      return rightTime - leftTime;
    });
}

function resolveRole(request: Request): DirectoryRole | null {
  const url = new URL(request.url);
  const role = cleanText(url.searchParams.get('role')) as DirectoryRole;
  return DIRECTORY_ROLES.has(role) ? role : null;
}

function resolveStatus(request: Request): 'active' | 'disabled' | null {
  const url = new URL(request.url);
  const status = cleanText(url.searchParams.get('status')) as 'active' | 'disabled';
  return status === 'active' || status === 'disabled' ? status : null;
}

function resolveIncludeDisabled(
  request: Request,
  status: 'active' | 'disabled' | null
): boolean {
  const url = new URL(request.url);
  const raw = cleanText(url.searchParams.get('includeDisabled')).toLowerCase();
  if (raw === 'false' || raw === '0') {
    return false;
  }
  if (raw === 'true' || raw === '1') {
    return true;
  }
  return status !== 'active';
}

function resolveExplicitCoadminUid(request: Request) {
  const url = new URL(request.url);
  return cleanText(url.searchParams.get('coadminUid')) || null;
}

function canAccessCoadminScope(authUser: ApiUser, requested: string | null, scoped: string | null) {
  if (!requested) return true;
  if (authUser.role === 'admin') return true;
  if (authUser.role === 'coadmin') return requested === authUser.uid;
  return Boolean(scoped && requested === scoped);
}

function resolveCoadminScope(authUser: ApiUser, explicitCoadminUid: string | null) {
  if (authUser.role === 'coadmin') {
    return authUser.uid;
  }
  return explicitCoadminUid || null;
}

function canReadRole(authUser: ApiUser, role: DirectoryRole) {
  if (authUser.role === 'admin') return true;
  if (role === 'admin') {
    return authUser.role === 'coadmin' || authUser.role === 'staff';
  }
  if (role === 'coadmin') {
    return authUser.role === 'staff';
  }
  return true;
}

async function staffCanReadPlayerDirectory(authUser: ApiUser, role: DirectoryRole) {
  if (authUser.role !== 'staff' || role !== 'player') {
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

  const role = resolveRole(request);
  if (!role) {
    return apiError('role query parameter is required (admin|staff|carer|coadmin|player).', 400);
  }

  if (!canReadRole(auth.user, role)) {
    return apiError('Forbidden.', 403);
  }

  if (!(await staffCanReadPlayerDirectory(auth.user, role))) {
    return apiError('Forbidden.', 403);
  }

  const status = resolveStatus(request);
  const includeDisabled = resolveIncludeDisabled(request, status);
  const statusFilter = status || 'all';
  const explicitCoadminUid = resolveExplicitCoadminUid(request);
  const scoped = scopedCoadminUid(auth.user);
  const coadminUid = resolveCoadminScope(auth.user, explicitCoadminUid);

  if (!canAccessCoadminScope(auth.user, coadminUid, scoped)) {
    return apiError('Forbidden.', 403);
  }

  try {
    const cached = await readUsersCacheByRole({ role, coadminUid, status, includeDisabled });
    if (cached !== null) {
      const durationMs = Date.now() - startedAt;
      logCacheSqlRead(ROUTE, {
        role,
        statusFilter,
        includeDisabled,
        coadminUid: coadminUid || null,
        count: cached.length,
        auth_path: auth.authPath,
        durationMs,
      });
      return NextResponse.json({ users: cached, source: 'postgres' });
    }
  } catch (error) {
    console.warn('[USERS_CACHE] postgres read failed', {
      role,
      coadminUid,
      statusFilter,
      includeDisabled,
      error,
    });
  }

  if (isCacheSqlAuthoritative()) {
    logCacheFirestoreFallbackBlocked(ROUTE, 'users', {
      role,
      coadminUid: coadminUid || null,
      statusFilter,
    });
    return NextResponse.json({ users: [], source: 'postgres' });
  }

  const users = await getFirestoreUsersByRole(role, coadminUid, status, includeDisabled);
  const durationMs = Date.now() - startedAt;
  console.info(
    `[USERS_CACHE_READ] source=firestore_fallback role=${role} statusFilter=${statusFilter} includeDisabled=${includeDisabled} coadminUid=${coadminUid || ''} count=${users.length} auth_path=${auth.authPath} durationMs=${durationMs}`
  );
  return NextResponse.json({ users, source: 'firestore' });
}
