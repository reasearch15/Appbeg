import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import { requireApiUser } from '@/lib/firebase/apiAuth';
import {
  isAuthoritySqlWriteEnabled,
  logAuthoritySqlWrite,
} from '@/lib/server/authoritySqlWrite';
import {
  logBonusEventsRangeSql,
  resolveCoadminBonusAuthFailure,
} from '@/lib/server/bonusEventsAudit';
import { invalidateBonusEventsMemoryCache } from '@/lib/server/bonusEventsMemoryCache';
import { updateBonusRangeInSql } from '@/lib/sql/authorityBonus';
import { mirrorCoadminBonusSettingsSnapshot } from '@/lib/sql/coadminBonusSettingsCache';

export const runtime = 'nodejs';

const ROUTE = '/api/coadmin/bonus-events/update-range';
const COADMIN_MIN_PERCENT = 5;
const COADMIN_MAX_PERCENT = 10;
const COADMIN_AUTO_BONUS_PERCENT_MIN = 5;
const COADMIN_AUTO_BONUS_PERCENT_MAX = 30;
const ACTIVE_CAP = 20;
const UPDATE_BATCH_SIZE = 2;
const UPDATE_DELAY_MS = 1500;
const LEASE_MS = 60_000;

function randomPercentInRange(min: number, max: number) {
  const safeMin = Number.isFinite(min) ? min : COADMIN_MIN_PERCENT;
  const safeMax = Number.isFinite(max) ? max : COADMIN_MAX_PERCENT;
  const low = Math.min(safeMin, safeMax);
  const high = Math.max(safeMin, safeMax);
  if (low === high) return Number(low.toFixed(2));
  const raw = Math.random() * (high - low) + low;
  return Number(raw.toFixed(2));
}

