import { collection, doc, getDoc, getDocs, query, where } from 'firebase/firestore';

import { assertClientFirestoreDisabled } from '@/lib/client/clientFirestoreGuard';
import { getCachedSessionUser, getSessionUserOnce } from '@/features/auth/sessionUser';
import { auth, db } from '@/lib/firebase/client';
import {
  getApiAuthHeaders,
  type ApiAuthHeaderAction,
} from '@/lib/firebase/apiClient';
import {
  CoadminScopedRecord,
  getCurrentUserCoadminUid,
  resolveCoadminUid,
} from '@/lib/coadmin/scope';
import { assertValidGameUsername } from '@/lib/games/gameUsernameRule';
import type { VendorAwareness } from '@/features/vendors/vendorAwareness';

export type CoadminUser = {
  id: string;
  uid: string;
  username: string;
  email: string;
  role: 'coadmin';
  status: 'active' | 'disabled';
  createdBy: string | null;
  coadminUid?: string | null;
  /** Reference images for player “Load coin” flow. */
  paymentDetailPhotoUrls?: string[] | null;
  paymentDetailPhotos?: Array<{
    imageUrl: string;
    imagePublicId: string;
  }> | null;
  createdAt?: any;
};

export type StaffUser = {
  id: string;
  uid: string;
  username: string;
  email: string;
  role: 'staff';
  status: 'active' | 'disabled';
  createdBy: string | null;
  coadminUid?: string | null;
  cashBoxNpr?: number;
  canViewPlayers?: boolean;
  createdAt?: any;
};

export type CarerUser = {
  id: string;
  uid: string;
  username: string;
  email: string;
  role: 'carer';
  status: 'active' | 'disabled';
  createdBy: string | null;
  coadminUid?: string | null;
  paymentQrUrl?: string | null;
  paymentQrPublicId?: string | null;
  paymentDetails?: string | null;
  cashBoxNpr?: number;
  createdAt?: any;
};

export type PlayerUser = {
  id: string;
  uid: string;
  username: string;
  email: string;
  role: 'player';
  status: 'active' | 'disabled';
  createdBy: string | null;
  coadminUid?: string | null;
  /** In-app coin (game balance). */
  coin?: number;
  /** Cash / redeem balance (optional; shown when present). */
  cash?: number;
  /** Aggregated total recharge amount (from player requests). */
  totalRechargeAmount?: number;
  /** Aggregated total redeem amount (from player requests). */
  totalRedeemAmount?: number;
  /** Aggregated total recharge count (from player requests). */
  totalRechargeCount?: number;
  /** Aggregated total redeem count (from player requests). */
  totalRedeemCount?: number;
  vendor?: VendorAwareness | null;
  createdAt?: any;
};

export type ManagedUser = StaffUser | CarerUser | PlayerUser;
type DirectoryRole = 'staff' | 'carer' | 'coadmin' | 'player';
type UsersListScopeOptions = {
  coadminUid?: string | null;
  all?: boolean;
};

let playerReferralBackfillAttempted = false;

const USERS_CACHE_TIMEOUT_MS = 5_000;
const PLAYERS_CACHE_TIMEOUT_MS = 5_000;
const CARER_CREATION_REQUESTS_CACHE_TIMEOUT_MS = 5_000;
const usersCacheInFlight = new Map<string, Promise<unknown>>();
const adminEndpointInFlight = new Map<string, Promise<unknown>>();

function singleFlight<T>(
  key: string,
  factory: () => Promise<T>,
  logEndpoint?: string
): Promise<T> {
  const existing = usersCacheInFlight.get(key) as Promise<T> | undefined;
  if (existing) {
    if (logEndpoint) {
      console.info('[ADMIN_STARTUP_DEDUPED_REQUEST]', { endpoint: logEndpoint });
      console.info('[ADMIN_STARTUP_REQUEST_DEDUPED]', { endpoint: logEndpoint });
    }
    return existing;
  }

  const promise = factory().finally(() => {
    usersCacheInFlight.delete(key);
  });
  usersCacheInFlight.set(key, promise);
  return promise;
}

