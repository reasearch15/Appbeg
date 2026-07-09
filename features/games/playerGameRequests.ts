import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';

import { getAppSessionRequestHeaders } from '@/features/auth/appSession';
import {
  assertActivePlayerSession,
  getPlayerApiHeaders,
  resolvePlayerApiHeaderMode,
} from '@/features/auth/playerSession';
import { getCachedSessionUser, getSessionUserOnce } from '@/features/auth/sessionUser';
import { auth, db } from '@/lib/firebase/client';
import { getFirebaseApiHeaders } from '@/lib/firebase/apiClient';
import {
  belongsToCoadmin,
  getCurrentUserCoadminUid,
  type CoadminScopedRecord,
} from '@/lib/coadmin/scope';
import { completedPlayerGameRequestTtl } from '@/lib/firestore/ttl';
import { assertClientFirestoreDisabled } from '@/lib/client/clientFirestoreGuard';
import { isClientSqlReadMode, logClientFirestoreSkipped } from '@/lib/client/sqlReadMode';

export type PlayerGameRequestType = 'recharge' | 'redeem';
export type PlayerGameRequestStatus =
  | 'pending'
  | 'completed'
  | 'failed'
  | 'poked'
  | 'pending_review'
  | 'dismissed'
  | 'waiting_player_exit'
  | 'retry_requested'
  | 'pending_automation';

export type PlayerGameRequest = {
  id: string;
  playerUid: string;
  gameName: string;
  currentUsername?: string | null;
  gameAccountUsername?: string | null;
  amount: number;
  baseAmount?: number | null;
  bonusPercentage?: number | null;
  bonusEventId?: string | null;
  firstRechargeMatchApplied?: boolean | null;
  type: PlayerGameRequestType;
  status: PlayerGameRequestStatus;
  createdBy?: string;
  coadminUid?: string;
  createdAt?: Date | null;
  completedAt?: Date | null;
  pokedAt?: Date | null;
  pokeMessage?: string | null;
  /**
   * When true, the player's `coin` was already reduced when the request was
   * created; carer completion must not deduct again (legacy requests omit this).
   */
  coinDeductedOnRequest?: boolean | null;
  coinRefundedOnDismissal?: boolean | null;
  dismissedByAutomation?: boolean | null;
  dismissType?: string | null;
  dismissReasonCode?: string | null;
  dismissReasonMessage?: string | null;
  automationStatus?: string | null;
  playerMessage?: string | null;
  retryAttempt?: number | null;
};

export type CreatePlayerGameRequestResult = {
  requestId: string;
  request: PlayerGameRequest;
  ok: boolean;
  status: number;
  duplicate?: boolean;
  authority?: string;
};

type PlayerGameRedeemLimitReset = {
  playerUid: string;
  gameName: string;
  resetAt?: Date | null;
  resetByUid?: string | null;
  coadminUid?: string | null;
};

export type PlayerGameRedeemLimitSummary = {
  gameName: string;
  usedAmount: number;
  remainingAmount: number;
  onLimit: boolean;
  windowStartedAtMs: number;
  resetAtMs: number;
};

export const MIN_REDEEM_AMOUNT = 50;
export const MAX_REDEEM_AMOUNT = 350;
export const PLAYER_GAME_REDEEM_MAX_PER_24H = 350;
export const PLAYER_GAME_REDEEM_ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;
const PLAYER_REQUEST_HISTORY_LISTENER_LIMIT = 40;
const PLAYER_REQUEST_ACTIVE_STATUSES: PlayerGameRequestStatus[] = [
  'pending',
  'poked',
  'pending_review',
  'waiting_player_exit',
  'retry_requested',
  'pending_automation',
];

