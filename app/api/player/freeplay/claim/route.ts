import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import { apiError, requirePlayerApiUser } from '@/lib/firebase/apiAuth';
import {
  authoritySqlWriteEnvLogFields,
  isAuthoritySqlWriteEnabled,
  logAuthorityFirestoreFallbackBlocked,
  logAuthoritySqlWrite,
} from '@/lib/server/authoritySqlWrite';
import { isAppbegSqlOnlyMode } from '@/lib/server/appbegSqlOnlyMode';
import { logPlayerApiAuthOk } from '@/lib/server/playerApiAuthLog';
import { logRouteSessionValidation, sessionIdsFromRequest } from '@/lib/server/sessionAuthLog';
import { claimFreeplayGiftInSql, mapFreeplaySqlError } from '@/lib/sql/authorityFreeplay';
import { mirrorFinancialEventById } from '@/lib/sql/financialEventsCache';
import { mirrorFreeplayPendingGiftByPlayerUid } from '@/lib/sql/freeplayPendingGiftsCache';
import { getPlayerMirrorPoolStats } from '@/lib/sql/playerMirrorCommon';
import { mirrorUserBalanceSnapshotById } from '@/lib/sql/userBalanceSnapshotsCache';

export const runtime = 'nodejs';

export const dynamic = 'force-dynamic';

const ROUTE = '/api/player/freeplay/claim';

