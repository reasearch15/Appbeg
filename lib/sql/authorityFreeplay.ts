import 'server-only';

import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';

import { cleanText, getPlayerMirrorPool } from '@/lib/sql/playerMirrorCommon';
import {
  claimAuthorityOperation,
  insertAuthorityLedgerEvent,
  logAuthPayloadPreTxnRemoved,
  readAuthorityOperationPayloadWithClient,
} from '@/lib/sql/authorityLedger';
import {
  insertLiveOutboxEventWithClient,
  insertLiveOutboxEventsBatch,
  playerFreeplayLiveChannel,
  playerRequestLiveChannel,
} from '@/lib/sql/liveOutbox';
import { buildPlayerBalanceUpdatedOutboxRows } from '@/lib/sql/playerBalanceUpdatedEvent';
import { invalidateSessionMePlayerExtras } from '@/lib/server/sessionMeExtras';

const STAFF_FREEPLAY_COST_COINS = 3;

function isFreeplaySqlParameterError(message: string) {
  return /could not determine data type of parameter|invalid input syntax for type/i.test(
    message
  );
}

export function mapFreeplaySqlError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || '');
  if (isFreeplaySqlParameterError(message)) {
    return 'Could not claim freeplay. Please try again.';
  }
  if (/no pending|no longer|not found|not available/i.test(message)) {
    return 'Freeplay gift is no longer available.';
  }
  return message;
}

export type FreeplayPlayerCandidate = {
  uid: string;
  username: string;
};

export type AuthorityFreeplayGiveResult = {
  success: true;
  duplicate: boolean;
  playerUid: string;
  playerUsername: string;
  giftId: string;
  staffWalletBalanceCoin?: number | null;
};

export type AuthorityFreeplayClaimResult = {
  success: true;
  duplicate: boolean;
  alreadyClaimed: boolean;
  amount: number;
  giftId: string;
  playerUid: string;
  message: string;
  /** Authoritative wallet after claim (or current balances on duplicate/already-claimed). */
  coin: number;
  cash: number;
  claimedAt: string | null;
  eventId: string | null;
  hasPendingGift: boolean;
};

function isEligiblePlayerRow(row: Record<string, unknown>) {
  const role = cleanText(row.role).toLowerCase();
  const status = cleanText(row.status).toLowerCase() || 'active';
  return role === 'player' && status !== 'disabled';
}

function belongsToCoadmin(row: Record<string, unknown>, coadminUid: string) {
  const scopeUid = cleanText(coadminUid);
  if (!scopeUid) return false;
  return (
    cleanText(row.coadmin_uid) === scopeUid || cleanText(row.created_by) === scopeUid
  );
}

function numberFromDb(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function debitStaffWalletForFreeplay(
  client: PoolClient,
  input: {
    staffUid: string;
    coadminUid: string;
    playerUid: string;
    giftId: string;
    nowIso: string;
    idempotencyKey: string | null;
  }
) {
  const wallet = await client.query<Record<string, unknown>>(
    `
      SELECT staff_uid, coadmin_uid, balance_coin
      FROM public.staff_coin_wallets
      WHERE staff_uid = $1::text
        AND deleted_at IS NULL
      FOR UPDATE
    `,
    [input.staffUid]
  );
  if (!wallet.rows.length) {
    throw new Error('insufficient_staff_freeplay_coins');
  }

  const row = wallet.rows[0];
  if (cleanText(row.coadmin_uid) !== input.coadminUid) {
    throw new Error('Forbidden: this staff wallet is outside your scope.');
  }

  const beforeBalance = numberFromDb(row.balance_coin);
  if (beforeBalance < STAFF_FREEPLAY_COST_COINS) {
    throw new Error('insufficient_staff_freeplay_coins');
  }
  const afterBalance = beforeBalance - STAFF_FREEPLAY_COST_COINS;

  await client.query(
    `
      UPDATE public.staff_coin_wallets
      SET balance_coin = $2::numeric,
          updated_at = $3::timestamptz
      WHERE staff_uid = $1::text
        AND deleted_at IS NULL
    `,
    [input.staffUid, afterBalance, input.nowIso]
  );

  await insertAuthorityLedgerEvent(client, {
    eventKey: `staffCoinWallets:${input.giftId}:${input.staffUid}:coin:staff_freeplay_give_debit`,
    userUid: input.staffUid,
    username: null,
    role: 'staff',
    coadminUid: input.coadminUid,
    balanceType: 'coin',
    direction: 'debit',
    delta: -STAFF_FREEPLAY_COST_COINS,
    absoluteAfter: afterBalance,
    eventType: 'staff_freeplay_give_debit',
    sourceCollection: 'freeplay_gifts_cache',
    sourceId: input.giftId,
    actorUid: input.staffUid,
    actorRole: 'staff',
    confidence: 'high',
    sourceCreatedAt: input.nowIso,
    rawSourceData: {
      staffUid: input.staffUid,
      coadminUid: input.coadminUid,
      playerUid: input.playerUid,
      giftId: input.giftId,
      costCoins: STAFF_FREEPLAY_COST_COINS,
      beforeBalance,
      afterBalance,
      idempotencyKey: input.idempotencyKey,
    },
    sourceFields: {
      staffUid: input.staffUid,
      playerUid: input.playerUid,
      giftId: input.giftId,
      costCoins: STAFF_FREEPLAY_COST_COINS,
      beforeBalance,
      afterBalance,
      idempotencyKey: input.idempotencyKey,
    },
  });

  return afterBalance;
}

function rollFreeplayAmount() {
  return Math.random() < 0.5 ? 2 : 3;
}

function readPendingGiftType(marker: Record<string, unknown>) {
  const direct = cleanText(marker.type);
  if (direct) return direct.toLowerCase();
  const raw = marker.raw_firestore_data;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return cleanText((raw as Record<string, unknown>).type).toLowerCase();
  }
  return '';
}

