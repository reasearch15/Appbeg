'use client';

import {
  addDoc,
  arrayRemove,
  arrayUnion,
  collection,
  doc,
  getDoc,
  getDocs,
  increment,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';

import { computeRewardCoinsAfterFee } from '@/lib/rewardCoinTransferFee';
import { auth, db } from '@/lib/firebase/client';
import { uploadImageToCloudinary } from '@/lib/cloudinary/uploadImage';
import { chatMessageTtl } from '@/lib/firestore/ttl';
import { getLocalAppSessionId } from '@/features/auth/appSession';
import { getLocalPlayerSessionId, getPlayerApiHeaders } from '@/features/auth/playerSession';
import { getCachedSessionUser } from '@/features/auth/sessionUser';
import { fetchChatApi } from '@/lib/client/chatLogoutDiagnostics';
import {
  noopFirestoreUnsubscribe,
  shouldSkipClientFirestore,
} from '@/lib/client/clientFirestoreGuard';
import {
  logClientFirebaseRuntimeRemoved,
  logSqlClientMigration,
} from '@/lib/client/sqlClientMigration';
import { getSqlApiReadHeaders } from '@/lib/client/sqlApiHeaders';
import { isClientSqlReadMode } from '@/lib/client/sqlReadMode';
import { attachSqlChatMessagesPoll } from '@/features/live/chatSqlRead';

const DIRECT_CONVERSATIONS = 'playerConversations';
const GROUP_CONVERSATIONS = 'playerGroupConversations';
const GLOBAL_GROUP_ID = 'global';
const RATE_LIMIT_MS = 900;
export const PLAYER_CHAT_RENDER_LIMIT = 7;
const DIRECT_MESSAGE_LIVE_WINDOW = PLAYER_CHAT_RENDER_LIMIT;

export type PlayerPeer = {
  uid: string;
  avatarEmoji: string;
  avatarName: string;
  gender?: string;
  bio: string;
  avatarImageUrl?: string | null;
  lastSeenAt?: string | null;
};

export type PlayerChatMessage = {
  id: string;
  senderUid: string;
  text?: string;
  imageUrl?: string;
  imagePublicId?: string;
  type: 'text' | 'image';
  createdAt?: Date;
  replyToMessageId?: string;
  replyToText?: string;
  deletedForEveryone?: boolean;
  deletedFor?: string[];
  deliveredTo?: string[];
  seenBy?: string[];
};

export type PlayerChatSendResult = {
  messageId: string;
  conversationId: string;
  createdAt: string | null;
  chargedAmount: number;
  senderCoinBalance: number | null;
  duplicate: boolean;
};

export type PlayerChatListItem = {
  conversationId: string;
  otherUid: string;
  lastMessage: string;
  lastMessageAt?: Date;
  unreadCount: number;
  muted: boolean;
};

export type FriendLink = {
  id: string;
  participants: string[];
  status: 'pending' | 'accepted';
  requestedByUid: string;
  createdAt?: string | null;
  updatedAt?: string | null;
  peer?: PlayerPeer;
};

export type PlayerChatProfile = {
  isActive: boolean;
  avatarEmoji: string;
  avatarName: string;
  gender: string;
  bio: string;
  avatarImageUrl: string | null;
  reviewStatus: string;
  suspendedUntil: string | null;
  activatedAt: string | null;
};

export type PlayerChatProfileInput = {
  avatarEmoji: string;
  avatarName: string;
  gender: string;
  bio: string;
};

function defaultPlayerChatProfile(): PlayerChatProfile {
  return {
    isActive: false,
    avatarEmoji: '',
    avatarName: '',
    gender: '',
    bio: '',
    avatarImageUrl: null,
    reviewStatus: 'approved',
    suspendedUntil: null,
    activatedAt: null,
  };
}

function mapPlayerChatProfile(value: Partial<PlayerChatProfile> | null | undefined): PlayerChatProfile {
  return {
    isActive: value?.isActive === true,
    avatarEmoji: cleanText(value?.avatarEmoji || ''),
    avatarName: cleanText(value?.avatarName || ''),
    gender: cleanText(value?.gender || '').toLowerCase(),
    bio: cleanText(value?.bio || ''),
    avatarImageUrl: cleanText(value?.avatarImageUrl || '') || null,
    reviewStatus: cleanText(value?.reviewStatus || '') || 'approved',
    suspendedUntil: cleanText(value?.suspendedUntil || '') || null,
    activatedAt: cleanText(value?.activatedAt || '') || null,
  };
}

async function readProfileApiPayload(response: Response, fallback: string) {
  const payload = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    profile?: Partial<PlayerChatProfile>;
    error?: string;
  };
  if (!response.ok) {
    throw new Error(payload.error || fallback);
  }
  return mapPlayerChatProfile(payload.profile || defaultPlayerChatProfile());
}

export async function getMyPlayerChatProfile() {
  const headers = await getPlayerApiHeaders(false, {
    route: '/api/player/chat/profile',
  });
  const response = await fetch('/api/player/chat/profile', {
    method: 'GET',
    headers,
    cache: 'no-store',
  });
  return readProfileApiPayload(response, 'Failed to load Player Chat profile.');
}

export async function updateMyPlayerChatProfile(input: PlayerChatProfileInput) {
  const headers = await getPlayerApiHeaders(true, {
    route: '/api/player/chat/profile',
  });
  const response = await fetch('/api/player/chat/profile', {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      avatarEmoji: input.avatarEmoji,
      avatarName: input.avatarName,
      gender: input.gender,
      bio: input.bio,
    }),
    cache: 'no-store',
  });
  return readProfileApiPayload(response, 'Failed to save Player Chat profile.');
}

export async function activateMyPlayerChatProfile() {
  const headers = await getPlayerApiHeaders(true, {
    route: '/api/player/chat/profile/activate',
  });
  const response = await fetch('/api/player/chat/profile/activate', {
    method: 'POST',
    headers,
    body: JSON.stringify({}),
    cache: 'no-store',
  });
  return readProfileApiPayload(response, 'Failed to activate Player Chat profile.');
}

