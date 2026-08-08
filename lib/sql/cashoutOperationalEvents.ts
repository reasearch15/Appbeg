import 'server-only';

import type { PoolClient } from 'pg';

import { cleanText, getPlayerMirrorPool, toIsoString } from '@/lib/sql/playerMirrorCommon';

export type CashoutOperationalClaim = {
  actionSource: string;
  telegramUserId: string | null;
  telegramUsername: string | null;
  telegramDisplayName: string | null;
  telegramClaimedAt: string | null;
};

export type CashoutOperationalCompletion = {
  actionSource: string;
  telegramUserId: string | null;
  telegramUsername: string | null;
  telegramDisplayName: string | null;
  telegramCompletedAt: string | null;
};

/** @deprecated Prefer operationalClaim / operationalCompletion. Kept for Phase 5 callers. */
export type CashoutOperationalAttribution = CashoutOperationalClaim & {
  telegramCompletedAt?: string | null;
  completionSource?: string | null;
};

export type TelegramOperationalActor = {
  actionSource?: string;
  telegramUserId: string;
  telegramUsername?: string | null;
  telegramDisplayName?: string | null;
  idempotencyKey?: string | null;
};

export function telegramCashoutClaimIdempotencyKey(taskId: string, telegramUserId: string) {
  return `cashout_claim:${cleanText(taskId)}:telegram:${cleanText(telegramUserId)}`;
}

export function telegramCashoutCompleteIdempotencyKey(taskId: string, telegramUserId: string) {
  return `cashout_complete:${cleanText(taskId)}:telegram:${cleanText(telegramUserId)}`;
}

export function readOperationalClaimFromTaskRow(
  row: Record<string, unknown> | null | undefined
): CashoutOperationalClaim | null {
  if (!row) return null;
  const actionSource = cleanText(row.operational_action_source);
  const telegramUserId = cleanText(row.operational_telegram_user_id);
  if (!actionSource && !telegramUserId) return null;
  return {
    actionSource: actionSource || 'telegram',
    telegramUserId: telegramUserId || null,
    telegramUsername: cleanText(row.operational_telegram_username) || null,
    telegramDisplayName: cleanText(row.operational_telegram_display_name) || null,
    telegramClaimedAt: toIsoString(row.operational_telegram_claimed_at),
  };
}

export function readOperationalCompletionFromTaskRow(
  row: Record<string, unknown> | null | undefined
): CashoutOperationalCompletion | null {
  if (!row) return null;
  const actionSource = cleanText(row.operational_completion_source);
  const telegramUserId = cleanText(row.operational_completion_telegram_user_id);
  const completedAt = toIsoString(row.operational_telegram_completed_at);
  if (!actionSource && !telegramUserId && !completedAt) return null;
  return {
    actionSource: actionSource || 'telegram',
    telegramUserId: telegramUserId || null,
    telegramUsername: cleanText(row.operational_completion_telegram_username) || null,
    telegramDisplayName: cleanText(row.operational_completion_telegram_display_name) || null,
    telegramCompletedAt: completedAt,
  };
}

export function readOperationalAttributionFromTaskRow(
  row: Record<string, unknown> | null | undefined
): CashoutOperationalAttribution | null {
  const claim = readOperationalClaimFromTaskRow(row);
  const completion = readOperationalCompletionFromTaskRow(row);
  if (!claim && !completion) return null;
  return {
    actionSource: claim?.actionSource || completion?.actionSource || 'telegram',
    telegramUserId: claim?.telegramUserId || completion?.telegramUserId || null,
    telegramUsername: claim?.telegramUsername || completion?.telegramUsername || null,
    telegramDisplayName: claim?.telegramDisplayName || completion?.telegramDisplayName || null,
    telegramClaimedAt: claim?.telegramClaimedAt || null,
    telegramCompletedAt: completion?.telegramCompletedAt || null,
    completionSource: completion?.actionSource || null,
  };
}