function normalizeGameName(gameName: string) {
  return gameName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

function getRedeemLimitResetDocId(playerUid: string, gameName: string) {
  return `${String(playerUid || '').trim()}__${encodeURIComponent(
    String(gameName || '').trim()
  )}`;
}

function getTimestampMs(value?: unknown) {
  if (!value) {
    return 0;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  const maybe = value as { toMillis?: () => number; toDate?: () => Date; seconds?: number };
  if (typeof maybe.toMillis === 'function') {
    return maybe.toMillis();
  }
  if (typeof maybe.toDate === 'function') {
    return maybe.toDate().getTime();
  }
  if (typeof maybe.seconds === 'number') {
    return maybe.seconds * 1000;
  }
  return 0;
}

async function fetchRedeemLimitResetForPlayerGame(
  playerUid: string,
  gameName: string
): Promise<PlayerGameRedeemLimitReset | null> {
  const cleanPlayerUid = String(playerUid || '').trim();
  const cleanGameName = String(gameName || '').trim();
  if (!cleanPlayerUid || !cleanGameName) {
    return null;
  }

  const resetSnap = await getDoc(
    doc(
      db,
      'playerGameRedeemLimitResets',
      getRedeemLimitResetDocId(cleanPlayerUid, cleanGameName)
    )
  );

  if (!resetSnap.exists()) {
    return null;
  }

  return resetSnap.data() as PlayerGameRedeemLimitReset;
}

function mapRequestDoc(docId: string, value: Omit<PlayerGameRequest, 'id'>) {
  return {
    id: docId,
    ...value,
  } satisfies PlayerGameRequest;
}

/** Dynamic import avoids a static circular dependency with `carerTasks`. */
async function upsertLinkedCarerTaskForRequest(request: PlayerGameRequest) {
  const { upsertCarerTaskForPlayerGameRequest } = await import('./carerTasks');
  await upsertCarerTaskForPlayerGameRequest(request);
}

async function tombstoneLinkedCarerTaskCacheBestEffort(taskId: string) {
  const cleanTaskId = String(taskId || '').trim();
  if (!cleanTaskId) return;
  try {
    const token = await auth.currentUser?.getIdToken();
    if (!token) return;
    const response = await fetch('/api/carer-tasks/cache/mirror', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...getAppSessionRequestHeaders(),
      },
      body: JSON.stringify({ taskId: cleanTaskId, action: 'tombstone' }),
    });
    if (!response.ok) {
      console.error('[CARER_TASKS_CACHE] tombstone failed', {
        taskId: cleanTaskId,
        status: response.status,
      });
    }
  } catch (error) {
    console.error('[CARER_TASKS_CACHE] tombstone failed', { taskId: cleanTaskId, error });
  }
}

async function mirrorPlayerGameRequestCacheBestEffort(
  requestId: string,
  action: 'upsert' | 'tombstone' = 'upsert'
) {
  const cleanRequestId = String(requestId || '').trim();
  if (!cleanRequestId) return;
  try {
    const token = await auth.currentUser?.getIdToken();
    if (!token) return;
    const response = await fetch('/api/player-game-requests/cache/mirror', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...getAppSessionRequestHeaders(),
      },
      body: JSON.stringify({ requestId: cleanRequestId, action }),
    });
    if (!response.ok) {
      console.error('[PLAYER_GAME_REQUESTS_CACHE] mirror failed', {
        requestId: cleanRequestId,
        action,
        status: response.status,
      });
    }
  } catch (error) {
    console.error('[PLAYER_GAME_REQUESTS_CACHE] mirror failed', {
      requestId: cleanRequestId,
      action,
      error,
    });
  }
}

function sortByNewest(requests: PlayerGameRequest[]) {
  return sortPlayerGameRequestsByNewest(requests);
}

export function sortPlayerGameRequestsByNewest(requests: PlayerGameRequest[]) {
  return [...requests].sort((left, right) => {
    const leftTime =
      getTimestampMs(left.pokedAt) ||
      getTimestampMs(left.completedAt) ||
      getTimestampMs(left.createdAt);
    const rightTime =
      getTimestampMs(right.pokedAt) ||
      getTimestampMs(right.completedAt) ||
      getTimestampMs(right.createdAt);

    return rightTime - leftTime;
  });
}

async function getPlayerRequestAuthHeaders() {
  return getPlayerApiHeaders();
}

