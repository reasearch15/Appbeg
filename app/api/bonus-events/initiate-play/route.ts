import {
  assertArbCanClaimBonusEvent,
  evaluateArbEligibility,
} from '@/lib/economy/automaticRechargeBonus/eligibility';
import { parseArbPlayerPreferenceState } from '@/lib/economy/automaticRechargeBonus/playerPreference';
import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import { apiError, requirePlayerApiUser } from '@/lib/firebase/apiAuth';
import {
  getCoadminMaintenanceBreak,
  maintenanceBreakApiResponse,
  rejectIfPlayerMaintenanceBreak,
} from '@/lib/maintenance/admin';
import {
  buildPendingRequestLinkedCarerTaskPayload,
  findRequestLinkedGameCredential,
  requestLinkedCarerTaskId,
} from '@/lib/games/requestLinkedCarerTask';
import {
  isAuthoritySqlWriteEnabled,
  logAuthoritySqlWrite,
} from '@/lib/server/authoritySqlWrite';
import {
  bonusEventsRequestHeaderFlags,
  logBonusEventsBlocked,
  logBonusEventsInitiateAuth,
  logPlayerBonusAuth,
  logPlayerBonusSessionHeaderCheck,
} from '@/lib/server/bonusEventsAudit';
import { invalidateBonusEventsMemoryCache } from '@/lib/server/bonusEventsMemoryCache';
import { initiateBonusPlayInSql } from '@/lib/sql/authorityBonus';
import { mirrorCarerTaskById } from '@/lib/sql/carerTasksCache';
import { mirrorFinancialEventById } from '@/lib/sql/financialEventsCache';
import { mirrorPlayerGameRequestById } from '@/lib/sql/playerGameRequestsCache';
import { mirrorUserBalanceSnapshotById } from '@/lib/sql/userBalanceSnapshotsCache';

export const runtime = 'nodejs';

function getStaffBonusMultiplier(bonusPercent: number) {
  if (bonusPercent <= 8) return 1.0;
  if (bonusPercent <= 20) return 0.5;
  if (bonusPercent <= 30) return 0.2;
  return 0;
}

type Body = { bonusEventId?: unknown; idempotencyKey?: unknown };

