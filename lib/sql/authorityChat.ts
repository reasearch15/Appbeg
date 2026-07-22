import 'server-only';

import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';

import {
  emitChatMessageOutboxEvent,
} from '@/lib/sql/liveOutbox';
import { updatePlayerBalancesInTxn } from '@/lib/sql/authorityGameRequestHelpers';
import {
  claimAuthorityOperation,
  insertAuthorityLedgerEvent,
  readAuthorityOperationPayloadWithClient,
} from '@/lib/sql/authorityLedger';
import { cleanText, getPlayerMirrorPool } from '@/lib/sql/playerMirrorCommon';

const PLAYER_CHAT_TEXT_FREE_LIMIT = 10;
const PLAYER_CHAT_TEXT_FEE_COINS = 0.2;
const PLAYER_CHAT_PHOTO_FEE_COINS = 1;

export type AuthorityChatSendInput = {
  senderUid: string;
  receiverUid: string;
  conversationId: string;
  type: 'text' | 'image';
  text?: string;
  imageUrl?: string;
  imagePublicId?: string;
  playerToPlayerTextBilling?: {
    idempotencyKey: string;
  };
  playerToPlayerPhotoBilling?: {
    idempotencyKey: string;
  };
};

export type AuthorityChatBillingInfo = {
  chargedAmount: number;
  freeMessagesUsedInWindow: number;
  freeMessagesRemaining: number;
  senderCoinBalance: number | null;
};

export type AuthorityChatDeleteInput = {
  actorUid: string;
  peerUid: string;
  conversationId: string;
  messageId: string;
  scope: 'for_me' | 'for_everyone';
};

async function upsertConversationInTxn(
  client: PoolClient,
  input: {
    conversationId: string;
    senderUid: string;
    receiverUid: string;
    lastMessage: string;
    unreadCounts: Record<string, number>;
    nowIso: string;
  }
) {
  const participantUids = [input.senderUid, input.receiverUid].sort();
  await client.query(
    `
      INSERT INTO public.conversations_cache (
        firebase_id, participant_uids, last_message, last_message_sender_uid,
        unread_counts, updated_at, raw_firestore_data, source, mirrored_at, deleted_at
      )
      VALUES ($1, $2::jsonb, $3, $4, $5::jsonb, $6::timestamptz, '{}'::jsonb, 'authority_chat', now(), NULL)
      ON CONFLICT (firebase_id) DO UPDATE SET
        participant_uids = EXCLUDED.participant_uids,
        last_message = EXCLUDED.last_message,
        last_message_sender_uid = EXCLUDED.last_message_sender_uid,
        unread_counts = EXCLUDED.unread_counts,
        updated_at = EXCLUDED.updated_at,
        source = EXCLUDED.source,
        mirrored_at = now(),
        deleted_at = NULL
    `,
    [
      input.conversationId,
      JSON.stringify(participantUids),
      input.lastMessage,
      input.senderUid,
      JSON.stringify(input.unreadCounts),
      input.nowIso,
    ]
  );
}

function parseJsonArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(cleanText).filter(Boolean);
}

async function upsertMessageInTxn(
  client: PoolClient,
  input: {
    messageId: string;
    conversationId: string;
    senderUid: string;
    receiverUid: string;
    type: 'text' | 'image';
    text: string | null;
    imageUrl: string | null;
    imagePublicId: string | null;
    nowIso: string;
  }
) {
  await client.query(
    `
      INSERT INTO public.chat_messages_cache (
        firebase_id, conversation_id, sender_uid, receiver_uid, type,
        text, image_url, image_public_id, created_at, raw_firestore_data,
        source, mirrored_at, deleted_at
      )
      VALUES (
        $1, $2, $3, $4, $5,
        NULLIF($6, ''), NULLIF($7, ''), NULLIF($8, ''),
        $9::timestamptz, '{}'::jsonb, 'authority_chat', now(), NULL
      )
      ON CONFLICT (firebase_id) DO UPDATE SET
        conversation_id = EXCLUDED.conversation_id,
        sender_uid = EXCLUDED.sender_uid,
        receiver_uid = EXCLUDED.receiver_uid,
        type = EXCLUDED.type,
        text = EXCLUDED.text,
        image_url = EXCLUDED.image_url,
        image_public_id = EXCLUDED.image_public_id,
        created_at = EXCLUDED.created_at,
        source = EXCLUDED.source,
        mirrored_at = now(),
        deleted_at = NULL
    `,
    [
      input.messageId,
      input.conversationId,
      input.senderUid,
      input.receiverUid,
      input.type,
      input.text,
      input.imageUrl,
      input.imagePublicId,
      input.nowIso,
    ]
  );
}