async function resolvePlayerActorUid(): Promise<string> {
  const cached = getCachedSessionUser();
  const sessionUser =
    cached?.uid && cached.role === 'player' ? cached : await getSessionUserOnce();
  if (sessionUser?.role === 'player' && sessionUser.uid) {
    return sessionUser.uid;
  }
  const firebaseUid = auth.currentUser?.uid;
  if (firebaseUid) {
    return firebaseUid;
  }
  throw new Error('Not authenticated.');
}

function logPlayerRechargeRequestAuth(headers: Record<string, string>) {
  console.info('[PLAYER_RECHARGE_REQUEST_AUTH]', {
    hasAppSession: Boolean(headers['X-App-Session-Id']),
    hasPlayerSession: Boolean(headers['X-Player-Session-Id']),
    hasFirebaseUser: Boolean(auth.currentUser),
    headerMode: resolvePlayerApiHeaderMode(headers),
  });
}

function readApiError(messageFallback: string, payload: unknown) {
  if (
    payload &&
    typeof payload === 'object' &&
    'message' in payload &&
    typeof (payload as { message?: unknown }).message === 'string'
  ) {
    return String((payload as { message: string }).message || messageFallback);
  }
  if (
    payload &&
    typeof payload === 'object' &&
    'error' in payload &&
    typeof (payload as { error?: unknown }).error === 'string'
  ) {
    return String((payload as { error: string }).error || messageFallback);
  }
  return messageFallback;
}

function logPostApiSqlSkip(requestId: string, type: PlayerGameRequestType) {
  console.info('[PLAYER_GAME_REQUEST_POST_API_SQL_SKIP]', {
    requestId,
    type,
    reason: 'server_sql_authority_creates_carer_task',
    firestoreAttempted: false,
  });
}

async function finalizePlayerGameRequestAfterApi(
  requestId: string,
  type: PlayerGameRequestType
) {
  console.info('[PLAYER_GAME_REQUEST] server-created linked task expected', {
    requestId,
    type,
  });
  if (isClientSqlReadMode()) {
    logPostApiSqlSkip(requestId, type);
    return;
  }
  const snap = await getDoc(doc(db, 'playerGameRequests', requestId));
  if (snap.exists()) {
    await upsertLinkedCarerTaskForRequest(
      mapRequestDoc(snap.id, snap.data() as Omit<PlayerGameRequest, 'id'>)
    );
  }
}

async function fetchRolling24hRedeemUsageForPlayerGame(
  playerUid: string,
  gameName: string
) {
  const cleanGameName = String(gameName || '').trim();
  const cleanPlayerUid = String(playerUid || '').trim();
  if (!cleanPlayerUid || !cleanGameName) {
    return 0;
  }

  const sinceMillis = Date.now() - PLAYER_GAME_REDEEM_ROLLING_WINDOW_MS;
  const resetRecord = await fetchRedeemLimitResetForPlayerGame(
    cleanPlayerUid,
    cleanGameName
  );
  const resetAtMs = getTimestampMs(resetRecord?.resetAt || null);
  const effectiveSinceMillis = Math.max(sinceMillis, resetAtMs);
  const redeemQuery = query(
    collection(db, 'playerGameRequests'),
    where('playerUid', '==', cleanPlayerUid),
    where('type', '==', 'redeem'),
    where('gameName', '==', cleanGameName),
    where('createdAt', '>=', new Date(sinceMillis))
  );
  const snapshot = await getDocs(redeemQuery);
  let total = 0;

  snapshot.forEach((docSnap) => {
    const data = docSnap.data() as {
      status?: string;
      amount?: number;
      createdAt?: Date | null;
    };
    const status = String(data.status || '').toLowerCase();
    if (status === 'dismissed' || status === 'failed') {
      return;
    }
    if (getTimestampMs(data.createdAt || null) < effectiveSinceMillis) {
      return;
    }
    total += Math.max(0, Number(data.amount || 0));
  });

  return total;
}