export async function insertCashoutOperationalEvent(
  client: PoolClient,
  input: {
    cashoutTaskId: string;
    coadminUid: string;
    eventType: string;
    actionSource?: string;
    telegramUserId?: string | null;
    telegramUsername?: string | null;
    telegramDisplayName?: string | null;
    actorAppbegUid?: string | null;
    idempotencyKey?: string | null;
    occurredAt?: string | null;
    metadata?: Record<string, unknown>;
  }
): Promise<{ inserted: boolean; id: number | null }> {
  const cashoutTaskId = cleanText(input.cashoutTaskId);
  const coadminUid = cleanText(input.coadminUid);
  const eventType = cleanText(input.eventType);
  if (!cashoutTaskId || !coadminUid || !eventType) {
    return { inserted: false, id: null };
  }

  const result = await client.query(
    `
      INSERT INTO public.cashout_operational_events (
        cashout_task_id,
        coadmin_uid,
        event_type,
        action_source,
        telegram_user_id,
        telegram_username,
        telegram_display_name,
        actor_appbeg_uid,
        idempotency_key,
        occurred_at,
        metadata
      )
      VALUES (
        $1::text, $2::text, $3::text, $4::text,
        NULLIF($5::text, ''), NULLIF($6::text, ''), NULLIF($7::text, ''),
        NULLIF($8::text, ''), NULLIF($9::text, ''),
        COALESCE($10::timestamptz, now()),
        COALESCE($11::jsonb, '{}'::jsonb)
      )
      ON CONFLICT (idempotency_key) WHERE (idempotency_key IS NOT NULL)
      DO NOTHING
      RETURNING id
    `,
    [
      cashoutTaskId,
      coadminUid,
      eventType,
      cleanText(input.actionSource) || 'telegram',
      cleanText(input.telegramUserId) || null,
      cleanText(input.telegramUsername) || null,
      cleanText(input.telegramDisplayName) || null,
      cleanText(input.actorAppbegUid) || null,
      cleanText(input.idempotencyKey) || null,
      input.occurredAt || null,
      JSON.stringify(input.metadata || {}),
    ]
  );

  if (!result.rows.length) {
    return { inserted: false, id: null };
  }
  return { inserted: true, id: Number(result.rows[0].id) || null };
}

export async function setCashoutOperationalClaimSnapshot(
  client: PoolClient,
  input: {
    cashoutTaskId: string;
    actionSource: string;
    telegramUserId: string;
    telegramUsername?: string | null;
    telegramDisplayName?: string | null;
    claimedAt?: string | null;
  }
) {
  const cashoutTaskId = cleanText(input.cashoutTaskId);
  if (!cashoutTaskId) return;
  await client.query(
    `
      UPDATE public.player_cashout_tasks_cache
      SET
        operational_action_source = $2::text,
        operational_telegram_user_id = $3::text,
        operational_telegram_username = NULLIF($4::text, ''),
        operational_telegram_display_name = NULLIF($5::text, ''),
        operational_telegram_claimed_at = COALESCE($6::timestamptz, now())
      WHERE firebase_id = $1::text
        AND deleted_at IS NULL
    `,
    [
      cashoutTaskId,
      cleanText(input.actionSource) || 'telegram',
      cleanText(input.telegramUserId),
      cleanText(input.telegramUsername) || null,
      cleanText(input.telegramDisplayName) || null,
      input.claimedAt || null,
    ]
  );
}

export async function setCashoutOperationalCompletionSnapshot(
  client: PoolClient,
  input: {
    cashoutTaskId: string;
    actionSource: string;
    telegramUserId: string;
    telegramUsername?: string | null;
    telegramDisplayName?: string | null;
    completedAt?: string | null;
  }
) {
  const cashoutTaskId = cleanText(input.cashoutTaskId);
  if (!cashoutTaskId) return;
  await client.query(
    `
      UPDATE public.player_cashout_tasks_cache
      SET
        operational_completion_source = $2::text,
        operational_completion_telegram_user_id = $3::text,
        operational_completion_telegram_username = NULLIF($4::text, ''),
        operational_completion_telegram_display_name = NULLIF($5::text, ''),
        operational_telegram_completed_at = COALESCE($6::timestamptz, now())
      WHERE firebase_id = $1::text
        AND deleted_at IS NULL
    `,
    [
      cashoutTaskId,
      cleanText(input.actionSource) || 'telegram',
      cleanText(input.telegramUserId),
      cleanText(input.telegramUsername) || null,
      cleanText(input.telegramDisplayName) || null,
      input.completedAt || null,
    ]
  );
}

