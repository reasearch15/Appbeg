import { NextResponse } from 'next/server';

import { apiError, requireApiUser, requirePlayerApiUser } from '@/lib/firebase/apiAuth';
import {
  isCacheSqlAuthoritative,
  logCacheFirestoreFallbackBlocked,
  logCacheSqlRead,
} from '@/lib/server/cacheSqlRead';
import { deleteChatMessageInSql, sendChatMessageInSql } from '@/lib/sql/authorityChat';
import {
  readChatMessagesCacheByConversation,
  readOlderChatMessagesCacheByConversation,
} from '@/lib/sql/chatMessagesCache';
import { cleanText, getPlayerMirrorPool } from '@/lib/sql/playerMirrorCommon';
import { isDatabaseUrlConfigured } from '@/lib/server/sqlRuntime';
import { isChatVerboseLogs } from '@/lib/server/verboseLogs';

export const runtime = 'nodejs';

const ROUTE = '/api/chat/messages';

function getConversationId(uid1: string, uid2: string) {
  return [uid1, uid2].sort().join('_');
}

function getDirectConversationId(uid1: string, uid2: string) {
  return [uid1, uid2].sort().join('__');
}

function validateDirectConversationRead(input: {
  authUid: string;
  authRole: string;
  peerUid: string;
  conversationId: string;
}) {
  const authUid = cleanText(input.authUid);
  const peerUid = cleanText(input.peerUid);
  const conversationId = cleanText(input.conversationId);
  if (input.authRole !== 'player') {
    return { ok: false as const, reason: 'explicit_conversation_requires_player' };
  }
  if (!authUid || !peerUid || authUid === peerUid) {
    return { ok: false as const, reason: 'invalid_direct_participants' };
  }
  const parts = conversationId.split('__');
  if (parts.length !== 2 || parts.some((part) => !cleanText(part))) {
    return { ok: false as const, reason: 'invalid_direct_conversation_format' };
  }
  const authMatches = parts.filter((part) => part === authUid).length;
  const peerMatches = parts.filter((part) => part === peerUid).length;
  if (authMatches !== 1 || peerMatches !== 1) {
    return { ok: false as const, reason: 'direct_conversation_participant_mismatch' };
  }
  if (conversationId !== getDirectConversationId(authUid, peerUid)) {
    return { ok: false as const, reason: 'direct_conversation_id_not_canonical' };
  }
  return { ok: true as const, conversationId };
}

function hasPlayerSessionHeaders(request: Request) {
  return Boolean(
    cleanText(request.headers.get('X-App-Session-Id')) ||
      cleanText(request.headers.get('X-Player-Session-Id'))
  );
}

async function requireChatPostUser(request: Request) {
  if (hasPlayerSessionHeaders(request)) {
    const playerAuth = await requirePlayerApiUser(request);
    if (!('response' in playerAuth)) {
      return playerAuth;
    }
    if (cleanText(request.headers.get('X-Player-Session-Id'))) {
      return playerAuth;
    }
  }
  return await requireApiUser(request, ['admin', 'coadmin', 'staff', 'carer', 'player']);
}

async function readChatParticipant(uid: string) {
  const db = getPlayerMirrorPool();
  const cleanUid = cleanText(uid);
  if (!db || !cleanUid) {
    return null;
  }
  const result = await db.query(
    `
      SELECT uid, role, coadmin_uid, created_by
      FROM public.players_cache
      WHERE uid = $1 AND deleted_at IS NULL
      LIMIT 1
    `,
    [cleanUid]
  );
  const row = result.rows[0] as
    | { uid?: unknown; role?: unknown; coadmin_uid?: unknown; created_by?: unknown }
    | undefined;
  if (!row) {
    return null;
  }
  return {
    uid: cleanText(row.uid),
    role: cleanText(row.role).toLowerCase(),
    coadminUid: cleanText(row.coadmin_uid) || cleanText(row.created_by) || null,
  };
}