function buildGiftRaw(input: {
  giftId: string;
  playerUid: string;
  coadminUid: string;
  status: string;
  amount?: number | null;
  createdAt: string;
  claimedAt?: string | null;
}) {
  return {
    type: 'freeplay',
    status: input.status,
    coadminUid: input.coadminUid,
    playerUid: input.playerUid,
    giftId: input.giftId,
    createdAt: input.createdAt,
    claimedAt: input.claimedAt ?? null,
    amount: input.amount ?? null,
  };
}

async function upsertFreeplayGiftCache(
  client: PoolClient,
  input: {
    giftId: string;
    playerUid: string;
    coadminUid: string;
    status: string;
    amount?: number | null;
    createdAt: string;
    updatedAt: string;
    claimedAt?: string | null;
    source: string;
  }
) {
  const raw = buildGiftRaw(input);
  await client.query(
    `
      INSERT INTO public.freeplay_gifts_cache (
        firebase_id, player_uid, coadmin_uid, type, status, amount,
        created_at, updated_at, claimed_at, source, mirrored_at, deleted_at,
        raw_firestore_data
      )
      VALUES (
        $1::text, $2::text, NULLIF($3::text, ''), 'freeplay', $4::text, $5::numeric,
        $6::timestamptz, $7::timestamptz, $8::timestamptz, $9::text, now(), NULL,
        $10::jsonb
      )
      ON CONFLICT (firebase_id) DO UPDATE SET
        player_uid = EXCLUDED.player_uid,
        coadmin_uid = EXCLUDED.coadmin_uid,
        status = EXCLUDED.status,
        amount = EXCLUDED.amount,
        updated_at = EXCLUDED.updated_at,
        claimed_at = EXCLUDED.claimed_at,
        source = EXCLUDED.source,
        mirrored_at = now(),
        deleted_at = NULL,
        raw_firestore_data = EXCLUDED.raw_firestore_data
    `,
    [
      input.giftId,
      input.playerUid,
      input.coadminUid,
      input.status,
      input.amount ?? null,
      input.createdAt,
      input.updatedAt,
      input.claimedAt ?? null,
      input.source,
      JSON.stringify(raw),
    ]
  );
}

