import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { adminAuth, adminDb } from '@/lib/firebase/admin';
import {
  REFERRAL_REWARD_COINS,
} from '@/lib/economy/policy';
import {
  buildUniqueReferralCodeCandidates,
  findFreeReferralCodeInTransaction,
  setReferralCodeIndexInTransaction,
} from '@/lib/referral/referralCodeAdmin';
import {
  apiError,
  requireApiUser,
  scopedCoadminUid,
} from '@/lib/firebase/apiAuth';
import { assertValidGameUsername } from '@/lib/games/gameUsernameRule';
import { recordGameUsername } from '@/lib/sql/usernameRegistry';
import { mirrorPlayerById } from '@/lib/sql/playersCache';
import { mirrorReferralById, mirrorReferralCodeByCode } from '@/lib/sql/referralsCache';
import { mirrorCarerTaskById } from '@/lib/sql/carerTasksCache';
import { mirrorUserBalanceSnapshotById } from '@/lib/sql/userBalanceSnapshotsCache';
import {
  isAuthoritySqlWriteEnabled,
  logAuthorityFirestoreFallbackBlocked,
  logAuthoritySqlWrite,
} from '@/lib/server/authoritySqlWrite';
import { createCoadminPlayerAccount } from '@/lib/server/coadminPlayerCreation';
import { completeCanonicalPlayerCreation } from '@/lib/server/canonicalPlayerCreation';
import { scheduleAutoClaimPendingTaskOnCreate } from '@/lib/sql/authorityAutoClaim';
import { lookupReferrerByCodeFromSql } from '@/lib/sql/authorityReferralCodes';
import { lookupUserDirectoryFromSql } from '@/lib/sql/authorityLookup';
import {

  createUserDirectoryInSql,
  isActiveUsernameTakenInSql,
} from '@/lib/sql/userDirectoryWrite';

export const runtime = 'nodejs';

type CreatableRole = 'staff' | 'carer' | 'player';

type GameLoginTaskSeed = {
  id: string;
  gameName: string;
  username?: unknown;
  password?: unknown;
  backendUrl?: unknown;
  frontendUrl?: unknown;
  siteUrl?: unknown;
};

function makeHiddenEmail(username: string) {
  return `${username}@app.local`;
}

function isCreatableRole(role: string): role is CreatableRole {
  return ['staff', 'carer', 'player'].includes(role);
}

function parseReferralCodeInput(value: unknown) {
  const code = String(value || '').trim();
  if (!code) {
    return '';
  }
  if (!/^\d{6,10}$/.test(code)) {
    throw new Error('Invalid referral code.');
  }
  return code;
}