function normalizeGameName(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

const ROUTE = '/api/bonus-events/initiate-play';

function cleanText(value: unknown) {
  return String(value || '').trim();
}

function readBonusClaimSessionDebug(request: Request) {
  const appSessionId = cleanText(request.headers.get('X-App-Session-Id'));
  const playerSessionId = cleanText(request.headers.get('X-Player-Session-Id'));
  const cookieHeader = cleanText(request.headers.get('cookie'));

  return {
    cookiePresent: Boolean(cookieHeader),
    appSessionId: appSessionId || null,
    appSessionIdPrefix: appSessionId ? appSessionId.slice(0, 8) : null,
    playerSessionId: playerSessionId || null,
    playerSessionIdPrefix: playerSessionId ? playerSessionId.slice(0, 8) : null,
  };
}

export async function POST(request: Request) {
  let bonusEventId: string | null = null;
  const sessionDebug = readBonusClaimSessionDebug(request);
  try {
    console.info('[BONUS_CLAIM_REQUEST]', {
      route: ROUTE,
      method: 'POST',
      ...sessionDebug,
    });
    console.info('[BONUS_CLAIM_AUTH_START]', {
      route: ROUTE,
      method: 'POST',
      authHelper: 'requirePlayerApiUser',
      expectedAuthPath: 'app_session_sql_session_sql',
      ...sessionDebug,
    });

    const auth = await requirePlayerApiUser(request);
    if ('response' in auth) {
      const headerFlags = bonusEventsRequestHeaderFlags(request);
      console.info('[BONUS_CLAIM_AUTH_RESULT]', {
        route: ROUTE,
        ok: false,
        uid: null,
        role: null,
        auth_path: auth.timing.auth_path,
        session_source: auth.timing.session_source,
        status: auth.response.status,
        ...sessionDebug,
      });
      console.info('[BONUS_CLAIM_SESSION_SOURCE]', {
        route: ROUTE,
        ok: false,
        uid: null,
        role: null,
        auth_path: auth.timing.auth_path,
        session_source: auth.timing.session_source,
        ...sessionDebug,
      });
      logPlayerBonusSessionHeaderCheck(request, {
        route: ROUTE,
        method: 'POST',
        auth_path: auth.timing?.auth_path || null,
        reason: headerFlags.has_app_session_header && !headerFlags.has_player_session_header
          ? 'missing_player_session_header'
          : 'auth_failed',
      });
      logBonusEventsBlocked({
        route: ROUTE,
        reason: 'auth_failed',
        requiredAuth: 'player',
        receivedAuth: auth.timing?.auth_path || null,
        hasAppSessionId: headerFlags.has_app_session_header,
        hasPlayerSessionId: headerFlags.has_player_session_header,
      });
      return auth.response;
    }
    await rejectIfPlayerMaintenanceBreak(auth.user.uid, 'bonus_event');
    const body = (await request.json()) as Body;
    bonusEventId = String(body.bonusEventId || '').trim();
    if (!bonusEventId) return apiError('bonusEventId is required.', 400);

    const playerUid = auth.user.uid;
    const coadminUid =
      String(auth.user.coadminUid || auth.user.createdBy || '').trim() || null;

    console.info('[BONUS_CLAIM_AUTH_RESULT]', {
      route: ROUTE,
      ok: true,
      uid: playerUid,
      role: auth.user.role,
      auth_path: auth.authPath,
      session_source: auth.timing.session_source,
      ...sessionDebug,
    });
    console.info('[BONUS_CLAIM_SESSION_SOURCE]', {
      route: ROUTE,
      ok: true,
      uid: playerUid,
      role: auth.user.role,
      auth_path: auth.authPath,
      session_source: auth.timing.session_source,
      ...sessionDebug,
    });

    logBonusEventsInitiateAuth(request, {
      route: ROUTE,
      playerUid,
      coadminUid,
      auth_path: auth.authPath,
      session_source: auth.timing?.session_source || 'none',
      reason: 'player_bonus_claim',
    });

    logPlayerBonusAuth(request, {
      route: ROUTE,
      playerUid,
      auth_path: auth.authPath,
      session_source: auth.timing?.session_source || null,
      reason: 'player_bonus_claim',
    });

    if (!bonusEventsRequestHeaderFlags(request).has_player_session_header) {
      logBonusEventsBlocked({
        route: ROUTE,
        role: auth.user.role,
        uid: playerUid,
        reason: 'player_session_required',
        requiredAuth: 'player_session',
        receivedAuth: auth.authPath,
        hasAppSessionId: bonusEventsRequestHeaderFlags(request).has_app_session_header,
        hasPlayerSessionId: false,
      });
    }

    const idempotencyKey =
      String(body.idempotencyKey || request.headers.get('Idempotency-Key') || '').trim() || null;

    if (isAuthoritySqlWriteEnabled()) {
      const result = await initiateBonusPlayInSql({
        playerUid,
        bonusEventId,
        idempotencyKey,
      });
      logAuthoritySqlWrite('/api/bonus-events/initiate-play', {
        playerUid,
        bonusEventId,
        requestId: result.requestId,
        duplicate: result.duplicate,
      });
      invalidateBonusEventsMemoryCache(coadminUid);
      return NextResponse.json({
        success: true,
        requestId: result.requestId,
        duplicate: result.duplicate,
        authority: 'sql',
      });
    }

    const playerRef = adminDb.collection('users').doc(playerUid);
    const bonusRef = adminDb.collection('bonusEvents').doc(bonusEventId);
    const requestRef = adminDb.collection('playerGameRequests').doc();
    const taskRef = adminDb.collection('carerTasks').doc(requestLinkedCarerTaskId(requestRef.id));
    const eventRef = adminDb.collection('financialEvents').doc();
    const mirroredUserIds = new Set<string>();

    await adminDb.runTransaction(async (transaction) => {
      const [playerSnap, bonusSnap, loginSnap, existingTaskSnap] = await Promise.all([
        transaction.get(playerRef),
        transaction.get(bonusRef),
        adminDb.collection('playerGameLogins').where('playerUid', '==', playerUid).get(),
        transaction.get(taskRef),
      ]);
      if (!playerSnap.exists) throw new Error('Player profile not found.');
      if (!bonusSnap.exists) {
        throw new Error(
          'This bonus was already claimed by another player or is no longer available.'
        );
      }

      const player = playerSnap.data() as {
        role?: string;
        username?: string | null;
        coin?: number;
        coadminUid?: string | null;
        createdBy?: string | null;
        bonusBlockedUntil?: Date | { toMillis?: () => number } | null;
        automaticBonusEnabled?: boolean;
        bonusCooldownEndsAt?: string | null;
      };
      if (String(player.role || '').toLowerCase() !== 'player') {
        throw new Error('Only players can start bonus event play.');
      }
      const playerCoadminUid =
        String(player.coadminUid || '').trim() || String(player.createdBy || '').trim();
      if (!playerCoadminUid) {
        throw new Error('Player coadmin scope not found.');
      }
      const bonusBlockedUntilMs =
        player.bonusBlockedUntil instanceof Date
          ? player.bonusBlockedUntil.getTime()
          : player.bonusBlockedUntil?.toMillis?.() || 0;
      // Phase 5: mutual exclusion + risk via authoritative eligibility helper.
      assertArbCanClaimBonusEvent(
        evaluateArbEligibility({
          preference: parseArbPlayerPreferenceState(player),
          nowMs: Date.now(),
          gates: {
            playerModeEnabled: true,
            globalKillActive: false,
            featureEnabled: true,
            emergencyDisable: false,
            playerOptInAllowed: true,
            riskBlocked: bonusBlockedUntilMs > Date.now(),
            hasPublishedConfiguration: true,
          },
          grantsEnabled: false,
        })
      );

      const bonus = bonusSnap.data() as {
        coadminUid?: string;
        gameName?: string;
        bonusName?: string;
        amountNpr?: number;
        bonusPercentage?: number;
        createdByRole?: string;
        createdByUid?: string;
      };
      const baseAmount = Number(bonus.amountNpr || 0);
      const bonusPercent = Number(bonus.bonusPercentage || 0);
      if (baseAmount <= 0) throw new Error('Bonus event amount is invalid.');
      if (bonusPercent <= 0 || bonusPercent > 50) {
        throw new Error('Bonus event percentage is invalid.');
      }
      const currentCoins = Number(player.coin || 0);
      if (currentCoins < baseAmount) {
        throw new Error('Low coins: cannot initiate this bonus event.');
      }

      const bonusAddAmount = Math.max(1, Math.round((baseAmount * bonusPercent) / 100));
      const boostedAmount = baseAmount + bonusAddAmount;
      const coadminUid = String(bonus.coadminUid || '').trim();
      const gameName = String(bonus.gameName || '').trim();
      if (!coadminUid) throw new Error('Bonus event coadmin scope missing.');
      if (coadminUid !== playerCoadminUid) {
        throw new Error('Forbidden: bonus event is outside your coadmin scope.');
      }
      const maintenanceBreak = await getCoadminMaintenanceBreak(playerCoadminUid);
      if (maintenanceBreak.enabled) {
        console.info('[MAINTENANCE] blocked player action', {
          action: 'bonus_event',
          playerUid,
          coadminUid: playerCoadminUid,
        });
        throw new Error(`MAINTENANCE_BREAK:${maintenanceBreak.message}`);
      }
      const assignedLogin = loginSnap.docs
        .map((docSnap) => docSnap.data() as { gameName?: string; gameUsername?: string })
        .find(
          (row) =>
            normalizeGameName(String(row.gameName || '')) === normalizeGameName(gameName) &&
            String(row.gameUsername || '').trim().length > 0
        );
      const assignedGameUsername = String(assignedLogin?.gameUsername || '').trim();
      const [coadminGameSnap, legacyGameSnap] = await Promise.all([
        adminDb.collection('gameLogins').where('coadminUid', '==', coadminUid).get(),
        adminDb.collection('gameLogins').where('createdBy', '==', coadminUid).get(),
      ]);
      const gameCredential = findRequestLinkedGameCredential(
        [...coadminGameSnap.docs, ...legacyGameSnap.docs].map((docSnap) => docSnap.data()),
        gameName
      );
      const createdAt = FieldValue.serverTimestamp();
      let staffRewardAudit: Record<string, unknown> | null = null;

      if (String(bonus.createdByRole || '').toLowerCase() === 'staff') {
        const staffRef = adminDb.collection('users').doc(String(bonus.createdByUid || '').trim());
        const staffSnap = await transaction.get(staffRef);
        const staffData = staffSnap.exists
          ? (staffSnap.data() as { cashBoxNpr?: number })
          : { cashBoxNpr: 0 };
        const normalizedAmount = Math.max(1, baseAmount) / 1000;
        const amountFactor = Math.min(3.5, 0.6 + Math.log10(normalizedAmount + 1) * 2.2);
        const percentPenalty = Math.max(0.25, 1.2 - bonusPercent / 60);
        const randomVariance = 0.9 + Math.random() * 0.3;
        const rawReward = amountFactor * percentPenalty * randomVariance;
        const multiplier = getStaffBonusMultiplier(bonusPercent);
        const minReward = bonusPercent <= 8 ? 0.2 : 0;
        const reward = multiplier === 0 ? 0 : Number(Math.max(minReward, rawReward * multiplier).toFixed(2));
        const cashBoxBefore = Number(staffData.cashBoxNpr || 0);
        const cashBoxAfter = cashBoxBefore + reward;
        transaction.set(
          staffRef,
          { cashBoxNpr: cashBoxAfter },
          { merge: true }
        );
        staffRewardAudit = {
          rewardAmountNpr: reward,
          rewardReason: 'bonus_staff_reward',
          cashBoxBefore,
          cashBoxAfter,
          cashBoxDelta: cashBoxAfter - cashBoxBefore,
          actorUid: auth.user.uid,
          actorRole: auth.user.role,
          sourceRequestId: requestRef.id,
          bonusEventId,
        };
        mirroredUserIds.add(String(bonus.createdByUid || '').trim());
      }

      transaction.update(playerRef, {
        coin: currentCoins - baseAmount,
        activeBonusEventId: bonusEventId,
        activeBonusStaffUid:
          String(bonus.createdByRole || '').toLowerCase() === 'staff'
            ? String(bonus.createdByUid || '').trim()
            : null,
        activeBonusEventName: String(bonus.bonusName || '').trim() || null,
        activeBonusGameName: String(bonus.gameName || '').trim() || null,
        activeBonusAmountNpr: baseAmount,
        activeBonusPercentage: bonusPercent,
      });
      transaction.set(requestRef, {
        playerUid,
        gameName,
        amount: boostedAmount,
        baseAmount,
        bonusPercentage: bonusPercent,
        bonusEventId,
        type: 'recharge',
        status: 'pending',
        createdBy: coadminUid,
        coadminUid,
        createdAt,
        completedAt: null,
        pokedAt: null,
        pokeMessage: null,
        coinDeductedOnRequest: true,
      });
      if (!existingTaskSnap.exists) {
        console.info('[GAME_REQUEST_API][BONUS] creating linked carer task', {
          requestId: requestRef.id,
          taskId: taskRef.id,
          type: 'recharge',
          bonusEventId,
        });
        transaction.set(
          taskRef,
          buildPendingRequestLinkedCarerTaskPayload({
            requestId: requestRef.id,
            coadminUid,
            type: 'recharge',
            playerUid,
            playerUsername: String(player.username || '').trim() || 'Player',
            gameName,
            amount: boostedAmount,
            currentUsername: assignedGameUsername,
            createdAt,
            gameCredential,
          })
        );
        console.info('[GAME_REQUEST_API][BONUS] linked carer task created', {
          requestId: requestRef.id,
          taskId: taskRef.id,
          type: 'recharge',
          bonusEventId,
        });
      } else {
        console.info('[GAME_REQUEST_API][BONUS] linked carer task already exists, skipped', {
          requestId: requestRef.id,
          taskId: taskRef.id,
          type: 'recharge',
          bonusEventId,
        });
      }
      transaction.set(eventRef, {
        playerUid,
        coadminUid,
        amountNpr: bonusAddAmount,
        type: 'bonus',
        bonusEventId,
        requestId: requestRef.id,
        ...(staffRewardAudit || {}),
        createdAt: FieldValue.serverTimestamp(),
      });
      transaction.delete(bonusRef);
      mirroredUserIds.add(playerUid);
    });
    console.info('[GAME_REQUEST_API][BONUS] request/task/financial event committed atomically', {
      requestId: requestRef.id,
      taskId: taskRef.id,
      type: 'recharge',
      bonusEventId,
    });
    invalidateBonusEventsMemoryCache(coadminUid);
    void mirrorCarerTaskById(taskRef.id, 'appbeg_bonus_initiate_play');
    void mirrorPlayerGameRequestById(requestRef.id, 'appbeg_bonus_initiate_play');
    void mirrorFinancialEventById(eventRef.id, 'appbeg_bonus_initiate_play');
    mirroredUserIds.forEach((uid) => {
      void mirrorUserBalanceSnapshotById(uid, 'appbeg_bonus_initiate_play');
    });

    return NextResponse.json({ success: true, requestId: requestRef.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to initiate bonus play.';
    console.info('[BONUS_CLAIM_ERROR]', {
      route: ROUTE,
      bonusEventId,
      error: message,
      ...sessionDebug,
    });
    if (message.startsWith('MAINTENANCE_BREAK:')) {
      return maintenanceBreakApiResponse(message.replace(/^MAINTENANCE_BREAK:/, ''));
    }
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code || '')
        : '';
    const blockers =
      error && typeof error === 'object' && Array.isArray((error as { blockers?: unknown }).blockers)
        ? (error as { blockers: string[] }).blockers
        : undefined;
    if (code === 'auto_bonus_enabled' || code === 'auto_bonus_cooldown' || code === 'risk_blocked') {
      return NextResponse.json(
        {
          error: message,
          code,
          blockers: blockers || [code],
        },
        { status: 403 }
      );
    }
    const status = /not authenticated|authorization|token/i.test(message)
      ? 401
      : /forbidden/i.test(message)
        ? 403
        : /required|not found|invalid|low coins|only|blocked|locked/i.test(message)
          ? 400
          : 409;
    return NextResponse.json(
      blockers ? { error: message, code: code || undefined, blockers } : { error: message },
      { status }
    );
  }
}