function singleFlightAdminEndpoint<T>(
  key: string,
  factory: () => Promise<T>
): Promise<T> {
  const existing = adminEndpointInFlight.get(key) as Promise<T> | undefined;
  if (existing) {
    console.info('[ADMIN_STARTUP_DEDUPED_REQUEST]', { endpoint: key });
    console.info('[ADMIN_STARTUP_REQUEST_DEDUPED]', { endpoint: key });
    return existing;
  }

  const promise = factory().finally(() => {
    adminEndpointInFlight.delete(key);
  });
  adminEndpointInFlight.set(key, promise);
  return promise;
}

async function fetchWithCacheTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function getUsersCacheReadHeaders() {
  return getApiAuthHeaders(false, { action: 'read' });
}

async function getAdminActionHeaders(action: ApiAuthHeaderAction) {
  return getApiAuthHeaders(true, { action });
}

export async function getAdminActorUid() {
  const cached = getCachedSessionUser();
  if (cached?.uid) {
    return cached.uid;
  }
  const sessionUser = await getSessionUserOnce();
  if (sessionUser?.uid) {
    return sessionUser.uid;
  }
  const firebaseUid = auth.currentUser?.uid;
  if (firebaseUid) {
    return firebaseUid;
  }
  throw new Error('Not authenticated.');
}

async function resolveUsersListScope(options?: UsersListScopeOptions) {
  if (options?.all) {
    return null;
  }
  if (options?.coadminUid) {
    return options.coadminUid.trim() || null;
  }
  const scoped = await getCurrentUserCoadminUid();
  return scoped || null;
}

async function tryReadUsersCacheByRole<T extends ManagedUser | CoadminUser>(
  role: DirectoryRole,
  options?: UsersListScopeOptions
): Promise<T[] | null> {
  const startedAt = Date.now();
  const coadminUid = await resolveUsersListScope(options);
  const params = new URLSearchParams({ role });
  if (coadminUid) {
    params.set('coadminUid', coadminUid);
  }
  if (role === 'player' && !params.has('status')) {
    params.set('includeDisabled', 'true');
  }
  const endpoint = `/api/users/cache?${params.toString()}`;

  return singleFlight(`users:${params.toString()}`, async () => {
    const headers = await getUsersCacheReadHeaders();
    const response = await fetchWithCacheTimeout(
      endpoint,
      {
        method: 'GET',
        headers,
        cache: 'no-store',
      },
      USERS_CACHE_TIMEOUT_MS
    );
    if (!response.ok) {
      console.info('[USERS_CACHE_READ] source=firestore_fallback', {
        role,
        coadminUid: coadminUid || '',
        reason: `cache_api_status_${response.status}`,
        durationMs: Date.now() - startedAt,
      });
      return null;
    }

    const payload = (await response.json()) as {
      users?: T[];
      source?: string;
    };
    if (Array.isArray(payload.users)) {
      console.info(
        `[USERS_CACHE_READ] source=${payload.source === 'postgres' ? 'postgres' : 'firestore_fallback'} role=${role} coadminUid=${coadminUid || ''} count=${payload.users.length} durationMs=${Date.now() - startedAt}`
      );
      return payload.users;
    }
    return null;
  }, endpoint).catch((error) => {
      console.info('[USERS_CACHE_READ] source=firestore_fallback', {
        role,
        coadminUid: coadminUid || '',
        reason: 'cache_api_failed',
        durationMs: Date.now() - startedAt,
        error,
      });
      return null;
    });
}

async function getUsersByRoleSqlFirst<T extends ManagedUser | CoadminUser>(
  role: T['role'],
  options?: UsersListScopeOptions
): Promise<T[]> {
  const cached = await tryReadUsersCacheByRole<T>(role as DirectoryRole, options);
  if (cached !== null) {
    return cached;
  }

  const startedAt = Date.now();
  const users = await getUsersByRoleFirestore<T>(role, options);
  const coadminUid = await resolveUsersListScope(options);
  console.info(
    `[USERS_CACHE_READ] source=firestore_fallback role=${role} coadminUid=${coadminUid || ''} count=${users.length} durationMs=${Date.now() - startedAt}`
  );
  return users;
}