function normalizeCarerTaskGameName(gameName: string) {
  return gameName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

function createGameUsernameTaskId(coadminUid: string, playerUid: string, gameName: string) {
  return `create_game_username__${coadminUid}__${playerUid}__${normalizeCarerTaskGameName(
    gameName
  )}`;
}

function normalizeTaskUrl(value?: unknown) {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return null;
  }
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function normalizeTaskText(value?: unknown) {
  return String(value || '').trim() || null;
}

function resolveTaskGameAccess(game: GameLoginTaskSeed) {
  const loginUrl = normalizeTaskUrl(game.backendUrl || game.siteUrl || '');
  const siteUrl = normalizeTaskUrl(game.siteUrl || game.frontendUrl || game.backendUrl || '');

  return {
    loginUrl,
    gameLoginUrl: loginUrl,
    lobbyUrl: loginUrl,
    siteUrl,
    baseUrl: loginUrl || siteUrl,
    gameCredentialUsername: normalizeTaskText(game.username),
    gameCredentialPassword: normalizeTaskText(game.password),
  };
}

async function getGameLoginTaskSeedsForCoadmin(coadminUid: string) {
  const snapshots = await Promise.all(
    (['coadminUid', 'createdBy'] as const).map((field) =>
      adminDb.collection('gameLogins').where(field, '==', coadminUid).limit(100).get()
    )
  );
  const byNormalizedGame = new Map<string, GameLoginTaskSeed>();

  for (const snap of snapshots) {
    for (const docSnap of snap.docs) {
      const data = docSnap.data() as Omit<GameLoginTaskSeed, 'id' | 'gameName'> & {
        gameName?: unknown;
      };
      const gameName = String(data.gameName || '').trim();
      const normalizedGame = normalizeCarerTaskGameName(gameName);
      if (!gameName || !normalizedGame || byNormalizedGame.has(normalizedGame)) {
        continue;
      }
      byNormalizedGame.set(normalizedGame, {
        id: docSnap.id,
        gameName,
        username: data.username,
        password: data.password,
        backendUrl: data.backendUrl,
        frontendUrl: data.frontendUrl,
        siteUrl: data.siteUrl,
      });
    }
  }

  return Array.from(byNormalizedGame.values());
}

function setInitialCreateUsernameTasksForPlayerInTransaction(input: {
  transaction: FirebaseFirestore.Transaction;
  games: GameLoginTaskSeed[];
  coadminUid: string;
  playerUid: string;
  playerUsername: string;
  playerPassword: string;
}) {
  const now = FieldValue.serverTimestamp();
  const taskIds: string[] = [];

  for (const game of input.games) {
    const taskId = createGameUsernameTaskId(input.coadminUid, input.playerUid, game.gameName);
    const taskRef = adminDb.collection('carerTasks').doc(taskId);
    input.transaction.set(taskRef, {
      coadminUid: input.coadminUid,
      coadminId: input.coadminUid,
      type: 'create_game_username',
      action: 'createUsername',
      taskAction: 'createUsername',
      playerUid: input.playerUid,
      playerId: input.playerUid,
      playerUsername: input.playerUsername,
      username: input.playerUsername,
      password: input.playerPassword,
      gameName: game.gameName,
      game: game.gameName,
      amount: null,
      requestId: null,
      status: 'pending',
      assignedCarerUid: null,
      assignedCarer: null,
      assignedCarerUsername: null,
      claimedStatus: null,
      claimedAt: null,
      claimedByUid: null,
      claimedByUsername: null,
      startedAt: null,
      runningAt: null,
      expiresAt: null,
      completedAt: null,
      cancelledAt: null,
      failedAt: null,
      ttlExpiresAt: null,
      completedByCarerUid: null,
      completedByCarerUsername: null,
      automationStatus: null,
      automationJobId: null,
      linkedJobId: null,
      currentJobId: null,
      activeJobId: null,
      assignedJobStatus: null,
      automationError: null,
      error: null,
      failureReason: null,
      retryPending: false,
      resetToPendingAt: null,
      returnedToPendingAt: null,
      pendingSince: now,
      lastHeartbeatAt: null,
      queuedAt: null,
      automationUpdatedAt: null,
      updatedAt: now,
      createdAt: now,
      isPoked: false,
      pokedAt: null,
      pokeMessage: null,
      playerLoginUsername: input.playerUsername,
      playerLoginPassword: input.playerPassword,
      ...resolveTaskGameAccess(game),
    });
    taskIds.push(taskId);
  }

  return taskIds;
}

async function recordPlayerLoginUsernameAfterFirebaseSave(input: {
  username: string;
  playerUid: string;
  coadminUid: string;
}) {
  try {
    await recordGameUsername({
      username: input.username,
      game: 'player_login',
      playerUid: input.playerUid,
      coadminUid: input.coadminUid,
      source: 'appbeg',
    });
  } catch (error) {
    console.warn('[PLAYER_LOGIN_USERNAME_REGISTRY] record failed after Firebase player creation', {
      username: input.username,
      playerUid: input.playerUid,
      coadminUid: input.coadminUid,
      error,
    });
  }
}

export async function POST(request: Request) {
  let createdAuthUid: string | null = null;
  try {
    const auth = await requireApiUser(request, ['admin', 'coadmin', 'staff']);
    if ('response' in auth) return auth.response;

    const body = await request.json();

    const role = String(body.role || 'staff').trim().toLowerCase();
    const username =
      role === 'player'
        ? String(body.username || '').trim()
        : String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    const requestedOwnerUid = String(body.coadminUid || body.createdBy || '').trim();
    const callerScopeUid = scopedCoadminUid(auth.user);
    const ownerCoadminUid =
      auth.user.role === 'admin' ? requestedOwnerUid : String(callerScopeUid || '').trim();
    const createdByStaffId = role === 'player' && auth.user.role === 'staff' ? auth.user.uid : null;

    let referralCodeInput = '';
    try {
      referralCodeInput = parseReferralCodeInput(body.referralCodeInput);
    } catch {
      return NextResponse.json({ error: 'Invalid referral code.' }, { status: 400 });
    }

    if (!username) {
      return NextResponse.json({ error: 'Username is required.' }, { status: 400 });
    }
    if (role === 'player') {
      assertValidGameUsername(username);
    }

    if (password.length < 6) {
      return NextResponse.json(
        { error: 'Password must be at least 6 characters.' },
        { status: 400 }
      );
    }

    if (!isCreatableRole(role)) {
      return NextResponse.json({ error: 'Invalid user role.' }, { status: 400 });
    }

    if (!ownerCoadminUid) {
      return NextResponse.json(
        { error: 'coadminUid is required.' },
        { status: 400 }
      );
    }

    if (auth.user.role !== 'admin' && role !== 'player' && auth.user.role === 'staff') {
      return apiError('Staff can only create scoped player accounts.', 403);
    }

    if (auth.user.role !== 'admin' && requestedOwnerUid && requestedOwnerUid !== ownerCoadminUid) {
      return apiError('Cannot create users outside your coadmin scope.', 403);
    }

    const authoritySql = isAuthoritySqlWriteEnabled();
    if (authoritySql) {
      const owner = await lookupUserDirectoryFromSql(ownerCoadminUid);
      if (!owner || String(owner.role || '').toLowerCase() !== 'coadmin') {
        return apiError('Owner coadmin scope is invalid.', 403);
      }
    } else {
      const ownerSnap = await adminDb.collection('users').doc(ownerCoadminUid).get();
      if (!ownerSnap.exists || String(ownerSnap.data()?.role || '').toLowerCase() !== 'coadmin') {
        return apiError('Owner coadmin scope is invalid.', 403);
      }
    }

    const usernameTakenInSql = await isActiveUsernameTakenInSql(username);
    const usernameTakenInFirestore = authoritySql
      ? false
      : !(await adminDb.collection('users').where('username', '==', username).limit(1).get()).empty;

    if (usernameTakenInFirestore || usernameTakenInSql) {
      return NextResponse.json({ error: 'Username already exists.' }, { status: 409 });
    }

    let validatedReferrerUid: string | null = null;
    let validatedReferrerUsername: string | null = null;
    if (role === 'player' && referralCodeInput) {
      if (authoritySql) {
        const referrer = await lookupReferrerByCodeFromSql(referralCodeInput);
        if (!referrer?.uid) {
          return NextResponse.json({ error: 'Invalid referral code.' }, { status: 400 });
        }
        validatedReferrerUid = referrer.uid;
        validatedReferrerUsername = referrer.username;
      } else {
        const referrerSnap = await adminDb
          .collection('users')
          .where('referralCode', '==', referralCodeInput)
          .where('role', '==', 'player')
          .limit(1)
          .get();

        if (referrerSnap.empty) {
          return NextResponse.json({ error: 'Invalid referral code.' }, { status: 400 });
        }

        const referrerDoc = referrerSnap.docs[0];
        validatedReferrerUid = referrerDoc.id;
        validatedReferrerUsername = String(referrerDoc.data().username || 'Player');
      }
    }

    if (role === 'player' && authoritySql) {
      const result = await createCoadminPlayerAccount({
        username,
        password,
        ownerCoadminUid,
        createdByStaffId,
        referralCodeInput: referralCodeInput || null,
        actorUid: auth.user.uid,
        actorRole: auth.user.role,
      });
      result.createdTaskIds.forEach((taskId) => {
        console.info('[CREATE_PLAYER_TASK] task created id=%s authority=sql', taskId);
      });
      logAuthoritySqlWrite('/api/admin/create-staff', {
        role: 'player',
        uid: result.uid,
        referralApplied: result.referralApplied,
        taskCount: result.createdTaskIds.length,
      });
      return NextResponse.json({
        success: true,
        uid: result.uid,
        message: `${role} created.`,
        referralApplied: result.referralApplied,
        referralBonusCoins: result.referralBonusCoins,
        referredByUid: result.referredByUid,
        referredByUsername: result.referredByUsername,
      });
    }

    const email = makeHiddenEmail(username);

    const authUser = await adminAuth.createUser({
      email,
      password,
      displayName: username,
      disabled: false,
    });
    createdAuthUid = authUser.uid;

    const userRef = adminDb.collection('users').doc(authUser.uid);
    let referralApplied = false;
    let referralBonusCoins = 0;
    let referredByUid: string | null = null;
    let referredByUsername: string | null = null;
    let referredByCode: string | null = null;

    if (role === 'player' && authoritySql) {
      const sqlResult = await completeCanonicalPlayerCreation({
        uid: authUser.uid,
        username,
        email,
        password,
        ownerCoadminUid,
        createdByStaffId,
        referralCodeInput: referralCodeInput || null,
        actorUid: auth.user.uid,
        actorRole: auth.user.role,
      });
      createdAuthUid = null;
      referralApplied = sqlResult.referralApplied;
      referralBonusCoins = sqlResult.referralBonusCoins;
      referredByUid = sqlResult.referredByUid;
      referredByUsername = sqlResult.referredByUsername;
      sqlResult.createdTaskIds.forEach((taskId) => {
        console.info('[CREATE_PLAYER_TASK] task created id=%s authority=sql', taskId);
      });
      logAuthoritySqlWrite('/api/admin/create-staff', {
        role: 'player',
        uid: authUser.uid,
        referralApplied: sqlResult.referralApplied,
        taskCount: sqlResult.createdTaskIds.length,
      });
    } else if (role === 'player') {
      const referralCandidates = buildUniqueReferralCodeCandidates(40);
      const gameTaskSeeds = await getGameLoginTaskSeedsForCoadmin(ownerCoadminUid);
      const now = new Date();
      let createdTaskIds: string[] = [];
      let createdReferralCode = '';
      const createdReferralIds: string[] = [];

      await adminDb.runTransaction(async (transaction) => {
        let referrerRef: FirebaseFirestore.DocumentReference | null = null;
        let referrerData: FirebaseFirestore.DocumentData | null = null;

        if (validatedReferrerUid) {
          if (validatedReferrerUid === authUser.uid) {
            throw new Error('A player cannot refer themselves.');
          }
          referrerRef = adminDb.collection('users').doc(validatedReferrerUid);
          const referrerSnap = await transaction.get(referrerRef);
          if (!referrerSnap.exists) {
            throw new Error('Invalid referral code.');
          }
          referrerData = referrerSnap.data() || null;
          referralBonusCoins = REFERRAL_REWARD_COINS;
          referredByUid = validatedReferrerUid;
          referredByUsername =
            validatedReferrerUsername || String(referrerData?.username || 'Player');
          referredByCode = referralCodeInput;
          referralApplied = true;
        }

        const nextReferralCode = await findFreeReferralCodeInTransaction(
          adminDb,
          transaction,
          referralCandidates
        );
        if (!nextReferralCode) {
          throw new Error('Failed to generate a unique referral code. Please try again.');
        }
        setReferralCodeIndexInTransaction(adminDb, transaction, nextReferralCode, authUser.uid);
        createdReferralCode = nextReferralCode;

        transaction.set(userRef, {
          uid: authUser.uid,
          username,
          email,
          role,
          createdBy: ownerCoadminUid,
          coadminUid: ownerCoadminUid,
          createdAt: now,
          status: 'active',
          coin: 0,
          cash: 0,
          promoLockedCoins: 0,
          referralCode: nextReferralCode,
          referredByUid,
          referredByCode,
          referralBonusCoins: referralApplied ? referralBonusCoins : 0,
          referralCreatedAt: referralApplied ? now : null,
          referralRewardStatus: referralApplied ? 'pending_first_recharge' : null,
          referralQualifiedAt: null,
          referralRewardClaimedAt: null,
          createdByStaffId,
        });

        if (referrerRef && referrerData) {
          const referralLogRef = adminDb.collection('referrals').doc();
          createdReferralIds.push(referralLogRef.id);
          transaction.set(referralLogRef, {
            referrerUid: referrerRef.id,
            referrerUsername: String(referrerData.username || 'Player'),
            referredPlayerUid: authUser.uid,
            referredPlayerUsername: username,
            referralCode: referralCodeInput,
            rewardCoins: referralBonusCoins,
            status: 'pending_first_recharge',
            createdAt: now,
            qualifiedAt: null,
            claimedAt: null,
          });
        }

        createdTaskIds = setInitialCreateUsernameTasksForPlayerInTransaction({
          transaction,
          games: gameTaskSeeds,
          coadminUid: ownerCoadminUid,
          playerUid: authUser.uid,
          playerUsername: username,
          playerPassword: password,
        });
      });
      createdAuthUid = null;
      createdTaskIds.forEach((taskId) => {
        console.info('[CREATE_PLAYER_TASK] task created id=%s', taskId);
      });
      void mirrorPlayerById(authUser.uid, 'appbeg_create_player');
      void mirrorUserBalanceSnapshotById(authUser.uid, 'appbeg_create_player');
      if (createdReferralCode) {
        void mirrorReferralCodeByCode(createdReferralCode, 'appbeg_create_player');
      }
      createdReferralIds.forEach((referralId) => {
        void mirrorReferralById(referralId, 'appbeg_create_player');
      });
      createdTaskIds.forEach((taskId) => {
        void mirrorCarerTaskById(taskId, 'appbeg_create_player');
        scheduleAutoClaimPendingTaskOnCreate({
          taskId,
          coadminUid: ownerCoadminUid,
          trigger: 'appbeg_create_player_firestore',
        });
      });
      await recordPlayerLoginUsernameAfterFirebaseSave({
        username,
        playerUid: authUser.uid,
        coadminUid: ownerCoadminUid,
      });
    } else {
      const workerUser = {
        uid: authUser.uid,
        username,
        email,
        role,
        createdBy: ownerCoadminUid,
        coadminUid: ownerCoadminUid,
        createdAt: new Date(),
        status: 'active',
      };
      const workerStartedAt = Date.now();

      try {
        await createUserDirectoryInSql({
          uid: authUser.uid,
          username,
          email,
          role,
          status: 'active',
          coadminUid: ownerCoadminUid,
          createdBy: ownerCoadminUid,
          password,
          rawData: workerUser,
          actorUid: auth.user.uid,
          actorRole: auth.user.role,
        });
      } catch (error) {
        console.info('[USER_DIRECTORY_SQL]', {
          action: 'create_user',
          route: 'create_staff',
          uid: authUser.uid,
          role,
          actorUid: auth.user.uid,
          sql_ok: false,
          firebase_create_ok: true,
          firestore_mirror_ok: false,
          durationMs: Date.now() - workerStartedAt,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }

      let firestoreMirrorOk = false;
      if (authoritySql) {
        logAuthorityFirestoreFallbackBlocked('/api/admin/create-staff', 'users.set', {
          uid: authUser.uid,
          role,
        });
      } else {
        try {
          await userRef.set(workerUser);
          firestoreMirrorOk = true;
          void mirrorUserBalanceSnapshotById(authUser.uid, 'appbeg_create_worker');
        } catch (error) {
          console.warn('[USER_DIRECTORY_SQL] firestore mirror failed', {
            action: 'create_user',
            route: 'create_staff',
            uid: authUser.uid,
            role,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      createdAuthUid = null;

      console.info('[USER_DIRECTORY_SQL]', {
        action: 'create_user',
        route: 'create_staff',
        uid: authUser.uid,
        role,
        actorUid: auth.user.uid,
        sql_ok: true,
        firebase_create_ok: true,
        firestore_mirror_ok: firestoreMirrorOk,
        durationMs: Date.now() - workerStartedAt,
      });

      return NextResponse.json({
        success: true,
        uid: authUser.uid,
        message: `${role} created.`,
        referralApplied,
        referralBonusCoins,
        referredByUid,
        referredByUsername,
        sqlOk: true,
        firebaseMirrorOk: true,
        firestoreMirrorOk,
      });
    }

    return NextResponse.json({
      success: true,
      uid: authUser.uid,
      message: `${role} created.`,
      referralApplied,
      referralBonusCoins,
      referredByUid,
      referredByUsername,
    });
  } catch (err: unknown) {
    if (createdAuthUid) {
      try {
        await adminAuth.deleteUser(createdAuthUid);
      } catch {
        // If cleanup fails, surface original error while avoiding secondary crash.
      }
    }
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : 'Failed to create user.',
      },
      { status: 500 }
    );
  }
}