async function hasActivePublicChatProfile(uid: string) {
  const db = getPlayerMirrorPool();
  const cleanUid = cleanText(uid);
  if (!db || !cleanUid) {
    return false;
  }
  const result = await db.query(
    `
      SELECT 1
      FROM public.player_chat_profiles
      WHERE player_uid = $1
        AND is_active = TRUE
        AND review_status = 'approved'
        AND (suspended_until IS NULL OR suspended_until < now())
        AND btrim(avatar_emoji) <> ''
        AND gender IN ('male', 'female')
        AND btrim(bio) <> ''
      LIMIT 1
    `,
    [cleanUid]
  );
  return result.rows.length > 0;
}

async function validatePlayerMessageScope(senderUid: string, receiverUid: string) {
  const [sender, receiver] = await Promise.all([
    readChatParticipant(senderUid),
    readChatParticipant(receiverUid),
  ]);
  if (!sender || sender.role !== 'player' || !sender.coadminUid) {
    return { ok: false as const, reason: 'sender_scope_not_found' };
  }
  if (!receiver || !receiver.role) {
    return { ok: false as const, reason: 'invalid_chat_receiver' };
  }
  if (receiver.uid === sender.coadminUid) {
    return { ok: true as const, sender, receiver };
  }
  if (receiver.coadminUid && receiver.coadminUid === sender.coadminUid) {
    return { ok: true as const, sender, receiver };
  }
  return { ok: false as const, reason: 'out_of_scope_receiver' };
}

async function validatePlayerToPlayerPublicProfiles(input: {
  senderUid: string;
  receiverUid: string;
}) {
  const scope = await validatePlayerMessageScope(input.senderUid, input.receiverUid);
  if (!scope.ok) {
    return scope;
  }

  if (scope.sender.role !== 'player') {
    return { ok: false as const, reason: 'sender_scope_not_found' };
  }
  if (scope.receiver.role !== 'player') {
    return { ok: true as const, sender: scope.sender, receiver: scope.receiver };
  }

  const [senderActive, receiverActive] = await Promise.all([
    hasActivePublicChatProfile(input.senderUid),
    hasActivePublicChatProfile(input.receiverUid),
  ]);
  if (!senderActive) {
    return { ok: false as const, reason: 'sender_chat_profile_inactive' };
  }
  if (!receiverActive) {
    return { ok: false as const, reason: 'receiver_chat_profile_inactive' };
  }
  return { ok: true as const, sender: scope.sender, receiver: scope.receiver };
}

function statusForPlayerSendValidationReason(reason: string) {
  if (reason === 'invalid_chat_receiver') {
    return 404;
  }
  if (
    reason === 'out_of_scope_receiver' ||
    reason === 'sender_scope_not_found'
  ) {
    return 403;
  }
  if (
    reason === 'sender_chat_profile_inactive' ||
    reason === 'receiver_chat_profile_inactive'
  ) {
    return 409;
  }
  return 403;
}

function safeCloudinaryFolderSegment(value: string) {
  return cleanText(value).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
}

function isValidCloudinaryImageUrl(value: string) {
  const imageUrl = cleanText(value);
  if (!imageUrl) {
    return false;
  }
  try {
    const parsed = new URL(imageUrl);
    return (
      parsed.protocol === 'https:' &&
      (parsed.hostname === 'res.cloudinary.com' || parsed.hostname.endsWith('.cloudinary.com')) &&
      parsed.pathname.includes('/image/upload/')
    );
  } catch {
    return false;
  }
}

function isValidPlayerChatCloudinaryPublicId(value: string, input: {
  senderUid: string;
  coadminUid: string;
}) {
  const imagePublicId = cleanText(value);
  if (!imagePublicId || imagePublicId.length > 300) {
    return false;
  }
  if (imagePublicId.includes('..') || imagePublicId.includes('\\')) {
    return false;
  }
  const expectedPrefix = `player-chat/${safeCloudinaryFolderSegment(input.coadminUid)}/${safeCloudinaryFolderSegment(input.senderUid)}/`;
  return imagePublicId.startsWith(expectedPrefix);
}