export async function deactivateMyPlayerChatProfile() {
  const headers = await getPlayerApiHeaders(true, {
    route: '/api/player/chat/profile/deactivate',
  });
  const response = await fetch('/api/player/chat/profile/deactivate', {
    method: 'POST',
    headers,
    body: JSON.stringify({}),
    cache: 'no-store',
  });
  return readProfileApiPayload(response, 'Failed to deactivate Player Chat profile.');
}

export async function fetchPlayerChatBootstrap(search = '') {
  const params = new URLSearchParams();
  const cleanSearch = cleanText(search);
  if (cleanSearch) {
    params.set('search', cleanSearch);
  }
  params.set('limit', '150');

  const headers = await getSqlApiReadHeaders(false);
  const cached = getCachedSessionUser();
  const response = await fetchChatApi(
    `/api/player/chat/bootstrap?${params.toString()}`,
    {
      method: 'GET',
      headers,
      cache: 'no-store',
    },
    {
      role: cached?.role ?? 'player',
      uid: cached?.uid ?? null,
      hasAppSessionId: Boolean(getLocalAppSessionId()),
      hasPlayerSessionId: Boolean(getLocalPlayerSessionId()),
      headersSent: Object.keys(headers),
    }
  );
  const payload = (await response.json().catch(() => ({}))) as {
    players?: PlayerPeer[];
    error?: string;
  };
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to load player chat.');
  }
  return (payload.players || [])
    .map((player) => ({
      uid: cleanText(player.uid),
      avatarEmoji: cleanText(player.avatarEmoji),
      avatarName: cleanText(player.avatarName) || 'Player',
      gender: cleanText(String(player.gender || '')).toLowerCase(),
      bio: cleanText(player.bio),
      avatarImageUrl: cleanText(String(player.avatarImageUrl || '')) || null,
      lastSeenAt: cleanText(String(player.lastSeenAt || '')) || null,
    }))
    .filter((player) => player.uid);
}

type ConversationDoc = {
  participants?: string[];
  lastMessage?: string;
  lastMessageAt?: Date;
  unreadCounts?: Record<string, number>;
  mutedBy?: string[];
  updatedAt?: Date;
};

function toMillis(value: unknown) {
  if (!value || typeof value !== 'object') return 0;
  if (value instanceof Date) return value.getTime();
  const maybe = value as { toMillis?: () => number; toDate?: () => Date; seconds?: number };
  if (typeof maybe.toMillis === 'function') return maybe.toMillis();
  if (typeof maybe.toDate === 'function') return maybe.toDate().getTime();
  if (typeof maybe.seconds === 'number') return maybe.seconds * 1000;
  return 0;
}

function assertAuthUid() {
  const cached = getCachedSessionUser();
  const uid = cached?.uid || auth.currentUser?.uid;
  if (!uid) {
    throw new Error('Not authenticated.');
  }
  return uid;
}

function resolveListenerSelfUid() {
  const cached = getCachedSessionUser();
  return cached?.uid || auth.currentUser?.uid || '';
}

function cleanText(text: string) {
  return String(text || '').trim();
}

function tokenizeText(text: string) {
  const t = cleanText(text).toLowerCase();
  if (!t) return [];
  return Array.from(new Set(t.split(/\s+/).filter((part) => part.length >= 2))).slice(0, 25);
}

export function getDirectConversationId(uidA: string, uidB: string) {
  return [uidA, uidB].sort().join('__');
}

function getFriendLinkId(uidA: string, uidB: string) {
  return [uidA, uidB].sort().join('__');
}

function mapSqlDirectMessage(message: {
  id: string;
  senderUid: string;
  text?: string;
  imageUrl?: string;
  imagePublicId?: string;
  type?: 'text' | 'image';
  createdAt?: Date | null;
  deletedForEveryone?: boolean;
  deletedFor?: string[];
}): PlayerChatMessage {
  return {
    id: message.id,
    senderUid: message.senderUid,
    text: message.text,
    imageUrl: message.imageUrl,
    imagePublicId: message.imagePublicId,
    type: message.type === 'image' ? 'image' : 'text',
    createdAt: message.createdAt || undefined,
    deletedForEveryone: message.deletedForEveryone === true,
    deletedFor: Array.isArray(message.deletedFor) ? message.deletedFor : [],
  };
}

export function isDirectMessageVisibleToPlayer(message: PlayerChatMessage, playerUid: string) {
  if (message.deletedForEveryone === true) {
    return true;
  }
  return !Array.isArray(message.deletedFor) || !message.deletedFor.includes(playerUid);
}

export function filterVisibleDirectMessages(
  messages: PlayerChatMessage[],
  playerUid: string
) {
  return messages.filter((message) => isDirectMessageVisibleToPlayer(message, playerUid));
}

async function deleteDirectMessageViaSql(
  otherUid: string,
  messageId: string,
  scope: 'for_me' | 'for_everyone'
) {
  const selfUid = assertAuthUid();
  const conversationId = getDirectConversationId(selfUid, otherUid);
  console.info('[CHAT_DELETE_REQUEST]', {
    messageId,
    senderUid: selfUid,
    peerUid: otherUid,
    conversationId,
    scope,
    source: 'client',
  });
  const response = await fetchChatApi(
    '/api/chat/messages',
    {
      method: 'PATCH',
      headers: await getSqlApiReadHeaders(true),
      body: JSON.stringify({
        peerUid: otherUid,
        conversationId,
        messageId,
        scope,
      }),
      cache: 'no-store',
    },
    {
      role: getCachedSessionUser()?.role ?? 'player',
      uid: selfUid,
      hasAppSessionId: Boolean(getLocalAppSessionId()),
      hasPlayerSessionId: Boolean(getLocalPlayerSessionId()),
      headersSent: ['content-type'],
    }
  );
  const payload = (await response.json().catch(() => ({}))) as {
    message?: PlayerChatMessage;
    error?: string;
  };
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to delete chat message.');
  }
  return payload.message ? mapSqlDirectMessage(payload.message) : null;
}