async function tryReadPlayersCacheByCoadmin(coadminUid: string): Promise<PlayerUser[] | null> {
  const cleanCoadminUid = coadminUid.trim();
  if (!cleanCoadminUid) {
    return [];
  }

  const startedAt = Date.now();
  try {
    const headers = await getUsersCacheReadHeaders();
    const response = await fetchWithCacheTimeout(
      `/api/players/cache?coadminUid=${encodeURIComponent(cleanCoadminUid)}`,
      {
        method: 'GET',
        headers,
        cache: 'no-store',
      },
      PLAYERS_CACHE_TIMEOUT_MS
    );
    if (!response.ok) {
      if (response.status === 403 || response.status === 401) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || 'Forbidden.');
      }
      console.info('[PLAYERS_CACHE_READ] source=firestore_fallback', {
        coadminUid: cleanCoadminUid,
        reason: `cache_api_status_${response.status}`,
        durationMs: Date.now() - startedAt,
      });
      return null;
    }

    const payload = (await response.json()) as {
      players?: PlayerUser[];
      source?: string;
    };
    if (Array.isArray(payload.players)) {
      console.info(
        `[PLAYERS_CACHE_READ] source=${payload.source === 'postgres' ? 'postgres' : 'firestore_fallback'} coadminUid=${cleanCoadminUid} count=${payload.players.length} durationMs=${Date.now() - startedAt}`
      );
      return payload.players;
    }
    return null;
  } catch (error) {
    console.info('[PLAYERS_CACHE_READ] source=firestore_fallback', {
      coadminUid: cleanCoadminUid,
      reason: 'cache_api_failed',
      durationMs: Date.now() - startedAt,
      error,
    });
    return null;
  }
}

export type CarerCreationRequest = {
  id: string;
  coadminUid: string;
  coadminUsername: string;
  requestedUsername: string;
  status: 'pending' | 'approved' | 'rejected';
  requestedAt?: any;
  reviewedAt?: any;
  reviewedByUid?: string | null;
  reviewedByUsername?: string | null;
  createdCarerUid?: string | null;
  note?: string | null;
};

async function parseApiResponse(response: Response) {
  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(text || 'Server returned invalid response.');
  }
}

async function normalizeUsersWithCoadminUid<
  T extends {
    id: string;
    uid: string;
    role: string;
    createdBy: string | null;
    coadminUid?: string | null;
  }
>(users: T[]) {
  const creatorIds = Array.from(
    new Set(
      users
        .filter((user) => !user.coadminUid && user.createdBy)
        .map((user) => String(user.createdBy))
    )
  );

  if (creatorIds.length === 0) {
    return users;
  }

  const creatorEntries = await Promise.all(
    creatorIds.map(async (creatorId) => {
      const creatorSnap = await getDoc(doc(db, 'users', creatorId));

      if (!creatorSnap.exists()) {
        return [creatorId, null] as const;
      }

      const creatorData = creatorSnap.data() as CoadminScopedRecord;
      const creatorCoadminUid = resolveCoadminUid({
        uid: creatorSnap.id,
        ...creatorData,
      });

      return [creatorId, creatorCoadminUid] as const;
    })
  );

  const creatorMap = new Map(creatorEntries);

  return users.map((user) => {
    if (user.coadminUid) {
      return user;
    }

    const inferredCoadminUid =
      (user.createdBy && creatorMap.get(user.createdBy)) || null;

    if (!inferredCoadminUid) {
      return user;
    }

    return {
      ...user,
      coadminUid: inferredCoadminUid,
    };
  });
}

