import 'server-only';

import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';

import {
  claimAuthorityOperation,
  insertAuthorityLedgerEvent,
  logAuthPayloadPreTxnRemoved,
  readAuthorityOperationPayloadWithClient,
} from '@/lib/sql/authorityLedger';
import { lookupUserDirectoryFromSql, resolvePlayerScopeUid } from '@/lib/sql/authorityLookup';
import { insertLiveOutboxEventsBatch } from '@/lib/sql/liveOutbox';
import { buildPlayerBalanceUpdatedOutboxRows } from '@/lib/sql/playerBalanceUpdatedEvent';
import { invalidateSessionMePlayerExtras } from '@/lib/server/sessionMeExtras';
import { cleanText, getPlayerMirrorPool } from '@/lib/sql/playerMirrorCommon';

export type AllocateStaffWalletCoinsInput = {
  staffUid: string;
  amount: number;
  actorUid: string;
  actorRole: string;
  scopeUid: string | null;
  isAdmin: boolean;
  idempotencyKey?: string | null;
  note?: string | null;
};

export type AllocateStaffWalletCoinsResult = {
  success: true;
  duplicate: boolean;
  staffUid: string;
  coadminUid: string;
  balanceCoin: number;
  totalAllocatedCoin: number;
  allocatedAmount: number;
  eventId: string;
};

export type StaffWalletBalance = {
  staffUid: string;
  coadminUid: string;
  balanceCoin: number;
  totalAllocatedCoin: number;
  totalLoadedCoin: number;
};

export type StaffWalletListRow = StaffWalletBalance & {
  username: string | null;
  status: string | null;
  walletUpdatedAt: string | null;
};

export type LoadPlayerCoinsFromStaffWalletInput = {
  playerUid: string;
  amount: number;
  actorUid: string;
  actorRole: string;
  scopeUid: string | null;
  idempotencyKey: string;
};

export type LoadPlayerCoinsFromStaffWalletResult = {
  success: true;
  duplicate: boolean;
  staffUid: string;
  playerUid: string;
  coadminUid: string;
  loadedAmount: number;
  staffWalletBalanceCoin: number;
  playerBalanceCoin: number;
  eventId: string;
};

type WalletRow = {
  staff_uid: string;
  coadmin_uid: string;
  balance_coin: unknown;
  total_allocated_coin: unknown;
  total_loaded_coin?: unknown;
  updated_at?: unknown;
};

function positiveIntegerAmount(value: number) {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error('Amount must be a positive whole number.');
  }
  return value;
}