function normalizeAutoBonusPercentRange(values: { minPercent?: number | null; maxPercent?: number | null }) {
  const rawMin = Number(values.minPercent);
  const rawMax = Number(values.maxPercent);
  const minPercent = Number.isFinite(rawMin) ? Math.round(rawMin) : COADMIN_MIN_PERCENT;
  const maxPercent = Number.isFinite(rawMax) ? Math.round(rawMax) : COADMIN_MAX_PERCENT;
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

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function mirrorCoadminBonusSettingsAfterFirebaseSave(
  settingsRef: FirebaseFirestore.DocumentReference,
  reason: string
) {
  try {
    const snap = await settingsRef.get();
    const mirrored = await mirrorCoadminBonusSettingsSnapshot(snap);
    if (!mirrored) {
      console.warn('[COADMIN_BONUS_SETTINGS_CACHE] mirror failed', {
        firebaseId: settingsRef.id,
        reason: 'database_url_missing_or_doc_missing',
        source: reason,
      });
    }
  } catch (error) {
    console.warn('[COADMIN_BONUS_SETTINGS_CACHE] mirror failed', {
      firebaseId: settingsRef.id,
      source: reason,
      error,
    });
  }
}

export async function POST(request: Request) {
  let leaseId: string | null = null;
  let leaseSettingsRef: FirebaseFirestore.DocumentReference | null = null;
  try {
    const auth = await requireApiUser(request, ['coadmin']);
    if ('response' in auth) {
      return resolveCoadminBonusAuthFailure(request, ROUTE, auth);
    }
    const callerUid = auth.user.uid;
    const body = (await request.json()) as {
      minPercent?: number;
      maxPercent?: number;
      idempotencyKey?: unknown;
    } | null;

    if (isAuthoritySqlWriteEnabled()) {
      const idempotencyKey =
        String(body?.idempotencyKey || request.headers.get('Idempotency-Key') || '').trim() ||
        null;
      const result = await updateBonusRangeInSql({
        coadminUid: callerUid,
        minPercent: Number(body?.minPercent),
        maxPercent: Number(body?.maxPercent),
        idempotencyKey,
      });
      logBonusEventsRangeSql({
        route: ROUTE,
        coadminUid: callerUid,
        oldMin: null,
        oldMax: null,
        newMin: result.minPercent,
        newMax: result.maxPercent,
        affectedEvents: result.adjustedEventCount,
        authority_sql_write: true,
        firestore_fallback: false,
        reason: result.duplicate ? 'duplicate_idempotency' : 'coadmin_bonus_settings_cache_update',
      });
      logAuthoritySqlWrite(ROUTE, {
        coadminUid: callerUid,
        adjustedEventCount: result.adjustedEventCount,
        duplicate: result.duplicate || false,
      });
      if (result.adjustedEventCount > 0) {
        invalidateBonusEventsMemoryCache(callerUid);
      }
      return NextResponse.json({ ...result, authority: 'sql' });
    }

    console.info('[COADMIN_BONUS_UPDATE_RANGE_AUTH]', {
      auth_path: auth.authPath,
      uid: callerUid,
      app_session_used: auth.authPath.startsWith('app_session'),
    });

    const normalized = normalizeAutoBonusPercentRange({
      minPercent: body?.minPercent,
      maxPercent: body?.maxPercent,
    });
    const now = new Date();

    // Save config first (fast path), then run slow updates.
    const settingsRef = adminDb.collection('coadminBonusSettings').doc(callerUid);
    leaseSettingsRef = settingsRef;
    await settingsRef.set(
      {
        coadminUid: callerUid,
        minPercent: normalized.minPercent,
        maxPercent: normalized.maxPercent,
        updatedAt: now,
      },
      { merge: true }
    );
    await mirrorCoadminBonusSettingsAfterFirebaseSave(settingsRef, 'range_saved');
    await adminDb.collection('users').doc(callerUid).set(
      {
        autoBonusEventMinPercent: normalized.minPercent,
        autoBonusEventMaxPercent: normalized.maxPercent,
        updatedAt: now,
        updated_at: now,
      },
      { merge: true }
    );

    const lease = await adminDb.runTransaction(async (transaction) => {
      const snap = await transaction.get(settingsRef);
      const data = (snap.data() || {}) as {
        rangeUpdateLeaseId?: string;
        rangeUpdateLeaseExpiresAt?: unknown;
      };
      const expiresAtMs = toMs(data.rangeUpdateLeaseExpiresAt);
      const nowMs = Date.now();
      if (expiresAtMs > nowMs) {
        return { acquired: false, retryAfterMs: Math.max(1_000, expiresAtMs - nowMs) };
      }
      const nextLeaseId = crypto.randomUUID();
      transaction.set(
        settingsRef,
        {
          rangeUpdateLeaseId: nextLeaseId,
          rangeUpdateLeaseExpiresAt: new Date(nowMs + LEASE_MS),
          rangeUpdateStartedAt: now,
        },
        { merge: true }
      );
      return { acquired: true, leaseId: nextLeaseId };
    });

    if (!lease.acquired) {
      console.info('[bonus-range-update:skip]', {
        coadminUid: callerUid,
        reason: 'lease-active',
        retryAfterMs: lease.retryAfterMs,
      });
      return NextResponse.json({
        minPercent: normalized.minPercent,
        maxPercent: normalized.maxPercent,
        adjustedEventCount: 0,
        skipped: 'lease-active',
        retryAfterMs: lease.retryAfterMs,
      });
    }
    leaseId = lease.leaseId || null;
    await mirrorCoadminBonusSettingsAfterFirebaseSave(settingsRef, 'lease_acquired');

    console.info('[bonus-range-update:start]', {
      coadminUid: callerUid,
      minPercent: normalized.minPercent,
      maxPercent: normalized.maxPercent,
      batchSize: UPDATE_BATCH_SIZE,
      delayMs: UPDATE_DELAY_MS,
    });

    const activeSnap = await adminDb
      .collection('bonusEvents')
      .where('coadminUid', '==', callerUid)
      .where('status', '==', 'active')
      .orderBy('createdAt', 'desc')
      .limit(ACTIVE_CAP)
      .get();

    const outOfRangeDocs = activeSnap.docs.filter((docSnap) => {
      const data = docSnap.data() as { bonusPercentage?: number; bonus_percentage?: number };
      const percent = Number(data.bonusPercentage ?? data.bonus_percentage ?? 0);
      return percent < normalized.minPercent || percent > normalized.maxPercent;
    });

    if (outOfRangeDocs.length === 0) {
      console.info('[bonus-range-update:skip]', {
        coadminUid: callerUid,
        reason: 'all-in-range',
      });
      return NextResponse.json({
        minPercent: normalized.minPercent,
        maxPercent: normalized.maxPercent,
        adjustedEventCount: 0,
      });
    }

    let adjustedEventCount = 0;
    for (let i = 0; i < outOfRangeDocs.length; i += UPDATE_BATCH_SIZE) {
      const batchDocs = outOfRangeDocs.slice(i, i + UPDATE_BATCH_SIZE);
      const batch = adminDb.batch();
      const batchDocIds: string[] = [];
      for (const docSnap of batchDocs) {
        const data = docSnap.data() as { bonusPercentage?: number; bonus_percentage?: number };
        const previousPercent = Number(data.bonusPercentage ?? data.bonus_percentage ?? 0);
        const nextPercent = randomPercentInRange(normalized.minPercent, normalized.maxPercent);
        batch.update(docSnap.ref, {
          bonusPercentage: nextPercent,
          bonus_percentage: nextPercent,
          updatedAt: FieldValue.serverTimestamp(),
          updated_at: FieldValue.serverTimestamp(),
        });
        batchDocIds.push(`${docSnap.id}:${previousPercent}->${nextPercent}`);
      }
      await batch.commit();
      adjustedEventCount += batchDocs.length;
      console.info('[bonus-range-update:batch]', {
        coadminUid: callerUid,
        batchIndex: Math.floor(i / UPDATE_BATCH_SIZE) + 1,
        batchSize: batchDocs.length,
        updatedDocIds: batchDocIds,
        updatedSoFar: adjustedEventCount,
        totalTarget: outOfRangeDocs.length,
      });
      if (i + UPDATE_BATCH_SIZE < outOfRangeDocs.length) {
        await sleep(UPDATE_DELAY_MS);
      }
    }

    console.info('[bonus-range-update:done]', {
      coadminUid: callerUid,
      adjustedEventCount,
      totalActiveConsidered: activeSnap.size,
      outOfRangeCount: outOfRangeDocs.length,
    });
    if (adjustedEventCount > 0) {
      invalidateBonusEventsMemoryCache(callerUid);
    }

    return NextResponse.json({
      minPercent: normalized.minPercent,
      maxPercent: normalized.maxPercent,
      adjustedEventCount,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update bonus range.';
    return NextResponse.json({ error: message }, { status: 400 });
  } finally {
    if (leaseId && leaseSettingsRef) {
      await adminDb
        .runTransaction(async (transaction) => {
          const snap = await transaction.get(leaseSettingsRef!);
          if (!snap.exists) return;
          const data = (snap.data() || {}) as { rangeUpdateLeaseId?: string };
          if (String(data.rangeUpdateLeaseId || '') !== leaseId) return;
          transaction.set(
            leaseSettingsRef!,
            {
              rangeUpdateLeaseId: FieldValue.delete(),
              rangeUpdateLeaseExpiresAt: FieldValue.delete(),
              rangeUpdateStartedAt: FieldValue.delete(),
              rangeUpdateLastCompletedAt: FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        })
        .then(() => mirrorCoadminBonusSettingsAfterFirebaseSave(leaseSettingsRef!, 'lease_released'))
        .catch(() => {});
    }
  }
}