export async function GET(request: Request) {
  const startedAt = Date.now();
  const url = new URL(request.url);
  const auth = await requireApiUser(request, [
    'admin',
    'coadmin',
    'staff',
    'carer',
    'player',
  ]);
  if ('response' in auth) {
    return auth.response;
  }

  const peerUid = cleanText(url.searchParams.get('peerUid'));
  if (!peerUid) {
    return apiError('peerUid query parameter is required.', 400);
  }

  const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') || 25)));
  const requestedConversationId = cleanText(url.searchParams.get('conversationId'));
  const olderThanMessageId = cleanText(url.searchParams.get('olderThanMessageId'));
  let conversationId = getConversationId(auth.user.uid, peerUid);
  console.info('[CHAT_SESSION_CONTEXT]', {
    currentUid: auth.user.uid,
    currentRole: auth.user.role,
    expectedReceiverUid: peerUid,
    selectedPlayerUid: peerUid,
    conversationId,
    authPath: auth.authPath,
  });
  if (requestedConversationId) {
    const direct = validateDirectConversationRead({
      authUid: auth.user.uid,
      authRole: auth.user.role,
      peerUid,
      conversationId: requestedConversationId,
    });
    if (!direct.ok) {
      console.info('[CHAT_MESSAGES_READ_DENIED]', {
        route: ROUTE,
        senderUid: auth.user.uid,
        peerUid,
        conversationId: requestedConversationId,
        reason: direct.reason,
        auth_path: auth.authPath,
      });
      return apiError('Conversation does not match authenticated player and peer.', 403);
    }
    const scope = await validatePlayerMessageScope(auth.user.uid, peerUid);
    if (!scope.ok) {
      console.info('[CHAT_MESSAGES_READ_DENIED]', {
        route: ROUTE,
        senderUid: auth.user.uid,
        peerUid,
        conversationId: requestedConversationId,
        reason: scope.reason,
        auth_path: auth.authPath,
      });
      return apiError('Forbidden.', 403);
    }
    conversationId = direct.conversationId;
  }
  const messages = olderThanMessageId
    ? await readOlderChatMessagesCacheByConversation(conversationId, olderThanMessageId, limit)
    : await readChatMessagesCacheByConversation(conversationId, limit);

  if (isCacheSqlAuthoritative()) {
    logCacheSqlRead(ROUTE, {
      conversationId,
      olderThanMessageId: olderThanMessageId || null,
      count: messages?.length || 0,
      durationMs: Date.now() - startedAt,
    });
    if (messages === null) {
      logCacheFirestoreFallbackBlocked(ROUTE, 'chat_messages', { conversationId });
    }
  }

  if (isChatVerboseLogs()) {
    console.info('[CHAT_MESSAGES_API]', {
      conversationId,
      olderThanMessageId: olderThanMessageId || null,
      currentUid: auth.user.uid,
      totalMessages: messages?.length || 0,
      messageIds: (messages || []).slice(0, 5).map((message) => message.id),
      messages: (messages || []).slice(0, 5).map((message) => ({
        id: message.id,
        senderUid: message.senderUid,
        hasText: Boolean(message.text),
        textLength: String(message.text || '').length,
        deletedForAll: message.deletedForEveryone,
        deletedForUsers: message.deletedFor,
        createdAt: message.createdAt,
      })),
    });
  }

  const responseMessages = messages || [];

  return NextResponse.json({
    messages: responseMessages.map((message) => ({
      id: message.id,
      senderUid: message.senderUid,
      receiverUid: message.receiverUid,
      type: message.type,
      text: message.text,
      imageUrl: message.imageUrl,
      imagePublicId: message.imagePublicId,
      deletedForEveryone: message.deletedForEveryone,
      deletedFor: message.deletedFor,
      createdAt: message.createdAt,
    })),
    hasMore: responseMessages.length === limit,
    nextCursor: responseMessages[0]?.id || null,
    conversationId,
    source: 'postgres',
    firestore_fallback: false,
  });
}