async function getUsersByRoleFirestore<T extends ManagedUser | CoadminUser>(
  role: T['role'],
  options?: UsersListScopeOptions
): Promise<T[]> {
  if (assertClientFirestoreDisabled('admin_users_by_role', 'getDocs', { role })) {
    return [];
  }

  const coadminUid = await resolveUsersListScope(options);
  const q = query(collection(db, 'users'), where('role', '==', role));
  const snapshot = await getDocs(q);

  const users = snapshot.docs
    .map((docSnap) => ({
      id: docSnap.id,
      ...(docSnap.data() as Omit<T, 'id'>),
    }))
    .filter((user) => {
      if (!coadminUid) {
        return true;
      }
      const scopedUser = user as { coadminUid?: string | null; createdBy?: string | null };
      return (
        scopedUser.coadminUid === coadminUid || scopedUser.createdBy === coadminUid
      );
    });

  return normalizeUsersWithCoadminUid(users as T[]);
}

async function backfillPlayerReferralCodesIfNeeded() {
  if (playerReferralBackfillAttempted) {
    console.info('[player-referral-backfill] backfill skipped client already-run');
    return;
  }

  if (typeof window !== 'undefined') {
    const key = 'playerReferralBackfillAttempted';
    if (window.sessionStorage.getItem(key) === '1') {
      playerReferralBackfillAttempted = true;
      console.info('[player-referral-backfill] backfill skipped client already-run');
      return;
    }
    window.sessionStorage.setItem(key, '1');
  }

  playerReferralBackfillAttempted = true;
  try {
    console.info('[player-referral-backfill] backfill started');
    await fetch('/api/admin/backfill-player-referrals', {
      method: 'POST',
      headers: await getApiAuthHeaders(false, { action: 'update' }),
    });
  } catch {
    // Non-blocking best-effort backfill.
  }
}

async function createManagedUser(
  username: string,
  password: string,
  role: 'staff' | 'carer' | 'player',
  referralCodeInput?: string
) {
  const cleanUsername = role === 'player' ? username.trim() : username.trim().toLowerCase();

  if (!cleanUsername) throw new Error('Username is required.');
  if (role === 'player') {
    assertValidGameUsername(cleanUsername);
  }
  if (password.length < 6) {
    throw new Error('Password must be at least 6 characters.');
  }

  const coadminUid = await getCurrentUserCoadminUid();
  const creatorUid = await getAdminActorUid();

  const response = await fetch('/api/admin/create-staff', {
    method: 'POST',
    headers: await getAdminActionHeaders('create'),
    body: JSON.stringify({
      username: cleanUsername,
      password,
      role,
      createdBy: coadminUid,
      coadminUid,
      creatorUid,
      ...(role === 'player'
        ? { referralCodeInput: String(referralCodeInput || '').trim() || null }
        : {}),
    }),
  });

  const data = await parseApiResponse(response);

  if (!response.ok) {
    throw new Error(data.error || `Failed to create ${role}.`);
  }

  return data;
}

async function deleteManagedUser(user: ManagedUser) {
  const response = await fetch('/api/admin/delete-user', {
    method: 'POST',
    headers: await getAdminActionHeaders('delete'),
    body: JSON.stringify({
      uid: user.uid,
    }),
  });

  const data = await parseApiResponse(response);

  if (!response.ok) {
    throw new Error(data.error || 'Failed to delete user.');
  }

  return data;
}

export type DeletedPlayerRecord = {
  uid: string;
  username: string;
  email: string;
  status?: string;
  createdBy?: string | null;
  coadminUid?: string | null;
  coin?: number;
  cash?: number;
  role: 'player';
  deletedAt?: string;
  deletedByUid?: string | null;
};

export async function getDeletedPlayers(): Promise<DeletedPlayerRecord[]> {
  const response = await fetch('/api/admin/player-archive', {
    method: 'GET',
    headers: await getApiAuthHeaders(false, { action: 'read' }),
  });

  const data = await parseApiResponse(response);

  if (!response.ok) {
    throw new Error(data.error || 'Failed to load deleted players.');
  }

  return (data.players || []) as DeletedPlayerRecord[];
}

export async function recreateDeletedPlayer(uid: string) {
  const response = await fetch('/api/admin/player-archive', {
    method: 'POST',
    headers: await getAdminActionHeaders('update'),
    body: JSON.stringify({ uid }),
  });

  const data = await parseApiResponse(response);

  if (!response.ok) {
    throw new Error(data.error || 'Failed to recreate player.');
  }

  return data;
}

