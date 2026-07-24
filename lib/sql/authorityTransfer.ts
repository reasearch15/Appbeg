import 'server-only';

import type { PoolClient } from 'pg';

import {
  getCashToCoinCashoutLimitFee,
  getCashToCoinFee,
  getCoinToCashTip,
  parsePositiveInteger,
  parseTransferId,
} from '@/lib/server/playerTransferRules';
import { isPlayerCashoutRollingLimitHit } from '@/lib/sql/authorityCashout';
import { cleanText, getPlayerMirrorPool, toIsoString } from '@/lib/sql/playerMirrorCommon';
import {
  claimAuthorityOperation,
  insertAuthorityLedgerEvent,
  logAuthPayloadPreTxnRemoved,
  readAuthorityOperationPayloadWithClient,
} from '@/lib/sql/authorityLedger';
import {
  insertLiveOutboxEventWithClient,
  playerRequestLiveChannel,
  playerTransferLiveChannel,
} from '@/lib/sql/liveOutbox';

export type TransferDirection = 'cash_to_coin' | 'coin_to_cash';

export type AuthorityTransferResult = {
  success: true;
  duplicate: boolean;
  cash: number;
  coin: number;
  transferAmount: number;
  feeAmount: number;
  tipAmount: number;
  coinsReceived?: number;
  cashReceived?: number;
  transferId: string;
  eventId: string;
};

const CASH_TO_COIN_MAX_TRANSFER_AMOUNT = 25;
const CASH_TO_COIN_COOLDOWN_MINUTES = 10;
const CASH_TO_COIN_DAILY_LIMIT = 300;

function resolveEventId(direction: TransferDirection, playerUid: string, transferId: string) {
  const prefix = direction === 'cash_to_coin' ? 'cashToCoin' : 'coinToCash';
  return `${prefix}_${playerUid}_${transferId}`;
}

function resolveOperationKey(
  playerUid: string,
  direction: TransferDirection,
  idempotencyKey: string
) {
  return `transfer:${playerUid}:${direction}:${idempotencyKey}`;
}

function resolveFinancialEventType(direction: TransferDirection) {
  return direction === 'cash_to_coin' ? 'cash_to_coin_transfer' : 'coin_to_cash_transfer';
}

function normalizeTransferFeeAmount(direction: TransferDirection, rawFee: unknown) {
  const feeRaw = rawFee;
  let feeNumber = Number(rawFee);
  if (!Number.isFinite(feeNumber) || feeNumber < 0) {
    feeNumber = 0;
  }
  if (direction === 'cash_to_coin') {
    feeNumber = Number(feeNumber.toFixed(2));
  } else {
    feeNumber = Math.floor(feeNumber);
  }
  return {
    feeRaw,
    feeNumber,
    feeReason: feeNumber > 0 ? 'calculated' : 'none',
  };
}

function normalizeTransferAmount(rawAmount: unknown) {
  const amountRaw = rawAmount;
  const amountNumber = parsePositiveInteger(rawAmount);
  return { amountRaw, amountNumber };
}

function isTransferSqlParameterError(message: string) {
  return /could not determine data type of parameter|invalid input syntax for type/i.test(
    message
  );
}

export function mapAuthorityTransferSqlError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || '');
  if (
    isTransferSqlParameterError(message) ||
    message === 'Transfer fee could not be calculated. Please try again.'
  ) {
    return 'Transfer fee could not be calculated. Please try again.';
  }
  return message;
}

function readTransferBlockedUntilMs(row: Record<string, unknown>) {
  const direct = toIsoString(row.transfer_blocked_until);
  if (direct) {
    const ms = new Date(direct).getTime();
    if (!Number.isNaN(ms)) return ms;
  }
  const raw = row.raw_firestore_data;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const blocked = (raw as Record<string, unknown>).transferBlockedUntil;
    const iso = toIsoString(blocked);
    if (iso) {
      const ms = new Date(iso).getTime();
      if (!Number.isNaN(ms)) return ms;
    }
  }
  return 0;
}

