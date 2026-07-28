'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { collection, doc, getDoc, getDocs, query, where } from 'firebase/firestore';

import {
  readErrorMessage,
  shouldSuppressInternalSqlFirestoreUiError,
} from '@/lib/client/sqlFirestoreError';

import ProtectedRoute from '../../components/auth/ProtectedRoute';
import LogoutButton from '../../components/auth/LogoutButton';
import DashboardView from '../../components/admin/DashboardView';
import ReachOutView from '../../components/admin/ReachOutView';
import RoleSidebarLayout, { type NavigationItem } from '@/components/navigation/RoleSidebarLayout';

import { auth, db } from '@/lib/firebase/client';
import { belongsToCoadmin, getCurrentUserCoadminUid } from '@/lib/coadmin/scope';
import {
  blockPlayer,
  getPlayers,
  getStaff,
  PlayerUser,
  StaffUser,
  unblockPlayer,
} from '@/features/users/adminUsers';
import {
  listenToUnreadCounts,
  mapFirestoreChatToDisplay,
  markConversationAsRead,
  sendChatMessage,
} from '@/features/messages/chatMessages';
import { getCachedSessionUser, getSessionUserOnce } from '@/features/auth/sessionUser';
import { usePaginatedChatMessages } from '@/features/messages/usePaginatedChatMessages';
import { CashoutClaimConflictError } from '@/lib/cashouts/playerCashoutClaimConflict';
import {
  CarerEscalationAlert,
  dismissCarerEscalationAlertForCurrentUser,
  listenToCarerEscalationAlertsByCoadmin,
} from '@/features/games/carerTasks';
import {
  completePlayerCashoutTask,
  declinePlayerCashoutTaskForCurrentHandler,
  getPlayerCashoutTaskCountdown,
  getPlayerCashoutPaymentDisplay,
  listenAllPlayerCashoutTasks,
  listenStaffCashoutTaskLifecycle,
  PlayerCashoutTask,
  releasePlayerCashoutTask,
  startPlayerCashoutTask,
} from '@/features/cashouts/playerCashoutTasks';
import {
  getPlayerRiskSnapshot,
  listenPlayerRiskSnapshotsByCoadmin,
  markRiskReviewed,
  PlayerRiskSnapshot,
  setPlayerBonusBlock,
  setPlayerTransferBlock,
} from '@/features/risk/playerRisk';
import {
  heartbeatShiftSession,
  endShiftSession,
  startShiftSession,
} from '@/features/shifts/userShifts';
import { usePresenceOnlineMap } from '@/features/presence/userPresence';
import { OnlineIndicator } from '@/components/presence/OnlineIndicator';
import {
  logStaffCashoutAlertClaimReceived,
  useStaffCashoutAlerts,
} from '@/lib/pwa/staffCashoutAlert';

import { giveFreeplayGift } from '@/features/freeplay/coadminFreeplay';
import {
  getMyStaffWallet,
  loadPlayerCoinsFromStaffWallet,
  type StaffWalletBalance,
} from '@/features/users/staffWallet';
import {
  hasVendorAwareness,
  type VendorAwareness,
} from '@/features/vendors/vendorAwareness';
import { AdminUser, ChatMessage } from '../../components/admin/types';

type StaffView =
  | 'dashboard'
  | 'view-tasks'
  | 'view-players'
  | 'reach-out';

type StaffSessionContext = {
  uid: string;
  role: string;
  coadminUid: string;
};

const STAFF_PLAYER_CHAT_PAGE_SIZE = 25;
const CHAT_BOTTOM_THRESHOLD_PX = 80;
const STAFF_FREEPLAY_COST_COINS = 3;

function isNearChatBottom(el: HTMLElement | null) {
  if (!el) {
    return true;
  }
  return el.scrollTop + el.clientHeight >= el.scrollHeight - CHAT_BOTTOM_THRESHOLD_PX;
}