export async function PATCH(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    peerUid?: string;
    conversationId?: string;
    messageId?: string;
    scope?: string;
  };
  const peerUid = cleanText(body.peerUid);
  const messageId = cleanText(body.messageId);
  const scope = body.scope === 'for_everyone' ? 'for_everyone' : 'for_me';

  console.info('[CHAT_DELETE_REQUEST]', {
    route: ROUTE,
    messageId,
    peerUid,
    scope,
    hasAppSessionId: Boolean(cleanText(request.headers.get('X-App-Session-Id'))),
    hasPlayerSessionId: Boolean(cleanText(request.headers.get('X-Player-Session-Id'))),
  });

  const auth = await requireChatPostUser(request);
  if ('response' in auth) {
    return auth.response;
  }

  if (!isDatabaseUrlConfigured()) {
    return apiError('Chat is unavailable in SQL mode right now.', 503);
  }

  if (auth.user.role !== 'player') {
    return apiError('Only players can delete player chat messages here.', 403);
  }

  if (!peerUid || !messageId) {
    return apiError('peerUid and messageId are required.', 400);
  }

  const conversationId = cleanText(body.conversationId) || getDirectConversationId(auth.user.uid, peerUid);
  const direct = validateDirectConversationRead({
    authUid: auth.user.uid,
    authRole: auth.user.role,
    peerUid,
    conversationId,
  });
  if (!direct.ok) {
    console.info('[CHAT_DELETE_PERMISSION_DENIED]', {
      route: ROUTE,
      messageId,
      actorUid: auth.user.uid,
      peerUid,
      conversationId,
      reason: direct.reason,
    });
    return apiError('Conversation does not match authenticated player and peer.', 403);
  }

  const playerScope = await validatePlayerMessageScope(auth.user.uid, peerUid);
  if (!playerScope.ok) {
    console.info('[CHAT_DELETE_PERMISSION_DENIED]', {
      route: ROUTE,
      messageId,
      actorUid: auth.user.uid,
      peerUid,
      conversationId,
      reason: playerScope.reason,
    });
    return apiError('Forbidden.', 403);
  }

  const result = await deleteChatMessageInSql({
    actorUid: auth.user.uid,
    peerUid,
    conversationId: direct.conversationId,
    messageId,
    scope,
  });

  if (!result.ok) {
    return apiError(
      result.reason === 'only_sender_can_delete_for_everyone'
        ? 'Only sender can delete for everyone.'
        : 'Failed to delete chat message.',
      result.status
    );
  }

  return NextResponse.json({
    success: true,
    message: result.message,
    duplicate: 'duplicate' in result ? Boolean(result.duplicate) : false,
    source: 'postgres',
    firestore_fallback: false,
  });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    peerUid?: string;
    conversationId?: string;
    type?: string;
    text?: string;
    imageUrl?: string;
    imagePublicId?: string;
    idempotencyKey?: string;
  };
  const receiverUid = cleanText(body.peerUid);
  console.info('[MESSAGE_CREATE_START]', {
    route: ROUTE,
    peerUid: receiverUid || null,
  });

  const auth = await requireChatPostUser(request);
  if ('response' in auth) {
    console.info('[MESSAGE_CREATE_ERROR]', {
      route: ROUTE,
      peerUid: receiverUid || null,
      reason: 'auth_failed',
      status: auth.response.status,
    });
    return auth.response;
  }

  console.info('[MESSAGE_CREATE_AUTH]', {
    senderUid: auth.user.uid,
    role: auth.user.role,
    coadminUid: auth.user.coadminUid || null,
    peerUid: receiverUid || null,
  });

  if (!isDatabaseUrlConfigured()) {
    return apiError('Chat is unavailable in SQL mode right now.', 503);
  }

  if (!receiverUid) {
    return apiError('peerUid is required.', 400);
  }

  const type = String(body.type || 'text').trim().toLowerCase() === 'image' ? 'image' : 'text';
  if (type === 'image' && auth.user.role !== 'player') {
    return apiError('Image chat not ready.', 501);
  }

  const text = cleanText(body.text);
  const imageUrl = cleanText(body.imageUrl);
  const imagePublicId = cleanText(body.imagePublicId);
  if (type === 'text' && !text) {
    return apiError('Message text is required.', 400);
  }
  if (type === 'image' && (!isValidCloudinaryImageUrl(imageUrl) || !imagePublicId)) {
    return apiError('invalid_photo_message', 400);
  }

  const conversationId = cleanText(body.conversationId) || getConversationId(auth.user.uid, receiverUid);
  const allowedConversationIds = new Set([
    getConversationId(auth.user.uid, receiverUid),
    getDirectConversationId(auth.user.uid, receiverUid),
  ]);
  if (!allowedConversationIds.has(conversationId)) {
    return apiError('Conversation does not match sender and receiver.', 403);
  }

  let playerToPlayerTextBilling: { idempotencyKey: string } | undefined;
  let playerToPlayerPhotoBilling: { idempotencyKey: string } | undefined;
  if (auth.user.role === 'player') {
    const scope = await validatePlayerToPlayerPublicProfiles({
      senderUid: auth.user.uid,
      receiverUid,
    });
    if (!scope.ok) {
      console.info('[MESSAGE_CREATE_ERROR]', {
        route: ROUTE,
        senderUid: auth.user.uid,
        receiverUid,
        reason: scope.reason,
      });
      return apiError(scope.reason, statusForPlayerSendValidationReason(scope.reason));
    }
    if (type === 'image' && scope.receiver.role !== 'player') {
      return apiError('Image chat not ready.', 501);
    }
    if (scope.receiver.role === 'player') {
      const idempotencyKey =
        cleanText(body.idempotencyKey) || cleanText(request.headers.get('Idempotency-Key'));
      if (!idempotencyKey) {
        return apiError('idempotency_key_required', 400);
      }
      if (type === 'image') {
        if (
          !scope.sender.coadminUid ||
          !isValidPlayerChatCloudinaryPublicId(imagePublicId, {
            senderUid: auth.user.uid,
            coadminUid: scope.sender.coadminUid,
          })
        ) {
          return apiError('invalid_photo_message', 400);
        }
        playerToPlayerPhotoBilling = { idempotencyKey };
      } else {
        playerToPlayerTextBilling = { idempotencyKey };
      }
    }
  }

  const result = await sendChatMessageInSql({
    senderUid: auth.user.uid,
    receiverUid,
    conversationId,
    type,
    text: type === 'text' ? text : undefined,
    imageUrl: type === 'image' ? imageUrl : undefined,
    imagePublicId: type === 'image' ? imagePublicId : undefined,
    playerToPlayerTextBilling,
    playerToPlayerPhotoBilling,
  });

  if (!result.ok) {
    console.error('[MESSAGE_CREATE_ERROR]', {
      route: ROUTE,
      senderUid: auth.user.uid,
      receiverUid,
      reason: result.reason,
    });
    const status =
      result.reason === 'insufficient_coin_for_chat_message'
        ? 402
        : result.reason === 'insufficient_coin_for_chat_photo'
          ? 402
          : result.reason === 'idempotency_conflict'
            ? 409
            : result.reason === 'missing_image'
              ? 400
              : 500;
    return apiError(
      result.reason === 'insufficient_coin_for_chat_message' ||
        result.reason === 'insufficient_coin_for_chat_photo' ||
        result.reason === 'missing_image' ||
        result.reason === 'idempotency_conflict'
        ? result.reason
        : 'Failed to send chat message.',
      status
    );
  }

  console.info('[PLAYER_MESSAGE_SENT]', {
    route: ROUTE,
    senderUid: auth.user.uid,
    receiverUid,
    conversationId: result.conversationId,
    messageId: result.messageId,
    auth_path: auth.authPath,
    role: auth.user.role,
  });

  return NextResponse.json({
    success: true,
    message: {
      id: result.messageId,
      senderUid: auth.user.uid,
      receiverUid,
      type,
      text: type === 'text' ? text : null,
      imageUrl: type === 'image' ? imageUrl : null,
      imagePublicId: type === 'image' ? imagePublicId : null,
      createdAt: result.createdAt,
    },
    messageId: result.messageId,
    conversationId: result.conversationId,
    createdAt: result.createdAt,
    chargedAmount: result.billing?.chargedAmount ?? 0,
    freeMessagesUsedInWindow: result.billing?.freeMessagesUsedInWindow ?? null,
    freeMessagesRemaining: result.billing?.freeMessagesRemaining ?? null,
    senderCoinBalance: result.billing?.senderCoinBalance ?? null,
    duplicate: result.duplicate === true,
    source: 'postgres',
    firestore_fallback: false,
  });
}
