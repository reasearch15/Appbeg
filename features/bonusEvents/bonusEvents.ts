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
  where,
} from 'firebase/firestore';

import { auth, db } from '@/lib/firebase/client';
import { recordBonusEventsListenerFirstSnapshot } from '@/features/dev/devUsageEstimates';
import { getCurrentUserCoadminUid } from '@/lib/coadmin/scope';
import { upsertCarerTaskForPlayerGameRequest } from '@/features/games/carerTasks';
import type { PlayerGameRequest } from '@/features/games/playerGameRequests';
import { getLocalAppSessionId } from '@/features/auth/appSession';
import {
  getLocalPlayerSessionId,
  ensurePlayerSessionGateReady,
  getPlayerApiHeaders,
  isPlayerSessionLoading,
  isPlayerSessionReady,
  logPlayerSessionReadyState,
  PLAYER_SESSION_LOADING_MESSAGE,
} from '@/features/auth/playerSession';
import { checkPlayerPollRole, createPlayerScopedPoll } from '@/lib/client/playerPollGuard';
import { playerDebugLog } from '@/lib/client/playerDebugLogs';
import {
  handleStalePlayerFetchError,
  isPlayerSessionStale,
} from '@/lib/client/playerStaleSession';
import { getCachedSessionUser, getSessionUserOnce } from '@/features/auth/sessionUser';
import { getStaffAppSessionApiHeaders, staffApiHeaderFlags } from '@/lib/client/staffApiHeaders';
import { assertClientFirestoreDisabled } from '@/lib/client/clientFirestoreGuard';
import { isClientSqlReadMode, logClientFirestoreSkipped } from '@/lib/client/sqlReadMode';

const BONUS_EVENTS_DEBUG =
  process.env.NODE_ENV !== 'production' &&
  process.env.NEXT_PUBLIC_DEBUG_BONUS_EVENTS === '1';

export type BonusEvent = {
  id: string;
  eventId?: string;
  event_id?: string;
  coadminUid: string;
  bonusName: string;
  gameName: string;
  amountNpr: number;
  amount?: number;
  description: string;
  bonusPercentage: number;
  bonus_percentage?: number;
  createdByUid: string;
  created_by?: string;
  createdByUsername: string;
  createdByRole: 'staff' | 'coadmin' | 'admin' | 'system';
  creator_role?: 'staff' | 'coadmin' | 'admin' | 'system';
  status?: 'active' | 'inactive';
  startDate?: Date | string | null;
  endDate?: Date | string | null;
  start_date?: Date | string | null;
  end_date?: Date | string | null;
  createdAt?: Date | string | null;
  created_at?: Date | string | null;
  updatedAt?: Date | string | null;
  updated_at?: Date | string | null;
};

function toBonusEvent(docId: string, value: Omit<BonusEvent, 'id'>): BonusEvent {
  const bonusPercentage = Number(
    (value as { bonusPercentage?: number; bonus_percentage?: number }).bonusPercentage ??
      (value as { bonusPercentage?: number; bonus_percentage?: number }).bonus_percentage ??
      0
  );
  const amountNpr = Number(
    (value as { amountNpr?: number; amount?: number }).amountNpr ??
      (value as { amountNpr?: number; amount?: number }).amount ??
      0
  );
  return {
    id: docId,
    ...value,
    bonusName: normalizeLegacyBonusName(String(value.bonusName || '')),
    bonusPercentage,
    bonus_percentage:
      (value as { bonus_percentage?: number }).bonus_percentage ?? bonusPercentage,
    amountNpr,
    amount: (value as { amount?: number }).amount ?? amountNpr,
    createdAt:
      (value as { createdAt?: Date | string | null; created_at?: Date | string | null }).createdAt ??
      (value as { createdAt?: Date | string | null; created_at?: Date | string | null }).created_at ??
      null,
  };
}

function toDateMs(value: unknown): number {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  const maybe = value as { toMillis?: () => number; toDate?: () => Date; seconds?: number };
  if (typeof maybe.toMillis === 'function') return maybe.toMillis();
  if (typeof maybe.toDate === 'function') return maybe.toDate().getTime();
  if (typeof maybe.seconds === 'number') return maybe.seconds * 1000;
  return 0;
}

function sortByNewest(list: BonusEvent[]) {
  return [...list].sort((left, right) => {
    const leftTime = toDateMs(left.createdAt);
    const rightTime = toDateMs(right.createdAt);
    return rightTime - leftTime;
  });
}

/** Newest bonus events shown on the player dashboard (up to 10). */
export const MAX_PLAYER_BONUS_EVENTS_DISPLAY = 10;
export const MAX_ACTIVE_BONUS_EVENTS = 20;
export const COADMIN_AUTO_BONUS_PERCENT_MIN = 5;
export const COADMIN_AUTO_BONUS_PERCENT_MAX = 30;

const COADMIN_MIN_PERCENT = 5;
const COADMIN_MAX_PERCENT = 10;
const COADMIN_MIN_AMOUNT = 10;
const COADMIN_MAX_AMOUNT = 50;
const MAX_GAME_LOGINS_READ = 100;
const AUTO_BONUS_NAMES = [
  'Friday Fever',
  'Lucky Streak',
  'High Roller Rush',
  'Hotshot Bonus',
  'Dollar Dash',
  'Jackpot Sprint',
  'Neon Nights Bonus',
  'Power Play Bonus',
  'Golden Ticket Drop',
  'Vegas Vibes',
  'Pocket Payday',
  'Prime Time Bonus',
  'Rocket Reward',
  'Cashwave Bonus',
  'Flash Fortune',
  'Rapid Reward',
  'Double Up Drop',
  'Crown Club Bonus',
  'Big Win Boost',
  'Main Event Bonus',
];
const LEGACY_AUTO_BONUS_NAMES = [
  'Freak Friday',
  'Hello Honee',
  'Mafia Boss',
  'Saduleeee',
  'Lucky Lassi',
  'Drama Dollar',
  'Paisa Pani',
  'Jhakaas Jackpot',
  'Bingo Bhoot',
  'Crazy Chiya',
  'Pocket Rocket',
  'No Tension Bonus',
  'Balle Balle',
  'Dhamaka Drop',
  'Laughter Loot',
  'Chill Pill Reward',
  'Pagal Paisa',
  'Momo Money',
  'Fatafat Fortune',
  'Boss Baby Bonus',
];
const LEGACY_BONUS_NAME_MAP = new Map(
  LEGACY_AUTO_BONUS_NAMES.map((legacyName, index) => [
    legacyName.toLowerCase(),
    AUTO_BONUS_NAMES[index % AUTO_BONUS_NAMES.length],
  ])
);