export async function getPlayerGameRedeemLimitSummary(
  playerUid: string,
  gameName: string
): Promise<PlayerGameRedeemLimitSummary> {
  const cleanGameName = String(gameName || '').trim();
  const usedAmount = await fetchRolling24hRedeemUsageForPlayerGame(
    playerUid,
    cleanGameName
  );
  const remainingAmount = Math.max(
    0,
    PLAYER_GAME_REDEEM_MAX_PER_24H - usedAmount
  );
  const resetRecord = await fetchRedeemLimitResetForPlayerGame(
    playerUid,
    cleanGameName
  );
  const resetAtMs = getTimestampMs(resetRecord?.resetAt || null);

  return {
    gameName: cleanGameName,
    usedAmount: Math.round(usedAmount),
    remainingAmount: Math.round(remainingAmount),
    onLimit: remainingAmount <= 0,
    windowStartedAtMs: Math.max(
      Date.now() - PLAYER_GAME_REDEEM_ROLLING_WINDOW_MS,
      resetAtMs
    ),
    resetAtMs,
  };
}

export async function resetPlayerGameRedeemLimitForCoadmin(
  playerUid: string,
  gameName: string
) {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error('Not authenticated.');
  }

  const cleanPlayerUid = String(playerUid || '').trim();
  const cleanGameName = String(gameName || '').trim();
  if (!cleanPlayerUid || !cleanGameName) {
    throw new Error('Player and game are required.');
  }

  const coadminUid = await getCurrentUserCoadminUid();
  if (!coadminUid.trim()) {
    throw new Error('Coadmin scope not found.');
  }

  const playerSnap = await getDoc(doc(db, 'users', cleanPlayerUid));
  if (!playerSnap.exists()) {
    throw new Error('Player profile not found.');
  }

  const playerData = playerSnap.data() as CoadminScopedRecord;
  if (!belongsToCoadmin(playerData, coadminUid)) {
    throw new Error('This player is outside your coadmin scope.');
  }

  await setDoc(
    doc(
      db,
      'playerGameRedeemLimitResets',
      getRedeemLimitResetDocId(cleanPlayerUid, cleanGameName)
    ),
    {
      playerUid: cleanPlayerUid,
      gameName: cleanGameName,
      resetAt: new Date(),
      resetByUid: currentUser.uid,
      coadminUid,
    } satisfies PlayerGameRedeemLimitReset
  );
}

async function getRequestsByStatuses(
  playerUid: string,
  statuses: PlayerGameRequestStatus[]
) {
  const results: PlayerGameRequest[] = [];

  for (const status of statuses) {
    const requestsQuery = query(
      collection(db, 'playerGameRequests'),
      where('playerUid', '==', playerUid),
      where('status', '==', status)
    );
    const snapshot = await getDocs(requestsQuery);

    snapshot.docs.forEach((docSnap) => {
      results.push(
        mapRequestDoc(
          docSnap.id,
          docSnap.data() as Omit<PlayerGameRequest, 'id'>
        )
      );
    });
  }

  return sortByNewest(results);
}

async function getRequestsByCoadminAndStatuses(
  coadminUid: string,
  statuses: PlayerGameRequestStatus[]
) {
  if (!coadminUid.trim() || statuses.length === 0) {
    return [];
  }

  const scopedQuery = query(
    collection(db, 'playerGameRequests'),
    where('coadminUid', '==', coadminUid),
    where('status', 'in', statuses)
  );
  const scopedSnapshot = await getDocs(scopedQuery);

  const requests = scopedSnapshot.docs.map((docSnap) =>
    mapRequestDoc(docSnap.id, docSnap.data() as Omit<PlayerGameRequest, 'id'>)
  );

  if (requests.length > 0) {
    return sortByNewest(requests);
  }

  const legacyQuery = query(
    collection(db, 'playerGameRequests'),
    where('createdBy', '==', coadminUid),
    where('status', 'in', statuses)
  );
  const legacySnapshot = await getDocs(legacyQuery);

  return sortByNewest(
    legacySnapshot.docs.map((docSnap) =>
      mapRequestDoc(docSnap.id, docSnap.data() as Omit<PlayerGameRequest, 'id'>)
    )
  );
}

