export const PLAYER_BALANCE_UPDATED_EVENT = 'player.balance.updated';
export const PLAYER_BALANCE_UPDATE_LEGACY_EVENT = 'balance_update';

export type PlayerBalanceUpdatedReason =
  | 'redeem_completed'
  | 'recharge_completed'
  | 'recharge_refunded'
  | 'cashout_request_deduct'
  | 'cash_to_coin'
  | 'coin_to_cash'
  | string;

export type PlayerBalanceUpdatedPayload = {
  entityId: string;
  playerUid: string;
  cashBalance: number;
  coinBalance?: number | null;
  reason: PlayerBalanceUpdatedReason;
  taskId?: string | null;
  requestId?: string | null;
  eventId: string;
  occurredAt: string;
  updatedAt: string;
  source: string;
  /** Legacy field kept for existing transfer/cashout listeners. */
  cash?: number;
  coin?: number | null;
};

export type PlayerBalanceOutboxRow = {
  channel: string;
  eventType: string;
  entityType: string;
  entityId: string;
  payload: Record<string, unknown>;
  source?: string;
  mirroredAt?: string | null;
};

function cleanText(value: unknown) {
  return String(value || '').trim();
}

function finiteMoney(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return null;
  }
  return Math.max(0, n);
}

export function playerBalanceLiveChannel(playerUid: string) {
  return `player:${cleanText(playerUid)}:requests`;
}

export function buildPlayerBalanceUpdatedPayload(input: {
  playerUid: string;
  cashBalance: number;
  coinBalance?: number | null;
  reason: PlayerBalanceUpdatedReason;
  eventId: string;
  occurredAt: string;
  taskId?: string | null;
  requestId?: string | null;
  source?: string;
}): PlayerBalanceUpdatedPayload {
  const playerUid = cleanText(input.playerUid);
  const eventId = cleanText(input.eventId);
  const occurredAt = cleanText(input.occurredAt) || new Date().toISOString();
  const cashBalance = finiteMoney(input.cashBalance) ?? 0;
  const coinBalance =
    input.coinBalance === undefined || input.coinBalance === null
      ? null
      : finiteMoney(input.coinBalance);

  return {
    entityId: playerUid,
    playerUid,
    cashBalance,
    coinBalance,
    cash: cashBalance,
    coin: coinBalance,
    reason: cleanText(input.reason) || 'balance_updated',
    taskId: cleanText(input.taskId) || null,
    requestId: cleanText(input.requestId) || null,
    eventId,
    occurredAt,
    updatedAt: occurredAt,
    source: cleanText(input.source) || 'authority',
  };
}

/**
 * Emits the canonical player.balance.updated event plus the legacy balance_update
 * alias with the same authoritative payload. Callers must insert these rows inside
 * the same DB transaction as the cash credit so publication cannot precede commit.
 */
export function buildPlayerBalanceUpdatedOutboxRows(input: {
  playerUid: string;
  cashBalance: number;
  coinBalance?: number | null;
  reason: PlayerBalanceUpdatedReason;
  eventId: string;
  occurredAt: string;
  taskId?: string | null;
  requestId?: string | null;
  source?: string;
  includeLegacyBalanceUpdate?: boolean;
}): PlayerBalanceOutboxRow[] {
  const playerUid = cleanText(input.playerUid);
  const eventId = cleanText(input.eventId);
  if (!playerUid || !eventId) {
    return [];
  }

  const cashBalance = finiteMoney(input.cashBalance);
  if (cashBalance == null) {
    return [];
  }

  const payload = buildPlayerBalanceUpdatedPayload({
    ...input,
    playerUid,
    eventId,
    cashBalance,
  });
  const source = payload.source;
  const mirroredAt = payload.occurredAt;
  const rows: PlayerBalanceOutboxRow[] = [
    {
      channel: playerBalanceLiveChannel(playerUid),
      eventType: PLAYER_BALANCE_UPDATED_EVENT,
      entityType: 'player_balance',
      entityId: playerUid,
      source,
      mirroredAt,
      payload: payload as unknown as Record<string, unknown>,
    },
  ];

  if (input.includeLegacyBalanceUpdate !== false) {
    rows.push({
      channel: playerBalanceLiveChannel(playerUid),
      eventType: PLAYER_BALANCE_UPDATE_LEGACY_EVENT,
      entityType: 'player_balance',
      entityId: playerUid,
      source,
      mirroredAt,
      payload: payload as unknown as Record<string, unknown>,
    });
  }

  return rows;
}

export function readAuthoritativeCashFromBalancePayload(
  payload: Record<string, unknown> | null | undefined
): number | null {
  if (!payload) {
    return null;
  }
  const fromCashBalance = finiteMoney(payload.cashBalance);
  if (fromCashBalance != null) {
    return fromCashBalance;
  }
  return finiteMoney(payload.cash);
}

export function readAuthoritativeCoinFromBalancePayload(
  payload: Record<string, unknown> | null | undefined
): number | null {
  if (!payload) {
    return null;
  }
  const fromCoinBalance = finiteMoney(payload.coinBalance);
  if (fromCoinBalance != null) {
    return fromCoinBalance;
  }
  return finiteMoney(payload.coin);
}

export function balanceEventDedupeKey(input: {
  eventName: string;
  eventId?: string | null;
  taskId?: string | null;
  requestId?: string | null;
  outboxId?: number | null;
}): string {
  const eventId = cleanText(input.eventId);
  if (eventId) {
    return `event:${eventId}`;
  }
  const taskId = cleanText(input.taskId);
  if (taskId) {
    return `task:${taskId}:${cleanText(input.eventName)}`;
  }
  const requestId = cleanText(input.requestId);
  if (requestId) {
    return `request:${requestId}:${cleanText(input.eventName)}`;
  }
  const outboxId = Number(input.outboxId || 0);
  if (Number.isFinite(outboxId) && outboxId > 0) {
    return `outbox:${outboxId}`;
  }
  return '';
}

/** Pure ordering check used by tests and call-site docs. */
export function assertRedeemBalanceEventOrdering(steps: string[]) {
  const expected = [
    'lock_validate_task',
    'write_ledger_or_cash_credit',
    'update_authoritative_balance',
    'commit_database_transaction',
    'mark_task_completed',
    'publish_player_balance_event',
  ];
  // Outbox insert is inside the txn before COMMIT; Postgres NOTIFY delivers after commit.
  // Call-site order in SQL authority is: credit → ledger → mark completed → outbox insert → COMMIT.
  const actualAllowed = [
    'lock_validate_task',
    'write_ledger_or_cash_credit',
    'update_authoritative_balance',
    'mark_task_completed',
    'publish_player_balance_event',
    'commit_database_transaction',
  ];
  if (steps.length !== actualAllowed.length) {
    return { ok: false as const, expected: actualAllowed, actual: steps };
  }
  for (let i = 0; i < actualAllowed.length; i += 1) {
    if (steps[i] !== actualAllowed[i]) {
      return { ok: false as const, expected: actualAllowed, actual: steps, note: expected };
    }
  }
  return { ok: true as const, expected: actualAllowed, actual: steps };
}