function normalizeLegacyBonusName(value: string) {
  const raw = String(value || '').trim();
  if (!raw) return raw;

  const lower = raw.toLowerCase();
  const direct = LEGACY_BONUS_NAME_MAP.get(lower);
  if (direct) return direct;

  const suffixMatch = raw.match(/^(.*?)(\s+\d+)$/);
  if (!suffixMatch) return raw;

  const base = suffixMatch[1].trim().toLowerCase();
  const suffix = suffixMatch[2];
  const mapped = LEGACY_BONUS_NAME_MAP.get(base);
  if (!mapped) return raw;
  return `${mapped}${suffix}`;
}

/**
 * All bonus events for the player’s coadmin (staff- or coadmin-created), newest first.
 * `listenBonusEventsByCoadmin` already scopes by coadmin — every player under that coadmin sees the same list.
 * Each doc is first-come-first-served: the first player to claim removes it (see `initiateBonusEventPlay`).
 */
export function getBonusEventsForPlayerDisplay(events: BonusEvent[]): BonusEvent[] {
  // Query already scopes to status=active; avoid local clock skew hiding valid server-active events.
  return sortByNewest(events).slice(0, MAX_PLAYER_BONUS_EVENTS_DISPLAY);
}

/** @deprecated Use {@link getBonusEventsForPlayerDisplay} — staff-only filter removed. */
export function getStaffBonusEventsForPlayerDisplay(events: BonusEvent[]) {
  return getBonusEventsForPlayerDisplay(events);
}

function normalizeDateMs(value: unknown): number {
  return toDateMs(value);
}

function normalizeStartDate(event: BonusEvent): number {
  return normalizeDateMs(event.startDate || event.start_date || null);
}

function normalizeEndDate(event: BonusEvent): number {
  return normalizeDateMs(event.endDate || event.end_date || null);
}

function isBonusEventActive(event: BonusEvent, nowMs: number = Date.now()): boolean {
  const status = String(event.status || 'active').toLowerCase();
  if (status !== 'active') return false;
  const startMs = normalizeStartDate(event);
  const endMs = normalizeEndDate(event);
  if (startMs > 0 && nowMs < startMs) return false;
  if (endMs > 0 && nowMs > endMs) return false;
  return true;
}

function makeActiveDuplicateKey(values: {
  bonusName: string;
  gameName: string;
  amountNpr: number;
  bonusPercentage: number;
}) {
  return [
    values.bonusName.trim().toLowerCase(),
    values.gameName.trim().toLowerCase(),
    Math.round(values.amountNpr),
    Math.round(values.bonusPercentage),
  ].join('__');
}

function randomInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomPercentInRange(min: number, max: number) {
  const safeMin = Number.isFinite(min) ? min : COADMIN_MIN_PERCENT;
  const safeMax = Number.isFinite(max) ? max : COADMIN_MAX_PERCENT;
  const low = Math.min(safeMin, safeMax);
  const high = Math.max(safeMin, safeMax);
  if (low === high) return Number(low.toFixed(2));
  const raw = Math.random() * (high - low) + low;
  return Number(raw.toFixed(2));
}

function buildActiveBonusEventsQuery(coadminUid: string, maxResults: number = MAX_ACTIVE_BONUS_EVENTS) {
  return query(
    collection(db, 'bonusEvents'),
    where('coadminUid', '==', coadminUid),
    where('status', '==', 'active'),
    orderBy('createdAt', 'desc'),
    limit(maxResults)
  );
}

function normalizeAutoBonusPercentRange(values: {
  minPercent?: number | null;
  maxPercent?: number | null;
}) {
  const rawMin = Number(values.minPercent);
  const rawMax = Number(values.maxPercent);
  const fallbackMin = COADMIN_MIN_PERCENT;
  const fallbackMax = COADMIN_MAX_PERCENT;

  const minPercent = Number.isFinite(rawMin)
    ? Math.round(rawMin)
    : fallbackMin;
  const maxPercent = Number.isFinite(rawMax)
    ? Math.round(rawMax)
    : fallbackMax;

  const boundedMin = Math.min(
    COADMIN_AUTO_BONUS_PERCENT_MAX,
    Math.max(COADMIN_AUTO_BONUS_PERCENT_MIN, minPercent)
  );
  const boundedMax = Math.min(
    COADMIN_AUTO_BONUS_PERCENT_MAX,
    Math.max(COADMIN_AUTO_BONUS_PERCENT_MIN, maxPercent)
  );

  return {
    minPercent: Math.min(boundedMin, boundedMax),
    maxPercent: Math.max(boundedMin, boundedMax),
  };
}

async function fetchCoadminAutoBonusPercentRangeFromApi(coadminUid: string) {
  const url = `/api/coadmin/bonus-events/cache?coadminUid=${encodeURIComponent(coadminUid)}`;
  const headers = await getCoadminBonusApiHeaders(false);
  logBonusEventsUiRequest({
    action: 'fetch_auto_bonus_range',
    page: 'coadmin_bonus_events',
    coadminUid,
    url,
    headers,
  });
  const response = await fetch(url, {
    method: 'GET',
    headers,
    cache: 'no-store',
  });
  const payload = (await response.json().catch(() => ({}))) as {
    autoBonusPercentRange?: { minPercent?: number; maxPercent?: number };
    error?: string;
  };
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to load auto-created bonus range.');
  }
  return normalizeAutoBonusPercentRange(payload.autoBonusPercentRange || {});
}

export async function getCoadminAutoBonusPercentRange(coadminUid: string) {
  if (isClientSqlReadMode()) {
    logClientFirestoreSkipped('coadmin_auto_bonus_percent_range', { coadminUid });
    return fetchCoadminAutoBonusPercentRangeFromApi(coadminUid);
  }

  const userSnap = await getDoc(doc(db, 'users', coadminUid));
  if (!userSnap.exists()) {
    return normalizeAutoBonusPercentRange({});
  }

  const userData = userSnap.data() as {
    autoBonusEventMinPercent?: number;
    autoBonusEventMaxPercent?: number;
  };

  return normalizeAutoBonusPercentRange({
    minPercent: userData.autoBonusEventMinPercent,
    maxPercent: userData.autoBonusEventMaxPercent,
  });
}

