import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import { apiError, belongsToScope, requireApiUser, scopedCoadminUid } from '@/lib/firebase/apiAuth';
import {
  authoritySqlWriteEnvLogFields,
  isAuthoritySqlWriteEnabled,
  logAuthoritySqlWrite,
} from '@/lib/server/authoritySqlWrite';
import { giveFreeplayGiftInSql } from '@/lib/sql/authorityFreeplay';
import { getPlayerMirrorPoolStats } from '@/lib/sql/playerMirrorCommon';
import { mirrorFreeplayPendingGiftByPlayerUid } from '@/lib/sql/freeplayPendingGiftsCache';

export const runtime = 'nodejs';

const ROUTE = '/api/coadmin/freeplay/give';

type PlayerCandidate = {
  uid: string;
  username: string;
};

function isEligiblePlayer(data: Record<string, unknown>) {
  return (
    String(data.role || '').toLowerCase() === 'player' &&
    String(data.status || '').toLowerCase() !== 'disabled'
  );
}

async function loadPlayersForCoadmin(coadminUid: string): Promise<PlayerCandidate[]> {
  const [scopedSnap, legacySnap] = await Promise.all([
    adminDb.collection('users').where('coadminUid', '==', coadminUid).get(),
    adminDb.collection('users').where('createdBy', '==', coadminUid).get(),
  ]);
  const players = new Map<string, PlayerCandidate>();

  [...scopedSnap.docs, ...legacySnap.docs].forEach((docSnap) => {
    const data = docSnap.data() as Record<string, unknown>;
    if (!isEligiblePlayer(data)) {
      return;
    }
    players.set(docSnap.id, {
      uid: docSnap.id,
      username: String(data.username || '').trim() || 'Player',
    });
  });

  return [...players.values()];
}

