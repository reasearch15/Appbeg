'use client';
import { playerDebugLog } from '@/lib/client/playerDebugLogs';

import '@/styles/player-fire.css';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { getLocalAppSessionId } from '@/features/auth/appSession';
import { getLocalPlayerSessionId } from '@/features/auth/playerSession';
import { getCachedSessionUser, getSessionUserOnce } from '@/features/auth/sessionUser';
import { computeRewardCoinsAfterFee } from '@/lib/rewardCoinTransferFee';
import { logChatPageMount } from '@/lib/client/chatLogoutDiagnostics';
import { shouldSkipClientFirestore } from '@/lib/client/clientFirestoreGuard';
import { useIsPlayerSessionRole } from '@/features/player/useIsPlayerSessionRole';
import { usePresenceOnlineMap } from '@/features/presence/userPresence';
import {
  clearStaleRoleThemeStorage,
  installPlayerThemeAudioGuard,
  stopWrongPlayerRouteThemeAudio,
} from '@/lib/client/playerThemeAudioGuard';
import { CASINO_BACKGROUND_TRACKS } from '../constants';
import {
  acceptFriendRequest,
  activateMyPlayerChatProfile,
  cancelFriendRequest,
  deleteDirectMessageForEveryone,
  deleteDirectMessageForMe,
  deactivateMyPlayerChatProfile,
  declineFriendRequest,
  ensureReferralFriendLinks,
  fetchPlayerChatBootstrap,
  filterVisibleDirectMessages,
  FriendLink,
  getMyPlayerChatProfile,
  listenDirectChatList,
  listenFriendLinks,
  listenDirectMessages,
  listenDirectTyping,
  markDirectConversationSeen,
  PlayerChatMessage,
  PlayerChatProfile,
  PlayerPeer,
  searchDirectMessages,
  sendFriendRequest,
  sendFriendRequestByReferralCode,
  rewardCoinsToPlayer,
  sendDirectImageMessage,
  sendDirectTextMessage,
  setDirectConversationMuted,
  setDirectTyping,
  updateMyPlayerChatProfile,
  PLAYER_CHAT_RENDER_LIMIT,
} from '@/features/messages/playerChat';
import { uploadSignedPlayerChatImage } from '@/features/messages/playerChatPhotoUpload';
import { markPlayerChatThreadRead, type PlayerChatReadType } from '@/features/messages/playerChatRead';

const PLAYER_CHAT_RENDER_MAX = 10;
const PLAYER_CHAT_PHOTO_MAX_BYTES = 5 * 1024 * 1024;
const PLAYER_CHAT_PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const PLAYER_CHAT_AVATAR_GROUPS = [
  { label: 'Faces', values: ['😀', '😎', '😇', '🥳', '🤠', '😈', '👽', '🤖', '🐵'] },
  {
    label: 'People',
    values: ['👨', '👩', '🧑', '👦', '👧', '👱‍♂️', '👱‍♀️', '🧔', '👸', '🤴', '🧙‍♂️', '🧙‍♀️', '🦸‍♂️', '🦸‍♀️'],
  },
  {
    label: 'Animals',
    values: ['🐶', '🐱', '🦊', '🐻', '🐼', '🐯', '🦁', '🐸', '🐵', '🐰', '🐺', '🐨', '🐮', '🐷', '🐲', '🦄'],
  },
];

function trimRenderedPlayerMessages(messages: PlayerChatMessage[]) {
  return messages.slice(-PLAYER_CHAT_RENDER_LIMIT);
}

function logChatMessageLimitApplied(beforeCount: number, afterCount: number) {
  if (process.env.NODE_ENV !== 'development' || beforeCount <= afterCount) {
    return;
  }
  console.info('[CHAT_MESSAGE_LIMIT_APPLIED]', {
    chatType: 'player_player',
    beforeCount,
    afterCount,
    limit: PLAYER_CHAT_RENDER_LIMIT,
  });
}

function isNearScrollBottom(el: HTMLElement | null, threshold = 80) {
  if (!el) {
    return true;
  }
  return el.scrollTop + el.clientHeight >= el.scrollHeight - threshold;
}

function scrollMessageListToBottom(
  scrollEl: HTMLElement | null,
  bottomEl: HTMLElement | null,
  behavior: ScrollBehavior = 'auto'
) {
  if (!scrollEl) {
    bottomEl?.scrollIntoView({ behavior, block: 'end' });
    return;
  }
  scrollEl.scrollTop = scrollEl.scrollHeight;
  bottomEl?.scrollIntoView({ behavior, block: 'end' });
}