function numberFromDb(value: unknown) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return 0;
  }
  return Math.max(0, n);
}

function sameBillingRequest(
  payload: Record<string, unknown> | null,
  input: {
    senderUid: string;
    receiverUid: string;
    conversationId: string;
    type: 'text' | 'image';
    text: string;
    imagePublicId?: string;
  }
) {
  if (!payload) {
    return false;
  }
  return (
    cleanText(payload.senderUid) === input.senderUid &&
    cleanText(payload.receiverUid) === input.receiverUid &&
    cleanText(payload.conversationId) === input.conversationId &&
    cleanText(payload.type) === input.type &&
    cleanText(payload.text) === input.text &&
    cleanText(payload.imagePublicId) === cleanText(input.imagePublicId)
  );
}

async function countSenderPlayerTextMessagesInWindow(
  client: PoolClient,
  input: { senderUid: string }
) {
  const result = await client.query(
    `
      SELECT COUNT(*)::int AS message_count
      FROM public.chat_messages_cache message
      JOIN public.players_cache receiver
        ON receiver.uid = message.receiver_uid
       AND receiver.deleted_at IS NULL
       AND receiver.role = 'player'
      WHERE message.sender_uid = $1
        AND message.type = 'text'
        AND message.deleted_at IS NULL
        AND message.created_at >= now() - interval '24 hours'
    `,
    [input.senderUid]
  );
  return Math.max(0, Number(result.rows[0]?.message_count || 0));
}

async function insertPlayerChatFeeEventInTxn(
  client: PoolClient,
  input: {
    eventId: string;
    eventType: 'player_chat_text_fee' | 'player_chat_photo_fee';
    senderUid: string;
    senderUsername: string;
    receiverUid: string;
    coadminUid: string | null;
    messageId: string;
    conversationId: string;
    amount: number;
    beforeCoin: number;
    afterCoin: number;
    idempotencyKey: string;
    createdAt: string;
    extraFields?: Record<string, unknown>;
  }
) {
  const rawEvent = {
    senderUid: input.senderUid,
    receiverUid: input.receiverUid,
    amount: input.amount,
    amountCoins: input.amount,
    messageId: input.messageId,
    conversationId: input.conversationId,
    beforeCoin: input.beforeCoin,
    afterCoin: input.afterCoin,
    idempotencyKey: input.idempotencyKey,
    createdAt: input.createdAt,
    ...(input.extraFields || {}),
  };

  await client.query(
    `
      INSERT INTO public.financial_events_cache (
        firebase_id,
        player_uid,
        coadmin_uid,
        actor_uid,
        actor_role,
        related_user_uid,
        related_user_role,
        type,
        amount,
        amount_coins,
        currency,
        unit,
        before_coin,
        after_coin,
        meta,
        created_at,
        updated_at,
        source,
        mirrored_at,
        deleted_at,
        raw_firestore_data
      )
      VALUES (
        $1, $2, NULLIF($3, ''), $2, 'player',
        $4, 'player', $5,
        $6::numeric, $6::numeric, 'coin', 'coin',
        $7::numeric, $8::numeric, $9::jsonb,
        $10::timestamptz, $10::timestamptz,
        'authority_chat_billing', now(), NULL, $9::jsonb
      )
      ON CONFLICT (firebase_id) DO NOTHING
    `,
    [
      input.eventId,
      input.senderUid,
      input.coadminUid,
      input.receiverUid,
      input.eventType,
      input.amount,
      input.beforeCoin,
      input.afterCoin,
      JSON.stringify(rawEvent),
      input.createdAt,
    ]
  );

  await insertAuthorityLedgerEvent(client, {
    eventKey: `financialEvents:${input.eventId}:${input.senderUid}:coin:${input.eventType}`,
    userUid: input.senderUid,
    username: input.senderUsername,
    role: 'player',
    coadminUid: input.coadminUid,
    balanceType: 'coin',
    direction: 'debit',
    delta: -input.amount,
    absoluteAfter: input.afterCoin,
    eventType: input.eventType,
    sourceCollection: 'financial_events_cache',
    sourceId: input.eventId,
    actorUid: input.senderUid,
    actorRole: 'player',
    confidence: 'high',
    sourceCreatedAt: input.createdAt,
    rawSourceData: rawEvent,
    sourceFields: rawEvent,
  });
}