async function withRateLimit(conversationId: string, senderUid: string) {
  const ref = doc(db, DIRECT_CONVERSATIONS, conversationId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    const nowMs = Date.now();
    const lastSent =
      snap.exists() && snap.data().lastSentAtByUid?.[senderUid]?.toMillis
        ? snap.data().lastSentAtByUid[senderUid].toMillis()
        : 0;
    if (nowMs - lastSent < RATE_LIMIT_MS) {
      throw new Error('You are sending too fast. Please wait a moment.');
    }
    tx.set(
      ref,
      {
        lastSentAtByUid: {
          [senderUid]: serverTimestamp(),
        },
      },
      { merge: true }
    );
  });
}

async function sendDirectTextMessageViaSql(
  senderUid: string,
  receiverUid: string,
  text: string,
  conversationId: string,
  idempotencyKey: string
) {
  const response = await fetch('/api/chat/messages', {
    method: 'POST',
    headers: {
      ...(await getSqlApiReadHeaders(true)),
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({
      peerUid: receiverUid,
      conversationId,
      type: 'text',
      text,
      idempotencyKey,
    }),
    cache: 'no-store',
  });
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    const errorCode = cleanText(payload.error || '');
    if (errorCode === 'sender_chat_profile_inactive') {
      throw new Error('Activate your chat profile before sending messages.');
    }
    if (errorCode === 'receiver_chat_profile_inactive') {
      throw new Error('This player is not available for chat right now.');
    }
    if (errorCode === 'invalid_chat_receiver') {
      throw new Error('This player is not available for chat right now.');
    }
    if (errorCode === 'out_of_scope_receiver') {
      throw new Error('This player is not available for chat right now.');
    }
    if (errorCode === 'insufficient_coin_for_chat_message') {
      throw new Error('You need coins to send more messages today.');
    }
    if (errorCode === 'insufficient_coin_for_chat_photo') {
      throw new Error('You need 1 coin to send a photo.');
    }
    if (errorCode === 'invalid_photo_message' || errorCode === 'missing_image') {
      throw new Error('Could not send photo. Please try again.');
    }
    if (errorCode === 'idempotency_conflict') {
      throw new Error('This message retry could not be verified. Please type it again.');
    }
    throw new Error(errorCode || 'Failed to send chat message.');
  }
  logSqlClientMigration({
    feature: 'player_chat_send_text',
    oldFirebaseOperation: 'setDoc+addDoc',
    newSqlRoute: '/api/chat/messages',
    result: 'ok',
    fallbackUsed: false,
  });
}

async function sendDirectImageMessageViaSql(
  receiverUid: string,
  input: {
    conversationId: string;
    imageUrl: string;
    imagePublicId: string;
    idempotencyKey: string;
  }
): Promise<PlayerChatSendResult> {
  const response = await fetch('/api/chat/messages', {
    method: 'POST',
    headers: {
      ...(await getSqlApiReadHeaders(true)),
      'Idempotency-Key': input.idempotencyKey,
    },
    body: JSON.stringify({
      peerUid: receiverUid,
      conversationId: input.conversationId,
      type: 'image',
      imageUrl: input.imageUrl,
      imagePublicId: input.imagePublicId,
      idempotencyKey: input.idempotencyKey,
    }),
    cache: 'no-store',
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    messageId?: string;
    conversationId?: string;
    createdAt?: string;
    chargedAmount?: number;
    senderCoinBalance?: number | null;
    duplicate?: boolean;
  };
  if (!response.ok) {
    const errorCode = cleanText(payload.error || '');
    if (errorCode === 'sender_chat_profile_inactive') {
      throw new Error('Activate your chat profile before sending photos.');
    }
    if (errorCode === 'receiver_chat_profile_inactive') {
      throw new Error('This player is not available for chat right now.');
    }
    if (errorCode === 'invalid_chat_receiver' || errorCode === 'out_of_scope_receiver') {
      throw new Error('This player is not available for chat right now.');
    }
    if (errorCode === 'insufficient_coin_for_chat_photo') {
      throw new Error('You need 1 coin to send a photo.');
    }
    if (errorCode === 'invalid_photo_message' || errorCode === 'missing_image') {
      throw new Error('Could not send photo. Please try again.');
    }
    if (errorCode === 'idempotency_conflict') {
      throw new Error('This photo retry could not be verified. Please choose it again.');
    }
    throw new Error(errorCode || 'Failed to send photo.');
  }
  logSqlClientMigration({
    feature: 'player_chat_send_image',
    oldFirebaseOperation: 'setDoc+addDoc',
    newSqlRoute: '/api/chat/messages',
    result: 'ok',
    fallbackUsed: false,
  });
  return {
    messageId: cleanText(payload.messageId || ''),
    conversationId: cleanText(payload.conversationId || ''),
    createdAt: cleanText(payload.createdAt || '') || null,
    chargedAmount: Number(payload.chargedAmount || 0),
    senderCoinBalance:
      payload.senderCoinBalance == null ? null : Number(payload.senderCoinBalance),
    duplicate: payload.duplicate === true,
  };
}

async function markDirectConversationSeenViaSql(otherUid: string) {
  const selfUid = assertAuthUid();
  const conversationId = getDirectConversationId(selfUid, otherUid);
  const response = await fetch('/api/conversations/cache/mirror', {
    method: 'POST',
    headers: await getSqlApiReadHeaders(true),
    body: JSON.stringify({
      conversationId,
      action: 'mark_read',
      unreadCounts: { [selfUid]: 0 },
    }),
    cache: 'no-store',
  });
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to mark chat as read.');
  }
}

