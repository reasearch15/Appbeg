'use client';

import { useRef, useState } from 'react';
import React from 'react';
import { ChatMessage } from './types';
import {
  getPanelDisplayName,
  type PanelNameMode,
} from '@/lib/admin/displayNames';

const EMOJIS = ['😀', '😂', '😍', '😎', '👍', '🙏', '🔥', '❤️', '🎉', '😢'];

interface BaseUser {
  id: string;
  uid: string;
  username: string;
  role: string;
  status: string;
  isOnline?: boolean;
  lastSeen?: any;
  canViewPlayers?: boolean;
}

interface Props<T extends BaseUser> {
  title: string;
  emptyText: string;
  selectText: string;
  deleteTitle: string;
  deleteMessage: string;
  users: T[];
  selectedUser: T | null;
  deleteTarget: T | null;
  loadingList: boolean;
  loading: boolean;
  unreadCounts?: Record<string, number>;
  onSelectUser: (user: T) => void;
  onSetDeleteTarget: (user: T | null) => void;
  onDelete?: () => void;
  onToggleBlock?: (user: T) => void;
  blocking?: boolean;
  /** Coadmin: set sign-in password for staff/carer. */
  onCoadminSetPassword?: (user: T) => void;
  /** Coadmin: change login username for staff/carer. */
  onCoadminSetUsername?: (user: T) => void;
  coadminCredentialsLoading?: boolean;
  onTogglePlayerPrivilege?: (user: T) => void;
  playerPrivilegeLoadingUid?: string | null;
  /** Firestore-based presence: uid → online (overrides `user.isOnline` when set). */
  onlineByUid?: Record<string, boolean>;
  renderSelectedExtras?: (user: T) => React.ReactNode;
  onGiveFreeplay?: (user: T) => void;
  freeplayGiveBusyUid?: string | null;
  /** Coadmin “View carers” — responsive grid, amber VIP panels, scrollable list. */
  carersVisualTheme?: boolean;

  onStartChat?: (user: T) => void;
  chatUser?: T | null;
  messages?: ChatMessage[];
  newMessage?: string;
  imagePreview?: string | null;
  sendingImage?: boolean;
  onMessageChange?: (value: string) => void;
  onSendMessage?: (e: React.FormEvent) => void;
  onImageSelect?: (file: File) => void;
  onClearImage?: () => void;

  messagesScrollRef?: React.RefObject<HTMLDivElement | null>;
  hasMoreOlderMessages?: boolean;
  loadingOlderMessages?: boolean;
  onLoadOlderMessages?: () => void;
  /** Who is viewing: controls real usernames vs generic labels. Default `player` (masked). */
  nameMode?: PanelNameMode;
}