function mapFreeplayClaimRouteError(error: unknown) {
  const rawMessage = error instanceof Error ? error.message : 'Failed to claim FreePlay gift.';
  const mapped = mapFreeplaySqlError(error);
  if (mapped !== rawMessage) {
    return mapped;
  }
  if (/not authenticated|authorization|token|session/i.test(rawMessage)) {
    return 'Session expired. Please log in again.';
  }
  if (/could not determine data type|parameter \$\d+/i.test(rawMessage)) {
    return 'Could not claim freeplay. Please try again.';
  }
  return rawMessage;
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  const headerSessions = sessionIdsFromRequest(request);
  try {
    console.info('[FREEPLAY_CLAIM_API_START]', {
      route: ROUTE,
      ...headerSessions,
    });
    console.info('[FREEPLAY_CLAIM_AUTH_BEGIN]', {
      route: ROUTE,
      authHelper: 'requirePlayerApiUser',
      ...headerSessions,
    });

    const auth = await requirePlayerApiUser(request);
    if ('response' in auth) {
      console.info('[FREEPLAY_CLAIM_AUTH_FAILED]', {
        route: ROUTE,
        uid: null,
        ...headerSessions,
        auth_path: auth.timing.auth_path,
        reason: 'requirePlayerApiUser_denied',
        status: auth.response.status,
      });
      logRouteSessionValidation(ROUTE, {
        ok: false,
        ...headerSessions,
        auth_path: auth.timing.auth_path,
        session_source: auth.timing.session_source,
      });
      return auth.response;
    }

    console.info('[FREEPLAY_CLAIM_AUTH_OK]', {
      route: ROUTE,
      uid: auth.user.uid,
      role: auth.user.role,
      ...headerSessions,
      auth_path: auth.authPath,
      session_source: auth.timing.session_source,
    });
    logRouteSessionValidation(ROUTE, {
      ok: true,
      ...headerSessions,
      auth_path: auth.authPath,
      session_source: auth.timing.session_source,
      uid: auth.user.uid,
    });
    logPlayerApiAuthOk(request, {
      route: ROUTE,
      uid: auth.user.uid,
      role: auth.user.role,
      authPath: auth.authPath,
    });

    const body = (await request.json().catch(() => ({}))) as {
      giftId?: unknown;
      idempotencyKey?: unknown;
    };
    const requestedGiftId = String(body.giftId || '').trim();
    if (!requestedGiftId) {
      return apiError('FreePlay gift id is required.', 400);
    }
    const idempotencyKey =
      String(body.idempotencyKey || request.headers.get('Idempotency-Key') || '').trim() || null;

    const playerUid = auth.user.uid;

    if (isAuthoritySqlWriteEnabled()) {
      console.info('[FREEPLAY_CLAIM_SQL_START]', {
        route: ROUTE,
        uid: playerUid,
        giftId: requestedGiftId,
      });
      const result = await claimFreeplayGiftInSql({
        playerUid,
        giftId: requestedGiftId,
        idempotencyKey,
      });
      const poolStats = getPlayerMirrorPoolStats();

      logAuthoritySqlWrite(ROUTE, {
        ...authoritySqlWriteEnvLogFields(),
        playerUid,
        giftId: requestedGiftId,
        amount: result.amount,
        alreadyClaimed: result.alreadyClaimed,
        duplicate: result.duplicate,
        route: ROUTE,
        pool_totalCount: poolStats?.totalCount ?? null,
        pool_idleCount: poolStats?.idleCount ?? null,
        pool_waitingCount: poolStats?.waitingCount ?? null,
        pool_max: poolStats?.max ?? null,
        duration_ms: Date.now() - startedAt,
      });

      console.info('[FREEPLAY_CLAIM_SQL_SUCCESS]', {
        route: ROUTE,
        uid: playerUid,
        giftId: requestedGiftId,
        amount: result.amount,
      });

      return NextResponse.json({
        success: true,
        amount: result.amount,
        alreadyClaimed: result.alreadyClaimed,
        duplicate: result.duplicate,
        message: result.message,
        coin: result.coin,
        cash: result.cash,
        coinBalance: result.coin,
        cashBalance: result.cash,
        claimedAt: result.claimedAt,
        eventId: result.eventId,
        hasPendingGift: result.hasPendingGift,
        authority: 'sql',
      });
    }

    if (isAppbegSqlOnlyMode()) {
      console.info('[SQL_NO_FIRESTORE_FREEPLAY_CLAIM]', {
        route: ROUTE,
        uid: playerUid,
        reason: 'sql_only_authority_required',
      });
      logAuthorityFirestoreFallbackBlocked(ROUTE, 'freeplay_claim', {
        playerUid,
        giftId: requestedGiftId,
      });
      return apiError('SQL freeplay claim authority is not enabled. Set AUTHORITY_SQL_WRITE=1.', 503);
    }

    const playerRef = adminDb.collection('users').doc(playerUid);
    const markerRef = adminDb.collection('freeplayPendingGifts').doc(playerUid);
    const eventRef = adminDb.collection('financialEvents').doc();
    let amount = 0;
    let alreadyClaimed = false;
    let mirroredEventId = '';

    await adminDb.runTransaction(async (transaction) => {
      const markerSnap = await transaction.get(markerRef);
      if (!markerSnap.exists) {
        throw new Error('No pending FreePlay gift found.');
      }
      const marker = markerSnap.data() as {
        type?: string;
        status?: string;
        giftId?: string;
        amount?: number | null;
        coadminUid?: string | null;
      };
      if (String(marker.type || '').toLowerCase() !== 'freeplay') {
        throw new Error('No pending FreePlay gift found.');
      }
      if (String(marker.giftId || '').trim() !== requestedGiftId) {
        throw new Error('This FreePlay gift is no longer pending.');
      }
      if (String(marker.status || '').toLowerCase() === 'claimed') {
        amount = Number(marker.amount || 0);
        alreadyClaimed = true;
        return;
      }
      if (String(marker.status || '').toLowerCase() !== 'pending' || !marker.giftId) {
        throw new Error('No pending FreePlay gift found.');
      }

      const giftRef = adminDb.collection('freeplayGifts').doc(requestedGiftId);
      const [giftSnap, playerSnap] = await Promise.all([
        transaction.get(giftRef),
        transaction.get(playerRef),
      ]);
      if (!giftSnap.exists || !playerSnap.exists) {
        throw new Error('FreePlay gift or player profile not found.');
      }
      const gift = giftSnap.data() as {
        playerUid?: string;
        type?: string;
        status?: string;
        coadminUid?: string | null;
      };
      if (
        String(gift.playerUid || '').trim() !== playerUid ||
        String(gift.type || '').toLowerCase() !== 'freeplay' ||
        String(gift.status || '').toLowerCase() !== 'pending'
      ) {
        throw new Error('No pending FreePlay gift found.');
      }
      const player = playerSnap.data() as { role?: string; coin?: number };
      if (String(player.role || '').toLowerCase() !== 'player') {
        throw new Error('Only players can claim FreePlay gifts.');
      }

      amount = Math.random() < 0.5 ? 2 : 3;
      const claimedFields = {
        status: 'claimed',
        amount,
        claimedAt: FieldValue.serverTimestamp(),
      };
      transaction.update(giftRef, claimedFields);
      transaction.update(markerRef, claimedFields);
      transaction.update(playerRef, {
        coin: Math.max(0, Number(player.coin || 0)) + amount,
      });
      transaction.set(eventRef, {
        type: 'freeplay',
        playerUid,
        coadminUid: String(gift.coadminUid || marker.coadminUid || '').trim() || null,
        amountNpr: amount,
        giftId: giftRef.id,
        createdAt: FieldValue.serverTimestamp(),
      });
      mirroredEventId = eventRef.id;
    });

    if (mirroredEventId) {
      void mirrorFinancialEventById(mirroredEventId, 'appbeg_freeplay_claim');
      void mirrorUserBalanceSnapshotById(playerUid, 'appbeg_freeplay_claim');
    }
    void mirrorFreeplayPendingGiftByPlayerUid(playerUid, 'appbeg_freeplay_claim').then((mirrorOk) => {
      console.info('[FREEPLAY_PENDING_CACHE]', {
        source: 'firestore_write',
        playerUid,
        mirror_ok: mirrorOk,
        action: 'claim',
        alreadyClaimed,
      });
    });
    return NextResponse.json({
      success: true,
      amount,
      alreadyClaimed,
      message: 'Freeplay claimed successfully.',
      authority: 'firestore',
    });
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : 'Failed to claim FreePlay gift.';
    const message = mapFreeplayClaimRouteError(error);
    console.info('[FREEPLAY_CLAIM_SQL_ERROR]', {
      route: ROUTE,
      error: rawMessage,
      userMessage: message,
    });
    return NextResponse.json(
      { error: message },
      {
        status: /session expired|not authenticated|authorization|token|session/i.test(message)
          ? 401
          : /only players/i.test(rawMessage)
            ? 403
            : /no longer|not found|not available|no pending/i.test(message)
              ? 409
              : 400,
      }
    );
  }
}