export async function sendDirectTextMessage(
  receiverUid: string,
  text: string,
  options?: { replyToMessageId?: string; replyToText?: string; idempotencyKey?: string }
) {
  const senderUid = assertAuthUid();
  const body = cleanText(text);
  if (!body) return;

  const conversationId = getDirectConversationId(senderUid, receiverUid);

  if (isClientSqlReadMode()) {
    logClientFirebaseRuntimeRemoved({
      feature: 'player_chat_send_text',
      file: 'features/messages/playerChat.ts',
      operation: 'setDoc+addDoc',
      replacement: 'POST /api/chat/messages',
    });
    const idempotencyKey =
      cleanText(options?.idempotencyKey || '') ||
      (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await sendDirectTextMessageViaSql(senderUid, receiverUid, body, conversationId, idempotencyKey);
    return;
  }
  await withRateLimit(conversationId, senderUid);
  const conversationRef = doc(db, DIRECT_CONVERSATIONS, conversationId);

  await setDoc(
    conversationRef,
    {
      participants: [senderUid, receiverUid],
      type: 'direct',
      lastMessage: body,
      lastMessageAt: serverTimestamp(),
      lastMessageSenderUid: senderUid,
      updatedAt: serverTimestamp(),
      unreadCounts: {
        [receiverUid]: increment(1),
        [senderUid]: 0,
      },
      mutedBy: [],
    },
    { merge: true }
  );

  await addDoc(collection(db, DIRECT_CONVERSATIONS, conversationId, 'messages'), {
    senderUid,
    receiverUid,
    text: body,
    type: 'text',
    replyToMessageId: options?.replyToMessageId || '',
    replyToText: cleanText(options?.replyToText || ''),
    searchTokens: tokenizeText(body),
    deliveredTo: [senderUid],
    seenBy: [senderUid],
    deletedFor: [],
    createdAt: serverTimestamp(),
    ttlExpiresAt: chatMessageTtl(),
  });
}

export async function sendDirectImageMessage(
  receiverUid: string,
  file: File,
  options?: {
    replyToMessageId?: string;
    replyToText?: string;
    idempotencyKey?: string;
    uploadedImage?: { secureUrl: string; publicId: string };
  }
) {
  const senderUid = assertAuthUid();
  if (!file.type.startsWith('image/')) {
    throw new Error('Only image files are allowed.');
  }
  const maxSizeBytes = 5 * 1024 * 1024;
  if (file.size > maxSizeBytes) {
    throw new Error('Image must be smaller than 5MB.');
  }

  if (isClientSqlReadMode()) {
    logClientFirebaseRuntimeRemoved({
      feature: 'player_chat_send_image',
      file: 'features/messages/playerChat.ts',
      operation: 'setDoc+addDoc',
      replacement: 'POST /api/chat/messages',
    });
    const conversationId = getDirectConversationId(senderUid, receiverUid);
    const imageUrl = cleanText(options?.uploadedImage?.secureUrl || '');
    const imagePublicId = cleanText(options?.uploadedImage?.publicId || '');
    const idempotencyKey =
      cleanText(options?.idempotencyKey || '') ||
      (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    if (!imageUrl || !imagePublicId) {
      throw new Error('Could not upload photo. Please try again.');
    }
    return sendDirectImageMessageViaSql(receiverUid, {
      conversationId,
      imageUrl,
      imagePublicId,
      idempotencyKey,
    });
  }

  const conversationId = getDirectConversationId(senderUid, receiverUid);
  await withRateLimit(conversationId, senderUid);
  const uploaded = await uploadImageToCloudinary(file);
  const conversationRef = doc(db, DIRECT_CONVERSATIONS, conversationId);

  await setDoc(
    conversationRef,
    {
      participants: [senderUid, receiverUid],
      type: 'direct',
      lastMessage: '📷 Photo',
      lastMessageAt: serverTimestamp(),
      lastMessageSenderUid: senderUid,
      updatedAt: serverTimestamp(),
      unreadCounts: {
        [receiverUid]: increment(1),
        [senderUid]: 0,
      },
      mutedBy: [],
    },
    { merge: true }
  );

  await addDoc(collection(db, DIRECT_CONVERSATIONS, conversationId, 'messages'), {
    senderUid,
    receiverUid,
    type: 'image',
    imageUrl: uploaded.url,
    imagePublicId: uploaded.publicId,
    replyToMessageId: options?.replyToMessageId || '',
    replyToText: cleanText(options?.replyToText || ''),
    searchTokens: [],
    deliveredTo: [senderUid],
    seenBy: [senderUid],
    deletedFor: [],
    createdAt: serverTimestamp(),
    ttlExpiresAt: chatMessageTtl(),
  });
  return null;
}

export function listenDirectMessages(
  otherUid: string,
  onNext: (messages: PlayerChatMessage[]) => void
) {
  const selfUid = resolveListenerSelfUid();
  if (!selfUid) {
    onNext([]);
    return () => {};
  }
  const conversationId = getDirectConversationId(selfUid, otherUid);

  if (isClientSqlReadMode()) {
    logClientFirebaseRuntimeRemoved({
      feature: 'player_chat_direct_messages',
      file: 'features/messages/playerChat.ts',
      operation: 'onSnapshot',
      replacement: 'GET /api/chat/messages',
    });
    return attachSqlChatMessagesPoll(
      otherUid,
      (messages) => {
        onNext(messages.map(mapSqlDirectMessage));
      },
      {
        limit: DIRECT_MESSAGE_LIVE_WINDOW,
        requirePlayerRole: true,
        conversationId,
      },
      (error) => {
        console.error('[PLAYER_CHAT_DIRECT_MESSAGES_SQL_READ_FAILED]', error);
      }
    );
  }

  if (
    shouldSkipClientFirestore({
      file: 'features/messages/playerChat.ts',
      feature: 'player_chat_direct_messages',
      collection: 'playerConversations/messages',
      operation: 'onSnapshot',
    })
  ) {
    onNext([]);
    return noopFirestoreUnsubscribe();
  }

  const q = query(
    collection(db, DIRECT_CONVERSATIONS, conversationId, 'messages'),
    orderBy('createdAt', 'desc'),
    limit(DIRECT_MESSAGE_LIVE_WINDOW)
  );
  return onSnapshot(q, (snap) => {
    const list = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<PlayerChatMessage, 'id'>) }));
    onNext(list.reverse());
  });
}