function numberFromDb(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isoStringOrNull(value: unknown) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function normalizeDuplicatePayload(payload: Record<string, unknown> | null) {
  if (!payload) {
    return { staffUid: '', amount: 0 };
  }
  return {
    staffUid: cleanText(payload.staffUid),
    amount: Math.trunc(Number(payload.amount || 0)),
  };
}

function normalizeLoadDuplicatePayload(payload: Record<string, unknown> | null) {
  if (!payload) {
    return { staffUid: '', playerUid: '', amount: 0 };
  }
  return {
    staffUid: cleanText(payload.staffUid),
    playerUid: cleanText(payload.playerUid),
    amount: Math.trunc(Number(payload.amount || 0)),
  };
}

export async function getStaffWalletForStaffInSql(input: {
  staffUid: string;
  scopeUid: string | null;
}): Promise<StaffWalletBalance> {
  const staffUid = cleanText(input.staffUid);
  const scopeUid = cleanText(input.scopeUid);
  if (!staffUid) {
    throw new Error('staffUid is required.');
  }
  if (!scopeUid) {
    throw new Error('Your account is not linked to a coadmin scope.');
  }

  const staff = await lookupUserDirectoryFromSql(staffUid);
  if (!staff) {
    throw new Error('Staff not found.');
  }
  if (cleanText(staff.role).toLowerCase() !== 'staff') {
    throw new Error('Selected account is not a staff account.');
  }

  const staffScopeUid = resolvePlayerScopeUid(staff);
  if (!staffScopeUid || staffScopeUid !== scopeUid) {
    throw new Error('Forbidden: this staff wallet is outside your scope.');
  }

  const db = getPlayerMirrorPool();
  if (!db) {
    throw new Error('Postgres is unavailable.');
  }

  const result = await db.query<WalletRow>(
    `
      SELECT balance_coin, total_allocated_coin, total_loaded_coin
      FROM public.staff_coin_wallets
      WHERE staff_uid = $1::text
        AND deleted_at IS NULL
      LIMIT 1
    `,
    [staffUid]
  );
  const wallet = result.rows[0] || null;

  return {
    staffUid,
    coadminUid: staffScopeUid,
    balanceCoin: numberFromDb(wallet?.balance_coin),
    totalAllocatedCoin: numberFromDb(wallet?.total_allocated_coin),
    totalLoadedCoin: numberFromDb(wallet?.total_loaded_coin),
  };
}

export async function listStaffWalletsForCoadminInSql(input: {
  coadminUid?: string | null;
  isAdmin?: boolean;
}): Promise<StaffWalletListRow[]> {
  const coadminUid = cleanText(input.coadminUid);
  if (!input.isAdmin && !coadminUid) {
    throw new Error('Your account is not linked to a coadmin scope.');
  }

  const db = getPlayerMirrorPool();
  if (!db) {
    throw new Error('Postgres is unavailable.');
  }

  const params: unknown[] = [];
  const scopeClause = coadminUid
    ? `AND (staff.coadmin_uid = $1::text OR staff.created_by = $1::text)`
    : '';
  if (coadminUid) {
    params.push(coadminUid);
  }

  const result = await db.query<Record<string, unknown>>(
    `
      SELECT
        staff.uid AS staff_uid,
        staff.username,
        staff.status,
        COALESCE(NULLIF(staff.coadmin_uid, ''), NULLIF(staff.created_by, '')) AS coadmin_uid,
        wallet.balance_coin,
        wallet.total_allocated_coin,
        wallet.total_loaded_coin,
        wallet.updated_at AS wallet_updated_at
      FROM public.players_cache staff
      LEFT JOIN public.staff_coin_wallets wallet
        ON wallet.staff_uid = staff.uid
       AND wallet.deleted_at IS NULL
      WHERE staff.deleted_at IS NULL
        AND staff.role = 'staff'
        ${scopeClause}
      ORDER BY LOWER(COALESCE(staff.username, '')), staff.uid
    `,
    params
  );

  return result.rows.map((row) => ({
    staffUid: cleanText(row.staff_uid),
    username: cleanText(row.username) || null,
    status: cleanText(row.status) || null,
    coadminUid: cleanText(row.coadmin_uid),
    balanceCoin: numberFromDb(row.balance_coin),
    totalAllocatedCoin: numberFromDb(row.total_allocated_coin),
    totalLoadedCoin: numberFromDb(row.total_loaded_coin),
    walletUpdatedAt: isoStringOrNull(row.wallet_updated_at),
  }));
}

async function lockWalletRow(
  client: PoolClient,
  input: {
    staffUid: string;
    coadminUid: string;
    nowIso: string;
  }
) {
  await client.query(
    `
      INSERT INTO public.staff_coin_wallets (
        staff_uid,
        coadmin_uid,
        balance_coin,
        total_allocated_coin,
        total_loaded_coin,
        created_at,
        updated_at,
        deleted_at
      )
      VALUES ($1::text, $2::text, 0, 0, 0, $3::timestamptz, $3::timestamptz, NULL)
      ON CONFLICT (staff_uid) DO NOTHING
    `,
    [input.staffUid, input.coadminUid, input.nowIso]
  );

  const wallet = await client.query<WalletRow>(
    `
      SELECT staff_uid, coadmin_uid, balance_coin, total_allocated_coin, total_loaded_coin
      FROM public.staff_coin_wallets
      WHERE staff_uid = $1::text
        AND deleted_at IS NULL
      FOR UPDATE
    `,
    [input.staffUid]
  );

  if (!wallet.rows.length) {
    throw new Error('Staff wallet not found.');
  }

  return wallet.rows[0];
}

export async function loadPlayerCoinsFromStaffWalletInSql(
  input: LoadPlayerCoinsFromStaffWalletInput
): Promise<LoadPlayerCoinsFromStaffWalletResult> {
  const staffUid = cleanText(input.actorUid);
  const actorRole = cleanText(input.actorRole).toLowerCase();
  const playerUid = cleanText(input.playerUid);
  const amount = positiveIntegerAmount(input.amount);
  const scopeUid = cleanText(input.scopeUid);
  const idempotencyKey = cleanText(input.idempotencyKey);

  if (actorRole !== 'staff') {
    throw new Error('Only staff can load player coins from a staff wallet.');
  }
  if (!staffUid) {
    throw new Error('staffUid is required.');
  }
  if (!playerUid) {
    throw new Error('playerUid is required.');
  }
  if (!scopeUid) {
    throw new Error('Your account is not linked to a coadmin scope.');
  }
  if (!idempotencyKey) {
    throw new Error('missing_idempotency_key');
  }

  const db = getPlayerMirrorPool();
  if (!db) {
    throw new Error('Postgres is unavailable.');
  }

  const eventId = randomUUID();
  const nowIso = new Date().toISOString();
  const operationKey = `staff_wallet_load:${staffUid}:${idempotencyKey}`;

  logAuthPayloadPreTxnRemoved('staff_wallet_load_player');
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const staff = await lookupUserDirectoryFromSql(staffUid, client);
    if (!staff) {
      throw new Error('Staff not found.');
    }
    if (cleanText(staff.role).toLowerCase() !== 'staff') {
      throw new Error('Selected account is not a staff account.');
    }

    const staffScopeUid = resolvePlayerScopeUid(staff);
    if (!staffScopeUid || staffScopeUid !== scopeUid) {
      throw new Error('Forbidden: this staff wallet is outside your scope.');
    }

    const claim = await claimAuthorityOperation(client, {
      operationKey,
      operationType: 'staff_wallet_load_player',
      userUid: staffUid,
      sourceId: eventId,
      actorUid: staffUid,
      actorRole: 'staff',
      payload: {
        staffUid,
        playerUid,
        amount,
        coadminUid: staffScopeUid,
      },
    });

    if (claim.duplicate) {
      const existingPayload = normalizeLoadDuplicatePayload(
        await readAuthorityOperationPayloadWithClient(client, operationKey, {
          flowName: 'staff_wallet_load_player',
        })
      );
      if (
        existingPayload.staffUid !== staffUid ||
        existingPayload.playerUid !== playerUid ||
        existingPayload.amount !== amount
      ) {
        throw new Error('idempotency_conflict');
      }

      const wallet = await client.query<WalletRow>(
        `
          SELECT balance_coin
          FROM public.staff_coin_wallets
          WHERE staff_uid = $1::text
            AND deleted_at IS NULL
          LIMIT 1
        `,
        [staffUid]
      );
      const player = await client.query<{ coin: unknown }>(
        `
          SELECT coin
          FROM public.players_cache
          WHERE uid = $1::text
            AND deleted_at IS NULL
          LIMIT 1
        `,
        [playerUid]
      );
      await client.query('ROLLBACK');
      return {
        success: true,
        duplicate: true,
        staffUid,
        playerUid,
        coadminUid: staffScopeUid,
        loadedAmount: 0,
        staffWalletBalanceCoin: numberFromDb(wallet.rows[0]?.balance_coin),
        playerBalanceCoin: numberFromDb(player.rows[0]?.coin),
        eventId,
      };
    }

    const wallet = await lockWalletRow(client, {
      staffUid,
      coadminUid: staffScopeUid,
      nowIso,
    });
    const walletCoadminUid = cleanText(wallet.coadmin_uid);
    if (walletCoadminUid && walletCoadminUid !== staffScopeUid) {
      throw new Error('Staff wallet scope does not match selected staff.');
    }

    const playerResult = await client.query<Record<string, unknown>>(
      `
        SELECT uid, username, role, coadmin_uid, created_by, coin, cash, raw_firestore_data
        FROM public.players_cache
        WHERE uid = $1::text
          AND deleted_at IS NULL
        FOR UPDATE
      `,
      [playerUid]
    );
    if (!playerResult.rows.length) {
      throw new Error('invalid_player');
    }

    const player = playerResult.rows[0];
    const raw =
      player.raw_firestore_data &&
      typeof player.raw_firestore_data === 'object' &&
      !Array.isArray(player.raw_firestore_data)
        ? (player.raw_firestore_data as Record<string, unknown>)
        : {};
    const playerRole = cleanText(player.role) || cleanText(raw.role);
    if (playerRole.toLowerCase() !== 'player') {
      throw new Error('invalid_player');
    }
    const playerScopeUid =
      cleanText(player.coadmin_uid) || cleanText(raw.coadminUid) || cleanText(player.created_by) || cleanText(raw.createdBy);
    if (playerScopeUid !== staffScopeUid) {
      throw new Error('out_of_scope_player');
    }

    const beforeWalletBalance = numberFromDb(wallet.balance_coin);
    const beforeTotalLoaded = numberFromDb(wallet.total_loaded_coin);
    if (beforeWalletBalance < amount) {
      throw new Error('insufficient_staff_wallet_balance');
    }

    const beforePlayerCoin = Math.max(0, Math.floor(numberFromDb(player.coin ?? raw.coin)));
    const beforePlayerCash = Math.max(0, Math.floor(numberFromDb(player.cash ?? raw.cash)));
    const afterWalletBalance = beforeWalletBalance - amount;
    const afterTotalLoaded = beforeTotalLoaded + amount;
    const afterPlayerCoin = beforePlayerCoin + amount;

    await client.query(
      `
        UPDATE public.staff_coin_wallets
        SET
          balance_coin = $2::numeric,
          total_loaded_coin = $3::numeric,
          updated_at = $4::timestamptz
        WHERE staff_uid = $1::text
          AND deleted_at IS NULL
      `,
      [staffUid, afterWalletBalance, afterTotalLoaded, nowIso]
    );

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
      [playerUid, afterPlayerCoin, nowIso]
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
      [playerUid, afterPlayerCoin, nowIso]
    );

    const financialRawEvent = {
      playerUid,
      staffUid,
      coadminUid: staffScopeUid,
      amountNpr: amount,
      amountCoins: amount,
      type: 'staff_wallet_coin_load',
      actorUid: staffUid,
      actorRole: 'staff',
      beforeCoin: beforePlayerCoin,
      afterCoin: afterPlayerCoin,
      staffWalletBefore: beforeWalletBalance,
      staffWalletAfter: afterWalletBalance,
      idempotencyKey,
      createdAt: nowIso,
    };

    await client.query(
      `
        INSERT INTO public.financial_events_cache (
          firebase_id,
          player_uid,
          coadmin_uid,
          type,
          amount_npr,
          amount_coins,
          before_coin,
          after_coin,
          before_cash,
          after_cash,
          actor_uid,
          actor_role,
          related_user_uid,
          related_user_role,
          created_at,
          updated_at,
          source,
          mirrored_at,
          deleted_at,
          raw_firestore_data
        )
        VALUES (
          $1::text, $2::text, NULLIF($3::text, ''), 'staff_wallet_coin_load',
          $4::numeric, $4::numeric, $5::numeric, $6::numeric, $7::numeric, $7::numeric,
          $8::text, 'staff', $8::text, 'staff',
          $9::timestamptz, $9::timestamptz, 'authority_staff_wallet_load', now(), NULL,
          $10::jsonb
        )
        ON CONFLICT (firebase_id) DO NOTHING
      `,
      [
        eventId,
        playerUid,
        staffScopeUid,
        amount,
        beforePlayerCoin,
        afterPlayerCoin,
        beforePlayerCash,
        staffUid,
        nowIso,
        JSON.stringify(financialRawEvent),
      ]
    );

    await insertAuthorityLedgerEvent(client, {
      eventKey: `staffCoinWallets:${eventId}:${staffUid}:coin:staff_wallet_player_load_debit`,
      userUid: staffUid,
      username: staff.username,
      role: 'staff',
      coadminUid: staffScopeUid,
      balanceType: 'coin',
      direction: 'debit',
      delta: -amount,
      absoluteAfter: afterWalletBalance,
      eventType: 'staff_wallet_player_load_debit',
      sourceCollection: 'staff_coin_wallets',
      sourceId: eventId,
      actorUid: staffUid,
      actorRole: 'staff',
      confidence: 'high',
      sourceCreatedAt: nowIso,
      rawSourceData: financialRawEvent,
      sourceFields: {
        staffUid,
        playerUid,
        amount,
        beforeWalletBalance,
        afterWalletBalance,
        totalLoadedBefore: beforeTotalLoaded,
        totalLoadedAfter: afterTotalLoaded,
        beforePlayerCoin,
        afterPlayerCoin,
        idempotencyKey,
      },
    });

    await insertAuthorityLedgerEvent(client, {
      eventKey: `financialEvents:${eventId}:${playerUid}:coin:staff_wallet_coin_load`,
      userUid: playerUid,
      username: cleanText(player.username) || cleanText(raw.username) || null,
      role: 'player',
      coadminUid: staffScopeUid,
      balanceType: 'coin',
      direction: 'credit',
      delta: amount,
      absoluteAfter: afterPlayerCoin,
      eventType: 'staff_wallet_coin_load',
      sourceCollection: 'financialEvents',
      sourceId: eventId,
      actorUid: staffUid,
      actorRole: 'staff',
      confidence: 'high',
      sourceCreatedAt: nowIso,
      rawSourceData: financialRawEvent,
      sourceFields: {
        staffUid,
        playerUid,
        amount,
        beforeWalletBalance,
        afterWalletBalance,
        beforePlayerCoin,
        afterPlayerCoin,
        idempotencyKey,
      },
    });

    const balanceOutboxRows = buildPlayerBalanceUpdatedOutboxRows({
      playerUid,
      cashBalance: beforePlayerCash,
      coinBalance: afterPlayerCoin,
      reason: 'staff_wallet_coin_load',
      eventId,
      occurredAt: nowIso,
      source: 'authority_staff_wallet_load',
    }).map((row) => ({
      ...row,
      payload: {
        ...row.payload,
        staffUid,
        coadminUid: staffScopeUid,
        amount,
      },
    }));
    await insertLiveOutboxEventsBatch(client, balanceOutboxRows, {
      flowName: 'staff_wallet_coin_load_balance',
    });
    console.info('[PLAYER_BALANCE_EVENT_PUBLISHED]', {
      playerUid,
      eventId,
      eventType: 'player.balance.updated',
      sourceFlow: 'staff_wallet_coin_load',
      staffUid,
      coinBalance: afterPlayerCoin,
      cashBalance: beforePlayerCash,
      amount,
      updatedAt: nowIso,
    });

    await client.query('COMMIT');
    // Session/me extras are process-local; clear only after the credit has committed.
    invalidateSessionMePlayerExtras({ uid: playerUid });
    return {
      success: true,
      duplicate: false,
      staffUid,
      playerUid,
      coadminUid: staffScopeUid,
      loadedAmount: amount,
      staffWalletBalanceCoin: afterWalletBalance,
      playerBalanceCoin: afterPlayerCoin,
      eventId,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function readCurrentWallet(
  client: PoolClient,
  staffUid: string
): Promise<{ balanceCoin: number; totalAllocatedCoin: number } | null> {
  const wallet = await client.query<WalletRow>(
    `
      SELECT balance_coin, total_allocated_coin
      FROM public.staff_coin_wallets
      WHERE staff_uid = $1::text
        AND deleted_at IS NULL
      LIMIT 1
    `,
    [staffUid]
  );

  if (!wallet.rows.length) {
    return null;
  }

  return {
    balanceCoin: numberFromDb(wallet.rows[0].balance_coin),
    totalAllocatedCoin: numberFromDb(wallet.rows[0].total_allocated_coin),
  };
}

export async function allocateStaffWalletCoinsInSql(
  input: AllocateStaffWalletCoinsInput
): Promise<AllocateStaffWalletCoinsResult> {
  const staffUid = cleanText(input.staffUid);
  const amount = positiveIntegerAmount(input.amount);
  const actorUid = cleanText(input.actorUid);
  const actorRole = cleanText(input.actorRole);
  const scopeUid = cleanText(input.scopeUid);
  const note = cleanText(input.note) || null;

  if (!staffUid || !actorUid || !actorRole) {
    throw new Error('staffUid, actorUid, and actorRole are required.');
  }
  if (!input.isAdmin && !scopeUid) {
    throw new Error('Your account is not linked to a coadmin scope.');
  }

  const db = getPlayerMirrorPool();
  if (!db) {
    throw new Error('Postgres is unavailable.');
  }

  const eventId = randomUUID();
  const nowIso = new Date().toISOString();
  const idempotencyKey = cleanText(input.idempotencyKey);
  const operationKey = idempotencyKey
    ? `staff_wallet_allocate:${actorUid}:${idempotencyKey}`
    : `staff_wallet_allocate:${eventId}`;

  logAuthPayloadPreTxnRemoved('staff_wallet_allocate');
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const staff = await lookupUserDirectoryFromSql(staffUid, client);
    if (!staff) {
      throw new Error('Staff not found.');
    }
    if (cleanText(staff.role).toLowerCase() !== 'staff') {
      throw new Error('Selected account is not a staff account.');
    }

    const staffScopeUid = resolvePlayerScopeUid(staff);
    if (!staffScopeUid) {
      throw new Error('Selected staff is not linked to a coadmin scope.');
    }
    if (!input.isAdmin && staffScopeUid !== scopeUid) {
      throw new Error('Forbidden: this staff member is outside your scope.');
    }

    const claim = await claimAuthorityOperation(client, {
      operationKey,
      operationType: 'staff_wallet_allocate',
      userUid: staffUid,
      sourceId: eventId,
      actorUid,
      actorRole,
      payload: {
        staffUid,
        amount,
        coadminUid: staffScopeUid,
        note,
      },
    });

    if (claim.duplicate) {
      const existingPayload = normalizeDuplicatePayload(
        await readAuthorityOperationPayloadWithClient(client, operationKey, {
          flowName: 'staff_wallet_allocate',
        })
      );
      if (existingPayload.staffUid !== staffUid || existingPayload.amount !== amount) {
        throw new Error(
          'Duplicate idempotency key already used for a different staff wallet allocation.'
        );
      }

      const currentWallet = await readCurrentWallet(client, staffUid);
      await client.query('ROLLBACK');
      return {
        success: true,
        duplicate: true,
        staffUid,
        coadminUid: staffScopeUid,
        balanceCoin: currentWallet?.balanceCoin ?? 0,
        totalAllocatedCoin: currentWallet?.totalAllocatedCoin ?? 0,
        allocatedAmount: 0,
        eventId,
      };
    }

    const wallet = await lockWalletRow(client, {
      staffUid,
      coadminUid: staffScopeUid,
      nowIso,
    });
    const walletCoadminUid = cleanText(wallet.coadmin_uid);
    if (walletCoadminUid && walletCoadminUid !== staffScopeUid) {
      throw new Error('Staff wallet scope does not match selected staff.');
    }

    const beforeBalance = numberFromDb(wallet.balance_coin);
    const beforeTotalAllocated = numberFromDb(wallet.total_allocated_coin);
    const afterBalance = beforeBalance + amount;
    const afterTotalAllocated = beforeTotalAllocated + amount;

    await client.query(
      `
        UPDATE public.staff_coin_wallets
        SET
          coadmin_uid = $2::text,
          balance_coin = $3::numeric,
          total_allocated_coin = $4::numeric,
          updated_at = $5::timestamptz
        WHERE staff_uid = $1::text
          AND deleted_at IS NULL
      `,
      [staffUid, staffScopeUid, afterBalance, afterTotalAllocated, nowIso]
    );

    const rawEvent = {
      staffUid,
      coadminUid: staffScopeUid,
      amount,
      type: 'staff_wallet_allocate_credit',
      actorUid,
      actorRole,
      beforeWalletBalance: beforeBalance,
      afterWalletBalance: afterBalance,
      idempotencyKey: idempotencyKey || null,
      note,
      createdAt: nowIso,
    };

    await insertAuthorityLedgerEvent(client, {
      eventKey: `staffCoinWallets:${eventId}:${staffUid}:coin:staff_wallet_allocate_credit`,
      userUid: staffUid,
      username: staff.username,
      role: 'staff',
      coadminUid: staffScopeUid,
      balanceType: 'coin',
      direction: 'credit',
      delta: amount,
      absoluteAfter: afterBalance,
      eventType: 'staff_wallet_allocate_credit',
      sourceCollection: 'staff_coin_wallets',
      sourceId: eventId,
      actorUid,
      actorRole,
      confidence: 'high',
      sourceCreatedAt: nowIso,
      rawSourceData: rawEvent,
      sourceFields: {
        amount,
        beforeWalletBalance: beforeBalance,
        afterWalletBalance: afterBalance,
        totalAllocatedBefore: beforeTotalAllocated,
        totalAllocatedAfter: afterTotalAllocated,
        idempotencyKey: idempotencyKey || null,
        note,
      },
    });

    await client.query('COMMIT');
    return {
      success: true,
      duplicate: false,
      staffUid,
      coadminUid: staffScopeUid,
      balanceCoin: afterBalance,
      totalAllocatedCoin: afterTotalAllocated,
      allocatedAmount: amount,
      eventId,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