async function assertCurrentPlayerIsActive(playerUid: string) {
  const cached = getCachedSessionUser();
  const sessionUser =
    cached?.uid === playerUid ? cached : (await getSessionUserOnce()) ?? null;
  if (sessionUser?.uid === playerUid) {
    if (sessionUser.status === 'disabled') {
      throw new Error(
        'Your account is blocked. Recharge and redeem features are disabled.'
      );
    }
    if (sessionUser.status === 'active') {
      return;
    }
  }

  const playerSnap = await getDoc(doc(db, 'users', playerUid));

  if (!playerSnap.exists()) {
    throw new Error('Player profile not found.');
  }

  const playerData = playerSnap.data() as { status?: string };

  if (playerData.status === 'disabled') {
    throw new Error(
      'Your account is blocked. Recharge and redeem features are disabled.'
    );
  }
}

export async function createPlayerGameRequest(values: {
  gameName: string;
  amount: number;
  type: PlayerGameRequestType;
  baseAmount?: number;
  bonusPercentage?: number;
  bonusEventId?: string;
  idempotencyKey?: string;
  onApiStart?: (meta: { route: string; type: PlayerGameRequestType }) => void;
}): Promise<CreatePlayerGameRequestResult> {
  const playerUid = await resolvePlayerActorUid();

  await assertActivePlayerSession();
  await assertCurrentPlayerIsActive(playerUid);

  if (!values.gameName.trim()) {
    throw new Error('Game is required.');
  }

  if (!values.amount || values.amount <= 0) {
    throw new Error('Enter a valid amount.');
  }

  const requestAmount = Number(values.amount);
  if (!Number.isFinite(requestAmount) || requestAmount <= 0) {
    throw new Error('Enter a valid amount.');
  }
  const cleanGameName = values.gameName.trim();
  const buildCommittedRequest = (
    requestId: string,
    type: PlayerGameRequestType
  ): PlayerGameRequest => ({
    id: requestId,
    playerUid,
    gameName: cleanGameName,
    amount: requestAmount,
    baseAmount: values.baseAmount ?? null,
    bonusPercentage: values.bonusPercentage ?? null,
    bonusEventId: values.bonusEventId ?? null,
    type,
    status: 'pending',
    createdBy: getCachedSessionUser()?.coadminUid || undefined,
    coadminUid: getCachedSessionUser()?.coadminUid || undefined,
    createdAt: new Date(),
    completedAt: null,
    pokedAt: null,
    pokeMessage: null,
  });

  if (values.type === 'recharge') {
    const headers = await getPlayerRequestAuthHeaders();
    logPlayerRechargeRequestAuth(headers);
    values.onApiStart?.({
      route: '/api/player/game-requests/recharge',
      type: 'recharge',
    });
    const response = await fetch('/api/player/game-requests/recharge', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        gameName: cleanGameName,
        amount: requestAmount,
        baseAmount: values.baseAmount,
        bonusPercentage: values.bonusPercentage,
        bonusEventId: values.bonusEventId,
        idempotencyKey: values.idempotencyKey,
      }),
    });
    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
      requestId?: string;
      duplicate?: boolean;
      authority?: string;
    };
    if (!response.ok) {
      const error = new Error(readApiError('Failed to create recharge request.', payload));
      Object.assign(error, {
        status: response.status,
        errorCode: payload.error || `http_${response.status}`,
      });
      throw error;
    }

    const createdRequestId = String(payload.requestId || '').trim();
    if (!createdRequestId) {
      throw new Error('Recharge request was created but request ID was missing.');
    }
    await finalizePlayerGameRequestAfterApi(createdRequestId, 'recharge');
    return {
      requestId: createdRequestId,
      request: buildCommittedRequest(createdRequestId, 'recharge'),
      ok: response.ok,
      status: response.status,
      duplicate: payload.duplicate === true,
      authority: payload.authority,
    };
  }

  if (requestAmount > MAX_REDEEM_AMOUNT) {
    throw new Error(
      `Redeem amount must not be more than ${MAX_REDEEM_AMOUNT}.`
    );
  }

  if (requestAmount < MIN_REDEEM_AMOUNT) {
    throw new Error(
      `Redeem amount must be between ${MIN_REDEEM_AMOUNT} and ${MAX_REDEEM_AMOUNT}.`
    );
  }

  const sqlMode = isClientSqlReadMode();
  if (!sqlMode) {
    const rollingRedeemUsed = await fetchRolling24hRedeemUsageForPlayerGame(
      playerUid,
      cleanGameName
    );
    const redeemRemaining = Math.max(
      0,
      PLAYER_GAME_REDEEM_MAX_PER_24H - rollingRedeemUsed
    );

    if (redeemRemaining <= 0) {
      throw new Error(
        `Redeem limit for ${cleanGameName} is ${PLAYER_GAME_REDEEM_MAX_PER_24H} per rolling 24 hours. Wait until older redeems expire from this game window before redeeming again.`
      );
    }

    if (requestAmount > redeemRemaining) {
      throw new Error(
        `Only ${redeemRemaining} redeem is left for ${cleanGameName} in this rolling 24-hour window.`
      );
    }
  } else {
    console.info('[PLAYER_REDEEM_CLIENT_SQL_PATH]', {
      playerUid,
      gameName: cleanGameName,
      amount: requestAmount,
      sqlMode: true,
      skippedClientFirestoreLimitCheck: true,
      willCallApi: true,
    });
  }

  values.onApiStart?.({
    route: '/api/player/game-requests/redeem',
    type: 'redeem',
  });
  const response = await fetch('/api/player/game-requests/redeem', {
    method: 'POST',
    headers: await getPlayerRequestAuthHeaders(),
    body: JSON.stringify({
      gameName: cleanGameName,
      amount: requestAmount,
      baseAmount: values.baseAmount,
      bonusPercentage: values.bonusPercentage,
      bonusEventId: values.bonusEventId,
      idempotencyKey: values.idempotencyKey,
    }),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    requestId?: string;
    duplicate?: boolean;
    authority?: string;
  };
  if (!response.ok) {
    const error = new Error(readApiError('Failed to create redeem request.', payload));
    Object.assign(error, {
      status: response.status,
      errorCode: payload.error || `http_${response.status}`,
    });
    throw error;
  }

  const createdRequestId = String(payload.requestId || '').trim();
  if (!createdRequestId) {
    throw new Error('Redeem request was created but request ID was missing.');
  }
  await finalizePlayerGameRequestAfterApi(createdRequestId, 'redeem');
  return {
    requestId: createdRequestId,
    request: buildCommittedRequest(createdRequestId, 'redeem'),
    ok: response.ok,
    status: response.status,
    duplicate: payload.duplicate === true,
    authority: payload.authority,
  };
}