export async function markDirectConversationSeen(otherUid: string) {
  if (isClientSqlReadMode()) {
    await markDirectConversationSeenViaSql(otherUid);
    return;
  }
  const selfUid = assertAuthUid();
  const conversationId = getDirectConversationId(selfUid, otherUid);

  await setDoc(
    doc(db, DIRECT_CONVERSATIONS, conversationId),
    {
      unreadCounts: { [selfUid]: 0 },
      seenAtByUid: { [selfUid]: serverTimestamp() },
      deliveredAtByUid: { [selfUid]: serverTimestamp() },
    },
    { merge: true }
  );

  const msgSnap = await getDocs(
    query(
      collection(db, DIRECT_CONVERSATIONS, conversationId, 'messages'),
      orderBy('createdAt', 'desc'),
      limit(60)
    )
  );
  if (msgSnap.empty) return;
  const batch = writeBatch(db);
  msgSnap.docs.forEach((m) => {
    const data = m.data() as PlayerChatMessage;
    if (data.senderUid === selfUid) return;
    batch.update(m.ref, {
      deliveredTo: arrayUnion(selfUid),
      seenBy: arrayUnion(selfUid),
    });
  });
  await batch.commit();
}

export function listenDirectTyping(
  otherUid: string,
  onNext: (typing: boolean) => void
) {
  if (
    shouldSkipClientFirestore({
      file: 'features/messages/playerChat.ts',
      feature: 'player_chat_direct_typing',
      collection: 'playerConversations',
      operation: 'onSnapshot',
    })
  ) {
    onNext(false);
    return noopFirestoreUnsubscribe();
  }

  const selfUid = resolveListenerSelfUid();
  if (!selfUid) {
    onNext(false);
    return () => {};
  }
  const conversationId = getDirectConversationId(selfUid, otherUid);
  return onSnapshot(doc(db, DIRECT_CONVERSATIONS, conversationId), (snap) => {
    if (!snap.exists()) {
      onNext(false);
      return;
    }
    const typingAt = snap.data().typingAtByUid?.[otherUid];
    const isTyping = !!typingAt && Date.now() - toMillis(typingAt) < 5000;
    onNext(isTyping);
  });
}

export async function setDirectTyping(otherUid: string, typing: boolean) {
  if (isClientSqlReadMode()) {
    return;
  }
  const selfUid = assertAuthUid();
  const conversationId = getDirectConversationId(selfUid, otherUid);
  await setDoc(
    doc(db, DIRECT_CONVERSATIONS, conversationId),
    {
      participants: [selfUid, otherUid],
      type: 'direct',
      typingAtByUid: {
        [selfUid]: typing ? serverTimestamp() : null,
      },
    },
    { merge: true }
  );
}

export function listenDirectChatList(onNext: (rows: PlayerChatListItem[]) => void) {
  if (
    shouldSkipClientFirestore({
      file: 'features/messages/playerChat.ts',
      feature: 'player_chat_direct_list',
      collection: 'playerConversations',
      operation: 'onSnapshot',
    })
  ) {
    onNext([]);
    return noopFirestoreUnsubscribe();
  }

  const selfUid = resolveListenerSelfUid();
  if (!selfUid) {
    onNext([]);
    return () => {};
  }
  const q = query(
    collection(db, DIRECT_CONVERSATIONS),
    where('participants', 'array-contains', selfUid),
    limit(150)
  );
  return onSnapshot(q, (snap) => {
    const rows: PlayerChatListItem[] = snap.docs.map((d) => {
      const data = d.data() as ConversationDoc;
      const participants = Array.isArray(data.participants) ? data.participants : [];
      const otherUid = participants.find((uid: string) => uid !== selfUid) || '';
      return {
        conversationId: d.id,
        otherUid,
        lastMessage: String(data.lastMessage || ''),
        lastMessageAt: data.lastMessageAt as Date | undefined,
        unreadCount: Number(data.unreadCounts?.[selfUid] || 0),
        muted: Array.isArray(data.mutedBy) ? data.mutedBy.includes(selfUid) : false,
      };
    });
    const sorted = rows
      .filter((r) => !!r.otherUid)
      .sort((a, b) => {
        const aMs = toMillis(a.lastMessageAt);
        const bMs = toMillis(b.lastMessageAt);
        return bMs - aMs;
      });
    onNext(sorted);
  });
}

export async function setDirectConversationMuted(otherUid: string, muted: boolean) {
  const selfUid = assertAuthUid();
  const conversationId = getDirectConversationId(selfUid, otherUid);
  await setDoc(
    doc(db, DIRECT_CONVERSATIONS, conversationId),
    {
      participants: [selfUid, otherUid],
      type: 'direct',
      mutedBy: muted ? arrayUnion(selfUid) : arrayRemove(selfUid),
    },
    { merge: true }
  );
}

export async function deleteDirectMessageForMe(otherUid: string, messageId: string) {
  if (isClientSqlReadMode()) {
    return deleteDirectMessageViaSql(otherUid, messageId, 'for_me');
  }
  const selfUid = assertAuthUid();
  const conversationId = getDirectConversationId(selfUid, otherUid);
  await updateDoc(doc(db, DIRECT_CONVERSATIONS, conversationId, 'messages', messageId), {
    deletedFor: arrayUnion(selfUid),
  });
  return null;
}

export async function deleteDirectMessageForEveryone(otherUid: string, messageId: string) {
  if (isClientSqlReadMode()) {
    return deleteDirectMessageViaSql(otherUid, messageId, 'for_everyone');
  }
  const selfUid = assertAuthUid();
  const conversationId = getDirectConversationId(selfUid, otherUid);
  const messageRef = doc(db, DIRECT_CONVERSATIONS, conversationId, 'messages', messageId);
  const snap = await getDoc(messageRef);
  if (!snap.exists()) return;
  const data = snap.data() as PlayerChatMessage;
  if (data.senderUid !== selfUid) {
    throw new Error('Only sender can delete for everyone.');
  }
  await updateDoc(messageRef, {
    text: '',
    imageUrl: '',
    imagePublicId: '',
    deletedForEveryone: true,
    searchTokens: [],
  });
  return null;
}

