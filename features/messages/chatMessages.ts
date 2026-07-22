import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  increment,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  startAfter,
  where,
} from 'firebase/firestore';

import {
  attachSqlChatMessagesPoll,
  attachSqlUnreadCountsPoll,
  fetchSqlChatMessagesOlderThan,
  isChatSqlReadEnabled,
} from '@/features/live/chatSqlRead';
import {
  markConversationReadCacheBestEffort,
  mirrorChatMessageCacheBestEffort,
  mirrorConversationCacheBestEffort,
} from '@/features/messages/chatCacheMirror';
import { auth, db } from '@/lib/firebase/client';
import { uploadImageToCloudinary } from '@/lib/cloudinary/uploadImage';
import { chatMessageTtl } from '@/lib/firestore/ttl';
import {
  assertClientFirestoreDisabled,
  noopFirestoreUnsubscribe,
} from '@/lib/client/clientFirestoreGuard';
import {
  isSqlClientMigrationMode,
  logClientFirebaseRuntimeRemoved,
  logSqlClientMigration,
} from '@/lib/client/sqlClientMigration';
import { getCachedSessionUser } from '@/features/auth/sessionUser';
import { playerDebugLog } from '@/lib/client/playerDebugLogs';
import { getSqlApiReadHeaders } from '@/lib/client/sqlApiHeaders';
import { logClientFirestoreSkipped } from '@/lib/client/sqlReadMode';

export type FirestoreChatMessage = {
  id: string;
  text?: string;
  imageUrl?: string;
  imagePublicId?: string;
  type?: 'text' | 'image';
  senderUid: string;
  receiverUid: string;
  createdAt?: any;
  deletedForEveryone?: boolean;
  deletedFor?: string[];
};

export type DisplayChatMessage = {
  id: string;
  text?: string;
  imageUrl?: string;
  sender: 'admin' | 'user';
  timestamp: Date;
  deletedForEveryone?: boolean;
};

export function isChatMessageVisibleToViewer(
  message: FirestoreChatMessage,
  viewerUid: string
) {
  if (message.deletedForEveryone === true) {
    return true;
  }
  return !(Array.isArray(message.deletedFor) && message.deletedFor.includes(viewerUid));
}

export function filterVisibleChatMessagesForViewer(
  messages: FirestoreChatMessage[],
  viewerUid: string
) {
  return messages.filter((message) => isChatMessageVisibleToViewer(message, viewerUid));
}

export function mapFirestoreChatToDisplay(
  messages: FirestoreChatMessage[],
  viewerUid: string
): DisplayChatMessage[] {
  if (!viewerUid) {
    return [];
  }
  return filterVisibleChatMessagesForViewer(messages, viewerUid).map((msg) => ({
    id: msg.id,
    text: msg.deletedForEveryone ? 'Message deleted' : msg.text,
    imageUrl: msg.deletedForEveryone ? undefined : msg.imageUrl,
    sender: msg.senderUid === viewerUid ? 'admin' : 'user',
    timestamp: msg.createdAt?.toDate?.() || new Date(),
    deletedForEveryone: msg.deletedForEveryone,
  }));
}

export type UnreadConversationNotice = {
  uid: string;
  unreadCount: number;
  lastMessage?: string;
};

export function getConversationId(uid1: string, uid2: string) {
  return [uid1, uid2].sort().join('_');
}

/** Newest messages for the live window (realtime listener + pagination). */
export const CHAT_RECENT_MESSAGE_WINDOW = 50;
/** Player-facing messenger keeps the live UI intentionally lightweight. */
export const PLAYER_AGENT_CHAT_RECENT_MESSAGE_WINDOW = 7;
/** How many older messages to fetch per "Load previous" action. */
export const CHAT_OLDER_MESSAGE_PAGE_SIZE = 50;