export async function getPendingPlayerGameRequests(
  playerUids: string[]
): Promise<PlayerGameRequest[]> {
  if (playerUids.length === 0) {
    return [];
  }

  const allRequests = await Promise.all(
    playerUids.map((playerUid) =>
      // Include legacy poked plus review-needed requests so task sync can recover them.
      getRequestsByStatuses(playerUid, ['pending', 'poked', 'pending_review'])
    )
  );

  return sortByNewest(allRequests.flat());
}

export async function getCompletedPlayerGameRequests(
  playerUids: string[]
): Promise<PlayerGameRequest[]> {
  if (playerUids.length === 0) {
    return [];
  }

  const allRequests = await Promise.all(
    playerUids.map((playerUid) => getRequestsByStatuses(playerUid, ['completed']))
  );

  return sortByNewest(allRequests.flat());
}

export async function getPendingPlayerGameRequestsByCoadmin(
  coadminUid: string
): Promise<PlayerGameRequest[]> {
  return getRequestsByCoadminAndStatuses(coadminUid, [
    'pending',
    'poked',
    'pending_review',
  ]);
}

export async function getCompletedPlayerGameRequestsByCoadmin(
  coadminUid: string
): Promise<PlayerGameRequest[]> {
  return getRequestsByCoadminAndStatuses(coadminUid, ['completed']);
}

