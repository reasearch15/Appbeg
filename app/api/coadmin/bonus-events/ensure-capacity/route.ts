import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import { requireApiUser } from '@/lib/firebase/apiAuth';
import {
  isAuthoritySqlWriteEnabled,
  logAuthoritySqlWrite,
} from '@/lib/server/authoritySqlWrite';
import {
  logBonusEventsEnsureAuth,
  logBonusEventsEnsureSql,
  resolveCoadminBonusAuthFailure,
} from '@/lib/server/bonusEventsAudit';
import { invalidateBonusEventsMemoryCache } from '@/lib/server/bonusEventsMemoryCache';
import { ensureBonusCapacityInSql } from '@/lib/sql/authorityBonus';

export const runtime = 'nodejs';

const ROUTE = '/api/coadmin/bonus-events/ensure-capacity';
const MAX_ACTIVE_BONUS_EVENTS = 20;
const COADMIN_MIN_PERCENT = 5;
const COADMIN_MAX_PERCENT = 10;
const COADMIN_AUTO_BONUS_PERCENT_MIN = 5;
const COADMIN_AUTO_BONUS_PERCENT_MAX = 30;
const COADMIN_MIN_AMOUNT = 10;
const COADMIN_MAX_AMOUNT = 50;
const BONUS_ENSURE_LEASE_MS = 15_000;
const BONUS_ENSURE_COOLDOWN_MS = 20_000;
const BONUS_ENSURE_STATE_CACHE_MS = 45_000;
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

type EnsureLeaseResult =
  | {
      status: 'acquired';
      leaseId: string;
      now: Date;
      lastEnsuredAtMs: number;
      lastEnsuredStateHash: string;
      lastActiveCount: number;
    }
  | { status: 'locked' | 'cooldown' | 'server-cooldown'; retryAfterMs: number };

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