async function resolveFirestoreGiveTarget(input: {
  coadminUid: string;
  targetPlayerUid?: string | null;
  reason?: string | null;
}) {
  const coadminUid = String(input.coadminUid || '').trim();
  const targetPlayerUid = String(input.targetPlayerUid || '').trim();
  const reason = String(input.reason || '').trim() || null;
  const players = await loadPlayersForCoadmin(coadminUid);
  if (players.length === 0) {
    throw new Error('No active players are assigned to your account.');
  }

  const pendingStates = await Promise.all(
    players.map(async (player) => {
      const markerSnap = await adminDb.collection('freeplayPendingGifts').doc(player.uid).get();
      const status = markerSnap.exists
        ? String((markerSnap.data() as { status?: string }).status || '').toLowerCase()
        : '';
      return status === 'pending' ? player.uid : null;
    })
  );
  const pendingPlayerUids = new Set(pendingStates.filter((uid): uid is string => Boolean(uid)));

  if (targetPlayerUid) {
    console.info('[FREEPLAY_GIVE_TARGET_SELECTED]', {
      coadminUid,
      targetPlayerUid,
      reason,
    });
    const playerRef = adminDb.collection('users').doc(targetPlayerUid);
    const playerSnap = await playerRef.get();
    if (!playerSnap.exists) {
      console.info('[FREEPLAY_GIVE_TARGET_SCOPE_DENIED]', {
        coadminUid,
        targetPlayerUid,
        reason: 'player_not_found',
      });
      throw new Error('Selected player is no longer eligible.');
    }
    const playerData = playerSnap.data() as Record<string, unknown>;
    if (!belongsToScope(playerData, coadminUid) || !isEligiblePlayer(playerData)) {
      console.info('[FREEPLAY_GIVE_TARGET_SCOPE_DENIED]', {
        coadminUid,
        targetPlayerUid,
        reason: 'outside_scope_or_ineligible',
      });
      throw new Error('Forbidden: this player is outside your scope.');
    }
    const scopedPlayer = players.find((player) => player.uid === targetPlayerUid);
    if (!scopedPlayer) {
      console.info('[FREEPLAY_GIVE_TARGET_SCOPE_DENIED]', {
        coadminUid,
        targetPlayerUid,
        reason: 'player_not_in_scope_list',
      });
      throw new Error('Selected player is no longer eligible.');
    }
    if (pendingPlayerUids.has(targetPlayerUid)) {
      throw new Error('This player already has a pending FreePlay gift.');
    }
    console.info('[FREEPLAY_GIVE_TARGET_SCOPE_OK]', {
      coadminUid,
      targetPlayerUid,
      playerUsername: scopedPlayer.username,
    });
    console.info('[FREEPLAY_GIVE_SPECIFIC_PLAYER]', {
      coadminUid,
      targetPlayerUid,
      reason,
    });
    return scopedPlayer;
  }

  const eligiblePlayers = players.filter((player) => !pendingPlayerUids.has(player.uid));
  if (eligiblePlayers.length === 0) {
    throw new Error('Every eligible player already has a pending FreePlay gift.');
  }

  const selectedPlayer =
    eligiblePlayers[Math.floor(Math.random() * eligiblePlayers.length)];
  console.info('[FREEPLAY_GIVE_RANDOM_PLAYER]', {
    coadminUid,
    playerUid: selectedPlayer.uid,
    playerUsername: selectedPlayer.username,
  });
  return selectedPlayer;
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  try {
    const auth = await requireApiUser(request, ['coadmin', 'staff']);
    if ('response' in auth) return auth.response;

    const scopeUid = scopedCoadminUid(auth.user);
    if (!scopeUid) {
      return apiError('Your account is not linked to a coadmin scope.', 403);
    }

    const body = (await request.json().catch(() => ({}))) as {
      targetPlayerUid?: unknown;
      amount?: unknown;
      reason?: unknown;
      idempotencyKey?: unknown;
    };
    const targetPlayerUid = String(body.targetPlayerUid || '').trim() || null;
    const reason = String(body.reason || '').trim() || null;
    const idempotencyKey =
      String(body.idempotencyKey || request.headers.get('Idempotency-Key') || '').trim() || null;

    if (auth.user.role === 'staff' && !isAuthoritySqlWriteEnabled()) {
      return apiError('Staff Free Play requires Staff Coins to be available.', 503);
    }

    if (isAuthoritySqlWriteEnabled()) {
      const result = await giveFreeplayGiftInSql({
        coadminUid: scopeUid,
        actorUid: auth.user.uid,
        actorRole: auth.user.role,
        targetPlayerUid,
        reason: targetPlayerUid ? reason || 'manual_specific_player' : reason,
        idempotencyKey,
      });
      const poolStats = getPlayerMirrorPoolStats();

      logAuthoritySqlWrite(ROUTE, {
        ...authoritySqlWriteEnvLogFields(),
        coadminUid: scopeUid,
        actorUid: auth.user.uid,
        actorRole: auth.user.role,
        playerUid: result.playerUid,
        giftId: result.giftId,
        duplicate: result.duplicate,
        targetPlayerUid,
        reason,
        route: ROUTE,
        pool_totalCount: poolStats?.totalCount ?? null,
        pool_idleCount: poolStats?.idleCount ?? null,
        pool_waitingCount: poolStats?.waitingCount ?? null,
        pool_max: poolStats?.max ?? null,
        duration_ms: Date.now() - startedAt,
      });

      return NextResponse.json({
        success: true,
        playerUsername: result.playerUsername,
        playerUid: result.playerUid,
        giftId: result.giftId,
        duplicate: result.duplicate,
        staffWalletBalanceCoin: result.staffWalletBalanceCoin ?? null,
        authority: 'sql',
      });
    }

    const selectedPlayer = await resolveFirestoreGiveTarget({
      coadminUid: scopeUid,
      targetPlayerUid,
      reason: targetPlayerUid ? reason || 'manual_specific_player' : reason,
    });
    const playerRef = adminDb.collection('users').doc(selectedPlayer.uid);
    const giftRef = adminDb.collection('freeplayGifts').doc();
    const markerRef = adminDb.collection('freeplayPendingGifts').doc(selectedPlayer.uid);

    await adminDb.runTransaction(async (transaction) => {
      const [playerSnap, markerSnap] = await Promise.all([
        transaction.get(playerRef),
        transaction.get(markerRef),
      ]);
      if (!playerSnap.exists) {
        throw new Error('Selected player no longer exists.');
      }
      const playerData = playerSnap.data() as Record<string, unknown>;
      if (!belongsToScope(playerData, scopeUid) || !isEligiblePlayer(playerData)) {
        throw new Error('Selected player is no longer eligible.');
      }
      if (
        markerSnap.exists &&
        String((markerSnap.data() as { status?: string }).status || '').toLowerCase() ===
          'pending'
      ) {
        throw new Error('This player already has a pending FreePlay gift.');
      }

      const gift = {
        type: 'freeplay',
        status: 'pending',
        coadminUid: scopeUid,
        playerUid: selectedPlayer.uid,
        createdAt: FieldValue.serverTimestamp(),
        claimedAt: null,
        amount: null,
      };
      transaction.set(giftRef, gift);
      transaction.set(markerRef, {
        ...gift,
        giftId: giftRef.id,
      });
    });

    void mirrorFreeplayPendingGiftByPlayerUid(
      selectedPlayer.uid,
      'coadmin_freeplay_give'
    ).then((mirrorOk) => {
      console.info('[FREEPLAY_PENDING_CACHE]', {
        source: 'firestore_write',
        playerUid: selectedPlayer.uid,
        mirror_ok: mirrorOk,
        action: 'give',
        targetPlayerUid,
        reason,
      });
    });

    return NextResponse.json({
      success: true,
      playerUsername: selectedPlayer.username,
      playerUid: selectedPlayer.uid,
      authority: 'firestore',
    });
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : 'Failed to give FreePlay gift.';
    const message = /insufficient_staff_freeplay_coins/i.test(rawMessage)
      ? 'You need at least 3 Staff Coins to give Free Play.'
      : rawMessage;
    const status = /authorization|token/i.test(message)
      ? 401
      : /forbidden|outside your scope/i.test(message)
        ? 403
        : /at least 3 Staff Coins/i.test(message)
          ? 409
        : /pending/i.test(message)
          ? 409
          : /player|eligible|active/i.test(message)
            ? 400
            : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