export async function deletePlayerForever(uid: string) {
  const response = await fetch('/api/admin/player-archive', {
    method: 'DELETE',
    headers: await getAdminActionHeaders('delete'),
    body: JSON.stringify({ uid }),
  });

  const data = await parseApiResponse(response);

  if (!response.ok) {
    throw new Error(data.error || 'Failed to permanently delete player.');
  }

  return data;
}

async function setManagedUserStatus(
  uid: string,
  status: 'active' | 'disabled'
) {
  const response = await fetch('/api/admin/set-user-status', {
    method: 'POST',
    headers: await getAdminActionHeaders('status'),
    body: JSON.stringify({
      uid,
      status,
    }),
  });

  const data = await parseApiResponse(response);

  if (!response.ok) {
    throw new Error(data.error || 'Failed to update user status.');
  }

  return data;
}

export async function getStaff(options?: UsersListScopeOptions): Promise<StaffUser[]> {
  return getUsersByRoleSqlFirst<StaffUser>('staff', options);
}

export async function createStaff(username: string, password: string) {
  return createManagedUser(username, password, 'staff');
}

export async function deleteStaff(staff: StaffUser) {
  return deleteManagedUser(staff);
}

export async function blockStaff(staff: StaffUser) {
  return setManagedUserStatus(staff.uid, 'disabled');
}

export async function unblockStaff(staff: StaffUser) {
  return setManagedUserStatus(staff.uid, 'active');
}

export async function getCarers(options?: UsersListScopeOptions): Promise<CarerUser[]> {
  return getUsersByRoleSqlFirst<CarerUser>('carer', options);
}

export async function createCarer(username: string, password: string) {
  return createManagedUser(username, password, 'carer');
}

export async function requestCarerCreation(username: string) {
  const cleanUsername = username.trim().toLowerCase();
  if (!cleanUsername) {
    throw new Error('Username is required.');
  }

  const response = await fetch('/api/coadmin/request-carer', {
    method: 'POST',
    headers: await getAdminActionHeaders('create'),
    body: JSON.stringify({ username: cleanUsername }),
  });
  const data = await parseApiResponse(response);
  if (!response.ok) {
    throw new Error(data.error || 'Failed to submit carer request.');
  }
  return data;
}

export async function getPendingCarerCreationRequests(): Promise<CarerCreationRequest[]> {
  return singleFlightAdminEndpoint('/api/admin/carer-creation-requests', async () => {
    const response = await fetch('/api/admin/carer-creation-requests', {
      method: 'GET',
      headers: await getApiAuthHeaders(false, { action: 'read' }),
    });
    const data = await parseApiResponse(response);
    if (!response.ok) {
      throw new Error(data.error || 'Failed to load carer requests.');
    }
    return (data.requests || []) as CarerCreationRequest[];
  });
}

export async function getMyPendingCarerCreationRequests(): Promise<CarerCreationRequest[]> {
  const actorUid = await getAdminActorUid();
  const startedAt = Date.now();
  try {
    const headers = await getUsersCacheReadHeaders();
    const response = await fetchWithCacheTimeout(
      '/api/carer-creation-requests/cache?scope=mine',
      {
        method: 'GET',
        headers,
        cache: 'no-store',
      },
      CARER_CREATION_REQUESTS_CACHE_TIMEOUT_MS
    );
    if (!response.ok) {
      throw new Error('Failed to load pending carer requests.');
    }

    const data = (await parseApiResponse(response)) as {
      requests?: CarerCreationRequest[];
      source?: string;
    };
    const requests = (data.requests || []) as CarerCreationRequest[];
    console.info('[CARER_CREATION_REQUEST_SQL]', {
      action: 'list_mine',
      coadminUid: actorUid,
      source: data.source === 'postgres' ? 'postgres' : 'firestore_fallback',
      count: requests.length,
      durationMs: Date.now() - startedAt,
    });
    return requests;
  } catch (error) {
    console.info('[CARER_CREATION_REQUEST_SQL]', {
      action: 'list_mine',
      coadminUid: actorUid,
      source: 'firestore_fallback',
      count: 0,
      durationMs: Date.now() - startedAt,
      error,
    });
    throw error instanceof Error ? error : new Error('Failed to load pending carer requests.');
  }
}