export async function clearCashoutOperationalClaimSnapshot(
  client: PoolClient,
  cashoutTaskId: string
) {
  const id = cleanText(cashoutTaskId);
  if (!id) return;
  await client.query(
    `
      UPDATE public.player_cashout_tasks_cache
      SET
        operational_action_source = NULL,
        operational_telegram_user_id = NULL,
        operational_telegram_username = NULL,
        operational_telegram_display_name = NULL,
        operational_telegram_claimed_at = NULL,
        operational_completion_source = NULL,
        operational_completion_telegram_user_id = NULL,
        operational_completion_telegram_username = NULL,
        operational_completion_telegram_display_name = NULL,
        operational_telegram_completed_at = NULL
      WHERE firebase_id = $1::text
        AND deleted_at IS NULL
    `,
    [id]
  );
}

/**
 * Read-only operational event history for a cash-out (Phase 7 helper for later UI).
 * Does not build a dashboard — API/helper only.
 */
export async function listCashoutOperationalEventsByTaskId(
  cashoutTaskId: string,
  {
    coadminUid = null,
    limit = 50,
  }: {
    coadminUid?: string | null;
    limit?: number;
  } = {}
): Promise<
  Array<{
    id: number;
    cashoutTaskId: string;
    coadminUid: string;
    eventType: string;
    actionSource: string | null;
    telegramUserId: string | null;
    telegramUsername: string | null;
    telegramDisplayName: string | null;
    actorAppbegUid: string | null;
    occurredAt: string | null;
    idempotencyKey: string | null;
  }>
> {
  const db = getPlayerMirrorPool();
  if (!db) return [];
  const taskId = cleanText(cashoutTaskId);
  if (!taskId) return [];
  const ownerUid = cleanText(coadminUid);
  const safeLimit = Math.max(1, Math.min(200, Math.floor(Number(limit) || 50)));
  const result = ownerUid
    ? await db.query(
        `
          SELECT id, cashout_task_id, coadmin_uid, event_type, action_source,
                 telegram_user_id, telegram_username, telegram_display_name,
                 actor_appbeg_uid, occurred_at, idempotency_key
          FROM public.cashout_operational_events
          WHERE cashout_task_id = $1::text
            AND coadmin_uid = $2::text
          ORDER BY occurred_at ASC, id ASC
          LIMIT $3
        `,
        [taskId, ownerUid, safeLimit]
      )
    : await db.query(
        `
          SELECT id, cashout_task_id, coadmin_uid, event_type, action_source,
                 telegram_user_id, telegram_username, telegram_display_name,
                 actor_appbeg_uid, occurred_at, idempotency_key
          FROM public.cashout_operational_events
          WHERE cashout_task_id = $1::text
          ORDER BY occurred_at ASC, id ASC
          LIMIT $2
        `,
        [taskId, safeLimit]
      );

  return result.rows.map((row: Record<string, unknown>) => ({
    id: Number(row.id) || 0,
    cashoutTaskId: cleanText(row.cashout_task_id) || taskId,
    coadminUid: cleanText(row.coadmin_uid) || '',
    eventType: cleanText(row.event_type) || '',
    actionSource: cleanText(row.action_source) || null,
    telegramUserId: cleanText(row.telegram_user_id) || null,
    telegramUsername: cleanText(row.telegram_username) || null,
    telegramDisplayName: cleanText(row.telegram_display_name) || null,
    actorAppbegUid: cleanText(row.actor_appbeg_uid) || null,
    occurredAt: toIsoString(row.occurred_at),
    idempotencyKey: cleanText(row.idempotency_key) || null,
  }));
}