function pickFunnyBonusName(usedNames: Set<string>, fallbackIndex: number) {
  const shuffled = [...AUTO_BONUS_NAMES].sort(() => Math.random() - 0.5);
  for (const candidate of shuffled) {
    const key = candidate.trim().toLowerCase();
    if (!usedNames.has(key)) {
      usedNames.add(key);
      return candidate;
    }
  }
  const fallback = `${AUTO_BONUS_NAMES[fallbackIndex % AUTO_BONUS_NAMES.length]} ${fallbackIndex}`;
  usedNames.add(fallback.toLowerCase());
  return fallback;
}

async function getCoadminGameNamesFromApi(coadminUid: string): Promise<string[]> {
  const url = `/api/game-logins/cache?coadminUid=${encodeURIComponent(coadminUid)}`;
  const headers = await getCoadminBonusApiHeaders(false);
  logBonusEventsUiRequest({
    action: 'fetch_game_logins_cache',
    page: 'coadmin_bonus_events',
    coadminUid,
    url,
    headers,
  });
  const response = await fetch(url, {
    method: 'GET',
    headers,
    cache: 'no-store',
  });
  const payload = (await response.json().catch(() => ({}))) as {
    gameLogins?: Array<{ gameName?: string }>;
  };
  if (!response.ok) {
    return [];
  }
  return Array.from(
    new Set(
      (payload.gameLogins || [])
        .map((entry) => String(entry.gameName || '').trim())
        .filter(Boolean)
    )
  );
}

async function getCoadminGameNames(coadminUid: string): Promise<string[]> {
  if (isClientSqlReadMode()) {
    logClientFirestoreSkipped('coadmin_game_names', { coadminUid });
    return getCoadminGameNamesFromApi(coadminUid);
  }

  const [coadminOwned, legacyOwned] = await Promise.all([
    getDocs(
      query(
        collection(db, 'gameLogins'),
        where('coadminUid', '==', coadminUid),
        limit(MAX_GAME_LOGINS_READ)
      )
    ),
    getDocs(
      query(
        collection(db, 'gameLogins'),
        where('createdBy', '==', coadminUid),
        limit(MAX_GAME_LOGINS_READ)
      )
    ),
  ]);

  const names = new Set<string>();
  [...coadminOwned.docs, ...legacyOwned.docs].forEach((docSnap) => {
    const data = docSnap.data() as { gameName?: string };
    const name = String(data.gameName || '').trim();
    if (name) names.add(name);
  });
  return [...names];
}

export async function createBonusEvent(values: {
  bonusName: string;
  gameName: string;
  amountNpr: number;
  description: string;
  bonusPercentage: number;
}) {
  const sessionUser = getCachedSessionUser() || (await getSessionUserOnce().catch(() => null));
  const actorUid = sessionUser?.uid || auth.currentUser?.uid;
  if (!actorUid) {
    throw new Error('Not authenticated.');
  }

  const bonusName = values.bonusName.trim();
  const gameName = values.gameName.trim();
  const rawAmount = Number(values.amountNpr);
  const amountNpr = Math.round(rawAmount);
  const description = values.description.trim();
  const rawBonusPercentage = Number(values.bonusPercentage);
  const bonusPercentage = Math.round(rawBonusPercentage);

  if (!bonusName) {
    throw new Error('Bonus name is required.');
  }

  if (!description) {
    throw new Error('Description is required.');
  }

  if (!gameName) {
    throw new Error('Game name is required.');
  }

  if (!Number.isFinite(rawAmount)) {
    throw new Error('Amount must be numeric.');
  }

  if (amountNpr <= 0) {
    throw new Error('Amount must be greater than zero.');
  }

  if (!Number.isFinite(rawBonusPercentage)) {
    throw new Error('Bonus percentage must be numeric.');
  }

  if (bonusPercentage <= 0) {
    throw new Error('Bonus percentage must be greater than zero.');
  }

  if (bonusPercentage > 50) {
    throw new Error('Bonus percentage cannot be more than 50%.');
  }

  const userSnap = isClientSqlReadMode()
    ? null
    : await getDoc(doc(db, 'users', actorUid));

  let username = sessionUser?.username || 'User';
  let role = String(sessionUser?.role || '').toLowerCase();

  if (userSnap?.exists()) {
    const userData = userSnap.data() as { username?: string; role?: string };
    username = String(userData.username || username);
    role = String(userData.role || role).toLowerCase();
  } else if (!role) {
    throw new Error('Current user profile not found.');
  }

  if (role !== 'staff' && role !== 'coadmin') {
    throw new Error('Only staff and coadmin can create bonus events.');
  }

  if (role === 'coadmin') {
    if (bonusPercentage > COADMIN_MAX_PERCENT) {
      throw new Error('Co-admin bonus percentage cannot exceed 10%.');
    }
    if (bonusPercentage < COADMIN_MIN_PERCENT) {
      throw new Error('Co-admin bonus percentage must be between 5 and 10.');
    }
    if (amountNpr < COADMIN_MIN_AMOUNT || amountNpr > COADMIN_MAX_AMOUNT) {
      throw new Error('Co-admin bonus amount must be between 10 and 50.');
    }
  }

  const coadminUid = await getCurrentUserCoadminUid();
  const allSnap = await getDocs(buildActiveBonusEventsQuery(coadminUid));
  const allEvents = allSnap.docs.map((docSnap) =>
    toBonusEvent(docSnap.id, docSnap.data() as Omit<BonusEvent, 'id'>)
  );
  const activeEvents = allEvents.filter((event) => isBonusEventActive(event));
  if (activeEvents.length >= MAX_ACTIVE_BONUS_EVENTS) {
    throw new Error('Bonus event limit reached. Maximum 20 active events allowed.');
  }

  const duplicateKey = makeActiveDuplicateKey({
    bonusName,
    gameName,
    amountNpr,
    bonusPercentage,
  });
  const existingKeys = new Set(
    activeEvents.map((event) =>
      makeActiveDuplicateKey({
        bonusName: event.bonusName,
        gameName: event.gameName,
        amountNpr: Number(event.amountNpr || event.amount || 0),
        bonusPercentage: Number(event.bonusPercentage || event.bonus_percentage || 0),
      })
    )
  );
  if (existingKeys.has(duplicateKey)) {
    throw new Error('Duplicate active bonus event already exists.');
  }

  const now = new Date();
  const end = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const baseDoc = {
    coadminUid,
    bonusName,
    gameName,
    amountNpr,
    amount: amountNpr,
    description,
    bonusPercentage,
    bonus_percentage: bonusPercentage,
    createdByUid: actorUid,
    created_by: actorUid,
    createdByUsername: username.trim() || 'User',
    createdByRole: role as BonusEvent['createdByRole'],
    creator_role: role as BonusEvent['createdByRole'],
    status: 'active' as const,
    startDate: now,
    endDate: end,
    start_date: now,
    end_date: end,
    createdAt: serverTimestamp(),
    created_at: serverTimestamp(),
    updatedAt: serverTimestamp(),
    updated_at: serverTimestamp(),
  };
  const manualRef = doc(collection(db, 'bonusEvents'));
  await setDoc(manualRef, {
    ...baseDoc,
    eventId: manualRef.id,
    event_id: manualRef.id,
  });

  console.info('[bonusEvents] createBonusEvent', {
    byUid: actorUid,
    role,
    coadminUid,
    manualEventId: manualRef.id,
  });

  return {
    createdEventId: manualRef.id,
    autoCreatedCount: 0,
  };
}