export function listenToPlayerGameRequestsByPlayer(
  playerUid: string,
  onChange: (requests: PlayerGameRequest[]) => void,
  onError?: (error: Error) => void
) {
  if (
    isClientSqlReadMode() ||
    assertClientFirestoreDisabled('player_game_requests_listener', 'onSnapshot', { playerUid })
  ) {
    logClientFirestoreSkipped('player_game_requests_listener', {
      file: 'features/games/playerGameRequests.ts',
      collection: 'playerGameRequests',
      operation: 'onSnapshot',
      playerUid,
    });
    onChange([]);
    return () => {};
  }

  const recentRequestsQuery = query(
    collection(db, 'playerGameRequests'),
    where('playerUid', '==', playerUid),
    orderBy('createdAt', 'desc'),
    limit(PLAYER_REQUEST_HISTORY_LISTENER_LIMIT)
  );
  const activeRequestsQuery = query(
    collection(db, 'playerGameRequests'),
    where('playerUid', '==', playerUid),
    where('status', 'in', PLAYER_REQUEST_ACTIVE_STATUSES)
  );
  let recentRequests: PlayerGameRequest[] = [];
  let activeRequests: PlayerGameRequest[] = [];

  const emitMergedRequests = () => {
    onChange(
      sortByNewest(
        Array.from(
          new Map(
            [...recentRequests, ...activeRequests].map((request) => [
              request.id,
              request,
            ])
          ).values()
        )
      )
    );
  };

  const unsubscribeRecent = onSnapshot(
    recentRequestsQuery,
    (snapshot) => {
      recentRequests = snapshot.docs.map((docSnap) =>
        mapRequestDoc(
          docSnap.id,
          docSnap.data() as Omit<PlayerGameRequest, 'id'>
        )
      );
      emitMergedRequests();
    },
    (error) => {
      onError?.(error as Error);
    }
  );

  const unsubscribeActive = onSnapshot(
    activeRequestsQuery,
    (snapshot) => {
      activeRequests = snapshot.docs.map((docSnap) =>
        mapRequestDoc(
          docSnap.id,
          docSnap.data() as Omit<PlayerGameRequest, 'id'>
        )
      );
      emitMergedRequests();
    },
    (error) => {
      onError?.(error as Error);
    }
  );

  return () => {
    unsubscribeRecent();
    unsubscribeActive();
  };
}

export async function markPlayerGameRequestDone(requestId: string) {
  await updateDoc(doc(db, 'playerGameRequests', requestId), {
    status: 'completed',
    completedAt: serverTimestamp(),
    ttlExpiresAt: completedPlayerGameRequestTtl(),
    pokedAt: null,
    pokeMessage: null,
  });
  const snap = await getDoc(doc(db, 'playerGameRequests', requestId));
  if (snap.exists()) {
    await upsertLinkedCarerTaskForRequest(
      mapRequestDoc(snap.id, snap.data() as Omit<PlayerGameRequest, 'id'>)
    );
  }
  void mirrorPlayerGameRequestCacheBestEffort(requestId);
}

export async function dismissPlayerRedeemRequest(requestId: string) {
  const currentUser = auth.currentUser;

  if (!currentUser) {
    throw new Error('Not authenticated.');
  }

  const requestRef = doc(db, 'playerGameRequests', requestId);
  const taskRef = doc(db, 'carerTasks', `request__${requestId}`);

  await runTransaction(db, async (transaction) => {
    const [requestSnap, taskSnap] = await Promise.all([
      transaction.get(requestRef),
      transaction.get(taskRef),
    ]);

    if (!requestSnap.exists()) {
      throw new Error('Request not found.');
    }

    const requestData = requestSnap.data() as Omit<PlayerGameRequest, 'id'>;

    if (requestData.playerUid !== currentUser.uid) {
      throw new Error('You can only dismiss your own request.');
    }

    if (requestData.type !== 'redeem') {
      throw new Error('Only redeem requests can be dismissed.');
    }

    if (requestData.status !== 'pending') {
      throw new Error('Only pending redeem requests can be dismissed.');
    }

    transaction.update(requestRef, {
      status: 'dismissed',
      completedAt: serverTimestamp(),
      ttlExpiresAt: completedPlayerGameRequestTtl(),
      pokedAt: null,
      pokeMessage: null,
    });

    if (taskSnap.exists()) {
      transaction.delete(taskRef);
    }
  });
  void mirrorPlayerGameRequestCacheBestEffort(requestId);
  void tombstoneLinkedCarerTaskCacheBestEffort(`request__${requestId}`);
}