function numberValue(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function minutesUntilAvailable(lastTransferAt: unknown) {
  const iso = toIsoString(lastTransferAt);
  if (!iso) return CASH_TO_COIN_COOLDOWN_MINUTES;
  const elapsedMs = Date.now() - new Date(iso).getTime();
  const remainingMs = CASH_TO_COIN_COOLDOWN_MINUTES * 60_000 - elapsedMs;
  return Math.max(1, Math.ceil(remainingMs / 60_000));
}

async function enforceCashToCoinTransferLimitsInTxn(
  client: PoolClient,
  input: {
    playerUid: string;
    amount: number;
  }
) {
  if (input.amount > CASH_TO_COIN_MAX_TRANSFER_AMOUNT) {
    throw new Error('Maximum transfer amount is $25.');
  }

  const recentTransfer = await client.query(
    `
      SELECT created_at
      FROM public.financial_events_cache
      WHERE player_uid = $1::text
        AND type = 'cash_to_coin_transfer'
        AND deleted_at IS NULL
        AND created_at > now() - interval '10 minutes'
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [input.playerUid]
  );
  if (recentTransfer.rows.length) {
    const minutes = minutesUntilAvailable((recentTransfer.rows[0] as Record<string, unknown>).created_at);
    throw new Error(`Another transfer is available in ${minutes} minutes.`);
  }

  const dailyTotal = await client.query(
    `
      SELECT COALESCE(SUM(COALESCE(amount_npr, (raw_firestore_data->>'transferAmount')::numeric)), 0) AS total
      FROM public.financial_events_cache
      WHERE player_uid = $1::text
        AND type = 'cash_to_coin_transfer'
        AND deleted_at IS NULL
        AND created_at > now() - interval '24 hours'
    `,
    [input.playerUid]
  );
  const existingTotal = numberValue((dailyTotal.rows[0] as Record<string, unknown> | undefined)?.total);
  if (existingTotal + input.amount > CASH_TO_COIN_DAILY_LIMIT) {
    throw new Error('Daily transfer limit reached.');
  }
}

async function enforceCoinToCashTransferLimitsInTxn(
  client: PoolClient,
  input: {
    playerUid: string;
    amount: number;
  }
) {
  const recentTransfer = await client.query(
    `
      SELECT
        created_at,
        GREATEST(
          0,
          CEIL(EXTRACT(EPOCH FROM (created_at + interval '30 minutes' - now())) * 1000)
        )::bigint AS remaining_wait_ms
      FROM public.financial_events_cache
      WHERE player_uid = $1::text
        AND type = 'coin_to_cash_transfer'
        AND deleted_at IS NULL
        AND created_at > now() - interval '30 minutes'
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [input.playerUid]
  );

  if (!recentTransfer.rows.length) {
    return;
  }

  const lastTransfer = recentTransfer.rows[0] as Record<string, unknown>;
  const lastTransferAt = toIsoString(lastTransfer.created_at) || null;
  const remainingWaitMs = Math.max(0, Number(lastTransfer.remaining_wait_ms || 0));
  console.info('[COIN_TO_CASH_TRANSFER_BLOCKED]', {
    uid: input.playerUid,
    amount: input.amount,
    lastTransferAt,
    remainingWaitMs,
  });
  throw new Error('You can transfer again 30 minutes after your last coin-to-cash transfer.');
}

function storedTransferResult(
  payload: Record<string, unknown>,
  transferId: string,
  eventId: string
): AuthorityTransferResult {
  return {
    success: true,
    duplicate: true,
    cash: numberValue(payload.cash),
    coin: numberValue(payload.coin),
    transferAmount: Math.max(0, Number(payload.transferAmount || 0)),
    feeAmount: Number(payload.feeAmount || 0),
    tipAmount: Number(payload.tipAmount || 0),
    coinsReceived:
      payload.coinsReceived == null ? undefined : Number(payload.coinsReceived),
    cashReceived: payload.cashReceived == null ? undefined : Number(payload.cashReceived),
    transferId,
    eventId,
  };
}

async function writeTransferOutbox(
  client: PoolClient,
  input: {
    playerUid: string;
    transferId: string;
    direction: TransferDirection;
    status: string;
    transferAmount: number;
    cash: number;
    coin: number;
    updatedAt: string;
  }
) {
  const payload = {
    entityId: input.transferId,
    playerUid: input.playerUid,
    transferId: input.transferId,
    direction: input.direction,
    status: input.status,
    transferAmount: input.transferAmount,
    cash: input.cash,
    coin: input.coin,
    updatedAt: input.updatedAt,
    source: 'authority',
  };

  await insertLiveOutboxEventWithClient(client, {
    channel: playerTransferLiveChannel(input.playerUid),
    eventType: input.direction === 'cash_to_coin' ? 'cash_to_coin_transfer' : 'coin_to_cash_transfer',
    entityType: 'player_transfer',
    entityId: input.transferId,
    source: 'authority_transfer',
    mirroredAt: input.updatedAt,
    payload,
  });

  await insertLiveOutboxEventWithClient(client, {
    channel: playerRequestLiveChannel(input.playerUid),
    eventType: 'balance_update',
    entityType: 'player_balance',
    entityId: input.playerUid,
    source: 'authority_transfer',
    mirroredAt: input.updatedAt,
    payload: {
      ...payload,
      entityId: input.playerUid,
      reason: input.direction,
    },
  });
}

async function insertTransferFinancialEvent(
  client: PoolClient,
  input: {
    eventId: string;
    playerUid: string;
    coadminUid: string | null;
    direction: TransferDirection;
    transferAmount: number;
    feeAmount: number;
    tipAmount: number;
    coinsReceived?: number;
    cashReceived?: number;
    transferId: string;
    beforeCash: number;
    afterCash: number;
    beforeCoin: number;
    afterCoin: number;
    nowIso: string;
  }
) {
  const type = resolveFinancialEventType(input.direction);
  const rawEvent = {
    playerUid: input.playerUid,
    playerId: input.playerUid,
    coadminUid: input.coadminUid,
    transferAmount: input.transferAmount,
    grossAmount: input.transferAmount,
    amountNpr: input.direction === 'cash_to_coin' ? input.transferAmount : undefined,
    amountCoins: input.direction === 'coin_to_cash' ? input.transferAmount : undefined,
    feeAmount: input.feeAmount,
    netCoinAmount: input.direction === 'cash_to_coin' ? input.coinsReceived ?? 0 : undefined,
    netCashAmount: input.direction === 'coin_to_cash' ? input.cashReceived ?? 0 : undefined,
    tipAmount: input.tipAmount,
    tipNpr: input.tipAmount,
    coinsReceived: input.coinsReceived ?? null,
    cashReceived: input.cashReceived ?? null,
    beforeCash: input.beforeCash,
    afterCash: input.afterCash,
    beforeCoins: input.beforeCoin,
    afterCoins: input.afterCoin,
    beforeCoin: input.beforeCoin,
    afterCoin: input.afterCoin,
    beforeBalances: { cash: input.beforeCash, coin: input.beforeCoin },
    afterBalances: { cash: input.afterCash, coin: input.afterCoin },
    transferId: input.transferId,
    type,
    timestamp: input.nowIso,
    createdAt: input.nowIso,
  };

  await client.query(
    `
      INSERT INTO public.financial_events_cache (
        firebase_id, player_uid, player_id, coadmin_uid, type,
        amount_npr, amount_coins, transfer_id,
        fee_amount, tip_amount, cash_received, coins_received,
        before_cash, after_cash, before_coin, after_coin,
        before_balances, after_balances,
        created_at, updated_at, source, mirrored_at, deleted_at,
        raw_firestore_data
      )
      VALUES (
        $1::text, $2::text, $2::text, NULLIF($3::text, ''), $4::text,
        $5::numeric, $6::numeric, $7::text,
        $8::numeric, $9::numeric, $10::numeric, $11::numeric,
        $12::numeric, $13::numeric, $14::numeric, $15::numeric,
        $16::jsonb, $17::jsonb,
        $18::timestamptz, $18::timestamptz, 'authority_transfer', now(), NULL,
        $19::jsonb
      )
      ON CONFLICT (firebase_id) DO NOTHING
    `,
    [
      input.eventId,
      input.playerUid,
      input.coadminUid,
      type,
      input.direction === 'cash_to_coin' ? input.transferAmount : null,
      input.direction === 'coin_to_cash' ? input.transferAmount : null,
      input.transferId,
      Number(input.feeAmount) || 0,
      Number(input.tipAmount) || 0,
      input.cashReceived ?? null,
      input.coinsReceived ?? null,
      input.beforeCash,
      input.afterCash,
      input.beforeCoin,
      input.afterCoin,
      JSON.stringify({ cash: input.beforeCash, coin: input.beforeCoin }),
      JSON.stringify({ cash: input.afterCash, coin: input.afterCoin }),
      input.nowIso,
      JSON.stringify(rawEvent),
    ]
  );
}

async function insertTransferLedgerEvents(
  client: PoolClient,
  input: {
    eventId: string;
    playerUid: string;
    username: string | null;
    coadminUid: string | null;
    direction: TransferDirection;
    beforeCash: number;
    afterCash: number;
    beforeCoin: number;
    afterCoin: number;
    nowIso: string;
    rawEvent: Record<string, unknown>;
  }
) {
  const cashDelta = input.afterCash - input.beforeCash;
  const coinDelta = input.afterCoin - input.beforeCoin;
  const cashEventType =
    input.direction === 'cash_to_coin' ? 'cash_to_coin_cash_debit' : 'coin_to_cash_cash_credit';
  const coinEventType =
    input.direction === 'cash_to_coin' ? 'cash_to_coin_coin_credit' : 'coin_to_cash_coin_debit';

  await insertAuthorityLedgerEvent(client, {
    eventKey: `financialEvents:${input.eventId}:${input.playerUid}:cash:${cashEventType}`,
    userUid: input.playerUid,
    username: input.username,
    role: 'player',
    coadminUid: input.coadminUid,
    balanceType: 'cash',
    direction: cashDelta >= 0 ? 'credit' : 'debit',
    delta: cashDelta,
    absoluteAfter: input.afterCash,
    eventType: cashEventType,
    sourceCollection: 'financialEvents',
    sourceId: input.eventId,
    actorUid: input.playerUid,
    actorRole: 'player',
    confidence: 'high',
    sourceCreatedAt: input.nowIso,
    rawSourceData: input.rawEvent,
    sourceFields: {
      beforeCash: input.beforeCash,
      afterCash: input.afterCash,
      grossAmount: input.rawEvent.transferAmount,
      feeAmount: input.rawEvent.feeAmount,
      netAmount: input.direction === 'cash_to_coin' ? input.rawEvent.coinsReceived : input.rawEvent.cashReceived,
    },
  });

  await insertAuthorityLedgerEvent(client, {
    eventKey: `financialEvents:${input.eventId}:${input.playerUid}:coin:${coinEventType}`,
    userUid: input.playerUid,
    username: input.username,
    role: 'player',
    coadminUid: input.coadminUid,
    balanceType: 'coin',
    direction: coinDelta >= 0 ? 'credit' : 'debit',
    delta: coinDelta,
    absoluteAfter: input.afterCoin,
    eventType: coinEventType,
    sourceCollection: 'financialEvents',
    sourceId: input.eventId,
    actorUid: input.playerUid,
    actorRole: 'player',
    confidence: 'high',
    sourceCreatedAt: input.nowIso,
    rawSourceData: input.rawEvent,
    sourceFields: {
      beforeCoin: input.beforeCoin,
      afterCoin: input.afterCoin,
      grossAmount: input.rawEvent.transferAmount,
      feeAmount: input.rawEvent.feeAmount,
      netAmount: input.direction === 'cash_to_coin' ? input.rawEvent.coinsReceived : input.rawEvent.cashReceived,
    },
  });
}

export async function transferPlayerBalancesInSql(input: {
  playerUid: string;
  direction: TransferDirection;
  amountNpr?: unknown;
  amountCoins?: unknown;
  transferId?: unknown;
  idempotencyKey?: string | null;
}): Promise<AuthorityTransferResult> {
  const playerUid = cleanText(input.playerUid);
  const direction = input.direction;
  const transferId = parseTransferId(input.transferId);
  const idempotencyKey =
    cleanText(input.idempotencyKey) || cleanText(input.transferId) || transferId;

  if (!playerUid) {
    throw new Error('Player profile not found.');
  }
  if (!transferId || !idempotencyKey) {
    throw new Error('Transfer id is required.');
  }

  const { amountRaw, amountNumber: amount } =
    direction === 'cash_to_coin'
      ? normalizeTransferAmount(input.amountNpr)
      : normalizeTransferAmount(input.amountCoins);

  if (!amount) {
    throw new Error('Amount must be a positive whole number.');
  }
  if (direction === 'coin_to_cash' && amount < 10) {
    throw new Error('Minimum Coin to Cash amount is 10.');
  }

  let cashoutLimitHitForCashToCoin = false;
  let rawFee =
    direction === 'cash_to_coin'
      ? getCashToCoinFee(amount)
      : getCoinToCashTip(amount);
  const { feeRaw, feeNumber: feeAmount, feeReason } = normalizeTransferFeeAmount(
    direction,
    rawFee
  );
  const tipAmount = direction === 'coin_to_cash' ? feeAmount : 0;
  const coinsReceived = direction === 'cash_to_coin' ? amount - feeAmount : undefined;
  const cashReceived = direction === 'coin_to_cash' ? amount - tipAmount : undefined;

  console.info('[AUTHORITY_TRANSFER_INPUT]', {
    uid: playerUid,
    direction,
    amountRaw,
    amountNumber: amount,
    feeRaw,
    feeNumber: feeAmount,
    feeReason,
    tipAmount,
    transferId,
  });

  if (feeAmount < 0) {
    throw new Error('Transfer fee could not be calculated. Please try again.');
  }

  if (direction === 'cash_to_coin' && (coinsReceived ?? 0) <= 0) {
    throw new Error('Transfer amount is too low after fee.');
  }
  if (direction === 'coin_to_cash' && (cashReceived ?? 0) <= 0) {
    throw new Error('Transfer amount is too low after tip.');
  }

  const eventId = resolveEventId(direction, playerUid, transferId);
  const operationKey = resolveOperationKey(playerUid, direction, idempotencyKey);
  const operationType =
    direction === 'cash_to_coin' ? 'transfer_cash_to_coin' : 'transfer_coin_to_cash';

  console.info('[AUTHORITY_TRANSFER_START]', {
    playerUid,
    direction,
    transferId,
    amount,
    operationKey,
  });

  logAuthPayloadPreTxnRemoved(`transfer_${direction}`);
  const db = getPlayerMirrorPool();
  if (!db) {
    throw new Error('Postgres is unavailable.');
  }

  const client = await db.connect();
  const nowIso = new Date().toISOString();

  try {
    await client.query('BEGIN');

    const existingFinancial = await client.query(
      `
        SELECT firebase_id
        FROM public.financial_events_cache
        WHERE firebase_id = $1
          AND deleted_at IS NULL
        LIMIT 1
      `,
      [eventId]
    );
    if ((existingFinancial.rowCount || 0) > 0) {
      const payload = await readAuthorityOperationPayloadWithClient(client, operationKey, {
        flowName: `transfer_${direction}`,
      });
      await client.query('ROLLBACK');
      if (payload?.transferId) {
        return storedTransferResult(payload, transferId, eventId);
      }
      throw new Error('Duplicate transfer id.');
    }

    const claim = await claimAuthorityOperation(client, {
      operationKey,
      operationType,
      userUid: playerUid,
      sourceId: eventId,
      actorUid: playerUid,
      actorRole: 'player',
      payload: {},
    });
    if (claim.duplicate) {
      const payload = await readAuthorityOperationPayloadWithClient(client, operationKey, {
        flowName: `transfer_${direction}`,
      });
      await client.query('ROLLBACK');
      if (payload?.transferId) {
        return storedTransferResult(payload, transferId, eventId);
      }
      throw new Error('Duplicate transfer id.');
    }

    const playerLock = await client.query(
      `
        SELECT
          uid,
          username,
          role,
          status,
          coin,
          cash,
          coadmin_uid,
          created_by,
          raw_firestore_data
        FROM public.players_cache
        WHERE uid = $1
          AND deleted_at IS NULL
        FOR UPDATE
      `,
      [playerUid]
    );
    if (!playerLock.rows.length) {
      throw new Error('Player profile not found.');
    }
    const player = playerLock.rows[0] as Record<string, unknown>;

    if (cleanText(player.role).toLowerCase() !== 'player') {
      throw new Error(
        direction === 'cash_to_coin'
          ? 'Only players can transfer cash to coin.'
          : 'Only players can transfer coin to cash.'
      );
    }
    if (cleanText(player.status).toLowerCase() === 'disabled') {
      throw new Error('Your account is blocked.');
    }

    const snapshotLock = await client.query(
      `
        SELECT transfer_blocked_until, raw_firestore_data
        FROM public.user_balance_snapshots_cache
        WHERE firebase_id = $1
          AND deleted_at IS NULL
        FOR UPDATE
      `,
      [playerUid]
    );
    const snapshot = (snapshotLock.rows[0] as Record<string, unknown> | undefined) || {};
    const blockedUntilMs = readTransferBlockedUntilMs(snapshot);
    if (blockedUntilMs > Date.now()) {
      throw new Error('Transfer is temporarily blocked. Contact staff.');
    }

    if (direction === 'cash_to_coin') {
      cashoutLimitHitForCashToCoin = await isPlayerCashoutRollingLimitHit(client, playerUid);
      if (cashoutLimitHitForCashToCoin) {
        rawFee = getCashToCoinCashoutLimitFee(amount);
      } else {
        await enforceCashToCoinTransferLimitsInTxn(client, {
          playerUid,
          amount,
        });
      }
    } else {
      await enforceCoinToCashTransferLimitsInTxn(client, {
        playerUid,
        amount,
      });
    }

    const currentCash = numberValue(player.cash);
    const currentCoin = numberValue(player.coin);
    console.info('[AUTHORITY_TRANSFER_BALANCE_BEFORE]', {
      playerUid,
      direction,
      transferId,
      cash: currentCash,
      coin: currentCoin,
    });

    if (direction === 'cash_to_coin') {
      if (currentCash < amount) {
        throw new Error('Not enough cash available for transfer.');
      }
    } else if (currentCoin < amount) {
      throw new Error('Not enough coin available for transfer.');
    }

    const coadminUid =
      cleanText(player.coadmin_uid) || cleanText(player.created_by) || null;

    const effectiveFee = direction === 'cash_to_coin' ? normalizeTransferFeeAmount(
      direction,
      rawFee
    ).feeNumber : feeAmount;
    const effectiveTipAmount = direction === 'coin_to_cash' ? feeAmount : 0;
    const effectiveCoinsReceived =
      direction === 'cash_to_coin' ? amount - effectiveFee : undefined;
    const effectiveCashReceived =
      direction === 'coin_to_cash' ? amount - effectiveTipAmount : undefined;

    if (direction === 'cash_to_coin' && (effectiveCoinsReceived ?? 0) <= 0) {
      throw new Error('Transfer amount is too low after fee.');
    }
    if (direction === 'coin_to_cash' && (effectiveCashReceived ?? 0) <= 0) {
      throw new Error('Transfer amount is too low after tip.');
    }
    if (cashoutLimitHitForCashToCoin) {
      console.info('[CASH_TO_COIN_CASHOUT_LIMIT_EXCEPTION_USED]', {
        uid: playerUid,
        amount,
        fee: effectiveFee,
        netCoinAmount: effectiveCoinsReceived ?? 0,
        cashoutLimitHit: true,
      });
    }

    const newCash =
      direction === 'cash_to_coin' ? currentCash - amount : currentCash + (effectiveCashReceived ?? 0);
    const newCoin =
      direction === 'cash_to_coin' ? currentCoin + (effectiveCoinsReceived ?? 0) : currentCoin - amount;

    await client.query(
      `
        UPDATE public.players_cache
        SET
          cash = $2::numeric,
          coin = $3::numeric,
          updated_at = $4::timestamptz,
          raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb)
            || jsonb_build_object('cash', $2::numeric, 'coin', $3::numeric)
        WHERE uid = $1::text
          AND deleted_at IS NULL
      `,
      [playerUid, newCash, newCoin, nowIso]
    );

    await client.query(
      `
        UPDATE public.user_balance_snapshots_cache
        SET
          cash = $2::numeric,
          coin = $3::numeric,
          updated_at = $4::timestamptz,
          mirrored_at = now(),
          raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb)
            || jsonb_build_object('cash', $2::numeric, 'coin', $3::numeric)
        WHERE firebase_id = $1::text
          AND deleted_at IS NULL
      `,
      [playerUid, newCash, newCoin, nowIso]
    );

    const rawEvent = {
      playerUid,
      playerId: playerUid,
      coadminUid,
      transferAmount: amount,
      grossAmount: amount,
      amountNpr: direction === 'cash_to_coin' ? amount : undefined,
      amountCoins: direction === 'coin_to_cash' ? amount : undefined,
      feeAmount: effectiveFee,
      netCoinAmount: direction === 'cash_to_coin' ? effectiveCoinsReceived ?? 0 : undefined,
      netCashAmount: direction === 'coin_to_cash' ? effectiveCashReceived ?? 0 : undefined,
      tipAmount: effectiveTipAmount,
      tipNpr: effectiveTipAmount,
      coinsReceived: effectiveCoinsReceived ?? null,
      cashReceived: effectiveCashReceived ?? null,
      cashoutLimitHit: cashoutLimitHitForCashToCoin || undefined,
      beforeCash: currentCash,
      afterCash: newCash,
      beforeCoins: currentCoin,
      afterCoins: newCoin,
      beforeCoin: currentCoin,
      afterCoin: newCoin,
      beforeBalances: { cash: currentCash, coin: currentCoin },
      afterBalances: { cash: newCash, coin: newCoin },
      transferId,
      type: resolveFinancialEventType(direction),
      timestamp: nowIso,
      createdAt: nowIso,
    };

    await insertTransferFinancialEvent(client, {
      eventId,
      playerUid,
      coadminUid,
      direction,
      transferAmount: amount,
      feeAmount: effectiveFee,
      tipAmount: effectiveTipAmount,
      coinsReceived: effectiveCoinsReceived,
      cashReceived: effectiveCashReceived,
      transferId,
      beforeCash: currentCash,
      afterCash: newCash,
      beforeCoin: currentCoin,
      afterCoin: newCoin,
      nowIso,
    });

    await insertTransferLedgerEvents(client, {
      eventId,
      playerUid,
      username: cleanText(player.username) || null,
      coadminUid,
      direction,
      beforeCash: currentCash,
      afterCash: newCash,
      beforeCoin: currentCoin,
      afterCoin: newCoin,
      nowIso,
      rawEvent,
    });
    console.info('[AUTHORITY_TRANSFER_LEDGER_WRITTEN]', {
      playerUid,
      direction,
      transferId,
      eventId,
    });

    await writeTransferOutbox(client, {
      playerUid,
      transferId,
      direction,
      status: 'completed',
      transferAmount: amount,
      cash: newCash,
      coin: newCoin,
      updatedAt: nowIso,
    });
    if (process.env.NODE_ENV !== 'production') {
      console.info('[PLAYER_BALANCE_EVENT]', {
        playerUid,
        direction,
        transferId,
        cash: newCash,
        coin: newCoin,
        source: 'authority_transfer',
      });
    }

    const resultPayload = {
      cash: newCash,
      coin: newCoin,
      transferAmount: amount,
      feeAmount: effectiveFee,
      tipAmount: effectiveTipAmount,
      coinsReceived: effectiveCoinsReceived ?? null,
      cashReceived: effectiveCashReceived ?? null,
      transferId,
      eventId,
    };

    await client.query(
      `
        UPDATE public.authority_operations
        SET payload = $2::jsonb
        WHERE operation_key = $1
      `,
      [operationKey, JSON.stringify(resultPayload)]
    );

    await client.query('COMMIT');
    console.info('[AUTHORITY_TRANSFER_BALANCE_AFTER]', {
      playerUid,
      direction,
      transferId,
      cash: newCash,
      coin: newCoin,
    });
    console.info('[AUTHORITY_TRANSFER_DONE]', {
      playerUid,
      direction,
      transferId,
      eventId,
    });

    return {
      success: true,
      duplicate: false,
      cash: newCash,
      coin: newCoin,
      transferAmount: amount,
      feeAmount: effectiveFee,
      tipAmount: effectiveTipAmount,
      coinsReceived: effectiveCoinsReceived,
      cashReceived: effectiveCashReceived,
      transferId,
      eventId,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    const message = error instanceof Error ? error.message : String(error || '');
    console.info('[AUTHORITY_TRANSFER_ERROR]', {
      playerUid,
      direction,
      transferId,
      error: message,
    });
    if (isTransferSqlParameterError(message)) {
      throw new Error('Transfer fee could not be calculated. Please try again.');
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function transferCashToCoinInSql(input: {
  playerUid: string;
  amountNpr?: unknown;
  transferId?: unknown;
  idempotencyKey?: string | null;
}) {
  return transferPlayerBalancesInSql({
    playerUid: input.playerUid,
    direction: 'cash_to_coin',
    amountNpr: input.amountNpr,
    transferId: input.transferId,
    idempotencyKey: input.idempotencyKey,
  });
}

export async function transferCoinToCashInSql(input: {
  playerUid: string;
  amountCoins?: unknown;
  transferId?: unknown;
  idempotencyKey?: string | null;
}) {
  return transferPlayerBalancesInSql({
    playerUid: input.playerUid,
    direction: 'coin_to_cash',
    amountCoins: input.amountCoins,
    transferId: input.transferId,
    idempotencyKey: input.idempotencyKey,
  });
}