export async function ensureCoadminActiveBonusEventsFilled(options?: {
  coadminUid?: string;
  createdByUid?: string;
  createdByUsername?: string;
  creatorRole?: 'coadmin' | 'system';
}) {
  const currentUser = auth.currentUser;
  if (!currentUser && !options?.createdByUid) {
    throw new Error('Not authenticated.');
  }

  const coadminUid = options?.coadminUid || (await getCurrentUserCoadminUid());
  const createdByUid = options?.createdByUid || currentUser?.uid || 'system';
  const createdByUsername = options?.createdByUsername || 'Coadmin';
  const creatorRole = options?.creatorRole || 'coadmin';
  const autoBonusPercentRange = await getCoadminAutoBonusPercentRange(coadminUid);

  const allSnap = await getDocs(buildActiveBonusEventsQuery(coadminUid));
  const allEvents = allSnap.docs.map((docSnap) =>
    toBonusEvent(docSnap.id, docSnap.data() as Omit<BonusEvent, 'id'>)
  );
  const activeEvents = allEvents.filter((event) => isBonusEventActive(event));
  if (activeEvents.length >= MAX_ACTIVE_BONUS_EVENTS) {
    return { autoCreatedCount: 0, totalActive: activeEvents.length };
  }

  const existingKeys = new Set(
    activeEvents.map((event) =>
      makeActiveDuplicateKey({
        bonusName: event.bonusName,
        gameName: event.gameName,
        amountNpr: Number(event.amountNpr || event.amount || 0),
        bonusPercentage: Number(event.bonusPercentage || event.bonus_percentage || 0),
      })
    )
  );
  const usedNames = new Set(activeEvents.map((event) => String(event.bonusName || '').trim().toLowerCase()));
  const coadminGameNames = await getCoadminGameNames(coadminUid);
  const pickGameName = () =>
    coadminGameNames.length > 0
      ? coadminGameNames[randomInt(0, coadminGameNames.length - 1)]
      : 'Bonus Table';

  const now = new Date();
  const end = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const missing = MAX_ACTIVE_BONUS_EVENTS - activeEvents.length;
  let autoCreatedCount = 0;
  let attempts = 0;

  while (autoCreatedCount < missing && attempts < missing * 25) {
    attempts += 1;
    const autoAmount = randomInt(COADMIN_MIN_AMOUNT, COADMIN_MAX_AMOUNT);
    const autoPercent = randomPercentInRange(
      autoBonusPercentRange.minPercent,
      autoBonusPercentRange.maxPercent
    );
    const autoGame = pickGameName();
    const autoName = pickFunnyBonusName(usedNames, attempts);
    const key = makeActiveDuplicateKey({
      bonusName: autoName,
      gameName: autoGame,
      amountNpr: autoAmount,
      bonusPercentage: autoPercent,
    });
    if (existingKeys.has(key)) {
      continue;
    }

    const autoRef = doc(collection(db, 'bonusEvents'));
    await setDoc(autoRef, {
      coadminUid,
      bonusName: autoName,
      gameName: autoGame,
      amountNpr: autoAmount,
      amount: autoAmount,
      description: 'Auto-generated co-admin bonus event to maintain active event capacity.',
      bonusPercentage: autoPercent,
      bonus_percentage: autoPercent,
      createdByUid,
      created_by: createdByUid,
      createdByUsername,
      createdByRole: creatorRole === 'system' ? 'coadmin' : creatorRole,
      creator_role: creatorRole,
      status: 'active',
      startDate: now,
      endDate: end,
      start_date: now,
      end_date: end,
      createdAt: serverTimestamp(),
      created_at: serverTimestamp(),
      updatedAt: serverTimestamp(),
      updated_at: serverTimestamp(),
      eventId: autoRef.id,
      event_id: autoRef.id,
      autoGenerated: true,
    });
    existingKeys.add(key);
    autoCreatedCount += 1;
  }

  console.info('[bonusEvents] ensureCoadminActiveBonusEventsFilled', {
    coadminUid,
    autoCreatedCount,
    totalActiveAfter: activeEvents.length + autoCreatedCount,
  });

  return {
    autoCreatedCount,
    totalActive: activeEvents.length + autoCreatedCount,
  };
}

export async function setCoadminAutoBonusPercentRange(values: {
  minPercent: number;
  maxPercent: number;
}) {
  const sessionUser = getCachedSessionUser() || (await getSessionUserOnce().catch(() => null));
  const role = String(sessionUser?.role || '').toLowerCase();
  if (role !== 'coadmin') {
    throw new Error('Only coadmin can change auto-created bonus ranges.');
  }

  const normalizedRange = normalizeAutoBonusPercentRange(values);
  const url = '/api/coadmin/bonus-events/update-range';
  const headers = await getCoadminBonusApiHeaders();
  logBonusEventsUiRequest({
    action: 'update_auto_bonus_range',
    page: 'coadmin_bonus_events',
    coadminUid: sessionUser?.uid || null,
    url,
    headers,
  });
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      minPercent: normalizedRange.minPercent,
      maxPercent: normalizedRange.maxPercent,
    }),
  });
  const data = (await response.json()) as {
    minPercent?: number;
    maxPercent?: number;
    adjustedEventCount?: number;
    error?: string;
    skipped?: string;
  };
  if (!response.ok) {
    throw new Error(data.error || 'Failed to save auto-created bonus range.');
  }
  return {
    minPercent: Number(data.minPercent ?? normalizedRange.minPercent),
    maxPercent: Number(data.maxPercent ?? normalizedRange.maxPercent),
    adjustedEventCount: Number(data.adjustedEventCount || 0),
    skipped: data.skipped || null,
  };
}