function normalizeAutoBonusPercentRange(values: {
  minPercent?: number | null;
  maxPercent?: number | null;
}) {
  const rawMin = Number(values.minPercent);
  const rawMax = Number(values.maxPercent);
  const fallbackMin = COADMIN_MIN_PERCENT;
  const fallbackMax = COADMIN_MAX_PERCENT;

  const minPercent = Number.isFinite(rawMin) ? Math.round(rawMin) : fallbackMin;
  const maxPercent = Number.isFinite(rawMax) ? Math.round(rawMax) : fallbackMax;

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

function toMs(value: unknown) {
  if (!value || typeof value !== 'object') return 0;
  const maybe = value as { toMillis?: () => number; toDate?: () => Date; seconds?: number };
  if (typeof maybe.toMillis === 'function') return maybe.toMillis();
  if (typeof maybe.toDate === 'function') return maybe.toDate().getTime();
  if (typeof maybe.seconds === 'number') return maybe.seconds * 1000;
  return 0;
}

function isActiveEvent(docData: Record<string, unknown>) {
  const now = Date.now();
  const status = String(docData.status || 'active').toLowerCase();
  if (status !== 'active') return false;
  const startMs = toMs(docData.startDate || docData.start_date || null);
  const endMs = toMs(docData.endDate || docData.end_date || null);
  if (startMs > 0 && now < startMs) return false;
  if (endMs > 0 && now > endMs) return false;
  return true;
}

function duplicateKey(values: {
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

function buildActiveStateHash(
  docs: FirebaseFirestore.QueryDocumentSnapshot<FirebaseFirestore.DocumentData>[]
) {
  return docs
    .map((docSnap) => {
      const data = docSnap.data() as {
        bonusName?: string;
        gameName?: string;
        amountNpr?: number;
        amount?: number;
        bonusPercentage?: number;
        bonus_percentage?: number;
      };
      return [
        docSnap.id,
        String(data.bonusName || '').trim().toLowerCase(),
        String(data.gameName || '').trim().toLowerCase(),
        Math.round(Number(data.amountNpr || data.amount || 0)),
        Math.round(Number(data.bonusPercentage || data.bonus_percentage || 0)),
      ].join('__');
    })
    .join('|');
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

async function getCoadminGameNames(coadminUid: string): Promise<string[]> {
  const [coadminOwned, legacyOwned] = await Promise.all([
    adminDb.collection('gameLogins').where('coadminUid', '==', coadminUid).limit(MAX_GAME_LOGINS_READ).get(),
    adminDb.collection('gameLogins').where('createdBy', '==', coadminUid).limit(MAX_GAME_LOGINS_READ).get(),
  ]);
  const names = new Set<string>();
  [...coadminOwned.docs, ...legacyOwned.docs].forEach((d) => {
    const data = d.data() as { gameName?: string };
    const name = String(data.gameName || '').trim();
    if (name) names.add(name);
  });
  return [...names];
}

async function getCoadminAutoBonusPercentRange(coadminUid: string) {
  const userSnap = await adminDb.collection('users').doc(coadminUid).get();
  if (!userSnap.exists) {
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

function buildActiveBonusEventsQuery(coadminUid: string) {
  return adminDb
    .collection('bonusEvents')
    .where('coadminUid', '==', coadminUid)
    .where('status', '==', 'active')
    .orderBy('createdAt', 'desc')
    .limit(MAX_ACTIVE_BONUS_EVENTS);
}

async function acquireEnsureCapacityLease(caller: {
  uid: string;
  coadminUid: string;
}) : Promise<EnsureLeaseResult> {
  const userRef = adminDb.collection('users').doc(caller.coadminUid);
  const leaseId = crypto.randomUUID();
  const now = new Date();
  const nowMs = now.getTime();

  return adminDb.runTransaction(async (transaction) => {
    const userSnap = await transaction.get(userRef);
    if (!userSnap.exists) {
      throw new Error('Current user profile not found.');
    }

    const userData = userSnap.data() as {
      bonusEnsureCapacityLeaseId?: string;
      bonusEnsureCapacityLeaseExpiresAt?: unknown;
      bonusEnsureCapacityLastEnsuredAt?: unknown;
      bonusEnsureCapacityLastStateHash?: string;
      bonusEnsureCapacityLastActiveCount?: number;
    };

    const leaseExpiresAtMs = toMs(userData.bonusEnsureCapacityLeaseExpiresAt);
    const lastEnsuredAtMs = toMs(userData.bonusEnsureCapacityLastEnsuredAt);

    if (leaseExpiresAtMs > nowMs) {
      return {
        status: 'locked' as const,
        retryAfterMs: Math.max(1_000, leaseExpiresAtMs - nowMs),
      };
    }

    if (lastEnsuredAtMs > 0 && nowMs - lastEnsuredAtMs < BONUS_ENSURE_COOLDOWN_MS) {
      return {
        status: 'cooldown' as const,
        retryAfterMs: Math.max(1_000, BONUS_ENSURE_COOLDOWN_MS - (nowMs - lastEnsuredAtMs)),
      };
    }
    const lastActiveCount = Number(userData.bonusEnsureCapacityLastActiveCount || 0);
    if (
      lastActiveCount >= MAX_ACTIVE_BONUS_EVENTS &&
      lastEnsuredAtMs > 0 &&
      nowMs - lastEnsuredAtMs < BONUS_ENSURE_STATE_CACHE_MS
    ) {
      return {
        status: 'server-cooldown' as const,
        retryAfterMs: Math.max(1_000, BONUS_ENSURE_STATE_CACHE_MS - (nowMs - lastEnsuredAtMs)),
      };
    }

    transaction.update(userRef, {
      bonusEnsureCapacityLeaseId: leaseId,
      bonusEnsureCapacityLeaseExpiresAt: new Date(nowMs + BONUS_ENSURE_LEASE_MS),
      bonusEnsureCapacityLeaseStartedAt: now,
    });

    return {
      status: 'acquired' as const,
      leaseId,
      now,
      lastEnsuredAtMs,
      lastEnsuredStateHash: String(userData.bonusEnsureCapacityLastStateHash || ''),
      lastActiveCount,
    };
  });
}

async function releaseEnsureCapacityLease(values: {
  coadminUid: string;
  leaseId: string;
  markEnsured: boolean;
  ensuredActiveCount?: number;
  ensuredStateHash?: string;
}) {
  const userRef = adminDb.collection('users').doc(values.coadminUid);
  const releaseTime = new Date();

  await adminDb.runTransaction(async (transaction) => {
    const userSnap = await transaction.get(userRef);
    if (!userSnap.exists) {
      return;
    }

    const userData = userSnap.data() as {
      bonusEnsureCapacityLeaseId?: string;
    };

    if (String(userData.bonusEnsureCapacityLeaseId || '') !== values.leaseId) {
      return;
    }

    transaction.update(userRef, {
      bonusEnsureCapacityLeaseId: FieldValue.delete(),
      bonusEnsureCapacityLeaseExpiresAt: FieldValue.delete(),
      bonusEnsureCapacityLeaseStartedAt: FieldValue.delete(),
      ...(values.markEnsured
        ? {
            bonusEnsureCapacityLastEnsuredAt: releaseTime,
            ...(typeof values.ensuredActiveCount === 'number'
              ? {
                  bonusEnsureCapacityLastActiveCount: values.ensuredActiveCount,
                }
              : {}),
            ...(values.ensuredStateHash
              ? {
                  bonusEnsureCapacityLastStateHash: values.ensuredStateHash,
                }
              : {}),
          }
        : {}),
    });
  });
}

export async function POST(request: Request) {
  const reqStartedAt = Date.now();
  let leaseId: string | null = null;
  let leaseOwnerCoadminUid = '';
  let shouldMarkEnsured = false;
  let ensuredActiveCount: number | undefined;
  let ensuredStateHash: string | undefined;

  try {
    let activeCountHint: number | null = null;
    try {
      const body = (await request.json()) as { activeCountHint?: number } | null;
      const parsed = Number(body?.activeCountHint);
      if (Number.isFinite(parsed)) {
        activeCountHint = Math.max(0, Math.round(parsed));
      }
    } catch {
      // Keep compatibility with empty-body callers.
    }

    const authStartedAt = Date.now();
    const auth = await requireApiUser(request, ['coadmin']);
    if ('response' in auth) {
      return resolveCoadminBonusAuthFailure(request, ROUTE, auth);
    }
    const callerUid = auth.user.uid;

    logBonusEventsEnsureAuth(request, {
      route: ROUTE,
      uid: callerUid,
      role: auth.user.role,
      coadminUid: callerUid,
      auth_path: auth.authPath,
      source: isAuthoritySqlWriteEnabled() ? 'sql' : 'firestore',
    });

    if (isAuthoritySqlWriteEnabled()) {
      const beforeCount =
        activeCountHint != null && Number.isFinite(activeCountHint)
          ? Math.max(0, Math.round(Number(activeCountHint)))
          : 0;
      const result = await ensureBonusCapacityInSql({
        coadminUid: callerUid,
        callerUid,
        callerUsername: auth.user.username || 'Coadmin',
        activeCountHint,
      });
      const afterCount =
        typeof result.totalActive === 'number' ? result.totalActive : beforeCount + result.autoCreatedCount;
      logBonusEventsEnsureSql({
        route: ROUTE,
        coadminUid: callerUid,
        beforeCount,
        createdCount: result.autoCreatedCount,
        afterCount,
        minPercent: null,
        maxPercent: null,
        authority_sql_write: true,
        firestore_fallback: false,
        reason: result.skipped ? `skipped_${result.skipped}` : 'bonus_events_cache_insert',
      });
      logAuthoritySqlWrite(ROUTE, {
        coadminUid: callerUid,
        autoCreatedCount: result.autoCreatedCount,
        totalActive: result.totalActive,
        skipped: result.skipped || null,
      });
      if (result.autoCreatedCount > 0) {
        invalidateBonusEventsMemoryCache(callerUid);
      }
      return NextResponse.json({ ...result, authority: 'sql' });
    }

    const userSnap = await adminDb.collection('users').doc(callerUid).get();
    if (!userSnap.exists) {
      return NextResponse.json({ error: 'Current user profile not found.' }, { status: 404 });
    }
    const userData = userSnap.data() as {
      bonusEnsureCapacityLastEnsuredAt?: unknown;
      bonusEnsureCapacityLastActiveCount?: number;
    };
    const caller = {
      uid: callerUid,
      coadminUid: callerUid,
      username: auth.user.username || 'Coadmin',
      lastEnsuredAtMs: toMs(userData.bonusEnsureCapacityLastEnsuredAt),
      lastActiveCount: Number(userData.bonusEnsureCapacityLastActiveCount || 0),
    };
    const authElapsedMs = Date.now() - authStartedAt;
    console.info('[bonusEvents] ensure-capacity:auth-done', {
      coadminUid: caller.coadminUid,
      auth_path: auth.authPath,
      app_session_used: auth.authPath.startsWith('app_session'),
      authElapsedMs,
    });

    const cooldownCheckedAt = Date.now();
    if (activeCountHint !== null && activeCountHint >= MAX_ACTIVE_BONUS_EVENTS) {
      const totalElapsedMs = Date.now() - reqStartedAt;
      console.info('[bonusEvents] ensure-capacity:cooldown-checked', {
        coadminUid: caller.coadminUid,
        decision: 'skip-client-full-hint',
        activeCountHint,
        checkElapsedMs: Date.now() - cooldownCheckedAt,
      });
      console.info('[bonusEvents] ensure-capacity:skip', {
        coadminUid: caller.coadminUid,
        reason: 'client-full-hint',
        elapsedMs: totalElapsedMs,
      });
      return NextResponse.json({
        autoCreatedCount: 0,
        totalActive: activeCountHint,
        skipped: 'client-full-hint',
      });
    }
    if (
      caller.lastActiveCount >= MAX_ACTIVE_BONUS_EVENTS &&
      caller.lastEnsuredAtMs > 0 &&
      Date.now() - caller.lastEnsuredAtMs < BONUS_ENSURE_STATE_CACHE_MS
    ) {
      const retryAfterMs = Math.max(
        1_000,
        BONUS_ENSURE_STATE_CACHE_MS - (Date.now() - caller.lastEnsuredAtMs)
      );
      const totalElapsedMs = Date.now() - reqStartedAt;
      console.info('[bonusEvents] ensure-capacity:cooldown-checked', {
        coadminUid: caller.coadminUid,
        decision: 'skip-server-cooldown-fast',
        checkElapsedMs: Date.now() - cooldownCheckedAt,
      });
      console.info('[bonusEvents] skipped-server-cooldown', {
        coadminUid: caller.coadminUid,
        retryAfterMs,
      });
      console.info('[bonusEvents] ensure-capacity:skip', {
        coadminUid: caller.coadminUid,
        reason: 'server-cooldown',
        retryAfterMs,
        elapsedMs: totalElapsedMs,
      });
      return NextResponse.json({
        autoCreatedCount: 0,
        totalActive: caller.lastActiveCount,
        skipped: 'server-cooldown',
        retryAfterMs,
      });
    }
    console.info('[bonusEvents] ensure-capacity:cooldown-checked', {
      coadminUid: caller.coadminUid,
      decision: 'continue',
      checkElapsedMs: Date.now() - cooldownCheckedAt,
    });

    const lease = await acquireEnsureCapacityLease(caller);
    if (lease.status !== 'acquired') {
      if (lease.status === 'server-cooldown') {
        console.info('[bonusEvents] skipped-server-cooldown', {
          coadminUid: caller.coadminUid,
          retryAfterMs: lease.retryAfterMs,
        });
      }
      console.info('[bonusEvents] ensure-capacity:skip', {
        coadminUid: caller.coadminUid,
        reason: lease.status,
        retryAfterMs: lease.retryAfterMs,
      });
      return NextResponse.json({
        autoCreatedCount: 0,
        totalActive: null,
        skipped: lease.status,
        retryAfterMs: lease.retryAfterMs,
      });
    }

    leaseId = lease.leaseId;
    leaseOwnerCoadminUid = caller.coadminUid;

    console.info('[bonusEvents] ensure-capacity:start', {
      coadminUid: caller.coadminUid,
      leaseId,
    });
    console.info('[bonusEvents] ensure-capacity:expensive-reads-start', {
      coadminUid: caller.coadminUid,
      elapsedMs: Date.now() - reqStartedAt,
    });

    const activeReadStartedAt = Date.now();
    const activeSnap = await buildActiveBonusEventsQuery(caller.coadminUid).get();
    const activeReadElapsedMs = Date.now() - activeReadStartedAt;
    console.info('[bonusEvents] ensure-capacity:read-active-done', {
      coadminUid: caller.coadminUid,
      readMs: activeReadElapsedMs,
      docsRead: activeSnap.size,
    });
    const activeDocs = activeSnap.docs.filter((d) =>
      isActiveEvent(d.data() as Record<string, unknown>)
    );
    const activeStateHash = buildActiveStateHash(activeDocs);
    const missingCapacity = Math.max(0, MAX_ACTIVE_BONUS_EVENTS - activeDocs.length);

    if (
      lease.lastEnsuredStateHash &&
      lease.lastEnsuredStateHash === activeStateHash &&
      lease.lastEnsuredAtMs > 0 &&
      lease.now.getTime() - lease.lastEnsuredAtMs < BONUS_ENSURE_STATE_CACHE_MS &&
      !(activeDocs.length === 0 && missingCapacity > 0)
    ) {
      shouldMarkEnsured = true;
      ensuredActiveCount = activeDocs.length;
      ensuredStateHash = activeStateHash;
      console.info('[BONUS_EVENTS_ENSURE_UNCHANGED_ACTIVE_STATE]', {
        coadminUid: caller.coadminUid,
        activeCount: activeDocs.length,
      });
      return NextResponse.json({
        autoCreatedCount: 0,
        totalActive: activeDocs.length,
        skipped: 'unchanged-active-state',
      });
    }

    if (activeDocs.length === 0 && missingCapacity > 0) {
      console.info('[BONUS_EVENTS_ENSURE_EMPTY_ACTIVE_CREATE]', {
        coadminUid: caller.coadminUid,
        missing: missingCapacity,
      });
    }

    if (activeDocs.length >= MAX_ACTIVE_BONUS_EVENTS) {
      shouldMarkEnsured = true;
      ensuredActiveCount = activeDocs.length;
      ensuredStateHash = activeStateHash;
      console.info('[bonusEvents] ensure-capacity:full', {
        coadminUid: caller.coadminUid,
        activeCount: activeDocs.length,
      });
      return NextResponse.json({ autoCreatedCount: 0, totalActive: activeDocs.length });
    }

    const rangeReadStartedAt = Date.now();
    const autoBonusPercentRange = await getCoadminAutoBonusPercentRange(caller.coadminUid);
    console.info('[bonusEvents] ensure-capacity:read-range-done', {
      coadminUid: caller.coadminUid,
      readMs: Date.now() - rangeReadStartedAt,
    });
    const gameReadStartedAt = Date.now();
    const gameNames = await getCoadminGameNames(caller.coadminUid);
    console.info('[bonusEvents] ensure-capacity:read-gamelogins-done', {
      coadminUid: caller.coadminUid,
      readMs: Date.now() - gameReadStartedAt,
      gameCount: gameNames.length,
    });
    const pickGameName = () =>
      gameNames.length > 0 ? gameNames[randomInt(0, gameNames.length - 1)] : 'Bonus Table';
    const existing = new Set(
      activeDocs.map((d) => {
        const data = d.data() as {
          bonusName?: string;
          gameName?: string;
          amountNpr?: number;
          amount?: number;
          bonusPercentage?: number;
          bonus_percentage?: number;
        };
        return duplicateKey({
          bonusName: String(data.bonusName || ''),
          gameName: String(data.gameName || ''),
          amountNpr: Number(data.amountNpr || data.amount || 0),
          bonusPercentage: Number(data.bonusPercentage || data.bonus_percentage || 0),
        });
      })
    );
    const usedNames = new Set(
      activeDocs.map((d) =>
        String((d.data() as { bonusName?: string }).bonusName || '')
          .trim()
          .toLowerCase()
      )
    );

    const now = new Date();
    const end = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const missing = MAX_ACTIVE_BONUS_EVENTS - activeDocs.length;
    let autoCreatedCount = 0;
    let attempts = 0;
    const batch = adminDb.batch();

    while (autoCreatedCount < missing && attempts < missing * 25) {
      attempts += 1;
      const amount = randomInt(COADMIN_MIN_AMOUNT, COADMIN_MAX_AMOUNT);
      const percent = randomPercentInRange(
        autoBonusPercentRange.minPercent,
        autoBonusPercentRange.maxPercent
      );
      const gameName = pickGameName();
      const bonusName = pickFunnyBonusName(usedNames, attempts);
      const key = duplicateKey({
        bonusName,
        gameName,
        amountNpr: amount,
        bonusPercentage: percent,
      });
      if (existing.has(key)) continue;

      const ref = adminDb.collection('bonusEvents').doc();
      batch.set(ref, {
        eventId: ref.id,
        event_id: ref.id,
        coadminUid: caller.coadminUid,
        bonusName,
        gameName,
        amountNpr: amount,
        amount,
        bonusPercentage: percent,
        bonus_percentage: percent,
        description: 'Auto-generated co-admin bonus event to maintain active event capacity.',
        createdByUid: caller.uid,
        created_by: caller.uid,
        createdByUsername: caller.username,
        createdByRole: 'coadmin',
        creator_role: 'system',
        status: 'active',
        startDate: now,
        endDate: end,
        start_date: now,
        end_date: end,
        createdAt: FieldValue.serverTimestamp(),
        created_at: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        updated_at: FieldValue.serverTimestamp(),
        autoGenerated: true,
      });

      existing.add(key);
      autoCreatedCount += 1;
    }

    if (autoCreatedCount > 0) {
      const commitStartedAt = Date.now();
      await batch.commit();
      console.info('[BONUS_EVENTS_ENSURE_CREATED]', {
        coadminUid: caller.coadminUid,
        autoCreatedCount,
        totalActive: activeDocs.length + autoCreatedCount,
      });
      console.info('[bonusEvents] ensure-capacity:batch-commit-done', {
        coadminUid: caller.coadminUid,
        commitMs: Date.now() - commitStartedAt,
        createdCount: autoCreatedCount,
      });
      invalidateBonusEventsMemoryCache(caller.coadminUid);
    }

    shouldMarkEnsured = true;
    ensuredActiveCount = activeDocs.length + autoCreatedCount;
    ensuredStateHash =
      autoCreatedCount > 0 ? undefined : activeStateHash;
    console.info('[bonusEvents] ensure-capacity:done', {
      coadminUid: caller.coadminUid,
      activeReadCount: activeDocs.length,
      createdCount: autoCreatedCount,
      totalActive: activeDocs.length + autoCreatedCount,
    });

    return NextResponse.json({
      autoCreatedCount,
      totalActive: activeDocs.length + autoCreatedCount,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to ensure bonus capacity.';
    return NextResponse.json({ error: message }, { status: 400 });
  } finally {
    if (leaseId && leaseOwnerCoadminUid) {
      await releaseEnsureCapacityLease({
        coadminUid: leaseOwnerCoadminUid,
        leaseId,
        markEnsured: shouldMarkEnsured,
        ensuredActiveCount,
        ensuredStateHash,
      }).catch((releaseError) => {
        console.error('[bonusEvents] ensure-capacity:release-failed', {
          coadminUid: leaseOwnerCoadminUid,
          leaseId,
          error:
            releaseError instanceof Error ? releaseError.message : 'Unknown release failure',
        });
      });
    }
  }
}