export async function approveCarerCreationRequest(requestId: string, password: string) {
  if (!requestId.trim()) {
    throw new Error('Request id is required.');
  }
  if (password.length < 6) {
    throw new Error('Password must be at least 6 characters.');
  }

  const response = await fetch('/api/admin/carer-creation-requests', {
    method: 'POST',
    headers: await getAdminActionHeaders('update'),
    body: JSON.stringify({
      requestId: requestId.trim(),
      password,
      action: 'approve',
    }),
  });
  const data = await parseApiResponse(response);
  if (!response.ok) {
    throw new Error(data.error || 'Failed to approve carer request.');
  }
  return data;
}

export async function deleteCarer(carer: CarerUser) {
  return deleteManagedUser(carer);
}

export async function blockCarer(carer: CarerUser) {
  return setManagedUserStatus(carer.uid, 'disabled');
}

export async function unblockCarer(carer: CarerUser) {
  return setManagedUserStatus(carer.uid, 'active');
}

export async function getPlayers(options?: UsersListScopeOptions): Promise<PlayerUser[]> {
  return getUsersByRoleSqlFirst<PlayerUser>('player', { all: true, ...options });
}

export async function getPlayersByCoadminSqlFirst(coadminUid: string): Promise<PlayerUser[]> {
  const cached = await tryReadPlayersCacheByCoadmin(coadminUid);
  if (cached) {
    return cached;
  }

  const startedAt = Date.now();
  const players = await getPlayersByCoadmin(coadminUid);
  console.info(
    `[PLAYERS_CACHE_READ] source=firestore_fallback coadminUid=${coadminUid.trim()} count=${players.length} durationMs=${Date.now() - startedAt}`
  );
  return players;
}

export async function getPlayersByCoadmin(coadminUid: string): Promise<PlayerUser[]> {
  if (!coadminUid.trim()) {
    return [];
  }

  const [scopedSnapshot, legacySnapshot] = await Promise.all([
    getDocs(
      query(
        collection(db, 'users'),
        where('role', '==', 'player'),
        where('coadminUid', '==', coadminUid)
      )
    ),
    getDocs(
      query(
        collection(db, 'users'),
        where('role', '==', 'player'),
        where('createdBy', '==', coadminUid)
      )
    ),
  ]);

  const merged = [
    ...scopedSnapshot.docs.map((docSnap) => ({
      id: docSnap.id,
      ...(docSnap.data() as Omit<PlayerUser, 'id'>),
    })),
    ...legacySnapshot.docs.map((docSnap) => ({
      id: docSnap.id,
      ...(docSnap.data() as Omit<PlayerUser, 'id'>),
    })),
  ];

  return normalizeUsersWithCoadminUid(
    Array.from(new Map(merged.map((user) => [user.id, user])).values())
  );
}

export async function createPlayer(
  username: string,
  password: string,
  referralCodeInput?: string
) {
  return createManagedUser(username, password, 'player', referralCodeInput);
}

export async function deletePlayer(player: PlayerUser) {
  return deleteManagedUser(player);
}

export async function blockPlayer(player: PlayerUser) {
  return setManagedUserStatus(player.uid, 'disabled');
}

export async function unblockPlayer(player: PlayerUser) {
  return setManagedUserStatus(player.uid, 'active');
}

export async function getCoadmins(): Promise<CoadminUser[]> {
  return getUsersByRoleSqlFirst<CoadminUser>('coadmin', { all: true });
}