function scrollChatToBottom(
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

function subscribeStaffMobileViewport(onChange: () => void) {
  const media = window.matchMedia('(max-width: 1023px)');
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

function getStaffMobileViewportSnapshot() {
  return window.matchMedia('(max-width: 1023px)').matches;
}

function getStaffMobileViewportServerSnapshot() {
  return false;
}

function sortByNewest<T extends { createdAt?: any }>(list: T[]) {
  return [...list].sort((a: any, b: any) => {
    const aTime = getDateMs(a.createdAt);
    const bTime = getDateMs(b.createdAt);
    return bTime - aTime;
  });
}

function getDateMs(value: unknown) {
  if (!value) {
    return 0;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  const maybe = value as { toMillis?: () => number; toDate?: () => Date; getTime?: () => number; seconds?: number };
  if (typeof maybe.toMillis === 'function') {
    return maybe.toMillis();
  }
  if (typeof maybe.toDate === 'function') {
    return maybe.toDate().getTime();
  }
  if (typeof maybe.getTime === 'function') {
    return maybe.getTime();
  }
  if (typeof maybe.seconds === 'number') {
    return maybe.seconds * 1000;
  }
  return 0;
}

function formatDateTime(value: unknown, fallback = 'N/A') {
  const ms = getDateMs(value);
  return ms ? new Date(ms).toLocaleString() : fallback;
}

function formatUsdFromNpr(value: number) {
  return `USD ${Math.round(Number(value || 0)).toLocaleString()}`;
}

function renderVendorTaskBadge(vendor: VendorAwareness | null | undefined) {
  if (vendor?.configured === false) {
    return (
      <div className="mt-2 inline-flex rounded-full border border-amber-300/20 bg-amber-300/10 px-2.5 py-1 text-xs text-amber-100/85">
        Vendor data unavailable
      </div>
    );
  }
  if (!hasVendorAwareness(vendor)) {
    return (
      <div className="mt-2 inline-flex rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-xs text-neutral-400">
        Unassigned player
      </div>
    );
  }
  return (
    <div className="mt-2 inline-flex max-w-full flex-wrap items-center gap-1.5 rounded-full border border-cyan-300/20 bg-cyan-300/10 px-2.5 py-1 text-xs text-cyan-50/85">
      <span className="font-mono text-cyan-100">[{vendor.code}]</span>
      <span className="truncate">Vendor: {vendor.name}</span>
      <span className="text-cyan-100/55">· {vendor.status}</span>
    </div>
  );
}

function renderVendorDetailSection(vendor: VendorAwareness | null | undefined) {
  if (vendor?.configured === false) {
    return (
      <div className="rounded-2xl border border-amber-300/20 bg-amber-300/10 p-4">
        <p className="text-xs font-black uppercase tracking-wide text-amber-100">Vendor</p>
        <p className="mt-2 text-sm font-semibold text-amber-100">Vendor data unavailable</p>
      </div>
    );
  }
  if (!hasVendorAwareness(vendor)) {
    return (
      <div className="rounded-2xl border border-white/10 bg-black/25 p-4">
        <p className="text-xs font-black uppercase tracking-wide text-neutral-400">Vendor</p>
        <p className="mt-2 text-sm font-semibold text-neutral-300">Unassigned player</p>
      </div>
    );
  }
  return (
    <div className="rounded-2xl border border-cyan-300/20 bg-cyan-300/10 p-4">
      <p className="text-xs font-black uppercase tracking-wide text-cyan-100">Vendor</p>
      <div className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
        <p className="text-cyan-100/70">
          Name <span className="block font-semibold text-white">{vendor.name}</span>
        </p>
        <p className="text-cyan-100/70">
          Vendor Code <span className="block font-mono font-semibold text-white">{vendor.code}</span>
        </p>
        <p className="text-cyan-100/70">
          Status <span className="block font-semibold text-white">{vendor.status}</span>
        </p>
        <p className="text-cyan-100/70">
          Linked Staff <span className="block font-semibold text-white">{vendor.linkedStaffUid || 'Not linked'}</span>
          <span className="block text-[11px] text-cyan-100/55">Reporting Only</span>
        </p>
        <p className="text-cyan-100/70">
          Ownership Date <span className="block font-semibold text-white">{formatDateTime(vendor.ownershipDate, '—')}</span>
        </p>
      </div>
    </div>
  );
}

function staffRiskErrorMessage(error: unknown) {
  if (shouldSuppressInternalSqlFirestoreUiError(error)) {
    return 'Risk data is not available in SQL mode yet.';
  }
  return readErrorMessage(error) || 'Failed to load player risk data.';
}

function getRiskTone(level: string, score: number) {
  if (level === 'high') {
    if (score >= 12) return 'text-orange-500';
    if (score >= 10) return 'text-orange-400';
    return 'text-orange-300';
  }
  if (level === 'medium') return 'text-amber-300';
  return 'text-emerald-300';
}

function getRiskCardTone(level: string, score: number) {
  if (level === 'high') {
    if (score >= 12) {
      return 'border-orange-500/70 bg-orange-500/30 hover:bg-orange-500/35';
    }
    if (score >= 10) {
      return 'border-orange-500/55 bg-orange-500/22 hover:bg-orange-500/28';
    }
    return 'border-orange-400/45 bg-orange-400/16 hover:bg-orange-400/24';
  }
  return 'border-rose-300/25 bg-black/30 hover:bg-black/45';
}

function getRiskPlayerCardClass(level: string, score: number, hasUnread: boolean) {
  const unreadRing = hasUnread ? ' ring-1 ring-red-500/40' : '';

  if (level === 'high') {
    if (score >= 12) {
      return `rounded-2xl border border-orange-500/75 bg-orange-500/32 p-5${unreadRing}`;
    }
    if (score >= 10) {
      return `rounded-2xl border border-orange-500/60 bg-orange-500/24 p-5${unreadRing}`;
    }
    return `rounded-2xl border border-orange-400/45 bg-orange-400/16 p-5${unreadRing}`;
  }

  if (level === 'medium') {
    return `rounded-2xl border border-amber-400/35 bg-amber-400/10 p-5${unreadRing}`;
  }

  return hasUnread
    ? 'rounded-2xl border border-red-500/40 bg-red-500/10 p-5 ring-1 ring-red-500/30'
    : 'rounded-2xl border border-white/10 bg-white/5 p-5';
}

function isAutoDismissStaffSuccessMessage(value: string) {
  const message = value.trim();
  if (!message) {
    return false;
  }
  if (/^(failed|failure|error|unable|could not|not enough|enter |select |session )/i.test(message)) {
    return false;
  }
  return (
    /^(loaded|created|saved|sent|claimed|completed|released|declined|approved|dismissed|processed|updated|deleted|unblocked|blocked)/i.test(
      message
    ) ||
    /\bsuccessfully\b/i.test(message) ||
    /\balready processed\b/i.test(message)
  );
}

export default function StaffPage() {
  const isMobilePlayerWorkspace = useSyncExternalStore(
    subscribeStaffMobileViewport,
    getStaffMobileViewportSnapshot,
    getStaffMobileViewportServerSnapshot
  );
  const [activeView, setActiveView] = useState<StaffView>('dashboard');
  const [creatorRole, setCreatorRole] = useState<'admin' | 'coadmin' | null>(null);
  const [players, setPlayers] = useState<PlayerUser[]>([]);
  const [chatUsers, setChatUsers] = useState<AdminUser[]>([]);
  const [selectedChatUser, setSelectedChatUser] = useState<AdminUser | null>(null);
  const [selectedViewPlayer, setSelectedViewPlayer] = useState<PlayerUser | null>(null);
  const [selectedPlayerChatUser, setSelectedPlayerChatUser] = useState<PlayerUser | null>(null);
  const [playerSearchQuery, setPlayerSearchQuery] = useState('');
  const [newMessage, setNewMessage] = useState('');
  const staffReachOutScrollRef = useRef<HTMLDivElement | null>(null);
  const staffPlayerScrollRef = useRef<HTMLDivElement | null>(null);
  const staffPlayerMessagesEndRef = useRef<HTMLDivElement | null>(null);
  const staffPlayerNearBottomRef = useRef(true);
  const lastRenderedStaffAgentReadRef = useRef('');
  const lastRenderedStaffPlayerReadRef = useRef('');
  const [newPlayerMessage, setNewPlayerMessage] = useState('');
  const [showStaffPlayerNewMessagePill, setShowStaffPlayerNewMessagePill] = useState(false);
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});
  const [message, setMessage] = useState('');
  const [loadingList, setLoadingList] = useState(false);
  const [staffWallet, setStaffWallet] = useState<StaffWalletBalance | null>(null);
  const [staffWalletLoading, setStaffWalletLoading] = useState(false);
  const [staffWalletLoadAmountInput, setStaffWalletLoadAmountInput] = useState('');
  const [staffWalletLoadBusy, setStaffWalletLoadBusy] = useState(false);
  const [staffWalletLoadFormUid, setStaffWalletLoadFormUid] = useState<string | null>(null);
  const [latestCarerEscalation, setLatestCarerEscalation] =
    useState<CarerEscalationAlert | null>(null);
  const [showCarerEscalationSplash, setShowCarerEscalationSplash] = useState(false);
  const [recentCarerEscalations, setRecentCarerEscalations] = useState<
    CarerEscalationAlert[]
  >([]);
  const [dismissedCarerEscalationIds, setDismissedCarerEscalationIds] = useState<
    string[]
  >([]);
  const [pendingCashoutTasks, setPendingCashoutTasks] = useState<PlayerCashoutTask[]>([]);
  const [activeCashoutTasks, setActiveCashoutTasks] = useState<PlayerCashoutTask[]>([]);
  const [completedCashoutTasks, setCompletedCashoutTasks] = useState<PlayerCashoutTask[]>([]);
  const [playerCashoutTasksLoading, setPlayerCashoutTasksLoading] = useState(true);
  const [cashoutTasksError, setCashoutTasksError] = useState<string | null>(null);
  const pendingCashoutAlertIds = useMemo(
    () => pendingCashoutTasks.map((task) => task.id),
    [pendingCashoutTasks]
  );
  const cashoutAlerts = useStaffCashoutAlerts(pendingCashoutAlertIds);
  const [staffSession, setStaffSession] = useState<StaffSessionContext | null>(null);
  const [playerCashoutTaskLoadingId, setPlayerCashoutTaskLoadingId] = useState<string | null>(
    null
  );
  const [staffAuthUid, setStaffAuthUid] = useState('');
  const [countdownTick, setCountdownTick] = useState(0);
  const [riskSnapshots, setRiskSnapshots] = useState<PlayerRiskSnapshot[]>([]);
  const [selectedRiskSnapshot, setSelectedRiskSnapshot] = useState<PlayerRiskSnapshot | null>(null);
  const [showRiskPanel, setShowRiskPanel] = useState(false);
  const [riskActionLoading, setRiskActionLoading] = useState<string | null>(null);
  const latestCarerEscalationIdRef = useRef<string | null>(null);
  const hasSeenCarerEscalationSnapshotRef = useRef(false);
  const previousPlayerChatUnreadRef = useRef(0);
  const hasSyncedPlayerChatUnreadRef = useRef(false);
  const shiftSessionIdRef = useRef<string | null>(null);
  const refetchCashoutTasksRef = useRef<(() => void) | null>(null);
  const freeplayGiveInFlightRef = useRef(new Set<string>());
  const [playerBlockActionUid, setPlayerBlockActionUid] = useState<string | null>(null);
  const [freeplayGiveTargetUid, setFreeplayGiveTargetUid] = useState<string | null>(null);

  const pagedStaffAgentChat = usePaginatedChatMessages(selectedChatUser?.uid ?? null, {
    scrollContainerRef: staffReachOutScrollRef,
  });
  const pagedStaffPlayerChat = usePaginatedChatMessages(selectedPlayerChatUser?.uid ?? null, {
    recentWindowSize: STAFF_PLAYER_CHAT_PAGE_SIZE,
    pageSize: STAFF_PLAYER_CHAT_PAGE_SIZE,
    scrollContainerRef: staffPlayerScrollRef,
  });

  const staffChatActorUid = staffAuthUid || getCachedSessionUser()?.uid || auth.currentUser?.uid || '';

  const messages: ChatMessage[] = useMemo(() => {
    return mapFirestoreChatToDisplay(pagedStaffAgentChat.items, staffChatActorUid);
  }, [pagedStaffAgentChat.items, staffChatActorUid]);

  const playerMessages: ChatMessage[] = useMemo(() => {
    return mapFirestoreChatToDisplay(pagedStaffPlayerChat.items, staffChatActorUid);
  }, [pagedStaffPlayerChat.items, staffChatActorUid]);

  useLayoutEffect(() => {
    if (!selectedChatUser || messages.length === 0) {
      return;
    }
    const lastMessageId = messages[messages.length - 1]?.id || '';
    const readKey = `${selectedChatUser.uid}:${lastMessageId}`;
    if (lastRenderedStaffAgentReadRef.current === readKey) {
      return;
    }
    lastRenderedStaffAgentReadRef.current = readKey;
    const frameId = window.requestAnimationFrame(() => {
      void markConversationAsRead(selectedChatUser.uid);
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [messages, selectedChatUser]);

  useLayoutEffect(() => {
    if (!selectedPlayerChatUser) {
      return;
    }
    if (playerMessages.length === 0) {
      return;
    }
    const shouldPin = staffPlayerNearBottomRef.current;
    if (shouldPin) {
      scrollChatToBottom(staffPlayerScrollRef.current, staffPlayerMessagesEndRef.current, 'auto');
      setShowStaffPlayerNewMessagePill(false);
    } else {
      setShowStaffPlayerNewMessagePill(true);
    }

    const lastMessageId = playerMessages[playerMessages.length - 1]?.id || '';
    const readKey = `${selectedPlayerChatUser.uid}:${lastMessageId}`;
    if (lastRenderedStaffPlayerReadRef.current === readKey) {
      return;
    }
    lastRenderedStaffPlayerReadRef.current = readKey;
    const frameId = window.requestAnimationFrame(() => {
      void markConversationAsRead(selectedPlayerChatUser.uid);
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [playerMessages, selectedPlayerChatUser]);

  const reachOutUnread = useMemo(
    () => chatUsers.reduce((total, user) => total + (unreadCounts[user.uid] || 0), 0),
    [chatUsers, unreadCounts]
  );

  const reachOutUnreadCounts = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(unreadCounts).filter(([uid]) =>
          chatUsers.some((user) => user.uid === uid)
        )
      ),
    [chatUsers, unreadCounts]
  );
  const visibleRecentCarerEscalations = recentCarerEscalations.filter(
    (alert) => !dismissedCarerEscalationIds.includes(alert.id)
  );
  const currentUserUid = staffAuthUid || auth.currentUser?.uid || '';
  const dashboardStaffWalletCoinBalance = Math.max(
    0,
    Math.floor(Number(staffWallet?.balanceCoin || 0))
  );
  const riskyPlayers = useMemo(
    () => riskSnapshots.filter((entry) => entry.riskLevel !== 'low').slice(0, 10),
    [riskSnapshots]
  );
  const riskByPlayerUid = useMemo(
    () => new Map(riskSnapshots.map((entry) => [entry.playerUid, entry])),
    [riskSnapshots]
  );
  const playerChatUnreadTotal = useMemo(
    () => players.reduce((sum, player) => sum + (unreadCounts[player.uid] || 0), 0),
    [players, unreadCounts]
  );

  useEffect(() => {
    if (!isAutoDismissStaffSuccessMessage(message)) {
      return;
    }

    const timer = window.setTimeout(() => {
      setMessage((current) => (current === message ? '' : current));
    }, 3000);

    return () => window.clearTimeout(timer);
  }, [message]);

  useEffect(() => {
    const returnedMessages = pagedStaffPlayerChat.items.length;
    const visibleMessages = playerMessages.length;
    console.info('[CHAT_MESSAGES_RENDER]', {
      stateMessagesLength: returnedMessages,
      visibleMessagesLength: visibleMessages,
      currentUid: staffChatActorUid,
      currentRole: creatorRole,
      selectedPeerUid: selectedPlayerChatUser?.uid || null,
    });
    if (returnedMessages > 0 && visibleMessages === 0) {
      console.warn('[CHAT_MESSAGES_HIDDEN_BY_UI_FILTER]', {
        returnedMessages,
        currentUid: staffChatActorUid,
        selectedPeerUid: selectedPlayerChatUser?.uid || null,
      });
    }
    const peerUnread = selectedPlayerChatUser
      ? unreadCounts[selectedPlayerChatUser.uid] || 0
      : 0;
    if (peerUnread > 0 && returnedMessages === 0) {
      console.warn('[CHAT_INCONSISTENT_UNREAD_NO_MESSAGES]', {
        peerUid: selectedPlayerChatUser?.uid || null,
        unreadCount: peerUnread,
        currentUid: staffChatActorUid,
      });
    }
    console.info('[MESSAGES_RENDER_FILTER]', {
      totalMessages: returnedMessages,
      visibleMessages,
      currentRole: creatorRole,
      staffUid: staffAuthUid,
      selectedPeerUid: selectedPlayerChatUser?.uid || null,
      activeView,
      unreadPeerCount: Object.keys(unreadCounts).length,
      playerCount: players.length,
      playerChatUnreadTotal,
    });
  }, [
    pagedStaffPlayerChat.items.length,
    playerMessages.length,
    staffChatActorUid,
    creatorRole,
    staffAuthUid,
    selectedPlayerChatUser?.uid,
    activeView,
    unreadCounts,
    players.length,
    playerChatUnreadTotal,
  ]);

  const playPlayerMessageSound = useCallback(() => {
    const audio = new Audio('/urgency-sound.mp3');
    audio.volume = 0.6;
    void audio.play().catch(() => undefined);
  }, []);

  const playersSortedByUnread = useMemo(() => {
    const latestKnownActivityByPlayerUid = new Map<string, number>();
    if (selectedPlayerChatUser?.uid && playerMessages.length > 0) {
      latestKnownActivityByPlayerUid.set(
        selectedPlayerChatUser.uid,
        Math.max(...playerMessages.map((msg) => msg.timestamp.getTime()))
      );
    }

    return [...players].sort((a, b) => {
      const unreadB = unreadCounts[b.uid] || 0;
      const unreadA = unreadCounts[a.uid] || 0;
      if (unreadB !== unreadA) {
        return unreadB - unreadA;
      }
      // TODO: replace this limited client-known activity fallback with conversation summary
      // metadata from SQL so every row can sort by latest message like Messenger.
      const activityB = latestKnownActivityByPlayerUid.get(b.uid) || 0;
      const activityA = latestKnownActivityByPlayerUid.get(a.uid) || 0;
      if (activityB !== activityA) {
        return activityB - activityA;
      }
      const aTime = (a as { createdAt?: { toDate?: () => Date } }).createdAt?.toDate?.()?.getTime() || 0;
      const bTime = (b as { createdAt?: { toDate?: () => Date } }).createdAt?.toDate?.()?.getTime() || 0;
      return bTime - aTime;
    });
  }, [players, unreadCounts, selectedPlayerChatUser?.uid, playerMessages]);

  const visiblePlayersForStaffList = useMemo(() => {
    const queryText = playerSearchQuery.trim().toLowerCase();
    if (!queryText) {
      return playersSortedByUnread;
    }

    return playersSortedByUnread.filter((player) => {
      const searchableValues = [
        player.username,
        (player as { displayName?: string | null }).displayName,
        (player as { name?: string | null }).name,
        player.uid,
      ];
      return searchableValues.some((value) =>
        String(value || '').toLowerCase().includes(queryText)
      );
    });
  }, [playerSearchQuery, playersSortedByUnread]);

  const staffPresenceUids = useMemo(() => {
    const s = new Set<string>();
    for (const p of players) s.add(p.uid);
    for (const u of chatUsers) s.add(u.uid);
    return Array.from(s);
  }, [players, chatUsers]);
  const staffOnlineByUid = usePresenceOnlineMap(staffPresenceUids);

  useEffect(() => {
    if (loadingList) {
      return;
    }

    if (!hasSyncedPlayerChatUnreadRef.current) {
      hasSyncedPlayerChatUnreadRef.current = true;
      previousPlayerChatUnreadRef.current = playerChatUnreadTotal;
      return;
    }

    if (playerChatUnreadTotal > previousPlayerChatUnreadRef.current) {
      playPlayerMessageSound();
      if (
        typeof document !== 'undefined' &&
        document.hidden &&
        typeof window !== 'undefined' &&
        'Notification' in window &&
        window.Notification?.permission === 'granted'
      ) {
        try {
          const delta = playerChatUnreadTotal - previousPlayerChatUnreadRef.current;
          new window.Notification('New message from player', {
            body: delta === 1 ? 'You have a new unread message.' : `${delta} new unread messages.`,
            tag: 'staff-player-chat',
          });
        } catch {
          // ignore
        }
      }
    }

    previousPlayerChatUnreadRef.current = playerChatUnreadTotal;
  }, [playPlayerMessageSound, playerChatUnreadTotal, loadingList]);

  async function loadPlayers() {
    setLoadingList(true);

    try {
      const coadminUid = await getCurrentUserCoadminUid();
      const allPlayers = await getPlayers();
      const relatedPlayers = allPlayers.filter((player) =>
        belongsToCoadmin(player, coadminUid)
      );
      setPlayers(sortByNewest(relatedPlayers));
      void loadMyStaffWalletBalance();
    } catch (error: any) {
      setMessage(error.message || 'Failed to load players.');
    } finally {
      setLoadingList(false);
    }
  }

  async function loadMyStaffWalletBalance() {
    setStaffWalletLoading(true);
    try {
      setStaffWallet(await getMyStaffWallet());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to load Staff Wallet.');
    } finally {
      setStaffWalletLoading(false);
    }
  }

  async function loadCreatorRole() {
    try {
      const currentUser = auth.currentUser;

      if (!currentUser) {
        setCreatorRole(null);
        return;
      }

      const currentUserSnap = await getDoc(doc(db, 'users', currentUser.uid));

      if (!currentUserSnap.exists()) {
        setCreatorRole(null);
        return;
      }

      const currentUserData = currentUserSnap.data() as {
        createdBy?: string | null;
      };
      const creatorUid = currentUserData.createdBy ? String(currentUserData.createdBy) : '';

      if (!creatorUid) {
        setCreatorRole(null);
        return;
      }

      const creatorSnap = await getDoc(doc(db, 'users', creatorUid));

      if (!creatorSnap.exists()) {
        setCreatorRole(null);
        return;
      }

      const creatorData = creatorSnap.data() as { role?: string };
      const nextRole = String(creatorData.role || '').toLowerCase();

      if (nextRole === 'admin' || nextRole === 'coadmin') {
        setCreatorRole(nextRole);
        return;
      }

      setCreatorRole(null);
    } catch {
      setCreatorRole(null);
    }
  }

  async function loadReachOutUsers() {
    try {
      const currentUser = auth.currentUser;

      if (!currentUser) {
        setChatUsers([]);
        return;
      }

      if (creatorRole === 'admin') {
        const [adminsSnap, coadminsSnap] = await Promise.all([
          getDocs(query(collection(db, 'users'), where('role', '==', 'admin'))),
          getDocs(query(collection(db, 'users'), where('role', '==', 'coadmin'))),
        ]);

        const admins = adminsSnap.docs.map((docSnap) => ({
          id: docSnap.id,
          ...(docSnap.data() as Omit<AdminUser, 'id'>),
        })) as AdminUser[];
        const coadmins = coadminsSnap.docs.map((docSnap) => ({
          id: docSnap.id,
          ...(docSnap.data() as Omit<AdminUser, 'id'>),
        })) as AdminUser[];

        setChatUsers(sortByNewest([...admins, ...coadmins]));
      } else {
        const coadminUid = await getCurrentUserCoadminUid();
        const [coadminSnap, allStaff] = await Promise.all([
          getDoc(doc(db, 'users', coadminUid)),
          getStaff(),
        ]);

        const siblingStaff = allStaff.filter(
          (staff: StaffUser) =>
            belongsToCoadmin(staff, coadminUid) && staff.uid !== currentUser.uid
        );

        const scopedUsers: AdminUser[] = [...siblingStaff];

        if (coadminSnap.exists()) {
          scopedUsers.unshift({
            id: coadminSnap.id,
            ...(coadminSnap.data() as Omit<AdminUser, 'id'>),
          });
        }

        setChatUsers(scopedUsers);
      }
    } catch (error: any) {
      setMessage(error.message || 'Failed to load chat users.');
    }
  }

  useEffect(() => {
    void loadCreatorRole();
  }, []);

  useEffect(() => {
    hasSyncedPlayerChatUnreadRef.current = false;
    previousPlayerChatUnreadRef.current = 0;
  }, [creatorRole]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setCountdownTick((tick) => tick + 1);
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    void loadPlayers();
    void loadReachOutUsers();
    const unsubscribe = listenToUnreadCounts(setUnreadCounts);
    return () => unsubscribe();
  }, [creatorRole]);

  useEffect(() => {
    let isCancelled = false;

    async function resolveStaffAuth() {
      try {
        const cached = getCachedSessionUser();
        const sessionUser = cached?.uid ? cached : await getSessionUserOnce();
        if (isCancelled || !sessionUser?.uid) {
          return;
        }

        const role = String(sessionUser.role || '').trim().toLowerCase();
        const coadminUid =
          role === 'coadmin'
            ? String(sessionUser.uid || '').trim()
            : String(sessionUser.coadminUid || '').trim();

        console.info('[STAFF_CASHOUT_TASKS] authResolved', {
          uid: sessionUser.uid,
          role,
          coadminUid: coadminUid || null,
        });

        if (!isCancelled) {
          setStaffSession({
            uid: sessionUser.uid,
            role,
            coadminUid,
          });
          setStaffAuthUid(sessionUser.uid);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[STAFF_CASHOUT_TASKS] fetchError', {
          phase: 'authResolved',
          error: message,
        });
        if (!isCancelled) {
          setCashoutTasksError(message);
          setPlayerCashoutTasksLoading(false);
        }
      }
    }

    void resolveStaffAuth();

    return () => {
      isCancelled = true;
    };
  }, []);

  useEffect(() => {
    console.info('[STAFF_CASHOUT_TASKS] render', {
      pendingCount: pendingCashoutTasks.length,
      activeCount: activeCashoutTasks.length,
      completedCount: completedCashoutTasks.length,
    });
  }, [pendingCashoutTasks.length, activeCashoutTasks.length, completedCashoutTasks.length]);

  useEffect(() => {
    let isCancelled = false;
    let disposeListener: (() => void) | undefined;

    async function startPlayerCashoutTaskListener() {
      try {
        if (!staffSession?.uid) {
          return;
        }

        setPlayerCashoutTasksLoading(true);
        setCashoutTasksError(null);
        console.info('[STAFF_CASHOUT_TASKS] fetchStart', {
          staffUid: staffSession.uid,
          staffCoadminUid: staffSession.coadminUid || null,
          creatorRole,
        });

        if (creatorRole === 'admin') {
          const adminUnsubscribe = listenAllPlayerCashoutTasks(
            (tasks) => {
              if (!isCancelled) {
                const pending = tasks.filter(
                  (task) => task.status === 'pending' && !task.assignedHandlerUid
                );
                const active = tasks.filter(
                  (task) =>
                    task.status === 'in_progress' &&
                    task.assignedHandlerUid === staffSession.uid
                );
                const completed = tasks.filter(
                  (task) =>
                    task.status === 'completed' &&
                    task.assignedHandlerUid === staffSession.uid
                );
                setPendingCashoutTasks(pending);
                setActiveCashoutTasks(active);
                setCompletedCashoutTasks(completed);
                setPlayerCashoutTasksLoading(false);
                console.info('[STAFF_CASHOUT_TASKS] pendingLoaded', { count: pending.length });
                console.info('[STAFF_CASHOUT_TASKS] activeLoaded', { count: active.length });
                console.info('[STAFF_CASHOUT_TASKS] completedLoaded', { count: completed.length });
              }
            },
            (error) => {
              if (!isCancelled) {
                setPlayerCashoutTasksLoading(false);
                setCashoutTasksError(error.message);
                console.error('[STAFF_CASHOUT_TASKS] fetchError', {
                  staffUid: staffSession.uid,
                  scope: 'all',
                  error: error.message,
                });
                setMessage(error.message || 'Failed to listen for player cashout tasks.');
              }
            }
          );
          disposeListener = adminUnsubscribe;
          refetchCashoutTasksRef.current = null;
          return;
        }

        const coadminUid = staffSession.coadminUid || (await getCurrentUserCoadminUid());

        if (isCancelled) {
          return;
        }

        if (!coadminUid) {
          setPendingCashoutTasks([]);
          setActiveCashoutTasks([]);
          setCompletedCashoutTasks([]);
          setPlayerCashoutTasksLoading(false);
          setCashoutTasksError('No coadmin assigned to this staff account.');
          return;
        }

        const lifecycle = listenStaffCashoutTaskLifecycle(coadminUid, {
          onPendingChange: (tasks) => {
            if (!isCancelled) {
              setPendingCashoutTasks(tasks);
              setPlayerCashoutTasksLoading(false);
            }
          },
          onActiveChange: (tasks) => {
            if (!isCancelled) {
              setActiveCashoutTasks(tasks);
              setPlayerCashoutTasksLoading(false);
            }
          },
          onCompletedChange: (tasks) => {
            if (!isCancelled) {
              setCompletedCashoutTasks(tasks);
              setPlayerCashoutTasksLoading(false);
              console.info('[STAFF_COMPLETED_TASKS] loaded', { count: tasks.length });
            }
          },
          onError: (error) => {
            if (!isCancelled) {
              setPlayerCashoutTasksLoading(false);
              setCashoutTasksError(error.message);
              console.error('[STAFF_CASHOUT_TASKS] fetchError', {
                staffUid: staffSession.uid,
                staffCoadminUid: coadminUid,
                error: error.message,
              });
              setMessage(error.message || 'Failed to listen for player cashout tasks.');
            }
          },
        });
        disposeListener = lifecycle.dispose;
        refetchCashoutTasksRef.current = () => lifecycle.refetchNow();
      } catch (error: any) {
        if (!isCancelled) {
          setPlayerCashoutTasksLoading(false);
          setCashoutTasksError(error?.message || 'Failed to start player cashout task listener.');
          console.error('[STAFF_CASHOUT_TASKS] fetchError', {
            staffUid: staffSession?.uid || null,
            error: error?.message || String(error),
          });
          setMessage(error.message || 'Failed to start player cashout task listener.');
        }
      }
    }

    void startPlayerCashoutTaskListener();

    return () => {
      isCancelled = true;
      refetchCashoutTasksRef.current = null;
      disposeListener?.();
    };
  }, [creatorRole, staffSession]);

  useEffect(() => {
    let isCancelled = false;
    let unsubscribe: (() => void) | undefined;

    async function startTransferRequestListener() {
      // Pending transfer request approval flow is disabled. Staff can view player risk and cashout ledger only.
      return;
    }

    void startTransferRequestListener();

    return () => {
      isCancelled = true;
      unsubscribe?.();
    };
  }, [creatorRole]);

  useEffect(() => {
    let isCancelled = false;
    let unsubscribe: (() => void) | undefined;

    async function startRiskSnapshotListener() {
      try {
        if (creatorRole === 'admin') {
          unsubscribe = listenPlayerRiskSnapshotsByCoadmin(
            '',
            (snapshots) => {
              if (!isCancelled) {
                setRiskSnapshots(snapshots);
              }
            },
            (error) => {
              if (!isCancelled) {
                if (!shouldSuppressInternalSqlFirestoreUiError(error)) {
                  setMessage(error.message || 'Failed to load player risk snapshots.');
                }
              }
            }
          );
          return;
        }

        const coadminUid = await getCurrentUserCoadminUid();
        if (isCancelled) {
          return;
        }
        unsubscribe = listenPlayerRiskSnapshotsByCoadmin(
          coadminUid,
          (snapshots) => {
            if (!isCancelled) {
              setRiskSnapshots(snapshots);
            }
          },
          (error) => {
            if (!isCancelled) {
              if (!shouldSuppressInternalSqlFirestoreUiError(error)) {
                setMessage(error.message || 'Failed to load player risk snapshots.');
              }
            }
          }
        );
      } catch (error: any) {
        if (!isCancelled) {
          if (!shouldSuppressInternalSqlFirestoreUiError(error)) {
            setMessage(error.message || 'Failed to start risk snapshot listener.');
          }
        }
      }
    }

    void startRiskSnapshotListener();

    return () => {
      isCancelled = true;
      unsubscribe?.();
    };
  }, [creatorRole]);

  useEffect(() => {
    if (activeView === 'dashboard' || activeView === 'view-players') {
      void loadPlayers();
    }

    if (activeView === 'reach-out') {
      void loadReachOutUsers();
    }

  }, [activeView]);

  useEffect(() => {
    let disposed = false;
    let heartbeatId: number | null = null;

    async function startMyShift() {
      const currentUser = auth.currentUser;
      if (!currentUser) {
        return;
      }
      const userSnap = await getDoc(doc(db, 'users', currentUser.uid));
      if (!userSnap.exists()) {
        return;
      }
      const userData = userSnap.data() as { username?: string };
      const coadminUid = await getCurrentUserCoadminUid();
      const sessionId = await startShiftSession({
        coadminUid,
        userUid: currentUser.uid,
        userRole: 'staff',
        userUsername: userData.username?.trim() || 'Staff',
      });
      if (disposed) {
        await endShiftSession(sessionId).catch(() => undefined);
        return;
      }
      shiftSessionIdRef.current = sessionId;
      heartbeatId = window.setInterval(() => {
        const id = shiftSessionIdRef.current;
        if (id) {
          void heartbeatShiftSession(id).catch(() => undefined);
        }
      }, 60_000);
    }

    void startMyShift().catch(() => undefined);

    return () => {
      disposed = true;
      if (heartbeatId !== null) {
        window.clearInterval(heartbeatId);
      }
      const id = shiftSessionIdRef.current;
      shiftSessionIdRef.current = null;
      if (id) {
        void endShiftSession(id).catch(() => undefined);
      }
    };
  }, []);

  useEffect(() => {
    let isCancelled = false;
    let unsubscribe: (() => void) | undefined;

    async function startCarerEscalationListener() {
      try {
        return;
        if (isCancelled) {
          return;
        }

        const onAlerts = (alerts: CarerEscalationAlert[]) => {
          if (isCancelled) {
            return;
          }

          setRecentCarerEscalations(alerts.slice(0, 6));

          if (!hasSeenCarerEscalationSnapshotRef.current) {
            hasSeenCarerEscalationSnapshotRef.current = true;
            latestCarerEscalationIdRef.current = alerts[0]?.id || null;
            return;
          }

          if (alerts.length === 0) {
            return;
          }

          const latestAlert = alerts[0];

          if (latestAlert.id === latestCarerEscalationIdRef.current) {
            return;
          }

          latestCarerEscalationIdRef.current = latestAlert.id;
          setLatestCarerEscalation(latestAlert);
          setShowCarerEscalationSplash(true);

          const audio = new Audio('/urgency-sound.mp3');
          audio.volume = 1;
          audio.play().catch(() => {});
        };

        const coadminUid = await getCurrentUserCoadminUid();

        if (isCancelled) {
          return;
        }

        unsubscribe = listenToCarerEscalationAlertsByCoadmin(
          coadminUid,
          onAlerts,
          (error) => {
            if (!isCancelled) {
              setMessage(error.message || 'Failed to listen for carer alerts.');
            }
          }
        );
      } catch (error: any) {
        if (!isCancelled) {
          setMessage(error.message || 'Failed to start carer alert listener.');
        }
      }
    }

    void startCarerEscalationListener();

    return () => {
      isCancelled = true;
      unsubscribe?.();
    };
  }, [creatorRole]);

  async function handleDismissCarerEscalation(alertId: string) {
    try {
      await dismissCarerEscalationAlertForCurrentUser(alertId);
      setDismissedCarerEscalationIds((current) =>
        current.includes(alertId) ? current : [...current, alertId]
      );
    } catch (error: any) {
      setMessage(error.message || 'Failed to dismiss urgent notification.');
    }
  }

  function formatCountdownMs(remainingMs: number) {
    const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
    const minutes = Math.floor(totalSeconds / 60)
      .toString()
      .padStart(2, '0');
    const seconds = (totalSeconds % 60).toString().padStart(2, '0');
    return `${minutes}:${seconds}`;
  }

  async function handleStartPlayerCashoutTask(taskId: string) {
    setPlayerCashoutTaskLoadingId(taskId);
    setMessage('');
    try {
      await startPlayerCashoutTask(taskId);
      logStaffCashoutAlertClaimReceived(taskId);
      setPendingCashoutTasks((prev) => prev.filter((task) => task.id !== taskId));
      refetchCashoutTasksRef.current?.();
      setMessage('Cashout task claimed.');
    } catch (error: unknown) {
      if (CashoutClaimConflictError.is(error)) {
        setPendingCashoutTasks((prev) => prev.filter((task) => task.id !== taskId));
        refetchCashoutTasksRef.current?.();
        setMessage('Task was already claimed by someone else.');
        console.warn('[STAFF_CASHOUT_TASKS] claimConflict', {
          taskId,
          status: error.snapshot.status,
          claimedByUid: error.snapshot.claimedByUid,
          claimedAt: error.snapshot.claimedAt,
        });
        return;
      }
      const message =
        error instanceof Error ? error.message : 'Failed to start player cashout task.';
      setMessage(message);
    } finally {
      setPlayerCashoutTaskLoadingId(null);
    }
  }

  async function handleCompletePlayerCashoutTask(taskId: string) {
    setPlayerCashoutTaskLoadingId(taskId);
    setMessage('');
    try {
      await completePlayerCashoutTask(taskId);
      refetchCashoutTasksRef.current?.();
      setMessage('Player cashout task completed.');
    } catch (error: any) {
      setMessage(error.message || 'Failed to complete player cashout task.');
    } finally {
      setPlayerCashoutTaskLoadingId(null);
    }
  }

  async function handleReleasePlayerCashoutTask(taskId: string) {
    setPlayerCashoutTaskLoadingId(taskId);
    setMessage('');
    try {
      await releasePlayerCashoutTask(taskId);
      setMessage('Cashout task released back to pending.');
    } catch (error: any) {
      setMessage(error.message || 'Failed to release player cashout task.');
    } finally {
      setPlayerCashoutTaskLoadingId(null);
    }
  }

  async function handleDeclinePlayerCashoutTask(taskId: string) {
    setPlayerCashoutTaskLoadingId(taskId);
    setMessage('');
    try {
      await declinePlayerCashoutTaskForCurrentHandler(taskId);
      setMessage('Task declined for you.');
    } catch (error: any) {
      setMessage(error.message || 'Failed to decline player cashout task.');
    } finally {
      setPlayerCashoutTaskLoadingId(null);
    }
  }

  async function handleOpenRiskPanel(playerUid: string) {
    setRiskActionLoading(`open-${playerUid}`);
    try {
      const snapshot = await getPlayerRiskSnapshot(playerUid);
      if (!snapshot) {
        setMessage('Risk data is not ready for this player yet.');
        return;
      }
      setSelectedRiskSnapshot(snapshot);
      setShowRiskPanel(true);
    } catch (error: any) {
      setMessage(staffRiskErrorMessage(error));
    } finally {
      setRiskActionLoading(null);
    }
  }

  async function handleStaffRiskAction(action: 'review' | 'bonus' | 'transfer', enabled?: boolean) {
    if (!selectedRiskSnapshot) return;

    const playerUid = selectedRiskSnapshot.playerUid;
    setRiskActionLoading(`${action}-${playerUid}`);
    setMessage('');
    try {
      if (action === 'review') {
        await markRiskReviewed(playerUid);
      } else if (action === 'bonus') {
        await setPlayerBonusBlock(playerUid, Boolean(enabled));
      } else if (action === 'transfer') {
        await setPlayerTransferBlock(playerUid, Boolean(enabled));
      }

      const refreshed = await getPlayerRiskSnapshot(playerUid);
      if (refreshed) {
        setSelectedRiskSnapshot(refreshed);
      }
      setMessage('Risk action saved.');
    } catch (error: any) {
      setMessage(staffRiskErrorMessage(error) || 'Failed to save risk action.');
    } finally {
      setRiskActionLoading(null);
    }
  }

  async function handleSendMessage(event: React.FormEvent) {
    event.preventDefault();

    if (!selectedChatUser || !newMessage.trim()) return;

    try {
      await sendChatMessage(selectedChatUser.uid, newMessage.trim());
      setNewMessage('');
      window.requestAnimationFrame(() => {
        const el = staffReachOutScrollRef.current;
        if (el) {
          el.scrollTop = el.scrollHeight;
        }
      });
    } catch (error: any) {
      setMessage(error.message || 'Failed to send message.');
    }
  }

  async function handleSendPlayerMessage(event: React.FormEvent) {
    event.preventDefault();

    if (!selectedPlayerChatUser || !newPlayerMessage.trim()) return;

    try {
      await sendChatMessage(selectedPlayerChatUser.uid, newPlayerMessage.trim());
      setNewPlayerMessage('');
      staffPlayerNearBottomRef.current = true;
      setShowStaffPlayerNewMessagePill(false);
      window.requestAnimationFrame(() => {
        scrollChatToBottom(staffPlayerScrollRef.current, staffPlayerMessagesEndRef.current, 'auto');
      });
    } catch (error: any) {
      setMessage(error.message || 'Failed to send player message.');
    }
  }

  function handleSelectReachOutUser(user: AdminUser) {
    setSelectedChatUser(user);
    setNewMessage('');
    lastRenderedStaffAgentReadRef.current = '';
  }

  function handleOpenPlayerChat(user: PlayerUser) {
    setSelectedPlayerChatUser(user);
    setNewPlayerMessage('');
    lastRenderedStaffPlayerReadRef.current = '';
    staffPlayerNearBottomRef.current = true;
    setShowStaffPlayerNewMessagePill(false);
  }

  function handleBackToPlayerList() {
    setSelectedViewPlayer(null);
    setSelectedPlayerChatUser(null);
    setNewPlayerMessage('');
    setStaffWalletLoadFormUid(null);
    setStaffWalletLoadAmountInput('');
  }

  async function handleSelectPlayerWorkspace(user: PlayerUser) {
    setSelectedViewPlayer(user);
    setSelectedPlayerChatUser(user);
    setNewPlayerMessage('');
    lastRenderedStaffPlayerReadRef.current = '';
    staffPlayerNearBottomRef.current = true;
    setShowStaffPlayerNewMessagePill(false);
    setStaffWalletLoadFormUid(null);
    setStaffWalletLoadAmountInput('');
  }

  function buildStaffWalletLoadIdempotencyKey(playerUid: string, amount: number) {
    const cryptoApi = typeof window !== 'undefined' ? window.crypto : undefined;
    const randomId =
      cryptoApi && typeof cryptoApi.randomUUID === 'function'
        ? cryptoApi.randomUUID()
        : `${playerUid}-${amount}`;
    return `staff-wallet-load:${playerUid}:${amount}:${randomId}`;
  }

  function buildStaffFreeplayIdempotencyKey(playerUid: string) {
    const cryptoApi = typeof window !== 'undefined' ? window.crypto : undefined;
    const randomId =
      cryptoApi && typeof cryptoApi.randomUUID === 'function'
        ? cryptoApi.randomUUID()
        : `${playerUid}-${Date.now()}`;
    return `staff-freeplay:${playerUid}:${randomId}`;
  }

  function staffWalletLoadErrorMessage(error: unknown) {
    const message = error instanceof Error ? error.message : String(error || '');
    if (message === 'insufficient_staff_wallet_balance') {
      return 'Not enough coins in your Staff Wallet.';
    }
    if (message === 'invalid_player') {
      return 'This player is no longer available.';
    }
    if (message === 'out_of_scope_player') {
      return 'This player is outside your coadmin scope.';
    }
    if (message === 'invalid_amount') {
      return 'Enter a positive whole-number amount.';
    }
    if (message === 'missing_idempotency_key') {
      return 'Could not prepare a safe request. Please try again.';
    }
    if (message === 'idempotency_conflict') {
      return 'This wallet load request conflicts with a previous request. Please try again.';
    }
    return message || 'Failed to load coins from Staff Wallet.';
  }

  async function handleLoadPlayerFromStaffWallet(player: PlayerUser) {
    if (!player?.uid) {
      setMessage('Select a player first.');
      return;
    }

    const parsed = Number(staffWalletLoadAmountInput.trim());
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
      setMessage('Enter a positive whole-number amount.');
      return;
    }

    const currentWalletBalance = Math.max(0, Math.floor(Number(staffWallet?.balanceCoin || 0)));
    if (parsed > currentWalletBalance) {
      setMessage('Not enough coins in your Staff Wallet.');
      return;
    }

    setStaffWalletLoadBusy(true);
    setMessage('');

    try {
      const result = await loadPlayerCoinsFromStaffWallet({
        playerUid: player.uid,
        amount: parsed,
        idempotencyKey: buildStaffWalletLoadIdempotencyKey(player.uid, parsed),
      });

      setStaffWallet((current) => ({
        staffUid: current?.staffUid || result.staffUid,
        coadminUid: current?.coadminUid || '',
        balanceCoin: result.staffWalletBalanceCoin,
        totalAllocatedCoin: current?.totalAllocatedCoin || 0,
        totalLoadedCoin: (current?.totalLoadedCoin || 0) + result.loadedAmount,
      }));
      setPlayers((current) =>
        current.map((item) =>
          item.uid === player.uid ? { ...item, coin: result.playerBalanceCoin } : item
        )
      );
      setSelectedViewPlayer((current) =>
        current?.uid === player.uid ? { ...current, coin: result.playerBalanceCoin } : current
      );
      setSelectedPlayerChatUser((current) =>
        current?.uid === player.uid ? { ...current, coin: result.playerBalanceCoin } : current
      );
      setStaffWalletLoadAmountInput('');
      setStaffWalletLoadFormUid(null);
      void loadMyStaffWalletBalance();
      setMessage(
        result.duplicate
          ? 'This Staff Wallet load was already processed.'
          : `Loaded ${parsed.toLocaleString()} coins to ${player.username || 'player'}.`
      );
    } catch (error) {
      setMessage(staffWalletLoadErrorMessage(error));
    } finally {
      setStaffWalletLoadBusy(false);
    }
  }

  async function handleGiveFreeplayToPlayer(player: PlayerUser) {
    if (freeplayGiveTargetUid || !player.uid || freeplayGiveInFlightRef.current.has(player.uid)) {
      return;
    }
    const currentWalletBalance = Math.max(0, Math.floor(Number(staffWallet?.balanceCoin || 0)));
    if (currentWalletBalance < STAFF_FREEPLAY_COST_COINS) {
      setMessage('You need at least 3 Staff Coins to give Free Play.');
      return;
    }
    console.info('[FREEPLAY_GIVE_BUTTON_CLICK]', {
      source: 'selected_player_panel',
      targetPlayerUid: player.uid,
    });
    setFreeplayGiveTargetUid(player.uid);
    freeplayGiveInFlightRef.current.add(player.uid);
    setMessage('');
    try {
      const result = await giveFreeplayGift({
        targetPlayerUid: player.uid,
        reason: 'manual_specific_player',
        idempotencyKey: buildStaffFreeplayIdempotencyKey(player.uid),
      });
      if (result.staffWalletBalanceCoin != null && Number.isFinite(result.staffWalletBalanceCoin)) {
        setStaffWallet((current) => ({
          staffUid: current?.staffUid || staffAuthUid,
          coadminUid: current?.coadminUid || '',
          balanceCoin: Math.max(0, Math.floor(Number(result.staffWalletBalanceCoin))),
          totalAllocatedCoin: current?.totalAllocatedCoin || 0,
          totalLoadedCoin: current?.totalLoadedCoin || 0,
        }));
      } else {
        void loadMyStaffWalletBalance();
      }
      setMessage(`FreePlay gift sent to ${result.playerUsername}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to give FreePlay gift.');
    } finally {
      freeplayGiveInFlightRef.current.delete(player.uid);
      setFreeplayGiveTargetUid(null);
    }
  }

  async function handleTogglePlayerStatus(player: PlayerUser) {
    const wasDisabled = player.status === 'disabled';

    if (!wasDisabled) {
      const ok = window.confirm(
        'Block this player? They can still sign in to message staff; other features stay restricted until unblocked.'
      );
      if (!ok) {
        return;
      }
    }

    setPlayerBlockActionUid(player.uid);
    setMessage('');

    try {
      if (wasDisabled) {
        await unblockPlayer(player);
      } else {
        await blockPlayer(player);
      }

      await loadPlayers();
      setMessage(wasDisabled ? 'Player unblocked.' : 'Player blocked.');
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : 'Failed to update player status.'
      );
    } finally {
      setPlayerBlockActionUid(null);
    }
  }

  function handleChangeView(view: StaffView) {
    setActiveView(view);
    setMessage('');

    if (view !== 'reach-out') {
      setSelectedChatUser(null);
      setNewMessage('');
    }

    if (view !== 'view-players') {
      setSelectedPlayerChatUser(null);
      setNewPlayerMessage('');
    }
  }

  const menuItems: (NavigationItem & { view: StaffView })[] = [
    { label: 'Dashboard', view: 'dashboard' },
    { label: 'Cashout Tasks', view: 'view-tasks' },
    { label: 'View Players', view: 'view-players', unread: playerChatUnreadTotal },
    { label: 'Reach Out', view: 'reach-out', unread: reachOutUnread },
  ];
  const sidebarItems = menuItems.map((item) => ({
    ...item,
    onClick: () => handleChangeView(item.view as StaffView),
  }));

  function renderPlayerCashoutPayment(task: PlayerCashoutTask) {
    const payment = getPlayerCashoutPaymentDisplay(task);

    if (payment.method === 'qr') {
      return (
        <div className="mt-2 space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-cyan-100/75">
            Payout method: QR
          </p>
          {payment.qrImageUrl ? (
            <div className="overflow-hidden rounded-xl border border-cyan-300/20 bg-black/35">
              <img
                src={payment.qrImageUrl}
                alt="Player payout QR"
                loading="lazy"
                className="max-h-52 w-full object-contain"
              />
            </div>
          ) : (
            <p className="text-xs text-cyan-100/70">QR image not provided.</p>
          )}
        </div>
      );
    }

    if (payment.method === 'app') {
      return (
        <div className="mt-2 grid gap-1 text-xs text-cyan-100/75">
          <p className="font-semibold uppercase tracking-wide text-cyan-100/75">
            Payout method: Payment app
          </p>
          <p>App name: {payment.paymentAppName || 'Not provided'}</p>
          <p>Cash tag: {payment.paymentAppCashTag || 'Not provided'}</p>
          <p>Name on app: {payment.paymentAppAccountName || 'Not provided'}</p>
        </div>
      );
    }

    return (
      <p className="mt-1 text-xs text-cyan-100/70">
        Payment details: {task.paymentDetails || 'Not provided'}
      </p>
    );
  }

  function renderStaffCashoutTasksView() {
    return (
      <div className="space-y-6">
        <div className="rounded-xl border border-yellow-500/30 bg-yellow-500/5 p-3 text-xs font-mono text-yellow-100/80">
          <p>staffUid: {staffSession?.uid || staffAuthUid || '—'}</p>
          <p>staffCoadminUid: {staffSession?.coadminUid || '—'}</p>
          <p>cashoutTasksLoading: {String(playerCashoutTasksLoading)}</p>
          <p>pendingCount: {pendingCashoutTasks.length}</p>
          <p>cashoutTasksCount: {pendingCashoutTasks.length + activeCashoutTasks.length + completedCashoutTasks.length}</p>
          <p>cashoutTasksError: {cashoutTasksError || '—'}</p>
          {pendingCashoutTasks[0] ? (
            <>
              <p>debugTaskId: {pendingCashoutTasks[0].id}</p>
              <p>debugStatus: {pendingCashoutTasks[0].status}</p>
              <p>debugClaimedByUid: {pendingCashoutTasks[0].assignedHandlerUid || '—'}</p>
              <p>
                debugClaimedAt:{' '}
                {formatDateTime(pendingCashoutTasks[0].startedAt, '—')}
              </p>
            </>
          ) : (
            <p>debugPendingTask: —</p>
          )}
        </div>

        <div className="rounded-2xl border border-cyan-500/30 bg-cyan-500/10 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h3 className="text-lg font-bold text-cyan-200">Pending Cashout Tasks</h3>
            <button
              type="button"
              disabled={cashoutAlerts.busy || cashoutAlerts.unsupported || cashoutAlerts.enabled}
              onClick={() => {
                void cashoutAlerts.enableAlerts().then(
                  () => {
                    setMessage('Cash-out alerts enabled for this device.');
                  },
                  (error: unknown) => {
                    setMessage(
                      error instanceof Error
                        ? error.message
                        : 'Failed to enable cash-out alerts.'
                    );
                  }
                );
              }}
              className="rounded-lg border border-cyan-300/40 bg-cyan-500/15 px-3 py-1.5 text-xs font-semibold text-cyan-50 hover:bg-cyan-500/25 disabled:opacity-60"
            >
              {cashoutAlerts.unsupported
                ? 'Alerts unsupported'
                : cashoutAlerts.enabled
                  ? 'Cash-out alerts on'
                  : cashoutAlerts.busy
                    ? 'Enabling...'
                    : 'Enable cash-out alerts'}
            </button>
          </div>
          {playerCashoutTasksLoading ? (
            <p className="mt-3 text-sm text-cyan-100/70">Loading cashout tasks...</p>
          ) : pendingCashoutTasks.length === 0 ? (
            <p className="mt-3 text-sm text-cyan-100/70">No pending cashout tasks.</p>
          ) : (
            <div className="mt-3 space-y-3">
              {pendingCashoutTasks.map((task) => (
                <div
                  key={task.id}
                  className="rounded-xl border border-cyan-400/25 bg-black/30 p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <p className="text-sm font-semibold text-white">
                        Player: {task.playerUsername}
                      </p>
                      <p className="text-sm text-cyan-100/85">
                        Amount: {formatUsdFromNpr(task.amountNpr || 0)}
                      </p>
                      {renderVendorTaskBadge(task.vendor)}
                      {renderPlayerCashoutPayment(task)}
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleStartPlayerCashoutTask(task.id)}
                      disabled={playerCashoutTaskLoadingId === task.id}
                      className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-black hover:bg-neutral-200 disabled:opacity-60"
                    >
                      {playerCashoutTaskLoadingId === task.id ? 'Saving...' : 'Claim / Start'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-5">
          <h3 className="text-lg font-bold text-amber-200">My Active Cashout Task</h3>
          {playerCashoutTasksLoading ? (
            <p className="mt-3 text-sm text-amber-100/70">Loading active task...</p>
          ) : activeCashoutTasks.length === 0 ? (
            <p className="mt-3 text-sm text-amber-100/70">No active cashout task.</p>
          ) : (
            <div className="mt-3 space-y-3">
              {activeCashoutTasks.map((task) => {
                const remainingMs = getPlayerCashoutTaskCountdown(task);
                return (
                  <div
                    key={task.id}
                    className="rounded-xl border border-amber-400/25 bg-black/30 p-4"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div>
                        <p className="text-sm font-semibold text-white">
                          Player: {task.playerUsername}
                        </p>
                        <p className="text-sm text-amber-100/85">
                          Amount: {formatUsdFromNpr(task.amountNpr || 0)}
                        </p>
                        {renderVendorTaskBadge(task.vendor)}
                        <p className="mt-1 text-xs text-amber-100/70">
                          Time left: {formatCountdownMs(remainingMs + countdownTick * 0)}
                        </p>
                        {renderPlayerCashoutPayment(task)}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => void handleCompletePlayerCashoutTask(task.id)}
                          disabled={playerCashoutTaskLoadingId === task.id}
                          className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-black hover:bg-neutral-200 disabled:opacity-60"
                        >
                          {playerCashoutTaskLoadingId === task.id
                            ? 'Saving...'
                            : `Done (${formatCountdownMs(remainingMs + countdownTick * 0)})`}
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleReleasePlayerCashoutTask(task.id)}
                          disabled={playerCashoutTaskLoadingId === task.id}
                          className="rounded-lg border border-amber-400/35 bg-amber-500/15 px-4 py-2 text-sm font-semibold text-amber-100 hover:bg-amber-500/25 disabled:opacity-60"
                        >
                          Release
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-5">
          <h3 className="text-lg font-bold text-emerald-200">Completed Tasks</h3>
          {playerCashoutTasksLoading ? (
            <p className="mt-3 text-sm text-emerald-100/70">Loading completed tasks...</p>
          ) : completedCashoutTasks.length === 0 ? (
            <p className="mt-3 text-sm text-emerald-100/70">No completed tasks yet.</p>
          ) : (
            <div className="mt-3 space-y-3">
              {completedCashoutTasks.map((task) => (
                <div
                  key={task.id}
                  className="rounded-xl border border-emerald-400/25 bg-black/30 p-4"
                >
                  <p className="text-sm font-semibold text-white">
                    Player: {task.playerUsername}
                  </p>
                  <p className="text-sm text-emerald-100/85">
                    Amount: {formatUsdFromNpr(task.amountNpr || 0)}
                  </p>
                  {renderVendorTaskBadge(task.vendor)}
                  {renderPlayerCashoutPayment(task)}
                  <p className="mt-1 text-xs text-emerald-100/70">
                    Completed: {formatDateTime(task.completedAt, 'Done')}
                  </p>
                  <p className="mt-1 text-xs text-emerald-100/70">
                    Handler: {task.assignedHandlerUsername || currentUserUid || 'Unknown'}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <ProtectedRoute allowedRoles={['staff']}>
      <RoleSidebarLayout
        title="Staff Panel"
        activeView={activeView}
        items={sidebarItems}
        footer={<LogoutButton />}
      >
          {message && (
            <div className="mb-4 rounded-2xl bg-white/10 p-3 text-sm text-neutral-300">
              {message}
            </div>
          )}

          {activeView === 'dashboard' && (
            <div className="space-y-6">
              <DashboardView
                coadminCount={1}
                staffCount={players.length}
                unreadCount={reachOutUnread}
              />

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="rounded-3xl border border-white/10 bg-white/5 p-5">
                  <p className="text-sm text-neutral-400">Players</p>
                  <p className="mt-2 text-3xl font-bold">{players.length}</p>
                </div>
                <div className="rounded-3xl border border-violet-400/25 bg-violet-500/10 p-5">
                  <p className="text-sm text-violet-100/75">Staff Wallet</p>
                  <p className="mt-2 text-3xl font-bold tabular-nums text-violet-50">
                    {staffWalletLoading
                      ? 'Loading...'
                      : `${dashboardStaffWalletCoinBalance.toLocaleString()} coins`}
                  </p>
                  <p className="mt-2 text-xs text-violet-100/65">
                    Coins available for loading players and Free Play.
                  </p>
                </div>
                <div className="rounded-3xl border border-white/10 bg-white/5 p-5">
                  <p className="text-sm text-neutral-400">Reach Out Contacts</p>
                  <p className="mt-2 text-3xl font-bold">{chatUsers.length}</p>
                </div>
              </div>

              <div>
                <button
                  type="button"
                  onClick={() => {
                    const firstRiskPlayer = riskyPlayers[0]?.playerUid || players[0]?.uid || '';
                    if (!firstRiskPlayer) {
                      setMessage('No player available to inspect.');
                      return;
                    }
                    void handleOpenRiskPanel(firstRiskPlayer);
                  }}
                  className="rounded-xl bg-white/10 px-4 py-2 text-sm font-semibold text-white hover:bg-white/20"
                >
                  View Player Risk Data
                </button>
              </div>

              {visibleRecentCarerEscalations.length > 0 && (
                <div className="rounded-2xl border border-red-500/30 bg-red-500/10 p-5">
                  <h3 className="text-lg font-bold text-red-200">
                    Urgent Carer Notifications ({visibleRecentCarerEscalations.length})
                  </h3>
                  <div className="mt-3 space-y-3">
                    {visibleRecentCarerEscalations.map((alert) => (
                      <div
                        key={alert.id}
                        className="rounded-xl border border-red-400/25 bg-black/30 p-4"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-sm font-semibold text-white">
                              Sender: {alert.createdByCarerUsername || 'User'}
                            </p>
                            <p className="mt-1 text-sm text-red-100/90">
                              Message: {alert.message || 'No message provided.'}
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() => void handleDismissCarerEscalation(alert.id)}
                            className="rounded-lg bg-white/15 px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/25"
                          >
                            Dismiss
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {riskyPlayers.length > 0 && (
                <div className="rounded-2xl border border-orange-500/35 bg-orange-500/10 p-5">
                  <h3 className="text-lg font-bold text-rose-200">Risky Players</h3>
                  <div className="mt-3 space-y-2">
                    {riskyPlayers.map((playerRisk) => (
                      <button
                        key={playerRisk.playerUid}
                        type="button"
                        onClick={() => void handleOpenRiskPanel(playerRisk.playerUid)}
                        className={`flex w-full items-center justify-between rounded-xl border px-4 py-3 text-left ${getRiskCardTone(
                          playerRisk.riskLevel,
                          playerRisk.riskScore || 0
                        )}`}
                      >
                        <div>
                          <p className="text-sm font-semibold text-white">{playerRisk.playerUsername}</p>
                          <p className="text-xs text-rose-100/70">
                            {playerRisk.alerts[0] || 'Risk pattern detected'} · Last:{' '}
                            {formatDateTime(playerRisk.lastActivityAt)}
                          </p>
                        </div>
                        <div
                          className={`text-xs font-bold uppercase ${getRiskTone(
                            playerRisk.riskLevel,
                            playerRisk.riskScore || 0
                          )}`}
                        >
                          {playerRisk.riskLevel} ({playerRisk.riskScore})
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {activeView === 'view-tasks' && (
            <div>
              <h2 className="mb-6 text-3xl font-bold">Cashout Tasks</h2>
              {renderStaffCashoutTasksView()}
            </div>
          )}

          {activeView === 'view-players' && (
            <div
              className={
                isMobilePlayerWorkspace
                  ? selectedViewPlayer
                    ? 'fixed inset-0 z-[35] flex min-h-0 flex-col overflow-hidden bg-neutral-950'
                    : 'block'
                  : 'grid h-[calc(100dvh-12rem)] min-h-0 grid-cols-[minmax(17rem,21rem)_minmax(0,1fr)] grid-rows-1 gap-4 overflow-hidden'
              }
            >
              {!isMobilePlayerWorkspace || !selectedViewPlayer ? (
                <aside
                  className={
                    isMobilePlayerWorkspace
                      ? 'flex flex-col rounded-2xl border border-white/10 bg-neutral-950/70'
                      : 'flex min-h-0 flex-col overflow-hidden rounded-2xl border border-white/10 bg-neutral-950/70'
                  }
                >
                <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
                  <div>
                    <h2 className="text-base font-bold text-white">Players</h2>
                    <p className="text-xs text-neutral-400">
                      {visiblePlayersForStaffList.length} visible
                    </p>
                  </div>
                  {playerChatUnreadTotal > 0 ? (
                    <span className="rounded-full bg-red-500 px-2.5 py-1 text-xs font-bold text-white">
                      {playerChatUnreadTotal}
                    </span>
                  ) : null}
                </div>

                <div className="border-b border-white/10 p-2">
                  <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-black/35 px-3 py-2">
                    <input
                      value={playerSearchQuery}
                      onChange={(event) => setPlayerSearchQuery(event.target.value)}
                      placeholder="Search players..."
                      className="min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-neutral-500"
                    />
                    {playerSearchQuery.trim() ? (
                      <button
                        type="button"
                        onClick={() => setPlayerSearchQuery('')}
                        className="rounded-full px-2 text-sm font-bold text-neutral-400 hover:bg-white/10 hover:text-white"
                        aria-label="Clear player search"
                      >
                        x
                      </button>
                    ) : null}
                  </div>
                </div>

                <div
                  className={
                    isMobilePlayerWorkspace
                      ? 'space-y-1 px-2 py-2'
                      : 'min-h-0 flex-1 space-y-1 overflow-y-auto px-2 py-2'
                  }
                >
                  {loadingList ? (
                    <p className="px-3 py-4 text-sm text-neutral-400">Loading...</p>
                  ) : visiblePlayersForStaffList.length === 0 ? (
                    <p className="px-3 py-4 text-sm text-neutral-400">No players found.</p>
                  ) : (
                    visiblePlayersForStaffList.map((player) => {
                      const isSelected = selectedViewPlayer?.uid === player.uid;
                      const unreadCount = unreadCounts[player.uid] || 0;
                      const isOnline = Boolean(staffOnlineByUid[player.uid]);
                      return (
                        <button
                          key={player.uid}
                          type="button"
                          onClick={() => void handleSelectPlayerWorkspace(player)}
                          className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition ${
                            isSelected
                              ? 'bg-white text-black'
                              : unreadCount > 0
                                ? 'bg-red-500/10 text-white ring-1 ring-red-500/25 hover:bg-red-500/15'
                                : 'text-white hover:bg-white/10'
                          }`}
                        >
                          <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-neutral-800 text-sm font-bold">
                            {(player.username || 'P').charAt(0).toUpperCase()}
                            <span
                              className={`absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full ring-2 ${
                                isSelected ? 'ring-white' : 'ring-neutral-950'
                              } ${isOnline ? 'bg-emerald-400' : 'bg-neutral-500'}`}
                            />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-semibold">
                              {player.username}
                            </span>
                            <span
                              className={`block truncate text-xs ${
                                isSelected
                                  ? 'text-black/60'
                                  : unreadCount > 0
                                    ? 'text-red-100'
                                    : 'text-neutral-500'
                              }`}
                            >
                              {unreadCount > 0
                                ? `${unreadCount} unread`
                                : isOnline
                                  ? 'Online'
                                  : 'Offline'}
                            </span>
                          </span>
                          {unreadCount > 0 ? (
                            <span className="rounded-full bg-red-500 px-2 py-0.5 text-[10px] font-bold text-white">
                              {unreadCount > 9 ? '9+' : unreadCount}
                            </span>
                          ) : null}
                        </button>
                      );
                    })
                  )}
                </div>
                </aside>
              ) : null}

              {!isMobilePlayerWorkspace || selectedViewPlayer ? (
                <section
                  className={
                    isMobilePlayerWorkspace
                      ? 'flex h-full min-h-0 flex-col overflow-hidden border border-white/10 bg-neutral-950'
                      : 'flex min-h-0 flex-col overflow-hidden rounded-2xl border border-white/10 bg-white/[0.04]'
                  }
                >
                {!selectedViewPlayer ? (
                  <div className="flex h-full items-center justify-center px-4 text-center text-sm text-neutral-500">
                    Select a player to open their workspace.
                  </div>
                ) : (
                  (() => {
                    const user = selectedViewPlayer;
                    const playerRisk = riskByPlayerUid.get(user.uid);
                    const staffWalletBalance = Math.max(
                      0,
                      Math.floor(Number(staffWallet?.balanceCoin || 0))
                    );
                    const staffWalletTotalAllocated = Math.max(
                      0,
                      Math.floor(Number(staffWallet?.totalAllocatedCoin || 0))
                    );
                    const staffWalletTotalLoaded = Math.max(
                      0,
                      Math.floor(Number(staffWallet?.totalLoadedCoin || 0))
                    );
                    const requestedWalletLoadAmount = Number(staffWalletLoadAmountInput || 0);
                    const walletLoadAmountTooHigh =
                      Number.isFinite(requestedWalletLoadAmount) &&
                      requestedWalletLoadAmount > staffWalletBalance;
                    const isWalletFormOpen = staffWalletLoadFormUid === user.uid;
                    const playerIsOnline = Boolean(staffOnlineByUid[user.uid]);

                    return (
                      <div className="flex h-full min-h-0 flex-col">
                        <div className="shrink-0 border-b border-white/10 px-4 py-3">
                          {isMobilePlayerWorkspace ? (
                            <button
                              type="button"
                              onClick={handleBackToPlayerList}
                              className="mb-3 rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-xs font-bold text-white hover:bg-white/15"
                            >
                              Back to players
                            </button>
                          ) : null}
                          <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <OnlineIndicator
                                  online={playerIsOnline}
                                  sizeClassName="h-3 w-3"
                                />
                                <h2 className="truncate text-xl font-bold text-white">
                                  {user.username}
                                </h2>
                                {playerRisk ? (
                                  <span className="rounded-full bg-orange-500/15 px-2 py-0.5 text-[11px] font-bold text-orange-100">
                                    Risk {String(playerRisk.riskLevel).toUpperCase()} (
                                    {playerRisk.riskScore || 0})
                                  </span>
                                ) : null}
                              </div>
                              <p className="mt-1 text-xs text-neutral-400">
                                {user.role} / {user.status} /{' '}
                                {playerIsOnline ? 'Online' : 'Offline'}
                              </p>
                            </div>

                            <div className="flex flex-wrap gap-2 text-xs">
                              <span className="rounded-xl border border-amber-400/25 bg-amber-400/10 px-3 py-2 text-amber-100">
                                Coin:{' '}
                                <span className="font-bold tabular-nums">
                                  {Math.max(0, Math.floor(Number(user.coin || 0))).toLocaleString()}
                                </span>
                              </span>
                              <span className="rounded-xl border border-emerald-400/20 bg-emerald-400/10 px-3 py-2 text-emerald-100">
                                Cash:{' '}
                                <span className="font-bold tabular-nums">
                                  {Math.max(0, Math.floor(Number(user.cash || 0))).toLocaleString()}
                                </span>
                              </span>
                              <span className="rounded-xl border border-violet-400/25 bg-violet-400/10 px-3 py-2 text-violet-100">
                                My Wallet:{' '}
                                <span className="font-bold tabular-nums">
                                  {staffWalletLoading
                                    ? '...'
                                    : `${staffWalletBalance.toLocaleString()} coins`}
                                </span>
                              </span>
                            </div>
                          </div>

                          <div className="mt-3">
                            {renderVendorDetailSection(user.vendor)}
                          </div>

                          <div className="mt-3 flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              onClick={() => handleOpenPlayerChat(user)}
                              className="rounded-xl bg-white px-3 py-2 text-xs font-semibold text-black hover:bg-neutral-200"
                            >
                              Chat
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleTogglePlayerStatus(user)}
                              disabled={playerBlockActionUid !== null}
                              className="rounded-xl bg-yellow-500/20 px-3 py-2 text-xs font-semibold text-yellow-200 hover:bg-yellow-500/30 disabled:opacity-60"
                            >
                              {playerBlockActionUid === user.uid
                                ? 'Updating...'
                                : user.status === 'disabled'
                                  ? 'Unblock'
                                  : 'Block'}
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleGiveFreeplayToPlayer(user)}
                              disabled={
                                Boolean(freeplayGiveTargetUid) ||
                                user.status === 'disabled' ||
                                staffWalletBalance < STAFF_FREEPLAY_COST_COINS
                              }
                              title={
                                staffWalletBalance < STAFF_FREEPLAY_COST_COINS
                                  ? 'You need at least 3 Staff Coins to give Free Play.'
                                  : undefined
                              }
                              className="rounded-xl border border-fuchsia-400/30 bg-fuchsia-500/15 px-3 py-2 text-xs font-semibold text-fuchsia-100 hover:bg-fuchsia-500/25 disabled:opacity-60"
                            >
                              {freeplayGiveTargetUid === user.uid ? 'Sending...' : 'Give Freeplay'}
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleOpenRiskPanel(user.uid)}
                              disabled={riskActionLoading === `open-${user.uid}`}
                              className="rounded-xl bg-white/10 px-3 py-2 text-xs font-semibold text-white hover:bg-white/20 disabled:opacity-60"
                            >
                              {riskActionLoading === `open-${user.uid}`
                                ? 'Loading...'
                                : 'View Risk Data'}
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setStaffWalletLoadFormUid(isWalletFormOpen ? null : user.uid);
                                if (isWalletFormOpen) {
                                  setStaffWalletLoadAmountInput('');
                                }
                              }}
                              className="rounded-xl border border-violet-400/35 bg-violet-400/15 px-3 py-2 text-xs font-semibold text-violet-100 hover:bg-violet-400/25"
                            >
                              Load Coins
                            </button>
                          </div>

                          {isWalletFormOpen ? (
                            <div className="mt-3 rounded-xl border border-violet-400/25 bg-black/30 p-3">
                              <div className="flex flex-col gap-3 md:flex-row md:items-end">
                                <div className="min-w-0 flex-1">
                                  <p className="text-xs font-semibold text-violet-100">
                                    Staff Wallet
                                  </p>
                                  <p className="mt-1 text-[11px] text-violet-100/70">
                                    Available: {staffWalletBalance.toLocaleString()} coins / Loaded:{' '}
                                    {staffWalletTotalLoaded.toLocaleString()} / Allocated:{' '}
                                    {staffWalletTotalAllocated.toLocaleString()} / Free Play cost:{' '}
                                    {STAFF_FREEPLAY_COST_COINS}
                                  </p>
                                </div>
                                <label className="min-w-0 text-xs text-neutral-300 md:w-40">
                                  Amount
                                  <input
                                    type="number"
                                    min={1}
                                    step={1}
                                    inputMode="numeric"
                                    value={staffWalletLoadAmountInput}
                                    onChange={(event) =>
                                      setStaffWalletLoadAmountInput(event.target.value)
                                    }
                                    disabled={staffWalletLoadBusy}
                                    placeholder="0"
                                    className="mt-1 w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-violet-400/60 disabled:opacity-50"
                                  />
                                </label>
                                <div className="flex gap-2">
                                  <button
                                    type="button"
                                    onClick={() => void handleLoadPlayerFromStaffWallet(user)}
                                    disabled={
                                      staffWalletLoadBusy ||
                                      staffWalletLoading ||
                                      staffWalletBalance <= 0 ||
                                      walletLoadAmountTooHigh
                                    }
                                    className="rounded-lg bg-violet-300 px-3 py-2 text-xs font-bold text-black hover:bg-violet-200 disabled:cursor-not-allowed disabled:opacity-50"
                                  >
                                    {staffWalletLoadBusy ? 'Loading...' : 'Confirm'}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setStaffWalletLoadFormUid(null);
                                      setStaffWalletLoadAmountInput('');
                                    }}
                                    disabled={staffWalletLoadBusy}
                                    className="rounded-lg bg-white/10 px-3 py-2 text-xs font-semibold text-white hover:bg-white/20 disabled:opacity-50"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                              {walletLoadAmountTooHigh ? (
                                <p className="mt-2 text-[11px] font-semibold text-rose-200">
                                  Amount is higher than your available Staff Wallet balance.
                                </p>
                              ) : null}
                            </div>
                          ) : null}
                        </div>

                        {selectedPlayerChatUser?.uid === user.uid ? (
                          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                            <div
                              ref={staffPlayerScrollRef}
                              onScroll={(event) => {
                                const nearBottom = isNearChatBottom(event.currentTarget);
                                staffPlayerNearBottomRef.current = nearBottom;
                                if (nearBottom) {
                                  setShowStaffPlayerNewMessagePill(false);
                                }
                              }}
                              className="min-h-0 flex-1 space-y-2 overflow-y-auto overflow-x-hidden overscroll-contain px-4 py-3"
                            >
                              {pagedStaffPlayerChat.hasMoreOlder ? (
                                <div className="sticky top-0 z-10 mb-2 flex justify-center">
                                  <button
                                    type="button"
                                    disabled={pagedStaffPlayerChat.loadingOlder}
                                    onClick={() => void pagedStaffPlayerChat.loadOlder()}
                                    className="rounded-full border border-white/15 bg-black/60 px-4 py-1.5 text-xs font-semibold text-white shadow-sm hover:border-white/25 disabled:opacity-50"
                                  >
                                    {pagedStaffPlayerChat.loadingOlder
                                      ? 'Loading older messages...'
                                      : 'Load older messages'}
                                  </button>
                                </div>
                              ) : playerMessages.length > 0 ? (
                                <div className="mb-2 text-center text-[11px] font-medium text-neutral-500">
                                  No older messages
                                </div>
                              ) : null}
                              {playerMessages.length === 0 ? (
                                <div className="flex h-full items-center justify-center text-sm text-neutral-500">
                                  No messages yet. Send first message to player.
                                </div>
                              ) : (
                                playerMessages.map((msg) => (
                                  <div
                                    key={msg.id}
                                    className={`flex ${
                                      msg.sender === 'admin' ? 'justify-end' : 'justify-start'
                                    }`}
                                  >
                                    <div
                                      className={`max-w-[78%] rounded-2xl px-3 py-2 text-sm ${
                                        msg.sender === 'admin'
                                          ? 'bg-white text-black'
                                          : 'bg-neutral-800 text-white'
                                      }`}
                                    >
                                      {msg.text ? <p className="break-words">{msg.text}</p> : null}
                                      {msg.imageUrl ? (
                                        <a
                                          className="mt-1 block text-xs underline"
                                          href={msg.imageUrl}
                                          target="_blank"
                                          rel="noreferrer"
                                        >
                                          View image
                                        </a>
                                      ) : null}
                                      <p className="mt-1 text-[11px] opacity-70">
                                        {msg.timestamp.toLocaleTimeString([], {
                                          hour: '2-digit',
                                          minute: '2-digit',
                                        })}
                                      </p>
                                    </div>
                                  </div>
                                ))
                              )}
                              <div ref={staffPlayerMessagesEndRef} />
                              {showStaffPlayerNewMessagePill ? (
                                <button
                                  type="button"
                                  onClick={() => {
                                    scrollChatToBottom(
                                      staffPlayerScrollRef.current,
                                      staffPlayerMessagesEndRef.current,
                                      'smooth'
                                    );
                                    staffPlayerNearBottomRef.current = true;
                                    setShowStaffPlayerNewMessagePill(false);
                                  }}
                                  className="sticky bottom-2 z-10 mx-auto block rounded-full border border-white/40 bg-white px-3 py-1 text-xs font-bold text-black shadow-lg shadow-black/30"
                                >
                                  New message
                                </button>
                              ) : null}
                            </div>

                            <form
                              onSubmit={handleSendPlayerMessage}
                              className="flex shrink-0 gap-2 border-t border-white/10 p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]"
                            >
                              <input
                                value={newPlayerMessage}
                                onChange={(event) => setNewPlayerMessage(event.target.value)}
                                placeholder="Type message to player..."
                                className="min-w-0 flex-1 rounded-xl border border-white/15 bg-black/35 px-4 py-3 text-sm text-white outline-none focus:border-white/35"
                              />
                              <button
                                type="submit"
                                disabled={!newPlayerMessage.trim()}
                                className="rounded-xl bg-white px-4 py-2 text-sm font-semibold text-black hover:bg-neutral-200 disabled:opacity-50"
                              >
                                Send
                              </button>
                            </form>
                          </div>
                        ) : (
                          <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-neutral-500">
                            Select Chat to open this conversation.
                          </div>
                        )}
                      </div>
                    );
                  })()
                )}
                </section>
              ) : null}
            </div>
          )}

      </RoleSidebarLayout>

      {showRiskPanel && selectedRiskSnapshot && (
        <div
          onClick={() => setShowRiskPanel(false)}
          className="fixed inset-0 z-[58] flex items-center justify-center bg-black/80 px-4"
        >
          <div
            onClick={(event) => event.stopPropagation()}
            className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-3xl border border-white/15 bg-neutral-900 p-6 text-white"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-2xl font-bold">Player Risk Data</h3>
              <button
                type="button"
                onClick={() => setShowRiskPanel(false)}
                className="rounded-lg bg-white/10 px-3 py-1.5 text-xs font-semibold hover:bg-white/20"
              >
                Close
              </button>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <p className="text-xs text-neutral-400">Player Summary</p>
                <p className="mt-2 text-lg font-semibold">{selectedRiskSnapshot.playerUsername}</p>
                <p
                  className={`text-sm font-bold uppercase ${getRiskTone(
                    selectedRiskSnapshot.riskLevel,
                    selectedRiskSnapshot.riskScore || 0
                  )}`}
                >
                  {selectedRiskSnapshot.riskLevel} risk
                </p>
                <p className="text-sm text-neutral-300">
                  Score: {selectedRiskSnapshot.riskScore}
                </p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <p className="text-xs text-neutral-400">Financial Data</p>
                <p className="mt-2 text-sm text-neutral-200">
                  Deposits: {formatUsdFromNpr(selectedRiskSnapshot.totalDeposits || 0)}
                </p>
                <p className="text-sm text-neutral-200">
                  Cashouts: {formatUsdFromNpr(selectedRiskSnapshot.totalCashouts || 0)}
                </p>
                <p className="text-sm text-neutral-200">
                  Transfers: {formatUsdFromNpr(selectedRiskSnapshot.totalTransfers || 0)}
                </p>
                <p className="text-sm text-neutral-200">
                  Bonus claimed: {formatUsdFromNpr(selectedRiskSnapshot.totalBonusClaimed || 0)}
                </p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <p className="text-xs text-neutral-400">Activity (24h / 7d)</p>
                <p className="mt-2 text-sm text-neutral-200">
                  Cashouts: {selectedRiskSnapshot.activity24h?.cashouts || 0} /{' '}
                  {selectedRiskSnapshot.activity7d?.cashouts || 0}
                </p>
                <p className="text-sm text-neutral-200">
                  Transfers: {selectedRiskSnapshot.activity24h?.transfers || 0} /{' '}
                  {selectedRiskSnapshot.activity7d?.transfers || 0}
                </p>
                <p className="text-sm text-neutral-200">
                  Bonus: {selectedRiskSnapshot.activity24h?.bonus || 0} /{' '}
                  {selectedRiskSnapshot.activity7d?.bonus || 0}
                </p>
                <p className="text-sm text-neutral-200">
                  Deposits: {selectedRiskSnapshot.activity24h?.deposits || 0} /{' '}
                  {selectedRiskSnapshot.activity7d?.deposits || 0}
                </p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <p className="text-xs text-neutral-400">Behavior Analysis</p>
                <p className="mt-2 text-sm text-neutral-200">
                  Deposit/Cashout ratio: {selectedRiskSnapshot.depositToCashoutRatio || 0}
                </p>
                <p className="text-sm text-neutral-200">
                  Bonus/Deposit ratio: {selectedRiskSnapshot.bonusToDepositRatio || 0}
                </p>
                <p className="text-sm text-neutral-200">
                  Cycle count: {selectedRiskSnapshot.cycleCount || 0}
                </p>
              </div>
            </div>

            <div className="mt-4 rounded-2xl border border-amber-400/30 bg-amber-500/10 p-4 text-sm text-amber-100">
              Repeated cashout → coin transfer → bonus usage can reduce system profit. Use this
              feature mainly for retention, not repeated recycling.
            </div>

            <div className="mt-4 rounded-2xl border border-rose-400/30 bg-rose-500/10 p-4">
              <p className="text-xs font-bold uppercase tracking-[0.2em] text-rose-100">Alerts</p>
              <div className="mt-2 space-y-1 text-sm text-rose-50">
                {(selectedRiskSnapshot.alerts || []).length === 0 ? (
                  <p>No active alerts.</p>
                ) : (
                  selectedRiskSnapshot.alerts.map((alert) => <p key={alert}>- {alert}</p>)
                )}
              </div>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void handleStaffRiskAction('review')}
                disabled={riskActionLoading === `review-${selectedRiskSnapshot.playerUid}`}
                className="rounded-lg bg-white/15 px-3 py-2 text-xs font-semibold hover:bg-white/25 disabled:opacity-60"
              >
                Mark reviewed
              </button>
              <button
                type="button"
                onClick={() => void handleStaffRiskAction('bonus', true)}
                disabled={riskActionLoading === `bonus-${selectedRiskSnapshot.playerUid}`}
                className="rounded-lg bg-rose-500 px-3 py-2 text-xs font-semibold text-white hover:bg-rose-400 disabled:opacity-60"
              >
                Block bonus temporarily
              </button>
              <button
                type="button"
                onClick={() => void handleStaffRiskAction('bonus', false)}
                disabled={riskActionLoading === `bonus-${selectedRiskSnapshot.playerUid}`}
                className="rounded-lg bg-emerald-500 px-3 py-2 text-xs font-semibold text-black hover:bg-emerald-400 disabled:opacity-60"
              >
                Unblock bonus
              </button>
              <button
                type="button"
                onClick={() => void handleStaffRiskAction('transfer', true)}
                disabled={riskActionLoading === `transfer-${selectedRiskSnapshot.playerUid}`}
                className="rounded-lg bg-rose-500 px-3 py-2 text-xs font-semibold text-white hover:bg-rose-400 disabled:opacity-60"
              >
                Block transfer temporarily
              </button>
              <button
                type="button"
                onClick={() => void handleStaffRiskAction('transfer', false)}
                disabled={riskActionLoading === `transfer-${selectedRiskSnapshot.playerUid}`}
                className="rounded-lg bg-emerald-500 px-3 py-2 text-xs font-semibold text-black hover:bg-emerald-400 disabled:opacity-60"
              >
                Unblock transfer
              </button>
            </div>
          </div>
        </div>
      )}

      {showCarerEscalationSplash && latestCarerEscalation && (
        <div
          onClick={() => setShowCarerEscalationSplash(false)}
          className="fixed inset-0 z-[60] flex items-center justify-center bg-red-700/90 px-4 backdrop-blur-sm"
        >
          <div className="w-full max-w-2xl rounded-3xl border border-red-200/40 bg-gradient-to-br from-red-700 via-red-800 to-red-950 p-8 text-white shadow-2xl">
            <p className="text-xs font-bold uppercase tracking-[0.3em] text-red-100">
              {latestCarerEscalation.contextType === 'cashbox_inquiry'
                ? 'Carer Inquiry Alert'
                : 'Carer Help Alert'}
            </p>
            <h2 className="mt-3 text-3xl font-bold">
              {latestCarerEscalation.contextType === 'cashbox_inquiry'
                ? 'Urgent inquiry from carer.'
                : 'This player is being an idiot.'}
            </h2>
            {latestCarerEscalation.contextType !== 'cashbox_inquiry' && (
              <p className="mt-3 text-sm text-red-100/85">
                Player: {latestCarerEscalation.playerUsername} /{' '}
                {latestCarerEscalation.gameName}
              </p>
            )}
            <p className="mt-3 text-sm text-red-100/90">
              Message: {latestCarerEscalation.message}
            </p>
            <p className="mt-2 text-sm text-red-100/75">
              Sender: {latestCarerEscalation.createdByCarerUsername}
            </p>
            <p className="mt-6 text-sm font-semibold text-red-100">
              Click anywhere to dismiss.
            </p>
          </div>
        </div>
      )}
    </ProtectedRoute>
  );
}