const BONUS_EVENTS_SQL_POLL_MS = 15_000;

function mapApiBonusEvent(event: Record<string, unknown>): BonusEvent {
  const bonusPercentage = Number(event.bonusPercentage ?? event.bonus_percentage ?? 0);
  const amountNpr = Number(event.amountNpr ?? event.amount ?? 0);
  return {
    id: String(event.id || ''),
    ...event,
    bonusName: normalizeLegacyBonusName(String(event.bonusName || '')),
    bonusPercentage,
    bonus_percentage: bonusPercentage,
    amountNpr,
    amount: amountNpr,
    createdAt: (event.createdAt as Date | string | null | undefined) ?? null,
    created_at: (event.created_at as Date | string | null | undefined) ?? null,
  } as BonusEvent;
}

export function logBonusEventsUiGuard(values: {
  page: string;
  reason: string;
  message?: string;
  blocked?: boolean;
  coadminUid?: string | null;
  isCoadminView?: boolean;
  isPlayerView?: boolean;
}) {
  const cached = getCachedSessionUser();
  const currentUser = auth.currentUser;
  console.info('[BONUS_EVENTS_UI_GUARD]', {
    page: values.page,
    role: cached?.role || null,
    uid: cached?.uid || currentUser?.uid || null,
    coadminUid:
      values.coadminUid ??
      (cached?.role === 'coadmin' ? cached.uid : cached?.coadminUid ?? null),
    hasAppSessionId: Boolean(getLocalAppSessionId()),
    hasPlayerSessionId: Boolean(getLocalPlayerSessionId()),
    isCoadminView: values.isCoadminView ?? true,
    isPlayerView: values.isPlayerView ?? false,
    blocked: values.blocked ?? true,
    reason: values.reason,
    message: values.message ?? values.reason,
  });
}

export function logBonusEventsUiRequest(values: {
  action: string;
  page: string;
  url: string;
  role?: string | null;
  uid?: string | null;
  coadminUid?: string | null;
  isCoadminView?: boolean;
  isPlayerView?: boolean;
  headers?: Record<string, string>;
}) {
  const cached = getCachedSessionUser();
  const headerFlags = values.headers
    ? staffApiHeaderFlags(values.headers)
    : {
        hasAppSessionId: Boolean(getLocalAppSessionId()),
        hasPlayerSessionId: Boolean(getLocalPlayerSessionId()),
        usesAuthorizationHeader: Boolean(auth.currentUser),
        usesPlayerSessionHeader: Boolean(getLocalPlayerSessionId()),
      };
  console.info('[BONUS_EVENTS_UI_REQUEST]', {
    action: values.action,
    page: values.page,
    role: values.role ?? cached?.role ?? null,
    uid: values.uid ?? cached?.uid ?? auth.currentUser?.uid ?? null,
    coadminUid: values.coadminUid ?? null,
    isCoadminView: values.isCoadminView ?? true,
    isPlayerView: values.isPlayerView ?? false,
    hasAppSessionId: headerFlags.hasAppSessionId,
    hasPlayerSessionId: headerFlags.hasPlayerSessionId,
    usesAuthorizationHeader: headerFlags.usesAuthorizationHeader,
    usesPlayerSessionHeader: headerFlags.usesPlayerSessionHeader,
    url: values.url,
  });
}

/** Coadmin/admin bonus management: app session only (no player session). */
export async function getCoadminBonusApiHeaders(contentType = false) {
  return getStaffAppSessionApiHeaders(contentType);
}

function sessionIdPrefix(value: string | null | undefined) {
  const clean = String(value || '').trim();
  return clean ? clean.slice(0, 8) : null;
}

function isPlayerBonusSessionError(message: string) {
  return /X-Player-Session-Id header is required|Player session required|player session not ready|Loading secure session|Loading session|Not authenticated/i.test(
    message
  );
}

async function resolvePlayerBonusRequestContext() {
  const cached = getCachedSessionUser();
  if (cached?.role === 'player') {
    return { role: cached.role, uid: cached.uid };
  }
  const fetched = await getSessionUserOnce().catch(() => null);
  return {
    role: fetched?.role ?? cached?.role ?? null,
    uid: fetched?.uid ?? cached?.uid ?? auth.currentUser?.uid ?? null,
  };
}

export function logPlayerBonusRequestHeaders(values: {
  action: string;
  url: string;
  method: string;
  role: string | null;
  uid: string | null;
  hasAppSessionId: boolean;
  hasPlayerSessionId: boolean;
  appSessionIdPrefix: string | null;
  playerSessionIdPrefix: string | null;
  headersSent: string[];
  blocked: boolean;
  reason: string;
}) {
  playerDebugLog('[PLAYER_BONUS_REQUEST_HEADERS]', values);
}

/** @deprecated Use logPlayerBonusRequestHeaders */
export function logPlayerBonusApiRequest(values: {
  action: string;
  url: string;
  hasAppSessionId: boolean;
  hasPlayerSessionId: boolean;
  appSessionIdPrefix: string | null;
  playerSessionIdPrefix: string | null;
  blocked: boolean;
  reason: string;
}) {
  logPlayerBonusRequestHeaders({
    action: values.action,
    url: values.url,
    method: values.action.includes('initiate') ? 'POST' : 'GET',
    role: getCachedSessionUser()?.role ?? null,
    uid: getCachedSessionUser()?.uid ?? auth.currentUser?.uid ?? null,
    hasAppSessionId: values.hasAppSessionId,
    hasPlayerSessionId: values.hasPlayerSessionId,
    appSessionIdPrefix: values.appSessionIdPrefix,
    playerSessionIdPrefix: values.playerSessionIdPrefix,
    headersSent: [],
    blocked: values.blocked,
    reason: values.reason,
  });
}