export async function searchDirectMessages(otherUid: string, keyword: string) {
  const selfUid = assertAuthUid();
  const token = cleanText(keyword).toLowerCase();
  if (token.length < 2) {
    return [] as PlayerChatMessage[];
  }
  const conversationId = getDirectConversationId(selfUid, otherUid);
  const q = query(
    collection(db, DIRECT_CONVERSATIONS, conversationId, 'messages'),
    where('searchTokens', 'array-contains', token),
    orderBy('createdAt', 'desc'),
    limit(40)
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<PlayerChatMessage, 'id'>) }));
}

export async function sendGlobalGroupTextMessage(text: string) {
  const senderUid = assertAuthUid();
  const body = cleanText(text);
  if (!body) return;
  await addDoc(collection(db, GROUP_CONVERSATIONS, GLOBAL_GROUP_ID, 'messages'), {
    senderUid,
    text: body,
    type: 'text',
    searchTokens: tokenizeText(body),
    createdAt: serverTimestamp(),
    ttlExpiresAt: chatMessageTtl(),
  });
  await setDoc(
    doc(db, GROUP_CONVERSATIONS, GLOBAL_GROUP_ID),
    {
      updatedAt: serverTimestamp(),
      lastMessage: body,
      lastMessageAt: serverTimestamp(),
    },
    { merge: true }
  );
}

export function listenGlobalGroupMessages(onNext: (messages: PlayerChatMessage[]) => void) {
  if (
    shouldSkipClientFirestore({
      file: 'features/messages/playerChat.ts',
      feature: 'player_chat_global_group_messages',
      collection: 'playerGroupConversations/messages',
      operation: 'onSnapshot',
    })
  ) {
    onNext([]);
    return noopFirestoreUnsubscribe();
  }

  const q = query(
    collection(db, GROUP_CONVERSATIONS, GLOBAL_GROUP_ID, 'messages'),
    orderBy('createdAt', 'asc'),
    limit(120)
  );
  return onSnapshot(q, (snap) => {
    const list = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<PlayerChatMessage, 'id'>) }));
    onNext(list);
  });
}

export async function sendFriendRequest(otherUid: string) {
  const cleanOtherUid = cleanText(otherUid);
  if (!cleanOtherUid) return;
  if (isClientSqlReadMode()) {
    logClientFirebaseRuntimeRemoved({
      feature: 'player_chat_friend_request',
      file: 'features/messages/playerChat.ts',
      operation: 'getDoc+setDoc playerFriendLinks',
      replacement: 'POST /api/player/chat/friends',
    });
    const headers = await getPlayerApiHeaders(true, {
      route: '/api/player/chat/friends',
    });
    const cached = getCachedSessionUser();
    const response = await fetchChatApi(
      '/api/player/chat/friends',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ targetUid: cleanOtherUid }),
        cache: 'no-store',
      },
      {
        role: cached?.role ?? 'player',
        uid: cached?.uid ?? null,
        hasAppSessionId: Boolean(getLocalAppSessionId()),
        hasPlayerSessionId: Boolean(getLocalPlayerSessionId()),
        headersSent: Object.keys(headers),
      }
    );
    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
      link?: FriendLink;
      duplicate?: boolean;
    };
    if (!response.ok) {
      throw new Error(payload.error || 'Failed to send friend request.');
    }
    return {
      link: payload.link,
      duplicate: payload.duplicate === true,
    };
  }

  const selfUid = assertAuthUid();
  if (selfUid === cleanOtherUid) return;
  const ref = doc(db, 'playerFriendLinks', getFriendLinkId(selfUid, cleanOtherUid));
  const snap = await getDoc(ref);
  if (snap.exists()) return;
  await setDoc(
    ref,
    {
      participants: [selfUid, cleanOtherUid],
      status: 'pending',
      requestedByUid: selfUid,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
}

export async function sendFriendRequestByReferralCode(referralCode: string) {
  const cleanCode = String(referralCode || '').trim().toUpperCase();
  if (!cleanCode) {
    throw new Error('Referral code is required.');
  }

  if (isClientSqlReadMode()) {
    logClientFirebaseRuntimeRemoved({
      feature: 'player_chat_friend_by_referral_code',
      file: 'features/messages/playerChat.ts',
      operation: 'query users + setDoc playerFriendLinks',
      replacement: 'POST /api/player/chat/friend-by-referral-code',
    });
    const headers = await getPlayerApiHeaders(true, {
      route: '/api/player/chat/friend-by-referral-code',
    });
    const cached = getCachedSessionUser();
    const response = await fetchChatApi(
      '/api/player/chat/friend-by-referral-code',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ referralCode: cleanCode }),
        cache: 'no-store',
      },
      {
        role: cached?.role ?? 'player',
        uid: cached?.uid ?? null,
        hasAppSessionId: Boolean(getLocalAppSessionId()),
        hasPlayerSessionId: Boolean(getLocalPlayerSessionId()),
        headersSent: Object.keys(headers),
      }
    );
    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
      target?: { uid?: string; username?: string };
      link?: FriendLink;
      duplicate?: boolean;
    };
    if (!response.ok) {
      throw new Error(payload.error || 'Failed to add friend.');
    }
    return {
      uid: cleanText(payload.target?.uid || ''),
      username: cleanText(payload.target?.username || '') || 'Player',
      link: payload.link,
      duplicate: payload.duplicate === true,
    };
  }

  const selfUid = assertAuthUid();
  const matchSnap = await getDocs(
    query(
      collection(db, 'users'),
      where('role', '==', 'player'),
      where('status', '==', 'active'),
      where('referralCode', '==', cleanCode),
      limit(1)
    )
  );

  if (matchSnap.empty) {
    throw new Error('No player found with this referral code.');
  }

  const matchedDoc = matchSnap.docs[0];
  if (matchedDoc.id === selfUid) {
    throw new Error('You cannot add yourself.');
  }

  await sendFriendRequest(matchedDoc.id);
  const data = matchedDoc.data() as { username?: string };
  return {
    uid: matchedDoc.id,
    username: String(data.username || '').trim() || 'Player',
  };
}