async function sendChatMessageViaSql(receiverUid: string, text: string) {
  playerDebugLog('[PLAYER_MESSAGE_API_REQUEST]', {
    peerUid: receiverUid,
    textLength: text.length,
  });

  const response = await fetch('/api/chat/messages', {
    method: 'POST',
    headers: await getSqlApiReadHeaders(true),
    body: JSON.stringify({
      peerUid: receiverUid,
      type: 'text',
      text,
    }),
    cache: 'no-store',
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    messageId?: string;
    conversationId?: string;
  };
  if (!response.ok) {
    console.error('[PLAYER_MESSAGE_API_ERROR]', {
      peerUid: receiverUid,
      status: response.status,
      error: payload.error || null,
    });
    throw new Error(payload.error || 'Failed to send chat message.');
  }

  playerDebugLog('[PLAYER_MESSAGE_API_SUCCESS]', {
    peerUid: receiverUid,
    messageId: payload.messageId || null,
    conversationId: payload.conversationId || null,
  });

  logSqlClientMigration({
    feature: 'chat_send_text',
    oldFirebaseOperation: 'setDoc+addDoc',
    newSqlRoute: '/api/chat/messages',
    result: 'ok',
    fallbackUsed: false,
  });
}

export async function sendChatMessage(receiverUid: string, text: string) {
  const messageText = text.trim();
  if (!messageText) {
    return;
  }

  if (isChatSqlReadEnabled() || isSqlClientMigrationMode()) {
    logClientFirebaseRuntimeRemoved({
      feature: 'chat_send_text',
      file: 'features/messages/chatMessages.ts',
      operation: 'setDoc+addDoc',
      replacement: 'POST /api/chat/messages',
    });
    await sendChatMessageViaSql(receiverUid, messageText);
    return;
  }

  const currentUser = auth.currentUser;

  if (!currentUser) {
    throw new Error('Not authenticated.');
  }

  const cleanText = messageText;
  const conversationId = getConversationId(currentUser.uid, receiverUid);
  const conversationRef = doc(db, 'conversations', conversationId);

  const unreadCounts = {
    [receiverUid]: increment(1),
    [currentUser.uid]: 0,
  };

  await setDoc(
    conversationRef,
    {
      participants: [currentUser.uid, receiverUid],
      lastMessage: cleanText,
      lastMessageSenderUid: currentUser.uid,
      updatedAt: serverTimestamp(),
      unreadCounts,
    },
    { merge: true }
  );

  const messageRef = await addDoc(collection(db, 'conversations', conversationId, 'messages'), {
    type: 'text',
    text: cleanText,
    senderUid: currentUser.uid,
    receiverUid,
    createdAt: serverTimestamp(),
    ttlExpiresAt: chatMessageTtl(),
  });

  void mirrorConversationCacheBestEffort({
    conversationId,
    participants: [currentUser.uid, receiverUid],
    lastMessage: cleanText,
    lastMessageSenderUid: currentUser.uid,
    unreadCounts: { [receiverUid]: 1, [currentUser.uid]: 0 },
  });
  void mirrorChatMessageCacheBestEffort({
    conversationId,
    messageId: messageRef.id,
    type: 'text',
    text: cleanText,
    senderUid: currentUser.uid,
    receiverUid,
  });
}

export async function sendImageMessage(receiverUid: string, file: File) {
  if (isChatSqlReadEnabled() || isSqlClientMigrationMode()) {
    logClientFirebaseRuntimeRemoved({
      feature: 'chat_send_image',
      file: 'features/messages/chatMessages.ts',
      operation: 'setDoc+addDoc',
      replacement: 'POST /api/chat/messages',
    });
    throw new Error('Image chat not ready.');
  }

  const currentUser = auth.currentUser;

  if (!currentUser) {
    throw new Error('Not authenticated.');
  }

  if (!file.type.startsWith('image/')) {
    throw new Error('Only image files are allowed.');
  }

  const maxSizeMb = 5;
  const maxSizeBytes = maxSizeMb * 1024 * 1024;

  if (file.size > maxSizeBytes) {
    throw new Error(`Image must be smaller than ${maxSizeMb}MB.`);
  }

  const conversationId = getConversationId(currentUser.uid, receiverUid);
  const uploaded = await uploadImageToCloudinary(file);

  const conversationRef = doc(db, 'conversations', conversationId);

  await setDoc(
    conversationRef,
    {
      participants: [currentUser.uid, receiverUid],
      lastMessage: '📷 Photo',
      lastMessageSenderUid: currentUser.uid,
      updatedAt: serverTimestamp(),
      unreadCounts: {
        [receiverUid]: increment(1),
        [currentUser.uid]: 0,
      },
    },
    { merge: true }
  );

  const messageRef = await addDoc(collection(db, 'conversations', conversationId, 'messages'), {
    type: 'image',
    imageUrl: uploaded.url,
    imagePublicId: uploaded.publicId,
    senderUid: currentUser.uid,
    receiverUid,
    createdAt: serverTimestamp(),
    ttlExpiresAt: chatMessageTtl(),
  });

  void mirrorConversationCacheBestEffort({
    conversationId,
    participants: [currentUser.uid, receiverUid],
    lastMessage: '📷 Photo',
    lastMessageSenderUid: currentUser.uid,
    unreadCounts: { [receiverUid]: 1, [currentUser.uid]: 0 },
  });
  void mirrorChatMessageCacheBestEffort({
    conversationId,
    messageId: messageRef.id,
    type: 'image',
    imageUrl: uploaded.url,
    imagePublicId: uploaded.publicId,
    senderUid: currentUser.uid,
    receiverUid,
  });
}

function compareChatMessagesChronological(
  a: FirestoreChatMessage,
  b: FirestoreChatMessage
) {
  const ta = a.createdAt?.toMillis?.() ?? a.createdAt?.toDate?.()?.getTime?.() ?? 0;
  const tb = b.createdAt?.toMillis?.() ?? b.createdAt?.toDate?.()?.getTime?.() ?? 0;
  if (ta !== tb) {
    return ta - tb;
  }
  return a.id.localeCompare(b.id);
}

export type ListenToMessagesOptions = {
  /**
   * Max recent messages to keep in the live snapshot (newest only).
   * Omit or set very high to mirror legacy “load all” (not recommended).
   */
  limit?: number;
  requirePlayerRole?: boolean;
};

/**
 * Listens to the newest slice of a conversation in realtime (default last 50).
 * Older messages are loaded via `fetchMessagesOlderThan`.
 */
export function listenToMessages(
  receiverUid: string,
  callback: (messages: FirestoreChatMessage[]) => void,
  options?: ListenToMessagesOptions
) {
  if (isChatSqlReadEnabled()) {
    return attachSqlChatMessagesPoll(receiverUid, callback, options, undefined);
  }

  if (assertClientFirestoreDisabled('chat_messages_listener', 'onSnapshot')) {
    callback([]);
    return noopFirestoreUnsubscribe();
  }

  const currentUser = auth.currentUser;

  if (!currentUser) {
    callback([]);
    return () => {};
  }

  const conversationId = getConversationId(currentUser.uid, receiverUid);
  const collectionRef = collection(
    db,
    'conversations',
    conversationId,
    'messages'
  );
  const windowLimit = options?.limit;

  const messagesQuery =
    windowLimit == null
      ? query(collectionRef, orderBy('createdAt', 'asc'))
      : query(
          collectionRef,
          orderBy('createdAt', 'desc'),
          limit(Math.max(1, windowLimit))
        );

  return onSnapshot(messagesQuery, (snapshot) => {
    const messages = snapshot.docs.map((docSnap) => ({
      id: docSnap.id,
      ...(docSnap.data() as Omit<FirestoreChatMessage, 'id'>),
    }));

    if (windowLimit == null) {
      messages.sort(compareChatMessagesChronological);
    } else {
      messages.reverse();
    }

    callback(messages);
  });
}

/**
 * Fetches messages older than a given message (the chronologically first one currently shown).
 * Returns messages sorted ascending (oldest first in the batch).
 */
export async function fetchMessagesOlderThan(
  receiverUid: string,
  olderThanMessageId: string,
  pageSize: number = CHAT_OLDER_MESSAGE_PAGE_SIZE
): Promise<FirestoreChatMessage[]> {
  if (isChatSqlReadEnabled()) {
    logClientFirestoreSkipped('chat_messages_older_than', { receiverUid });
    return fetchSqlChatMessagesOlderThan(receiverUid, olderThanMessageId, pageSize, {
      preferStaffSession: true,
    });
  }

  const currentUser = auth.currentUser;

  if (!currentUser) {
    return [];
  }

  const conversationId = getConversationId(currentUser.uid, receiverUid);
  const collectionRef = collection(
    db,
    'conversations',
    conversationId,
    'messages'
  );
  const cursorRef = doc(
    db,
    'conversations',
    conversationId,
    'messages',
    olderThanMessageId
  );
  const cursorSnap = await getDoc(cursorRef);

  if (!cursorSnap.exists()) {
    return [];
  }

  const size = Math.max(1, pageSize);
  const olderQuery = query(
    collectionRef,
    orderBy('createdAt', 'desc'),
    startAfter(cursorSnap),
    limit(size)
  );

  const snap = await getDocs(olderQuery);
  const batch = snap.docs.map((d) => ({
    id: d.id,
    ...(d.data() as Omit<FirestoreChatMessage, 'id'>),
  }));
  batch.reverse();
  return batch;
}

export async function markConversationAsRead(
  receiverUid: string,
  options?: { requirePersist?: boolean }
) {
  const cached = getCachedSessionUser();
  const currentUserUid = cached?.uid || auth.currentUser?.uid;

  if (!currentUserUid) {
    return;
  }

  const conversationId = getConversationId(currentUserUid, receiverUid);

  if (isChatSqlReadEnabled()) {
    await markConversationReadCacheBestEffort(conversationId, currentUserUid, {
      requireSuccess: options?.requirePersist,
    });
    return;
  }

  const currentUser = auth.currentUser;

  if (!currentUser) {
    return;
  }

  await setDoc(
    doc(db, 'conversations', conversationId),
    {
      unreadCounts: {
        [currentUser.uid]: 0,
      },
    },
    { merge: true }
  );

  void markConversationReadCacheBestEffort(conversationId, currentUser.uid);
}

export function listenToUnreadCounts(
  callback: (unreadCounts: Record<string, number>) => void,
  options?: { requirePlayerRole?: boolean }
) {
  if (isChatSqlReadEnabled()) {
    return attachSqlUnreadCountsPoll(callback, undefined, options);
  }

  if (assertClientFirestoreDisabled('chat_unread_counts_listener', 'onSnapshot')) {
    callback({});
    return noopFirestoreUnsubscribe();
  }

  const currentUser = auth.currentUser;

  if (!currentUser) {
    callback({});
    return () => {};
  }

  const conversationsQuery = query(
    collection(db, 'conversations'),
    where(`unreadCounts.${currentUser.uid}`, '>', 0)
  );

  return onSnapshot(conversationsQuery, (snapshot) => {
    const counts: Record<string, number> = {};

    snapshot.docs.forEach((docSnap) => {
      const data = docSnap.data() as any;

      const otherUid = data.participants?.find(
        (uid: string) => uid !== currentUser.uid
      );

      if (!otherUid) {
        return;
      }

      counts[otherUid] = data.unreadCounts?.[currentUser.uid] || 0;
    });

    callback(counts);
  });
}

export function listenToUnreadNotices(
  callback: (notices: UnreadConversationNotice[]) => void
) {
  if (isChatSqlReadEnabled()) {
    return attachSqlUnreadCountsPoll((counts) => {
      callback(
        Object.entries(counts).map(([uid, unreadCount]) => ({
          uid,
          unreadCount,
          lastMessage: '',
        }))
      );
    });
  }

  const currentUser = auth.currentUser;

  if (!currentUser) {
    callback([]);
    return () => {};
  }

  const conversationsQuery = query(
    collection(db, 'conversations'),
    where(`unreadCounts.${currentUser.uid}`, '>', 0)
  );

  return onSnapshot(conversationsQuery, (snapshot) => {
    const notices: UnreadConversationNotice[] = [];

    snapshot.docs.forEach((docSnap) => {
      const data = docSnap.data() as any;

      const unreadCount = data.unreadCounts?.[currentUser.uid] || 0;

      if (unreadCount <= 0) {
        return;
      }

      const otherUid = data.participants?.find(
        (uid: string) => uid !== currentUser.uid
      );

      if (!otherUid) {
        return;
      }

      notices.push({
        uid: otherUid,
        unreadCount,
        lastMessage: data.lastMessage || '',
      });
    });

    callback(notices);
  });
}