export default function UserManagementView<T extends BaseUser>({
  title,
  emptyText,
  selectText,
  deleteTitle,
  deleteMessage,
  users,
  selectedUser,
  deleteTarget,
  loadingList,
  loading,
  unreadCounts = {},
  onSelectUser,
  onSetDeleteTarget,
  onDelete,
  onToggleBlock,
  blocking = false,
  onCoadminSetPassword,
  onCoadminSetUsername,
  coadminCredentialsLoading = false,
  onTogglePlayerPrivilege,
  playerPrivilegeLoadingUid = null,
  onlineByUid,
  renderSelectedExtras,
  onGiveFreeplay,
  freeplayGiveBusyUid = null,
  carersVisualTheme = false,

  onStartChat,
  chatUser,
  messages = [],
  newMessage = '',
  imagePreview = null,
  sendingImage = false,
  onMessageChange,
  onSendMessage,
  onImageSelect,
  onClearImage,
  messagesScrollRef,
  hasMoreOlderMessages = false,
  loadingOlderMessages = false,
  onLoadOlderMessages,
  nameMode = 'player',
}: Props<T>) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showEmojis, setShowEmojis] = useState(false);
  const [openImageUrl, setOpenImageUrl] = useState<string | null>(null);

  function isUserOnline(user: T) {
    if (onlineByUid && user.uid in onlineByUid) {
      return onlineByUid[user.uid];
    }
    return Boolean(user.isOnline);
  }

  function getOnlineLabel(user: T) {
    return isUserOnline(user) ? 'Online' : 'Offline';
  }

  function formatTime(date: Date) {
    return date.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function handleEmojiClick(emoji: string) {
    onMessageChange?.(`${newMessage}${emoji}`);
    setShowEmojis(false);
  }

  function getMaskedDisplayName(user: T) {
    return getPanelDisplayName(user, nameMode);
  }

  function getAvatarLetter(user: T) {
    const displayName = getMaskedDisplayName(user).trim();
    return (displayName.charAt(0) || '?').toUpperCase();
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];

    if (!file || !onImageSelect) return;

    onImageSelect(file);
    e.target.value = '';
  }

  const isChatOpen =
    selectedUser && chatUser && selectedUser.uid === chatUser.uid;

  const rootLayoutClass = carersVisualTheme
    ? 'flex min-h-0 flex-1 flex-col gap-4 overflow-hidden lg:grid lg:h-[min(88dvh,calc(100vh-7rem))] lg:max-h-[min(88dvh,calc(100vh-7rem))] lg:min-h-0 lg:grid-cols-[minmax(0,300px)_1fr] lg:grid-rows-1 lg:gap-6'
    : 'grid h-[calc(100vh-48px)] min-h-0 max-h-[calc(100vh-48px)] grid-cols-1 gap-4 overflow-hidden lg:grid-cols-[minmax(0,320px)_1fr] lg:gap-6';

  const sidebarClass = carersVisualTheme
    ? 'max-h-[42vh] min-h-0 shrink-0 overflow-y-auto overflow-x-hidden overscroll-contain rounded-2xl border border-amber-500/30 bg-gradient-to-b from-amber-950/55 via-[#0f0a14] to-black/70 p-4 shadow-[0_0_40px_-12px_rgba(234,179,8,0.15)] backdrop-blur-md lg:max-h-full'
    : 'rounded-2xl border border-white/10 bg-neutral-900/60 p-4';

  const detailClass = carersVisualTheme
    ? 'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-amber-500/25 bg-black/50 p-5 shadow-xl shadow-amber-900/10 backdrop-blur-md'
    : 'flex min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border border-white/10 bg-white/5 p-6';

  const listTitleClass = carersVisualTheme
    ? 'mb-4 text-lg font-black tracking-tight text-amber-100'
    : 'mb-4 text-xl font-bold';

  return (
    <div className={rootLayoutClass}>
      <div className={sidebarClass}>
        <h2 className={listTitleClass}>{title}</h2>

        {loadingList ? (
          <p className="text-sm text-neutral-400">Loading...</p>
        ) : users.length === 0 ? (
          <p className="text-sm text-neutral-400">{emptyText}</p>
        ) : (
          <div className="space-y-2">
            {users.map((user) => {
              const unreadCount = unreadCounts[user.uid] || 0;

              return (
                <button
                  key={user.id}
                  onClick={() => {
                    onSelectUser(user);
                    onSetDeleteTarget(null);
                  }}
                  className={`flex w-full items-center justify-between rounded-xl p-4 text-left transition ${
                    selectedUser?.id === user.id
                      ? carersVisualTheme
                        ? 'bg-gradient-to-r from-amber-400 to-yellow-500 text-black shadow-lg shadow-amber-500/25'
                        : 'bg-white text-black'
                      : unreadCount > 0
                        ? carersVisualTheme
                          ? 'bg-rose-950/40 text-white ring-1 ring-rose-500/35 hover:bg-rose-950/55'
                          : 'bg-red-500/10 text-white ring-1 ring-red-500/30 hover:bg-red-500/20'
                        : carersVisualTheme
                          ? 'border border-white/10 bg-white/[0.04] text-amber-50/95 hover:border-amber-400/30 hover:bg-amber-500/10'
                          : 'bg-white/5 text-white hover:bg-white/10'
                  }`}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="truncate font-semibold">{getMaskedDisplayName(user)}</p>

                      {unreadCount > 0 && (
                        <span className="rounded-full bg-red-500 px-2 py-0.5 text-[10px] font-bold text-white">
                          {unreadCount > 9 ? '9+' : unreadCount}
                        </span>
                      )}
                    </div>

                    <div className="mt-1 flex items-center gap-2">
                      <span
                        className={`h-2 w-2 rounded-full ${
                          isUserOnline(user) ? 'bg-emerald-500' : 'bg-neutral-500'
                        }`}
                      />

                      <p
                        className={`text-xs ${
                          selectedUser?.id === user.id
                            ? 'text-black/60'
                            : unreadCount > 0
                              ? 'text-red-200'
                              : 'text-neutral-500'
                        }`}
                      >
                        {getOnlineLabel(user)}
                      </p>
                    </div>
                  </div>

                  {unreadCount > 0 && (
                    <span className="rounded-full bg-red-500 px-2 py-1 text-xs font-bold text-white">
                      New
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className={detailClass}>
        {!selectedUser ? (
          <div
            className={`flex h-full min-h-[12rem] items-center justify-center px-4 text-center ${
              carersVisualTheme ? 'text-amber-100/45' : 'text-neutral-500'
            }`}
          >
            {carersVisualTheme ? (
              <p>
                <span className="text-2xl">👆</span>
                <br />
                {selectText}
              </p>
            ) : (
              selectText
            )}
          </div>
        ) : (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="mb-6 flex flex-wrap justify-end gap-2 sm:gap-3">
                {onStartChat && (
                  <button
                    onClick={() => onStartChat(selectedUser)}
                    className={
                      carersVisualTheme
                        ? 'rounded-xl border border-amber-400/40 bg-amber-500/20 px-4 py-2.5 text-sm font-bold text-amber-50 hover:bg-amber-500/30'
                        : 'rounded-xl bg-white px-4 py-2 text-sm font-semibold text-black hover:bg-neutral-200'
                    }
                  >
                    {isChatOpen ? 'Close Chat' : 'Chat'}
                  </button>
                )}

                {onDelete && (
                  <button
                    onClick={() => onSetDeleteTarget(selectedUser)}
                    className={
                      carersVisualTheme
                        ? 'rounded-xl border border-rose-500/40 bg-rose-600/25 px-4 py-2.5 text-sm font-bold text-rose-100 hover:bg-rose-600/40'
                        : 'rounded-xl bg-red-500/20 px-4 py-2 text-sm font-semibold text-red-400 hover:bg-red-500/30'
                    }
                  >
                    Delete
                  </button>
                )}

                {onToggleBlock && (
                  <button
                    onClick={() => onToggleBlock(selectedUser)}
                    disabled={blocking}
                    className={
                      carersVisualTheme
                        ? 'rounded-xl border border-yellow-500/40 bg-yellow-500/15 px-4 py-2.5 text-sm font-bold text-yellow-100 hover:bg-yellow-500/25 disabled:cursor-not-allowed disabled:opacity-60'
                        : 'rounded-xl bg-yellow-500/20 px-4 py-2 text-sm font-semibold text-yellow-300 hover:bg-yellow-500/30 disabled:cursor-not-allowed disabled:opacity-60'
                    }
                  >
                    {blocking
                      ? 'Updating...'
                      : selectedUser.status === 'disabled'
                        ? 'Unblock'
                        : 'Block'}
                  </button>
                )}

                {onGiveFreeplay && (
                  <button
                    type="button"
                    onClick={() => onGiveFreeplay(selectedUser)}
                    disabled={
                      Boolean(freeplayGiveBusyUid) || selectedUser.status === 'disabled'
                    }
                    className={
                      carersVisualTheme
                        ? 'rounded-xl border border-fuchsia-400/40 bg-fuchsia-500/15 px-4 py-2.5 text-sm font-bold text-fuchsia-100 hover:bg-fuchsia-500/25 disabled:cursor-not-allowed disabled:opacity-60'
                        : 'rounded-xl border border-fuchsia-400/35 bg-fuchsia-500/15 px-4 py-2 text-sm font-semibold text-fuchsia-100 hover:bg-fuchsia-500/25 disabled:cursor-not-allowed disabled:opacity-60'
                    }
                  >
                    {freeplayGiveBusyUid === selectedUser.uid ? 'Sending...' : 'Give Freeplay'}
                  </button>
                )}

                {onCoadminSetPassword && (
                  <button
                    type="button"
                    onClick={() => onCoadminSetPassword(selectedUser)}
                    disabled={coadminCredentialsLoading}
                    className={
                      carersVisualTheme
                        ? 'rounded-xl border border-cyan-500/40 bg-cyan-500/15 px-4 py-2.5 text-sm font-bold text-cyan-100 hover:bg-cyan-500/25 disabled:cursor-not-allowed disabled:opacity-60'
                        : 'rounded-xl border border-cyan-500/30 bg-cyan-500/15 px-4 py-2 text-sm font-semibold text-cyan-200 hover:bg-cyan-500/25 disabled:cursor-not-allowed disabled:opacity-60'
                    }
                  >
                    {coadminCredentialsLoading ? 'Saving…' : 'Set password'}
                  </button>
                )}

                {onTogglePlayerPrivilege && selectedUser.role === 'staff' && (
                  <button
                    type="button"
                    onClick={() => onTogglePlayerPrivilege(selectedUser)}
                    disabled={playerPrivilegeLoadingUid === selectedUser.uid}
                    className={
                      selectedUser.canViewPlayers
                        ? 'rounded-xl border border-emerald-400/35 bg-emerald-500/20 px-4 py-2 text-sm font-semibold text-emerald-100 hover:bg-emerald-500/30 disabled:cursor-not-allowed disabled:opacity-60'
                        : 'rounded-xl border border-neutral-500/35 bg-neutral-700/35 px-4 py-2 text-sm font-semibold text-neutral-200 hover:bg-neutral-700/50 disabled:cursor-not-allowed disabled:opacity-60'
                    }
                  >
                    {playerPrivilegeLoadingUid === selectedUser.uid
                      ? 'Saving...'
                      : `Player Privilege: ${selectedUser.canViewPlayers ? 'ON' : 'OFF'}`}
                  </button>
                )}

                {onCoadminSetUsername && (
                  <button
                    type="button"
                    onClick={() => onCoadminSetUsername(selectedUser)}
                    disabled={coadminCredentialsLoading}
                    className={
                      carersVisualTheme
                        ? 'rounded-xl border border-sky-500/40 bg-sky-500/15 px-4 py-2.5 text-sm font-bold text-sky-100 hover:bg-sky-500/25 disabled:cursor-not-allowed disabled:opacity-60'
                        : 'rounded-xl border border-sky-500/30 bg-sky-500/15 px-4 py-2 text-sm font-semibold text-sky-200 hover:bg-sky-500/25 disabled:cursor-not-allowed disabled:opacity-60'
                    }
                  >
                    {coadminCredentialsLoading ? 'Saving…' : 'Change username'}
                  </button>
                )}
              </div>

              <h2
                className={`text-4xl font-bold capitalize ${
                  carersVisualTheme
                    ? 'bg-gradient-to-r from-white via-amber-100 to-amber-300 bg-clip-text text-transparent'
                    : ''
                }`}
              >
                {getMaskedDisplayName(selectedUser)}
              </h2>

              <div className="mt-4 space-y-3">
                <p
                  className={
                    carersVisualTheme ? 'text-sm text-amber-100/55' : 'text-sm text-neutral-400'
                  }
                >
                  Role:{' '}
                  <span className={carersVisualTheme ? 'text-amber-50' : 'text-white'}>
                    {selectedUser.role}
                  </span>
                </p>

                <p
                  className={
                    carersVisualTheme ? 'text-sm text-amber-100/55' : 'text-sm text-neutral-400'
                  }
                >
                  Status:{' '}
                  <span className={carersVisualTheme ? 'text-amber-50' : 'text-white'}>
                    {selectedUser.status}
                  </span>
                </p>

                {(onCoadminSetPassword || onCoadminSetUsername) && (
                  <p
                    className={
                      carersVisualTheme ? 'text-sm text-amber-100/70' : 'text-sm text-neutral-300'
                    }
                  >
                    Login username:{' '}
                    <span
                      className={
                        carersVisualTheme ? 'font-mono text-amber-50' : 'font-mono text-white'
                      }
                    >
                      {selectedUser.username}
                    </span>
                  </p>
                )}

                <div
                  className={`flex items-center gap-2 text-sm ${
                    carersVisualTheme ? 'text-amber-100/55' : 'text-neutral-400'
                  }`}
                >
                  <span>Online Status:</span>

                  <span
                    className={`h-2.5 w-2.5 rounded-full ${
                      isUserOnline(selectedUser) ? 'bg-emerald-500' : 'bg-neutral-500'
                    }`}
                  />

                  <span className={carersVisualTheme ? 'text-amber-50' : 'text-white'}>
                    {getOnlineLabel(selectedUser)}
                  </span>
                </div>

                {renderSelectedExtras && renderSelectedExtras(selectedUser)}
              </div>
            </div>

            {isChatOpen && (
              <div
                className={`mt-8 flex min-h-0 max-h-[min(64dvh,38rem)] flex-1 flex-col overflow-hidden rounded-2xl border sm:max-h-[min(70dvh,42rem)] ${
                  carersVisualTheme
                    ? 'border-amber-500/25 bg-black/45 shadow-inner shadow-black/40'
                    : 'border-white/10 bg-neutral-950/60'
                }`}
              >
                <div className="shrink-0 border-b border-white/10 p-4">
                  <div className="flex items-center gap-3">
                    <div className="relative">
                      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-neutral-700 font-bold">
                        {getAvatarLetter(selectedUser)}
                      </div>

                      <div
                        className={`absolute bottom-0 right-0 h-3 w-3 rounded-full ring-2 ring-neutral-950 ${
                          isUserOnline(selectedUser)
                            ? 'bg-emerald-500'
                            : 'bg-neutral-500'
                        }`}
                      />
                    </div>

                    <div>
                      <h3 className="font-semibold">
                        Chat with {getMaskedDisplayName(selectedUser)}
                      </h3>
                      <p className="text-xs text-neutral-400">
                        {getOnlineLabel(selectedUser)}
                      </p>
                    </div>
                  </div>
                </div>

                <div
                  ref={messagesScrollRef}
                  className="min-h-0 min-w-0 flex-1 space-y-3 overflow-y-auto overflow-x-hidden overscroll-contain p-4"
                >
                  {onLoadOlderMessages && hasMoreOlderMessages ? (
                    <div className="sticky top-0 z-10 -mt-1 mb-2 flex justify-center">
                      <button
                        type="button"
                        disabled={loadingOlderMessages}
                        onClick={() => onLoadOlderMessages()}
                        className={`rounded-full border px-4 py-2 text-xs font-semibold shadow-sm backdrop-blur-sm disabled:opacity-50 ${
                          carersVisualTheme
                            ? 'border-amber-500/35 bg-black/50 text-amber-100/90 hover:border-amber-400/50 hover:bg-black/60'
                            : 'border-white/15 bg-black/40 text-neutral-100 hover:border-white/25 hover:bg-black/55'
                        }`}
                      >
                        {loadingOlderMessages
                          ? 'Loading…'
                          : 'Load previous messages'}
                      </button>
                    </div>
                  ) : null}
                  {messages.length === 0 ? (
                    <div className="flex h-full items-center justify-center text-sm text-neutral-500">
                      No messages yet. Start the conversation.
                    </div>
                  ) : (
                    messages.map((msg) => (
                      <div
                        key={msg.id}
                        className={`flex ${
                          msg.sender === 'admin'
                            ? 'justify-end'
                            : 'justify-start'
                        }`}
                      >
                        <div
                          className={`max-w-[70%] rounded-xl px-4 py-2 ${
                            msg.sender === 'admin'
                              ? 'bg-white text-black'
                              : 'bg-neutral-800 text-white'
                          }`}
                        >
                          {msg.imageUrl && (
                            <button
                              type="button"
                              onClick={() => setOpenImageUrl(msg.imageUrl || null)}
                              className="mb-2 block overflow-hidden rounded-xl"
                            >
                              <img
                                src={msg.imageUrl}
                                alt="Chat image"
                                loading="lazy"
                                className="max-h-72 max-w-full rounded-xl object-cover"
                              />
                            </button>
                          )}

                          {msg.text && (
                            <p className="break-words text-sm">{msg.text}</p>
                          )}

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

                  {imagePreview && (
                    <div className="flex justify-end">
                      <div className="max-w-[70%] rounded-xl bg-white p-2 text-black">
                        <div className="relative">
                          <img
                            src={imagePreview}
                            alt="Preview"
                            loading="lazy"
                            className="max-h-60 rounded-xl object-cover"
                          />

                          {onClearImage && (
                            <button
                              type="button"
                              onClick={onClearImage}
                              className="absolute right-2 top-2 rounded-full bg-black/70 px-2 py-1 text-xs font-bold text-white"
                            >
                              ✕
                            </button>
                          )}
                        </div>
                        <p className="mt-1 text-xs text-black/60">
                          Image ready to send
                        </p>
                      </div>
                    </div>
                  )}
                </div>

                {onSendMessage && onMessageChange && (
                  <form
                    onSubmit={onSendMessage}
                    className="shrink-0 border-t border-white/10 p-4"
                  >
                    {showEmojis && (
                      <div className="mb-3 flex flex-wrap gap-2 rounded-2xl border border-white/10 bg-neutral-900 p-3">
                        {EMOJIS.map((emoji) => (
                          <button
                            key={emoji}
                            type="button"
                            onClick={() => handleEmojiClick(emoji)}
                            className="rounded-xl bg-white/5 px-3 py-2 text-xl hover:bg-white/10"
                          >
                            {emoji}
                          </button>
                        ))}
                      </div>
                    )}

                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      onChange={handleFileChange}
                      className="hidden"
                    />

                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setShowEmojis((value) => !value)}
                        className="rounded-xl bg-neutral-900 px-3 py-2 text-lg hover:bg-neutral-800"
                        title="Emoji"
                      >
                        😊
                      </button>

                      {onImageSelect && (
                        <button
                          type="button"
                          onClick={() => fileInputRef.current?.click()}
                          className="rounded-xl bg-neutral-900 px-3 py-2 text-lg hover:bg-neutral-800"
                          title="Send image"
                        >
                          📷
                        </button>
                      )}

                      <input
                        type="text"
                        value={newMessage}
                        onChange={(e) => onMessageChange(e.target.value)}
                        placeholder="Type a message..."
                        className="flex-1 rounded-xl bg-neutral-900 px-4 py-2 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:ring-1 focus:ring-white/30"
                      />

                      <button
                        type="submit"
                        disabled={sendingImage || (!newMessage.trim() && !imagePreview)}
                        className="rounded-xl bg-white px-4 py-2 text-sm font-semibold text-black disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {sendingImage ? 'Sending...' : 'Send'}
                      </button>
                    </div>
                  </form>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {deleteTarget && (
        <div
          onClick={() => onSetDeleteTarget(null)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm rounded-2xl border border-red-400 bg-red-600 p-6 text-white shadow-2xl"
          >
            <h3 className="text-xl font-bold">{deleteTitle}</h3>

            <p className="mt-2 text-sm text-red-100">
              {deleteMessage} {deleteTarget.username}?
            </p>

            <div className="mt-6 flex gap-3">
              <button
                onClick={onDelete}
                disabled={loading}
                className="flex-1 rounded-xl bg-white px-4 py-3 font-bold text-red-600 disabled:opacity-60"
              >
                {loading ? 'Deleting...' : 'Yes'}
              </button>

              <button
                onClick={() => onSetDeleteTarget(null)}
                className="flex-1 rounded-xl bg-black/20 px-4 py-3 font-semibold text-white"
              >
                No
              </button>
            </div>
          </div>
        </div>
      )}

      {openImageUrl && (
        <div
          onClick={() => setOpenImageUrl(null)}
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4"
        >
          <img
            src={openImageUrl}
            alt="Full chat image"
            loading="lazy"
            className="max-h-[90vh] max-w-[90vw] rounded-2xl object-contain"
          />
        </div>
      )}
    </div>
  );
}