async function upsertFreeplayPendingCache(
  client: PoolClient,
  input: {
    playerUid: string;
    coadminUid: string;
    giftId: string;
    status: string;
    amount?: number | null;
    createdAt: string;
    updatedAt: string;
    claimedAt?: string | null;
    source: string;
  }
) {
  const hasPendingGift =
    input.status.toLowerCase() === 'pending' && Boolean(cleanText(input.giftId));
  const raw = buildGiftRaw({
    giftId: input.giftId,
    playerUid: input.playerUid,
    coadminUid: input.coadminUid,
    status: input.status,
    amount: input.amount ?? null,
    createdAt: input.createdAt,
    claimedAt: input.claimedAt ?? null,
  });

  await client.query(
    `
      INSERT INTO public.freeplay_pending_gifts_cache (
        player_uid, coadmin_uid, gift_id, has_pending_gift, status, amount,
        created_at, updated_at, claimed_at, source, mirrored_at, deleted_at,
        raw_firestore_data
      )
      VALUES (
        $1::text, NULLIF($2::text, ''), NULLIF($3::text, ''), $4::boolean, $5::text, $6::numeric,
        $7::timestamptz, $8::timestamptz, $9::timestamptz, $10::text, now(), NULL,
        $11::jsonb
      )
      ON CONFLICT (player_uid) DO UPDATE SET
        coadmin_uid = EXCLUDED.coadmin_uid,
        gift_id = EXCLUDED.gift_id,
        has_pending_gift = EXCLUDED.has_pending_gift,
        status = EXCLUDED.status,
        amount = EXCLUDED.amount,
        created_at = COALESCE(EXCLUDED.created_at, public.freeplay_pending_gifts_cache.created_at),
        updated_at = EXCLUDED.updated_at,
        claimed_at = EXCLUDED.claimed_at,
        source = EXCLUDED.source,
        mirrored_at = now(),
        deleted_at = NULL,
        raw_firestore_data = EXCLUDED.raw_firestore_data
    `,
    [
      input.playerUid,
      input.coadminUid,
      input.giftId,
      hasPendingGift,
      input.status,
      input.amount ?? null,
      input.createdAt,
      input.updatedAt,
      input.claimedAt ?? null,
      input.source,
      JSON.stringify(raw),
    ]
  );
}

async function writeFreeplayOutbox(
  client: PoolClient,
  input: {
    playerUid: string;
    giftId: string;
    status: string;
    amount?: number | null;
    updatedAt: string;
    eventType: string;
  }
) {
  const isGiveEvent = input.eventType === 'freeplay.given' || input.eventType === 'freeplay_give';
  const payload = {
    entityId: input.giftId,
    playerUid: input.playerUid,
    freeplayGiftId: input.giftId,
    giftId: input.giftId,
    status: input.status,
    amount: input.amount ?? null,
    message: isGiveEvent ? 'You received freeplay.' : null,
    createdAt: input.updatedAt,
    updatedAt: input.updatedAt,
    source: 'authority',
  };
  if (isGiveEvent) {
    console.info('[FREEPLAY_GIVE_OUTBOX_START]', {
      playerUid: input.playerUid,
      freeplayGiftId: input.giftId,
      amount: input.amount ?? null,
      channel: playerFreeplayLiveChannel(input.playerUid),
      eventType: 'freeplay.given',
    });
  }
  const outboxId = await insertLiveOutboxEventWithClient(client, {
    channel: playerFreeplayLiveChannel(input.playerUid),
    eventType: isGiveEvent ? 'freeplay.given' : input.eventType,
    entityType: 'freeplay_gift',
    entityId: input.giftId,
    source: 'authority_freeplay',
    mirroredAt: input.updatedAt,
    payload,
  });
  console.info(isGiveEvent ? '[FREEPLAY_GIVE_OUTBOX_INSERTED]' : '[FREEPLAY_CLAIM_OUTBOX_INSERTED]', {
    outboxId,
    playerUid: input.playerUid,
    freeplayGiftId: input.giftId,
    giftId: input.giftId,
    amount: input.amount ?? null,
    message: payload.message,
    createdAt: payload.createdAt,
    eventType: isGiveEvent ? 'freeplay.given' : input.eventType,
    channel: playerFreeplayLiveChannel(input.playerUid),
  });
}

async function writeFreeplayBalanceOutbox(
  client: PoolClient,
  input: {
    playerUid: string;
    giftId: string;
    amount: number;
    coin: number;
    cash: number;
    eventId: string;
    updatedAt: string;
  }
) {
  const rows = buildPlayerBalanceUpdatedOutboxRows({
    playerUid: input.playerUid,
    cashBalance: input.cash,
    coinBalance: input.coin,
    reason: 'freeplay_claim',
    eventId: input.eventId,
    occurredAt: input.updatedAt,
    source: 'authority_freeplay',
  }).map((row) => ({
    ...row,
    payload: {
      ...row.payload,
      giftId: input.giftId,
      amount: input.amount,
      freePlayClaimedAt: input.updatedAt,
      hasPendingGift: false,
    },
  }));
  const outboxIds = await insertLiveOutboxEventsBatch(client, rows, {
    flowName: 'freeplay_claim_balance',
  });
  console.info('[PLAYER_BALANCE_EVENT_PUBLISHED]', {
    playerUid: input.playerUid,
    eventId: input.eventId,
    eventType: 'player.balance.updated',
    sourceFlow: 'freeplay_claim',
    giftId: input.giftId,
    coinBalance: input.coin,
    cashBalance: input.cash,
    amount: input.amount,
    outboxIds,
    updatedAt: input.updatedAt,
  });
}