async function getBonusEventsListHeaders(isPlayerView: boolean) {
  if (isPlayerView) {
    return getPlayerApiHeaders(false, { route: '/api/bonus-events/list' });
  }
  return getCoadminBonusApiHeaders(false);
}

type FetchBonusEventsOptions = {
  skipTimeWindowFilter?: boolean;
  isPlayerView?: boolean;
  onSessionLoading?: (loading: boolean) => void;
  onActiveFilterEmpty?: () => void;
};

async function fetchBonusEventsFromApi(
  coadminUid: string,
  options?: FetchBonusEventsOptions
) {
  const isPlayerView = options?.isPlayerView ?? false;
  const url = `/api/bonus-events/list?coadminUid=${encodeURIComponent(coadminUid)}`;
  playerDebugLog('[BONUS_FETCH_START]', { coadminUid, isPlayerView, url });
  const requestContext = isPlayerView ? await resolvePlayerBonusRequestContext() : { role: null, uid: null };

  if (isPlayerView) {
    const appSessionId = getLocalAppSessionId();
    const playerSessionId = getLocalPlayerSessionId();
    logPlayerSessionReadyState({
      source: 'fetchBonusEventsFromApi:before_gate',
      sessionReady: isPlayerSessionReady(),
      loading: isPlayerSessionLoading(),
    });

    const gate = await ensurePlayerSessionGateReady({
      source: 'fetchBonusEventsFromApi',
    });

    logPlayerSessionReadyState({
      source: 'fetchBonusEventsFromApi:after_gate',
      sessionReady: gate.state === 'ready',
      loading: gate.state === 'loading',
    });

    if (gate.state === 'loading') {
      logPlayerBonusRequestHeaders({
        action: 'list_bonus_events',
        url,
        method: 'GET',
        role: requestContext.role,
        uid: requestContext.uid,
        hasAppSessionId: Boolean(appSessionId || getLocalAppSessionId()),
        hasPlayerSessionId: Boolean(playerSessionId || getLocalPlayerSessionId()),
        appSessionIdPrefix: sessionIdPrefix(appSessionId || getLocalAppSessionId()),
        playerSessionIdPrefix: sessionIdPrefix(playerSessionId || getLocalPlayerSessionId()),
        headersSent: [],
        blocked: true,
        reason: gate.reason || 'player_session_loading',
      });
      playerDebugLog('[PLAYER_BONUS_SESSION_LOADING]', {
        reason: gate.reason || 'player_session_loading',
        coadminUid,
      });
      options?.onSessionLoading?.(true);
      return null;
    }

    if (gate.state === 'failed') {
      logPlayerBonusRequestHeaders({
        action: 'list_bonus_events',
        url,
        method: 'GET',
        role: requestContext.role,
        uid: requestContext.uid,
        hasAppSessionId: Boolean(getLocalAppSessionId()),
        hasPlayerSessionId: Boolean(getLocalPlayerSessionId()),
        appSessionIdPrefix: sessionIdPrefix(getLocalAppSessionId()),
        playerSessionIdPrefix: sessionIdPrefix(getLocalPlayerSessionId()),
        headersSent: [],
        blocked: true,
        reason: gate.reason,
      });
      playerDebugLog('[PLAYER_BONUS_SESSION_LOADING]', {
        reason: gate.reason || 'player_session_failed',
        coadminUid,
      });
      options?.onSessionLoading?.(true);
      return null;
    }
  }

  options?.onSessionLoading?.(false);

  try {
    const headers = await getBonusEventsListHeaders(isPlayerView);
    if (isPlayerView) {
      logPlayerBonusRequestHeaders({
        action: 'list_bonus_events',
        url,
        method: 'GET',
        role: requestContext.role,
        uid: requestContext.uid,
        hasAppSessionId: Boolean(headers['X-App-Session-Id']),
        hasPlayerSessionId: Boolean(headers['X-Player-Session-Id']),
        appSessionIdPrefix: sessionIdPrefix(headers['X-App-Session-Id']),
        playerSessionIdPrefix: sessionIdPrefix(headers['X-Player-Session-Id']),
        headersSent: Object.keys(headers),
        blocked: false,
        reason: 'request',
      });
    } else {
      logBonusEventsUiRequest({
        action: 'list_bonus_events',
        page: 'coadmin_bonus_events',
        coadminUid,
        url,
        headers,
        isCoadminView: true,
        isPlayerView: false,
      });
    }
    const response = await fetch(url, {
      method: 'GET',
      headers,
      cache: 'no-store',
    });
    const payload = (await response.json().catch(() => ({}))) as {
      events?: Array<Record<string, unknown>>;
      error?: string;
      filterReason?: string;
    };
    if (!response.ok) {
      const reason = payload.error || `http_${response.status}`;
      if (isPlayerView) {
        logPlayerBonusRequestHeaders({
          action: 'list_bonus_events',
          url,
          method: 'GET',
          role: requestContext.role,
          uid: requestContext.uid,
          hasAppSessionId: Boolean(headers['X-App-Session-Id']),
          hasPlayerSessionId: Boolean(headers['X-Player-Session-Id']),
          appSessionIdPrefix: sessionIdPrefix(headers['X-App-Session-Id']),
          playerSessionIdPrefix: sessionIdPrefix(headers['X-Player-Session-Id']),
          headersSent: Object.keys(headers),
          blocked: true,
          reason,
        });
        if (isPlayerBonusSessionError(reason)) {
          playerDebugLog('[PLAYER_BONUS_SESSION_LOADING]', { reason, coadminUid });
          options?.onSessionLoading?.(true);
          return null;
        }
      } else {
        logBonusEventsUiGuard({
          page: 'coadmin_bonus_events_list',
          reason,
          message: payload.error || reason,
          blocked: true,
          coadminUid,
          isCoadminView: true,
          isPlayerView: false,
        });
      }
      throw new Error(payload.error || 'Failed to load bonus events.');
    }
    options?.onSessionLoading?.(false);
    const events = (payload.events || []).map(mapApiBonusEvent);
    const filtered = options?.skipTimeWindowFilter
      ? sortByNewest(events)
      : sortByNewest(events).filter((event) => isBonusEventActive(event));
    if (!isPlayerView && payload.filterReason === 'active_filter_empty') {
      options?.onActiveFilterEmpty?.();
    }
    if (isPlayerView && filtered.length === 0) {
      playerDebugLog('[PLAYER_BONUS_LOADED_EMPTY]', {
        coadminUid,
        apiCount: events.length,
        filterReason: payload.filterReason || null,
      });
    }
    playerDebugLog('[BONUS_FETCH_RESPONSE]', {
      coadminUid,
      isPlayerView,
      status: response.status,
      apiEventCount: events.length,
      filteredEventCount: filtered.length,
      filterReason: payload.filterReason || null,
    });
    return filtered;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isPlayerView && isPlayerBonusSessionError(message)) {
      logPlayerBonusRequestHeaders({
        action: 'list_bonus_events',
        url,
        method: 'GET',
        role: requestContext.role,
        uid: requestContext.uid,
        hasAppSessionId: Boolean(getLocalAppSessionId()),
        hasPlayerSessionId: Boolean(getLocalPlayerSessionId()),
        appSessionIdPrefix: sessionIdPrefix(getLocalAppSessionId()),
        playerSessionIdPrefix: sessionIdPrefix(getLocalPlayerSessionId()),
        headersSent: [],
        blocked: true,
        reason: message,
      });
      playerDebugLog('[PLAYER_BONUS_SESSION_LOADING]', { reason: message, coadminUid });
      options?.onSessionLoading?.(true);
      return null;
    }
    if (!isPlayerView && message.includes('Player session required')) {
      logBonusEventsUiGuard({
        page: 'coadmin_bonus_events_list',
        reason: 'player_session_required_blocked_on_coadmin_view',
        message,
        blocked: true,
        coadminUid,
        isCoadminView: true,
        isPlayerView: false,
      });
    }
    throw error instanceof Error ? error : new Error(message);
  }
}

