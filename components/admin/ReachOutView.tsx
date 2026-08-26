'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AdminUser, ChatMessage } from './types';
import { OnlineIndicator } from '@/components/presence/OnlineIndicator';
import {
  getPanelDisplayName,
  type PanelNameMode,
} from '@/lib/admin/displayNames';

const EMOJIS = ['😀', '😂', '😍', '😎', '👍', '🙏', '🔥', '❤️', '🎉', '😢'];

const CHAT_BOTTOM_THRESHOLD_PX = 80;

function isNearScrollBottom(el: HTMLElement | null) {
  if (!el) {
    return true;
  }
  return el.scrollTop + el.clientHeight >= el.scrollHeight - CHAT_BOTTOM_THRESHOLD_PX;
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

function getOnlineStatusLabel(
  onlineByUid: Record<string, boolean>,
  user: AdminUser
) {
  if (user.uid in onlineByUid) {
    return onlineByUid[user.uid] ? 'Online' : 'Offline';
  }
  return 'Offline';
}

interface Props {
  chatUsers: AdminUser[];
  selectedChatUser: AdminUser | null;
  messages: ChatMessage[];
  newMessage: string;
  unreadCounts?: Record<string, number>;
  imagePreview?: string | null;
  sendingImage?: boolean;
  /** For scroll-anchoring when loading older messages (optional). */
  messagesScrollRef?: React.RefObject<HTMLDivElement | null>;
  hasMoreOlderMessages?: boolean;
  loadingOlderMessages?: boolean;
  onLoadOlderMessages?: () => void;
  disableLoadOlder?: boolean;
  playerLightweightMode?: boolean;
  onSelectUser: (user: AdminUser) => void;
  onMessageChange: (value: string) => void;
  onMessageFocus?: () => void;
  onSendMessage: (e: React.FormEvent) => void;
  onImageSelect?: (file: File) => void;
  onClearImage?: () => void;
  onBackToList?: () => void;
  /** Real-time: uid was active recently (for green dot). */
  onlineByUid?: Record<string, boolean>;
  nameMode?: PanelNameMode;
}

export default function ReachOutView({
  chatUsers,
  selectedChatUser,
  messages,
  newMessage,
  unreadCounts = {},
  imagePreview = null,
  sendingImage = false,
  onSelectUser,
  onMessageChange,
  onMessageFocus,
  onSendMessage,
  onImageSelect,
  onClearImage,
  onBackToList,
  messagesScrollRef,
  hasMoreOlderMessages = false,
  loadingOlderMessages = false,
  onLoadOlderMessages,
  disableLoadOlder = false,
  playerLightweightMode = false,
  onlineByUid = {},
  nameMode = 'player',
}: Props) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const lastScrolledIdRef = useRef<string | null>(null);
  const nearBottomRef = useRef(true);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showEmojis, setShowEmojis] = useState(false);
  const [showNewMessagePill, setShowNewMessagePill] = useState(false);

  useEffect(() => {
    lastScrolledIdRef.current = null;
    nearBottomRef.current = true;
    setShowNewMessagePill(false);
  }, [selectedChatUser?.id]);

  useLayoutEffect(() => {
    if (messages.length === 0) {
      return;
    }
    const last = messages[messages.length - 1].id;
    if (lastScrolledIdRef.current === last) {
      return;
    }
    lastScrolledIdRef.current = last;
    const nearBottom = nearBottomRef.current;
    if (process.env.NODE_ENV === 'development') {
      const el = messagesScrollRef?.current ?? null;
      console.info('[CHAT_AUTOSCROLL]', {
        chatType: playerLightweightMode ? 'player_agent' : 'agent_shared',
        reason: 'new_message',
        nearBottom,
      });
      if (el) {
        console.info('[CHAT_RENDER_STATE]', {
          chatType: playerLightweightMode ? 'player_agent' : 'agent_shared',
          messageCount: messages.length,
          renderedCount: messages.length,
          containerHeight: el.clientHeight,
          scrollHeight: el.scrollHeight,
          isOverflowing: el.scrollHeight > el.clientHeight,
        });
      }
    }
    if (nearBottom) {
      scrollMessageListToBottom(messagesScrollRef?.current ?? null, messagesEndRef.current, 'auto');
      setShowNewMessagePill(false);
      return;
    }
    setShowNewMessagePill(true);
  }, [messages, messagesScrollRef, playerLightweightMode, selectedChatUser?.id, selectedChatUser?.uid]);

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const totalUnread = Object.values(unreadCounts).reduce(
    (total, count) => total + count,
    0
  );

  const getMaskedDisplayName = (user: AdminUser) =>
    getPanelDisplayName(user, nameMode);

  /** Staff Reach Out: show coadmin as “Admin” in the subtitle line too (UI only). */
  const reachOutAgentRoleLabel = (user: AdminUser) => {
    if (nameMode !== 'staff') {
      return user.role;
    }
    if (String(user.role || '').toLowerCase() === 'coadmin') {
      return 'Admin';
    }
    return user.role;
  };

  const getAvatarLetter = (user: AdminUser) => {
    const name = getMaskedDisplayName(user).trim();
    return (name.charAt(0) || '?').toUpperCase();
  };

  const allowLoadOlder = !disableLoadOlder && Boolean(onLoadOlderMessages) && hasMoreOlderMessages;
  const canSend = Boolean(newMessage.trim() || imagePreview) && !sendingImage;

  if (playerLightweightMode) {
    return (
      <div className="player-agents-workspace flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden lg:grid lg:grid-cols-[minmax(240px,300px)_minmax(0,1fr)] lg:gap-6">
        <div
          className={`player-agents-list ${
            selectedChatUser ? 'hidden lg:flex' : 'flex'
          } h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden rounded-3xl border border-amber-300/20 bg-gradient-to-b from-[#1d1009] to-[#0d0705] p-3 shadow-2xl shadow-black/35 sm:p-4`}
        >
        <div className="mb-3 flex shrink-0 items-center justify-between">
          <div className="min-w-0">
            <h2 className="text-lg font-black tracking-tight text-amber-100 lg:text-xl">
              Agents
            </h2>
            <p className="player-agents-list__lede mt-0.5 hidden text-xs font-semibold text-amber-100/55 lg:block">
              Connect with our team
            </p>
          </div>

          {totalUnread > 0 && (
            <span className="rounded-full bg-red-500 px-2.5 py-1 text-xs font-bold text-white">
              {totalUnread} unread
            </span>
          )}
        </div>

        {chatUsers.length === 0 ? (
          <div className="flex min-h-[220px] items-center justify-center text-center text-sm text-amber-100/55">
            No agents available.
          </div>
        ) : (
          <div className="player-agents-list__scroller min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1">
            <div className="player-agents-list__grid grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {chatUsers.map((user) => {
                const unreadCount = unreadCounts[user.uid] || 0;
                const isSelectedAgent = selectedChatUser?.id === user.id;

                return (
                  <button
                    key={user.id}
                    type="button"
                    onClick={() => onSelectUser(user)}
                    aria-pressed={isSelectedAgent}
                    className={`player-agents-card flex w-full min-w-0 items-center gap-3 rounded-2xl border p-3 text-left shadow-lg transition active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/60 ${
                      isSelectedAgent
                        ? 'border-amber-300/45 bg-amber-400/15 text-white shadow-amber-950/25'
                        : unreadCount > 0
                          ? 'border-red-400/30 bg-red-500/10 text-white shadow-red-950/20 hover:bg-red-500/15'
                          : 'border-amber-200/10 bg-amber-100/8 text-amber-50 shadow-black/20 hover:border-amber-200/20 hover:bg-amber-100/10'
                    }`}
                  >
                    <div className="relative shrink-0">
                      <div className="flex h-12 w-12 items-center justify-center rounded-full border border-amber-200/20 bg-gradient-to-br from-[#4b2d18] to-[#1f1008] text-base font-black text-amber-100">
                        {getAvatarLetter(user)}
                      </div>

                      {unreadCount > 0 && (
                        <div className="absolute -right-1 -top-1 z-[1] flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1 text-xs font-bold text-white">
                          {unreadCount > 9 ? '9+' : unreadCount}
                        </div>
                      )}

                      <div className="absolute bottom-0 right-0 z-[1]">
                        <OnlineIndicator
                          online={Boolean(onlineByUid[user.uid])}
                          sizeClassName="h-3 w-3"
                          ringClassName="ring-[#1d1009]"
                        />
                      </div>
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center justify-between gap-2">
                        <p className="truncate text-sm font-black">
                          {getMaskedDisplayName(user)}
                        </p>

                        {unreadCount > 0 && (
                          <span className="shrink-0 rounded-full bg-red-500 px-2 py-0.5 text-[10px] font-bold text-white">
                            NEW
                          </span>
                        )}
                      </div>

                      <p className="truncate text-xs font-medium text-amber-100/50">
                        {getOnlineStatusLabel(onlineByUid, user)} -{' '}
                        {reachOutAgentRoleLabel(user)}
                      </p>
                      <p className="player-agents-card__hint mt-1 hidden text-[11px] font-black uppercase tracking-wide text-amber-200/70 lg:block">
                        View conversation
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}
        </div>

        <div
          className={`${
            selectedChatUser ? 'flex' : 'hidden lg:flex'
          } h-full max-h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden rounded-3xl border border-amber-300/20 bg-[#170c07] shadow-2xl shadow-black/40`}
        >
          {selectedChatUser ? (
            <>
        <div className="sticky top-0 z-20 shrink-0 border-b border-amber-200/10 bg-[#130a06]/95 px-3 py-3 shadow-lg shadow-black/25 backdrop-blur-xl">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={onBackToList}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-amber-200/15 bg-amber-100/10 text-sm font-black text-amber-100 transition hover:bg-amber-100/15 lg:hidden"
              aria-label="Back to agents"
            >
              Back
            </button>

            <div className="relative shrink-0">
              <div className="flex h-11 w-11 items-center justify-center rounded-full border border-amber-200/25 bg-gradient-to-br from-[#4b2d18] to-[#1f1008] text-base font-black text-amber-100 shadow-inner shadow-amber-200/10">
                {getAvatarLetter(selectedChatUser)}
              </div>
              <div className="absolute bottom-0 right-0 z-[1]">
                <OnlineIndicator
                  online={Boolean(onlineByUid[selectedChatUser.uid])}
                  sizeClassName="h-3 w-3"
                  ringClassName="ring-[#130a06]"
                />
              </div>
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <h3 className="truncate text-base font-black tracking-tight text-amber-50">
                  {getMaskedDisplayName(selectedChatUser)}
                </h3>
                <span className="shrink-0 rounded-full border border-amber-300/35 bg-amber-200/10 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-amber-100">
                  Agent
                </span>
              </div>
              <p className="truncate text-xs font-medium text-amber-100/55">
                {getOnlineStatusLabel(onlineByUid, selectedChatUser)} -{' '}
                {reachOutAgentRoleLabel(selectedChatUser)}
              </p>
            </div>
          </div>
        </div>

        <div
          ref={messagesScrollRef}
          onScroll={(event) => {
            const el = event.currentTarget;
            const nearBottom = isNearScrollBottom(el);
            nearBottomRef.current = nearBottom;
            if (nearBottom) {
              setShowNewMessagePill(false);
            }
          }}
          className="relative min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain bg-[radial-gradient(circle_at_top,rgba(180,120,45,0.16),transparent_32%),linear-gradient(180deg,#1d1009_0%,#0d0705_100%)] px-3 py-4 sm:px-5"
        >
          <div className="sticky top-1 z-10 mb-4 flex justify-center">
            <span className="rounded-full border border-amber-200/15 bg-[#20100a]/85 px-3 py-1 text-[11px] font-bold uppercase tracking-wide text-amber-100/70 shadow-lg shadow-black/25 backdrop-blur">
              Today
            </span>
          </div>

          {allowLoadOlder ? (
            <div className="mb-4 flex justify-center">
              <button
                type="button"
                disabled={loadingOlderMessages}
                onClick={() => onLoadOlderMessages?.()}
                className="rounded-full border border-amber-300/25 bg-black/35 px-4 py-2 text-xs font-semibold text-amber-100/90 shadow-sm backdrop-blur-sm hover:border-amber-300/45 hover:bg-black/45 disabled:opacity-50"
              >
                {loadingOlderMessages ? 'Loading...' : 'Load previous messages'}
              </button>
            </div>
          ) : null}

          {messages.length === 0 ? (
            <div className="flex min-h-full items-center justify-center px-6 text-center text-sm text-amber-100/55">
              <div className="max-w-xs space-y-2">
                <p className="text-base font-black text-amber-50">
                  Your VIP chat is ready
                </p>
                <p>Send a message when you need help.</p>
              </div>
            </div>
          ) : (
            <div className="space-y-1 pb-2">
              {messages.map((msg, index) => {
                const previous = messages[index - 1];
                const next = messages[index + 1];
                const fromPlayer = msg.sender === 'admin';
                const senderChanged = !previous || previous.sender !== msg.sender;
                const groupEnds = !next || next.sender !== msg.sender;

                return (
                  <div
                    key={msg.id}
                    className={`flex ${fromPlayer ? 'justify-end' : 'justify-start'} ${
                      senderChanged ? 'pt-4' : 'pt-1'
                    }`}
                  >
                    <div className={`flex max-w-[86%] flex-col sm:max-w-[68%] ${fromPlayer ? 'items-end' : 'items-start'}`}>
                      <div
                        className={`overflow-hidden px-4 py-2.5 shadow-lg [overflow-wrap:anywhere] ${
                          fromPlayer
                            ? 'rounded-[1.35rem] rounded-br-md bg-gradient-to-br from-amber-200 via-yellow-100 to-[#d69b3d] text-[#160b05] shadow-amber-950/30'
                            : 'rounded-[1.35rem] rounded-bl-md border border-amber-100/10 bg-[#2a1810]/95 text-amber-50 shadow-black/25'
                        }`}
                      >
                        {msg.imageUrl ? (
                          <img
                            src={msg.imageUrl}
                            alt=""
                            loading="lazy"
                            className="mb-2 max-h-56 max-w-full rounded-2xl object-contain"
                          />
                        ) : null}
                        {msg.text ? (
                          <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed [overflow-wrap:anywhere]">
                            {msg.text}
                          </p>
                        ) : null}
                      </div>

                      {groupEnds ? (
                        <p className={`mt-1 px-1 text-[11px] font-medium ${fromPlayer ? 'text-amber-100/45' : 'text-amber-100/40'}`}>
                          {formatTime(msg.timestamp)}
                        </p>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div ref={messagesEndRef} />
          {showNewMessagePill ? (
            <button
              type="button"
              onClick={() => {
                scrollMessageListToBottom(messagesScrollRef?.current ?? null, messagesEndRef.current, 'smooth');
                nearBottomRef.current = true;
                setShowNewMessagePill(false);
                if (process.env.NODE_ENV === 'development') {
                  console.info('[CHAT_AUTOSCROLL]', {
                    chatType: 'player_agent',
                    reason: 'new_message_pill',
                    nearBottom: false,
                  });
                }
              }}
              className="sticky bottom-3 z-10 mx-auto block rounded-full border border-amber-200/70 bg-gradient-to-r from-amber-200 to-[#d69b3d] px-4 py-2 text-xs font-black text-[#170c07] shadow-lg shadow-black/30"
            >
              New message
            </button>
          ) : null}
        </div>

        <form
          onSubmit={onSendMessage}
          onClick={onMessageFocus}
          className="shrink-0 border-t border-amber-200/10 bg-[#130a06]/95 p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] shadow-[0_-14px_38px_rgba(0,0,0,0.35)] backdrop-blur-xl sm:p-4"
        >
          {imagePreview && (
            <div className="mb-3 flex items-center gap-3 rounded-2xl border border-amber-200/15 bg-amber-100/10 p-3">
              <img
                src={imagePreview}
                alt="preview"
                loading="lazy"
                className="h-16 w-16 rounded-xl object-cover"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-amber-50">Photo ready</p>
                <p className="text-xs text-amber-100/45">Send when you are ready.</p>
              </div>
              <button
                type="button"
                onClick={onClearImage}
                className="rounded-full border border-amber-200/15 px-3 py-1.5 text-xs font-bold text-amber-100/70 hover:bg-amber-100/10 hover:text-amber-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/60"
              >
                Remove
              </button>
            </div>
          )}

          <div className="flex items-end gap-2 rounded-[1.6rem] border border-amber-200/15 bg-[#24140d]/95 p-2 shadow-inner shadow-black/30">
            <div className="relative shrink-0">
              <button
                type="button"
                onClick={() => setShowEmojis(!showEmojis)}
                className="flex h-10 w-10 items-center justify-center rounded-full text-sm font-black text-amber-100/65 transition hover:bg-amber-100/10 hover:text-amber-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/60"
              >
                :-)
              </button>

              {showEmojis && (
                <div className="absolute bottom-full left-0 mb-3 grid w-48 grid-cols-5 gap-1 rounded-2xl border border-amber-200/15 bg-[#20100a] p-2 shadow-2xl shadow-black/50">
                  {EMOJIS.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      onClick={() => {
                        onMessageChange(`${newMessage}${emoji}`);
                        setShowEmojis(false);
                      }}
                      className="rounded-xl bg-amber-100/10 p-2 text-lg hover:bg-amber-100/15"
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {onImageSelect ? (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      onImageSelect(file);
                    }
                    e.target.value = '';
                  }}
                  className="hidden"
                />

                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-black text-amber-100/65 transition hover:bg-amber-100/10 hover:text-amber-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/60"
                  aria-label="Attach photo"
                >
                  +
                </button>
              </>
            ) : null}

            <textarea
              value={newMessage}
              onChange={(e) => onMessageChange(e.target.value)}
              onInput={(event) => {
                event.currentTarget.style.height = 'auto';
                event.currentTarget.style.height = `${Math.min(event.currentTarget.scrollHeight, 128)}px`;
              }}
              onFocus={onMessageFocus}
              onClick={onMessageFocus}
              rows={1}
              placeholder="Message..."
              className="max-h-32 min-h-10 min-w-0 flex-1 resize-none rounded-lg bg-transparent px-1 py-2 text-base leading-6 text-amber-50 placeholder:text-amber-100/35 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/50"
            />

            <button
              type="submit"
              disabled={!canSend}
              className={`flex h-10 min-w-16 shrink-0 items-center justify-center rounded-full px-4 text-sm font-black transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/60 ${
                canSend
                  ? 'bg-gradient-to-r from-amber-200 via-yellow-100 to-[#d69b3d] text-[#170c07] shadow-lg shadow-amber-950/30 hover:brightness-110'
                  : 'bg-amber-100/10 text-amber-100/35'
              } disabled:cursor-not-allowed`}
            >
              {sendingImage ? '...' : 'Send'}
            </button>
          </div>
        </form>
            </>
          ) : (
            <div className="hidden h-full min-h-0 w-full flex-1 flex-col items-center justify-center gap-3 px-6 text-center lg:flex">
              <div className="flex h-14 w-14 items-center justify-center rounded-full border border-amber-200/15 bg-amber-100/8 text-2xl">
                💬
              </div>
              <p className="text-base font-black text-amber-50">Select an agent</p>
              <p className="max-w-[15rem] text-sm leading-relaxed text-amber-100/55">
                Choose someone from the list to view your conversation.
              </p>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col gap-4 overflow-hidden xl:grid xl:max-h-full xl:min-h-0 xl:grid-cols-[minmax(0,300px)_1fr] xl:grid-rows-1 xl:gap-6">
      <div className="order-2 flex min-h-0 max-h-[min(36dvh,320px)] shrink-0 flex-col overflow-hidden rounded-2xl border border-violet-500/25 bg-gradient-to-b from-violet-950/80 to-black/60 p-3 shadow-lg shadow-violet-500/10 backdrop-blur-md sm:max-h-[min(40dvh,360px)] xl:order-1 xl:max-h-full xl:min-h-0 xl:p-4">
        <div className="mb-3 flex shrink-0 items-center justify-between xl:mb-4">
          <h2 className="text-lg font-black tracking-tight text-amber-100 lg:text-xl">
            💬 Agents
          </h2>

          {totalUnread > 0 && (
            <span className="rounded-full bg-red-500 px-2.5 py-1 text-xs font-bold text-white">
              {totalUnread} unread
            </span>
          )}
        </div>

        {chatUsers.length === 0 ? (
          <p className="text-sm text-violet-200/60">No agents available.</p>
        ) : (
          <div className="min-h-0 flex-1">
            <div className="grid min-h-0 grid-cols-1 gap-2 overflow-x-hidden overflow-y-auto overscroll-contain pb-1 pr-1 sm:grid-cols-2 xl:flex xl:overflow-x-auto xl:overflow-y-hidden">
            {chatUsers.map((user) => {
              const unreadCount = unreadCounts[user.uid] || 0;

              return (
                <button
                  key={user.id}
                  onClick={() => onSelectUser(user)}
                  className={`flex w-full min-w-0 items-center gap-3 rounded-xl p-3 text-left transition xl:min-w-[220px] xl:shrink-0 2xl:min-w-[240px] ${
                    selectedChatUser?.id === user.id
                      ? 'bg-white text-black'
                      : unreadCount > 0
                        ? 'bg-red-500/10 text-white ring-1 ring-red-500/30 hover:bg-red-500/20'
                        : 'bg-white/5 text-white hover:bg-white/10'
                  }`}
                >
                  <div className="relative">
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-neutral-700 font-bold">
                      {getAvatarLetter(user)}
                    </div>

                    {unreadCount > 0 && (
                      <div className="absolute -right-1 -top-1 z-[1] flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1 text-xs font-bold text-white">
                        {unreadCount > 9 ? '9+' : unreadCount}
                      </div>
                    )}

                    <div className="absolute bottom-0 right-0 z-[1]">
                      <OnlineIndicator
                        online={Boolean(onlineByUid[user.uid])}
                        sizeClassName="h-2.5 w-2.5"
                        ringClassName="ring-neutral-800"
                      />
                    </div>
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-sm font-semibold">
                        {getMaskedDisplayName(user)}
                      </p>

                      {unreadCount > 0 && (
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                            selectedChatUser?.id === user.id
                              ? 'bg-red-500 text-white'
                              : 'bg-red-500 text-white'
                          }`}
                        >
                          NEW
                        </span>
                      )}
                    </div>

                    <p
                      className={`text-xs ${
                        selectedChatUser?.id === user.id
                          ? 'text-black/60'
                          : unreadCount > 0
                            ? 'text-red-200'
                            : 'text-neutral-500'
                      }`}
                    >
                      {getOnlineStatusLabel(onlineByUid, user)} ·{' '}
                      {reachOutAgentRoleLabel(user)}
                    </p>
                  </div>
                </button>
              );
            })}
            </div>
          </div>
        )}
      </div>

      <div className="order-1 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-amber-500/20 bg-black/40 shadow-xl shadow-amber-500/5 backdrop-blur-md xl:order-2">
        {!selectedChatUser ? (
          <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden px-4 text-center text-sm text-amber-100/50">
            <div className="w-full max-w-[16rem] min-w-0">
              <p className="w-full min-w-0 break-words">
              <span className="text-2xl">✨</span>
              <br />
              Pick an agent to open your VIP messenger
              </p>
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <div className="shrink-0 border-b border-white/10 bg-black/30 p-3 xl:p-4">
              <div className="flex items-center gap-3">
                <div className="relative">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-neutral-700 font-bold">
                    {getAvatarLetter(selectedChatUser)}
                  </div>
                  <div className="absolute bottom-0 right-0 z-[1]">
                    <OnlineIndicator
                      online={Boolean(onlineByUid[selectedChatUser.uid])}
                      sizeClassName="h-3 w-3"
                    />
                  </div>
                </div>

                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-semibold">
                      {getMaskedDisplayName(selectedChatUser)}
                    </h3>
                    {playerLightweightMode ? (
                      <span className="rounded-full border border-amber-300/40 bg-amber-300/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-100">
                        Agent
                      </span>
                    ) : null}
                  </div>
                  <p className="text-xs text-neutral-400">
                    {getOnlineStatusLabel(onlineByUid, selectedChatUser)} ·{' '}
                    {reachOutAgentRoleLabel(selectedChatUser)}
                  </p>
                </div>
              </div>
            </div>

            <div
              ref={messagesScrollRef}
              onScroll={(event) => {
                const el = event.currentTarget;
                const nearBottom = isNearScrollBottom(el);
                nearBottomRef.current = nearBottom;
                if (nearBottom) {
                  setShowNewMessagePill(false);
                }
              }}
              className="relative min-h-0 min-w-0 flex-1 space-y-3 overflow-y-auto overflow-x-hidden overscroll-contain p-3 xl:p-4"
            >
              {allowLoadOlder ? (
                <div className="sticky top-0 z-10 -mt-1 mb-2 flex justify-center">
                  <button
                    type="button"
                    disabled={loadingOlderMessages}
                    onClick={() => onLoadOlderMessages?.()}
                    className="rounded-full border border-amber-500/30 bg-black/50 px-4 py-2 text-xs font-semibold text-amber-100/90 shadow-sm backdrop-blur-sm hover:border-amber-400/50 hover:bg-black/60 disabled:opacity-50"
                  >
                    {loadingOlderMessages
                      ? 'Loading…'
                      : 'Load previous messages'}
                  </button>
                </div>
              ) : null}
              {messages.length === 0 ? (
                <div className="flex h-full items-center justify-center px-6 text-center text-sm text-neutral-400">
                  <div className="max-w-xs space-y-2">
                    <p className="text-base font-semibold text-amber-100">
                      {playerLightweightMode ? 'Your VIP chat is ready' : 'No messages yet'}
                    </p>
                    <p>
                      {playerLightweightMode
                        ? 'Agents usually reply fast. Send a message when you need help.'
                        : 'Start the conversation.'}
                    </p>
                  </div>
                </div>
              ) : (
                messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`flex ${
                      msg.sender === 'admin' ? 'justify-end' : 'justify-start'
                    }`}
                  >
                    <div
                      className={`max-w-[85%] overflow-hidden rounded-2xl px-4 py-2 shadow-md [overflow-wrap:anywhere] sm:max-w-[70%] ${
                        msg.sender === 'admin'
                          ? 'bg-gradient-to-br from-amber-100 to-amber-200 text-black'
                          : 'border border-white/10 bg-neutral-800/90 text-white'
                      }`}
                    >
                      {msg.imageUrl ? (
                        <img
                          src={msg.imageUrl}
                          alt=""
                          loading="lazy"
                          className="mb-2 max-h-48 max-w-full rounded-lg object-contain"
                        />
                      ) : null}
                      {msg.text ? (
                        <p className="break-words text-sm [overflow-wrap:anywhere]">{msg.text}</p>
                      ) : null}
                      <p
                        className={`mt-1 text-xs ${
                          msg.sender === 'admin'
                            ? 'text-black/60'
                            : 'text-neutral-500'
                        }`}
                      >
                        {formatTime(msg.timestamp)}
                      </p>
                    </div>
                  </div>
                ))
              )}

              <div ref={messagesEndRef} />
              {showNewMessagePill ? (
                <button
                  type="button"
                  onClick={() => {
                    scrollMessageListToBottom(messagesScrollRef?.current ?? null, messagesEndRef.current, 'smooth');
                    nearBottomRef.current = true;
                    setShowNewMessagePill(false);
                    if (process.env.NODE_ENV === 'development') {
                      console.info('[CHAT_AUTOSCROLL]', {
                        chatType: playerLightweightMode ? 'player_agent' : 'agent_shared',
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

            <form
              onSubmit={onSendMessage}
              onClick={onMessageFocus}
              className="shrink-0 border-t border-white/10 bg-black/40 p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] xl:p-4"
            >
              {imagePreview && (
                <div className="mb-3 flex items-center gap-2 rounded-lg bg-white/5 p-3">
                  <img
                    src={imagePreview}
                    alt="preview"
                    loading="lazy"
                    className="h-16 w-16 rounded object-cover"
                  />
                  <button
                    type="button"
                    onClick={onClearImage}
                    className="ml-auto text-xs text-neutral-400 hover:text-white"
                  >
                    Remove
                  </button>
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                <input
                  type="text"
                  value={newMessage}
                  onChange={(e) => onMessageChange(e.target.value)}
                  onFocus={onMessageFocus}
                  onClick={onMessageFocus}
                  placeholder="Message…"
                  className="min-w-0 flex-1 rounded-xl border border-amber-500/20 bg-neutral-900/90 px-4 py-3 text-base text-white placeholder:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-amber-400/40"
                />

                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setShowEmojis(!showEmojis)}
                    className="rounded-xl bg-white/10 px-3 py-2 text-sm hover:bg-white/20"
                  >
                    😊
                  </button>

                  {showEmojis && (
                    <div className="absolute bottom-full right-0 mb-2 grid w-48 grid-cols-5 gap-1 rounded-lg bg-neutral-800 p-2 shadow-lg">
                      {EMOJIS.map((emoji) => (
                        <button
                          key={emoji}
                          type="button"
                          onClick={() => {
                            onMessageChange(`${newMessage}${emoji}`);
                            setShowEmojis(false);
                          }}
                          className="rounded bg-neutral-700 p-2 text-lg hover:bg-neutral-600"
                        >
                          {emoji}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file && onImageSelect) {
                      onImageSelect(file);
                    }
                    e.target.value = '';
                  }}
                  className="hidden"
                />

                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="rounded-xl bg-white/10 px-3 py-2 text-sm hover:bg-white/20"
                >
                  📷
                </button>

                <button
                  type="submit"
                  disabled={(!newMessage.trim() && !imagePreview) || sendingImage}
                  className="rounded-xl bg-white px-4 py-2 text-sm font-semibold text-black disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {sendingImage ? '...' : 'Send'}
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