export async function createCoadmin(username: string, password: string) {
  const cleanUsername = username.trim().toLowerCase();

  if (!cleanUsername) throw new Error('Username is required.');
  if (password.length < 6) {
    throw new Error('Password must be at least 6 characters.');
  }

  const createdBy = await getAdminActorUid();

  const response = await fetch('/api/admin/create-coadmin', {
    method: 'POST',
    headers: await getAdminActionHeaders('create'),
    body: JSON.stringify({
      username: cleanUsername,
      password,
      createdBy,
    }),
  });

  const data = await parseApiResponse(response);

  if (!response.ok) {
    throw new Error(data.error || 'Failed to create co-admin.');
  }

  return data;
}

export async function deleteCoadmin(coadmin: CoadminUser) {
  const response = await fetch('/api/admin/delete-user', {
    method: 'POST',
    headers: await getAdminActionHeaders('delete'),
    body: JSON.stringify({
      uid: coadmin.uid,
    }),
  });

  const data = await parseApiResponse(response);

  if (!response.ok) {
    throw new Error(data.error || 'Failed to delete co-admin.');
  }

  return data;
}

export async function blockCoadmin(coadmin: CoadminUser) {
  return setManagedUserStatus(coadmin.uid, 'disabled');
}

export async function unblockCoadmin(coadmin: CoadminUser) {
  return setManagedUserStatus(coadmin.uid, 'active');
}

/** Coadmin: change password and/or app login username for a staff or carer you manage. */
export async function resetCoadminWorkerCredentials(
  user: StaffUser | CarerUser | PlayerUser,
  options: { newPassword?: string; newUsername?: string }
) {
  if (!options.newPassword && options.newUsername === undefined) {
    throw new Error('New password or new username is required.');
  }
  if (options.newUsername !== undefined && !String(options.newUsername).trim()) {
    throw new Error('Username cannot be empty.');
  }
  if (options.newUsername !== undefined && user.role === 'player') {
    assertValidGameUsername(String(options.newUsername));
  }

  const response = await fetch('/api/coadmin/reset-worker-credentials', {
    method: 'POST',
    headers: await getAdminActionHeaders('reset_password'),
    body: JSON.stringify({
      targetUid: user.uid,
      newPassword: options.newPassword,
      newUsername: options.newUsername,
    }),
  });

  const data = await parseApiResponse(response);
  if (!response.ok) {
    throw new Error(data.error || 'Failed to update sign-in details.');
  }
  return data;
}

export async function setStaffPlayerPrivilege(
  staff: StaffUser,
  canViewPlayers: boolean
): Promise<{ canViewPlayers: boolean; changed: boolean }> {
  const response = await fetch('/api/coadmin/staff-player-privilege', {
    method: 'POST',
    headers: await getAdminActionHeaders('update'),
    body: JSON.stringify({
      staffUid: staff.uid,
      canViewPlayers,
    }),
  });

  const data = await parseApiResponse(response);
  if (!response.ok) {
    throw new Error(data.error || 'Failed to update player privilege.');
  }
  return {
    canViewPlayers: Boolean(data.canViewPlayers),
    changed: Boolean(data.changed),
  };
}

export async function adminResetManagedPassword(
  user: CoadminUser | StaffUser,
  newPassword: string
) {
  if (!newPassword || newPassword.length < 6) {
    throw new Error('Password must be at least 6 characters.');
  }
  const response = await fetch('/api/admin/reset-user-password', {
    method: 'POST',
    headers: await getAdminActionHeaders('reset_password'),
    body: JSON.stringify({
      targetUid: user.uid,
      newPassword,
    }),
  });
  const data = await parseApiResponse(response);
  if (!response.ok) {
    throw new Error(data.error || 'Failed to reset password.');
  }
  return data;
}

export async function transferPlayerToCoadmin(playerUid: string, targetCoadminUid: string) {
  const response = await fetch('/api/admin/transfer-player-coadmin', {
    method: 'POST',
    headers: await getAdminActionHeaders('update'),
    body: JSON.stringify({
      playerUid,
      targetCoadminUid,
    }),
  });
  const data = await parseApiResponse(response);
  if (!response.ok) {
    throw new Error(data.error || 'Failed to transfer player.');
  }
  return data;
}