export function listenBonusEventsByCoadmin(
  coadminUid: string,
  onChange: (events: BonusEvent[]) => void,
  onError?: (error: Error) => void,
  options?: {
    skipTimeWindowFilter?: boolean;
    isPlayerView?: boolean;
    onSessionLoading?: (loading: boolean) => void;
    onActiveFilterEmpty?: () => void;
    onSnapshotDebug?: (values: {
      snapshotSize: number;
      firstDocData: Record<string, unknown> | null;
    }) => void;
  }
) {
  if (!coadminUid.trim()) {
    onChange([]);
    return () => {};
  }

  if (isClientSqlReadMode()) {
    logClientFirestoreSkipped('bonus_events_by_coadmin', { coadminUid });
    let recordedFirstSnapshot = false;

    const handleTickError = (error: Error) => {
      if (options?.isPlayerView) {
        if (handleStalePlayerFetchError('player_bonus_events', error)) {
          return;
        }
        logPlayerBonusRequestHeaders({
          action: 'list_bonus_events',
          url: `/api/bonus-events/list?coadminUid=${encodeURIComponent(coadminUid)}`,
          method: 'GET',
          role: getCachedSessionUser()?.role ?? null,
          uid: getCachedSessionUser()?.uid ?? auth.currentUser?.uid ?? null,
          hasAppSessionId: Boolean(getLocalAppSessionId()),
          hasPlayerSessionId: Boolean(getLocalPlayerSessionId()),
          appSessionIdPrefix: sessionIdPrefix(getLocalAppSessionId()),
          playerSessionIdPrefix: sessionIdPrefix(getLocalPlayerSessionId()),
          headersSent: [],
          blocked: true,
          reason: error.message,
        });
        if (isPlayerBonusSessionError(error.message) || isPlayerSessionStale()) {
          playerDebugLog('[PLAYER_BONUS_SESSION_LOADING]', {
            reason: error.message,
            coadminUid,
          });
          options?.onSessionLoading?.(true);
          return;
        }
      } else {
        logBonusEventsUiGuard({
          page: 'coadmin_bonus_events_listener',
          reason: error.message,
          message: error.message,
          blocked: true,
          coadminUid,
          isCoadminView: true,
          isPlayerView: false,
        });
      }
      onError?.(error);
    };

    const runTick = async () => {
      const events = await fetchBonusEventsFromApi(coadminUid, options);
      if (events === null) {
        return;
      }
      if (!recordedFirstSnapshot) {
        recordedFirstSnapshot = true;
        recordBonusEventsListenerFirstSnapshot(events.length);
      }
      const firstDocData = events[0] ? (events[0] as unknown as Record<string, unknown>) : null;
      options?.onSnapshotDebug?.({
        snapshotSize: events.length,
        firstDocData,
      });
      if (BONUS_EVENTS_DEBUG) {
        console.info('[bonusEvents] sql-poll:snapshot', {
          coadminUid,
          snapshotSize: events.length,
          skipTimeWindowFilter: Boolean(options?.skipTimeWindowFilter),
        });
      }
      onChange(events);
    };

    if (BONUS_EVENTS_DEBUG) {
      console.info('[bonusEvents] sql-poll:start', { coadminUid });
    }

    if (options?.isPlayerView) {
      return createPlayerScopedPoll({
        pollName: 'player_bonus_events',
        intervalMs: BONUS_EVENTS_SQL_POLL_MS,
        summaryRoute: '/api/bonus-events/list',
        onTick: runTick,
        onError: handleTickError,
      });
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled) {
        return;
      }
      try {
        await runTick();
      } catch (error) {
        if (!cancelled) {
          handleTickError(error instanceof Error ? error : new Error(String(error)));
        }
      } finally {
        if (!cancelled) {
          timer = setTimeout(() => void tick(), BONUS_EVENTS_SQL_POLL_MS);
        }
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer != null) {
        clearTimeout(timer);
        timer = null;
      }
      if (BONUS_EVENTS_DEBUG) {
        console.info('[bonusEvents] sql-poll:stop', { coadminUid });
      }
    };
  }

  if (assertClientFirestoreDisabled('bonus_events_by_coadmin', 'onSnapshot', { coadminUid })) {
    onChange([]);
    return () => {};
  }

  let recordedFirstSnapshot = false;
  if (BONUS_EVENTS_DEBUG) {
    console.info('[bonusEvents] listener:start', { coadminUid, limit: MAX_ACTIVE_BONUS_EVENTS });
  }
  const unsubscribe = onSnapshot(
    buildActiveBonusEventsQuery(coadminUid),
    (snapshot) => {
      if (!recordedFirstSnapshot) {
        recordedFirstSnapshot = true;
        recordBonusEventsListenerFirstSnapshot(snapshot.size);
      }
      const events = snapshot.docs.map((docSnap) =>
        toBonusEvent(docSnap.id, docSnap.data() as Omit<BonusEvent, 'id'>)
      );
      const activeEvents = options?.skipTimeWindowFilter
        ? sortByNewest(events)
        : sortByNewest(events).filter(isBonusEventActive);
      const firstDoc = snapshot.docs[0];
      const firstData = firstDoc?.data() as {
        status?: string;
        coadminUid?: string;
      } | undefined;
      options?.onSnapshotDebug?.({
        snapshotSize: snapshot.size,
        firstDocData: firstDoc ? (firstDoc.data() as Record<string, unknown>) : null,
      });
      if (BONUS_EVENTS_DEBUG) {
        console.info('[bonusEvents] listener:snapshot', {
          coadminUid,
          snapshotSize: snapshot.size,
          activeFilteredSize: activeEvents.length,
          skipTimeWindowFilter: Boolean(options?.skipTimeWindowFilter),
          firstDocId: firstDoc?.id || null,
          firstDocStatus: String(firstData?.status || ''),
          firstDocCoadminUid: String(firstData?.coadminUid || ''),
          firstRenderedBonusPercentage:
            activeEvents.length > 0 ? Number(activeEvents[0].bonusPercentage || 0) : null,
          renderedBonusPercentages: activeEvents.slice(0, 8).map((event) =>
            Number(event.bonusPercentage || event.bonus_percentage || 0)
          ),
        });
      }
      onChange(activeEvents);
    },
    (error) => {
      console.error('[bonusEvents] listener:error', {
        coadminUid,
        message: error instanceof Error ? error.message : String(error),
      });
      onError?.(error as Error);
    }
  );
  return () => {
    if (BONUS_EVENTS_DEBUG) {
      console.info('[bonusEvents] listener:stop', { coadminUid });
    }
    unsubscribe();
  };
}