export async function acceptFriendRequest(otherUid: string) {
  const cleanOtherUid = cleanText(otherUid);
  if (!cleanOtherUid) return;
  if (isClientSqlReadMode()) {
    logClientFirebaseRuntimeRemoved({
      feature: 'player_chat_friend_accept',
      file: 'features/messages/playerChat.ts',
      operation: 'setDoc playerFriendLinks',
      replacement: 'POST /api/player/chat/friends/accept',
    });
    const headers = await getPlayerApiHeaders(true, {
      route: '/api/player/chat/friends/accept',
    });
    const cached = getCachedSessionUser();
    const response = await fetchChatApi(
      '/api/player/chat/friends/accept',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ otherUid: cleanOtherUid }),
        cache: 'no-store',
      },
      {
        role: cached?.role ?? 'player',
        uid: cached?.uid ?? null,
        hasAppSessionId: Boolean(getLocalAppSessionId()),
        hasPlayerSessionId: Boolean(getLocalPlayerSessionId()),
        headersSent: Object.keys(headers),
      }
    );
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) {
      throw new Error(payload.error || 'Failed to accept friend request.');
    }
    return;
  }

  const selfUid = assertAuthUid();
  const ref = doc(db, 'playerFriendLinks', getFriendLinkId(selfUid, cleanOtherUid));
  await setDoc(
    ref,
    {
      participants: [selfUid, cleanOtherUid],
      status: 'accepted',
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
}

export async function declineFriendRequest(otherUid: string) {
  const cleanOtherUid = cleanText(otherUid);
  if (!cleanOtherUid) {
    throw new Error('Player is required.');
  }
  if (!isClientSqlReadMode()) {
    throw new Error('Declining friend requests requires the SQL chat runtime.');
  }

  logClientFirebaseRuntimeRemoved({
    feature: 'player_chat_friend_decline',
    file: 'features/messages/playerChat.ts',
    operation: 'setDoc playerFriendLinks',
    replacement: 'POST /api/player/chat/friends/decline',
  });
  const headers = await getPlayerApiHeaders(true, {
    route: '/api/player/chat/friends/decline',
  });
  const cached = getCachedSessionUser();
  const response = await fetchChatApi(
    '/api/player/chat/friends/decline',
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ otherUid: cleanOtherUid }),
      cache: 'no-store',
    },
    {
      role: cached?.role ?? 'player',
      uid: cached?.uid ?? null,
      hasAppSessionId: Boolean(getLocalAppSessionId()),
      hasPlayerSessionId: Boolean(getLocalPlayerSessionId()),
      headersSent: Object.keys(headers),
    }
  );
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to decline friend request.');
  }
}

export async function cancelFriendRequest(otherUid: string) {
  const cleanOtherUid = cleanText(otherUid);
  if (!cleanOtherUid) {
    throw new Error('Player is required.');
  }
  if (!isClientSqlReadMode()) {
    throw new Error('Cancelling friend requests requires the SQL chat runtime.');
  }

  logClientFirebaseRuntimeRemoved({
    feature: 'player_chat_friend_cancel',
    file: 'features/messages/playerChat.ts',
    operation: 'setDoc playerFriendLinks',
    replacement: 'POST /api/player/chat/friends/cancel',
  });
  const headers = await getPlayerApiHeaders(true, {
    route: '/api/player/chat/friends/cancel',
  });
  const cached = getCachedSessionUser();
  const response = await fetchChatApi(
    '/api/player/chat/friends/cancel',
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ otherUid: cleanOtherUid }),
      cache: 'no-store',
    },
    {
      role: cached?.role ?? 'player',
      uid: cached?.uid ?? null,
      hasAppSessionId: Boolean(getLocalAppSessionId()),
      hasPlayerSessionId: Boolean(getLocalPlayerSessionId()),
      headersSent: Object.keys(headers),
    }
  );
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to cancel friend request.');
  }
}