export async function sendChatMessageInSql(input: AuthorityChatSendInput) {
  const db = getPlayerMirrorPool();
  const senderUid = cleanText(input.senderUid);
  const receiverUid = cleanText(input.receiverUid);
  const conversationId = cleanText(input.conversationId);
  const type = input.type === 'image' ? 'image' : 'text';
  const text = type === 'text' ? cleanText(input.text) : '';
  const imageUrl = type === 'image' ? cleanText(input.imageUrl) : '';
  const imagePublicId = type === 'image' ? cleanText(input.imagePublicId) : '';
  const textBillingIdempotencyKey = cleanText(input.playerToPlayerTextBilling?.idempotencyKey).slice(
    0,
    160
  );
  const photoBillingIdempotencyKey = cleanText(input.playerToPlayerPhotoBilling?.idempotencyKey).slice(
    0,
    160
  );
  const shouldBillPlayerText = type === 'text' && Boolean(textBillingIdempotencyKey);
  const shouldBillPlayerPhoto = type === 'image' && Boolean(photoBillingIdempotencyKey);
  console.info('[MESSAGE_CREATE_START]', {
    senderUid,
    receiverUid,
    conversationId,
    type,
  });
  console.info('[CHAT_SEND_START]', {
    senderUid,
    receiverUid,
    conversationId,
    type,
  });
  if (!db || !senderUid || !receiverUid || !conversationId) {
    return { ok: false as const, reason: 'missing_input' };
  }

  if (type === 'text' && !text) {
    return { ok: false as const, reason: 'empty_text' };
  }
  if (type === 'image' && (!imageUrl || !imagePublicId)) {
    return { ok: false as const, reason: 'missing_image' };
  }
  if (input.playerToPlayerTextBilling && !textBillingIdempotencyKey) {
    return { ok: false as const, reason: 'missing_idempotency_key' };
  }
  if (input.playerToPlayerPhotoBilling && !photoBillingIdempotencyKey) {
    return { ok: false as const, reason: 'missing_idempotency_key' };
  }

  const messageId = randomUUID();
  const nowIso = new Date().toISOString();
  const lastMessage = type === 'image' ? '📷 Photo' : cleanText(input.text);
  const unreadCounts = {
    [receiverUid]: 1,
    [senderUid]: 0,
  };

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const operationKey = shouldBillPlayerText
      ? `player_chat_text:${senderUid}:${textBillingIdempotencyKey}`
      : shouldBillPlayerPhoto
        ? `player_chat_photo:${senderUid}:${photoBillingIdempotencyKey}`
        : null;
    if (operationKey) {
      const requestPayload = {
        senderUid,
        receiverUid,
        conversationId,
        type,
        text,
        imagePublicId,
        idempotencyKey: shouldBillPlayerPhoto
          ? photoBillingIdempotencyKey
          : textBillingIdempotencyKey,
      } satisfies {
        senderUid: string;
        receiverUid: string;
        conversationId: string;
        type: 'text' | 'image';
        text: string;
        imagePublicId: string;
        idempotencyKey: string;
      };
      const claim = await claimAuthorityOperation(client, {
        operationKey,
        operationType: shouldBillPlayerPhoto
          ? 'player_chat_photo_message'
          : 'player_chat_text_message',
        userUid: senderUid,
        sourceId: messageId,
        actorUid: senderUid,
        actorRole: 'player',
        payload: requestPayload,
      });
      if (claim.duplicate) {
        const payload = await readAuthorityOperationPayloadWithClient(client, operationKey, {
          flowName: shouldBillPlayerPhoto
            ? 'player_chat_photo_message'
            : 'player_chat_text_message',
        });
        if (!sameBillingRequest(payload, requestPayload) || !payload?.messageId) {
          await client.query('ROLLBACK');
          return { ok: false as const, reason: 'idempotency_conflict' };
        }
        await client.query('ROLLBACK');
        return {
          ok: true as const,
          duplicate: true,
          messageId: cleanText(payload.messageId),
          conversationId: cleanText(payload.conversationId) || conversationId,
          createdAt: cleanText(payload.createdAt) || nowIso,
          billing: {
            chargedAmount: Number(payload.chargedAmount || 0),
            freeMessagesUsedInWindow: Number(payload.freeMessagesUsedInWindow || 0),
            freeMessagesRemaining: Number(payload.freeMessagesRemaining || 0),
            senderCoinBalance:
              payload.senderCoinBalance == null ? null : Number(payload.senderCoinBalance),
          } satisfies AuthorityChatBillingInfo,
        };
      }
    }

    const participantRows = await client.query(
      `
        SELECT uid, username, role, coadmin_uid, created_by
        FROM public.players_cache
        WHERE uid = ANY($1::text[]) AND deleted_at IS NULL
      `,
      [[senderUid, receiverUid]]
    );
    const byUid = new Map<string, Record<string, unknown>>();
    for (const row of participantRows.rows as Record<string, unknown>[]) {
      byUid.set(cleanText(row.uid), row);
    }
    const senderRow = byUid.get(senderUid);
    const receiverRow = byUid.get(receiverUid);
    console.info('[MESSAGE_CREATE_PLAYER_LOOKUP]', {
      senderUid,
      receiverUid,
      senderRole: cleanText(senderRow?.role) || null,
      receiverRole: cleanText(receiverRow?.role) || null,
      senderCoadminUid: cleanText(senderRow?.coadmin_uid) || cleanText(senderRow?.created_by) || null,
      receiverCoadminUid: cleanText(receiverRow?.coadmin_uid) || cleanText(receiverRow?.created_by) || null,
    });

    const senderRole = cleanText(senderRow?.role).toLowerCase();
    const receiverRole = cleanText(receiverRow?.role).toLowerCase();
    const playerUid =
      senderRole === 'player' ? senderUid : receiverRole === 'player' ? receiverUid : senderUid;
    const coadminUid =
      cleanText(senderRow?.coadmin_uid) ||
      cleanText(senderRow?.created_by) ||
      cleanText(receiverRow?.coadmin_uid) ||
      cleanText(receiverRow?.created_by) ||
      null;
    console.info('[MESSAGE_CREATE_COADMIN_RESOLVED]', {
      playerUid,
      coadminUid,
      conversationId,
    });

    let billing: AuthorityChatBillingInfo = {
      chargedAmount: 0,
      freeMessagesUsedInWindow: 0,
      freeMessagesRemaining: 0,
      senderCoinBalance: null,
    };
    if (shouldBillPlayerText || shouldBillPlayerPhoto) {
      if (senderRole !== 'player' || receiverRole !== 'player') {
        await client.query('ROLLBACK');
        return { ok: false as const, reason: 'invalid_player_chat_billing_context' };
      }
      const senderLock = await client.query(
        `
          SELECT uid, username, role, status, coin, coadmin_uid, created_by, raw_firestore_data
          FROM public.players_cache
          WHERE uid = $1
            AND deleted_at IS NULL
          FOR UPDATE
        `,
        [senderUid]
      );
      const sender = senderLock.rows[0] as Record<string, unknown> | undefined;
      if (!sender || cleanText(sender.role).toLowerCase() !== 'player') {
        await client.query('ROLLBACK');
        return { ok: false as const, reason: 'invalid_player_chat_billing_context' };
      }

      const beforeCoin = numberFromDb(sender.coin);
      const sentTextCount = shouldBillPlayerText
        ? await countSenderPlayerTextMessagesInWindow(client, { senderUid })
        : 0;
      const shouldChargeText = shouldBillPlayerText && sentTextCount >= PLAYER_CHAT_TEXT_FREE_LIMIT;
      const chargedAmount = shouldBillPlayerPhoto
        ? PLAYER_CHAT_PHOTO_FEE_COINS
        : shouldChargeText
          ? PLAYER_CHAT_TEXT_FEE_COINS
          : 0;
      if (chargedAmount > 0 && beforeCoin < chargedAmount) {
        await client.query('ROLLBACK');
        return {
          ok: false as const,
          reason: shouldBillPlayerPhoto
            ? 'insufficient_coin_for_chat_photo'
            : 'insufficient_coin_for_chat_message',
        };
      }

      const afterCoin = Number((beforeCoin - chargedAmount).toFixed(4));
      const freeMessagesUsedInWindow = shouldBillPlayerText
        ? Math.min(
            PLAYER_CHAT_TEXT_FREE_LIMIT,
            sentTextCount + (shouldChargeText ? 0 : 1)
          )
        : 0;
      const freeMessagesRemaining = shouldBillPlayerText
        ? Math.max(0, PLAYER_CHAT_TEXT_FREE_LIMIT - (sentTextCount + 1))
        : 0;
      if (chargedAmount > 0) {
        await updatePlayerBalancesInTxn(client, senderUid, { coin: afterCoin });
      }
      billing = {
        chargedAmount,
        freeMessagesUsedInWindow,
        freeMessagesRemaining,
        senderCoinBalance: chargedAmount > 0 ? afterCoin : beforeCoin,
      };
    }

    await upsertConversationInTxn(client, {
      conversationId,
      senderUid,
      receiverUid,
      lastMessage,
      unreadCounts,
      nowIso,
    });
    await upsertMessageInTxn(client, {
      messageId,
      conversationId,
      senderUid,
      receiverUid,
      type,
      text: type === 'text' ? text : null,
      imageUrl: type === 'image' ? imageUrl : null,
      imagePublicId: type === 'image' ? imagePublicId : null,
      nowIso,
    });
    console.info('[MESSAGE_CREATE_ROW_WRITTEN]', {
      messageId,
      conversationId,
      senderUid,
      receiverUid,
      playerUid,
      coadminUid,
    });
    console.info('[CHAT_SEND_ROW_WRITTEN]', {
      messageId,
      conversationId,
      senderUid,
      receiverUid,
    });

    await emitChatMessageOutboxEvent(client, {
      entityId: messageId,
      conversationId,
      senderUid,
      receiverUid,
      type,
      text: type === 'text' ? text : null,
      imageUrl: type === 'image' ? imageUrl : null,
      updatedAt: nowIso,
      source: 'authority_chat',
      participantUids: [senderUid, receiverUid],
      playerUid,
      coadminUid,
    });
    console.info('[MESSAGE_CREATE_OUTBOX_EVENT]', {
      messageId,
      playerUid,
      coadminUid,
      eventType: 'player_message_created',
    });
    console.info('[CHAT_SEND_OUTBOX_EVENT]', {
      messageId,
      playerUid,
      coadminUid,
    });
    console.info('[CHAT_UNREAD_UPDATED]', {
      conversationId,
      receiverUid,
      unreadCount: unreadCounts[receiverUid],
    });

    if ((shouldBillPlayerText || shouldBillPlayerPhoto) && billing.chargedAmount > 0) {
      const eventType = shouldBillPlayerPhoto
        ? 'player_chat_photo_fee'
        : 'player_chat_text_fee';
      const eventId = shouldBillPlayerPhoto
        ? `playerChatPhotoFee_${messageId}`
        : `playerChatTextFee_${messageId}`;
      const beforeCoin = Number(
        ((billing.senderCoinBalance || 0) + billing.chargedAmount).toFixed(4)
      );
      const afterCoin = Number(billing.senderCoinBalance || 0);
      await insertPlayerChatFeeEventInTxn(client, {
        eventId,
        eventType,
        senderUid,
        senderUsername: cleanText(senderRow?.username),
        receiverUid,
        coadminUid,
        messageId,
        conversationId,
        amount: billing.chargedAmount,
        beforeCoin,
        afterCoin,
        idempotencyKey: shouldBillPlayerPhoto
          ? photoBillingIdempotencyKey
          : textBillingIdempotencyKey,
        createdAt: nowIso,
        extraFields: shouldBillPlayerPhoto
          ? { imagePublicId }
          : {
              freeMessagesUsedInWindow: billing.freeMessagesUsedInWindow,
              freeMessagesRemaining: billing.freeMessagesRemaining,
            },
      });
    }

    if (operationKey) {
      await client.query(
        `
          UPDATE public.authority_operations
          SET source_id = $2,
              payload = $3::jsonb
          WHERE operation_key = $1
        `,
        [
          operationKey,
          messageId,
          JSON.stringify({
            senderUid,
            receiverUid,
            conversationId,
            type,
            text,
            imagePublicId,
            idempotencyKey: shouldBillPlayerPhoto
              ? photoBillingIdempotencyKey
              : textBillingIdempotencyKey,
            messageId,
            createdAt: nowIso,
            chargedAmount: billing.chargedAmount,
            freeMessagesUsedInWindow: billing.freeMessagesUsedInWindow,
            freeMessagesRemaining: billing.freeMessagesRemaining,
            senderCoinBalance: billing.senderCoinBalance,
          }),
        ]
      );
    }

    await client.query('COMMIT');
    console.info('[MESSAGE_CREATE_COMMIT]', {
      messageId,
      conversationId,
      senderUid,
      receiverUid,
    });
    console.info('[CHAT_SEND_RESPONSE]', {
      messageId,
      conversationId,
      createdAt: nowIso,
    });
    return {
      ok: true as const,
      messageId,
      conversationId,
      createdAt: nowIso,
      duplicate: false,
      billing: shouldBillPlayerText || shouldBillPlayerPhoto ? billing : undefined,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[MESSAGE_CREATE_ERROR]', {
      conversationId,
      senderUid,
      receiverUid,
      error,
    });
    return { ok: false as const, reason: 'sql_write_failed' };
  } finally {
    client.release();
  }
}