export async function activateBonusEventForPlayer(values: {
  playerUid: string;
  bonusEvent: BonusEvent;
}) {
  await initiateBonusEventPlay({
    playerUid: values.playerUid,
    bonusEventId: values.bonusEvent.id,
  });
}

export async function initiateBonusEventPlay(values: {
  playerUid: string;
  bonusEventId: string;
}) {
  const url = '/api/bonus-events/initiate-play';
  const requestContext = await resolvePlayerBonusRequestContext();

  if (requestContext.role !== 'player' || requestContext.uid !== values.playerUid) {
    logPlayerBonusRequestHeaders({
      action: 'initiate_bonus_play',
      url,
      method: 'POST',
      role: requestContext.role,
      uid: requestContext.uid,
      hasAppSessionId: Boolean(getLocalAppSessionId()),
      hasPlayerSessionId: Boolean(getLocalPlayerSessionId()),
      appSessionIdPrefix: sessionIdPrefix(getLocalAppSessionId()),
      playerSessionIdPrefix: sessionIdPrefix(getLocalPlayerSessionId()),
      headersSent: [],
      blocked: true,
      reason: 'app_session_player_context_mismatch',
    });
    throw new Error('Player session required.');
  }

  const gate = await ensurePlayerSessionGateReady({
    source: 'initiateBonusEventPlay',
  });
  logPlayerSessionReadyState({
    source: 'initiateBonusEventPlay',
    sessionReady: gate.state === 'ready',
    loading: gate.state === 'loading',
  });
  if (gate.state !== 'ready') {
    logPlayerBonusRequestHeaders({
      action: 'initiate_bonus_play',
      url,
      method: 'POST',
      role: requestContext.role,
      uid: requestContext.uid,
      hasAppSessionId: Boolean(getLocalAppSessionId()),
      hasPlayerSessionId: Boolean(getLocalPlayerSessionId()),
      appSessionIdPrefix: sessionIdPrefix(getLocalAppSessionId()),
      playerSessionIdPrefix: sessionIdPrefix(getLocalPlayerSessionId()),
      headersSent: [],
      blocked: true,
      reason: gate.reason || 'player_session_loading',
    });
    throw new Error(PLAYER_SESSION_LOADING_MESSAGE);
  }
  const headers = await getPlayerApiHeaders(true, { route: url });
  logPlayerBonusRequestHeaders({
    action: 'initiate_bonus_play',
    url,
    method: 'POST',
    role: requestContext.role,
    uid: requestContext.uid,
    hasAppSessionId: Boolean(headers['X-App-Session-Id']),
    hasPlayerSessionId: Boolean(headers['X-Player-Session-Id']),
    appSessionIdPrefix: sessionIdPrefix(headers['X-App-Session-Id']),
    playerSessionIdPrefix: sessionIdPrefix(headers['X-Player-Session-Id']),
    headersSent: Object.keys(headers),
    blocked: false,
    reason: 'request',
  });

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ bonusEventId: values.bonusEventId }),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string | boolean;
    message?: string;
    requestId?: string;
  };
  if (!response.ok) {
    const reason =
      payload.message ||
      (typeof payload.error === 'string' ? payload.error : '') ||
      'Failed to initiate bonus event play.';
    logPlayerBonusRequestHeaders({
      action: 'initiate_bonus_play',
      url,
      method: 'POST',
      role: requestContext.role,
      uid: requestContext.uid,
      hasAppSessionId: Boolean(headers['X-App-Session-Id']),
      hasPlayerSessionId: Boolean(headers['X-Player-Session-Id']),
      appSessionIdPrefix: sessionIdPrefix(headers['X-App-Session-Id']),
      playerSessionIdPrefix: sessionIdPrefix(headers['X-Player-Session-Id']),
      headersSent: Object.keys(headers),
      blocked: true,
      reason,
    });
    throw new Error(reason);
  }
  const createdRequestId = String(payload.requestId || '').trim();
  if (!createdRequestId) {
    throw new Error('Bonus request was created but request ID was missing.');
  }
  const bonusRequestSnap = await getDoc(doc(db, 'playerGameRequests', createdRequestId));
  if (bonusRequestSnap.exists()) {
    await upsertCarerTaskForPlayerGameRequest({
      id: bonusRequestSnap.id,
      ...(bonusRequestSnap.data() as Omit<PlayerGameRequest, 'id'>),
    });
  }
}