export function listenFriendLinks(onNext: (links: FriendLink[]) => void) {
  if (
    shouldSkipClientFirestore({
      file: 'features/messages/playerChat.ts',
      feature: 'player_chat_friend_links',
      collection: 'playerFriendLinks',
      operation: 'onSnapshot',
    })
  ) {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let eventSource: EventSource | null = null;
    let pollInFlight = false;
    let refreshAfterPoll = false;
    const poll = async () => {
      if (cancelled) {
        return;
      }
      if (pollInFlight) {
        refreshAfterPoll = true;
        return;
      }
      pollInFlight = true;
      try {
        const headers = await getPlayerApiHeaders(false, {
          route: '/api/player/chat/friends',
        });
        const cached = getCachedSessionUser();
        const response = await fetchChatApi(
          '/api/player/chat/friends',
          {
            method: 'GET',
            headers,
            cache: 'no-store',
          },
          {
            role: cached?.role ?? 'player',
            uid: cached?.uid ?? null,
            hasAppSessionId: Boolean(getLocalAppSessionId()),
            hasPlayerSessionId: Boolean(getLocalPlayerSessionId()),
            headersSent: Object.keys(headers),
          }
        );
        const payload = (await response.json().catch(() => ({}))) as {
          links?: FriendLink[];
          error?: string;
        };
        if (!response.ok) {
          throw new Error(payload.error || 'Failed to load friend links.');
        }
        if (!cancelled) {
          onNext(
            (payload.links || [])
              .map((link) => ({
                id: cleanText(link.id),
                participants: Array.isArray(link.participants)
                  ? link.participants.map(cleanText).filter(Boolean)
                  : [],
                status: (link.status === 'accepted' ? 'accepted' : 'pending') as
                  | 'accepted'
                  | 'pending',
                requestedByUid: cleanText(link.requestedByUid),
                createdAt: link.createdAt || null,
                updatedAt: link.updatedAt || null,
                peer: link.peer?.uid
                  ? {
                      uid: cleanText(link.peer.uid),
                      avatarEmoji: cleanText(link.peer.avatarEmoji),
                      avatarName: cleanText(link.peer.avatarName) || 'Player',
                      gender: cleanText(String(link.peer.gender || '')).toLowerCase(),
                      bio: cleanText(link.peer.bio),
                      avatarImageUrl:
                        cleanText(String(link.peer.avatarImageUrl || '')) || null,
                      lastSeenAt: cleanText(String(link.peer.lastSeenAt || '')) || null,
                    }
                  : undefined,
              }))
              .filter((link) => link.id && link.participants.length === 2)
          );
        }
      } catch (error) {
        console.warn('[PLAYER_CHAT_FRIEND_LINKS_SQL_POLL_FAILED]', error);
        if (!cancelled) {
          onNext([]);
        }
      } finally {
        pollInFlight = false;
        if (!cancelled && refreshAfterPoll) {
          refreshAfterPoll = false;
          void poll();
        } else if (!cancelled) {
          timer = setTimeout(poll, 4000);
        }
      }
    };
    const refreshNow = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      void poll();
    };
    void poll();
    const selfUid = resolveListenerSelfUid();
    if (selfUid && typeof EventSource !== 'undefined') {
      const params = new URLSearchParams({
        channels: `user:${selfUid}:chat`,
        lastEventId: '0',
      });
      const appSessionId = cleanText(getLocalAppSessionId());
      if (appSessionId) {
        params.set('appSessionId', appSessionId);
      }
      const playerSessionId = cleanText(getLocalPlayerSessionId());
      if (playerSessionId) {
        params.set('playerSessionId', playerSessionId);
      }
      eventSource = new EventSource(`/api/live/stream?${params.toString()}`);
      const friendEvents = [
        'player_friend_request_created',
        'player_friend_request_accepted',
        'player_friend_request_declined',
        'player_friend_request_cancelled',
      ];
      friendEvents.forEach((eventName) => {
        eventSource?.addEventListener(eventName, refreshNow);
      });
    }
    return () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
      eventSource?.close();
    };
  }

  const selfUid = resolveListenerSelfUid();
  if (!selfUid) {
    onNext([]);
    return () => {};
  }
  const q = query(
    collection(db, 'playerFriendLinks'),
    where('participants', 'array-contains', selfUid),
    limit(500)
  );
  return onSnapshot(q, (snap) => {
    const links = snap.docs
      .map((d) => ({ id: d.id, ...(d.data() as Omit<FriendLink, 'id'>) }))
      .sort((a, b) => {
        const aMs = toMillis((a as unknown as { updatedAt?: unknown }).updatedAt);
        const bMs = toMillis((b as unknown as { updatedAt?: unknown }).updatedAt);
        return bMs - aMs;
      });
    onNext(links);
  });
}

export async function ensureReferralFriendLinks() {
  if (isClientSqlReadMode()) {
    return;
  }
  const selfUid = assertAuthUid();
  const referredSnap = await getDocs(
    query(collection(db, 'users'), where('role', '==', 'player'), where('referredByUid', '==', selfUid))
  );
  if (referredSnap.empty) return;

  const batch = writeBatch(db);
  referredSnap.docs.forEach((d) => {
    const otherUid = d.id;
    if (otherUid === selfUid) return;
    const ref = doc(db, 'playerFriendLinks', getFriendLinkId(selfUid, otherUid));
    batch.set(
      ref,
      {
        participants: [selfUid, otherUid],
        status: 'accepted',
        requestedByUid: selfUid,
        source: 'referral',
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  });
  await batch.commit();
}

export async function rewardCoinsToPlayer(
  targetUid: string,
  amountCoins: number,
  options?: { idempotencyKey?: string }
) {
  const MAX_REWARD_COINS_PER_TRANSFER = 50;
  const cached = getCachedSessionUser();
  const selfUid = cached?.uid || auth.currentUser?.uid || '';
  const hasSqlSession = Boolean(getLocalAppSessionId()) && Boolean(getLocalPlayerSessionId());
  if (!selfUid && !hasSqlSession) {
    throw new Error('Not authenticated.');
  }
  const cleanTargetUid = String(targetUid || '').trim();
  const cleanAmount = Math.max(0, Math.floor(Number(amountCoins || 0)));
  if (!cleanTargetUid) {
    throw new Error('Target player is required.');
  }
  if (cleanAmount <= 0) {
    throw new Error('Reward amount must be at least 1 coin.');
  }
  if (cleanAmount > MAX_REWARD_COINS_PER_TRANSFER) {
    throw new Error(`Maximum reward per transfer is ${MAX_REWARD_COINS_PER_TRANSFER} coins.`);
  }

  const headers = await getPlayerApiHeaders(false, { route: '/api/player/reward-coins' });
  const response = await fetchChatApi(
    '/api/player/reward-coins',
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        targetUid: cleanTargetUid,
        amountCoins: cleanAmount,
        idempotencyKey: cleanText(options?.idempotencyKey || ''),
      }),
    },
    {
      role: cached?.role ?? 'player',
      uid: selfUid || cached?.uid || null,
      hasAppSessionId: Boolean(getLocalAppSessionId()),
      hasPlayerSessionId: Boolean(getLocalPlayerSessionId()),
      headersSent: Object.keys(headers),
    }
  );

  const data = (await response.json()) as {
    error?: string;
    message?: string;
    amountCoins?: number;
    feeCoins?: number;
    recipientCoins?: number;
  };
  if (!response.ok) {
    if (response.status === 401) {
      throw new Error(data.error || 'Reward coins unauthorized.');
    }
    throw new Error(data.error || 'Failed to reward coins.');
  }

  const fallback = computeRewardCoinsAfterFee(cleanAmount);
  return {
    amountCoins: Math.max(0, Math.floor(Number(data.amountCoins ?? cleanAmount))),
    feeCoins: Math.max(0, Math.floor(Number(data.feeCoins ?? fallback.feeCoins))),
    recipientCoins: Math.max(
      0,
      Math.floor(Number(data.recipientCoins ?? fallback.recipientCoins))
    ),
    message: data.message || 'Coin reward sent.',
  };
}