async function readPlayerWalletForClaim(
  client: PoolClient,
  playerUid: string
): Promise<{ coin: number; cash: number }> {
  const result = await client.query<{ coin: unknown; cash: unknown }>(
    `
      SELECT coin, cash
      FROM public.players_cache
      WHERE uid = $1::text
        AND deleted_at IS NULL
      LIMIT 1
    `,
    [playerUid]
  );
  return {
    coin: Math.max(0, Math.floor(numberFromDb(result.rows[0]?.coin))),
    cash: Math.max(0, Math.floor(numberFromDb(result.rows[0]?.cash))),
  };
}

async function loadFreeplayPlayersForCoadmin(coadminUid: string): Promise<FreeplayPlayerCandidate[]> {
  const scopeUid = cleanText(coadminUid);
  const db = getPlayerMirrorPool();
  if (!scopeUid || !db) {
    return [];
  }

  const playersResult = await db.query(
    `
      SELECT uid, username, role, status, coadmin_uid, created_by
      FROM public.players_cache
      WHERE deleted_at IS NULL
        AND role = 'player'
        AND COALESCE(LOWER(status), 'active') <> 'disabled'
        AND (coadmin_uid = $1 OR created_by = $1)
    `,
    [scopeUid]
  );

  return playersResult.rows
    .filter((row) => isEligiblePlayerRow(row as Record<string, unknown>))
    .map((row) => ({
      uid: cleanText((row as Record<string, unknown>).uid),
      username: cleanText((row as Record<string, unknown>).username) || 'Player',
    }))
    .filter((row) => row.uid);
}

export async function loadEligibleFreeplayPlayersForCoadmin(
  coadminUid: string
): Promise<FreeplayPlayerCandidate[]> {
  const players = await loadFreeplayPlayersForCoadmin(coadminUid);
  if (!players.length) {
    return [];
  }

  const db = getPlayerMirrorPool();
  if (!db) {
    return [];
  }

  const pendingResult = await db.query(
    `
      SELECT player_uid
      FROM public.freeplay_pending_gifts_cache
      WHERE deleted_at IS NULL
        AND has_pending_gift = TRUE
        AND player_uid = ANY($1::text[])
    `,
    [players.map((player) => player.uid)]
  );

  const pendingUids = new Set(
    pendingResult.rows.map((row) => cleanText((row as Record<string, unknown>).player_uid))
  );
  return players.filter((player) => !pendingUids.has(player.uid));
}