export async function deleteChatMessageInSql(input: AuthorityChatDeleteInput) {
  const db = getPlayerMirrorPool();
  const actorUid = cleanText(input.actorUid);
  const peerUid = cleanText(input.peerUid);
  const conversationId = cleanText(input.conversationId);
  const messageId = cleanText(input.messageId);
  const scope = input.scope === 'for_everyone' ? 'for_everyone' : 'for_me';
  if (!db || !actorUid || !peerUid || !conversationId || !messageId) {
    return { ok: false as const, status: 400, reason: 'missing_input' };
  }

  const nowIso = new Date().toISOString();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const beforeResult = await client.query(
      `
        SELECT firebase_id, conversation_id, sender_uid, receiver_uid, type, text,
               image_url, image_public_id, raw_firestore_data
        FROM public.chat_messages_cache
        WHERE firebase_id = $1
          AND conversation_id = $2
          AND deleted_at IS NULL
        FOR UPDATE
      `,
      [messageId, conversationId]
    );
    const before = beforeResult.rows[0] as Record<string, unknown> | undefined;
    if (!before) {
      await client.query('ROLLBACK');
      return { ok: false as const, status: 404, reason: 'message_not_found' };
    }

    const senderUid = cleanText(before.sender_uid);
    const receiverUid = cleanText(before.receiver_uid);
    const participants = [senderUid, receiverUid].filter(Boolean);
    const isParticipant = participants.includes(actorUid) && participants.includes(peerUid);
    const beforeRaw =
      before.raw_firestore_data && typeof before.raw_firestore_data === 'object'
        ? (before.raw_firestore_data as Record<string, unknown>)
        : {};
    const beforeDeletedFor = parseJsonArray(beforeRaw.deletedFor);
    const beforeDeletedForEveryone = beforeRaw.deletedForEveryone === true;

    console.info('[CHAT_DELETE_REQUEST]', {
      messageId,
      conversationId,
      actorUid,
      peerUid,
      senderUid,
      currentDeleteFields: {
        deletedFor: beforeDeletedFor,
        deletedForEveryone: beforeDeletedForEveryone,
      },
      scope,
    });

    if (!isParticipant) {
      console.info('[CHAT_DELETE_PERMISSION_DENIED]', {
        messageId,
        conversationId,
        actorUid,
        peerUid,
        senderUid,
        reason: 'actor_or_peer_not_participant',
      });
      await client.query('ROLLBACK');
      return { ok: false as const, status: 403, reason: 'not_participant' };
    }

    if (scope === 'for_everyone' && senderUid !== actorUid) {
      console.info('[CHAT_DELETE_PERMISSION_DENIED]', {
        messageId,
        conversationId,
        actorUid,
        peerUid,
        senderUid,
        reason: 'not_sender',
      });
      await client.query('ROLLBACK');
      return { ok: false as const, status: 403, reason: 'only_sender_can_delete_for_everyone' };
    }

    const alreadyDeletedForMe =
      scope === 'for_me' &&
      (beforeDeletedForEveryone || beforeDeletedFor.includes(actorUid));
    const alreadyDeletedForEveryone = scope === 'for_everyone' && beforeDeletedForEveryone;
    if (alreadyDeletedForMe || alreadyDeletedForEveryone) {
      console.info('[CHAT_DELETE_NOOP_SKIP_OUTBOX]', {
        messageId,
        conversationId,
        actorUid,
        scope,
        reason: alreadyDeletedForEveryone ? 'already_deleted_for_everyone' : 'already_deleted_for_me',
      });
      await client.query('ROLLBACK');
      return {
        ok: true as const,
        duplicate: true as const,
        message: {
          id: messageId,
          senderUid,
          receiverUid,
          type: cleanText(before.type) === 'image' ? 'image' : 'text',
          text: beforeDeletedForEveryone ? null : cleanText(before.text) || null,
          imageUrl: beforeDeletedForEveryone ? null : cleanText(before.image_url) || null,
          imagePublicId: beforeDeletedForEveryone ? null : cleanText(before.image_public_id) || null,
          deletedFor: beforeDeletedFor,
          deletedForEveryone: beforeDeletedForEveryone,
        },
      };
    }

    let updatedRow: Record<string, unknown> | undefined;
    if (scope === 'for_me') {
      const updatedDeletedFor = Array.from(new Set([...beforeDeletedFor, actorUid]));
      console.info('[CHAT_DELETE_FOR_ME]', {
        messageId,
        senderUid,
        currentDeleteFields: {
          deletedFor: beforeDeletedFor,
          deletedForEveryone: beforeDeletedForEveryone,
        },
        updatedDeleteFields: {
          deletedFor: updatedDeletedFor,
          deletedForEveryone: beforeDeletedForEveryone,
        },
      });
      const result = await client.query(
        `
          UPDATE public.chat_messages_cache
          SET raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb) || jsonb_build_object('deletedFor', $3::jsonb),
              source = 'authority_chat_delete',
              mirrored_at = now()
          WHERE firebase_id = $1
            AND conversation_id = $2
            AND deleted_at IS NULL
          RETURNING firebase_id, conversation_id, sender_uid, receiver_uid, type, text,
                    image_url, image_public_id, raw_firestore_data
        `,
        [messageId, conversationId, JSON.stringify(updatedDeletedFor)]
      );
      updatedRow = result.rows[0] as Record<string, unknown> | undefined;
    } else {
      console.info('[CHAT_DELETE_FOR_ALL]', {
        messageId,
        senderUid,
        currentDeleteFields: {
          deletedFor: beforeDeletedFor,
          deletedForEveryone: beforeDeletedForEveryone,
        },
        updatedDeleteFields: {
          deletedFor: beforeDeletedFor,
          deletedForEveryone: true,
        },
      });
      const result = await client.query(
        `
          UPDATE public.chat_messages_cache
          SET text = NULL,
              image_url = NULL,
              image_public_id = NULL,
              raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb)
                || jsonb_build_object(
                  'text', '',
                  'imageUrl', '',
                  'imagePublicId', '',
                  'deletedForEveryone', true,
                  'deletedForEveryoneAt', $3::text,
                  'searchTokens', '[]'::jsonb
                ),
              source = 'authority_chat_delete',
              mirrored_at = now()
          WHERE firebase_id = $1
            AND conversation_id = $2
            AND deleted_at IS NULL
          RETURNING firebase_id, conversation_id, sender_uid, receiver_uid, type, text,
                    image_url, image_public_id, raw_firestore_data
        `,
        [messageId, conversationId, nowIso]
      );
      updatedRow = result.rows[0] as Record<string, unknown> | undefined;
      const latestResult = await client.query(
        `
          SELECT firebase_id
          FROM public.chat_messages_cache
          WHERE conversation_id = $1
            AND deleted_at IS NULL
          ORDER BY created_at DESC NULLS LAST
          LIMIT 1
        `,
        [conversationId]
      );
      if (cleanText(latestResult.rows[0]?.firebase_id) === messageId) {
        await client.query(
          `
            UPDATE public.conversations_cache
            SET last_message = 'Message deleted',
                source = 'authority_chat_delete',
                mirrored_at = now()
            WHERE firebase_id = $1
              AND deleted_at IS NULL
          `,
          [conversationId]
        );
      }
    }

    if (!updatedRow) {
      await client.query('ROLLBACK');
      return { ok: false as const, status: 500, reason: 'message_update_failed' };
    }

    const updatedRaw =
      updatedRow.raw_firestore_data && typeof updatedRow.raw_firestore_data === 'object'
        ? (updatedRow.raw_firestore_data as Record<string, unknown>)
        : {};
    const updatedDeletedFor = parseJsonArray(updatedRaw.deletedFor);
    const updatedDeletedForEveryone = updatedRaw.deletedForEveryone === true;
    console.info('[CHAT_DELETE_DB_UPDATED]', {
      messageId,
      senderUid,
      currentDeleteFields: {
        deletedFor: beforeDeletedFor,
        deletedForEveryone: beforeDeletedForEveryone,
      },
      updatedDeleteFields: {
        deletedFor: updatedDeletedFor,
        deletedForEveryone: updatedDeletedForEveryone,
      },
      writeResult: 'updated',
    });

    await emitChatMessageOutboxEvent(client, {
      entityId: messageId,
      conversationId,
      senderUid,
      receiverUid,
      type: cleanText(updatedRow.type) || cleanText(before.type) || 'text',
      text: updatedDeletedForEveryone ? null : cleanText(updatedRow.text) || null,
      imageUrl: updatedDeletedForEveryone ? null : cleanText(updatedRow.image_url) || null,
      updatedAt: nowIso,
      source: 'authority_chat_delete',
      participantUids: participants,
    });

    await client.query('COMMIT');
    return {
      ok: true as const,
      message: {
        id: messageId,
        senderUid,
        receiverUid,
        type: cleanText(updatedRow.type) === 'image' ? 'image' : 'text',
        text: updatedDeletedForEveryone ? null : cleanText(updatedRow.text) || null,
        imageUrl: updatedDeletedForEveryone ? null : cleanText(updatedRow.image_url) || null,
        imagePublicId: updatedDeletedForEveryone ? null : cleanText(updatedRow.image_public_id) || null,
        deletedFor: updatedDeletedFor,
        deletedForEveryone: updatedDeletedForEveryone,
      },
    };
  } catch (error) {
    await client.query('ROLLBACK');
    console.warn('[AUTHORITY_CHAT] delete failed', { conversationId, messageId, scope, error });
    return { ok: false as const, status: 500, reason: 'sql_delete_failed' };
  } finally {
    client.release();
  }
}