/**
 * Carers may dismiss a pending redeem when it appears fraudulent or mistaken.
 * Marks the request dismissed and removes the linked carer task.
 */
export async function dismissPendingRedeemAsCarer(requestId: string) {
  const { isClientSqlReadMode } = await import('@/lib/client/sqlReadMode');
  const { getSqlApiReadHeaders } = await import('@/lib/client/sqlApiHeaders');
  const headers = isClientSqlReadMode()
    ? await getSqlApiReadHeaders(true)
    : await getFirebaseApiHeaders();
  if (isClientSqlReadMode()) {
    console.info('[CARER_TASK_ACTION_SQL_HEADERS]', {
      action: 'dismiss_redeem',
      route: '/api/carer/game-requests/dismiss-redeem',
      hasAppSessionId: true,
      authSource: 'app_session_sql',
      firebaseAttempted: false,
    });
  }
  const response = await fetch('/api/carer/game-requests/dismiss-redeem', {
    method: 'POST',
    headers,
    body: JSON.stringify({ requestId }),
  });
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    throw new Error(readApiError('Failed to dismiss redeem request.', payload));
  }
}

/**
 * Carers may dismiss a pending recharge manually when they decide to remove it.
 * Marks the request dismissed and removes the linked carer task.
 */
export type DismissRechargeAsCarerResult = {
  ok?: boolean;
  success?: boolean;
  duplicate?: boolean;
  alreadyDismissed?: boolean;
  alreadyHandled?: boolean;
  refunded?: boolean;
  taskDeleted?: boolean;
};

export async function dismissPendingRechargeAsCarer(
  requestId: string,
  context?: {
    taskId?: string | null;
    taskStatus?: string | null;
    amount?: number | null;
    playerUid?: string | null;
  }
): Promise<DismissRechargeAsCarerResult> {
  const { isClientSqlReadMode } = await import('@/lib/client/sqlReadMode');
  const { getSqlApiReadHeaders } = await import('@/lib/client/sqlApiHeaders');
  const headers = isClientSqlReadMode()
    ? await getSqlApiReadHeaders(true)
    : await getFirebaseApiHeaders();
  if (isClientSqlReadMode()) {
    console.info('[CARER_TASK_ACTION_SQL_HEADERS]', {
      action: 'dismiss_recharge',
      route: '/api/carer/game-requests/dismiss-recharge',
      hasAppSessionId: true,
      authSource: 'app_session_sql',
      firebaseAttempted: false,
    });
  }
  const response = await fetch('/api/carer/game-requests/dismiss-recharge', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      requestId,
      taskId: context?.taskId || null,
      taskStatus: context?.taskStatus || null,
      amount: context?.amount ?? null,
      playerUid: context?.playerUid || null,
    }),
  });
  const payload = (await response.json().catch(() => ({}))) as DismissRechargeAsCarerResult & {
    error?: string;
  };
  if (!response.ok) {
    const message = readApiError('Failed to dismiss recharge request.', payload);
    const normalized = message.toLowerCase();
    if (
      response.status === 400 ||
      response.status === 409 ||
      payload.alreadyHandled ||
      payload.alreadyDismissed
    ) {
      if (
        normalized.includes('not pending') ||
        normalized.includes('not found') ||
        normalized.includes('already')
      ) {
        return {
          ok: true,
          success: true,
          duplicate: true,
          alreadyDismissed: true,
          alreadyHandled: true,
          refunded: payload.refunded === true,
        };
      }
    }
    throw new Error(message);
  }
  return payload;
}