async function resolveFreeplayGiveTarget(input: {
  coadminUid: string;
  targetPlayerUid?: string | null;
  reason?: string | null;
}): Promise<FreeplayPlayerCandidate> {
  const coadminUid = cleanText(input.coadminUid);
  const targetPlayerUid = cleanText(input.targetPlayerUid);
  const reason = cleanText(input.reason) || null;

  const allPlayers = await loadFreeplayPlayersForCoadmin(coadminUid);
  if (!allPlayers.length) {
    throw new Error('No active players are assigned to your account.');
  }

  if (targetPlayerUid) {
    console.info('[FREEPLAY_GIVE_TARGET_SELECTED]', {
      coadminUid,
      targetPlayerUid,
      reason,
    });

    const db = getPlayerMirrorPool();
    if (db) {
      const lookup = await db.query(
        `
          SELECT uid, username, role, status, coadmin_uid, created_by
          FROM public.players_cache
          WHERE uid = $1::text
            AND deleted_at IS NULL
          LIMIT 1
        `,
        [targetPlayerUid]
      );
      if (lookup.rows.length) {
        const row = lookup.rows[0] as Record<string, unknown>;
        if (!belongsToCoadmin(row, coadminUid)) {
          console.info('[FREEPLAY_GIVE_TARGET_SCOPE_DENIED]', {
            coadminUid,
            targetPlayerUid,
            reason: 'outside_coadmin_scope',
          });
          throw new Error('Forbidden: this player is outside your scope.');
        }
        if (!isEligiblePlayerRow(row)) {
          console.info('[FREEPLAY_GIVE_TARGET_SCOPE_DENIED]', {
            coadminUid,
            targetPlayerUid,
            reason: 'player_not_eligible',
          });
          throw new Error('Selected player is no longer eligible.');
        }
      }
    }

    const scopedPlayer = allPlayers.find((player) => player.uid === targetPlayerUid);
    if (!scopedPlayer) {
      console.info('[FREEPLAY_GIVE_TARGET_SCOPE_DENIED]', {
        coadminUid,
        targetPlayerUid,
        reason: 'player_not_in_scope_list',
      });
      throw new Error('Selected player is no longer eligible.');
    }

    const eligiblePlayers = await loadEligibleFreeplayPlayersForCoadmin(coadminUid);
    const eligibleTarget = eligiblePlayers.find((player) => player.uid === targetPlayerUid);
    if (!eligibleTarget) {
      throw new Error('This player already has a pending FreePlay gift.');
    }

    console.info('[FREEPLAY_GIVE_TARGET_SCOPE_OK]', {
      coadminUid,
      targetPlayerUid,
      playerUsername: eligibleTarget.username,
    });
    console.info('[FREEPLAY_GIVE_SPECIFIC_PLAYER]', {
      coadminUid,
      targetPlayerUid,
      reason,
    });
    return eligibleTarget;
  }

  const eligiblePlayers = await loadEligibleFreeplayPlayersForCoadmin(coadminUid);
  if (!eligiblePlayers.length) {
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

export async function giveFreeplayGiftInSql(input: {
  coadminUid: string;
  actorUid?: string | null;
  actorRole?: string | null;
  targetPlayerUid?: string | null;
  reason?: string | null;
  idempotencyKey?: string | null;
}): Promise<AuthorityFreeplayGiveResult> {
  const coadminUid = cleanText(input.coadminUid);
  if (!coadminUid) {
    throw new Error('coadminUid is required.');
  }

  const actorUid = cleanText(input.actorUid) || coadminUid;
  const actorRole = cleanText(input.actorRole) || 'coadmin';
  const selectedPlayer = await resolveFreeplayGiveTarget({
    coadminUid,
    targetPlayerUid: input.targetPlayerUid,
    reason: input.reason,
  });
  const giftId = randomUUID();
  const nowIso = new Date().toISOString();
  const idempotencyKey = cleanText(input.idempotencyKey);
  const operationKey = idempotencyKey
    ? `freeplay_give:${coadminUid}:${idempotencyKey}`
    : null;
  let staffWalletBalanceCoin: number | null = null;

  if (operationKey) {
    logAuthPayloadPreTxnRemoved('freeplay_give');
  }

  const db = getPlayerMirrorPool();
  if (!db) {
    throw new Error('Postgres is unavailable.');
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    if (operationKey) {
      const claim = await claimAuthorityOperation(client, {
        operationKey,
        operationType: 'freeplay_give',
        userUid: selectedPlayer.uid,
        sourceId: giftId,
        actorUid,
        actorRole,
        payload: {
          playerUid: selectedPlayer.uid,
          playerUsername: selectedPlayer.username,
          giftId,
          reason: cleanText(input.reason) || null,
          targetPlayerUid: cleanText(input.targetPlayerUid) || null,
        },
      });
      if (claim.duplicate) {
        const payload = await readAuthorityOperationPayloadWithClient(client, operationKey, {
          flowName: 'freeplay_give',
        });
        await client.query('ROLLBACK');
        if (payload?.playerUid && payload?.giftId) {
          return {
            success: true,
            duplicate: true,
            playerUid: cleanText(payload.playerUid),
            playerUsername: cleanText(payload.playerUsername) || 'Player',
            giftId: cleanText(payload.giftId),
          };
        }
        throw new Error('FreePlay give idempotency conflict without stored result.');
      }
    }

    const playerLock = await client.query(
      `
        SELECT uid, username, role, status, coadmin_uid, created_by
        FROM public.players_cache
        WHERE uid = $1
          AND deleted_at IS NULL
        FOR UPDATE
      `,
      [selectedPlayer.uid]
    );
    if (!playerLock.rows.length) {
      throw new Error('Selected player no longer exists.');
    }
    const playerRow = playerLock.rows[0] as Record<string, unknown>;
    if (!belongsToCoadmin(playerRow, coadminUid) || !isEligiblePlayerRow(playerRow)) {
      throw new Error('Selected player is no longer eligible.');
    }

    const pendingLock = await client.query(
      `
        SELECT player_uid, gift_id, status, has_pending_gift
        FROM public.freeplay_pending_gifts_cache
        WHERE player_uid = $1
          AND deleted_at IS NULL
        FOR UPDATE
      `,
      [selectedPlayer.uid]
    );
    if (pendingLock.rows.length) {
      const pending = pendingLock.rows[0] as Record<string, unknown>;
      const pendingStatus = cleanText(pending.status).toLowerCase();
      if (pending.has_pending_gift === true || pendingStatus === 'pending') {
        throw new Error('This player already has a pending FreePlay gift.');
      }
    }

    if (actorRole.toLowerCase() === 'staff') {
      staffWalletBalanceCoin = await debitStaffWalletForFreeplay(client, {
        staffUid: actorUid,
        coadminUid,
        playerUid: selectedPlayer.uid,
        giftId,
        nowIso,
        idempotencyKey,
      });
    }

    await upsertFreeplayGiftCache(client, {
      giftId,
      playerUid: selectedPlayer.uid,
      coadminUid,
      status: 'pending',
      amount: null,
      createdAt: nowIso,
      updatedAt: nowIso,
      source: 'authority_freeplay_give',
    });

    await upsertFreeplayPendingCache(client, {
      playerUid: selectedPlayer.uid,
      coadminUid,
      giftId,
      status: 'pending',
      amount: null,
      createdAt: nowIso,
      updatedAt: nowIso,
      source: 'authority_freeplay_give',
    });
    console.info('[FREEPLAY_GIVE_SQL_SUCCESS]', {
      playerUid: selectedPlayer.uid,
      freeplayGiftId: giftId,
      giftId,
      amount: null,
      createdAt: nowIso,
    });

    await writeFreeplayOutbox(client, {
      playerUid: selectedPlayer.uid,
      giftId,
      status: 'pending',
      amount: null,
      updatedAt: nowIso,
      eventType: 'freeplay.given',
    });

    await client.query('COMMIT');
    return {
      success: true,
      duplicate: false,
      playerUid: selectedPlayer.uid,
      playerUsername: selectedPlayer.username,
      giftId,
      staffWalletBalanceCoin,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function claimFreeplayGiftInSql(input: {
  playerUid: string;
  giftId: string;
  idempotencyKey?: string | null;
}): Promise<AuthorityFreeplayClaimResult> {
  const playerUid = cleanText(input.playerUid);
  const requestedGiftId = cleanText(input.giftId);
  if (!playerUid || !requestedGiftId) {
    throw new Error('FreePlay gift id is required.');
  }

  const db = getPlayerMirrorPool();
  if (!db) {
    throw new Error('Postgres is unavailable.');
  }

  const operationKey = cleanText(input.idempotencyKey)
    ? `freeplay_claim:${playerUid}:${cleanText(input.idempotencyKey)}`
    : `freeplay_claim:${playerUid}:${requestedGiftId}`;

  console.info('[FREEPLAY_CLAIM_SQL_START]', {
    playerUid,
    giftId: requestedGiftId,
    operationKey,
  });

  logAuthPayloadPreTxnRemoved('freeplay_claim');
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const pendingLock = await client.query(
      `
        SELECT *
        FROM public.freeplay_pending_gifts_cache
        WHERE player_uid = $1
          AND deleted_at IS NULL
        FOR UPDATE
      `,
      [playerUid]
    );
    if (!pendingLock.rows.length) {
      throw new Error('No pending FreePlay gift found.');
    }
    const marker = pendingLock.rows[0] as Record<string, unknown>;
    const markerType = readPendingGiftType(marker);
    const markerStatus = cleanText(marker.status).toLowerCase();
    const markerGiftId = cleanText(marker.gift_id);

    if (markerType !== 'freeplay') {
      throw new Error('No pending FreePlay gift found.');
    }
    if (markerGiftId !== requestedGiftId) {
      throw new Error('This FreePlay gift is no longer pending.');
    }
    if (markerStatus === 'claimed') {
      const amount = Math.max(0, Math.floor(Number(marker.amount || 0)));
      const wallet = await readPlayerWalletForClaim(client, playerUid);
      const claimedAt = cleanText(marker.claimed_at) || null;
      await client.query('COMMIT');
      return {
        success: true,
        duplicate: true,
        alreadyClaimed: true,
        amount,
        giftId: requestedGiftId,
        playerUid,
        message: `You got ${amount} FreePlay coins!`,
        coin: wallet.coin,
        cash: wallet.cash,
        claimedAt,
        eventId: null,
        hasPendingGift: false,
      };
    }
    if (markerStatus !== 'pending' || !markerGiftId) {
      throw new Error('No pending FreePlay gift found.');
    }

    const giftLock = await client.query(
      `
        SELECT *
        FROM public.freeplay_gifts_cache
        WHERE firebase_id = $1
          AND deleted_at IS NULL
        FOR UPDATE
      `,
      [requestedGiftId]
    );
    if (!giftLock.rows.length) {
      throw new Error('FreePlay gift or player profile not found.');
    }
    const gift = giftLock.rows[0] as Record<string, unknown>;
    const giftPlayerUid = cleanText(gift.player_uid);
    const giftType = cleanText(gift.type).toLowerCase();
    const giftStatus = cleanText(gift.status).toLowerCase();
    if (giftPlayerUid !== playerUid || giftType !== 'freeplay' || giftStatus !== 'pending') {
      throw new Error('No pending FreePlay gift found.');
    }

    const playerLock = await client.query(
      `
        SELECT uid, username, role, coin, cash
        FROM public.players_cache
        WHERE uid = $1
          AND deleted_at IS NULL
        FOR UPDATE
      `,
      [playerUid]
    );
    if (!playerLock.rows.length) {
      throw new Error('FreePlay gift or player profile not found.');
    }
    const player = playerLock.rows[0] as Record<string, unknown>;
    if (cleanText(player.role).toLowerCase() !== 'player') {
      throw new Error('Only players can claim FreePlay gifts.');
    }

    const claim = await claimAuthorityOperation(client, {
      operationKey,
      operationType: 'freeplay_claim',
      userUid: playerUid,
      sourceId: requestedGiftId,
      actorUid: playerUid,
      actorRole: 'player',
      payload: {},
    });
    if (claim.duplicate) {
      const payload = await readAuthorityOperationPayloadWithClient(client, operationKey, {
        flowName: 'freeplay_claim',
      });
      const wallet = await readPlayerWalletForClaim(client, playerUid);
      await client.query('ROLLBACK');
      const amount = Math.max(0, Math.floor(Number(payload?.amount || marker.amount || 0)));
      return {
        success: true,
        duplicate: true,
        alreadyClaimed: true,
        amount,
        giftId: requestedGiftId,
        playerUid,
        message: `You got ${amount} FreePlay coins!`,
        coin: wallet.coin,
        cash: wallet.cash,
        claimedAt: cleanText(payload?.claimedAt) || cleanText(marker.claimed_at) || null,
        eventId: cleanText(payload?.eventId) || null,
        hasPendingGift: false,
      };
    }

    const amount = rollFreeplayAmount();
    const nowIso = new Date().toISOString();
    const coadminUid =
      cleanText(gift.coadmin_uid) || cleanText(marker.coadmin_uid) || null;
    const currentCoin = Math.max(0, Math.floor(Number(player.coin || 0)));
    const currentCash = Math.max(0, Math.floor(Number(player.cash || 0)));
    const nextCoin = currentCoin + amount;
    const eventId = randomUUID();

    console.info('[FREEPLAY_SQL_INPUT]', {
      playerUid,
      giftId: requestedGiftId,
      amountRaw: amount,
      amountNumber: amount,
      reasonType: 'freeplay_claim',
      metadataType: 'jsonb',
      param1Type: 'text',
      param2Type: 'numeric',
      param3Type: 'timestamptz',
      operationKey,
    });

    await client.query(
      `
        UPDATE public.players_cache
        SET
          coin = $2::numeric,
          updated_at = $3::timestamptz,
          raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb)
            || jsonb_build_object('coin', $2::numeric)
        WHERE uid = $1::text
          AND deleted_at IS NULL
      `,
      [playerUid, nextCoin, nowIso]
    );

    await client.query(
      `
        UPDATE public.user_balance_snapshots_cache
        SET
          coin = $2::numeric,
          updated_at = $3::timestamptz,
          mirrored_at = now(),
          raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb)
            || jsonb_build_object('coin', $2::numeric)
        WHERE firebase_id = $1::text
          AND deleted_at IS NULL
      `,
      [playerUid, nextCoin, nowIso]
    );
    console.info('[FREEPLAY_CLAIM_BALANCE_UPDATED]', {
      playerUid,
      giftId: requestedGiftId,
      beforeCoin: currentCoin,
      afterCoin: nextCoin,
      amount,
    });

    await upsertFreeplayGiftCache(client, {
      giftId: requestedGiftId,
      playerUid,
      coadminUid: coadminUid || '',
      status: 'claimed',
      amount,
      createdAt: toIsoOrNow(gift.created_at, nowIso),
      updatedAt: nowIso,
      claimedAt: nowIso,
      source: 'authority_freeplay_claim',
    });

    await upsertFreeplayPendingCache(client, {
      playerUid,
      coadminUid: coadminUid || '',
      giftId: requestedGiftId,
      status: 'claimed',
      amount,
      createdAt: toIsoOrNow(marker.created_at, nowIso),
      updatedAt: nowIso,
      claimedAt: nowIso,
      source: 'authority_freeplay_claim',
    });

    const rawEvent = {
      type: 'freeplay',
      playerUid,
      coadminUid,
      amountNpr: amount,
      giftId: requestedGiftId,
      createdAt: nowIso,
    };

    await client.query(
      `
        INSERT INTO public.financial_events_cache (
          firebase_id, player_uid, coadmin_uid, type, amount_npr, gift_id,
          before_coin, after_coin, actor_uid, actor_role,
          created_at, updated_at, source, mirrored_at, deleted_at, raw_firestore_data
        )
        VALUES (
          $1::text, $2::text, NULLIF($3::text, ''), 'freeplay', $4::numeric, $5::text,
          $6::numeric, $7::numeric, $2::text, 'player',
          $8::timestamptz, $8::timestamptz, 'authority_freeplay_claim', now(), NULL, $9::jsonb
        )
        ON CONFLICT (firebase_id) DO NOTHING
      `,
      [
        eventId,
        playerUid,
        coadminUid,
        amount,
        requestedGiftId,
        currentCoin,
        nextCoin,
        nowIso,
        JSON.stringify(rawEvent),
      ]
    );

    console.info('[FREEPLAY_CLAIM_LEDGER_WRITTEN]', {
      playerUid,
      giftId: requestedGiftId,
      eventId,
      amount,
    });

    await insertAuthorityLedgerEvent(client, {
      eventKey: `authority:freeplay_claim:${eventId}`,
      userUid: playerUid,
      username: cleanText(player.username) || null,
      role: 'player',
      coadminUid,
      balanceType: 'coin',
      direction: 'credit',
      delta: amount,
      absoluteAfter: nextCoin,
      eventType: 'freeplay',
      sourceCollection: 'financialEvents',
      sourceId: eventId,
      actorUid: playerUid,
      actorRole: 'player',
      confidence: 'high',
      sourceCreatedAt: nowIso,
      rawSourceData: rawEvent,
      sourceFields: {
        giftId: requestedGiftId,
        amountNpr: amount,
        beforeCoin: currentCoin,
        afterCoin: nextCoin,
      },
    });

    await writeFreeplayOutbox(client, {
      playerUid,
      giftId: requestedGiftId,
      status: 'claimed',
      amount,
      updatedAt: nowIso,
      eventType: 'freeplay_claim',
    });
    await writeFreeplayBalanceOutbox(client, {
      playerUid,
      giftId: requestedGiftId,
      amount,
      coin: nextCoin,
      cash: currentCash,
      eventId,
      updatedAt: nowIso,
    });
    await insertLiveOutboxEventWithClient(client, {
      channel: playerRequestLiveChannel(playerUid),
      eventType: 'player_message',
      entityType: 'freeplay_gift',
      entityId: requestedGiftId,
      source: 'authority_freeplay',
      mirroredAt: nowIso,
      payload: {
        entityId: requestedGiftId,
        playerUid,
        giftId: requestedGiftId,
        status: 'claimed',
        amount,
        pokeMessage: 'Freeplay claimed successfully.',
        updatedAt: nowIso,
        source: 'authority',
      },
    });
    console.info('[PLAYER_FREEPLAY_CLAIM_TOAST_QUEUED]', {
      playerUid,
      giftId: requestedGiftId,
      amount,
    });

    await client.query(
      `
        UPDATE public.authority_operations
        SET payload = $2::jsonb
        WHERE operation_key = $1
      `,
      [
        operationKey,
        JSON.stringify({
          playerUid,
          giftId: requestedGiftId,
          amount,
          alreadyClaimed: false,
          coin: nextCoin,
          cash: currentCash,
          eventId,
          claimedAt: nowIso,
        }),
      ]
    );

    await client.query('COMMIT');
    // Session/me extras are process-local; clear only after the credit has committed.
    invalidateSessionMePlayerExtras({ uid: playerUid });
    console.info('[FREEPLAY_CLAIM_SQL_SUCCESS]', {
      playerUid,
      giftId: requestedGiftId,
      amount,
      operationKey,
      coin: nextCoin,
      cash: currentCash,
      eventId,
    });
    return {
      success: true,
      duplicate: false,
      alreadyClaimed: false,
      amount,
      giftId: requestedGiftId,
      playerUid,
      message: 'Freeplay claimed successfully.',
      coin: nextCoin,
      cash: currentCash,
      claimedAt: nowIso,
      eventId,
      hasPendingGift: false,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    const message = error instanceof Error ? error.message : String(error || '');
    console.info('[FREEPLAY_CLAIM_SQL_ERROR]', {
      playerUid,
      giftId: requestedGiftId,
      error: message,
    });
    if (isFreeplaySqlParameterError(message)) {
      throw new Error('Could not claim freeplay. Please try again.');
    }
    throw error;
  } finally {
    client.release();
  }
}

function toIsoOrNow(value: unknown, fallback: string) {
  if (!value) return fallback;
  if (value instanceof Date) return value.toISOString();
  const text = cleanText(value);
  if (!text) return fallback;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}