function toTime(value: Date | { toMillis?: () => number; toDate?: () => Date; seconds?: number } | null | undefined) {
  const ms =
    value instanceof Date
      ? value.getTime()
      : value?.toMillis?.() ?? value?.toDate?.()?.getTime?.() ?? (value?.seconds ? value.seconds * 1000 : 0);
  if (!ms) return '';
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function timestampLikeFromIso(value: string | null | undefined) {
  const date = value ? new Date(value) : new Date();
  const ms = Number.isNaN(date.getTime()) ? Date.now() : date.getTime();
  return new Date(ms);
}

function createIdempotencyKey() {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function validatePhotoFile(file: File) {
  if (!PLAYER_CHAT_PHOTO_TYPES.has(file.type)) {
    return 'Only JPG, PNG, or WEBP images are allowed.';
  }
  if (!Number.isFinite(file.size) || file.size <= 0 || file.size > PLAYER_CHAT_PHOTO_MAX_BYTES) {
    return 'Photo must be 5MB or smaller.';
  }
  return '';
}

function normalizeGender(value: string | null | undefined) {
  const gender = String(value || '').trim().toLowerCase();
  return gender === 'male' || gender === 'female' ? gender : '';
}

function isCompletePlayerChatProfile(profile: PlayerChatProfile | null) {
  return Boolean(
    profile?.isActive &&
      profile.avatarEmoji.trim() &&
      profile.avatarName.trim() &&
      normalizeGender(profile.gender) &&
      profile.bio.trim()
  );
}

export default function PlayerChatPage() {
  const isPlayerRole = useIsPlayerSessionRole();
  const mountLoggedRef = useRef(false);
  const [allPlayers, setAllPlayers] = useState<PlayerPeer[]>([]);
  const [selectedPeer, setSelectedPeer] = useState<PlayerPeer | null>(null);
  const [messages, setMessages] = useState<PlayerChatMessage[]>([]);
  const [rawMessageCount, setRawMessageCount] = useState(0);
  const [typing, setTyping] = useState(false);
  const [newMessage, setNewMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [messageError, setMessageError] = useState('');
  const [messageNotice, setMessageNotice] = useState('');
  const [photoStatus, setPhotoStatus] = useState('');
  const [replyTarget, setReplyTarget] = useState<PlayerChatMessage | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [playerSearchTerm, setPlayerSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState<PlayerChatMessage[]>([]);
  const [showRewardPanel, setShowRewardPanel] = useState(false);
  const [rewardAmount, setRewardAmount] = useState('10');
  const [rewardBusy, setRewardBusy] = useState(false);
  const [rewardNotice, setRewardNotice] = useState('');
  const rewardRequestIdRef = useRef<string | null>(null);
  const rewardInFlightRef = useRef(false);
  const [chatList, setChatList] = useState<Record<string, { unread: number; muted: boolean; last: string }>>({});
  const [friendByUid, setFriendByUid] = useState<
    Record<
      string,
      { status: 'pending' | 'accepted'; requestedByUid: string; peer?: PlayerPeer }
    >
  >({});
  const [friendActionUid, setFriendActionUid] = useState('');
  const [friendError, setFriendError] = useState('');
  const [friendNotice, setFriendNotice] = useState('');
  const [showAddByReferralModal, setShowAddByReferralModal] = useState(false);
  const [referralInput, setReferralInput] = useState('');
  const [referralLoading, setReferralLoading] = useState(false);
  const [referralError, setReferralError] = useState('');
  const [referralNotice, setReferralNotice] = useState('');
  const [selfUid, setSelfUid] = useState('');
  const [chatLoading, setChatLoading] = useState(true);
  const [chatLoadError, setChatLoadError] = useState('');
  const messagesScrollRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const nearBottomRef = useRef(true);
  const pendingScrollToBottomRef = useRef(false);
  const [showNewMessagePill, setShowNewMessagePill] = useState(false);
  const [failedDraft, setFailedDraft] = useState('');
  const [failedDraftIdempotencyKey, setFailedDraftIdempotencyKey] = useState('');
  const [chatProfile, setChatProfile] = useState<PlayerChatProfile | null>(null);
  const [profileDraftAvatarEmoji, setProfileDraftAvatarEmoji] = useState('');
  const [profileDraftName, setProfileDraftName] = useState('');
  const [profileDraftGender, setProfileDraftGender] = useState('');
  const [profileDraftBio, setProfileDraftBio] = useState('');
  const [profileLoading, setProfileLoading] = useState(true);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileEditing, setProfileEditing] = useState(false);
  const [profileError, setProfileError] = useState('');
  const [profileNotice, setProfileNotice] = useState('');
  const chatReadInFlightRef = useRef<Set<string>>(new Set());
  const lastChatReadClearAtRef = useRef<Record<string, number>>({});
  const lastRenderedReadThreadRef = useRef('');

  useEffect(() => {
    installPlayerThemeAudioGuard(CASINO_BACKGROUND_TRACKS);
    clearStaleRoleThemeStorage();
    stopWrongPlayerRouteThemeAudio(CASINO_BACKGROUND_TRACKS);

    return () => {
      stopWrongPlayerRouteThemeAudio(CASINO_BACKGROUND_TRACKS);
    };
  }, []);

  const markThreadReadOnPlayerChatFocus = useCallback(
    (
      threadId: string | null | undefined,
      chatType: PlayerChatReadType,
      trigger: 'open' | 'input' = 'input'
    ) => {
      const cleanThreadId = String(threadId || '').trim();
      if (!cleanThreadId) {
        playerDebugLog('[PLAYER_CHAT_READ] skippedNoThread', { chatType });
        return;
      }

      const dedupeKey = `${chatType}:${cleanThreadId}`;
      const now = Date.now();
      if (chatReadInFlightRef.current.has(dedupeKey)) {
        playerDebugLog('[PLAYER_CHAT_READ] debounced', { chatType, threadId: cleanThreadId, reason: 'in_flight' });
        return;
      }
      if (now - (lastChatReadClearAtRef.current[dedupeKey] || 0) < 10000) {
        playerDebugLog('[PLAYER_CHAT_READ] debounced', { chatType, threadId: cleanThreadId, reason: 'recent' });
        return;
      }
      lastChatReadClearAtRef.current[dedupeKey] = now;

      playerDebugLog(
        trigger === 'open'
          ? '[PLAYER_CHAT_READ] openThreadClearUnread'
          : '[PLAYER_CHAT_READ] inputFocusClearUnread',
        {
        chatType,
        threadId: cleanThreadId,
        playerUid: selfUid || getCachedSessionUser()?.uid || null,
        }
      );
      setChatList((previous) => {
        const current = previous[cleanThreadId];
        if (!current?.unread) {
          return previous;
        }
        playerDebugLog('[PLAYER_CHAT_READ] optimisticClear', {
          chatType,
          threadId: cleanThreadId,
        });
        return {
          ...previous,
          [cleanThreadId]: {
            ...current,
            unread: 0,
          },
        };
      });

      chatReadInFlightRef.current.add(dedupeKey);
      void markPlayerChatThreadRead(cleanThreadId, chatType)
        .then((payload) => {
          playerDebugLog('[PLAYER_CHAT_READ] persisted', {
            chatType,
            threadId: cleanThreadId,
            conversationId: payload.conversationId || null,
            unreadCount: payload.unreadCount ?? null,
          });
        })
        .catch((error) => {
          console.warn('[PLAYER_CHAT_READ] persisted', {
            chatType,
            threadId: cleanThreadId,
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          chatReadInFlightRef.current.delete(dedupeKey);
        });
    },
    [selfUid]
  );

  useEffect(() => {
    if (!isPlayerRole) {
      setSelfUid('');
      return;
    }
    let cancelled = false;
    void (async () => {
      const cached = getCachedSessionUser();
      const sessionUser =
        cached?.role === 'player'
          ? cached
          : await getSessionUserOnce().catch(() => null);
      if (cancelled) {
        return;
      }
      if (sessionUser?.role === 'player' && sessionUser.uid) {
        setSelfUid(sessionUser.uid);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isPlayerRole]);

  useEffect(() => {
    if (mountLoggedRef.current) {
      return;
    }
    mountLoggedRef.current = true;

    void (async () => {
      const cached = getCachedSessionUser();
      const sessionUser =
        cached?.role === 'player'
          ? cached
          : await getSessionUserOnce().catch(() => null);
      const appSessionId = getLocalAppSessionId();
      const playerSessionId = getLocalPlayerSessionId();
      logChatPageMount({
        role: sessionUser?.role ?? cached?.role ?? null,
        uid: sessionUser?.uid ?? cached?.uid ?? null,
        hasAppSessionId: Boolean(appSessionId),
        hasPlayerSessionId: Boolean(playerSessionId),
        appSessionIdPrefix: appSessionId ? appSessionId.slice(0, 8) : null,
        playerSessionIdPrefix: playerSessionId ? playerSessionId.slice(0, 8) : null,
      });
    })();
  }, []);

  useEffect(() => {
    if (!isPlayerRole) {
      setAllPlayers([]);
      setChatLoading(false);
      return;
    }

    let cancelled = false;

    const loadSqlPlayers = async () => {
      setChatLoading(true);
      setChatLoadError('');
      try {
        const players = await fetchPlayerChatBootstrap(playerSearchTerm);
        if (!cancelled) {
          setAllPlayers(players);
        }
      } catch (error) {
        if (!cancelled) {
          setAllPlayers([]);
          setChatLoadError(error instanceof Error ? error.message : 'Failed to load player chat.');
        }
      } finally {
        if (!cancelled) {
          setChatLoading(false);
        }
      }
    };

    const skipFirestore = shouldSkipClientFirestore({
      file: 'app/player/chat/page.tsx',
      feature: 'player_chat_active_players_list',
      collection: 'users',
      operation: 'onSnapshot',
    });

    if (skipFirestore) {
      void loadSqlPlayers();
      return () => {
        cancelled = true;
      };
    }

    void ensureReferralFriendLinks();
    setChatLoading(false);
    return () => {
      cancelled = true;
    };
  }, [isPlayerRole, selfUid, playerSearchTerm]);

  useEffect(() => {
    if (!isPlayerRole) {
      return;
    }

    let cancelled = false;
    const loadProfile = async () => {
      setProfileLoading(true);
      setProfileError('');
      try {
        const profile = await getMyPlayerChatProfile();
        if (cancelled) return;
        setChatProfile(profile);
        setProfileDraftAvatarEmoji(profile.avatarEmoji);
        setProfileDraftName(profile.avatarName);
        setProfileDraftGender(normalizeGender(profile.gender));
        setProfileDraftBio(profile.bio);
        setProfileEditing(!isCompletePlayerChatProfile(profile));
      } catch (error) {
        if (cancelled) return;
        setChatProfile(null);
        setProfileError(
          error instanceof Error ? error.message : 'Failed to load Player Chat profile.'
        );
      } finally {
        if (!cancelled) {
          setProfileLoading(false);
        }
      }
    };
    void loadProfile();

    return () => {
      cancelled = true;
    };
  }, [isPlayerRole]);

  const onlineByUid = usePresenceOnlineMap(allPlayers.map((p) => p.uid), {
    requirePlayerRole: true,
  });

  useEffect(() => {
    if (!isPlayerRole) {
      return;
    }
    return listenDirectChatList((rows) => {
      const next: Record<string, { unread: number; muted: boolean; last: string }> = {};
      rows.forEach((row) => {
        next[row.otherUid] = {
          unread: row.unreadCount,
          muted: row.muted,
          last: row.lastMessage,
        };
      });
      playerDebugLog('[PLAYER_CHAT_READ] refreshReadStateLoaded', {
        threadCount: Object.keys(next).length,
      });
      setChatList(next);
    });
  }, [isPlayerRole]);

  useEffect(() => {
    if (!isPlayerRole) {
      return;
    }
    return listenFriendLinks((links: FriendLink[]) => {
      const next: Record<
        string,
        { status: 'pending' | 'accepted'; requestedByUid: string; peer?: PlayerPeer }
      > = {};
      links.forEach((link) => {
        const otherUid = (link.participants || []).find((uid) => uid !== selfUid) || '';
        if (!otherUid) return;
        next[otherUid] = {
          status: link.status,
          requestedByUid: link.requestedByUid,
          peer: link.peer,
        };
      });
      setFriendByUid(next);
    });
  }, [isPlayerRole, selfUid]);

  useEffect(() => {
    if (!isPlayerRole || !selectedPeer) return;
    const unsubMessages = listenDirectMessages(selectedPeer.uid, (list) => {
      const visible = filterVisibleDirectMessages(list, selfUid);
      const rendered = trimRenderedPlayerMessages(visible);
      logChatMessageLimitApplied(visible.length, rendered.length);
      setRawMessageCount(list.length);
      if (nearBottomRef.current) {
        pendingScrollToBottomRef.current = true;
      } else {
        setShowNewMessagePill(true);
      }
      setMessages(rendered);
      console.info('[CHAT_MESSAGES_FILTERED]', {
        conversationId: [selfUid, selectedPeer.uid].sort().join('__'),
        currentUid: selfUid,
        participantIds: [selfUid, selectedPeer.uid],
        totalMessages: list.length,
        visibleMessages: visible.length,
        renderedMessages: rendered.length,
        messageIds: list.slice(0, 5).map((message) => message.id),
        visibleMessageIds: visible.slice(0, 5).map((message) => message.id),
        messages: list.slice(0, 5).map((message) => ({
          id: message.id,
          senderUid: message.senderUid,
          text: message.text,
          deletedForAll: message.deletedForEveryone,
          deletedForUsers: message.deletedFor,
          createdAt: message.createdAt?.toISOString?.() || null,
        })),
      });
      console.info('[CHAT_DELETE_UI_REFRESH]', {
        reason: 'live_messages_refresh',
        peerUid: selectedPeer.uid,
        visibleCount: rendered.length,
        rawCount: list.length,
      });
    });
    const unsubTyping = listenDirectTyping(selectedPeer.uid, setTyping);
    return () => {
      unsubMessages();
      unsubTyping();
      void setDirectTyping(selectedPeer.uid, false);
    };
  }, [isPlayerRole, markThreadReadOnPlayerChatFocus, selectedPeer, selfUid]);

  useEffect(() => {
    setShowRewardPanel(false);
    setRewardNotice('');
    setShowNewMessagePill(false);
    nearBottomRef.current = true;
    pendingScrollToBottomRef.current = true;
    lastRenderedReadThreadRef.current = '';
  }, [selectedPeer?.uid]);

  const rewardFeePreview = useMemo(() => {
    const amt = Math.max(0, Math.floor(Number(rewardAmount || 0)));
    if (!amt) return null;
    return computeRewardCoinsAfterFee(amt);
  }, [rewardAmount]);

  const selectedMuted = selectedPeer ? Boolean(chatList[selectedPeer.uid]?.muted) : false;
  const selectedFriend = selectedPeer ? friendByUid[selectedPeer.uid] : null;
  const selectedPeerDisplayName = selectedPeer ? selectedPeer.avatarName : '';
  const chatProfileComplete = isCompletePlayerChatProfile(chatProfile);
  const filteredPlayers = useMemo(() => {
    const term = playerSearchTerm.trim().toLowerCase();
    if (!term) {
      return allPlayers;
    }
    return allPlayers.filter(
      (p) =>
        p.avatarName.toLowerCase().includes(term) ||
        p.bio.toLowerCase().includes(term)
    );
  }, [allPlayers, playerSearchTerm]);
  const pendingFriendRequests = useMemo(
    () =>
      Object.entries(friendByUid).flatMap(([uid, link]) => {
        if (link.status !== 'pending') {
          return [];
        }
        const player = allPlayers.find((candidate) => candidate.uid === uid) || link.peer;
        if (!player) {
          return [];
        }
        return [{
          player,
          direction: link.requestedByUid === selfUid ? 'sent' as const : 'received' as const,
        }];
      }),
    [allPlayers, friendByUid, selfUid]
  );
  const messagesHiddenByFilters = rawMessageCount > 0 && messages.length === 0;

  useLayoutEffect(() => {
    if (!selectedPeer) return;
    if (pendingScrollToBottomRef.current) {
      pendingScrollToBottomRef.current = false;
      scrollMessageListToBottom(messagesScrollRef.current, messagesEndRef.current, 'auto');
      setShowNewMessagePill(false);
      nearBottomRef.current = true;
    }
    const el = messagesScrollRef.current;
    if (process.env.NODE_ENV === 'development' && el) {
      console.info('[CHAT_RENDER_STATE]', {
        chatType: 'player_player',
        messageCount: rawMessageCount,
        renderedCount: messages.length,
        containerHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
        isOverflowing: el.scrollHeight > el.clientHeight,
      });
    }
    console.info('[CHAT_MESSAGES_RENDER]', {
      conversationId: [selfUid, selectedPeer.uid].sort().join('__'),
      currentUid: selfUid,
      participantIds: [selfUid, selectedPeer.uid],
      totalMessages: rawMessageCount,
      visibleMessages: messages.length,
      messageIds: messages.slice(0, 5).map((message) => message.id),
    });
  }, [messages, rawMessageCount, selectedPeer, selfUid]);

  useEffect(() => {
    if (!selectedPeer || messages.length === 0) {
      return;
    }
    const lastMessageId = messages[messages.length - 1]?.id || '';
    const readKey = `${selectedPeer.uid}:${lastMessageId}`;
    if (lastRenderedReadThreadRef.current === readKey) {
      return;
    }
    lastRenderedReadThreadRef.current = readKey;
    const frameId = window.requestAnimationFrame(() => {
      markThreadReadOnPlayerChatFocus(selectedPeer.uid, 'player_player', 'open');
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [markThreadReadOnPlayerChatFocus, messages, selectedPeer]);

  async function onSend(e: React.FormEvent) {
    e.preventDefault();
    await sendCurrentTextMessage(newMessage);
  }

  async function sendCurrentTextMessage(value: string, retryIdempotencyKey = '') {
    if (!selectedPeer || sending) return;
    const body = value.trim();
    if (!body) return;
    const messageIdempotencyKey = retryIdempotencyKey || createIdempotencyKey();
    setSending(true);
    setMessageError('');
    setMessageNotice('');
    setFailedDraft('');
    setFailedDraftIdempotencyKey('');
    try {
      await sendDirectTextMessage(selectedPeer.uid, body, {
        replyToMessageId: replyTarget?.id || '',
        replyToText: replyTarget?.text || '',
        idempotencyKey: messageIdempotencyKey,
      });
      setNewMessage('');
      setReplyTarget(null);
      pendingScrollToBottomRef.current = true;
      nearBottomRef.current = true;
      setShowNewMessagePill(false);
      await markDirectConversationSeen(selectedPeer.uid);
    } catch (error) {
      setFailedDraft(body);
      setFailedDraftIdempotencyKey(messageIdempotencyKey);
      setMessageError(error instanceof Error ? error.message : 'Failed to send message.');
    } finally {
      setSending(false);
    }
  }

  async function onSendImage(file: File) {
    if (!selectedPeer || sending) return;
    const validation = validatePhotoFile(file);
    if (validation) {
      setMessageError(validation);
      setMessageNotice('');
      setPhotoStatus('');
      return;
    }
    const photoIdempotencyKey = createIdempotencyKey();
    setSending(true);
    setMessageError('');
    setMessageNotice('');
    setPhotoStatus('Uploading photo...');
    try {
      const uploaded = await uploadSignedPlayerChatImage(file);
      setPhotoStatus('Sending photo...');
      const result = await sendDirectImageMessage(selectedPeer.uid, file, {
        replyToMessageId: replyTarget?.id || '',
        replyToText: replyTarget?.text || '',
        idempotencyKey: photoIdempotencyKey,
        uploadedImage: uploaded,
      });
      setReplyTarget(null);
      pendingScrollToBottomRef.current = true;
      nearBottomRef.current = true;
      setShowNewMessagePill(false);
      if (result?.messageId) {
        const nextMessage: PlayerChatMessage = {
          id: result.messageId,
          senderUid: selfUid,
          type: 'image',
          imageUrl: uploaded.secureUrl,
          imagePublicId: uploaded.publicId,
          createdAt: timestampLikeFromIso(result.createdAt) as PlayerChatMessage['createdAt'],
          deliveredTo: [selfUid],
          seenBy: [selfUid],
          deletedFor: [],
        };
        setMessages((current) => trimRenderedPlayerMessages([...current, nextMessage]));
        setChatList((current) => ({
          ...current,
          [selectedPeer.uid]: {
            ...(current[selectedPeer.uid] || { unread: 0, muted: false, last: '' }),
            last: 'Photo',
          },
        }));
      }
      setMessageNotice(
        result?.chargedAmount === 1 ? 'Photo sent. 1 coin charged.' : 'Photo sent.'
      );
      await markDirectConversationSeen(selectedPeer.uid);
    } catch (error) {
      // TODO: best-effort Cloudinary cleanup if upload succeeds but final send fails.
      setMessageError(error instanceof Error ? error.message : 'Could not send photo. Please try again.');
    } finally {
      setPhotoStatus('');
      setSending(false);
    }
  }

  async function onSearch() {
    if (!selectedPeer) return;
    const results = await searchDirectMessages(selectedPeer.uid, searchTerm);
    setSearchResults(filterVisibleDirectMessages(results, selfUid));
  }

  async function onDeleteForMe(message: PlayerChatMessage) {
    if (!selectedPeer) return;
    setMessageError('');
    console.info('[CHAT_DELETE_REQUEST]', {
      messageId: message.id,
      senderUid: message.senderUid,
      peerUid: selectedPeer.uid,
      scope: 'for_me',
      source: 'ui',
    });
    try {
      await deleteDirectMessageForMe(selectedPeer.uid, message.id);
      setMessages((current) => current.filter((item) => item.id !== message.id).slice(-PLAYER_CHAT_RENDER_MAX));
      setChatList((current) => ({
        ...current,
        [selectedPeer.uid]: {
          ...(current[selectedPeer.uid] || { unread: 0, muted: false, last: '' }),
          last:
            current[selectedPeer.uid]?.last &&
            message.text &&
            current[selectedPeer.uid]?.last === message.text
              ? ''
              : current[selectedPeer.uid]?.last || '',
        },
      }));
      console.info('[CHAT_DELETE_UI_REFRESH]', {
        reason: 'delete_for_me_local_state',
        messageId: message.id,
        peerUid: selectedPeer.uid,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Failed to delete message.';
      console.error('[CHAT_DELETE_FOR_ME]', {
        messageId: message.id,
        senderUid: message.senderUid,
        error: reason,
      });
      setMessageError(reason);
    }
  }

  async function onDeleteForEveryone(message: PlayerChatMessage) {
    if (!selectedPeer) return;
    setMessageError('');
    console.info('[CHAT_DELETE_REQUEST]', {
      messageId: message.id,
      senderUid: message.senderUid,
      peerUid: selectedPeer.uid,
      scope: 'for_everyone',
      source: 'ui',
    });
    try {
      await deleteDirectMessageForEveryone(selectedPeer.uid, message.id);
      setMessages((current) =>
        current
          .map((item) =>
            item.id === message.id
              ? {
                  ...item,
                  text: '',
                  imageUrl: '',
                  imagePublicId: '',
                  deletedForEveryone: true,
                }
              : item
          )
          .slice(-PLAYER_CHAT_RENDER_MAX)
      );
      setChatList((current) => ({
        ...current,
        [selectedPeer.uid]: {
          ...(current[selectedPeer.uid] || { unread: 0, muted: false, last: '' }),
          last: 'Message deleted',
        },
      }));
      console.info('[CHAT_DELETE_UI_REFRESH]', {
        reason: 'delete_for_everyone_local_state',
        messageId: message.id,
        peerUid: selectedPeer.uid,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Failed to delete message.';
      console.error('[CHAT_DELETE_FOR_ALL]', {
        messageId: message.id,
        senderUid: message.senderUid,
        error: reason,
      });
      setMessageError(reason);
    }
  }

  async function onAddFriendByReferralCode(e: React.FormEvent) {
    e.preventDefault();
    const code = referralInput.trim().toUpperCase();
    if (!code) {
      setReferralError('Please enter a referral code.');
      return;
    }

    setReferralLoading(true);
    setReferralError('');
    setReferralNotice('');
    try {
      const result = await sendFriendRequestByReferralCode(code);
      if (result.uid && result.link) {
        const link = result.link;
        setFriendByUid((current) => ({
          ...current,
          [result.uid]: {
            status: link.status === 'accepted' ? 'accepted' : 'pending',
            requestedByUid: link.requestedByUid || selfUid,
            peer:
              current[result.uid]?.peer ||
              allPlayers.find((player) => player.uid === result.uid) || {
                uid: result.uid,
                avatarEmoji: '',
                avatarName: result.username,
                bio: '',
                avatarImageUrl: null,
                lastSeenAt: null,
              },
          },
        }));
      }
      setReferralNotice(
        result.link?.status === 'accepted'
          ? `You and ${result.username} are already friends.`
          : result.duplicate
            ? `A friend request with ${result.username} is already pending.`
            : `Friend request sent to ${result.username}.`
      );
      setReferralInput('');
    } catch (error) {
      setReferralError(error instanceof Error ? error.message : 'Failed to add friend.');
    } finally {
      setReferralLoading(false);
    }
  }

  async function onSendFriendRequest(otherUid: string) {
    if (!otherUid || friendActionUid) return;
    setFriendActionUid(otherUid);
    setFriendError('');
    setFriendNotice('');
    try {
      const result = await sendFriendRequest(otherUid);
      setFriendByUid((current) => ({
        ...current,
        [otherUid]: {
          status: result?.link?.status === 'accepted' ? 'accepted' : 'pending',
          requestedByUid: result?.link?.requestedByUid || selfUid,
          peer:
            current[otherUid]?.peer ||
            allPlayers.find((player) => player.uid === otherUid) ||
            selectedPeer ||
            undefined,
        },
      }));
      setFriendNotice(
        result?.link?.status === 'accepted'
          ? 'You are already friends.'
          : result?.duplicate
            ? 'Friend request is already pending.'
            : 'Friend request sent.'
      );
    } catch (error) {
      setFriendError(error instanceof Error ? error.message : 'Failed to send friend request.');
    } finally {
      setFriendActionUid('');
    }
  }

  async function onAcceptFriendRequest(otherUid: string) {
    if (!otherUid || friendActionUid) return;
    setFriendActionUid(otherUid);
    setFriendError('');
    setFriendNotice('');
    try {
      await acceptFriendRequest(otherUid);
      setFriendByUid((current) => ({
        ...current,
        [otherUid]: {
          status: 'accepted',
          requestedByUid: current[otherUid]?.requestedByUid || otherUid,
          peer: current[otherUid]?.peer,
        },
      }));
      setFriendNotice('Friend request accepted.');
    } catch (error) {
      setFriendError(error instanceof Error ? error.message : 'Failed to accept friend request.');
    } finally {
      setFriendActionUid('');
    }
  }

  async function onDeclineFriendRequest(otherUid: string) {
    if (!otherUid || friendActionUid) return;
    setFriendActionUid(otherUid);
    setFriendError('');
    setFriendNotice('');
    try {
      await declineFriendRequest(otherUid);
      setFriendByUid((current) => {
        const next = { ...current };
        delete next[otherUid];
        return next;
      });
      if (selectedPeer?.uid === otherUid) {
        setSelectedPeer(null);
      }
      setFriendNotice('Friend request declined.');
    } catch (error) {
      setFriendError(error instanceof Error ? error.message : 'Failed to decline friend request.');
    } finally {
      setFriendActionUid('');
    }
  }

  async function onCancelFriendRequest(otherUid: string) {
    if (!otherUid || friendActionUid) return;
    setFriendActionUid(otherUid);
    setFriendError('');
    setFriendNotice('');
    try {
      await cancelFriendRequest(otherUid);
      setFriendByUid((current) => {
        const next = { ...current };
        delete next[otherUid];
        return next;
      });
      if (selectedPeer?.uid === otherUid) {
        setSelectedPeer(null);
      }
      setFriendNotice('Friend request cancelled.');
    } catch (error) {
      setFriendError(error instanceof Error ? error.message : 'Failed to cancel friend request.');
    } finally {
      setFriendActionUid('');
    }
  }

  async function onRewardCoins() {
    if (!selectedPeer || rewardBusy || rewardInFlightRef.current) return;
    const amount = Math.max(0, Math.floor(Number(rewardAmount || 0)));
    if (amount <= 0) {
      setMessageError('Reward amount must be at least 1 coin.');
      return;
    }
    rewardInFlightRef.current = true;
    setRewardBusy(true);
    setMessageError('');
    setRewardNotice('');
    rewardRequestIdRef.current =
      rewardRequestIdRef.current ||
      (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      const result = await rewardCoinsToPlayer(selectedPeer.uid, amount, {
        idempotencyKey: rewardRequestIdRef.current,
      });
      try {
        await sendDirectTextMessage(
          selectedPeer.uid,
          `Received ${result.recipientCoins} coin reward.`
        );
      } catch (noticeError) {
        console.warn('[PLAYER_CHAT_REWARD_NOTICE_FAILED]', noticeError);
      }
      setRewardNotice(`Reward sent. Friend receives ${result.recipientCoins} coins.`);
      setShowRewardPanel(false);
    } catch (error) {
      setMessageError(error instanceof Error ? error.message : 'Failed to reward coins.');
    } finally {
      rewardRequestIdRef.current = null;
      rewardInFlightRef.current = false;
      setRewardBusy(false);
    }
  }

  function validateProfileDraft(options?: { activating?: boolean }) {
    const avatarEmoji = profileDraftAvatarEmoji.trim();
    const avatarName = profileDraftName.trim().replace(/\s+/g, ' ');
    const gender = normalizeGender(profileDraftGender);
    const bio = profileDraftBio.trim().replace(/\s+/g, ' ');
    const requireComplete = options?.activating || chatProfile?.isActive === true;
    if (requireComplete && !avatarEmoji) {
      return 'Choose an avatar before using Player Chat.';
    }
    if (avatarName.length < 3 || avatarName.length > 32) {
      return 'Avatar Name must be 3-32 characters.';
    }
    if (requireComplete && !gender) {
      return 'Choose Male or Female before using Player Chat.';
    }
    if (requireComplete && !bio) {
      return 'Short Bio is required to activate Player Chat.';
    }
    if (bio.length > 120) {
      return 'Short Bio must be 120 characters or less.';
    }
    return '';
  }

  async function saveProfileDraft(options?: { activate?: boolean }) {
    const validation = validateProfileDraft({ activating: options?.activate });
    if (validation) {
      setProfileError(validation);
      setProfileNotice('');
      return;
    }

    setProfileSaving(true);
    setProfileError('');
    setProfileNotice('');
    try {
      const saved = await updateMyPlayerChatProfile({
        avatarEmoji: profileDraftAvatarEmoji,
        avatarName: profileDraftName,
        gender: profileDraftGender,
        bio: profileDraftBio,
      });
      const next = options?.activate ? await activateMyPlayerChatProfile() : saved;
      setChatProfile(next);
      setProfileDraftAvatarEmoji(next.avatarEmoji);
      setProfileDraftName(next.avatarName);
      setProfileDraftGender(normalizeGender(next.gender));
      setProfileDraftBio(next.bio);
      setProfileEditing(!isCompletePlayerChatProfile(next));
      setProfileNotice(
        options?.activate ? 'Player Chat activated.' : 'Player Chat profile saved.'
      );
    } catch (error) {
      setProfileError(
        error instanceof Error ? error.message : 'Failed to save Player Chat profile.'
      );
    } finally {
      setProfileSaving(false);
    }
  }

  async function deactivateProfile() {
    setProfileSaving(true);
    setProfileError('');
    setProfileNotice('');
    try {
      const next = await deactivateMyPlayerChatProfile();
      setChatProfile(next);
      setProfileDraftAvatarEmoji(next.avatarEmoji);
      setProfileDraftName(next.avatarName);
      setProfileDraftGender(normalizeGender(next.gender));
      setProfileDraftBio(next.bio);
      setProfileEditing(true);
      setProfileNotice('Player Chat deactivated.');
    } catch (error) {
      setProfileError(
        error instanceof Error ? error.message : 'Failed to deactivate Player Chat.'
      );
    } finally {
      setProfileSaving(false);
    }
  }

  function renderProfileFields(options: { activate: boolean; showTitle?: boolean }) {
    const activateLabel = chatProfile?.isActive ? 'Complete Profile' : 'Activate Chat';
    return (
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void saveProfileDraft({ activate: options.activate });
        }}
      >
        {options.showTitle ? (
          <div>
            <h1 className="text-2xl font-black text-amber-200">
              {chatProfile?.isActive ? 'Complete Your Chat Profile' : 'Create Your Chat Profile'}
            </h1>
            <p className="mt-1 text-sm text-amber-100/65">
              Choose a public avatar, name, gender, and short bio to enter Player Chat.
            </p>
          </div>
        ) : null}
        <div>
          <p className="mb-2 text-xs font-semibold text-amber-100/70">Avatar Emoji</p>
          <div className="space-y-2">
            {PLAYER_CHAT_AVATAR_GROUPS.map((group) => (
              <div key={group.label}>
                <p className="mb-1 text-[11px] uppercase tracking-[0.14em] text-amber-100/45">
                  {group.label}
                </p>
                <div className="grid grid-cols-7 gap-1.5 sm:grid-cols-9">
                  {group.values.map((emoji) => {
                    const selected = profileDraftAvatarEmoji === emoji;
                    return (
                      <button
                        key={`${group.label}-${emoji}`}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => setProfileDraftAvatarEmoji(emoji)}
                        className={`h-9 rounded-lg border text-lg transition ${
                          selected
                            ? 'border-amber-300 bg-amber-300/25 shadow-[0_0_0_2px_rgba(252,211,77,0.22)]'
                            : 'border-white/10 bg-black/35 hover:border-amber-200/50'
                        }`}
                      >
                        {emoji}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-amber-100/70">
            Avatar Name
          </label>
          <input
            value={profileDraftName}
            maxLength={32}
            onChange={(event) => setProfileDraftName(event.target.value)}
            className="w-full rounded-lg border border-white/15 bg-black/45 px-3 py-2 text-sm"
            placeholder="3-32 characters"
          />
        </div>
        <div>
          <p className="mb-1 block text-xs font-semibold text-amber-100/70">Gender</p>
          <div className="grid grid-cols-2 gap-2">
            {[
              { value: 'male', label: 'Male' },
              { value: 'female', label: 'Female' },
            ].map((option) => {
              const selected = profileDraftGender === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setProfileDraftGender(option.value)}
                  className={`rounded-lg border px-3 py-2 text-sm font-semibold transition ${
                    selected
                      ? 'border-emerald-300 bg-emerald-300/20 text-emerald-100'
                      : 'border-white/15 bg-black/35 text-amber-100/75 hover:border-emerald-200/50'
                  }`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-amber-100/70">
            Short Bio
          </label>
          <textarea
            value={profileDraftBio}
            maxLength={120}
            onChange={(event) => setProfileDraftBio(event.target.value)}
            className="min-h-[70px] w-full resize-none rounded-lg border border-white/15 bg-black/45 px-3 py-2 text-sm"
            placeholder="A short public bio"
          />
          <p className="mt-1 text-right text-[11px] text-amber-100/45">
            {profileDraftBio.length}/120
          </p>
        </div>
        {profileError ? <p className="text-xs text-red-300">{profileError}</p> : null}
        {profileNotice ? <p className="text-xs text-emerald-300">{profileNotice}</p> : null}
        <div className="flex flex-wrap gap-2">
          {chatProfile?.isActive && chatProfileComplete ? (
            <>
              <button
                type="submit"
                disabled={profileSaving}
                className="rounded-lg bg-amber-300 px-3 py-1.5 text-xs font-bold text-black disabled:opacity-50"
              >
                {profileSaving ? 'Saving...' : 'Save'}
              </button>
              <button
                type="button"
                disabled={profileSaving}
                onClick={() => {
                  setProfileDraftAvatarEmoji(chatProfile.avatarEmoji);
                  setProfileDraftName(chatProfile.avatarName);
                  setProfileDraftGender(normalizeGender(chatProfile.gender));
                  setProfileDraftBio(chatProfile.bio);
                  setProfileEditing(false);
                  setProfileError('');
                  setProfileNotice('');
                }}
                className="rounded-lg border border-white/20 px-3 py-1.5 text-xs hover:bg-white/10 disabled:opacity-50"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="submit"
              disabled={profileSaving}
              className="rounded-lg bg-emerald-300 px-3 py-1.5 text-xs font-bold text-black disabled:opacity-50"
            >
              {profileSaving ? 'Activating...' : activateLabel}
            </button>
          )}
        </div>
      </form>
    );
  }

  if (isPlayerRole && profileLoading) {
    return (
      <main className="min-h-[100dvh] bg-[#050509] p-4 text-white">
        <section className="fire-panel fire-violet mx-auto mt-8 max-w-lg rounded-2xl border border-violet-400/30 bg-black/50 p-5">
          <p className="text-sm text-amber-100/65">Loading profile...</p>
        </section>
      </main>
    );
  }

  if (isPlayerRole && !chatProfileComplete) {
    return (
      <main className="min-h-[100dvh] bg-[#050509] p-4 text-white">
        <section className="fire-panel fire-violet mx-auto mt-4 max-w-2xl rounded-2xl border border-violet-400/30 bg-black/50 p-5">
          <div className="mb-4 flex items-center justify-between">
            <span className="text-sm font-bold uppercase tracking-[0.18em] text-amber-200/80">
              Player Chat
            </span>
            <Link
              href="/player"
              className="rounded-lg border border-white/15 px-3 py-1.5 text-xs text-amber-100/80 hover:bg-white/10"
            >
              Back
            </Link>
          </div>
          {renderProfileFields({ activate: true, showTitle: true })}
        </section>
      </main>
    );
  }

  return (
    <>
    <main className="min-h-[100dvh] bg-[#050509] text-white">
        <div
          className={`mx-auto flex w-full max-w-7xl flex-col gap-4 lg:h-[100dvh] lg:min-h-0 lg:flex-row lg:gap-5 lg:overflow-hidden lg:p-5 ${
            selectedPeer
              ? 'h-[100dvh] min-h-0 overflow-hidden p-0'
              : 'min-h-[100dvh] p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]'
          }`}
        >
          <aside
            className={`fire-panel fire-violet min-h-0 w-full shrink-0 flex-col rounded-2xl border border-violet-400/30 bg-black/50 p-4 lg:flex lg:w-[320px] lg:overflow-hidden ${
              selectedPeer ? 'hidden' : 'flex'
            }`}
          >
            <div className="mb-4 flex items-center justify-between">
              <h1 className="text-xl font-black tracking-wide text-amber-200">Player Chat</h1>
              <Link
                href="/player"
                className="rounded-lg border border-white/15 px-3 py-1.5 text-xs text-amber-100/80 hover:bg-white/10"
              >
                Back
              </Link>
            </div>
            <button
              type="button"
              onClick={() => {
                setShowAddByReferralModal(true);
                setReferralError('');
                setReferralNotice('');
              }}
              className="mb-3 w-full rounded-xl border border-emerald-300/40 bg-emerald-500/15 px-3 py-2 text-sm font-semibold text-emerald-100 hover:bg-emerald-500/25"
            >
              Add Friend
            </button>
            <div className="mb-3 rounded-xl border border-white/10 bg-black/35 p-3">
              {profileLoading ? (
                <p className="text-sm text-amber-100/60">Loading profile...</p>
              ) : !chatProfile?.isActive || profileEditing ? (
                renderProfileFields({ activate: !chatProfile?.isActive })
              ) : (
                <div className="space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 gap-2">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/15 bg-black/50 text-xl">
                        {chatProfile.avatarEmoji}
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-bold text-white">
                          {chatProfile.avatarName}
                        </p>
                        <p className="mt-1 line-clamp-2 text-xs text-amber-100/60">
                          {chatProfile.bio}
                        </p>
                      </div>
                    </div>
                    <span className="shrink-0 rounded-full border border-emerald-300/40 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold text-emerald-200">
                      Active
                    </span>
                  </div>
                  {profileError ? <p className="text-xs text-red-300">{profileError}</p> : null}
                  {profileNotice ? <p className="text-xs text-emerald-300">{profileNotice}</p> : null}
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={profileSaving}
                      onClick={() => {
                        setProfileEditing(true);
                        setProfileError('');
                        setProfileNotice('');
                      }}
                      className="rounded-lg border border-white/20 px-3 py-1.5 text-xs hover:bg-white/10 disabled:opacity-50"
                    >
                      Edit Profile
                    </button>
                    <button
                      type="button"
                      disabled={profileSaving}
                      onClick={() => void deactivateProfile()}
                      className="rounded-lg border border-red-300/40 px-3 py-1.5 text-xs text-red-100 hover:bg-red-500/15 disabled:opacity-50"
                    >
                      {profileSaving ? 'Updating...' : 'Deactivate Chat'}
                    </button>
                  </div>
                </div>
              )}
            </div>
            {pendingFriendRequests.length > 0 ? (
              <div className="mb-3 rounded-xl border border-amber-300/30 bg-amber-500/10 p-3">
                <p className="text-xs font-black uppercase tracking-[0.18em] text-amber-200">
                  Pending friend requests ({pendingFriendRequests.length})
                </p>
                <div className="mt-2 max-h-44 space-y-2 overflow-y-auto overflow-x-hidden pr-1">
                  {pendingFriendRequests.map(({ player, direction }) => (
                    <div
                      key={player.uid}
                      className="rounded-xl border border-white/10 bg-black/35 p-2.5"
                    >
                      <div className="flex items-center gap-2">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/15 bg-black/50 text-lg">
                          {player.avatarEmoji || 'P'}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm font-bold text-white">
                          {player.avatarName}
                        </span>
                        <span className="shrink-0 rounded-full border border-amber-300/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-amber-200">
                          Pending
                        </span>
                      </div>
                      <p className="mt-1 text-[10px] font-bold uppercase tracking-wide text-amber-100/60">
                        {direction === 'sent' ? 'Sent' : 'Received'}
                      </p>
                      <div className="mt-2 flex gap-2">
                        {direction === 'received' ? (
                          <button
                            type="button"
                            disabled={Boolean(friendActionUid)}
                            onClick={() => void onAcceptFriendRequest(player.uid)}
                            className="flex-1 rounded-lg border border-emerald-300/40 bg-emerald-500/15 px-2 py-1.5 text-xs font-bold text-emerald-100 hover:bg-emerald-500/25 disabled:opacity-50"
                          >
                            {friendActionUid === player.uid ? 'Updating...' : 'Accept'}
                          </button>
                        ) : null}
                        <button
                          type="button"
                          disabled={Boolean(friendActionUid)}
                          onClick={() =>
                            void (direction === 'sent'
                              ? onCancelFriendRequest(player.uid)
                              : onDeclineFriendRequest(player.uid))
                          }
                          className="flex-1 rounded-lg border border-red-300/40 bg-red-500/10 px-2 py-1.5 text-xs font-bold text-red-100 hover:bg-red-500/20 disabled:opacity-50"
                        >
                          {direction === 'sent' ? 'Cancel Request' : 'Decline'}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            {friendError ? <p className="mb-2 text-xs text-red-300">{friendError}</p> : null}
            {friendNotice ? <p className="mb-2 text-xs text-emerald-300">{friendNotice}</p> : null}
            <p className="mb-2 text-xs uppercase tracking-[0.2em] text-emerald-300/80">
              All players
            </p>
            <input
              value={playerSearchTerm}
              onChange={(e) => setPlayerSearchTerm(e.target.value)}
              placeholder="Search players"
              className="mb-3 w-full rounded-xl border border-white/15 bg-black/45 px-3 py-2 text-sm"
            />
            <div className="max-h-[min(50dvh,28rem)] min-h-0 flex-1 space-y-2 overflow-y-auto overflow-x-hidden overscroll-contain pr-1 lg:max-h-none">
              {chatLoading ? (
                <p className="rounded-xl border border-white/10 bg-black/40 p-3 text-sm text-amber-100/60">
                  Chat loading...
                </p>
              ) : filteredPlayers.length === 0 ? (
                <p className="rounded-xl border border-white/10 bg-black/40 p-3 text-sm text-amber-100/60">
                  {chatLoadError || 'No matching players found.'}
                </p>
              ) : (
                filteredPlayers.map((p) => {
                  const stat = chatList[p.uid];
                  const selected = selectedPeer?.uid === p.uid;
                  const initials =
                    p.avatarName
                      .split(/\s+/)
                      .map((part) => part[0])
                      .join('')
                      .slice(0, 2)
                      .toUpperCase() || 'P';
                  return (
                    <button
                      key={p.uid}
                      type="button"
                      onClick={() => {
                        setSelectedPeer(p);
                        setSearchResults([]);
                      }}
                      className={`w-full rounded-xl border p-3 text-left transition ${
                        selected
                          ? 'border-amber-400/60 bg-amber-500/15'
                          : 'border-white/10 bg-black/30 hover:border-violet-300/40'
                      }`}
                    >
                      <div className="flex items-start gap-3">
                        <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-full border border-white/15 bg-black/50">
                          {p.avatarImageUrl ? (
                            <span
                              aria-hidden="true"
                              className="block h-full w-full bg-cover bg-center"
                              style={{ backgroundImage: `url(${p.avatarImageUrl})` }}
                            />
                          ) : p.avatarEmoji ? (
                            <span className="flex h-full w-full items-center justify-center text-xl">
                              {p.avatarEmoji}
                            </span>
                          ) : (
                            <span className="flex h-full w-full items-center justify-center text-sm font-black text-amber-100">
                              {initials}
                            </span>
                          )}
                          <span
                            className={`absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border border-black ${
                              onlineByUid[p.uid] ? 'bg-emerald-400' : 'bg-neutral-600'
                            }`}
                          />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate font-semibold">{p.avatarName}</span>
                            {stat?.unread ? (
                              <span className="shrink-0 rounded-full bg-red-500 px-2 py-0.5 text-[10px] font-black">
                                {stat.unread > 9 ? '9+' : stat.unread}
                              </span>
                            ) : null}
                          </div>
                          <p className="mt-1 line-clamp-2 text-xs text-amber-100/55">
                            {p.bio || 'Chat profile active'}
                          </p>
                          {friendByUid[p.uid]?.status === 'accepted' ? (
                            <p className="mt-1 text-[10px] font-bold uppercase tracking-wide text-emerald-300">
                              Friends
                            </p>
                          ) : friendByUid[p.uid]?.status === 'pending' ? (
                            <p className="mt-1 text-[10px] font-bold uppercase tracking-wide text-amber-300">
                              {friendByUid[p.uid].requestedByUid === selfUid
                                ? 'Request sent'
                                : 'Request received'}
                            </p>
                          ) : null}
                        </div>
                      </div>
                      <p className="mt-1 truncate text-xs text-amber-100/50">
                        {stat?.last || 'Start chatting'}
                      </p>
                    </button>
                  );
                })
              )}
            </div>
          </aside>

          <section
            className={`fire-panel fire-orange min-h-0 flex-1 flex-col overflow-hidden border border-amber-400/20 bg-black/45 lg:flex lg:rounded-2xl ${
              selectedPeer ? 'flex rounded-none' : 'hidden'
            }`}
          >
            {!selectedPeer ? (
              <div className="m-auto p-8 text-center text-amber-100/65">
                <p className="text-4xl">💬</p>
                <p className="mt-2 text-sm">Pick an online player to start a private chat.</p>
              </div>
            ) : (
              <>
                <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-white/10 p-3">
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedPeer(null);
                      setSearchResults([]);
                    }}
                    className="rounded-lg border border-white/20 bg-white/5 px-2.5 py-1 text-xs font-bold text-amber-100 hover:bg-white/10 lg:hidden"
                  >
                    ← Back
                  </button>
                  <h2 className="mr-auto text-lg font-bold">{selectedPeerDisplayName}</h2>
                  {typing ? <span className="text-xs text-emerald-300">typing...</span> : null}
                  {!selectedFriend ? (
                    <button
                      type="button"
                      disabled={Boolean(friendActionUid)}
                      onClick={() => void onSendFriendRequest(selectedPeer.uid)}
                      className="rounded-lg border border-emerald-300/40 bg-emerald-500/15 px-2.5 py-1 text-xs hover:bg-emerald-500/25"
                    >
                      {friendActionUid === selectedPeer.uid ? 'Sending...' : 'Add Friend'}
                    </button>
                  ) : selectedFriend.status === 'pending' && selectedFriend.requestedByUid !== selfUid ? (
                    <>
                      <button
                        type="button"
                        disabled={Boolean(friendActionUid)}
                        onClick={() => void onAcceptFriendRequest(selectedPeer.uid)}
                        className="rounded-lg border border-amber-300/40 bg-amber-500/15 px-2.5 py-1 text-xs hover:bg-amber-500/25 disabled:opacity-50"
                      >
                        {friendActionUid === selectedPeer.uid ? 'Updating...' : 'Accept Request'}
                      </button>
                      <button
                        type="button"
                        disabled={Boolean(friendActionUid)}
                        onClick={() => void onDeclineFriendRequest(selectedPeer.uid)}
                        className="rounded-lg border border-red-300/40 bg-red-500/10 px-2.5 py-1 text-xs text-red-100 hover:bg-red-500/20 disabled:opacity-50"
                      >
                        Decline
                      </button>
                    </>
                  ) : selectedFriend.status === 'pending' ? (
                    <>
                      <span className="rounded-lg border border-amber-300/30 bg-amber-500/10 px-2.5 py-1 text-xs font-bold text-amber-200">
                        Pending · Sent
                      </span>
                      <button
                        type="button"
                        disabled={Boolean(friendActionUid)}
                        onClick={() => void onCancelFriendRequest(selectedPeer.uid)}
                        className="rounded-lg border border-red-300/40 bg-red-500/10 px-2.5 py-1 text-xs text-red-100 hover:bg-red-500/20 disabled:opacity-50"
                      >
                        {friendActionUid === selectedPeer.uid ? 'Cancelling...' : 'Cancel Request'}
                      </button>
                    </>
                  ) : (
                    <span className="rounded-lg border border-white/15 px-2.5 py-1 text-xs text-emerald-300">
                      Friends
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      void setDirectConversationMuted(selectedPeer.uid, !selectedMuted)
                    }
                    className="rounded-lg border border-white/20 px-2.5 py-1 text-xs hover:bg-white/10"
                  >
                    {selectedMuted ? 'Unmute' : 'Mute'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowRewardPanel((v) => !v)}
                    className="rounded-lg border border-amber-300/40 bg-amber-500/15 px-2.5 py-1 text-xs hover:bg-amber-500/25"
                  >
                    Reward Coins
                  </button>
                </header>
                {rewardNotice ? (
                  <p className="border-b border-white/10 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
                    {rewardNotice}
                  </p>
                ) : null}
                {showRewardPanel ? (
                  <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-white/10 bg-black/20 p-2">
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={rewardAmount}
                      onChange={(e) => setRewardAmount(e.target.value)}
                      className="w-32 rounded-lg border border-white/15 bg-black/45 px-3 py-2 text-sm"
                      placeholder="Coins"
                    />
                    <button
                      type="button"
                      onClick={() => void onRewardCoins()}
                      disabled={rewardBusy}
                      className="rounded-lg border border-amber-300/40 bg-amber-500/15 px-3 py-2 text-xs hover:bg-amber-500/25 disabled:opacity-60"
                    >
                      {rewardBusy ? 'Sending…' : 'Send Reward'}
                    </button>
                    {rewardFeePreview !== null ? (
                      <span className="text-[11px] text-amber-100/65">
                        Friend gets {rewardFeePreview.recipientCoins}
                      </span>
                    ) : null}
                  </div>
                ) : null}

                <div className="flex shrink-0 items-center gap-2 border-b border-white/10 p-2">
                  <input
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    placeholder="Search messages"
                    className="flex-1 rounded-lg border border-white/15 bg-black/45 px-3 py-2 text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => void onSearch()}
                    className="rounded-lg border border-white/20 px-3 py-2 text-xs hover:bg-white/10"
                  >
                    Search
                  </button>
                </div>

                {searchResults.length > 0 ? (
                  <div className="max-h-28 shrink-0 space-y-1 overflow-y-auto overflow-x-hidden border-b border-white/10 bg-black/25 p-2">
                    {searchResults.map((m) => (
                      <div key={m.id} className="rounded bg-white/5 px-2 py-1 text-xs text-amber-100/80">
                        {m.text || 'Image'} · {toTime(m.createdAt)}
                      </div>
                    ))}
                  </div>
                ) : null}

                <div
                  ref={messagesScrollRef}
                  onScroll={(event) => {
                    const nearBottom = isNearScrollBottom(event.currentTarget);
                    nearBottomRef.current = nearBottom;
                    if (nearBottom) {
                      setShowNewMessagePill(false);
                    }
                    if (process.env.NODE_ENV === 'development') {
                      console.info('[CHAT_AUTOSCROLL]', {
                        chatType: 'player_player',
                        reason: 'user_scroll',
                        nearBottom,
                      });
                    }
                  }}
                  className="relative min-h-0 flex-1 space-y-2 overflow-y-auto overflow-x-hidden overscroll-contain p-3"
                >
                  {chatLoading ? (
                    <div className="pt-14 text-center text-sm text-amber-100/45">
                      Chat loading...
                    </div>
                  ) : messagesHiddenByFilters ? (
                    <div className="pt-14 text-center text-sm text-red-200">
                      Messages loaded but hidden by filters
                    </div>
                  ) : messages.length === 0 ? (
                    <div className="pt-14 text-center text-sm text-amber-100/45">
                      No messages yet.
                    </div>
                  ) : (
                    messages.map((m) => {
                      const mine = m.senderUid === selfUid;
                      const delivered = mine && (m.deliveredTo || []).length > 1;
                      const seen = mine && (m.seenBy || []).length > 1;
                      const status = seen ? 'Seen' : delivered ? 'Delivered' : 'Sent';
                      return (
                        <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                          <div
                            className={`max-w-[85%] overflow-hidden rounded-2xl px-3 py-2 text-sm [overflow-wrap:anywhere] ${
                              mine
                                ? 'bg-gradient-to-br from-amber-200 to-amber-300 text-black'
                                : 'border border-white/10 bg-white/5 text-white'
                            }`}
                          >
                            {m.replyToText ? (
                              <p className="mb-1 rounded-lg bg-black/10 px-2 py-1 text-xs opacity-80">
                                Reply: {m.replyToText}
                              </p>
                            ) : null}
                            {m.deletedForEveryone ? (
                              <p className="italic opacity-70">Message deleted</p>
                            ) : (
                              <>
                                {m.imageUrl ? (
                                  <img src={m.imageUrl} alt="" loading="lazy" className="mb-2 max-h-48 max-w-full rounded-lg object-contain" />
                                ) : null}
                                {m.text ? <p className="break-words [overflow-wrap:anywhere]">{m.text}</p> : null}
                              </>
                            )}
                            <div className="mt-1 flex items-center justify-between gap-3 text-[10px] opacity-70">
                              <span>{toTime(m.createdAt)}</span>
                              {mine ? <span>{status}</span> : null}
                            </div>
                            <div className="mt-1 flex gap-2 text-[10px]">
                              <button type="button" onClick={() => setReplyTarget(m)} className="underline">
                                Reply
                              </button>
                              <button
                                type="button"
                                onClick={() => void onDeleteForMe(m)}
                                className="underline"
                              >
                                Delete for me
                              </button>
                              {mine ? (
                                <button
                                  type="button"
                                  onClick={() =>
                                    void onDeleteForEveryone(m)
                                  }
                                  className="underline"
                                >
                                  Delete for all
                                </button>
                              ) : null}
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}
                  <div ref={messagesEndRef} />
                  {showNewMessagePill ? (
                    <button
                      type="button"
                      onClick={() => {
                        pendingScrollToBottomRef.current = false;
                        scrollMessageListToBottom(messagesScrollRef.current, messagesEndRef.current, 'smooth');
                        nearBottomRef.current = true;
                        setShowNewMessagePill(false);
                        if (process.env.NODE_ENV === 'development') {
                          console.info('[CHAT_AUTOSCROLL]', {
                            chatType: 'player_player',
                            reason: 'new_message_pill',
                            nearBottom: false,
                          });
                        }
                      }}
                      className="sticky bottom-2 z-10 mx-auto block rounded-full border border-amber-300/50 bg-amber-300 px-3 py-1 text-xs font-bold text-black shadow-lg shadow-black/30"
                    >
                      New message
                    </button>
                  ) : null}
                </div>

                {replyTarget ? (
                  <div className="shrink-0 border-t border-white/10 bg-black/20 px-3 py-2 text-xs text-amber-100/75">
                    Replying to: {replyTarget.text || 'Image'}
                    <button
                      type="button"
                      onClick={() => setReplyTarget(null)}
                      className="ml-3 underline"
                    >
                      Cancel
                    </button>
                  </div>
                ) : null}

                <form
                  onSubmit={onSend}
                  onClick={() => markThreadReadOnPlayerChatFocus(selectedPeer.uid, 'player_player', 'input')}
                  className="shrink-0 border-t border-white/10 p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]"
                >
                  <div className="mb-2 flex gap-2">
                    <div className="min-w-0 flex-1">
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        disabled={sending}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) {
                            void onSendImage(file);
                          }
                          e.target.value = '';
                        }}
                        className="text-xs disabled:opacity-50"
                      />
                      <p className="mt-1 text-[11px] text-amber-100/55">
                        Photo messages cost 1 coin.
                      </p>
                    </div>
                  </div>
                  {photoStatus ? (
                    <p className="mb-2 text-xs text-amber-200">{photoStatus}</p>
                  ) : null}
                  <div className="flex gap-2">
                    <input
                      value={newMessage}
                      onFocus={() =>
                        markThreadReadOnPlayerChatFocus(selectedPeer.uid, 'player_player', 'input')
                      }
                      onClick={() =>
                        markThreadReadOnPlayerChatFocus(selectedPeer.uid, 'player_player', 'input')
                      }
                      onChange={(e) => {
                        setNewMessage(e.target.value);
                        void setDirectTyping(selectedPeer.uid, e.target.value.trim().length > 0);
                      }}
                      placeholder="Type a message"
                      className="min-w-0 flex-1 rounded-xl border border-white/15 bg-black/55 px-3 py-2 text-sm [overflow-wrap:anywhere]"
                    />
                    <button
                      type="submit"
                      disabled={sending || !newMessage.trim()}
                      className="rounded-xl bg-amber-300 px-4 py-2 text-sm font-bold text-black disabled:opacity-50"
                    >
                      {sending ? 'Sending...' : 'Send'}
                    </button>
                  </div>
                  {messageError ? (
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-red-300">
                      <span>{messageError}</span>
                      {failedDraft ? (
                        <button
                          type="button"
                          onClick={() =>
                            void sendCurrentTextMessage(failedDraft, failedDraftIdempotencyKey)
                          }
                          className="rounded-full border border-red-300/40 px-2 py-0.5 font-semibold text-red-100 hover:bg-red-500/15"
                        >
                          Retry
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                  {messageNotice ? (
                    <p className="mt-2 text-xs text-emerald-300">{messageNotice}</p>
                  ) : null}
                </form>
              </>
            )}
          </section>
        </div>
      </main>
      {showAddByReferralModal ? (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
          onClick={() => setShowAddByReferralModal(false)}
        >
          <div
            className="w-full max-w-sm rounded-2xl border border-emerald-300/30 bg-[#090a12] p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-bold text-emerald-200">Add Friend by Referral Code</h3>
            <p className="mt-1 text-xs text-emerald-100/60">
              Enter a player referral code to send a friend request.
            </p>
            <form onSubmit={onAddFriendByReferralCode} className="mt-3 space-y-3">
              <input
                value={referralInput}
                onChange={(e) => setReferralInput(e.target.value.toUpperCase())}
                placeholder="Referral code"
                className="w-full rounded-xl border border-white/15 bg-black/50 px-3 py-2 text-sm uppercase tracking-wide text-white"
              />
              {referralError ? <p className="text-xs text-red-300">{referralError}</p> : null}
              {referralNotice ? <p className="text-xs text-emerald-300">{referralNotice}</p> : null}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setShowAddByReferralModal(false)}
                  className="flex-1 rounded-xl border border-white/15 px-3 py-2 text-sm hover:bg-white/10"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={referralLoading}
                  className="flex-1 rounded-xl bg-emerald-300 px-3 py-2 text-sm font-bold text-black disabled:opacity-60"
                >
                  {referralLoading ? 'Adding...' : 'Send Request'}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}
