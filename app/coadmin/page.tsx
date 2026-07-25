'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from 'firebase/firestore';
import { onAuthStateChanged, signInWithCustomToken } from 'firebase/auth';

import ProtectedRoute from '../../components/auth/ProtectedRoute';
import LogoutButton from '../../components/auth/LogoutButton';
import DashboardView from '../../components/admin/DashboardView';
import CreateUserForm from '../../components/admin/CreateUserForm';
import UserManagementView from '../../components/admin/UserManagementView';
import ReachOutView from '../../components/admin/ReachOutView';
import RoleSidebarLayout, { type NavigationItem } from '@/components/navigation/RoleSidebarLayout';

import {
  ensureAppSessionBootstrapped,
  getAppSessionRequestHeaders,
  getLocalAppSessionId,
  startImpersonationSession,
} from '@/features/auth/appSession';
import { getCachedSessionUser, getSessionUserOnce } from '@/features/auth/sessionUser';
import { isClientSqlReadMode, logClientFirestoreSkipped } from '@/lib/client/sqlReadMode';
import { clientGetDocs } from '@/lib/client/clientFirestoreQuery';
import { getSqlApiReadHeaders } from '@/lib/client/sqlApiHeaders';
import {
  attachHiddenTabPollResume,
  HIDDEN_THROTTLED_POLL_MS,
  isDocumentHidden,
  logHiddenTabPollThrottled,
  resolveVisiblePollIntervalMs,
} from '@/lib/client/hiddenTabPoll';
import { auth, db } from '@/lib/firebase/client';
import { getApiAuthHeaders, getFirebaseApiHeaders } from '@/lib/firebase/apiClient';
import {
  belongsToCoadmin,
  getCoadminActorUid,
  getCurrentUserCoadminUid,
} from '@/lib/coadmin/scope';

import {
  CarerCreationRequest,
  StaffUser,
  CarerUser,
  PlayerUser,
  blockCarer,
  blockPlayer,
  blockStaff,
  createStaff,
  createPlayer,
  deleteStaff,
  deleteCarer,
  deletePlayer,
  getStaff,
  getCarers,
  getMyPendingCarerCreationRequests,
  getPlayersByCoadminSqlFirst,
  requestCarerCreation,
  resetCoadminWorkerCredentials,
  unblockCarer,
  unblockPlayer,
  unblockStaff,
} from '@/features/users/adminUsers';
import {
  adjustPlayerCash,
  adjustPlayerCoin,
} from '@/features/users/coadminPlayerCoin';
import {
  allocateStaffWalletCoins,
  listCoadminStaffWallets,
  type CoadminStaffWalletRow,
} from '@/features/users/staffWallet';

import {
  GameLogin,
  createGameLogin,
  deleteGameLoginAndRelatedData,
  getMyGameLogins,
  updateGameLogin,
} from '@/features/games/gameLogins';
import { getPlayerGameLoginsByPlayer } from '@/features/games/playerGameLogins';
import {
  CarerEscalationAlert,
  CarerRechargeRedeemTotals,
  dismissCarerEscalationAlertForCurrentUser,
  listenCarerRechargeRedeemTotalsByCoadmin,
  listenToCarerEscalationAlertsByCoadmin,
} from '@/features/games/carerTasks';
import {
  CarerCashoutRequest,
  completeCarerCashoutRequest,
  declineCarerCashoutRequest,
  listenCarerCashoutsByCarerUid,
  listenPendingCashoutsByCoadmin,
} from '@/features/cashouts/carerCashouts';
import {
  completePlayerCashoutTask,
  declinePlayerCashoutTaskByCoadmin,
  getEffectivePlayerCashoutTaskStatus,
  isPlayerCashoutHandledBySomeoneElse,
  getPlayerCashoutTaskCountdown,
  getPlayerCashoutPaymentDisplay,
  listenPlayerCashoutTasksByAssignedHandler,
  listenCoadminCashoutTaskLifecycle,
  PlayerCashoutTask,
  startPlayerCashoutTask,
} from '@/features/cashouts/playerCashoutTasks';
import {
  logStaffCashoutAlertClaimReceived,
  useStaffCashoutAlerts,
} from '@/lib/pwa/staffCashoutAlert';
import {
  PLAYER_GAME_REDEEM_MAX_PER_24H,
  getPlayerGameRedeemLimitSummary,
  resetPlayerGameRedeemLimitForCoadmin,
  type PlayerGameRedeemLimitSummary,
} from '@/features/games/playerGameRequests';
import {
  BonusEvent,
  COADMIN_AUTO_BONUS_PERCENT_MAX,
  COADMIN_AUTO_BONUS_PERCENT_MIN,
  createBonusEvent,
  getCoadminAutoBonusPercentRange,
  MAX_ACTIVE_BONUS_EVENTS,
  listenBonusEventsByCoadmin,
  getCoadminBonusApiHeaders,
  logBonusEventsUiGuard,
  logBonusEventsUiRequest,
  setCoadminAutoBonusPercentRange,
} from '../../features/bonusEvents/bonusEvents';
import {
  listenToUnreadCounts,
  mapFirestoreChatToDisplay,
  markConversationAsRead,
  sendChatMessage,
  sendImageMessage,
} from '@/features/messages/chatMessages';
import { usePaginatedChatMessages } from '@/features/messages/usePaginatedChatMessages';

import { AdminUser, ChatMessage } from '../../components/admin/types';
import {
  getCoadminPaymentDetailPhotos,
  setCoadminPaymentDetailPhotos,
  type PaymentDetailPhoto,
  uploadCoadminPaymentDetailPhoto,
} from '@/features/coinLoad/coinLoadSession';
import ImageUploadField from '@/components/common/ImageUploadField';

const SELECTED_PLAYER_RECORD_QUERY_LIMIT = 100;
const SELECTED_PLAYER_CASHOUT_QUERY_LIMIT = 50;
import {
  cutWorkerReward,
  listenShiftSessionsByCoadmin,
  type ShiftSession,
} from '@/features/shifts/userShifts';
import { usePresenceOnlineMap } from '@/features/presence/userPresence';
import {
  listenCoadminMaintenanceBreak,
  setCoadminMaintenanceBreak,
} from '@/features/maintenance/maintenanceBreak';
import { normalizeMaintenanceBreak, type MaintenanceBreak } from '@/lib/maintenance/config';
import { giveFreeplayGift } from '@/features/freeplay/coadminFreeplay';
import {
  createPaymentListener,
  deletePaymentListener,
  listPaymentListeners,
  paymentListenerDefaults,
  testPaymentListener,
  updatePaymentListener,
  type PaymentListener,
  type PaymentListenerProvider,
} from '@/features/paymentListeners/paymentListeners';

type CoadminView =
  | 'dashboard'
  | 'view-tasks'
  | 'create-bonus-event'
  | 'view-bonus-events'
  | 'add-staff'
  | 'view-staff'
  | 'create-carer'
  | 'view-carers'
  | 'create-player'
  | 'view-players'
  | 'add-games'
  | 'game-list'
  | 'payment-details'
  | 'listener-details'
  | 'shifts'
  | 'reach-out'
  | 'behaviours';

type StaffBehaviourRow = {
  staff: {
    staffId: string;
    name: string;
    role: string;
    createdAt?: { toDate?: () => Date } | null;
    rewardBlocked?: boolean;
  };
  accountCreation: {
    totalPlayersCreated: number;
    playersCreatedToday: number;
    playersCreatedYesterday: number;
    playersCreatedLast7d: number;
  };
  cashoutActivity: {
    totalCashoutRequestsHandled: number;
    totalCashoutAmountHandled: number;
    cashoutsToday: number;
    cashoutsYesterday: number;
    cashoutsLast7d: number;
    averageCashoutAmount: number;
  };
  playerRiskPatterns: {
    pendingReviewCashouts: number;
    bonusBlockedPlayers: number;
  };
  staffRiskSummary: {
    riskScore: number;
    riskLevel: 'low' | 'medium' | 'high';
    riskFlags: string[];
  };
  details: {
    playersCreated: Array<{
      playerId: string;
      username: string;
      createdAt?: { toDate?: () => Date } | null;
      bonusBlocked?: boolean;
    }>;
    recentCashoutsHandled: Array<{
      cashoutId: string;
      playerId: string;
      amount: number;
      status: string;
      createdAt?: { toDate?: () => Date } | null;
      completedAt?: { toDate?: () => Date } | null;
    }>;
    riskyPlayers: Array<{
      playerId: string;
      username: string;
      createdAt?: { toDate?: () => Date } | null;
      flags: string[];
    }>;
    pendingReviewCashouts: Array<{
      requestId: string;
      playerId: string;
      amount: number;
      status: string;
      reason: string;
      createdAt?: { toDate?: () => Date } | null;
    }>;
  };
};

type PaymentListenerForm = {
  id: string | null;
  label: string;
  provider: PaymentListenerProvider;
  email: string;
  password: string;
  imapHost: string;
  imapPort: string;
  useSsl: boolean;
  autoLoad: boolean;
  enabled: boolean;
};

function buildPaymentListenerForm(
  provider: PaymentListenerProvider = 'gmail',
  listener?: PaymentListener
): PaymentListenerForm {
  const defaults = paymentListenerDefaults(listener?.provider || provider);
  return {
    id: listener?.id || null,
    label: listener?.label || '',
    provider: listener?.provider || provider,
    email: listener?.email || '',
    password: '',
    imapHost: listener?.imapHost || defaults.imapHost,
    imapPort: String(listener?.imapPort || defaults.imapPort),
    useSsl: listener?.useSsl ?? defaults.useSsl,
    autoLoad: listener?.autoLoad ?? false,
    enabled: listener?.enabled ?? true,
  };
}

type PlayerRecordTab = 'coin-recharge' | 'cashout' | 'coin-recharge-ingame' | 'redeem';

type PlayerRecordRow = {
  id: string;
  dateLabel: string;
  amountValue: number;
  amountUnit: 'coin' | 'cash';
  amountLabel: string;
  statusLabel: string;
  sourceLabel: string;
  detailLabel: string;
  sortMs: number;
};

type SelectedPlayerHistoryResponse = {
  source?: 'postgres' | 'firestore';
  coadminAddedCoinTotal?: number;
  cashoutTotalAmount?: number;
  rows?: Partial<Record<PlayerRecordTab, PlayerRecordRow[]>>;
  error?: string;
};

const AED_TO_USD = 0.2723;
const NPR_TO_USD = 0.0075;
const NPR_TO_AED = NPR_TO_USD / AED_TO_USD;

function formatNprDisplay(value: number) {
  return `NPR ${Math.round(value).toLocaleString()}`;
}

function formatUsdDisplay(value: number) {
  return `USD ${Math.round(value || 0).toLocaleString()}`;
}

function formatUsdFromNprDisplay(value: number) {
  return formatUsdDisplay(Number(value || 0));
}

function formatDateTime(value?: Date | { toDate?: () => Date } | string | null) {
  if (!value) {
    return '—';
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'â€”' : value.toLocaleString();
  }
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleString();
  }
  const date = value.toDate?.();
  if (!date) {
    return '—';
  }
  return date.toLocaleString();
}

function formatHours(value: number) {
  return `${value.toFixed(2)} h`;
}

function formatPlayerRecordAmount(value: number, unit: 'coin' | 'cash') {
  const rounded = Math.max(0, Math.floor(Number(value || 0))).toLocaleString();
  return unit === 'cash' ? formatUsdFromNprDisplay(Number(value || 0)) : `${rounded} coin`;
}

function trendBadge(today: number, yesterday: number) {
  if (today > yesterday) return `up ${today} vs ${yesterday}`;
  if (today < yesterday) return `down ${today} vs ${yesterday}`;
  return `same ${today} vs ${yesterday}`;
}

function toMillis(value?: Date | { toDate?: () => Date; toMillis?: () => number; seconds?: number } | null) {
  if (!value) {
    return 0;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value.toMillis === 'function') {
    return value.toMillis();
  }
  if (typeof value.toDate === 'function') {
    return value.toDate().getTime();
  }
  if (typeof value.seconds === 'number') {
    return value.seconds * 1000;
  }
  return 0;
}

function randomInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function isQuotaExceededMessage(value: unknown) {
  const lower = String(value || '').toLowerCase();
  return (
    lower.includes('resource_exhausted') ||
    lower.includes('quota exceeded') ||
    (lower.includes('quota') && lower.includes('exceeded'))
  );
}

function calculateWorkedHoursLast24hWithHeartbeat(
  sessions: ShiftSession[],
  nowMs: number,
  heartbeatGraceMs: number
) {
  const windowStart = nowMs - 24 * 60 * 60 * 1000;
  let totalMs = 0;

  for (const session of sessions) {
    const loginMs = toMillis(session.loginAt || null);
    if (!loginMs) {
      continue;
    }

    const logoutMs = toMillis(session.logoutAt || null);
    const lastSeenMs = toMillis(session.lastSeenAt || null);
    const inferredAutoLogoutMs =
      session.isActive && lastSeenMs > 0 && nowMs - lastSeenMs > heartbeatGraceMs
        ? lastSeenMs
        : 0;
    const endMs = logoutMs || inferredAutoLogoutMs || nowMs;

    const start = Math.max(loginMs, windowStart);
    const end = Math.min(endMs, nowMs);
    if (end > start) {
      totalMs += end - start;
    }
  }

  return totalMs / (1000 * 60 * 60);
}

function logCoadminActionAuth(action: string) {
  console.info('[COADMIN_ACTION_AUTH]', {
    action,
    hasAppSession: Boolean(getLocalAppSessionId()),
    hasFirebaseUser: Boolean(auth.currentUser),
  });
}

function readInitialCoadminActorFromCache() {
  const cached = getCachedSessionUser();
  if (cached?.role === 'coadmin' && cached.uid) {
    return {
      uid: cached.uid,
      username: String(cached.username || ''),
    };
  }
  return { uid: '', username: '' };
}

function resolveCoadminActorUid(coadminActorUid: string) {
  return coadminActorUid || auth.currentUser?.uid || '';
}

function viewNeedsCoadminActor(view: CoadminView) {
  return (
    view === 'dashboard' ||
    view === 'view-staff' ||
    view === 'view-carers' ||
    view === 'create-carer' ||
    view === 'shifts' ||
    view === 'behaviours' ||
    view === 'view-players' ||
    view === 'game-list' ||
    view === 'reach-out' ||
    view === 'payment-details'
  );
}

type CoadminBaseLoadResult = {
  staffCount: number;
  carerCount: number;
  playerCount: number;
  requestCount: number;
  gameLoginCount: number;
  prefetchedStaff: StaffUser[];
};

const coadminBaseLoadInflight = new Map<string, Promise<CoadminBaseLoadResult>>();

export default function CoadminPage() {
  const [activeView, setActiveView] = useState<CoadminView>('dashboard');
  const [coadminActorUid, setCoadminActorUid] = useState(
    () => readInitialCoadminActorFromCache().uid
  );
  const [coadminActorUsername, setCoadminActorUsername] = useState(
    () => readInitialCoadminActorFromCache().username
  );

  const [staffUsername, setStaffUsername] = useState('');
  const [staffPassword, setStaffPassword] = useState('');
  const [staffList, setStaffList] = useState<StaffUser[]>([]);
  const [selectedStaff, setSelectedStaff] = useState<StaffUser | null>(null);
  const [deleteStaffTarget, setDeleteStaffTarget] = useState<StaffUser | null>(null);
  const [staffWalletsByUid, setStaffWalletsByUid] = useState<
    Record<string, CoadminStaffWalletRow>
  >({});
  const [staffWalletsLoading, setStaffWalletsLoading] = useState(false);
  const [staffWalletAmountByUid, setStaffWalletAmountByUid] = useState<Record<string, string>>({});
  const [staffWalletAllocatingUid, setStaffWalletAllocatingUid] = useState<string | null>(null);

  const [carerUsername, setCarerUsername] = useState('');
  const [carerPassword, setCarerPassword] = useState('');
  const [pendingCarerRequests, setPendingCarerRequests] = useState<CarerCreationRequest[]>([]);
  const [dismissedPendingCarerRequestIds, setDismissedPendingCarerRequestIds] = useState<string[]>(
    []
  );
  const [carerList, setCarerList] = useState<CarerUser[]>([]);
  const [selectedCarer, setSelectedCarer] = useState<CarerUser | null>(null);
  const [deleteCarerTarget, setDeleteCarerTarget] = useState<CarerUser | null>(null);

  const [playerUsername, setPlayerUsername] = useState('');
  const [playerPassword, setPlayerPassword] = useState('');
  const [playerReferralCodeInput, setPlayerReferralCodeInput] = useState('');
  const [playerList, setPlayerList] = useState<PlayerUser[]>([]);
  const [selectedPlayer, setSelectedPlayer] = useState<PlayerUser | null>(null);
  const [deletePlayerTarget, setDeletePlayerTarget] = useState<PlayerUser | null>(null);
  const [playerCoinAmountInput, setPlayerCoinAmountInput] = useState('');
  const [playerCashAmountInput, setPlayerCashAmountInput] = useState('');
  const [playerCoinAdjustBusy, setPlayerCoinAdjustBusy] = useState(false);
  const [playerCashAdjustBusy, setPlayerCashAdjustBusy] = useState(false);
  const [selectedPlayerCoadminAddedCoinTotal, setSelectedPlayerCoadminAddedCoinTotal] = useState(0);
  const [selectedPlayerCashoutTotalAmount, setSelectedPlayerCashoutTotalAmount] = useState(0);
  const [selectedPlayerTotalsLoading, setSelectedPlayerTotalsLoading] = useState(false);
  const [selectedPlayerRedeemLimitSummaries, setSelectedPlayerRedeemLimitSummaries] = useState<
    PlayerGameRedeemLimitSummary[]
  >([]);
  const [selectedPlayerRedeemLimitLoading, setSelectedPlayerRedeemLimitLoading] = useState(false);
  const [redeemLimitResetBusyGameName, setRedeemLimitResetBusyGameName] = useState<string | null>(
    null
  );
  const [selectedPlayerRecordTab, setSelectedPlayerRecordTab] =
    useState<PlayerRecordTab>('coin-recharge');
  const [selectedPlayerRecordLoading, setSelectedPlayerRecordLoading] = useState(false);
  const [selectedPlayerRecordPages, setSelectedPlayerRecordPages] = useState<
    Record<PlayerRecordTab, number>
  >({
    'coin-recharge': 1,
    cashout: 1,
    'coin-recharge-ingame': 1,
    redeem: 1,
  });
  const [selectedPlayerRecordRows, setSelectedPlayerRecordRows] = useState<
    Record<PlayerRecordTab, PlayerRecordRow[]>
  >({
    'coin-recharge': [],
    cashout: [],
    'coin-recharge-ingame': [],
    redeem: [],
  });

  const [gameName, setGameName] = useState('');
  const [gameUsername, setGameUsername] = useState('');
  const [gamePassword, setGamePassword] = useState('');
  const [gameBackendUrl, setGameBackendUrl] = useState('');
  const [gameFrontendUrl, setGameFrontendUrl] = useState('');
  const [gameLogins, setGameLogins] = useState<GameLogin[]>([]);
  const [editingGame, setEditingGame] = useState<GameLogin | null>(null);
  const [gameListDeletingId, setGameListDeletingId] = useState<string | null>(null);
  const [bonusName, setBonusName] = useState('');
  const [bonusGameName, setBonusGameName] = useState('');
  const [bonusAmount, setBonusAmount] = useState('');
  const [bonusDescription, setBonusDescription] = useState('');
  const [bonusPercentage, setBonusPercentage] = useState('');
  const [bonusEvents, setBonusEvents] = useState<BonusEvent[]>([]);
  const [autoBonusMinPercentInput, setAutoBonusMinPercentInput] = useState('5');
  const [autoBonusMaxPercentInput, setAutoBonusMaxPercentInput] = useState('10');
  const [autoBonusRangeBusy, setAutoBonusRangeBusy] = useState(false);
  const [maintenanceBreak, setMaintenanceBreak] = useState<MaintenanceBreak>(
    normalizeMaintenanceBreak(null)
  );
  const [maintenanceBusy, setMaintenanceBusy] = useState(false);
  const [freeplayGiveBusy, setFreeplayGiveBusy] = useState(false);
  const [freeplayGiveTargetUid, setFreeplayGiveTargetUid] = useState<string | null>(null);
  const [playerSignupCode, setPlayerSignupCode] = useState('');
  const [playerSignupCodeLoading, setPlayerSignupCodeLoading] = useState(false);
  const [playerSignupCodeRotating, setPlayerSignupCodeRotating] = useState(false);

  const [chatUsers, setChatUsers] = useState<AdminUser[]>([]);
  const [reachOutChatUser, setReachOutChatUser] = useState<AdminUser | null>(null);
  const [staffChatUser, setStaffChatUser] = useState<StaffUser | null>(null);

  const [newMessage, setNewMessage] = useState('');
  const coadminChatScrollRef = useRef<HTMLDivElement>(null);
  const lastRenderedCoadminChatReadRef = useRef('');
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});

  const [selectedImage, setSelectedImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [sendingImage, setSendingImage] = useState(false);

  const [paymentDetailPhotos, setPaymentDetailPhotos] = useState<PaymentDetailPhoto[]>([]);
  const [loadingPaymentDetailPhotos, setLoadingPaymentDetailPhotos] = useState(false);
  const [paymentDetailUploading, setPaymentDetailUploading] = useState(false);
  const [paymentListeners, setPaymentListeners] = useState<PaymentListener[]>([]);
  const [paymentListenersLoading, setPaymentListenersLoading] = useState(false);
  const [paymentListenerSaving, setPaymentListenerSaving] = useState(false);
  const [paymentListenerTestingId, setPaymentListenerTestingId] = useState<string | null>(null);
  const [paymentListenerDeletingId, setPaymentListenerDeletingId] = useState<string | null>(null);
  const [showPaymentListenerForm, setShowPaymentListenerForm] = useState(false);
  const [paymentListenerForm, setPaymentListenerForm] = useState<PaymentListenerForm>(
    buildPaymentListenerForm('gmail')
  );
  const [shiftSessions, setShiftSessions] = useState<ShiftSession[]>([]);
  const [rewardCutAmountByUid, setRewardCutAmountByUid] = useState<Record<string, string>>({});
  const [rewardCutReasonByUid, setRewardCutReasonByUid] = useState<Record<string, string>>({});
  const [rewardCutBusyUid, setRewardCutBusyUid] = useState<string | null>(null);

  const previousUnreadRef = useRef(0);
  const latestCarerEscalationIdRef = useRef<string | null>(null);
  const hasSeenCarerEscalationSnapshotRef = useRef(false);
  const suppressedCashoutIdsRef = useRef<Set<string>>(new Set());

  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [workerCredentialsLoading, setWorkerCredentialsLoading] = useState(false);
  const [blocking, setBlocking] = useState(false);
  const [loadingList, setLoadingList] = useState(false);
  const [latestCarerEscalation, setLatestCarerEscalation] =
    useState<CarerEscalationAlert | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('view') === 'listener-details') {
      setActiveView('listener-details');
    }
    const oauthStatus = params.get('paymentListenerOAuth');
    if (oauthStatus === 'connected') {
      setMessage('Outlook connected');
    } else if (oauthStatus === 'error') {
      setMessage('Outlook connection failed');
    }
  }, []);

  async function loadPlayerSignupCode() {
    setPlayerSignupCodeLoading(true);
    try {
      const response = await fetch('/api/coadmin/player-signup-code', {
        headers: await getApiAuthHeaders(false, { action: 'read' }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to load player signup code.');
      setPlayerSignupCode(String(data.code || ''));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to load player signup code.');
    } finally {
      setPlayerSignupCodeLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadPlayerSignupCode();
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function handleCopyPlayerSignupCode() {
    if (!playerSignupCode) return;
    try {
      await navigator.clipboard.writeText(playerSignupCode);
      setMessage('Player Signup Code copied.');
    } catch {
      setMessage('Unable to copy the Player Signup Code.');
    }
  }

  async function handleRotatePlayerSignupCode() {
    if (!window.confirm('Changing your signup code will immediately invalidate your old signup code. Existing players will not be affected.')) return;
    setPlayerSignupCodeRotating(true);
    try {
      const response = await fetch('/api/coadmin/player-signup-code', {
        method: 'POST',
        headers: await getApiAuthHeaders(true, { action: 'update' }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to rotate player signup code.');
      setPlayerSignupCode(String(data.code || ''));
      setMessage('Player Signup Code rotated.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to rotate player signup code.');
    } finally {
      setPlayerSignupCodeRotating(false);
    }
  }
  const [showCarerEscalationSplash, setShowCarerEscalationSplash] = useState(false);
  const [recentCarerEscalations, setRecentCarerEscalations] = useState<
    CarerEscalationAlert[]
  >([]);
  const [dismissedCarerEscalationIds, setDismissedCarerEscalationIds] = useState<
    string[]
  >([]);
  const [pendingCashouts, setPendingCashouts] = useState<CarerCashoutRequest[]>([]);
  const [cashoutDoneAmountById, setCashoutDoneAmountById] = useState<Record<string, string>>({});
  const [staffLedgerPayoutTasks, setStaffLedgerPayoutTasks] = useState<PlayerCashoutTask[]>([]);
  const [staffLedgerClaimPay, setStaffLedgerClaimPay] = useState<CarerCashoutRequest[]>([]);
  const [staffLiveCashBoxNpr, setStaffLiveCashBoxNpr] = useState<number | null>(null);
  const [carerRechargeRedeemTotals, setCarerRechargeRedeemTotals] = useState<
    Record<string, CarerRechargeRedeemTotals>
  >({});
  const [pendingCashoutTasks, setPendingCashoutTasks] = useState<PlayerCashoutTask[]>([]);
  const [activeCashoutTasks, setActiveCashoutTasks] = useState<PlayerCashoutTask[]>([]);
  const [completedCashoutTasks, setCompletedCashoutTasks] = useState<PlayerCashoutTask[]>([]);
  const pendingCashoutAlertIds = useMemo(
    () => pendingCashoutTasks.map((task) => task.id),
    [pendingCashoutTasks]
  );
  const cashoutAlerts = useStaffCashoutAlerts(pendingCashoutAlertIds);
  const [playerCashoutTaskLoadingId, setPlayerCashoutTaskLoadingId] = useState<string | null>(
    null
  );
  const [countdownTick, setCountdownTick] = useState(0);
  const [staffBehaviours, setStaffBehaviours] = useState<StaffBehaviourRow[]>([]);
  const [behavioursLoading, setBehavioursLoading] = useState(false);
  const [selectedBehaviourStaffId, setSelectedBehaviourStaffId] = useState<string | null>(null);
  const [rewardBlockBusyStaffId, setRewardBlockBusyStaffId] = useState<string | null>(null);
  const bonusAutoFillBusyRef = useRef(false);
  const bonusEventsRetryTimerRef = useRef<number | null>(null);
  const bonusEventsRetryCountRef = useRef(0);
  const bonusEventsLastEnsureAttemptedCountRef = useRef<number | null>(null);
  const bonusEventsEnsureCooldownUntilMsRef = useRef(0);
  const bonusEventsLastEnsureAttemptAtMsRef = useRef(0);
  const bonusEventsLatestActiveCountRef = useRef(0);
  const bonusEventsLastMissingCountRef = useRef<number | null>(null);
  const refetchCashoutTasksRef = useRef<(() => void) | null>(null);
  const BONUS_ENSURE_CLIENT_COOLDOWN_MS = 45_000;

  function resetBonusEventsEnsureGuard(reason: string) {
    bonusEventsLastEnsureAttemptedCountRef.current = null;
    bonusEventsLastMissingCountRef.current = null;
    console.info('[BONUS_EVENTS_ENSURE_GUARD_RESET]', { reason });
  }

  const activeChatUser =
    activeView === 'reach-out' ? reachOutChatUser : staffChatUser;
  const isBonusEventsView =
    activeView === 'view-bonus-events' || activeView === 'create-bonus-event';
  const selectedPlayerUid = selectedPlayer?.uid || '';
  const selectedStaffUid = selectedStaff?.uid || '';

  const pagedCoadminChat = usePaginatedChatMessages(activeChatUser?.uid ?? null, {
    scrollContainerRef: coadminChatScrollRef,
  });

  const messages: ChatMessage[] = useMemo(() => {
    const actorUid = coadminActorUid || auth.currentUser?.uid || '';
    return mapFirestoreChatToDisplay(pagedCoadminChat.items, actorUid);
  }, [coadminActorUid, pagedCoadminChat.items]);

  useLayoutEffect(() => {
    if (!activeChatUser || messages.length === 0) {
      return;
    }
    const lastMessageId = messages[messages.length - 1]?.id || '';
    const readKey = `${activeChatUser.uid}:${lastMessageId}`;
    if (lastRenderedCoadminChatReadRef.current === readKey) {
      return;
    }
    lastRenderedCoadminChatReadRef.current = readKey;
    const frameId = window.requestAnimationFrame(() => {
      void markConversationAsRead(activeChatUser.uid);
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [activeChatUser, messages]);

  const totalUnread = Object.values(unreadCounts).reduce(
    (total, count) => total + count,
    0
  );

  useEffect(() => {
    const actorUid = coadminActorUid || auth.currentUser?.uid || '';
    const returnedMessages = pagedCoadminChat.items.length;
    const visibleMessages = messages.length;
    console.info('[CHAT_MESSAGES_RENDER]', {
      stateMessagesLength: returnedMessages,
      visibleMessagesLength: visibleMessages,
      currentUid: actorUid,
      currentRole: 'coadmin',
      selectedPeerUid: activeChatUser?.uid || null,
    });
    if (returnedMessages > 0 && visibleMessages === 0) {
      console.warn('[CHAT_MESSAGES_HIDDEN_BY_UI_FILTER]', {
        returnedMessages,
        currentUid: actorUid,
        selectedPeerUid: activeChatUser?.uid || null,
      });
    }
    const peerUnread = activeChatUser ? unreadCounts[activeChatUser.uid] || 0 : 0;
    if (peerUnread > 0 && returnedMessages === 0) {
      console.warn('[CHAT_INCONSISTENT_UNREAD_NO_MESSAGES]', {
        peerUid: activeChatUser?.uid || null,
        unreadCount: peerUnread,
        currentUid: actorUid,
      });
    }
    console.info('[MESSAGES_RENDER_FILTER]', {
      totalMessages: returnedMessages,
      visibleMessages,
      currentRole: 'coadmin',
      coadminUid: coadminActorUid || null,
      selectedPeerUid: activeChatUser?.uid || null,
      activeView,
      unreadPeerCount: Object.keys(unreadCounts).length,
      playerCount: playerList.length,
      staffCount: staffList.length,
      totalUnread,
    });
  }, [
    pagedCoadminChat.items.length,
    messages.length,
    coadminActorUid,
    activeChatUser?.uid,
    activeView,
    unreadCounts,
    playerList.length,
    staffList.length,
    totalUnread,
  ]);

  const staffUnreadCount = staffList.reduce(
    (total, staff) => total + (unreadCounts[staff.uid] || 0),
    0
  );

  const reachOutUnreadCount = chatUsers.reduce(
    (total, user) => total + (unreadCounts[user.uid] || 0),
    0
  );
  const visibleRecentCarerEscalations = recentCarerEscalations
    .filter((alert) => !dismissedCarerEscalationIds.includes(alert.id))
    .slice(0, 24);
  const visiblePendingCarerRequests = pendingCarerRequests.filter(
    (request) => !dismissedPendingCarerRequestIds.includes(request.id)
  );
  const coadminCashoutViewerUid = coadminActorUid || auth.currentUser?.uid || '';
  const visiblePlayerCashoutTasks = [...pendingCashoutTasks, ...activeCashoutTasks]
    .filter((task) => {
      if (isPlayerCashoutHandledBySomeoneElse(task, coadminCashoutViewerUid)) {
        return false;
      }
      const effective = getEffectivePlayerCashoutTaskStatus(task);
      return effective !== 'completed' && effective !== 'declined';
    })
    .map((task) => ({
      ...task,
      status: getEffectivePlayerCashoutTaskStatus(task),
    }));
  const completedPlayerCashoutTasks = completedCashoutTasks;
  const selectedBehaviour = useMemo(
    () =>
      staffBehaviours.find((row) => row.staff.staffId === selectedBehaviourStaffId) ||
      staffBehaviours[0] ||
      null,
    [staffBehaviours, selectedBehaviourStaffId]
  );
  const myBonusEvents = bonusEvents;

  const staffInspectionAlerts = useMemo(() => {
    if (!selectedStaff) {
      return [] as CarerEscalationAlert[];
    }
    const staffUid = selectedStaff.uid;
    const handledPlayerIds = new Set(
      staffLedgerPayoutTasks.map((task) => task.playerUid).filter(Boolean)
    );
    return [...recentCarerEscalations]
      .filter((alert) => !dismissedCarerEscalationIds.includes(alert.id))
      .filter((alert) => {
        if (alert.createdByCarerUid === staffUid) {
          return true;
        }
        if (alert.contextType !== 'cashbox_inquiry') {
          return false;
        }
        const pid = alert.playerUid;
        if (!pid || !handledPlayerIds.has(pid)) {
          return false;
        }
        return (
          alert.escalationFrom === 'player' ||
          alert.escalationFrom === 'risk_auto' ||
          !alert.escalationFrom
        );
      })
      .sort(
        (a, b) =>
          toMillis(b.createdAt || null) - toMillis(a.createdAt || null)
      );
  }, [
    selectedStaff,
    staffLedgerPayoutTasks,
    recentCarerEscalations,
    dismissedCarerEscalationIds,
  ]);

  useEffect(() => {
    if (!message) {
      return;
    }

    const timer = window.setTimeout(() => {
      setMessage((current) => (current === message ? '' : current));
    }, isQuotaExceededMessage(message) ? 15000 : 7000);

    return () => window.clearTimeout(timer);
  }, [message]);

  function clearBonusEventsMessage() {
    setMessage((current) => (isQuotaExceededMessage(current) ? '' : current));
  }

  async function handleMaintenanceBreakToggle(enabled: boolean) {
    setMaintenanceBusy(true);
    setMessage('');

    try {
      await setCoadminMaintenanceBreak(enabled);
      console.info(
        enabled ? '[MAINTENANCE] enabled by coadmin' : '[MAINTENANCE] disabled by coadmin',
        { coadminUid: auth.currentUser?.uid || null }
      );
      setMessage(enabled ? 'Maintenance Break started.' : 'Maintenance Break ended.');
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : 'Failed to update Maintenance Break.'
      );
    } finally {
      setMaintenanceBusy(false);
    }
  }

  async function handleGiveFreeplay() {
    if (freeplayGiveBusy || freeplayGiveTargetUid) {
      return;
    }
    setFreeplayGiveBusy(true);
    setMessage('');
    try {
      const result = await giveFreeplayGift();
      setMessage(`FreePlay gift sent to ${result.playerUsername}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to give FreePlay gift.');
    } finally {
      setFreeplayGiveBusy(false);
    }
  }

  async function handleGiveFreeplayToPlayer(player: PlayerUser) {
    if (freeplayGiveBusy || freeplayGiveTargetUid || !player.uid) {
      return;
    }
    console.info('[FREEPLAY_GIVE_BUTTON_CLICK]', {
      source: 'selected_player_panel',
      targetPlayerUid: player.uid,
    });
    setFreeplayGiveTargetUid(player.uid);
    setMessage('');
    try {
      const result = await giveFreeplayGift({
        targetPlayerUid: player.uid,
        reason: 'manual_specific_player',
      });
      setMessage(`FreePlay gift sent to ${result.playerUsername}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to give FreePlay gift.');
    } finally {
      setFreeplayGiveTargetUid(null);
    }
  }

  function scheduleBonusEventsRetry(restart: () => void) {
    if (bonusEventsRetryTimerRef.current != null) {
      window.clearTimeout(bonusEventsRetryTimerRef.current);
    }

    const retryAttempt = bonusEventsRetryCountRef.current;
    const retryDelayMs = Math.min(60_000, 2_000 * 2 ** retryAttempt);
    bonusEventsRetryTimerRef.current = window.setTimeout(() => {
      bonusEventsRetryTimerRef.current = null;
      restart();
    }, retryDelayMs);
    bonusEventsRetryCountRef.current += 1;
  }

  useEffect(() => {
    let cancelled = false;

    async function resolveFromAppSession() {
      await ensureAppSessionBootstrapped();
      const sessionUser = getCachedSessionUser() || (await getSessionUserOnce());
      if (!sessionUser?.uid || sessionUser.role !== 'coadmin') {
        return false;
      }
      if (cancelled) {
        return true;
      }
      setCoadminActorUid(sessionUser.uid);
      setCoadminActorUsername(String(sessionUser.username || ''));
      console.info('[COADMIN_PAGE_AUTH]', {
        source: 'app_session',
        uid: sessionUser.uid,
        role: sessionUser.role,
        ok: true,
      });
      return true;
    }

    async function resolveFromFirebase(user: NonNullable<typeof auth.currentUser>) {
      if (cancelled) {
        return;
      }
      setCoadminActorUid(user.uid);
      if (isClientSqlReadMode()) {
        logClientFirestoreSkipped('coadmin_actor_profile', { uid: user.uid });
        const sessionUser = getCachedSessionUser() || (await getSessionUserOnce());
        setCoadminActorUsername(String(sessionUser?.username || ''));
      } else {
        try {
          const userSnap = await getDoc(doc(db, 'users', user.uid));
          const data = userSnap.data() as { username?: string } | undefined;
          setCoadminActorUsername(String(data?.username || ''));
        } catch {
          // Non-blocking profile read for display name.
        }
      }
      console.info('[COADMIN_PAGE_AUTH]', {
        source: 'firebase',
        uid: user.uid,
        role: 'coadmin',
        ok: true,
      });
    }

    void (async () => {
      try {
        const fromSession = await resolveFromAppSession();
        if (!fromSession && !cancelled) {
          const firebaseUser = auth.currentUser;
          if (firebaseUser) {
            await resolveFromFirebase(firebaseUser);
          } else {
            console.info('[COADMIN_PAGE_AUTH]', {
              source: 'none',
              ok: false,
              reason: 'missing_session_and_firebase_user',
            });
          }
        }
      } catch (error) {
        if (!cancelled) {
          console.info('[COADMIN_PAGE_AUTH]', {
            source: 'app_session',
            ok: false,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();

    const stopAuthListener = onAuthStateChanged(auth, (user) => {
      if (getCachedSessionUser()?.role === 'coadmin') {
        return;
      }
      if (user) {
        void resolveFromFirebase(user);
      }
    });

    return () => {
      cancelled = true;
      stopAuthListener();
    };
  }, []);

  useEffect(() => {
    let isCancelled = false;

    async function loadAutoBonusPercentRange() {
      try {
        const coadminUid = await getCurrentUserCoadminUid();
        const range = await getCoadminAutoBonusPercentRange(coadminUid);
        if (isCancelled) {
          return;
        }
        setAutoBonusMinPercentInput(String(range.minPercent));
        setAutoBonusMaxPercentInput(String(range.maxPercent));
      } catch (error: unknown) {
        if (!isCancelled) {
          setMessage(
            error instanceof Error
              ? error.message
              : 'Failed to load auto-created bonus range.'
          );
        }
      }
    }

    void loadAutoBonusPercentRange();

    return () => {
      isCancelled = true;
    };
  }, []);

  useEffect(() => {
    let stopMaintenanceListener: (() => void) | null = null;
    const stopAuthListener = onAuthStateChanged(auth, (user) => {
      stopMaintenanceListener?.();
      stopMaintenanceListener = null;
      if (!user) {
        setMaintenanceBreak(normalizeMaintenanceBreak(null));
        return;
      }

      stopMaintenanceListener = listenCoadminMaintenanceBreak(
        user.uid,
        setMaintenanceBreak,
        () => setMaintenanceBreak(normalizeMaintenanceBreak(null))
      );
    });

    return () => {
      stopAuthListener();
      stopMaintenanceListener?.();
    };
  }, []);

  useEffect(() => {
    const actorUid = resolveCoadminActorUid(coadminActorUid);
    if (viewNeedsCoadminActor(activeView) && !actorUid) {
      return;
    }

    if (activeView === 'dashboard') {
      void loadDashboardBaseData(actorUid);
    }

    if (activeView === 'view-staff') loadStaffList();
    if (activeView === 'view-carers') {
      loadCarerList();
      void loadPendingCarerRequestsForCoadmin();
    }
    if (activeView === 'create-carer') {
      void loadPendingCarerRequestsForCoadmin();
    }
    if (activeView === 'shifts') {
      loadStaffList();
      loadCarerList();
    }
    if (activeView === 'behaviours') loadStaffList();
    if (activeView === 'view-players') loadPlayerList();
    if (activeView === 'game-list') loadGameLogins();
    if (activeView === 'reach-out') loadChatUsers();
    if (activeView === 'behaviours') void loadStaffBehaviours();
  }, [activeView, coadminActorUid]);

  useEffect(() => {
    if (!coadminActorUid) {
      return;
    }
    setPlayerCoinAmountInput('');
  }, [activeView, selectedPlayerUid, coadminActorUid]);

  async function loadSelectedPlayerRedeemLimitSummaries(playerUid: string) {
    const cleanPlayerUid = String(playerUid || '').trim();
    if (!cleanPlayerUid) {
      setSelectedPlayerRedeemLimitSummaries([]);
      setSelectedPlayerRedeemLimitLoading(false);
      return;
    }

    setSelectedPlayerRedeemLimitLoading(true);

    try {
      const [playerGameLogins, redeemRequestsSnap] = await Promise.all([
        getPlayerGameLoginsByPlayer(cleanPlayerUid),
        getDocs(
          query(
            collection(db, 'playerGameRequests'),
            where('playerUid', '==', cleanPlayerUid),
            where('type', '==', 'redeem'),
            orderBy('createdAt', 'desc'),
            limit(SELECTED_PLAYER_RECORD_QUERY_LIMIT)
          )
        ),
      ]);

      const gameNames = Array.from(
        new Set(
          [
            ...playerGameLogins.map((login) => String(login.gameName || '').trim()),
            ...redeemRequestsSnap.docs.map((docSnap) =>
              String((docSnap.data() as { gameName?: string }).gameName || '').trim()
            ),
          ].filter(Boolean)
        )
      ).sort((left, right) => left.localeCompare(right));

      const summaries = await Promise.all(
        gameNames.map((name) => getPlayerGameRedeemLimitSummary(cleanPlayerUid, name))
      );
      setSelectedPlayerRedeemLimitSummaries(summaries);
    } catch (error) {
      setSelectedPlayerRedeemLimitSummaries([]);
      setMessage(
        error instanceof Error ? error.message : 'Failed to load redeem limit details.'
      );
    } finally {
      setSelectedPlayerRedeemLimitLoading(false);
    }
  }

  useEffect(() => {
    const playerUid = selectedPlayerUid;
    if (!playerUid) {
      setSelectedPlayerCoadminAddedCoinTotal(0);
      setSelectedPlayerCashoutTotalAmount(0);
      setSelectedPlayerTotalsLoading(false);
      setSelectedPlayerRecordLoading(false);
      setSelectedPlayerRecordPages({
        'coin-recharge': 1,
        cashout: 1,
        'coin-recharge-ingame': 1,
        redeem: 1,
      });
      setSelectedPlayerRecordRows({
        'coin-recharge': [],
        cashout: [],
        'coin-recharge-ingame': [],
        redeem: [],
      });
      setSelectedPlayerRedeemLimitSummaries([]);
      setSelectedPlayerRedeemLimitLoading(false);
      setRedeemLimitResetBusyGameName(null);
      return;
    }
    if (!coadminActorUid) {
      return;
    }

    let cancelled = false;
    setSelectedPlayerTotalsLoading(true);
    setSelectedPlayerRecordLoading(true);

    void (async () => {
      try {
        await ensureAppSessionBootstrapped();
        const historyHeaders = getLocalAppSessionId()
          ? getAppSessionRequestHeaders()
          : await getFirebaseApiHeaders(false);
        const response = await fetch(
          `/api/coadmin/players/${encodeURIComponent(playerUid)}/history`,
          {
            headers: historyHeaders,
          }
        );
        const payload = (await response.json()) as SelectedPlayerHistoryResponse;
        if (!response.ok) {
          throw new Error(payload.error || 'Failed to load player totals.');
        }
        const rows = payload.rows || {};

        if (!cancelled) {
          setSelectedPlayerCoadminAddedCoinTotal(
            Math.round(Number(payload.coadminAddedCoinTotal || 0))
          );
          setSelectedPlayerCashoutTotalAmount(
            Math.round(Number(payload.cashoutTotalAmount || 0))
          );
          setSelectedPlayerRecordPages({
            'coin-recharge': 1,
            cashout: 1,
            'coin-recharge-ingame': 1,
            redeem: 1,
          });
          setSelectedPlayerRecordRows({
            'coin-recharge': rows['coin-recharge'] || [],
            cashout: rows.cashout || [],
            'coin-recharge-ingame': rows['coin-recharge-ingame'] || [],
            redeem: rows.redeem || [],
          });
        }
      } catch (error) {
        if (!cancelled) {
          setSelectedPlayerCoadminAddedCoinTotal(0);
          setSelectedPlayerCashoutTotalAmount(0);
          setSelectedPlayerRecordRows({
            'coin-recharge': [],
            cashout: [],
            'coin-recharge-ingame': [],
            redeem: [],
          });
          setMessage(error instanceof Error ? error.message : 'Failed to load player totals.');
        }
      } finally {
        if (!cancelled) {
          setSelectedPlayerTotalsLoading(false);
          setSelectedPlayerRecordLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeView, selectedPlayerUid, coadminActorUid]);

  useEffect(() => {
    if (!coadminActorUid || !selectedPlayerUid) {
      return;
    }
    void loadSelectedPlayerRedeemLimitSummaries(selectedPlayerUid);
  }, [activeView, selectedPlayerUid, coadminActorUid]);

  useEffect(() => {
    if (!selectedStaffUid) {
      setStaffLedgerPayoutTasks([]);
      setStaffLedgerClaimPay([]);
      setStaffLiveCashBoxNpr(null);
      return;
    }
    if (!coadminActorUid) {
      return;
    }

    const uid = selectedStaffUid;
    let cancelled = false;

    const unsubscribePayoutLedger = listenPlayerCashoutTasksByAssignedHandler(
      uid,
      (tasks) => {
        if (!cancelled) {
          setStaffLedgerPayoutTasks(tasks);
        }
      },
      (error) => {
        if (!cancelled) {
          setMessage(error.message || 'Could not load staff player cashout ledger.');
        }
      }
    );

    const unsubscribeClaimPayLedger = listenCarerCashoutsByCarerUid(
      uid,
      (requests) => {
        if (!cancelled) {
          setStaffLedgerClaimPay(requests);
        }
      },
      (error) => {
        if (!cancelled) {
          setMessage(error.message || 'Could not load staff Claim Pay history.');
        }
      }
    );

    let unsubscribeStaffProfile = () => {};
    let staffProfilePollTimer: ReturnType<typeof setTimeout> | null = null;

    if (isClientSqlReadMode()) {
      logClientFirestoreSkipped('staff_live_cash_box', { staffUid: uid });
      const STAFF_CASH_BOX_POLL_MS = 12_000;
      const pollStaffCashBox = async () => {
        if (cancelled) {
          return;
        }
        if (isDocumentHidden()) {
          logHiddenTabPollThrottled('coadmin_staff_cash_box', HIDDEN_THROTTLED_POLL_MS);
          staffProfilePollTimer = setTimeout(() => {
            void pollStaffCashBox();
          }, HIDDEN_THROTTLED_POLL_MS);
          return;
        }
        try {
          const response = await fetch('/api/users/cache?role=staff', {
            method: 'GET',
            headers: await getFirebaseApiHeaders(false),
            cache: 'no-store',
          });
          const payload = (await response.json().catch(() => ({}))) as {
            users?: Array<{ uid?: string; cashBoxNpr?: number }>;
          };
          if (!cancelled && response.ok) {
            const staff = (payload.users || []).find((entry) => entry.uid === uid);
            setStaffLiveCashBoxNpr(Number(staff?.cashBoxNpr || 0));
          }
        } catch (error) {
          if (!cancelled) {
            setMessage(
              error instanceof Error ? error.message : 'Could not monitor staff cash box.'
            );
          }
        } finally {
          if (!cancelled) {
            staffProfilePollTimer = setTimeout(() => {
              void pollStaffCashBox();
            }, resolveVisiblePollIntervalMs(STAFF_CASH_BOX_POLL_MS));
          }
        }
      };
      const detachStaffCashBoxHiddenResume = attachHiddenTabPollResume(
        'coadmin_staff_cash_box',
        () => {
          void pollStaffCashBox();
        }
      );
      void pollStaffCashBox();
      unsubscribeStaffProfile = () => {
        detachStaffCashBoxHiddenResume();
        if (staffProfilePollTimer != null) {
          clearTimeout(staffProfilePollTimer);
          staffProfilePollTimer = null;
        }
      };
    } else {
      const profileRef = doc(db, 'users', uid);
      unsubscribeStaffProfile = onSnapshot(
        profileRef,
        (snapshot) => {
          if (cancelled) {
            return;
          }
          if (!snapshot.exists()) {
            setStaffLiveCashBoxNpr(0);
            return;
          }
          const data = snapshot.data() as { cashBoxNpr?: number };
          setStaffLiveCashBoxNpr(Number(data.cashBoxNpr || 0));
        },
        (error) => {
          if (!cancelled) {
            setMessage(error.message || 'Could not monitor staff cash box.');
          }
        }
      );
    }

    return () => {
      cancelled = true;
      unsubscribePayoutLedger();
      unsubscribeClaimPayLedger();
      unsubscribeStaffProfile();
    };
  }, [activeView, selectedStaffUid, coadminActorUid]);

  useEffect(() => {
    if (activeView !== 'payment-details') {
      return;
    }
    const uid = resolveCoadminActorUid(coadminActorUid);
    if (!uid) {
      return;
    }
    let cancelled = false;
    setLoadingPaymentDetailPhotos(true);
    setMessage('');
    void (async () => {
      try {
        const urls = await getCoadminPaymentDetailPhotos(uid);
        if (!cancelled) {
          setPaymentDetailPhotos(urls);
        }
      } catch {
        if (!cancelled) {
          setMessage('Failed to load payment reference photos.');
        }
      } finally {
        if (!cancelled) {
          setLoadingPaymentDetailPhotos(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeView, coadminActorUid]);

  useEffect(() => {
    if (activeView !== 'listener-details') {
      return;
    }
    const uid = resolveCoadminActorUid(coadminActorUid);
    if (!uid) {
      return;
    }
    let cancelled = false;
    setPaymentListenersLoading(true);
    setMessage('');
    void listPaymentListeners(uid)
      .then((listeners) => {
        if (!cancelled) {
          setPaymentListeners(listeners);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setMessage(error instanceof Error ? error.message : 'Failed to load listeners.');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setPaymentListenersLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeView, coadminActorUid]);

  useEffect(() => {
    if (!isBonusEventsView) {
      bonusEventsLastEnsureAttemptedCountRef.current = null;
      return;
    }

    let isCancelled = false;
    let unsubscribe: (() => void) | undefined;

    async function startBonusEventsListener() {
      try {
        const coadminUid = await getCurrentUserCoadminUid();
        const currentUid = auth.currentUser?.uid || null;
        console.info('[bonusEvents] listener-started', {
          coadminUid,
          currentUid,
        });

        if (isCancelled) {
          return;
        }

        const tryAutoFill = (activeCount: number) => {
          const desiredCapacity = MAX_ACTIVE_BONUS_EVENTS;
          const missingCount = Math.max(0, desiredCapacity - activeCount);
          console.info('[BONUS_ENSURE_ENTRY]', {
            activeCount,
            coadminUid,
            view: activeView,
            desiredCapacity,
            missingCount,
          });
          bonusEventsLatestActiveCountRef.current = activeCount;
          console.info('[BONUS_ENSURE_ACTIVE_COUNT]', {
            activeCount,
            cap: MAX_ACTIVE_BONUS_EVENTS,
            expiredRowsNotCounted: true,
          });
          if (activeCount >= MAX_ACTIVE_BONUS_EVENTS) {
            bonusEventsLastEnsureAttemptedCountRef.current = null;
            bonusEventsEnsureCooldownUntilMsRef.current = Date.now() + 60_000;
            bonusEventsLastMissingCountRef.current = null;
            console.info('[bonusEvents] skipped-client-full', {
              activeCount,
              cap: MAX_ACTIVE_BONUS_EVENTS,
            });
            return;
          }
          console.info('[BONUS_ENSURE_MISSING]', {
            activeCount,
            missingCount,
            desiredCapacity: MAX_ACTIVE_BONUS_EVENTS,
          });
          const isFirstEmptyAttempt =
            activeCount === 0 && bonusEventsLastEnsureAttemptAtMsRef.current === 0;
          const nowMs = Date.now();
          if (!isFirstEmptyAttempt && bonusEventsEnsureCooldownUntilMsRef.current > nowMs) {
            console.info('[BONUS_ENSURE_COOLDOWN_BLOCK]', {
              reason: 'client_cooldown_until',
              activeCount,
              missingCount,
              retryAfterMs: bonusEventsEnsureCooldownUntilMsRef.current - nowMs,
            });
            console.info('[bonusEvents] skipped-client-cooldown', {
              activeCount,
              missingCount,
              retryAfterMs: bonusEventsEnsureCooldownUntilMsRef.current - nowMs,
            });
            return;
          }
          if (!isFirstEmptyAttempt && bonusEventsLastMissingCountRef.current === missingCount) {
            bonusEventsEnsureCooldownUntilMsRef.current = nowMs + BONUS_ENSURE_CLIENT_COOLDOWN_MS;
            console.info('[BONUS_ENSURE_COOLDOWN_BLOCK]', {
              reason: 'client_missing_count_unchanged',
              activeCount,
              missingCount,
              retryAfterMs: BONUS_ENSURE_CLIENT_COOLDOWN_MS,
            });
            console.info('[bonusEvents] skipped-client-cooldown', {
              activeCount,
              missingCount,
              retryAfterMs: BONUS_ENSURE_CLIENT_COOLDOWN_MS,
            });
            return;
          }
          if (
            bonusAutoFillBusyRef.current ||
            (activeCount > 0 &&
              bonusEventsLastEnsureAttemptedCountRef.current === activeCount)
          ) {
            console.info('[BONUS_ENSURE_COOLDOWN_BLOCK]', {
              reason: bonusAutoFillBusyRef.current ? 'busy' : 'already_attempted_count',
              activeCount,
            });
            console.info('[BONUS_EVENTS_ENSURE_SKIPPED]', {
              reason: bonusAutoFillBusyRef.current ? 'busy' : 'already_attempted_count',
              activeCount,
            });
            return;
          }

          if (activeCount === 0) {
            console.info('[BONUS_EVENTS_ENSURE_RETRY_ALLOWED]', {
              activeCount,
              reason: 'zero_active_capacity',
            });
          }

          if (activeCount > 0) {
            bonusEventsLastEnsureAttemptedCountRef.current = activeCount;
          }
          bonusEventsLastMissingCountRef.current = missingCount;
          console.info('[bonusEvents] ensure-trigger', {
            activeCount,
            missingCount,
            view: activeView,
          });
          void (async () => {
            try {
              await ensureCoadminBonusCapacity(activeCount, {
                ignoreCooldown: isFirstEmptyAttempt,
              });
            } catch (error: unknown) {
              bonusEventsLastEnsureAttemptedCountRef.current = null;
              if (!isCancelled) {
                const msg =
                  error instanceof Error
                    ? error.message
                    : 'Failed to auto-create bonus events.';
                console.info('[bonusEvents] ensure-error', { message: msg });
                logBonusEventsUiGuard({
                  page: 'coadmin_page_bonus_events_ensure',
                  reason: msg,
                  message: msg,
                  blocked: true,
                  coadminUid: coadminActorUid || null,
                  isCoadminView: true,
                  isPlayerView: false,
                });
                setMessage(msg);
              }
            } finally {
              // capacity helper manages busy flag lifecycle
            }
          })();
        };

        unsubscribe = listenBonusEventsByCoadmin(
          coadminUid,
          (events) => {
            if (!isCancelled) {
              bonusEventsRetryCountRef.current = 0;
              console.info('[coadmin bonusEvents] render-values', {
                snapshotSize: events.length,
                firstEventId: events[0]?.id || null,
                firstEventPercent:
                  events.length > 0
                    ? Number(events[0].bonusPercentage || events[0].bonus_percentage || 0)
                    : null,
                percents: events.slice(0, 10).map((event) =>
                  Number(event.bonusPercentage || event.bonus_percentage || 0)
                ),
              });
              setBonusEvents(events);
              clearBonusEventsMessage();
              tryAutoFill(events.length);
            }
          },
          (error) => {
            if (!isCancelled) {
              const errMsg = error.message || 'Failed to listen for bonus events.';
              logBonusEventsUiGuard({
                page: 'coadmin_page_bonus_events',
                reason: errMsg,
                message: errMsg,
                blocked: true,
                coadminUid: coadminActorUid || null,
                isCoadminView: true,
                isPlayerView: false,
              });
              setMessage(errMsg);
              scheduleBonusEventsRetry(() => {
                if (!isCancelled) {
                  void startBonusEventsListener();
                }
              });
            }
          },
          { skipTimeWindowFilter: true, onActiveFilterEmpty: () => resetBonusEventsEnsureGuard('active_filter_empty') }
        );
      } catch (error: any) {
        if (!isCancelled) {
          const errMsg = error?.message || 'Failed to start bonus events listener.';
          logBonusEventsUiGuard({
            page: 'coadmin_page_bonus_events_start',
            reason: errMsg,
            message: errMsg,
            blocked: true,
            coadminUid: coadminActorUid || null,
            isCoadminView: true,
            isPlayerView: false,
          });
          setMessage(errMsg);
          if (String(errMsg).toLowerCase().includes('not authenticated')) {
            bonusEventsRetryCountRef.current = 0;
            bonusEventsRetryTimerRef.current = window.setTimeout(() => {
              bonusEventsRetryTimerRef.current = null;
              if (!isCancelled) {
                void startBonusEventsListener();
              }
            }, 1200);
            return;
          }
          scheduleBonusEventsRetry(() => {
            if (!isCancelled) {
              void startBonusEventsListener();
            }
          });
        }
      }
    }

    void startBonusEventsListener();

    return () => {
      isCancelled = true;
      unsubscribe?.();
      if (bonusEventsRetryTimerRef.current != null) {
        window.clearTimeout(bonusEventsRetryTimerRef.current);
        bonusEventsRetryTimerRef.current = null;
      }
    };
  }, [isBonusEventsView]);

  useEffect(() => {
    let isCancelled = false;
    let unsubscribe: (() => void) | undefined;

    async function startShiftSessionListener() {
      try {
        const coadminUid = await getCurrentUserCoadminUid();
        if (isCancelled) {
          return;
        }
        unsubscribe = listenShiftSessionsByCoadmin(
          coadminUid,
          (items) => {
            if (!isCancelled) {
              setShiftSessions(items);
            }
          },
          (error) => {
            if (!isCancelled) {
              setMessage(error.message || 'Failed to listen for shifts.');
            }
          }
        );
      } catch (error: any) {
        if (!isCancelled) {
          setMessage(error.message || 'Failed to start shifts listener.');
        }
      }
    }

    void startShiftSessionListener();

    return () => {
      isCancelled = true;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    let isCancelled = false;
    let unsubscribe: (() => void) | undefined;

    async function startCarerTotalsListener() {
      try {
        const coadminUid = await getCurrentUserCoadminUid();

        if (isCancelled) {
          return;
        }

        unsubscribe = listenCarerRechargeRedeemTotalsByCoadmin(
          coadminUid,
          (totals) => {
            if (!isCancelled) {
              setCarerRechargeRedeemTotals(totals);
            }
          },
          (error) => {
            if (!isCancelled) {
              setMessage(error.message || 'Failed to listen for carer totals.');
            }
          }
        );
      } catch (error: any) {
        if (!isCancelled) {
          setMessage(error.message || 'Failed to start carer totals listener.');
        }
      }
    }

    void startCarerTotalsListener();

    return () => {
      isCancelled = true;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    const currentUser = auth.currentUser;
    if (!currentUser) return;

    const unsubscribe = listenToUnreadCounts(setUnreadCounts);
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    let isCancelled = false;
    let unsubscribe: (() => void) | undefined;

    async function startCashoutListener() {
      try {
        const coadminUid = await getCurrentUserCoadminUid();

        if (isCancelled) {
          return;
        }

        unsubscribe = listenPendingCashoutsByCoadmin(
          coadminUid,
          (items) => {
            if (!isCancelled) {
              const visibleItems = items.filter(
                (item) => !suppressedCashoutIdsRef.current.has(item.id)
              );
              setPendingCashouts(visibleItems);
            }
          },
          (error) => {
            if (!isCancelled) {
              setMessage(error.message || 'Failed to listen for carer cashout requests.');
            }
          }
        );
      } catch (err: unknown) {
        if (!isCancelled) {
          setMessage(
            err instanceof Error
              ? err.message
              : 'Failed to start carer cashout listener.'
          );
        }
      }
    }

    void startCashoutListener();

    return () => {
      isCancelled = true;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    let isCancelled = false;
    let disposeListener: (() => void) | undefined;

    async function startPlayerCashoutTaskListener() {
      try {
        const coadminUid = await getCurrentUserCoadminUid();

        if (isCancelled) {
          return;
        }

        const lifecycle = listenCoadminCashoutTaskLifecycle(coadminUid, {
          onPendingChange: (tasks) => {
            if (!isCancelled) {
              setPendingCashoutTasks(tasks);
            }
          },
          onActiveChange: (tasks) => {
            if (!isCancelled) {
              setActiveCashoutTasks(tasks);
            }
          },
          onCompletedChange: (tasks) => {
            if (!isCancelled) {
              setCompletedCashoutTasks(tasks);
              console.info('[COADMIN_COMPLETED_TASKS] loaded', { count: tasks.length });
            }
          },
          onError: (error) => {
            if (!isCancelled) {
              setMessage(error.message || 'Failed to listen for player cashout tasks.');
            }
          },
        });
        disposeListener = lifecycle.dispose;
        refetchCashoutTasksRef.current = () => lifecycle.refetchNow();
      } catch (error: any) {
        if (!isCancelled) {
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
  }, []);

  useEffect(() => {
    let isCancelled = false;
    let unsubscribe: (() => void) | undefined;

    async function startTransferRequestListener() {
      // Pending cash-to-coin request approval flow is disabled for coadmin.
      return;
    }

    void startTransferRequestListener();

    return () => {
      isCancelled = true;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    if (pendingCashouts.length === 0) {
      return;
    }

    const playAudio = () => {
      const audio = new Audio('/notification.mp3');
      audio.volume = 0.9;
      audio.play().catch(() => {});
    };

    playAudio();
    const intervalId = window.setInterval(playAudio, 60000);

    return () => window.clearInterval(intervalId);
  }, [pendingCashouts.length]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setCountdownTick((tick) => tick + 1);
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    if (totalUnread > previousUnreadRef.current) {
      playNotificationSound();
    }

    previousUnreadRef.current = totalUnread;
  }, [totalUnread]);

  useEffect(() => {
    let isCancelled = false;
    let unsubscribe: (() => void) | undefined;

    async function startCarerEscalationListener() {
      try {
        const coadminUid = await getCurrentUserCoadminUid();

        if (isCancelled) {
          return;
        }

        unsubscribe = listenToCarerEscalationAlertsByCoadmin(
          coadminUid,
          (alerts) => {
            if (isCancelled) {
              return;
            }

            setRecentCarerEscalations(alerts);

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
          },
          (error) => {
            if (!isCancelled) {
              setMessage(error.message || 'Failed to listen for carer help alerts.');
            }
          }
        );
      } catch (err: unknown) {
        if (!isCancelled) {
          setMessage(
            err instanceof Error
              ? err.message
              : 'Failed to start carer help alert listener.'
          );
        }
      }
    }

    void startCarerEscalationListener();

    return () => {
      isCancelled = true;
      unsubscribe?.();
    };
  }, []);

  function playNotificationSound() {
    const audio = new Audio('/notification.mp3');
    audio.volume = 0.6;
    audio.play().catch(() => {});
  }

  async function getUsersForCurrentCoadmin<
    T extends { createdBy?: string | null; coadminUid?: string | null }
  >(loader: () => Promise<T[]>) {
    const coadminUid = await getCurrentUserCoadminUid();
    const list = await loader();

    return list.filter((user) => belongsToCoadmin(user, coadminUid));
  }

  async function loadDashboardBaseData(actorUid: string) {
    const inflight = coadminBaseLoadInflight.get(actorUid);
    if (inflight) {
      console.info('[COADMIN_BASE_LOAD]', {
        stage: 'start',
        coadminUid: actorUid,
        deduped: true,
      });
      await inflight;
      console.info('[COADMIN_BASE_LOAD]', {
        stage: 'done',
        coadminUid: actorUid,
        deduped: true,
      });
      return;
    }

    const startedAt = Date.now();
    console.info('[COADMIN_BASE_LOAD]', {
      stage: 'start',
      coadminUid: actorUid,
      deduped: false,
    });

    const promise = (async (): Promise<CoadminBaseLoadResult> => {
      setLoadingList(true);
      logCoadminActionAuth('load_dashboard_base');

      try {
        const coadminUid = await getCurrentUserCoadminUid();
        const [staffRaw, carersRaw, players, requests, gameLoginsRaw] = await Promise.all([
          getStaff(),
          getCarers(),
          getPlayersByCoadminSqlFirst(coadminUid),
          getMyPendingCarerCreationRequests(),
          getMyGameLogins(),
        ]);

        const staff = staffRaw.filter((user) => belongsToCoadmin(user, coadminUid));
        const carers = carersRaw.filter((user) => belongsToCoadmin(user, coadminUid));
        const gameLogins = sortByNewest(
          gameLoginsRaw.filter((game) => belongsToCoadmin(game, coadminUid))
        );

        setStaffList(staff);
        setCarerList(carers);
        setPlayerList(players);
        setPendingCarerRequests(requests);
        setGameLogins(gameLogins);
        void loadChatUsers(staff);

        return {
          staffCount: staff.length,
          carerCount: carers.length,
          playerCount: players.length,
          requestCount: requests.length,
          gameLoginCount: gameLogins.length,
          prefetchedStaff: staff,
        };
      } catch (err: unknown) {
        setMessage(err instanceof Error ? err.message : 'Failed to load dashboard data.');
        return {
          staffCount: 0,
          carerCount: 0,
          playerCount: 0,
          requestCount: 0,
          gameLoginCount: 0,
          prefetchedStaff: [],
        };
      } finally {
        setLoadingList(false);
      }
    })();

    coadminBaseLoadInflight.set(actorUid, promise);
    try {
      const result = await promise;
      console.info('[COADMIN_BASE_LOAD]', {
        stage: 'done',
        coadminUid: actorUid,
        deduped: false,
        staffCount: result.staffCount,
        carerCount: result.carerCount,
        playerCount: result.playerCount,
        requestCount: result.requestCount,
        gameLoginCount: result.gameLoginCount,
        durationMs: Date.now() - startedAt,
      });
    } finally {
      coadminBaseLoadInflight.delete(actorUid);
    }
  }

  async function loadStaffList() {
    setLoadingList(true);
    logCoadminActionAuth('load_staff');

    try {
      setStaffList(await getUsersForCurrentCoadmin(getStaff));
      void loadStaffWallets();
    } catch (err: any) {
      setMessage(err.message || 'Failed to load staff.');
    } finally {
      setLoadingList(false);
    }
  }

  async function loadStaffWallets() {
    setStaffWalletsLoading(true);
    try {
      const wallets = await listCoadminStaffWallets();
      const byUid = wallets.reduce<Record<string, CoadminStaffWalletRow>>((acc, wallet) => {
        acc[wallet.staffUid] = wallet;
        return acc;
      }, {});
      setStaffWalletsByUid(byUid);
    } catch (err: unknown) {
      setMessage(err instanceof Error ? err.message : 'Failed to load staff wallets.');
    } finally {
      setStaffWalletsLoading(false);
    }
  }

  async function loadCarerList() {
    setLoadingList(true);
    logCoadminActionAuth('load_carers');

    try {
      setCarerList(await getUsersForCurrentCoadmin(getCarers));
    } catch (err: any) {
      setMessage(err.message || 'Failed to load carers.');
    } finally {
      setLoadingList(false);
    }
  }

  async function loadScopedPlayerList() {
    const coadminUid = await getCurrentUserCoadminUid();
    return getPlayersByCoadminSqlFirst(coadminUid);
  }

  async function loadPlayerList() {
    setLoadingList(true);
    logCoadminActionAuth('load_players');

    try {
      setPlayerList(await loadScopedPlayerList());
    } catch (err: any) {
      setMessage(err.message || 'Failed to load players.');
    } finally {
      setLoadingList(false);
    }
  }

  async function loadGameLogins() {
    setLoadingList(true);

    try {
      const coadminUid = await getCurrentUserCoadminUid();
      const list = await getMyGameLogins();
      const relatedGames = list.filter((game) => belongsToCoadmin(game, coadminUid));
      setGameLogins(sortByNewest(relatedGames));
    } catch (err: any) {
      setMessage(err.message || 'Failed to load games.');
    } finally {
      setLoadingList(false);
    }
  }

  function mapReachOutContact(user: {
    id?: string;
    uid: string;
    username?: string;
    email?: string;
    role: string;
    status?: string;
    createdBy?: string | null;
    coadminUid?: string | null;
    createdAt?: unknown;
  }): AdminUser {
    return {
      id: String(user.id || user.uid || ''),
      uid: String(user.uid || ''),
      username: String(user.username || ''),
      email: String(user.email || ''),
      role: String(user.role || 'staff') as AdminUser['role'],
      status: (String(user.status || 'active') === 'disabled' ? 'disabled' : 'active') as
        | 'active'
        | 'disabled',
      createdBy: user.createdBy ?? null,
      coadminUid: user.coadminUid ?? null,
      createdAt: user.createdAt,
    } as AdminUser;
  }

  async function fetchReachOutUsersCache(role: 'staff' | 'admin', coadminUid: string) {
    const sqlMode = isClientSqlReadMode();
    const headers = await getSqlApiReadHeaders(false);
    const params = new URLSearchParams({
      role,
      includeDisabled: 'false',
    });
    if (role !== 'admin') {
      params.set('coadminUid', coadminUid);
    }
    const route = `/api/users/cache?${params.toString()}`;
    console.info('[COADMIN_REACH_OUT_CONTACTS_REQUEST]', {
      coadminUid,
      route,
      sqlMode,
      authSource: sqlMode ? 'app_session_sql' : 'firebase_token',
      rolesRequested: [role],
      statusFilter: 'active',
    });
    const response = await fetch(route, {
      method: 'GET',
      headers,
      cache: 'no-store',
    });
    const payload = (await response.json().catch(() => ({}))) as {
      users?: Array<Record<string, unknown>>;
      source?: string;
      error?: string;
    };
    if (!response.ok) {
      throw new Error(payload.error || `Failed to load ${role} contacts.`);
    }
    return {
      role,
      source: payload.source || 'unknown',
      users: payload.users || [],
    };
  }

  async function loadChatUsers(prefetchedStaff?: StaffUser[]) {
    try {
      const coadminUid = String(coadminActorUid || (await getCurrentUserCoadminUid()) || '').trim();
      const actorUid = resolveCoadminActorUid(coadminActorUid);
      if (!coadminUid) {
        setChatUsers([]);
        return;
      }

      if (isClientSqlReadMode()) {
        logClientFirestoreSkipped('load_chat_users_contacts', { route: '/coadmin', coadminUid });

        const [staffResult, adminResult] = await Promise.all([
          prefetchedStaff
            ? Promise.resolve({
                role: 'staff' as const,
                source: 'prefetched',
                users: prefetchedStaff as unknown as Array<Record<string, unknown>>,
              })
            : fetchReachOutUsersCache('staff', coadminUid),
          fetchReachOutUsersCache('admin', coadminUid),
        ]);

        let filteredOut = 0;
        const contacts: AdminUser[] = [];
        const seenUids = new Set<string>();

        const considerContact = (
          raw: Record<string, unknown>,
          sourceRole: string,
          online = false
        ) => {
          const uid = String(raw.uid || raw.id || '').trim();
          const role = String(raw.role || sourceRole || '').trim().toLowerCase();
          const status = String(raw.status || 'active').trim().toLowerCase();
          const userCoadminUid =
            String(raw.coadminUid || raw.coadmin_uid || '').trim() ||
            String(raw.createdBy || raw.created_by || '').trim();
          let included = Boolean(uid);
          let reason = 'included';

          if (!uid) {
            included = false;
            reason = 'missing_uid';
          } else if (uid === actorUid) {
            included = false;
            reason = 'self_excluded';
          } else if (seenUids.has(uid)) {
            included = false;
            reason = 'duplicate_uid';
          } else if (status === 'disabled') {
            included = false;
            reason = 'disabled';
          } else if (role === 'carer') {
            included = false;
            reason = 'carer_excluded';
          } else if (
            role !== 'admin' &&
            !belongsToCoadmin(
              {
                coadminUid: String(raw.coadminUid || raw.coadmin_uid || '').trim() || null,
                createdBy: String(raw.createdBy || raw.created_by || '').trim() || null,
              },
              coadminUid
            )
          ) {
            included = false;
            reason = 'outside_coadmin_scope';
          }

          console.info('[COADMIN_REACH_OUT_CONTACT_FILTER]', {
            uid: uid || null,
            role,
            coadminUid: userCoadminUid || null,
            status,
            online,
            included,
            reason,
          });

          if (!included) {
            filteredOut += 1;
            return;
          }

          seenUids.add(uid);
          contacts.push(mapReachOutContact({
            id: uid,
            uid,
            username: String(raw.username || ''),
            email: String(raw.email || ''),
            role,
            status,
            createdBy: String(raw.createdBy || raw.created_by || '').trim() || null,
            coadminUid: userCoadminUid || null,
            createdAt: raw.createdAt,
          }));
        };

        for (const raw of staffResult.users) {
          considerContact(raw, 'staff');
        }
        for (const raw of adminResult.users) {
          considerContact(raw, 'admin');
        }

        const adminCount = contacts.filter((user) => user.role === 'admin').length;
        const staffCount = contacts.filter((user) => user.role === 'staff').length;

        console.info('[COADMIN_REACH_OUT_CONTACTS_RESULT]', {
          coadminUid,
          source: 'postgres',
          adminCount,
          staffCount,
          totalCount: contacts.length,
          filteredOut,
          reason: contacts.length ? 'ok' : 'no_contacts_after_filter',
        });

        setChatUsers(sortByNewest(contacts));
        return;
      }

      const adminQuery = query(collection(db, 'users'), where('role', '==', 'admin'));
      const adminSnapshot = await clientGetDocs(adminQuery, {
        file: 'app/coadmin/page.tsx',
        hook: 'loadChatUsers',
        collection: 'users',
        where: { role: 'admin' },
      });
      const admins = adminSnapshot.docs.map((docSnap) =>
        mapReachOutContact({
          id: docSnap.id,
          uid: docSnap.id,
          ...(docSnap.data() as Omit<AdminUser, 'id' | 'uid'>),
          role: 'admin',
        })
      );

      const allStaff = prefetchedStaff ?? (await getStaff());
      const scopedStaff = allStaff.filter(
        (staff) => belongsToCoadmin(staff, coadminUid) && staff.uid !== actorUid
      );

      setChatUsers(
        sortByNewest([
          ...admins.filter((admin) => admin.uid !== actorUid),
          ...scopedStaff.map((user) => mapReachOutContact(user)),
        ])
      );
    } catch (err: any) {
      setMessage(err.message || 'Failed to load users.');
    }
  }

  async function loadStaffBehaviours(staffId?: string) {
    setBehavioursLoading(true);
    logCoadminActionAuth('load_behaviours');
    try {
      const queryString = staffId ? `?staffId=${encodeURIComponent(staffId)}` : '';
      const response = await fetch(`/api/coadmin/behaviours${queryString}`, {
        method: 'GET',
        headers: await getApiAuthHeaders(false, { action: 'read' }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || 'Failed to load behaviours.');
      }
      const rows = (data?.staffBehaviours || []) as StaffBehaviourRow[];
      setStaffBehaviours(rows);
      if (rows.length > 0 && !selectedBehaviourStaffId) {
        setSelectedBehaviourStaffId(rows[0].staff.staffId);
      }
      if (rows.length === 0) {
        setSelectedBehaviourStaffId(null);
      }
    } catch (error: any) {
      setMessage(error?.message || 'Failed to load behaviours.');
    } finally {
      setBehavioursLoading(false);
    }
  }

  async function handleToggleStaffRewardBlock(row: StaffBehaviourRow) {
    try {
      await getCoadminActorUid();
    } catch {
      setMessage('Not authenticated.');
      return;
    }
    setRewardBlockBusyStaffId(row.staff.staffId);
    setMessage('');
    try {
      const coadminUid = await getCurrentUserCoadminUid();
      const staffRef = doc(db, 'users', row.staff.staffId);
      const staffSnap = await getDoc(staffRef);
      if (!staffSnap.exists()) {
        throw new Error('Staff account not found.');
      }
      const staffData = staffSnap.data() as {
        role?: string;
        coadminUid?: string | null;
        createdBy?: string | null;
      };
      if (String(staffData.role || '').toLowerCase() !== 'staff') {
        throw new Error('Only staff reward can be blocked from this view.');
      }
      if (!belongsToCoadmin(staffData, coadminUid)) {
        throw new Error('Staff is outside your coadmin scope.');
      }
      const nextBlocked = !Boolean(row.staff.rewardBlocked);
      await updateDoc(staffRef, {
        rewardBlocked: nextBlocked,
        rewardBlockedAt: nextBlocked ? serverTimestamp() : null,
        rewardUnblockedAt: nextBlocked ? null : serverTimestamp(),
      });
      setStaffBehaviours((current) =>
        current.map((item) =>
          item.staff.staffId === row.staff.staffId
            ? { ...item, staff: { ...item.staff, rewardBlocked: nextBlocked } }
            : item
        )
      );
      setMessage(nextBlocked ? 'Staff reward blocked.' : 'Staff reward unblocked.');
    } catch (error: any) {
      setMessage(error?.message || 'Failed to update staff reward block.');
    } finally {
      setRewardBlockBusyStaffId(null);
    }
  }

  async function handleLoginAsStaffFromBehaviour(staffId: string) {
    await ensureAppSessionBootstrapped();
    if (!auth.currentUser && !getLocalAppSessionId()) {
      setMessage('Not authenticated.');
      return;
    }
    setWorkerCredentialsLoading(true);
    setMessage('');
    try {
      const impersonateHeaders = getLocalAppSessionId()
        ? {
            'Content-Type': 'application/json',
            ...getAppSessionRequestHeaders(),
          }
        : await getFirebaseApiHeaders();
      const response = await fetch('/api/coadmin/impersonate-staff', {
        method: 'POST',
        headers: impersonateHeaders,
        body: JSON.stringify({ staffUid: staffId }),
      });
      const data = (await response.json()) as {
        ok?: boolean;
        success?: boolean;
        mode?: 'sql_session' | 'firebase_custom_token';
        sessionId?: string;
        expiresAt?: string;
        customToken?: string;
        firebaseCustomToken?: string | null;
        redirectTo?: string;
        error?: string;
      };
      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to login as staff.');
      }
      if (data.mode === 'sql_session' && data.sessionId) {
        startImpersonationSession(data.sessionId, String(data.expiresAt || ''));
        window.location.href = data.redirectTo || '/staff';
        return;
      }
      const customToken = data.customToken || data.firebaseCustomToken;
      if (!customToken) {
        throw new Error(data.error || 'Failed to login as staff.');
      }
      await signInWithCustomToken(auth, customToken);
      window.location.href = data.redirectTo || '/staff';
    } catch (error: any) {
      setMessage(error?.message || 'Failed to login as staff.');
    } finally {
      setWorkerCredentialsLoading(false);
    }
  }

  async function handleCreateStaff(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setMessage('');

    try {
      await createStaff(staffUsername, staffPassword);
      setStaffUsername('');
      setStaffPassword('');
      setMessage('Staff created successfully.');
      await loadStaffList();
    } catch (err: any) {
      setMessage(err.message || 'Failed to create staff.');
    } finally {
      setLoading(false);
    }
  }

  function buildStaffWalletIdempotencyKey(staffUid: string, amount: number) {
    const cryptoApi = typeof window !== 'undefined' ? window.crypto : undefined;
    const randomId =
      cryptoApi && typeof cryptoApi.randomUUID === 'function'
        ? cryptoApi.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return `coadmin-staff-wallet:${staffUid}:${amount}:${randomId}`;
  }

  async function handleAllocateStaffWallet(staffMember: StaffUser) {
    const raw = String(staffWalletAmountByUid[staffMember.uid] || '').trim();
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
      setMessage('Enter a positive whole-number Staff Wallet amount.');
      return;
    }

    const amount = parsed;
    setStaffWalletAllocatingUid(staffMember.uid);
    setMessage('');

    try {
      const result = await allocateStaffWalletCoins({
        staffUid: staffMember.uid,
        amount,
        idempotencyKey: buildStaffWalletIdempotencyKey(staffMember.uid, amount),
      });
      setStaffWalletAmountByUid((current) => ({
        ...current,
        [staffMember.uid]: '',
      }));
      setStaffWalletsByUid((current) => ({
        ...current,
        [staffMember.uid]: {
          staffUid: staffMember.uid,
          username: staffMember.username || null,
          status: staffMember.status || null,
          coadminUid: staffMember.coadminUid || staffMember.createdBy || '',
          balanceCoin: result.balanceCoin,
          totalAllocatedCoin: result.totalAllocatedCoin,
          totalLoadedCoin: current[staffMember.uid]?.totalLoadedCoin || 0,
          walletUpdatedAt: new Date().toISOString(),
        },
      }));
      void loadStaffWallets();
      setMessage(
        result.duplicate
          ? 'Staff Wallet allocation already processed.'
          : `Allocated ${amount.toLocaleString()} coins to ${staffMember.username || 'staff'}.`
      );
    } catch (err: unknown) {
      setMessage(err instanceof Error ? err.message : 'Failed to allocate Staff Wallet coins.');
    } finally {
      setStaffWalletAllocatingUid(null);
    }
  }

  async function handleCreateCarer(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setMessage('');

    try {
      await requestCarerCreation(carerUsername);
      setCarerUsername('');
      setCarerPassword('');
      setMessage('Carer request sent to admin for approval.');
      await loadPendingCarerRequestsForCoadmin();
      await loadCarerList();
    } catch (err: any) {
      setMessage(err.message || 'Failed to request carer creation.');
    } finally {
      setLoading(false);
    }
  }

  async function loadPendingCarerRequestsForCoadmin() {
    logCoadminActionAuth('load_carer_requests');
    try {
      setPendingCarerRequests(await getMyPendingCarerCreationRequests());
    } catch {
      setPendingCarerRequests([]);
    }
  }

  async function handleCreatePlayer(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setMessage('');

    try {
      const result = await createPlayer(playerUsername, playerPassword, playerReferralCodeInput);
      setPlayerUsername('');
      setPlayerPassword('');
      setPlayerReferralCodeInput('');
      setMessage(
        result?.referralApplied
          ? 'Referral was successful. Referral bonus has been added.'
          : 'Player created successfully.'
      );
      await loadPlayerList();
    } catch (err: any) {
      setMessage(err.message || 'Failed to create player.');
    } finally {
      setLoading(false);
    }
  }

  async function handleCreateGame(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setMessage('');

    try {
      await createGameLogin(
        gameName,
        gameUsername,
        gamePassword,
        gameBackendUrl,
        gameFrontendUrl
      );
      setGameName('');
      setGameUsername('');
      setGamePassword('');
      setGameBackendUrl('');
      setGameFrontendUrl('');
      setMessage('Game login added successfully.');
      await loadGameLogins();
    } catch (err: any) {
      setMessage(err.message || 'Failed to add game.');
    } finally {
      setLoading(false);
    }
  }

  async function handleUpdateGame(e: React.FormEvent) {
    e.preventDefault();

    if (!editingGame) return;

    setLoading(true);
    setMessage('');

    try {
      await updateGameLogin(editingGame.id, {
        gameName: editingGame.gameName,
        username: editingGame.username,
        password: editingGame.password,
        backendUrl: editingGame.backendUrl || editingGame.siteUrl || '',
        frontendUrl: editingGame.frontendUrl || '',
      });

      setEditingGame(null);
      setMessage('Game login updated.');
      await loadGameLogins();
    } catch (err: any) {
      setMessage(err.message || 'Failed to update game.');
    } finally {
      setLoading(false);
    }
  }

  async function handleDeleteGame(game: GameLogin) {
    const lines = [
      `Permanently delete "${game.gameName}" and everything tied to it under your coadmin?`,
      '',
      'This will remove:',
      '• The game from your list',
      '• All player game accounts for this game',
      '• Recharge and redeem requests for this game',
      '• Carer tasks for this game',
      '• Bonus events for this game',
      '',
      'This cannot be undone.',
    ];
    if (!window.confirm(lines.join('\n'))) {
      return;
    }

    setGameListDeletingId(game.id);
    setMessage('');

    try {
      const result = await deleteGameLoginAndRelatedData(game.id);
      if (editingGame?.id === game.id) {
        setEditingGame(null);
      }
      const d = result.deleted;
      setMessage(
        `Deleted "${game.gameName}". Removed ${d.playerGameLogins} player game login(s), ` +
          `${d.playerGameRequests} request(s), ${d.carerTasks} carer task(s), ${d.bonusEvents} bonus event(s).`
      );
      await loadGameLogins();
    } catch (err: unknown) {
      setMessage(err instanceof Error ? err.message : 'Failed to delete game.');
    } finally {
      setGameListDeletingId(null);
    }
  }

  async function handleDeleteStaff() {
    if (!deleteStaffTarget) return;
    setLoading(true);

    try {
      await deleteStaff(deleteStaffTarget);
      await loadStaffList();

      if (staffChatUser?.uid === deleteStaffTarget.uid) {
        setStaffChatUser(null);
      }

      setSelectedStaff(null);
      setDeleteStaffTarget(null);
      setMessage('Staff deleted.');
    } catch (err: any) {
      setMessage(err.message || 'Delete failed.');
    } finally {
      setLoading(false);
    }
  }

  async function handleDeleteCarer() {
    if (!deleteCarerTarget) return;
    setLoading(true);

    try {
      await deleteCarer(deleteCarerTarget);
      await loadCarerList();
      setSelectedCarer(null);
      setDeleteCarerTarget(null);
      setMessage('Carer deleted.');
    } catch (err: any) {
      setMessage(err.message || 'Delete failed.');
    } finally {
      setLoading(false);
    }
  }

  async function handleCoadminSetStaffPassword(user: StaffUser) {
    const pw1 = window.prompt('New password (at least 6 characters):', '');
    if (pw1 === null) {
      return;
    }
    if (pw1.length < 6) {
      setMessage('Password must be at least 6 characters.');
      return;
    }
    const pw2 = window.prompt('Confirm new password:', '');
    if (pw2 === null) {
      return;
    }
    if (pw1 !== pw2) {
      setMessage('Passwords do not match.');
      return;
    }
    setWorkerCredentialsLoading(true);
    setMessage('');
    try {
      await resetCoadminWorkerCredentials(user, { newPassword: pw1 });
      await loadStaffList();
      const fresh =
        (await getUsersForCurrentCoadmin(getStaff)).find((s) => s.uid === user.uid) ?? null;
      setSelectedStaff(fresh);
      setMessage('Password updated. Send it to this person through a private channel only.');
    } catch (err: any) {
      setMessage(err?.message || 'Failed to set password.');
    } finally {
      setWorkerCredentialsLoading(false);
    }
  }

  async function handleCoadminSetStaffUsername(user: StaffUser) {
    const next = window.prompt(
      `New login username (lowercase, no spaces; current: ${user.username}):`,
      user.username
    );
    if (next === null) {
      return;
    }
    const clean = next.trim().toLowerCase();
    if (!clean) {
      setMessage('Username is required.');
      return;
    }
    if (clean === user.username) {
      setMessage('That is already the login username.');
      return;
    }
    setWorkerCredentialsLoading(true);
    setMessage('');
    try {
      await resetCoadminWorkerCredentials(user, { newUsername: clean });
      await loadStaffList();
      const fresh =
        (await getUsersForCurrentCoadmin(getStaff)).find((s) => s.uid === user.uid) ?? null;
      setSelectedStaff(fresh);
      setMessage('Login username updated. It must be unique across the app.');
    } catch (err: any) {
      setMessage(err?.message || 'Failed to change username.');
    } finally {
      setWorkerCredentialsLoading(false);
    }
  }

  async function handleCoadminSetCarerPassword(user: CarerUser) {
    const pw1 = window.prompt('New password (at least 6 characters):', '');
    if (pw1 === null) {
      return;
    }
    if (pw1.length < 6) {
      setMessage('Password must be at least 6 characters.');
      return;
    }
    const pw2 = window.prompt('Confirm new password:', '');
    if (pw2 === null) {
      return;
    }
    if (pw1 !== pw2) {
      setMessage('Passwords do not match.');
      return;
    }
    setWorkerCredentialsLoading(true);
    setMessage('');
    try {
      await resetCoadminWorkerCredentials(user, { newPassword: pw1 });
      await loadCarerList();
      const fresh =
        (await getUsersForCurrentCoadmin(getCarers)).find((c) => c.uid === user.uid) ?? null;
      setSelectedCarer(fresh);
      setMessage('Password updated. Send it to this person through a private channel only.');
    } catch (err: any) {
      setMessage(err?.message || 'Failed to set password.');
    } finally {
      setWorkerCredentialsLoading(false);
    }
  }

  async function handleCoadminSetCarerUsername(user: CarerUser) {
    const next = window.prompt(
      `New login username (lowercase, no spaces; current: ${user.username}):`,
      user.username
    );
    if (next === null) {
      return;
    }
    const clean = next.trim().toLowerCase();
    if (!clean) {
      setMessage('Username is required.');
      return;
    }
    if (clean === user.username) {
      setMessage('That is already the login username.');
      return;
    }
    setWorkerCredentialsLoading(true);
    setMessage('');
    try {
      await resetCoadminWorkerCredentials(user, { newUsername: clean });
      await loadCarerList();
      const fresh =
        (await getUsersForCurrentCoadmin(getCarers)).find((c) => c.uid === user.uid) ?? null;
      setSelectedCarer(fresh);
      setMessage('Login username updated. It must be unique across the app.');
    } catch (err: any) {
      setMessage(err?.message || 'Failed to change username.');
    } finally {
      setWorkerCredentialsLoading(false);
    }
  }

  async function handleCoadminSetPlayerPassword(user: PlayerUser) {
    const pw1 = window.prompt(
      `Set new password for player "${user.username}" (min 6 chars):`,
      ''
    );
    if (pw1 == null) return;
    if (pw1.length < 6) {
      setMessage('Password must be at least 6 characters.');
      return;
    }
    const pw2 = window.prompt('Confirm new password:', '');
    if (pw2 == null) return;
    if (pw1 !== pw2) {
      setMessage('Passwords do not match.');
      return;
    }
    setWorkerCredentialsLoading(true);
    setMessage('');
    try {
      await resetCoadminWorkerCredentials(user, { newPassword: pw1 });
      setMessage('Player password updated. Share it securely.');
    } catch (err: any) {
      setMessage(err?.message || 'Failed to set player password.');
    } finally {
      setWorkerCredentialsLoading(false);
    }
  }

  async function handleDeletePlayer() {
    if (!deletePlayerTarget) return;
    setLoading(true);

    try {
      await deletePlayer(deletePlayerTarget);
      await loadPlayerList();
      setSelectedPlayer(null);
      setDeletePlayerTarget(null);
      setMessage('Player deleted.');
    } catch (err: any) {
      setMessage(err.message || 'Delete failed.');
    } finally {
      setLoading(false);
    }
  }

  async function handleTogglePlayerStatus(user: PlayerUser) {
    const wasDisabled = user.status === 'disabled';

    if (!wasDisabled) {
      const ok = window.confirm(
        'Block this player? They can still sign in to message your team; play and wallet actions stay restricted until unblocked.'
      );
      if (!ok) {
        return;
      }
    }

    setBlocking(true);
    setMessage('');

    try {
      if (wasDisabled) {
        await unblockPlayer(user);
        setMessage('Player unblocked.');
      } else {
        await blockPlayer(user);
        setMessage('Player blocked.');
      }
      await loadPlayerList();
    } catch (err: any) {
      setMessage(err.message || 'Failed to update player status.');
    } finally {
      setBlocking(false);
    }
  }

  async function handleAdjustPlayerCash(player: PlayerUser, mode: 'add' | 'deduct') {
    const raw = playerCashAmountInput.trim();
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setMessage('Enter a positive amount.');
      return;
    }

    const amount = Math.floor(parsed);
    if (amount <= 0) {
      setMessage('Enter a positive amount.');
      return;
    }

    const delta = mode === 'add' ? amount : -amount;

    setPlayerCashAdjustBusy(true);
    setMessage('');

    try {
      await adjustPlayerCash({ playerUid: player.uid, delta });
      setMessage(
        mode === 'add'
          ? `Added ${amount} cash for ${player.username || 'player'}.`
          : `Deducted ${amount} cash from ${player.username || 'player'}.`
      );
      setPlayerCashAmountInput('');

      const list = await loadScopedPlayerList();
      setPlayerList(list);
      setSelectedPlayer(list.find((p) => p.uid === player.uid) ?? null);
    } catch (err: any) {
      setMessage(err?.message || 'Could not update cash balance.');
    } finally {
      setPlayerCashAdjustBusy(false);
    }
  }

  async function handleAdjustPlayerCoin(player: PlayerUser, mode: 'add' | 'deduct') {
    const raw = playerCoinAmountInput.trim();
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setMessage('Enter a positive amount.');
      return;
    }

    const amount = Math.floor(parsed);
    if (amount <= 0) {
      setMessage('Enter a positive amount.');
      return;
    }

    const delta = mode === 'add' ? amount : -amount;

    setPlayerCoinAdjustBusy(true);
    setMessage('');

    try {
      await adjustPlayerCoin({ playerUid: player.uid, delta });
      setMessage(
        mode === 'add'
          ? `Added ${amount} coin for ${player.username || 'player'}.`
          : `Deducted ${amount} coin from ${player.username || 'player'}.`
      );
      setPlayerCoinAmountInput('');

      const list = await loadScopedPlayerList();
      setPlayerList(list);
      setSelectedPlayer(list.find((p) => p.uid === player.uid) ?? null);
    } catch (err: any) {
      setMessage(err?.message || 'Could not update coin balance.');
    } finally {
      setPlayerCoinAdjustBusy(false);
    }
  }

  async function handleResetPlayerRedeemLimit(player: PlayerUser, gameName: string) {
    const cleanGameName = String(gameName || '').trim();
    if (!player?.uid || !cleanGameName) {
      setMessage('Player and game are required.');
      return;
    }

    setRedeemLimitResetBusyGameName(cleanGameName);
    setMessage('');

    try {
      await resetPlayerGameRedeemLimitForCoadmin(player.uid, cleanGameName);
      await loadSelectedPlayerRedeemLimitSummaries(player.uid);
      setMessage(`Redeem limit reset for ${player.username} on ${cleanGameName}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to reset redeem limit.');
    } finally {
      setRedeemLimitResetBusyGameName(null);
    }
  }

  async function handleCompleteCashout(request: CarerCashoutRequest) {
    setLoading(true);
    setMessage('');
    const requestedAmount = Math.max(0, Math.round(Number(request.amountNpr || 0)));
    const doneAmountRaw = String(cashoutDoneAmountById[request.id] || '').trim();
    const doneAmount = doneAmountRaw === '' ? requestedAmount : Math.round(Number(doneAmountRaw));
    if (!Number.isFinite(doneAmount) || doneAmount < 0) {
      setMessage('Enter a valid done amount.');
      setLoading(false);
      return;
    }
    if (doneAmount > requestedAmount) {
      setMessage('Done amount cannot be greater than claim amount.');
      setLoading(false);
      return;
    }
    const remainingAmount = Math.max(0, requestedAmount - doneAmount);
    const previousPendingCashouts = pendingCashouts;
    const settledIdsForCarer = pendingCashouts
      .filter((item) => item.carerUid === request.carerUid)
      .map((item) => item.id);

    settledIdsForCarer.forEach((id) => suppressedCashoutIdsRef.current.add(id));

    // Remove this carer's request box immediately from UI on Done.
    setPendingCashouts((current) =>
      current.filter((item) => item.carerUid !== request.carerUid)
    );

    try {
      await completeCarerCashoutRequest(request.id, doneAmount);
      setCashoutDoneAmountById((current) => {
        const next = { ...current };
        delete next[request.id];
        return next;
      });
      setMessage(
        `Cashout settled for ${request.carerUsername}. Done: ${formatUsdFromNprDisplay(
          doneAmount
        )} | Remaining cash box: ${formatUsdFromNprDisplay(remainingAmount)}.`
      );
    } catch (err: any) {
      settledIdsForCarer.forEach((id) => suppressedCashoutIdsRef.current.delete(id));
      // Restore UI list if request failed.
      setPendingCashouts(previousPendingCashouts);
      setMessage(err.message || 'Failed to settle cashout request.');
    } finally {
      setLoading(false);
    }
  }

  async function handleDeclineCashout(request: CarerCashoutRequest) {
    setLoading(true);
    setMessage('');
    try {
      await declineCarerCashoutRequest(request.id);
      setCashoutDoneAmountById((current) => {
        const next = { ...current };
        delete next[request.id];
        return next;
      });
      setMessage(
        `Claim Pay declined for ${request.carerUsername}. ${formatUsdFromNprDisplay(
          request.amountNpr || 0
        )} added back to staff cash box.`
      );
    } catch (err: any) {
      setMessage(err.message || 'Failed to decline cashout request.');
    } finally {
      setLoading(false);
    }
  }

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
    } catch (error: any) {
      setMessage(error.message || 'Failed to start player cashout task.');
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

  async function handleDeclinePlayerCashoutTask(taskId: string) {
    setPlayerCashoutTaskLoadingId(taskId);
    setMessage('');
    try {
      await declinePlayerCashoutTaskByCoadmin(taskId);
      setPendingCashoutTasks((prev) => prev.filter((task) => task.id !== taskId));
      refetchCashoutTasksRef.current?.();
      setMessage('Player cashout task declined.');
    } catch (error: any) {
      setMessage(error.message || 'Failed to decline player cashout task.');
    } finally {
      setPlayerCashoutTaskLoadingId(null);
    }
  }

  async function handleCreateBonusEvent(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setMessage('');

    try {
      const resolvedAmount = bonusAmount.trim() ? Number(bonusAmount) : randomInt(10, 50);
      const resolvedPercentage = bonusPercentage.trim()
        ? Number(bonusPercentage)
        : randomInt(5, 10);
      if (!bonusAmount.trim()) {
        setBonusAmount(String(resolvedAmount));
      }
      if (!bonusPercentage.trim()) {
        setBonusPercentage(String(resolvedPercentage));
      }

      const result = await createBonusEvent({
        bonusName,
        gameName: bonusGameName,
        amountNpr: resolvedAmount,
        description: bonusDescription,
        bonusPercentage: resolvedPercentage,
      });
      setBonusName('');
      setBonusGameName('');
      setBonusAmount('');
      setBonusDescription('');
      setBonusPercentage('');
      setMessage('Bonus event created successfully.');
    } catch (error: any) {
      setMessage(error.message || 'Failed to create bonus event.');
    } finally {
      setLoading(false);
    }
  }

  async function ensureCoadminBonusCapacity(
    activeCountHint?: number,
    options?: { ignoreCooldown?: boolean }
  ) {
    const desiredCapacity = MAX_ACTIVE_BONUS_EVENTS;
    console.info('[BONUS_ENSURE_ENTRY]', {
      source: 'ensureCoadminBonusCapacity',
      activeCountHint: activeCountHint ?? null,
      ignoreCooldown: Boolean(options?.ignoreCooldown),
      coadminUid: coadminActorUid || null,
      desiredCapacity,
    });
    if (bonusAutoFillBusyRef.current) {
      console.info('[coadmin] bonus-events:ensure-skip', {
        reason: 'busy',
      });
      return;
    }
    const resolvedActiveCount =
      typeof activeCountHint === 'number'
        ? activeCountHint
        : bonusEventsLatestActiveCountRef.current;
    const missingCapacity = Math.max(0, desiredCapacity - resolvedActiveCount);
    console.info('[BONUS_ENSURE_ACTIVE_COUNT]', {
      source: 'ensureCoadminBonusCapacity',
      resolvedActiveCount,
      stateActiveCount: bonusEvents.length,
      desiredCapacity,
    });
    console.info('[BONUS_ENSURE_MISSING]', {
      source: 'ensureCoadminBonusCapacity',
      missingCapacity,
      desiredCapacity,
      resolvedActiveCount,
    });
    // Strict full-capacity guard: never call ensure API when active is full.
    if (resolvedActiveCount >= MAX_ACTIVE_BONUS_EVENTS) {
      bonusEventsEnsureCooldownUntilMsRef.current = Date.now() + 60_000;
      bonusEventsLastMissingCountRef.current = null;
      console.info('[bonusEvents] skipped-client-full', {
        activeCount: resolvedActiveCount,
        cap: MAX_ACTIVE_BONUS_EVENTS,
      });
      return;
    }
    const stateActiveCount = bonusEvents.length;
    if (stateActiveCount >= MAX_ACTIVE_BONUS_EVENTS) {
      bonusEventsEnsureCooldownUntilMsRef.current = Date.now() + 60_000;
      bonusEventsLastMissingCountRef.current = null;
      console.info('[bonusEvents] skipped-client-full', {
        activeCount: stateActiveCount,
        cap: MAX_ACTIVE_BONUS_EVENTS,
      });
      return;
    }
    const nowMs = Date.now();
    const retryAfterByAttempt = bonusEventsLastEnsureAttemptAtMsRef.current
      ? BONUS_ENSURE_CLIENT_COOLDOWN_MS - (nowMs - bonusEventsLastEnsureAttemptAtMsRef.current)
      : 0;
    if (!options?.ignoreCooldown && retryAfterByAttempt > 0) {
      console.info('[BONUS_ENSURE_COOLDOWN_BLOCK]', {
        source: 'ensureCoadminBonusCapacity',
        reason: 'retry_after_by_attempt',
        retryAfterMs: retryAfterByAttempt,
      });
      console.info('[bonusEvents] skipped-client-cooldown', {
        retryAfterMs: retryAfterByAttempt,
      });
      return;
    }
    if (!options?.ignoreCooldown && bonusEventsEnsureCooldownUntilMsRef.current > nowMs) {
      console.info('[BONUS_ENSURE_COOLDOWN_BLOCK]', {
        source: 'ensureCoadminBonusCapacity',
        reason: 'cooldown_until',
        retryAfterMs: bonusEventsEnsureCooldownUntilMsRef.current - nowMs,
      });
      console.info('[bonusEvents] skipped-client-cooldown', {
        retryAfterMs: bonusEventsEnsureCooldownUntilMsRef.current - nowMs,
      });
      return;
    }
    const missingCount = Math.max(0, MAX_ACTIVE_BONUS_EVENTS - stateActiveCount);
    if (!options?.ignoreCooldown && bonusEventsLastMissingCountRef.current === missingCount) {
      bonusEventsEnsureCooldownUntilMsRef.current = nowMs + BONUS_ENSURE_CLIENT_COOLDOWN_MS;
      console.info('[BONUS_ENSURE_COOLDOWN_BLOCK]', {
        source: 'ensureCoadminBonusCapacity',
        reason: 'missing_count_unchanged',
        missingCount,
        retryAfterMs: BONUS_ENSURE_CLIENT_COOLDOWN_MS,
      });
      console.info('[bonusEvents] skipped-client-cooldown', {
        missingCount,
        retryAfterMs: BONUS_ENSURE_CLIENT_COOLDOWN_MS,
      });
      return;
    }
    bonusAutoFillBusyRef.current = true;
    bonusEventsLastEnsureAttemptAtMsRef.current = nowMs;
    bonusEventsLastMissingCountRef.current = missingCount;
    try {
      const url = '/api/coadmin/bonus-events/ensure-capacity';
      const headers = await getCoadminBonusApiHeaders();
      logBonusEventsUiRequest({
        action: 'ensure_bonus_capacity',
        page: 'coadmin_bonus_events',
        coadminUid: coadminActorUid || null,
        url,
        headers,
      });
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ activeCountHint: resolvedActiveCount }),
      });
      const data = (await response.json()) as {
        autoCreatedCount?: number;
        totalActive?: number | null;
        skipped?: string;
        retryAfterMs?: number;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(data.error || 'Failed to auto-create bonus events.');
      }
      if (
        data.skipped === 'cooldown' ||
        data.skipped === 'locked' ||
        data.skipped === 'server-cooldown'
      ) {
        bonusEventsEnsureCooldownUntilMsRef.current = Date.now() + Math.max(5_000, Number(data.retryAfterMs || 10_000));
      }
      if (typeof data.totalActive === 'number' && data.totalActive >= MAX_ACTIVE_BONUS_EVENTS) {
        bonusEventsEnsureCooldownUntilMsRef.current = Date.now() + 60_000;
      }
      if (data.skipped === 'server-cooldown') {
        console.info('[coadmin] bonus-events:skipped-server-cooldown', {
          retryAfterMs: Number(data.retryAfterMs || 0),
        });
      }
      const result = {
        autoCreatedCount: Number(data.autoCreatedCount || 0),
      };
      if (data.skipped === 'unchanged-active-state' && resolvedActiveCount === 0) {
        resetBonusEventsEnsureGuard('unchanged_active_state_while_empty');
        console.info('[BONUS_EVENTS_ENSURE_RETRY_ALLOWED]', {
          reason: 'unchanged_active_state_while_empty',
          activeCount: resolvedActiveCount,
        });
      }
      if (
        result.autoCreatedCount === 0 &&
        (typeof data.totalActive === 'number' ? data.totalActive : resolvedActiveCount) === 0
      ) {
        resetBonusEventsEnsureGuard('ensure_returned_zero_created_while_empty');
      } else if (result.autoCreatedCount > 0 && typeof data.totalActive === 'number') {
        bonusEventsLastEnsureAttemptedCountRef.current = data.totalActive;
      }
      console.info('[BONUS_ENSURE_CREATED]', {
        source: 'ensureCoadminBonusCapacity',
        autoCreatedCount: result.autoCreatedCount,
        totalActive: data.totalActive ?? null,
        skipped: data.skipped || null,
        coadminUid: coadminActorUid || null,
      });
      console.info('[bonusEvents] ensure-created', {
        activeCount: stateActiveCount,
        missingCount,
        createdCount: result.autoCreatedCount,
        totalActive: data.totalActive ?? null,
        skipped: data.skipped || null,
      });
      clearBonusEventsMessage();
      if (result.autoCreatedCount > 0) {
        setMessage('Bonus events auto-created successfully.');
      }
    } catch (error: unknown) {
      const msg =
        error instanceof Error ? error.message : 'Failed to auto-create bonus events.';
      console.info('[bonusEvents] ensure-error', { message: msg });
      logBonusEventsUiGuard({
        page: 'coadmin_page_bonus_events_ensure',
        reason: msg,
        message: msg,
        blocked: true,
        coadminUid: coadminActorUid || null,
        isCoadminView: true,
        isPlayerView: false,
      });
      setMessage(msg);
    } finally {
      bonusAutoFillBusyRef.current = false;
      console.info('[BONUS_ENSURE_EXIT]', {
        source: 'ensureCoadminBonusCapacity',
        coadminUid: coadminActorUid || null,
        resolvedActiveCount,
        stateActiveCount: bonusEvents.length,
        desiredCapacity,
      });
    }
  }

  async function handleSaveAutoBonusPercentRange() {
    setAutoBonusRangeBusy(true);
    setMessage('');

    try {
      const minPercent = Number(autoBonusMinPercentInput);
      const maxPercent = Number(autoBonusMaxPercentInput);

      if (!Number.isFinite(minPercent) || !Number.isFinite(maxPercent)) {
        throw new Error('Auto-created bonus range must use numbers only.');
      }

      const savedRange = await setCoadminAutoBonusPercentRange({
        minPercent,
        maxPercent,
      });
      setAutoBonusMinPercentInput(String(savedRange.minPercent));
      setAutoBonusMaxPercentInput(String(savedRange.maxPercent));
      setMessage(
        savedRange.adjustedEventCount > 0
          ? `Auto-created bonus event range saved: ${savedRange.minPercent}% to ${savedRange.maxPercent}%. Adjusted ${savedRange.adjustedEventCount} existing auto-created bonus events into range.`
          : `Auto-created bonus event range saved: ${savedRange.minPercent}% to ${savedRange.maxPercent}%. New auto-created events will use this range.`
      );
    } catch (error: unknown) {
      setMessage(
        error instanceof Error
          ? error.message
          : 'Failed to save auto-created bonus range.'
      );
    } finally {
      setAutoBonusRangeBusy(false);
    }
  }

  async function handleToggleStaffStatus(user: StaffUser) {
    setBlocking(true);
    setMessage('');

    try {
      if (user.status === 'disabled') {
        await unblockStaff(user);
      } else {
        await blockStaff(user);
      }

      await loadStaffList();
      setMessage(`Staff ${user.status === 'disabled' ? 'unblocked' : 'blocked'} successfully.`);
    } catch (err: any) {
      setMessage(err.message || 'Failed to update staff status.');
    } finally {
      setBlocking(false);
    }
  }

  async function handleToggleCarerStatus(user: CarerUser) {
    setBlocking(true);
    setMessage('');

    try {
      if (user.status === 'disabled') {
        await unblockCarer(user);
      } else {
        await blockCarer(user);
      }

      await loadCarerList();
      setMessage(`Carer ${user.status === 'disabled' ? 'unblocked' : 'blocked'} successfully.`);
    } catch (err: any) {
      setMessage(err.message || 'Failed to update carer status.');
    } finally {
      setBlocking(false);
    }
  }

  async function handleCutRewardForWorker(values: {
    uid: string;
    username: string;
    role: 'staff' | 'carer';
  }) {
    const amountText = rewardCutAmountByUid[values.uid] || '';
    const reasonText = rewardCutReasonByUid[values.uid] || '';
    const amountNpr = Math.round(Number(amountText || 0));
    if (amountNpr <= 0) {
      setMessage('Enter a valid reward cut amount.');
      return;
    }

    setRewardCutBusyUid(values.uid);
    setMessage('');
    try {
      const result = await cutWorkerReward({
        workerUid: values.uid,
        workerRole: values.role,
        workerUsername: values.username,
        amountNpr,
        reason: reasonText,
      });
      if (values.role === 'staff') {
        setStaffList((prev) =>
          prev.map((item) =>
            item.uid === values.uid ? { ...item, cashBoxNpr: result.updatedCashBox } : item
          )
        );
      } else {
        setCarerList((prev) =>
          prev.map((item) =>
            item.uid === values.uid ? { ...item, cashBoxNpr: result.updatedCashBox } : item
          )
        );
      }
      setRewardCutAmountByUid((prev) => ({ ...prev, [values.uid]: '' }));
      setMessage(`Reward cut applied for ${values.username || values.role}.`);
    } catch (error: any) {
      setMessage(error?.message || 'Failed to cut reward.');
    } finally {
      setRewardCutBusyUid(null);
    }
  }

  async function handleImageSelect(file: File) {
    try {
      const { default: imageCompression } = await import('browser-image-compression');
      const compressed = await imageCompression(file, {
        maxSizeMB: 0.7,
        maxWidthOrHeight: 1000,
        useWebWorker: true,
      });

      setSelectedImage(compressed);
      setImagePreview(URL.createObjectURL(compressed));
    } catch (err) {
      console.error(err);
      setMessage('Failed to process image.');
    }
  }

  function handleClearImage() {
    setSelectedImage(null);

    if (imagePreview) {
      URL.revokeObjectURL(imagePreview);
    }

    setImagePreview(null);
  }

  async function handleSendMessage(e: React.FormEvent) {
    e.preventDefault();

    if (!activeChatUser) return;

    try {
      if (selectedImage) {
        setSendingImage(true);
        await sendImageMessage(activeChatUser.uid, selectedImage);
        handleClearImage();
      }

      if (newMessage.trim()) {
        await sendChatMessage(activeChatUser.uid, newMessage);
        setNewMessage('');
      }
      window.requestAnimationFrame(() => {
        const el = coadminChatScrollRef.current;
        if (el) {
          el.scrollTop = el.scrollHeight;
        }
      });
    } catch (err: any) {
      setMessage(err.message || 'Failed to send message.');
    } finally {
      setSendingImage(false);
    }
  }

  function handleStaffStartChat(user: StaffUser) {
    if (staffChatUser?.uid === user.uid) {
      setStaffChatUser(null);
      setNewMessage('');
      handleClearImage();
      return;
    }

    setStaffChatUser(user);
    setReachOutChatUser(null);
    setNewMessage('');
    handleClearImage();
    lastRenderedCoadminChatReadRef.current = '';
  }

  function handleReachOutUserSelect(user: AdminUser) {
    setReachOutChatUser(user);
    setStaffChatUser(null);
    setNewMessage('');
    handleClearImage();
    lastRenderedCoadminChatReadRef.current = '';
  }

  async function handleOpenFirstUnreadStaffChat() {
    let staffUsers = staffList;

    if (staffUsers.length === 0) {
      staffUsers = await getUsersForCurrentCoadmin(getStaff);
      setStaffList(staffUsers);
    }

    const unreadStaff =
      staffUsers.find((staff) => (unreadCounts[staff.uid] || 0) > 0) || null;

    setActiveView('view-staff');

    if (unreadStaff) {
      setSelectedStaff(unreadStaff);
      setStaffChatUser(unreadStaff);
      setReachOutChatUser(null);
      setNewMessage('');
      handleClearImage();
      lastRenderedCoadminChatReadRef.current = '';
    }
  }

  async function handleOpenFirstUnreadReachOutChat() {
    let users = chatUsers;

    if (users.length === 0) {
      await loadChatUsers();
      users = chatUsers;
    }

    const unreadUser =
      users.find((user) => (unreadCounts[user.uid] || 0) > 0) || null;

    setActiveView('reach-out');

    if (unreadUser) {
      setReachOutChatUser(unreadUser);
      setStaffChatUser(null);
      setNewMessage('');
      handleClearImage();
      lastRenderedCoadminChatReadRef.current = '';
    }
  }

  async function handleOpenAnyUnreadChat() {
    if (staffUnreadCount > 0) {
      await handleOpenFirstUnreadStaffChat();
      return;
    }

    if (reachOutUnreadCount > 0) {
      await handleOpenFirstUnreadReachOutChat();
    }
  }

  function resetSelection() {
    setMessage('');
    setSelectedStaff(null);
    setSelectedCarer(null);
    setSelectedPlayer(null);
    setDeleteStaffTarget(null);
    setDeleteCarerTarget(null);
    setDeletePlayerTarget(null);
    setStaffChatUser(null);
    setReachOutChatUser(null);
    setEditingGame(null);
    setNewMessage('');
    handleClearImage();
  }

  function handleChangeView(view: CoadminView) {
    setActiveView(view);
    setMessage('');
    resetSelection();
  }

  async function handleAddPaymentDetailPhotos(files: FileList | null) {
    if (!files?.length) {
      return;
    }
    const uid = auth.currentUser?.uid;
    if (!uid) {
      return;
    }
    setPaymentDetailUploading(true);
    setMessage('');
    try {
      const { default: imageCompression } = await import('browser-image-compression');
      const next = [...paymentDetailPhotos];
      for (const file of Array.from(files)) {
        const compressed = await imageCompression(file, {
          maxSizeMB: 0.7,
          maxWidthOrHeight: 1600,
          useWebWorker: true,
        });
        const uploaded = await uploadCoadminPaymentDetailPhoto(uid, compressed);
        next.push(uploaded);
      }
      await setCoadminPaymentDetailPhotos(uid, next);
      const refreshed = await getCoadminPaymentDetailPhotos(uid);
      setPaymentDetailPhotos(refreshed);
      setMessage('Payment photos saved. Players can use them in Load coin.');
    } catch (err: any) {
      setMessage(err?.message || 'Failed to upload photos.');
    } finally {
      setPaymentDetailUploading(false);
    }
  }

  async function handleRemovePaymentDetailPhoto(index: number) {
    const uid = auth.currentUser?.uid;
    if (!uid) {
      return;
    }
    const next = paymentDetailPhotos.filter((_, i) => i !== index);
    setPaymentDetailUploading(true);
    setMessage('');
    try {
      await setCoadminPaymentDetailPhotos(uid, next);
      const refreshed = await getCoadminPaymentDetailPhotos(uid);
      setPaymentDetailPhotos(refreshed);
    } catch (err: any) {
      setMessage(err?.message || 'Failed to remove photo.');
    } finally {
      setPaymentDetailUploading(false);
    }
  }

  function refreshPaymentListenerRow(listener: PaymentListener) {
    setPaymentListeners((current) => {
      const exists = current.some((row) => row.id === listener.id);
      if (!exists) {
        return [listener, ...current];
      }
      return current.map((row) => (row.id === listener.id ? listener : row));
    });
  }

  function handleAddPaymentListener() {
    setPaymentListenerForm(buildPaymentListenerForm('gmail'));
    setShowPaymentListenerForm(true);
    setMessage('');
  }

  function handleEditPaymentListener(listener: PaymentListener) {
    setPaymentListenerForm(buildPaymentListenerForm(listener.provider, listener));
    setShowPaymentListenerForm(true);
    setMessage('');
  }

  function handlePaymentListenerProviderChange(provider: PaymentListenerProvider) {
    const defaults = paymentListenerDefaults(provider);
    setPaymentListenerForm((current) => ({
      ...current,
      provider,
      imapHost: defaults.imapHost,
      imapPort: String(defaults.imapPort),
      useSsl: defaults.useSsl,
    }));
  }

  async function handleSavePaymentListener() {
    const uid = resolveCoadminActorUid(coadminActorUid);
    if (!uid) {
      setMessage('Not authenticated.');
      return;
    }
    setPaymentListenerSaving(true);
    setMessage('');
    try {
      const payload = {
        coadminUid: uid,
        label: paymentListenerForm.label,
        provider: paymentListenerForm.provider,
        email: paymentListenerForm.email,
        password: paymentListenerForm.password,
        imapHost: paymentListenerForm.imapHost,
        imapPort: Number(paymentListenerForm.imapPort),
        useSsl: paymentListenerForm.useSsl,
        autoLoad: paymentListenerForm.autoLoad,
        enabled: paymentListenerForm.enabled,
      };
      const result = paymentListenerForm.id
        ? await updatePaymentListener(paymentListenerForm.id, payload)
        : await createPaymentListener(payload);
      refreshPaymentListenerRow(result.listener);
      setShowPaymentListenerForm(false);
      setPaymentListenerForm(buildPaymentListenerForm('gmail'));
      setMessage(result.message || 'Listener saved');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to save listener.');
    } finally {
      setPaymentListenerSaving(false);
    }
  }

  async function handleTogglePaymentListener(listener: PaymentListener) {
    const uid = resolveCoadminActorUid(coadminActorUid);
    if (!uid) {
      setMessage('Not authenticated.');
      return;
    }
    setMessage('');
    try {
      const result = await updatePaymentListener(listener.id, {
        coadminUid: uid,
        enabled: !listener.enabled,
      });
      refreshPaymentListenerRow(result.listener);
      setMessage(result.listener.enabled ? 'Listener saved' : 'Listener disabled');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to update listener.');
    }
  }

  async function handleDeletePaymentListener(listener: PaymentListener) {
    const uid = resolveCoadminActorUid(coadminActorUid);
    if (!uid) {
      setMessage('Not authenticated.');
      return;
    }
    setPaymentListenerDeletingId(listener.id);
    setMessage('');
    try {
      await deletePaymentListener(listener.id, uid);
      setPaymentListeners((current) => current.filter((row) => row.id !== listener.id));
      setMessage('Listener deleted');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to delete listener.');
    } finally {
      setPaymentListenerDeletingId(null);
    }
  }

  async function handleTestPaymentListener(listener: PaymentListener) {
    const uid = resolveCoadminActorUid(coadminActorUid);
    if (!uid) {
      setMessage('Not authenticated.');
      return;
    }
    setPaymentListenerTestingId(listener.id);
    setMessage('');
    try {
      const result = await testPaymentListener(listener.id, uid);
      refreshPaymentListenerRow(result.listener);
      setMessage(result.message || 'Connection successful');
    } catch (error) {
      const messageText = error instanceof Error ? error.message : 'Connection failed';
      setMessage(messageText || 'Invalid credentials');
      void listPaymentListeners(uid)
        .then(setPaymentListeners)
        .catch(() => undefined);
    } finally {
      setPaymentListenerTestingId(null);
    }
  }

  function sortByNewest<T extends { createdAt?: any }>(list: T[]) {
    return [...list].sort((a: any, b: any) => {
      const aTime =
        a.createdAt?.toDate?.()?.getTime?.() ||
        a.createdAt?.getTime?.() ||
        0;

      const bTime =
        b.createdAt?.toDate?.()?.getTime?.() ||
        b.createdAt?.getTime?.() ||
        0;

      return bTime - aTime;
    });
  }

  const sortedStaff = sortByNewest(staffList);
  const sortedCarers = sortByNewest(carerList);
  const sortedPlayers = sortByNewest(playerList);
  const selectedPlayerTabRows = selectedPlayerRecordRows[selectedPlayerRecordTab];
  const selectedPlayerTabPage = selectedPlayerRecordPages[selectedPlayerRecordTab];
  const selectedPlayerTabPageCount = Math.max(
    1,
    Math.ceil(selectedPlayerTabRows.length / 30)
  );
  const selectedPlayerTabVisibleRows = selectedPlayerTabRows.slice(
    (selectedPlayerTabPage - 1) * 30,
    selectedPlayerTabPage * 30
  );
  const selectedPlayerTabVisibleTotal = selectedPlayerTabVisibleRows.reduce(
    (total, row) => total + Math.max(0, Number(row.amountValue || 0)),
    0
  );

  const coadminPresenceUids = useMemo(() => {
    const s = new Set<string>();
    for (const u of staffList) s.add(u.uid);
    for (const u of carerList) s.add(u.uid);
    for (const u of playerList) s.add(u.uid);
    for (const u of chatUsers) s.add(u.uid);
    return Array.from(s);
  }, [staffList, carerList, playerList, chatUsers]);

  const coadminOnlineByUid = usePresenceOnlineMap(coadminPresenceUids);

  const shiftsRows = useMemo(() => {
    const nowMs = Date.now();
    const heartbeatGraceMs = 2 * 60 * 1000;
    const byUser = new Map<string, ShiftSession[]>();
    for (const item of shiftSessions) {
      const list = byUser.get(item.userUid) || [];
      list.push(item);
      byUser.set(item.userUid, list);
    }

    const workers = [
      ...sortedStaff.map((user) => ({ ...user, workerRole: 'staff' as const })),
      ...sortedCarers.map((user) => ({ ...user, workerRole: 'carer' as const })),
    ];

    return workers.map((worker) => {
      const sessions = byUser.get(worker.uid) || [];
      const latestLoginAt =
        [...sessions]
          .map((session) => ({ value: session.loginAt || null, ms: toMillis(session.loginAt || null) }))
          .sort((a, b) => b.ms - a.ms)[0]?.value || null;
      const latestLogoutAtRaw =
        [...sessions]
          .map((session) => ({ value: session.logoutAt || null, ms: toMillis(session.logoutAt || null) }))
          .sort((a, b) => b.ms - a.ms)[0]?.value || null;
      const latestLastSeenAt =
        [...sessions]
          .map((session) => ({ value: session.lastSeenAt || null, ms: toMillis(session.lastSeenAt || null) }))
          .sort((a, b) => b.ms - a.ms)[0]?.value || null;

      const activeSession = [...sessions]
        .filter((session) => Boolean(session.isActive))
        .sort((a, b) => {
          const aMs = toMillis(a.lastSeenAt || null) || toMillis(a.loginAt || null);
          const bMs = toMillis(b.lastSeenAt || null) || toMillis(b.loginAt || null);
          return bMs - aMs;
        })[0];
      const activeSeenMs = toMillis(activeSession?.lastSeenAt || null);
      const isActive =
        Boolean(activeSession) &&
        activeSeenMs > 0 &&
        nowMs - activeSeenMs <= heartbeatGraceMs;

      const workedHoursLast24h = calculateWorkedHoursLast24hWithHeartbeat(
        sessions,
        nowMs,
        heartbeatGraceMs
      );
      const inferredLogoutAt =
        !isActive && latestLogoutAtRaw == null && latestLastSeenAt ? latestLastSeenAt : null;

      return {
        uid: worker.uid,
        username: worker.username,
        role: worker.workerRole,
        cashBoxNpr: Number(worker.cashBoxNpr || 0),
        latestLoginAt,
        latestLogoutAt: latestLogoutAtRaw || inferredLogoutAt,
        isActive,
        lastSeenAt: latestLastSeenAt,
        workedHoursLast24h,
      };
    });
  }, [shiftSessions, sortedCarers, sortedStaff]);
  const menuItems: (NavigationItem & { view: CoadminView })[] = [
    { label: 'Dashboard', view: 'dashboard' },
    { label: 'View Tasks', view: 'view-tasks' },
    { label: 'Create Bonus Event', view: 'create-bonus-event' },
    { label: 'View Bonus Events', view: 'view-bonus-events' },
    { label: 'Add Staff', view: 'add-staff' },
    {
      label: 'View Staff',
      view: 'view-staff',
      unread: staffUnreadCount,
      onClick: () => {
        if (staffUnreadCount > 0) {
          handleOpenFirstUnreadStaffChat();
          return;
        }

        handleChangeView('view-staff');
      },
    },
    { label: 'Hire Carer', view: 'create-carer' },
    { label: 'View Carers', view: 'view-carers' },
    { label: 'Create Player', view: 'create-player' },
    { label: 'View Players', view: 'view-players' },
    { label: 'Add Games', view: 'add-games' },
    { label: 'Game List', view: 'game-list' },
    { label: 'Payment details (photos)', view: 'payment-details' },
    { label: 'Listener Details', view: 'listener-details' },
    { label: 'Shifts', view: 'shifts' },
    { label: 'Behaviours', view: 'behaviours' },
    {
      label: 'Reach Out',
      view: 'reach-out',
      unread: reachOutUnreadCount,
      onClick: () => {
        if (reachOutUnreadCount > 0) {
          handleOpenFirstUnreadReachOutChat();
          return;
        }

        handleChangeView('reach-out');
      },
    },
  ];

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

  return (
    <ProtectedRoute allowedRoles={['coadmin']}>
      <RoleSidebarLayout
        title="Co-admin Panel"
        activeView={activeView}
        items={menuItems.map((item) => ({
          ...item,
          onClick: item.onClick ?? (() => handleChangeView(item.view as CoadminView)),
        }))}
        footer={<LogoutButton />}
      >
          {message && (
            <div className="mb-4 rounded-2xl bg-white/10 p-3 text-sm text-neutral-300">
              {message}
            </div>
          )}

          {/* Dashboard content (stats) */}
          {activeView === 'dashboard' && (
            <div>
            <DashboardView
              coadminCount={0}
              staffCount={staffList.length}
              unreadCount={totalUnread}
            />

            <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
              <div className="rounded-2xl border border-white/10 bg-white/5 p-6">
                <p className="text-sm text-neutral-400">Total Carers</p>
                <p className="mt-2 text-3xl font-bold">{carerList.length}</p>
              </div>

              <div className="rounded-2xl border border-white/10 bg-white/5 p-6">
                <p className="text-sm text-neutral-400">Total Players</p>
                <p className="mt-2 text-3xl font-bold">{playerList.length}</p>
              </div>

              <div className="rounded-2xl border border-white/10 bg-white/5 p-6">
                <p className="text-sm text-neutral-400">Total Games</p>
                <p className="mt-2 text-3xl font-bold">{gameLogins.length}</p>
              </div>
            </div>

            <section className="mt-4 rounded-2xl border border-cyan-400/25 bg-cyan-500/10 p-5">
              <p className="text-sm font-semibold uppercase tracking-wide text-cyan-200">Player Signup Code</p>
              <p className="mt-2 text-sm text-neutral-300">
                Give this code to players so their self-created account connects to your coadmin account.
              </p>
              <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
                <code className="rounded-xl border border-white/10 bg-black/25 px-4 py-3 text-lg font-bold tracking-wider text-white">
                  {playerSignupCodeLoading ? 'Loading…' : playerSignupCode || 'Unavailable'}
                </code>
                <div className="flex gap-2">
                  <button type="button" onClick={() => void handleCopyPlayerSignupCode()} disabled={!playerSignupCode || playerSignupCodeLoading} className="rounded-xl bg-cyan-400 px-4 py-2 text-sm font-bold text-slate-950 transition hover:bg-cyan-300 disabled:opacity-50">Copy</button>
                  <button type="button" onClick={() => void handleRotatePlayerSignupCode()} disabled={playerSignupCodeRotating || playerSignupCodeLoading} className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-bold text-white transition hover:bg-white/15 disabled:opacity-50">{playerSignupCodeRotating ? 'Generating…' : 'Generate New Code'}</button>
                </div>
              </div>
            </section>

            {/* Maintenance Break card — render for coadmin pages regardless of active view so it's reachable */}
            <div
              className={`mt-4 rounded-2xl border p-5 ${
                maintenanceBreak.enabled
                  ? 'border-amber-400/40 bg-amber-500/10'
                  : 'border-emerald-400/25 bg-emerald-500/10'
              }`}
            >
              <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                <div>
                  <p className="text-sm font-semibold uppercase tracking-wide text-neutral-400">
                    Maintenance Break
                  </p>
                  <h3 className="mt-1 text-xl font-bold text-white">
                    {maintenanceBreak.enabled ? 'Active' : 'Inactive'}
                  </h3>
                  <p className="mt-2 max-w-2xl whitespace-pre-line text-sm leading-relaxed text-neutral-300">
                    {maintenanceBreak.enabled
                      ? maintenanceBreak.message
                      : 'Players can use the player app normally.'}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
                  <button
                    type="button"
                    onClick={() => void handleMaintenanceBreakToggle(true)}
                    disabled={maintenanceBusy || maintenanceBreak.enabled}
                    className="rounded-xl bg-amber-400 px-4 py-2 text-sm font-bold text-black transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Start Maintenance Break
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleMaintenanceBreakToggle(false)}
                    disabled={maintenanceBusy || !maintenanceBreak.enabled}
                    className="rounded-xl border border-white/15 bg-white/10 px-4 py-2 text-sm font-bold text-white transition hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    End Maintenance Break
                  </button>
                </div>
              </div>
            </div>

            <div className="mt-4 rounded-2xl border border-fuchsia-400/35 bg-gradient-to-br from-fuchsia-500/15 via-amber-500/10 to-white/5 p-5">
              <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                <div>
                  <p className="text-sm font-semibold uppercase tracking-wide text-fuchsia-200">
                    Player Surprise
                  </p>
                  <h3 className="mt-1 text-xl font-bold text-white">Give FreePlay</h3>
                  <p className="mt-2 text-sm text-neutral-300">
                    Send a mystery FreePlay coin gift to one randomly selected active player.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void handleGiveFreeplay()}
                  disabled={freeplayGiveBusy}
                  className="shrink-0 rounded-xl bg-gradient-to-r from-fuchsia-500 to-amber-400 px-5 py-3 text-sm font-bold text-white shadow-lg shadow-fuchsia-900/25 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {freeplayGiveBusy ? 'Sending...' : 'Give FreePlay'}
                </button>
              </div>
            </div>

            {visiblePendingCarerRequests.length > 0 && (
                <div className="mt-4 rounded-2xl border border-yellow-500/30 bg-yellow-500/10 p-5">
                  <h3 className="text-lg font-bold text-yellow-200">
                    Carer Requests Awaiting Admin Approval ({visiblePendingCarerRequests.length})
                  </h3>
                  <div className="mt-3 space-y-2">
                    {visiblePendingCarerRequests.slice(0, 5).map((request) => (
                      <div
                        key={request.id}
                        className="rounded-xl border border-white/10 bg-black/30 p-3"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-sm text-white">
                              Username: <span className="font-semibold">{request.requestedUsername}</span>
                            </p>
                            <p className="text-xs text-yellow-100/70">
                              Requested at: {formatDateTime(request.requestedAt)}
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() =>
                              setDismissedPendingCarerRequestIds((current) =>
                                current.includes(request.id) ? current : [...current, request.id]
                              )
                            }
                            className="rounded-lg border border-yellow-300/30 bg-yellow-500/10 px-3 py-1 text-xs font-semibold text-yellow-100 hover:bg-yellow-500/20"
                          >
                            Dismiss
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {pendingCashouts.length > 0 && (
                <div className="mt-4 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-5">
                  <h3 className="text-lg font-bold text-emerald-200">
                    Carer Cashout Requests ({pendingCashouts.length})
                  </h3>

                  <div className="mt-3 space-y-3">
                    {pendingCashouts.map((request) => (
                      <div
                        key={request.id}
                        className="rounded-xl border border-white/10 bg-black/30 p-4"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-4">
                          <div>
                            <p className="text-sm font-semibold text-white">
                              {request.carerUsername}
                            </p>
                            <p className="text-sm text-neutral-300">
                              Amount: {formatUsdFromNprDisplay(request.amountNpr || 0)}
                            </p>
                            {request.paymentDetails && (
                              <p className="mt-1 text-xs text-neutral-400">
                                {request.paymentDetails}
                              </p>
                            )}
                            {request.paymentQrUrl && (
                              <a
                                href={request.paymentQrUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="mt-2 inline-block text-xs font-semibold text-cyan-300 hover:text-cyan-200"
                              >
                                Open Payment QR
                              </a>
                            )}
                          </div>

                          <div className="flex min-w-[220px] flex-col gap-2">
                            <input
                              type="number"
                              min={0}
                              step={1}
                              value={cashoutDoneAmountById[request.id] || ''}
                              onChange={(event) =>
                                setCashoutDoneAmountById((current) => ({
                                  ...current,
                                  [request.id]: event.target.value,
                                }))
                              }
                              placeholder={`Done amount (max ${Math.round(
                                Number(request.amountNpr || 0)
                              )})`}
                              className="rounded-lg border border-white/15 bg-black/35 px-3 py-2 text-sm text-white"
                            />
                            <button
                              type="button"
                              disabled={loading}
                              onClick={() => void handleCompleteCashout(request)}
                              className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-black hover:bg-neutral-200 disabled:opacity-60"
                            >
                              Done
                            </button>
                            <button
                              type="button"
                              disabled={loading}
                              onClick={() => void handleDeclineCashout(request)}
                              className="rounded-lg border border-red-400/40 bg-red-500/10 px-4 py-2 text-sm font-semibold text-red-100 hover:bg-red-500/20 disabled:opacity-60"
                            >
                              Decline
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {visibleRecentCarerEscalations.length > 0 && (
                <div className="mt-4 rounded-2xl border border-red-500/30 bg-red-500/10 p-5">
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

              {visiblePlayerCashoutTasks.length > 0 && (
                <div className="mt-4 rounded-2xl border border-cyan-500/30 bg-cyan-500/10 p-5">
                  <h3 className="text-lg font-bold text-cyan-200">
                    Player Cashout Tasks ({visiblePlayerCashoutTasks.length})
                  </h3>
                  <div className="mt-3 space-y-3">
                    {visiblePlayerCashoutTasks.map((task) => {
                      const isInProgress = task.status === 'in_progress';
                      const remainingMs = getPlayerCashoutTaskCountdown(task);
                      const actionLabel = isInProgress
                        ? `Done (${formatCountdownMs(remainingMs + countdownTick * 0)})`
                        : 'Start Task';

                      return (
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
                                Amount: {formatUsdFromNprDisplay(task.amountNpr || 0)}
                              </p>
                              {renderPlayerCashoutPayment(task)}
                            </div>
                            <div className="flex min-w-[130px] flex-col gap-2">
                              <button
                                type="button"
                                onClick={() =>
                                  void (isInProgress
                                    ? handleCompletePlayerCashoutTask(task.id)
                                    : handleStartPlayerCashoutTask(task.id))
                                }
                                disabled={playerCashoutTaskLoadingId === task.id}
                                className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-black hover:bg-neutral-200 disabled:opacity-60"
                              >
                                {playerCashoutTaskLoadingId === task.id ? 'Saving...' : actionLabel}
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleDeclinePlayerCashoutTask(task.id)}
                                disabled={playerCashoutTaskLoadingId === task.id}
                                className="rounded-lg border border-red-400/40 bg-red-500/10 px-4 py-2 text-sm font-semibold text-red-100 hover:bg-red-500/20 disabled:opacity-60"
                              >
                                {playerCashoutTaskLoadingId === task.id ? 'Saving...' : 'Decline'}
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {totalUnread > 0 && (
                <button
                  onClick={handleOpenAnyUnreadChat}
                  className="mt-4 rounded-2xl bg-red-500 px-4 py-3 text-sm font-bold text-white hover:bg-red-600"
                >
                  Open unread chat
                </button>
              )}
            </div>
          )}

          {activeView === 'view-tasks' && (
            <div className="space-y-6">
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
                {pendingCashoutTasks.length === 0 ? (
                  <p className="mt-3 text-sm text-cyan-100/70">No pending cashout tasks.</p>
                ) : (
                  <div className="mt-3 space-y-3">
                    {pendingCashoutTasks.map((task) => (
                      <div
                        key={task.id}
                        className="rounded-xl border border-cyan-400/25 bg-black/30 p-4"
                      >
                        <p className="text-sm font-semibold text-white">
                          Player: {task.playerUsername}
                        </p>
                        <p className="text-sm text-cyan-100/85">
                          Amount: {formatUsdFromNprDisplay(task.amountNpr || 0)}
                        </p>
                        {renderPlayerCashoutPayment(task)}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-5">
                <h3 className="text-lg font-bold text-amber-200">Active / Claimed Cashout Tasks</h3>
                {activeCashoutTasks.length === 0 ? (
                  <p className="mt-3 text-sm text-amber-100/70">No active cashout tasks.</p>
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
                                Amount: {formatUsdFromNprDisplay(task.amountNpr || 0)}
                              </p>
                              {renderPlayerCashoutPayment(task)}
                              <p className="mt-1 text-xs text-amber-100/70">
                                Handler: {task.assignedHandlerUsername || 'Unknown'}
                              </p>
                            </div>
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
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-5">
                <h3 className="text-lg font-bold text-emerald-200">Completed Tasks</h3>
                {completedPlayerCashoutTasks.length === 0 ? (
                  <p className="mt-3 text-sm text-emerald-100/70">No completed tasks yet.</p>
                ) : (
                  <div className="mt-3 space-y-3">
                    {completedPlayerCashoutTasks.map((task) => (
                      <div
                        key={task.id}
                        className="rounded-xl border border-emerald-400/25 bg-black/30 p-4"
                      >
                        <p className="text-sm font-semibold text-white">
                          Player: {task.playerUsername}
                        </p>
                        <p className="text-sm text-emerald-100/85">
                          Amount: {formatUsdFromNprDisplay(task.amountNpr || 0)}
                        </p>
                        {renderPlayerCashoutPayment(task)}
                        <p className="mt-1 text-xs text-emerald-100/70">
                          Completed: {formatDateTime(task.completedAt || null) || 'Done'}
                        </p>
                        <p className="mt-1 text-xs text-emerald-100/70">
                          Handler: {task.assignedHandlerUsername || 'Unknown'}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {activeView === 'create-bonus-event' && (
            <form
              onSubmit={handleCreateBonusEvent}
              className="max-w-2xl rounded-2xl border border-white/10 bg-white/5 p-6"
            >
              <h2 className="text-3xl font-bold">Create Bonus Event</h2>
              <div className="mt-5 space-y-4">
                <label className="block text-sm">
                  Bonus Name
                  <input
                    value={bonusName}
                    onChange={(event) => setBonusName(event.target.value)}
                    className="mt-2 w-full rounded-xl border border-white/15 bg-black/30 px-4 py-3 text-white outline-none focus:border-white/40"
                    placeholder="Bonus name"
                  />
                </label>
                <label className="block text-sm">
                  Game Name
                  <select
                    value={bonusGameName}
                    onChange={(event) => setBonusGameName(event.target.value)}
                    className="mt-2 w-full rounded-xl border border-white/15 bg-black/30 px-4 py-3 text-white outline-none focus:border-white/40"
                  >
                    <option value="">Select game</option>
                    {gameLogins.map((game) => (
                      <option key={game.id} value={game.gameName}>
                        {game.gameName}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm">
                  Amount
                  <input
                    type="number"
                    min={10}
                    max={50}
                    value={bonusAmount}
                    onChange={(event) => setBonusAmount(event.target.value)}
                    className="mt-2 w-full rounded-xl border border-white/15 bg-black/30 px-4 py-3 text-white outline-none focus:border-white/40"
                    placeholder="10 - 50"
                  />
                </label>
                <label className="block text-sm">
                  Description
                  <textarea
                    value={bonusDescription}
                    onChange={(event) => setBonusDescription(event.target.value)}
                    className="mt-2 min-h-24 w-full rounded-xl border border-white/15 bg-black/30 px-4 py-3 text-white outline-none focus:border-white/40"
                    placeholder="Describe this bonus"
                  />
                </label>
                <label className="block text-sm">
                  Bonus Percentage
                  <input
                    type="number"
                    min={5}
                    max={10}
                    value={bonusPercentage}
                    onChange={(event) => setBonusPercentage(event.target.value)}
                    className="mt-2 w-full rounded-xl border border-white/15 bg-black/30 px-4 py-3 text-white outline-none focus:border-white/40"
                    placeholder="5 - 10"
                  />
                </label>
                <button
                  type="submit"
                  disabled={loading}
                  className="rounded-xl bg-white px-5 py-3 text-sm font-semibold text-black hover:bg-neutral-200 disabled:opacity-60"
                >
                  {loading ? 'Creating...' : 'Create Bonus Event'}
                </button>
              </div>
            </form>
          )}

          {activeView === 'view-bonus-events' && (
            <div>
              <div className="mb-6 flex flex-col gap-4 rounded-2xl border border-violet-400/25 bg-violet-500/10 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="text-3xl font-bold">View Bonus Events</h2>
                  <p className="mt-1 text-sm text-violet-100/75">
                    Set the percentage range used when coadmin bonus events are auto-created.
                    Examples: `10` to `20`, or `5` to `30`.
                  </p>
                </div>
                <div className="flex flex-wrap items-end gap-3">
                  {isQuotaExceededMessage(message) && (
                    <button
                      type="button"
                      onClick={() => {
                        resetBonusEventsEnsureGuard('manual_refresh');
                        setMessage('');
                        void ensureCoadminBonusCapacity(undefined, { ignoreCooldown: true });
                      }}
                      disabled={bonusAutoFillBusyRef.current}
                      className="min-h-[44px] rounded-xl border border-amber-300/40 bg-amber-200/90 px-4 py-2 text-sm font-semibold text-black transition hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {bonusAutoFillBusyRef.current ? 'Retrying...' : 'Retry now'}
                    </button>
                  )}
                  <label className="flex min-w-[110px] flex-col gap-1 text-sm text-violet-100/80">
                    <span>Min %</span>
                    <input
                      type="number"
                      min={COADMIN_AUTO_BONUS_PERCENT_MIN}
                      max={COADMIN_AUTO_BONUS_PERCENT_MAX}
                      value={autoBonusMinPercentInput}
                      onChange={(event) => setAutoBonusMinPercentInput(event.target.value)}
                      disabled={autoBonusRangeBusy}
                      className="rounded-xl border border-violet-400/35 bg-black/30 px-3 py-2 text-white outline-none transition focus:border-violet-300"
                    />
                  </label>
                  <label className="flex min-w-[110px] flex-col gap-1 text-sm text-violet-100/80">
                    <span>Max %</span>
                    <input
                      type="number"
                      min={COADMIN_AUTO_BONUS_PERCENT_MIN}
                      max={COADMIN_AUTO_BONUS_PERCENT_MAX}
                      value={autoBonusMaxPercentInput}
                      onChange={(event) => setAutoBonusMaxPercentInput(event.target.value)}
                      disabled={autoBonusRangeBusy}
                      className="rounded-xl border border-violet-400/35 bg-black/30 px-3 py-2 text-white outline-none transition focus:border-violet-300"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => void handleSaveAutoBonusPercentRange()}
                    disabled={autoBonusRangeBusy}
                    className="min-h-[44px] rounded-xl border border-violet-300/35 bg-white px-4 py-2 text-sm font-semibold text-black transition hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {autoBonusRangeBusy ? 'Saving...' : 'Save Range'}
                  </button>
                </div>
              </div>
              {myBonusEvents.length === 0 ? (
                <div className="space-y-3">
                  <p className="text-sm text-neutral-400">No active bonus events.</p>
                  <p className="text-xs text-neutral-500">
                    Existing bonus events may have expired. Create or refill active events.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      resetBonusEventsEnsureGuard('manual_refill');
                      void ensureCoadminBonusCapacity(0, { ignoreCooldown: true });
                    }}
                    disabled={bonusAutoFillBusyRef.current}
                    className="min-h-[40px] rounded-xl border border-violet-300/35 bg-violet-500/20 px-4 py-2 text-sm font-semibold text-violet-100 transition hover:bg-violet-500/30 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {bonusAutoFillBusyRef.current ? 'Refilling...' : 'Refill active events'}
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  {myBonusEvents.map((event) => (
                    <div
                      key={event.id}
                      className="rounded-xl border border-violet-400/25 bg-violet-500/10 p-4"
                    >
                      <p className="text-base font-semibold text-white">{event.bonusName}</p>
                      <p className="mt-1 text-sm text-violet-100/85">
                        Game: {event.gameName} | Amount: {formatUsdFromNprDisplay(event.amountNpr || 0)}
                      </p>
                      <p className="mt-1 text-sm text-violet-100/85">{event.description}</p>
                      <p className="mt-1 text-xs text-violet-100/70">
                        Bonus: {event.bonusPercentage}% | Created:{' '}
                        {formatDateTime(event.createdAt || null) || 'Now'}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeView === 'add-staff' && (
            <CreateUserForm
              title="Add Staff"
              buttonLabel="Create Staff"
              loadingLabel="Creating..."
              username={staffUsername}
              password={staffPassword}
              loading={loading}
              onUsernameChange={setStaffUsername}
              onPasswordChange={setStaffPassword}
              onSubmit={handleCreateStaff}
            />
          )}

          {activeView === 'view-staff' && (
            <UserManagementView<StaffUser>
              title="Staff"
              emptyText="No staff found."
              selectText="Select a staff member to manage."
              deleteTitle="Delete staff?"
              deleteMessage="Are you sure you want to delete"
              users={sortedStaff}
              selectedUser={selectedStaff}
              deleteTarget={deleteStaffTarget}
              loadingList={loadingList}
              loading={loading}
              unreadCounts={unreadCounts}
              imagePreview={imagePreview}
              sendingImage={sendingImage}
              onSelectUser={setSelectedStaff}
              onSetDeleteTarget={setDeleteStaffTarget}
              onDelete={handleDeleteStaff}
              onToggleBlock={handleToggleStaffStatus}
              blocking={blocking}
              onCoadminSetPassword={handleCoadminSetStaffPassword}
              onCoadminSetUsername={handleCoadminSetStaffUsername}
              coadminCredentialsLoading={workerCredentialsLoading}
              onlineByUid={coadminOnlineByUid}
              nameMode="coadmin"
              onStartChat={handleStaffStartChat}
              chatUser={staffChatUser}
              messages={messages}
              newMessage={newMessage}
              onMessageChange={setNewMessage}
              onSendMessage={handleSendMessage}
              onImageSelect={handleImageSelect}
              onClearImage={handleClearImage}
              messagesScrollRef={coadminChatScrollRef}
              hasMoreOlderMessages={pagedCoadminChat.hasMoreOlder}
              loadingOlderMessages={pagedCoadminChat.loadingOlder}
              onLoadOlderMessages={pagedCoadminChat.loadOlder}
              renderSelectedExtras={(staffMember) => {
                const staffWallet = staffWalletsByUid[staffMember.uid];
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
                const walletAmountInput = staffWalletAmountByUid[staffMember.uid] || '';
                const walletAllocating = staffWalletAllocatingUid === staffMember.uid;
                const completedPayouts = staffLedgerPayoutTasks.filter(
                  (task) =>
                    getEffectivePlayerCashoutTaskStatus(task) === 'completed'
                );
                const declinedPayouts = staffLedgerPayoutTasks.filter(
                  (task) =>
                    getEffectivePlayerCashoutTaskStatus(task) === 'declined'
                );
                const activePayouts = staffLedgerPayoutTasks.filter((task) => {
                  const effective = getEffectivePlayerCashoutTaskStatus(task);
                  return effective !== 'completed' && effective !== 'declined';
                });

                return (
                  <div className="mt-6 space-y-5 border-t border-white/15 pt-6 text-left">
                    <div className="rounded-2xl border border-violet-400/35 bg-violet-950/20 p-4">
                      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                        <div>
                          <h4 className="text-sm font-black uppercase tracking-wide text-violet-100">
                            Staff Wallet
                          </h4>
                          <p className="mt-2 text-3xl font-black text-white tabular-nums">
                            {staffWalletsLoading
                              ? 'Loading...'
                              : `${staffWalletBalance.toLocaleString()} coins`}
                          </p>
                          <p className="mt-1 text-xs text-violet-100/70">
                            Total allocated: {staffWalletTotalAllocated.toLocaleString()} coins
                            {' · '}
                            Total loaded to players: {staffWalletTotalLoaded.toLocaleString()} coins
                          </p>
                        </div>

                        <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-end lg:w-auto">
                          <label className="min-w-0 flex-1 text-sm text-neutral-300 lg:w-48">
                            Amount
                            <input
                              type="number"
                              min={1}
                              step={1}
                              inputMode="numeric"
                              value={walletAmountInput}
                              onChange={(event) =>
                                setStaffWalletAmountByUid((current) => ({
                                  ...current,
                                  [staffMember.uid]: event.target.value,
                                }))
                              }
                              disabled={walletAllocating}
                              placeholder="0"
                              className="mt-1 w-full rounded-xl border border-white/15 bg-black/40 px-3 py-2 text-white outline-none focus:border-violet-400/60 disabled:opacity-50"
                            />
                          </label>
                          <button
                            type="button"
                            onClick={() => void handleAllocateStaffWallet(staffMember)}
                            disabled={walletAllocating || staffWalletsLoading}
                            className="whitespace-nowrap rounded-xl bg-violet-400 px-4 py-2.5 text-sm font-black text-black hover:bg-violet-300 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {walletAllocating ? 'Allocating...' : 'Allocate Coins'}
                          </button>
                        </div>
                      </div>
                    </div>

                    <div>
                      <h4 className="text-sm font-black uppercase tracking-wide text-teal-200/95">
                        Staff oversight snapshot
                      </h4>
                      <p className="mt-1 text-xs leading-relaxed text-neutral-400">
                        Tracks player cashouts where this login started or closed the payout,
                        Claim Pay (cash box) payouts to you from this worker, linked inquiries about
                        those players (newer inquires carry player linkage).
                      </p>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-3">
                      <div className="rounded-2xl border border-emerald-500/35 bg-emerald-950/30 p-4">
                        <p className="text-[11px] font-bold uppercase tracking-wide text-emerald-100/85">
                          Live cash box
                        </p>
                        <p className="mt-2 text-2xl font-black text-emerald-50">
                          {staffLiveCashBoxNpr === null
                            ? '…'
                            : formatUsdFromNprDisplay(staffLiveCashBoxNpr)}
                        </p>
                      </div>
                      <div className="rounded-2xl border border-cyan-500/35 bg-cyan-950/25 p-4">
                        <p className="text-[11px] font-bold uppercase tracking-wide text-cyan-100/85">
                          Player cashouts (ledger)
                        </p>
                        <p className="mt-2 text-lg font-bold text-cyan-50">
                          {staffLedgerPayoutTasks.length} total · {completedPayouts.length} done ·{' '}
                          {declinedPayouts.length} declined · {activePayouts.length} active
                        </p>
                      </div>
                      <div className="rounded-2xl border border-amber-500/35 bg-amber-950/25 p-4">
                        <p className="text-[11px] font-bold uppercase tracking-wide text-amber-100/85">
                          Claim Pay sent
                        </p>
                        <p className="mt-2 text-lg font-bold text-amber-50">
                          {staffLedgerClaimPay.length} record
                          {staffLedgerClaimPay.length === 1 ? '' : 's'}
                        </p>
                      </div>
                    </div>

                    <div className="rounded-2xl border border-cyan-500/35 bg-neutral-950/40 p-4">
                      <h5 className="text-xs font-black uppercase tracking-wide text-cyan-100">
                        Player payouts handled ({staffLedgerPayoutTasks.length})
                      </h5>
                      <p className="mt-1 text-[11px] text-cyan-100/65">
                        Task ID, player, payout method, timestamps, ledger status — same details you
                        would verify on Tasks.
                      </p>
                      {staffLedgerPayoutTasks.length === 0 ? (
                        <p className="mt-3 text-sm text-neutral-500">
                          No routed player cashouts for {staffMember.username} yet.
                        </p>
                      ) : (
                        <div className="mt-3 max-h-[26rem] space-y-3 overflow-y-auto pr-1">
                          {staffLedgerPayoutTasks.map((task) => {
                            const effective = getEffectivePlayerCashoutTaskStatus(task);
                            const rewardNpr = Math.max(
                              1,
                              Math.round(Number(task.amountNpr || 0) * 0.05)
                            );
                            return (
                              <div
                                key={task.id}
                                className="rounded-xl border border-white/15 bg-black/35 p-3 text-xs"
                              >
                                <div className="flex flex-wrap items-start justify-between gap-2">
                                  <div className="space-y-1">
                                    <p className="text-sm font-semibold text-white">
                                      {task.playerUsername}
                                    </p>
                                    <p className="text-[11px] text-neutral-500">
                                      Task ID: {task.id}
                                    </p>
                                    <p className="text-[11px] text-cyan-100/80">
                                      Amount: {formatUsdFromNprDisplay(task.amountNpr || 0)}{' '}
                                      <span className="text-neutral-500">
                                        (handler reward ≈{' '}
                                        {formatUsdFromNprDisplay(rewardNpr)})
                                      </span>
                                    </p>
                                    <p className="text-[11px] text-neutral-400">
                                      Status:{' '}
                                      <span className="font-semibold text-white">{effective}</span>
                                      {' · '}Created{' '}
                                      {formatDateTime(task.createdAt)}{' '}
                                      {task.completedAt ? (
                                        <>· Completed {formatDateTime(task.completedAt)} </>
                                      ) : null}
                                    </p>
                                    {task.status === 'in_progress' && task.expiresAt ? (
                                      <p className="text-[11px] text-orange-100/85">
                                        Window: {formatDateTime(task.startedAt)} →{' '}
                                        {formatDateTime(task.expiresAt)}
                                      </p>
                                    ) : null}
                                  </div>
                                </div>
                                <div className="mt-2 border-t border-white/10 pt-2">
                                  {renderPlayerCashoutPayment(task)}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>

                    <div className="rounded-2xl border border-emerald-500/35 bg-neutral-950/40 p-4">
                      <h5 className="text-xs font-black uppercase tracking-wide text-emerald-100">
                        Claim Pay & payment trail ({staffLedgerClaimPay.length})
                      </h5>
                      <p className="mt-1 text-[11px] text-emerald-100/65">
                        Each row is a Request-to-coadmin payout. Includes payout info they submitted &
                        settle state.
                      </p>
                      {staffLedgerClaimPay.length === 0 ? (
                        <p className="mt-3 text-sm text-neutral-500">
                          No Claim Pay submissions recorded for this account.
                        </p>
                      ) : (
                        <div className="mt-3 max-h-80 space-y-3 overflow-y-auto pr-1">
                          {staffLedgerClaimPay.map((request) => (
                            <div
                              key={request.id}
                              className="rounded-xl border border-white/15 bg-black/35 p-3 text-xs"
                            >
                              <div className="flex flex-wrap items-start justify-between gap-2">
                                <div>
                                  <p className="text-sm font-semibold text-white">
                                    {formatUsdFromNprDisplay(request.amountNpr || 0)} ·{' '}
                                    <span className="text-neutral-300">{request.status}</span>
                                  </p>
                                  <p className="text-[11px] text-neutral-500">ID: {request.id}</p>
                                  <p className="text-[11px] text-neutral-400">
                                    Requested {formatDateTime(request.createdAt)}
                                    {request.completedAt ? (
                                      <> · Settled {formatDateTime(request.completedAt)}</>
                                    ) : null}
                                  </p>
                                  {typeof request.completedAmountNpr === 'number' ? (
                                    <p className="text-[11px] text-emerald-100/90">
                                      Done amount:{' '}
                                      {formatUsdFromNprDisplay(request.completedAmountNpr)}
                                      {' · '}
                                      Remaining back to cash box:{' '}
                                      {formatUsdFromNprDisplay(request.remainingAmountNpr || 0)}
                                    </p>
                                  ) : null}
                                </div>
                              </div>
                              {request.paymentDetails ? (
                                <pre className="mt-2 whitespace-pre-wrap rounded-lg border border-white/10 bg-black/40 p-2 text-[11px] text-neutral-200">
                                  {request.paymentDetails}
                                </pre>
                              ) : (
                                <p className="mt-2 text-[11px] text-neutral-500">
                                  Payment details omitted.
                                </p>
                              )}
                              {request.paymentQrUrl ? (
                                <a
                                  href={request.paymentQrUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="mt-2 inline-block text-[11px] font-semibold text-cyan-300 hover:text-cyan-200"
                                >
                                  Open Claim Pay QR ↗
                                </a>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="rounded-2xl border border-orange-400/35 bg-orange-950/30 p-4">
                      <h5 className="text-xs font-black uppercase tracking-wide text-orange-100">
                        Inquiries & alerts ({staffInspectionAlerts.length})
                      </h5>
                      <p className="mt-1 text-[11px] text-orange-50/85">
                        Includes payout messages initiated by{' '}
                        <span className="font-semibold text-white">{staffMember.username}</span> and,
                        player or risk payouts linked to cashouts routed through them.
                      </p>
                      {staffInspectionAlerts.length === 0 ? (
                        <p className="mt-3 text-sm text-neutral-500">
                          No linked alerts in the current feed.
                        </p>
                      ) : (
                        <div className="mt-3 max-h-72 space-y-2 overflow-y-auto pr-1">
                          {staffInspectionAlerts.map((alert) => {
                            const tag =
                              alert.createdByCarerUid === staffMember.uid
                                ? 'Sent by worker'
                                : alert.escalationFrom === 'player'
                                  ? 'Player payout inquiry'
                                  : alert.escalationFrom === 'risk_auto'
                                    ? 'Risk system'
                                    : 'Linked payout inquiry';
                            return (
                              <div
                                key={alert.id}
                                className="rounded-lg border border-white/10 bg-black/40 p-2 text-[11px] text-neutral-200"
                              >
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <span className="font-semibold text-white">{tag}</span>
                                  <span className="text-neutral-500">
                                    {formatDateTime(alert.createdAt)}
                                  </span>
                                </div>
                                {alert.playerUsername ? (
                                  <p className="mt-1 text-[11px] text-cyan-100/85">
                                    Player hint: {alert.playerUsername}
                                  </p>
                                ) : null}
                                <p className="mt-1 whitespace-pre-wrap text-neutral-100">
                                  {alert.message}
                                </p>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                );
              }}
            />
          )}

          {activeView === 'create-carer' && (
            <div className="space-y-4">
              <div className="rounded-2xl border border-yellow-500/30 bg-yellow-500/10 p-4 text-sm text-yellow-100">
                Carer handles your tasks for you, but you need to pay them.
              </div>
              <CreateUserForm
                title="Hire Carer (Admin Approval)"
                buttonLabel="Send Hire Request"
                loadingLabel="Sending..."
                username={carerUsername}
                password={carerPassword}
                loading={loading}
                onUsernameChange={setCarerUsername}
                onPasswordChange={setCarerPassword}
                showPasswordInput={false}
                passwordRequired={false}
                onSubmit={handleCreateCarer}
              />
            </div>
          )}

          {activeView === 'view-carers' && (
            <UserManagementView<CarerUser>
              title="Carers"
              emptyText="No carers found."
              selectText="Select a carer to manage."
              deleteTitle="Delete carer?"
              deleteMessage="Are you sure you want to delete"
              users={sortedCarers}
              selectedUser={selectedCarer}
              deleteTarget={deleteCarerTarget}
              loadingList={loadingList}
              loading={loading}
              carersVisualTheme
              onSelectUser={setSelectedCarer}
              onSetDeleteTarget={setDeleteCarerTarget}
              onDelete={handleDeleteCarer}
              onToggleBlock={handleToggleCarerStatus}
              blocking={blocking}
              onCoadminSetUsername={handleCoadminSetCarerUsername}
              coadminCredentialsLoading={workerCredentialsLoading}
              onlineByUid={coadminOnlineByUid}
              nameMode="coadmin"
              renderSelectedExtras={(carer) => {
                const rechargeTotal = Math.round(
                  carerRechargeRedeemTotals[carer.uid]?.totalRechargeAmount || 0
                );
                const redeemTotal = Math.round(
                  carerRechargeRedeemTotals[carer.uid]?.totalRedeemAmount || 0
                );
                const redeemShare =
                  rechargeTotal > 0 ? redeemTotal / rechargeTotal : redeemTotal > 0 ? Infinity : 0;
                const showRedeemWarning =
                  redeemTotal > 0 && (rechargeTotal <= 0 || redeemShare > 0.5);

                return (
                  <div className="mt-5 space-y-4">
                    <div className="rounded-2xl border border-amber-500/30 bg-amber-950/25 p-5 shadow-[0_0_32px_-10px_rgba(234,179,8,0.2)]">
                      <h4 className="text-sm font-black uppercase tracking-wide text-amber-200/90">
                        Work details
                      </h4>
                      <p className="mt-1 text-xs text-amber-100/55">
                        Completed recharge & redeem totals (all time, from finished tasks).
                      </p>
                      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div className="rounded-xl border border-emerald-500/25 bg-emerald-950/35 p-4">
                          <p className="text-xs font-bold uppercase tracking-wide text-emerald-200/80">
                            Total recharged
                          </p>
                          <p className="mt-2 text-xl font-black text-emerald-100 sm:text-2xl">
                            {formatNprDisplay(rechargeTotal)}
                          </p>
                        </div>
                        <div className="rounded-xl border border-rose-500/25 bg-rose-950/35 p-4">
                          <p className="text-xs font-bold uppercase tracking-wide text-rose-200/80">
                            Total redeemed
                          </p>
                          <p className="mt-2 text-xl font-black text-rose-100 sm:text-2xl">
                            {formatNprDisplay(redeemTotal)}
                          </p>
                        </div>
                      </div>
                      {rechargeTotal > 0 && redeemTotal > 0 ? (
                        <p className="mt-3 text-xs text-amber-100/60">
                          Redeem vs recharge (amount):{' '}
                          <span className="font-semibold text-amber-200">
                            {Math.round((redeemTotal / rechargeTotal) * 100)}%
                          </span>{' '}
                          of recharge.
                        </p>
                      ) : null}
                      {showRedeemWarning ? (
                        <div
                          role="alert"
                          className="mt-4 rounded-xl border border-rose-500/45 bg-rose-950/50 p-4 text-sm leading-relaxed text-rose-50"
                        >
                          <p className="font-bold text-rose-200">⚠️ Redeem pattern notice</p>
                          <p className="mt-2">
                            This carer&apos;s redeem volume is high versus recharge. Their account
                            may be reviewed for legitimate redeems.
                          </p>
                        </div>
                      ) : null}
                    </div>

                    <div className="rounded-2xl border border-violet-500/30 bg-violet-950/25 p-5">
                      <p className="text-xs font-black uppercase tracking-wide text-violet-200/90">
                        Payment details
                      </p>
                      {carer.paymentDetails ? (
                        <p className="mt-2 text-sm text-violet-50/95">{carer.paymentDetails}</p>
                      ) : (
                        <p className="mt-2 text-sm text-violet-200/60">
                          No payment details added yet.
                        </p>
                      )}
                      {carer.paymentQrUrl ? (
                        <a
                          href={carer.paymentQrUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-3 inline-flex items-center gap-2 text-sm font-bold text-violet-200 hover:text-violet-100"
                        >
                          🔗 Open QR link
                        </a>
                      ) : null}
                    </div>
                  </div>
                );
              }}
            />
          )}

          {activeView === 'create-player' && (
            <CreateUserForm
              title="Create Player"
              buttonLabel="Create Player"
              loadingLabel="Creating..."
              username={playerUsername}
              password={playerPassword}
              referralCode={playerReferralCodeInput}
              onReferralCodeChange={setPlayerReferralCodeInput}
              showReferralCodeInput
              loading={loading}
              onUsernameChange={setPlayerUsername}
              onPasswordChange={setPlayerPassword}
              validatePlayerUsername
              onSubmit={handleCreatePlayer}
            />
          )}

          {activeView === 'view-players' && (
            <UserManagementView<PlayerUser>
              title="Players"
              emptyText="No players found."
              selectText="Select a player to manage."
              deleteTitle="Delete player?"
              deleteMessage="Are you sure you want to delete"
              users={sortedPlayers}
              selectedUser={selectedPlayer}
              deleteTarget={deletePlayerTarget}
              loadingList={loadingList}
              loading={loading}
              onSelectUser={setSelectedPlayer}
              onSetDeleteTarget={setDeletePlayerTarget}
              onDelete={handleDeletePlayer}
              onToggleBlock={handleTogglePlayerStatus}
              blocking={blocking}
              onCoadminSetPassword={handleCoadminSetPlayerPassword}
              coadminCredentialsLoading={workerCredentialsLoading}
              onlineByUid={coadminOnlineByUid}
              nameMode="coadmin"
              onGiveFreeplay={(player) => void handleGiveFreeplayToPlayer(player)}
              freeplayGiveBusyUid={freeplayGiveTargetUid}
              renderSelectedExtras={(user) => (
                <div className="mt-5 w-full max-w-6xl space-y-4">
                  <div className="rounded-2xl border border-emerald-500/20 bg-emerald-950/30 p-4">
                    <p className="text-xs font-bold uppercase tracking-wider text-emerald-200/80">
                      Coin balance
                    </p>
                    <p className="mt-1 text-2xl font-bold text-white tabular-nums">
                      {Math.max(0, Math.floor(Number(user.coin || 0))).toLocaleString()} coin
                    </p>
                    <p className="mt-1 text-sm text-neutral-400">
                      Total recharged:{' '}
                      <span className="font-semibold text-emerald-200">
                        {Math.max(
                          0,
                          Math.floor(Number(user.totalRechargeAmount || 0))
                        ).toLocaleString()}
                      </span>
                    </p>
                    <p className="mt-0.5 text-sm text-neutral-400">
                      Total redeemed:{' '}
                      <span className="font-semibold text-rose-200">
                        {Math.max(
                          0,
                          Math.floor(Number(user.totalRedeemAmount || 0))
                        ).toLocaleString()}
                      </span>
                    </p>
                    <p className="mt-0.5 text-sm text-neutral-400">
                      Total recharged by coadmin/load coin:{' '}
                      <span className="font-semibold text-emerald-200">
                        {selectedPlayerTotalsLoading
                          ? 'Loading...'
                          : Math.max(
                              0,
                              Math.floor(Number(selectedPlayerCoadminAddedCoinTotal || 0))
                            ).toLocaleString()}
                      </span>
                    </p>
                    <p className="mt-0.5 text-sm text-neutral-400">
                      Total amount cashed out:{' '}
                      <span className="font-semibold text-sky-200">
                        {selectedPlayerTotalsLoading
                          ? 'Loading...'
                          : Math.max(0, Math.floor(Number(selectedPlayerCashoutTotalAmount || 0))).toLocaleString()}
                      </span>
                    </p>
                    <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
                      <label className="min-w-0 flex-1 text-sm text-neutral-400">
                        Amount (coin)
                        <input
                          type="number"
                          min={1}
                          step={1}
                          inputMode="numeric"
                          value={playerCoinAmountInput}
                          onChange={(e) => setPlayerCoinAmountInput(e.target.value)}
                          disabled={playerCoinAdjustBusy}
                          placeholder="0"
                          className="mt-1 w-full rounded-xl border border-white/15 bg-black/40 px-3 py-2 text-white outline-none focus:border-emerald-500/50 disabled:opacity-50"
                        />
                      </label>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => void handleAdjustPlayerCoin(user, 'add')}
                          disabled={playerCoinAdjustBusy || blocking}
                          className="whitespace-nowrap rounded-xl bg-emerald-500 px-4 py-2.5 text-sm font-bold text-black hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {playerCoinAdjustBusy ? '...' : 'Add coin'}
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleAdjustPlayerCoin(user, 'deduct')}
                          disabled={playerCoinAdjustBusy || blocking}
                          className="whitespace-nowrap rounded-xl border border-rose-500/50 bg-rose-950/40 px-4 py-2.5 text-sm font-bold text-rose-100 hover:bg-rose-900/50 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {playerCoinAdjustBusy ? '...' : 'Deduct coin'}
                        </button>
                      </div>
                    </div>
                    <p className="mt-2 text-xs text-neutral-500">
                      Whole numbers only. Deductions cannot make coin go below zero.
                    </p>
                  </div>

                  <div className="rounded-2xl border border-sky-500/25 bg-sky-950/25 p-4">
                    <p className="text-xs font-bold uppercase tracking-wider text-sky-200/85">
                      Cash balance
                    </p>
                    <p className="mt-1 text-xl font-bold text-white tabular-nums">
                      {formatUsdFromNprDisplay(Math.max(0, Math.floor(Number(user.cash ?? 0))))}
                    </p>
                    <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
                      <label className="min-w-0 flex-1 text-sm text-neutral-400">
                        Amount (cash)
                        <input
                          type="number"
                          min={1}
                          step={1}
                          inputMode="numeric"
                          value={playerCashAmountInput}
                          onChange={(e) => setPlayerCashAmountInput(e.target.value)}
                          disabled={playerCashAdjustBusy}
                          placeholder="0"
                          className="mt-1 w-full rounded-xl border border-white/15 bg-black/40 px-3 py-2 text-white outline-none focus:border-sky-500/50 disabled:opacity-50"
                        />
                      </label>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => void handleAdjustPlayerCash(user, 'add')}
                          disabled={playerCashAdjustBusy || blocking}
                          className="whitespace-nowrap rounded-xl bg-sky-500 px-4 py-2.5 text-sm font-bold text-black hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {playerCashAdjustBusy ? '...' : 'Add cash'}
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleAdjustPlayerCash(user, 'deduct')}
                          disabled={playerCashAdjustBusy || blocking}
                          className="whitespace-nowrap rounded-xl border border-rose-500/50 bg-rose-950/40 px-4 py-2.5 text-sm font-bold text-rose-100 hover:bg-rose-900/50 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {playerCashAdjustBusy ? '...' : 'Deduct cash'}
                        </button>
                      </div>
                    </div>
                    <p className="mt-2 text-xs text-neutral-500">
                      Same increments as balances elsewhere (whole numbers). Deductions cannot make cash
                      go below zero.
                    </p>
                  </div>

                  <div className="rounded-2xl border border-white/10 bg-slate-950/40 p-4">
                    <div className="flex flex-wrap gap-2">
                      {(
                        [
                          ['coin-recharge', 'Coin Recharge'],
                          ['cashout', 'Cashout'],
                          ['coin-recharge-ingame', 'Coin Recharge In Game'],
                          ['redeem', 'Redeem'],
                        ] as Array<[PlayerRecordTab, string]>
                      ).map(([tabKey, label]) => {
                        const isActive = selectedPlayerRecordTab === tabKey;
                        return (
                          <button
                            key={tabKey}
                            type="button"
                            onClick={() => setSelectedPlayerRecordTab(tabKey)}
                            className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${
                              isActive
                                ? 'bg-cyan-400 text-slate-950'
                                : 'border border-white/10 bg-white/5 text-neutral-200 hover:bg-white/10'
                            }`}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>

                    <div className="mt-4 overflow-hidden rounded-2xl border border-white/10 bg-black/25">
                      <div className="overflow-x-auto">
                        <table className="min-w-full border-collapse text-sm">
                          <thead className="bg-white/10 text-left text-xs uppercase tracking-[0.2em] text-neutral-300">
                            <tr>
                              <th className="border-b border-white/10 px-4 py-3">SN</th>
                              <th className="border-b border-white/10 px-4 py-3">Date</th>
                              <th className="border-b border-white/10 px-4 py-3">Amount</th>
                              <th className="border-b border-white/10 px-4 py-3">Status</th>
                              <th className="border-b border-white/10 px-4 py-3">Source</th>
                              <th className="border-b border-white/10 px-4 py-3">Details</th>
                            </tr>
                          </thead>
                          <tbody>
                            {selectedPlayerRecordLoading ? (
                              <tr>
                                <td
                                  colSpan={6}
                                  className="px-4 py-8 text-center text-sm text-neutral-400"
                                >
                                  Loading records...
                                </td>
                              </tr>
                            ) : selectedPlayerTabVisibleRows.length === 0 ? (
                              <tr>
                                <td
                                  colSpan={6}
                                  className="px-4 py-8 text-center text-sm text-neutral-500"
                                >
                                  No records found in this section.
                                </td>
                              </tr>
                            ) : (
                              selectedPlayerTabVisibleRows.map((row, index) => (
                                <tr
                                  key={row.id}
                                  className="border-b border-white/5 text-neutral-100 even:bg-white/[0.03]"
                                >
                                  <td className="px-4 py-3 text-neutral-400">
                                    {(selectedPlayerTabPage - 1) * 30 + index + 1}
                                  </td>
                                  <td className="px-4 py-3 whitespace-nowrap">{row.dateLabel}</td>
                                  <td className="px-4 py-3 font-semibold">{row.amountLabel}</td>
                                  <td className="px-4 py-3">{row.statusLabel}</td>
                                  <td className="px-4 py-3">{row.sourceLabel}</td>
                                  <td className="px-4 py-3">{row.detailLabel}</td>
                                </tr>
                              ))
                            )}
                          </tbody>
                          {!selectedPlayerRecordLoading && selectedPlayerTabVisibleRows.length > 0 ? (
                            <tfoot className="bg-emerald-950/35">
                              <tr className="border-t border-emerald-400/20 text-emerald-100">
                                <td className="px-4 py-3 font-bold" colSpan={2}>
                                  Total
                                </td>
                                <td className="px-4 py-3 font-bold">
                                  {formatPlayerRecordAmount(
                                    selectedPlayerTabVisibleTotal,
                                    selectedPlayerRecordTab === 'cashout' ? 'cash' : 'coin'
                                  )}
                                </td>
                                <td className="px-4 py-3 text-sm text-emerald-200/80">
                                  Page {selectedPlayerTabPage}
                                </td>
                                <td className="px-4 py-3 text-sm text-emerald-200/80">
                                  {selectedPlayerTabVisibleRows.length} entries
                                </td>
                                <td className="px-4 py-3 text-sm text-emerald-200/80">
                                  Current page only
                                </td>
                              </tr>
                            </tfoot>
                          ) : null}
                        </table>
                      </div>
                    </div>

                    {!selectedPlayerRecordLoading && selectedPlayerTabPageCount > 1 ? (
                      <div className="mt-4 flex flex-wrap justify-center gap-2">
                        {Array.from({ length: selectedPlayerTabPageCount }, (_, index) => {
                          const pageNumber = index + 1;
                          const isActive = selectedPlayerTabPage === pageNumber;
                          return (
                            <button
                              key={pageNumber}
                              type="button"
                              onClick={() =>
                                setSelectedPlayerRecordPages((current) => ({
                                  ...current,
                                  [selectedPlayerRecordTab]: pageNumber,
                                }))
                              }
                              className={`h-10 min-w-10 rounded-lg px-3 text-sm font-bold transition ${
                                isActive
                                  ? 'bg-emerald-400 text-slate-950'
                                  : 'border border-white/10 bg-white/5 text-neutral-200 hover:bg-white/10'
                              }`}
                            >
                              {pageNumber}
                            </button>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>

                  <div className="rounded-2xl border border-rose-500/25 bg-rose-950/25 p-4">
                    <p className="text-xs font-bold uppercase tracking-wider text-rose-200/85">
                      Redeem limits by game
                    </p>
                    <p className="mt-1 text-sm text-neutral-400">
                      Reset is available only when this player is fully capped on a game&apos;s rolling
                      24-hour redeem limit.
                    </p>

                    {selectedPlayerRedeemLimitLoading ? (
                      <p className="mt-3 text-sm text-neutral-400">Loading redeem limits...</p>
                    ) : selectedPlayerRedeemLimitSummaries.length === 0 ? (
                      <p className="mt-3 text-sm text-neutral-400">
                        No game redeem activity or player game logins found yet.
                      </p>
                    ) : (
                      <div className="mt-3 space-y-3">
                        {selectedPlayerRedeemLimitSummaries.map((summary) => {
                          const isBusy = redeemLimitResetBusyGameName === summary.gameName;
                          const canReset = summary.onLimit && !isBusy && !blocking;

                          return (
                            <div
                              key={summary.gameName}
                              className="rounded-xl border border-white/10 bg-black/30 p-3"
                            >
                              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                <div className="min-w-0">
                                  <p className="font-semibold text-white">{summary.gameName}</p>
                                  <p className="mt-1 text-xs text-neutral-400">
                                    Used {summary.usedAmount} / {PLAYER_GAME_REDEEM_MAX_PER_24H} in
                                    the current rolling 24-hour window
                                  </p>
                                  <p className="mt-0.5 text-xs text-neutral-500">
                                    Remaining: {summary.remainingAmount}
                                  </p>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => void handleResetPlayerRedeemLimit(user, summary.gameName)}
                                  disabled={!canReset}
                                  className="whitespace-nowrap rounded-xl border border-rose-400/50 bg-rose-600 px-4 py-2 text-sm font-bold text-white hover:bg-rose-500 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-white/5 disabled:text-neutral-500"
                                >
                                  {isBusy ? 'Resetting...' : 'Reset limit'}
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}
            />
          )}

          {activeView === 'add-games' && (
            <div className="max-w-md">
              <h2 className="mb-6 text-3xl font-bold">Add Game</h2>

              <form
                onSubmit={handleCreateGame}
                className="space-y-4 rounded-2xl border border-white/10 bg-white/5 p-6"
              >
                <input
                  value={gameName}
                  onChange={(e) => setGameName(e.target.value)}
                  placeholder="Game Name"
                  className="w-full rounded-xl border border-white/10 bg-neutral-900 p-3 outline-none focus:border-white/30"
                  required
                />

                <input
                  value={gameUsername}
                  onChange={(e) => setGameUsername(e.target.value)}
                  placeholder="Username"
                  className="w-full rounded-xl border border-white/10 bg-neutral-900 p-3 outline-none focus:border-white/30"
                  required
                />

                <input
                  value={gamePassword}
                  onChange={(e) => setGamePassword(e.target.value)}
                  placeholder="Password"
                  className="w-full rounded-xl border border-white/10 bg-neutral-900 p-3 outline-none focus:border-white/30"
                  required
                />

                <label className="block text-sm text-neutral-300">
                  <span className="mb-2 block">Backend Link</span>
                  <input
                    value={gameBackendUrl}
                    onChange={(e) => setGameBackendUrl(e.target.value)}
                    placeholder="https://backend.example.com"
                    className="w-full rounded-xl border border-white/10 bg-neutral-900 p-3 outline-none focus:border-white/30"
                  />
                </label>

                <label className="block text-sm text-neutral-300">
                  <span className="mb-2 block">Frontend Download Link</span>
                  <input
                    value={gameFrontendUrl}
                    onChange={(e) => setGameFrontendUrl(e.target.value)}
                    placeholder="https://download.example.com"
                    className="w-full rounded-xl border border-white/10 bg-neutral-900 p-3 outline-none focus:border-white/30"
                  />
                </label>

                <button
                  disabled={loading}
                  className="w-full rounded-xl bg-white p-3 font-semibold text-black disabled:opacity-60"
                >
                  {loading ? 'Adding...' : 'Add Game'}
                </button>
              </form>
            </div>
          )}

          {activeView === 'game-list' && (
            <div>
              <h2 className="mb-6 text-3xl font-bold">Game List</h2>

              {loadingList ? (
                <p className="text-sm text-neutral-400">Loading...</p>
              ) : gameLogins.length === 0 ? (
                <p className="text-sm text-neutral-400">No games found.</p>
              ) : (
                <div className="space-y-4">
                  {gameLogins.map((game) => (
                    <div
                      key={game.id}
                      className="rounded-2xl border border-white/10 bg-white/5 p-5"
                    >
                      {editingGame?.id === game.id ? (
                        <form onSubmit={handleUpdateGame} className="space-y-3">
                          <input
                            value={editingGame.gameName}
                            onChange={(e) =>
                              setEditingGame({
                                ...editingGame,
                                gameName: e.target.value,
                              })
                            }
                            className="w-full rounded-xl border border-white/10 bg-neutral-900 p-3 outline-none focus:border-white/30"
                          />

                          <input
                            value={editingGame.username}
                            onChange={(e) =>
                              setEditingGame({
                                ...editingGame,
                                username: e.target.value,
                              })
                            }
                            className="w-full rounded-xl border border-white/10 bg-neutral-900 p-3 outline-none focus:border-white/30"
                          />

                          <input
                            value={editingGame.password}
                            onChange={(e) =>
                              setEditingGame({
                                ...editingGame,
                                password: e.target.value,
                              })
                            }
                            className="w-full rounded-xl border border-white/10 bg-neutral-900 p-3 outline-none focus:border-white/30"
                          />

                          <label className="block text-sm text-neutral-300">
                            <span className="mb-2 block">Backend Link</span>
                            <input
                              value={editingGame.backendUrl || editingGame.siteUrl || ''}
                              onChange={(e) =>
                                setEditingGame({
                                  ...editingGame,
                                  backendUrl: e.target.value,
                                })
                              }
                              placeholder="https://backend.example.com"
                              className="w-full rounded-xl border border-white/10 bg-neutral-900 p-3 outline-none focus:border-white/30"
                            />
                          </label>

                          <label className="block text-sm text-neutral-300">
                            <span className="mb-2 block">Frontend Download Link</span>
                            <input
                              value={editingGame.frontendUrl || ''}
                              onChange={(e) =>
                                setEditingGame({
                                  ...editingGame,
                                  frontendUrl: e.target.value,
                                })
                              }
                              placeholder="https://download.example.com"
                              className="w-full rounded-xl border border-white/10 bg-neutral-900 p-3 outline-none focus:border-white/30"
                            />
                          </label>

                          <div className="flex gap-3">
                            <button
                              disabled={loading}
                              className="rounded-xl bg-white px-4 py-2 font-semibold text-black disabled:opacity-60"
                            >
                              {loading ? 'Saving...' : 'Save'}
                            </button>

                            <button
                              type="button"
                              onClick={() => setEditingGame(null)}
                              className="rounded-xl bg-white/10 px-4 py-2 font-semibold text-white hover:bg-white/20"
                            >
                              Cancel
                            </button>
                          </div>
                        </form>
                      ) : (
                        <div className="flex items-start justify-between gap-4">
                          <div>
                            <h3 className="text-xl font-bold">{game.gameName}</h3>
                            <p className="mt-2 text-sm text-neutral-400">
                              Username:{' '}
                              <span className="text-white">{game.username}</span>
                            </p>
                            <p className="mt-1 text-sm text-neutral-400">
                              Password:{' '}
                              <span className="text-white">{game.password}</span>
                            </p>
                            <div className="mt-3 rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-3">
                              <p className="text-xs font-semibold uppercase tracking-wide text-cyan-200/80">
                                Backend Link
                              </p>
                              {game.backendUrl || game.siteUrl ? (
                                <a
                                  href={game.backendUrl || game.siteUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="mt-2 block break-all text-sm text-cyan-300 underline underline-offset-2 hover:text-cyan-200"
                                >
                                  {game.backendUrl || game.siteUrl}
                                </a>
                              ) : (
                                <p className="mt-2 text-sm text-white">Not set</p>
                              )}
                            </div>
                            <div className="mt-3 rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-3">
                              <p className="text-xs font-semibold uppercase tracking-wide text-cyan-200/80">
                                Frontend Download Link
                              </p>
                              {game.frontendUrl ? (
                                <a
                                  href={game.frontendUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="mt-2 block break-all text-sm text-cyan-300 underline underline-offset-2 hover:text-cyan-200"
                                >
                                  {game.frontendUrl}
                                </a>
                              ) : (
                                <p className="mt-2 text-sm text-white">Not set</p>
                              )}
                            </div>
                          </div>

                        <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-start">
                          <button
                            type="button"
                            onClick={() => setEditingGame(game)}
                            disabled={Boolean(gameListDeletingId)}
                            className="rounded-xl bg-white px-4 py-2 text-sm font-semibold text-black hover:bg-neutral-200 disabled:opacity-50"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDeleteGame(game)}
                            disabled={Boolean(gameListDeletingId)}
                            className="rounded-xl border border-rose-500/50 bg-rose-500/15 px-4 py-2 text-sm font-semibold text-rose-100 hover:bg-rose-500/25 disabled:opacity-50"
                          >
                            {gameListDeletingId === game.id ? 'Deleting…' : 'Delete game'}
                          </button>
                        </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeView === 'payment-details' && (
            <div>
              <h2 className="text-2xl font-bold">Payment details — reference photos</h2>
              <p className="mt-2 max-w-2xl text-sm text-neutral-400">
                Upload one or more images (QR codes, bank apps, e-wallet screenshots). When a
                player taps <span className="text-neutral-200">Load coin</span> and then{' '}
                <span className="text-neutral-200">Add coins</span>, they see{' '}
                <strong>one image chosen at random</strong> and use their Royal VIP username as the
                payment note/remark during the 10-minute session.
              </p>

              <div className="mt-6 rounded-2xl border border-cyan-500/25 bg-black/30 p-5">
                <label className="block">
                  <span className="text-sm font-semibold text-cyan-100/90">
                    Add photos
                  </span>
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    disabled={paymentDetailUploading}
                    onChange={(e) => {
                      void handleAddPaymentDetailPhotos(e.target.files);
                      e.target.value = '';
                    }}
                    className="mt-2 block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-cyan-500/20 file:px-4 file:py-2 file:font-semibold file:text-cyan-100"
                  />
                </label>
                <div className="mt-4">
                  <ImageUploadField
                    label="Quick single upload"
                    autoUpload
                    onUploaded={(uploaded) => {
                      const uid = auth.currentUser?.uid;
                      if (!uid) {
                        return;
                      }
                      const next = [
                        ...paymentDetailPhotos,
                        {
                          imageUrl: uploaded.url,
                          imagePublicId: uploaded.publicId,
                        },
                      ];
                      void setCoadminPaymentDetailPhotos(uid, next)
                        .then(async () => {
                          const refreshed = await getCoadminPaymentDetailPhotos(uid);
                          setPaymentDetailPhotos(refreshed);
                          setMessage('Image uploaded successfully.');
                        })
                        .catch((err) =>
                          setMessage(
                            err instanceof Error
                              ? err.message
                              : 'Image upload failed. Please try again.'
                          )
                        );
                    }}
                    onError={(err) => setMessage(err)}
                  />
                </div>
                {paymentDetailUploading ? (
                  <p className="mt-3 text-sm text-amber-200/90">Uploading…</p>
                ) : null}
              </div>

              <div className="mt-6">
                {loadingPaymentDetailPhotos ? (
                  <p className="text-sm text-neutral-500">Loading…</p>
                ) : paymentDetailPhotos.length === 0 ? (
                  <p className="text-sm text-neutral-500">No reference photos yet.</p>
                ) : (
                  <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {paymentDetailPhotos.map((photo, index) => (
                      <li
                        key={photo.id || `${photo.imagePublicId || 'photo'}-${index}`}
                        className="overflow-hidden rounded-2xl border border-white/10 bg-black/40"
                      >
                        <div className="relative aspect-[4/3] w-full">
                          <img
                            src={photo.imageUrl}
                            alt={`Payment reference ${index + 1}`}
                            loading="lazy"
                            className="h-full w-full object-contain"
                          />
                        </div>
                        <div className="flex items-center justify-between gap-2 p-2">
                          <span className="text-xs text-neutral-500">#{index + 1}</span>
                          <button
                            type="button"
                            disabled={paymentDetailUploading}
                            onClick={() => void handleRemovePaymentDetailPhoto(index)}
                            className="rounded-lg bg-rose-500/20 px-3 py-1.5 text-xs font-semibold text-rose-200 hover:bg-rose-500/30 disabled:opacity-50"
                          >
                            Remove
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}

          {activeView === 'listener-details' && (
            <div>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="text-2xl font-bold">Listener Details</h2>
                  <p className="mt-2 max-w-2xl text-sm text-neutral-400">
                    Mailbox listeners saved for the payment agent runtime.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleAddPaymentListener}
                  className="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-bold text-black hover:bg-cyan-400"
                >
                  Add Listener
                </button>
              </div>

              {showPaymentListenerForm && (
                <div className="mt-6 rounded-2xl border border-cyan-500/25 bg-black/30 p-5">
                  <div className="flex flex-wrap gap-2">
                    {(['gmail', 'outlook'] as PaymentListenerProvider[]).map((provider) => (
                      <button
                        key={provider}
                        type="button"
                        onClick={() => handlePaymentListenerProviderChange(provider)}
                        className={`rounded-lg px-4 py-2 text-sm font-semibold ${
                          paymentListenerForm.provider === provider
                            ? 'bg-cyan-500 text-black'
                            : 'bg-white/10 text-neutral-200 hover:bg-white/15'
                        }`}
                      >
                        {provider === 'gmail' ? 'Gmail' : 'Outlook'}
                      </button>
                    ))}
                  </div>

                  <div className="mt-5 grid gap-4 md:grid-cols-2">
                    <label className="block">
                      <span className="text-xs font-semibold uppercase text-neutral-400">
                        Listener label
                      </span>
                      <input
                        value={paymentListenerForm.label}
                        onChange={(event) =>
                          setPaymentListenerForm((current) => ({
                            ...current,
                            label: event.target.value,
                          }))
                        }
                        className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white"
                      />
                    </label>
                    <label className="block">
                      <span className="text-xs font-semibold uppercase text-neutral-400">
                        {paymentListenerForm.provider === 'gmail'
                          ? 'Gmail address'
                          : 'Outlook email'}
                      </span>
                      <input
                        type="email"
                        value={paymentListenerForm.email}
                        onChange={(event) =>
                          setPaymentListenerForm((current) => ({
                            ...current,
                            email: event.target.value,
                          }))
                        }
                        className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white"
                      />
                    </label>
                    <label className="block">
                      <span className="text-xs font-semibold uppercase text-neutral-400">
                        {paymentListenerForm.provider === 'gmail'
                          ? 'App password'
                          : 'Password / App Password'}
                      </span>
                      <input
                        type="password"
                        value={paymentListenerForm.password}
                        placeholder={
                          paymentListenerForm.id ? 'Leave blank to keep existing password' : ''
                        }
                        onChange={(event) =>
                          setPaymentListenerForm((current) => ({
                            ...current,
                            password: event.target.value,
                          }))
                        }
                        className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white"
                      />
                    </label>
                    <label className="block">
                      <span className="text-xs font-semibold uppercase text-neutral-400">
                        IMAP host
                      </span>
                      <input
                        value={paymentListenerForm.imapHost}
                        onChange={(event) =>
                          setPaymentListenerForm((current) => ({
                            ...current,
                            imapHost: event.target.value,
                          }))
                        }
                        className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white"
                      />
                    </label>
                    <label className="block">
                      <span className="text-xs font-semibold uppercase text-neutral-400">
                        IMAP port
                      </span>
                      <input
                        type="number"
                        min={1}
                        max={65535}
                        value={paymentListenerForm.imapPort}
                        onChange={(event) =>
                          setPaymentListenerForm((current) => ({
                            ...current,
                            imapPort: event.target.value,
                          }))
                        }
                        className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white"
                      />
                    </label>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                      {[
                        ['useSsl', 'Use SSL'],
                        ['autoLoad', 'Auto-load'],
                        ['enabled', 'Enabled'],
                      ].map(([key, label]) => (
                        <label
                          key={key}
                          className="flex items-center gap-2 rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-neutral-200"
                        >
                          <input
                            type="checkbox"
                            checked={Boolean(
                              paymentListenerForm[key as 'useSsl' | 'autoLoad' | 'enabled']
                            )}
                            onChange={(event) =>
                              setPaymentListenerForm((current) => ({
                                ...current,
                                [key]: event.target.checked,
                              }))
                            }
                          />
                          {label}
                        </label>
                      ))}
                    </div>
                  </div>

                  <div className="mt-5 flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={paymentListenerSaving}
                      onClick={() => void handleSavePaymentListener()}
                      className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-bold text-black hover:bg-emerald-400 disabled:opacity-60"
                    >
                      {paymentListenerSaving ? 'Saving...' : 'Save Listener'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowPaymentListenerForm(false);
                        setPaymentListenerForm(buildPaymentListenerForm('gmail'));
                      }}
                      className="rounded-lg bg-white/10 px-4 py-2 text-sm font-semibold text-neutral-200 hover:bg-white/15"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              <div className="mt-6 overflow-x-auto rounded-2xl border border-white/10 bg-black/30">
                <table className="min-w-full divide-y divide-white/10 text-sm">
                  <thead className="bg-white/5 text-left text-xs uppercase text-neutral-400">
                    <tr>
                      <th className="px-3 py-3">Label</th>
                      <th className="px-3 py-3">Provider</th>
                      <th className="px-3 py-3">Email</th>
                      <th className="px-3 py-3">Enabled</th>
                      <th className="px-3 py-3">Auto-load</th>
                      <th className="px-3 py-3">Last checked</th>
                      <th className="px-3 py-3">Last error</th>
                      <th className="px-3 py-3">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/10">
                    {paymentListenersLoading ? (
                      <tr>
                        <td className="px-3 py-4 text-neutral-400" colSpan={8}>
                          Loading...
                        </td>
                      </tr>
                    ) : paymentListeners.length === 0 ? (
                      <tr>
                        <td className="px-3 py-4 text-neutral-400" colSpan={8}>
                          No listeners saved yet.
                        </td>
                      </tr>
                    ) : (
                      paymentListeners.map((listener) => (
                        <tr key={listener.id} className="align-top">
                          <td className="px-3 py-3 font-semibold text-white">{listener.label}</td>
                          <td className="px-3 py-3 capitalize text-neutral-200">
                            {listener.provider}
                            {listener.provider === 'outlook' && listener.authType === 'oauth' && (
                              <span className="ml-2 rounded-full bg-cyan-500/15 px-2 py-0.5 text-[11px] font-semibold uppercase text-cyan-100">
                                OAuth
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-3 text-neutral-200">{listener.email}</td>
                          <td className="px-3 py-3">
                            <span
                              className={`rounded-full px-2 py-1 text-xs font-semibold ${
                                listener.enabled
                                  ? 'bg-emerald-500/15 text-emerald-200'
                                  : 'bg-neutral-500/15 text-neutral-300'
                              }`}
                            >
                              {listener.enabled ? 'Enabled' : 'Disabled'}
                            </span>
                          </td>
                          <td className="px-3 py-3 text-neutral-200">
                            {listener.autoLoad ? 'On' : 'Off'}
                          </td>
                          <td className="px-3 py-3 text-neutral-300">
                            {listener.lastCheckedAt
                              ? new Date(listener.lastCheckedAt).toLocaleString()
                              : 'Never'}
                          </td>
                          <td className="max-w-xs px-3 py-3 text-rose-200">
                            {listener.lastError || '-'}
                          </td>
                          <td className="px-3 py-3">
                            <div className="flex flex-wrap gap-2">
                              <button
                                type="button"
                                disabled={paymentListenerTestingId === listener.id}
                                onClick={() => void handleTestPaymentListener(listener)}
                                className="rounded-lg bg-cyan-500/20 px-3 py-1.5 text-xs font-semibold text-cyan-100 hover:bg-cyan-500/30 disabled:opacity-50"
                              >
                                {paymentListenerTestingId === listener.id
                                  ? 'Testing...'
                                  : 'Test Connection'}
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleTogglePaymentListener(listener)}
                                className="rounded-lg bg-white/10 px-3 py-1.5 text-xs font-semibold text-neutral-200 hover:bg-white/15"
                              >
                                {listener.enabled ? 'Disable' : 'Enable'}
                              </button>
                              <button
                                type="button"
                                onClick={() => handleEditPaymentListener(listener)}
                                className="rounded-lg bg-white/10 px-3 py-1.5 text-xs font-semibold text-neutral-200 hover:bg-white/15"
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                disabled={paymentListenerDeletingId === listener.id}
                                onClick={() => void handleDeletePaymentListener(listener)}
                                className="rounded-lg bg-rose-500/20 px-3 py-1.5 text-xs font-semibold text-rose-200 hover:bg-rose-500/30 disabled:opacity-50"
                              >
                                Delete
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {activeView === 'shifts' && (
            <div>
              <h2 className="text-2xl font-bold">Shifts</h2>
              <p className="mt-2 text-sm text-neutral-400">
                Live login/logout status for staff and carers, total worked hours in last 24 hours,
                and reward cut controls.
              </p>

              <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {shiftsRows.map((row) => (
                  <article
                    key={`${row.role}:${row.uid}`}
                    className="rounded-2xl border border-white/10 bg-black/30 p-4"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-base font-semibold text-white">
                          {row.role === 'staff' ? 'Staff' : 'Carer'} Account
                        </p>
                        <p className="text-xs uppercase tracking-wide text-neutral-500">
                          {row.username || 'User'}
                        </p>
                      </div>
                      <span
                        className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                          row.isActive
                            ? 'bg-emerald-500/20 text-emerald-200'
                            : 'bg-neutral-700/50 text-neutral-200'
                        }`}
                      >
                        {row.isActive ? 'Logged in' : 'Logged out'}
                      </span>
                    </div>

                    <dl className="mt-3 space-y-1 text-sm text-neutral-300">
                      <div className="flex justify-between gap-3">
                        <dt>Last login</dt>
                        <dd className="text-right">{formatDateTime(row.latestLoginAt)}</dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt>Last logout</dt>
                        <dd className="text-right">{formatDateTime(row.latestLogoutAt)}</dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt>Last seen</dt>
                        <dd className="text-right">{formatDateTime(row.lastSeenAt)}</dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt>Worked (24h)</dt>
                        <dd className="text-right font-semibold text-cyan-200">
                          {formatHours(row.workedHoursLast24h)}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt>Current reward</dt>
                        <dd className="text-right font-semibold text-amber-200">
                          {formatNprDisplay(row.cashBoxNpr)}
                        </dd>
                      </div>
                    </dl>

                    <div className="mt-4 rounded-xl border border-rose-500/25 bg-rose-500/5 p-3">
                      <p className="text-xs font-semibold uppercase tracking-wide text-rose-200/90">
                        Cut reward
                      </p>
                      <input
                        type="number"
                        min={1}
                        value={rewardCutAmountByUid[row.uid] || ''}
                        onChange={(e) =>
                          setRewardCutAmountByUid((prev) => ({
                            ...prev,
                            [row.uid]: e.target.value,
                          }))
                        }
                        placeholder="Amount (NPR)"
                        className="mt-2 w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none ring-cyan-400/40 placeholder:text-neutral-500 focus:ring-2"
                      />
                      <input
                        type="text"
                        value={rewardCutReasonByUid[row.uid] || ''}
                        onChange={(e) =>
                          setRewardCutReasonByUid((prev) => ({
                            ...prev,
                            [row.uid]: e.target.value,
                          }))
                        }
                        placeholder="Reason (optional)"
                        className="mt-2 w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none ring-cyan-400/40 placeholder:text-neutral-500 focus:ring-2"
                      />
                      <button
                        type="button"
                        disabled={rewardCutBusyUid === row.uid}
                        onClick={() =>
                          void handleCutRewardForWorker({
                            uid: row.uid,
                            username: row.username,
                            role: row.role,
                          })
                        }
                        className="mt-2 min-h-[44px] w-full rounded-xl bg-rose-500 px-3 py-2 text-sm font-semibold text-white hover:bg-rose-400 disabled:opacity-60"
                      >
                        {rewardCutBusyUid === row.uid ? 'Applying…' : 'Apply Cut'}
                      </button>
                    </div>
                  </article>
                ))}
              </div>

              {shiftsRows.length === 0 && (
                <p className="mt-6 text-sm text-neutral-500">No staff or carer accounts found.</p>
              )}
            </div>
          )}

          {activeView === 'behaviours' && (
            <div className="space-y-6">
              <div className="rounded-2xl border border-rose-500/25 bg-rose-500/10 p-4">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-lg font-bold text-rose-100">Top Risky Staff</h3>
                  <p className="text-xs uppercase tracking-wide text-rose-100/80">
                    Quick view (highest risk score)
                  </p>
                </div>
                <div className="mt-3 grid gap-3 md:grid-cols-3">
                  {staffBehaviours
                    .slice()
                    .sort(
                      (left, right) =>
                        right.staffRiskSummary.riskScore - left.staffRiskSummary.riskScore
                    )
                    .slice(0, 3)
                    .map((row) => (
                      <div
                        key={row.staff.staffId}
                        className="rounded-xl border border-white/15 bg-black/25 p-3 text-left hover:bg-black/35"
                      >
                        <p className="text-sm font-semibold text-white">{row.staff.name}</p>
                        <p className="text-xs text-neutral-300">ID: {row.staff.staffId}</p>
                        <p className="text-xs text-neutral-300">Username: {row.staff.name}</p>
                        <p className="mt-2 text-xs text-rose-100">
                          Risk: {row.staffRiskSummary.riskScore} ({row.staffRiskSummary.riskLevel})
                        </p>
                        <p className="text-xs text-neutral-300">
                          Pending reviews: {row.playerRiskPatterns.pendingReviewCashouts}
                        </p>
                        <p className="text-xs text-neutral-300">
                          Bonus blocked players: {row.playerRiskPatterns.bonusBlockedPlayers}
                        </p>
                        <p className="text-xs text-neutral-300">
                          Reward status: {row.staff.rewardBlocked ? 'blocked' : 'active'}
                        </p>
                        <p className="mt-1 text-xs text-cyan-200">
                          Cashouts trend: {trendBadge(row.cashoutActivity.cashoutsToday, row.cashoutActivity.cashoutsYesterday)}
                        </p>
                        <p className="text-xs text-cyan-200">
                          Players trend: {trendBadge(row.accountCreation.playersCreatedToday, row.accountCreation.playersCreatedYesterday)}
                        </p>
                        <div className="mt-2 flex gap-2">
                          <button
                            type="button"
                            onClick={() => setSelectedBehaviourStaffId(row.staff.staffId)}
                            className="rounded-lg border border-cyan-300/30 bg-cyan-500/10 px-2 py-1 text-xs font-semibold text-cyan-200 hover:bg-cyan-500/20"
                          >
                            View details
                          </button>
                          <button
                            type="button"
                            disabled={workerCredentialsLoading}
                            onClick={() => void handleLoginAsStaffFromBehaviour(row.staff.staffId)}
                            className="rounded-lg border border-amber-300/35 bg-amber-500/10 px-2 py-1 text-xs font-semibold text-amber-100 hover:bg-amber-500/20 disabled:opacity-60"
                          >
                            {workerCredentialsLoading ? 'Switching...' : 'Login as Staff'}
                          </button>
                        </div>
                      </div>
                    ))}
                  {staffBehaviours.length === 0 && (
                    <p className="text-sm text-neutral-300">No staff behaviour data available yet.</p>
                  )}
                </div>
              </div>

              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-2xl font-bold text-white">Staff Behaviours</h2>
                  <p className="text-sm text-neutral-400">
                    Monitoring dashboard only. No automatic blocking is applied here.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void loadStaffBehaviours()}
                  disabled={behavioursLoading}
                  className="rounded-xl border border-white/15 bg-white/5 px-4 py-2 text-sm font-semibold text-white hover:bg-white/10 disabled:opacity-60"
                >
                  {behavioursLoading ? 'Refreshing…' : 'Refresh'}
                </button>
              </div>

              <div className="overflow-x-auto rounded-2xl border border-white/10 bg-white/5">
                <table className="min-w-full text-sm">
                  <thead className="bg-black/30 text-left text-xs uppercase tracking-wide text-neutral-300">
                    <tr>
                      <th className="px-3 py-3">Staff name</th>
                      <th className="px-3 py-3">Players created</th>
                      <th className="px-3 py-3">Cashouts handled</th>
                      <th className="px-3 py-3">Total cashout amount</th>
                      <th className="px-3 py-3">Pending reviews</th>
                      <th className="px-3 py-3">Bonus blocked players</th>
                      <th className="px-3 py-3">Risk score</th>
                      <th className="px-3 py-3">Risk level</th>
                      <th className="px-3 py-3 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {staffBehaviours.map((row) => (
                      <tr key={row.staff.staffId} className="border-t border-white/10 text-neutral-200">
                        <td className="px-3 py-3 font-semibold">{row.staff.name}</td>
                        <td className="px-3 py-3">{row.accountCreation.totalPlayersCreated}</td>
                        <td className="px-3 py-3">{row.cashoutActivity.totalCashoutRequestsHandled}</td>
                        <td className="px-3 py-3">{formatNprDisplay(row.cashoutActivity.totalCashoutAmountHandled)}</td>
                        <td className="px-3 py-3">{row.playerRiskPatterns.pendingReviewCashouts}</td>
                        <td className="px-3 py-3">{row.playerRiskPatterns.bonusBlockedPlayers}</td>
                        <td className="px-3 py-3">{row.staffRiskSummary.riskScore}</td>
                        <td className="px-3 py-3 uppercase">{row.staffRiskSummary.riskLevel}</td>
                        <td className="px-3 py-3 text-right">
                          <div className="flex justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => setSelectedBehaviourStaffId(row.staff.staffId)}
                              className="rounded-lg border border-cyan-300/30 bg-cyan-500/10 px-3 py-1.5 text-xs font-semibold text-cyan-200 hover:bg-cyan-500/20"
                            >
                              View details
                            </button>
                            <button
                              type="button"
                              disabled={rewardBlockBusyStaffId === row.staff.staffId}
                              onClick={() => void handleToggleStaffRewardBlock(row)}
                              className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${
                                row.staff.rewardBlocked
                                  ? 'border border-emerald-400/35 bg-emerald-500/10 text-emerald-100 hover:bg-emerald-500/20'
                                  : 'border border-rose-400/35 bg-rose-500/10 text-rose-100 hover:bg-rose-500/20'
                              } disabled:opacity-60`}
                            >
                              {rewardBlockBusyStaffId === row.staff.staffId
                                ? 'Saving...'
                                : row.staff.rewardBlocked
                                ? 'Unblock reward'
                                : 'Block reward'}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {staffBehaviours.length === 0 && (
                      <tr>
                        <td colSpan={9} className="px-3 py-6 text-center text-neutral-400">
                          {behavioursLoading ? 'Loading staff behaviours…' : 'No staff behaviour data found.'}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {selectedBehaviour && (
                <div className="grid gap-4 lg:grid-cols-2">
                  <article className="rounded-2xl border border-white/10 bg-white/5 p-4">
                    <h3 className="text-lg font-bold text-white">Staff Summary</h3>
                    <p className="mt-1 text-sm text-neutral-300">
                      {selectedBehaviour.staff.name} ({selectedBehaviour.staff.role}) · Joined:{' '}
                      {formatDateTime(selectedBehaviour.staff.createdAt || null)}
                    </p>
                    <p className="mt-1 text-xs text-neutral-400">
                      Login username: {selectedBehaviour.staff.name}
                    </p>
                    <div className="mt-2">
                      <button
                        type="button"
                        disabled={workerCredentialsLoading}
                        onClick={() => void handleLoginAsStaffFromBehaviour(selectedBehaviour.staff.staffId)}
                        className="rounded-lg border border-amber-300/35 bg-amber-500/10 px-3 py-1.5 text-xs font-semibold text-amber-100 hover:bg-amber-500/20 disabled:opacity-60"
                      >
                        {workerCredentialsLoading ? 'Switching account...' : 'Login as This Staff'}
                      </button>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2 text-sm text-neutral-200">
                      <p>Players today: {selectedBehaviour.accountCreation.playersCreatedToday}</p>
                      <p>Players yesterday: {selectedBehaviour.accountCreation.playersCreatedYesterday}</p>
                      <p>Players last 7d: {selectedBehaviour.accountCreation.playersCreatedLast7d}</p>
                      <p>Cashouts today: {selectedBehaviour.cashoutActivity.cashoutsToday}</p>
                      <p>Cashouts yesterday: {selectedBehaviour.cashoutActivity.cashoutsYesterday}</p>
                      <p>Cashouts last 7d: {selectedBehaviour.cashoutActivity.cashoutsLast7d}</p>
                      <p>
                        Avg cashout:{' '}
                        {formatNprDisplay(selectedBehaviour.cashoutActivity.averageCashoutAmount)}
                      </p>
                      <p>Risk score: {selectedBehaviour.staffRiskSummary.riskScore}</p>
                      <p>
                        Daily trend:{' '}
                        {trendBadge(
                          selectedBehaviour.cashoutActivity.cashoutsToday,
                          selectedBehaviour.cashoutActivity.cashoutsYesterday
                        )}
                      </p>
                      <p>
                        Player trend:{' '}
                        {trendBadge(
                          selectedBehaviour.accountCreation.playersCreatedToday,
                          selectedBehaviour.accountCreation.playersCreatedYesterday
                        )}
                      </p>
                    </div>
                    <div className="mt-3">
                      <p className="text-xs uppercase tracking-wide text-neutral-400">Flags</p>
                      <ul className="mt-1 space-y-1 text-sm text-amber-200">
                        {selectedBehaviour.staffRiskSummary.riskFlags.map((flag) => (
                          <li key={flag}>- {flag}</li>
                        ))}
                        {selectedBehaviour.staffRiskSummary.riskFlags.length === 0 && (
                          <li className="text-neutral-400">- No high-risk flags detected.</li>
                        )}
                      </ul>
                    </div>
                  </article>

                  <article className="rounded-2xl border border-white/10 bg-white/5 p-4">
                    <h3 className="text-lg font-bold text-white">Players Created</h3>
                    <div className="mt-2 max-h-64 space-y-2 overflow-auto">
                      {selectedBehaviour.details.playersCreated.map((player) => (
                        <div key={player.playerId} className="rounded-xl border border-white/10 bg-black/20 p-3">
                          <p className="text-sm font-semibold text-white">{player.username}</p>
                          <p className="text-xs text-neutral-400">ID: {player.playerId}</p>
                          <p className="text-xs text-neutral-400">Created: {formatDateTime(player.createdAt || null)}</p>
                          {player.bonusBlocked && (
                            <p className="text-xs font-semibold text-rose-200">bonusBlocked = true</p>
                          )}
                        </div>
                      ))}
                      {selectedBehaviour.details.playersCreated.length === 0 && (
                        <p className="text-sm text-neutral-500">No players linked to this staff yet.</p>
                      )}
                    </div>
                  </article>

                  <article className="rounded-2xl border border-white/10 bg-white/5 p-4">
                    <h3 className="text-lg font-bold text-white">Recent Cashouts Handled</h3>
                    <div className="mt-2 max-h-64 space-y-2 overflow-auto">
                      {selectedBehaviour.details.recentCashoutsHandled.map((cashout) => (
                        <div key={cashout.cashoutId} className="rounded-xl border border-white/10 bg-black/20 p-3">
                          <p className="text-sm font-semibold text-white">{formatNprDisplay(cashout.amount)}</p>
                          <p className="text-xs text-neutral-400">Player: {cashout.playerId}</p>
                          <p className="text-xs text-neutral-400">Status: {cashout.status}</p>
                          <p className="text-xs text-neutral-400">Time: {formatDateTime(cashout.completedAt || cashout.createdAt || null)}</p>
                        </div>
                      ))}
                      {selectedBehaviour.details.recentCashoutsHandled.length === 0 && (
                        <p className="text-sm text-neutral-500">No completed cashouts handled yet.</p>
                      )}
                    </div>
                  </article>

                  <article className="rounded-2xl border border-white/10 bg-white/5 p-4">
                    <h3 className="text-lg font-bold text-white">Risky Players & Pending Reviews</h3>
                    <div className="mt-2 max-h-64 space-y-2 overflow-auto">
                      {selectedBehaviour.details.riskyPlayers.map((player) => (
                        <div key={player.playerId} className="rounded-xl border border-white/10 bg-black/20 p-3">
                          <p className="text-sm font-semibold text-white">{player.username}</p>
                          <p className="text-xs text-neutral-400">Player: {player.playerId}</p>
                          <p className="text-xs text-neutral-300">{player.flags.join(' | ')}</p>
                        </div>
                      ))}
                      {selectedBehaviour.details.pendingReviewCashouts.map((entry) => (
                        <div key={entry.requestId} className="rounded-xl border border-amber-400/25 bg-amber-500/10 p-3">
                          <p className="text-sm font-semibold text-amber-100">
                            Pending review: {formatNprDisplay(entry.amount)}
                          </p>
                          <p className="text-xs text-amber-100/80">Player: {entry.playerId}</p>
                          <p className="text-xs text-amber-100/80">Reason: {entry.reason}</p>
                          <p className="text-xs text-amber-100/70">Time: {formatDateTime(entry.createdAt || null)}</p>
                        </div>
                      ))}
                      {selectedBehaviour.details.riskyPlayers.length === 0 &&
                        selectedBehaviour.details.pendingReviewCashouts.length === 0 && (
                          <p className="text-sm text-neutral-500">No risky records found for this staff.</p>
                        )}
                    </div>
                  </article>
                </div>
              )}
            </div>
          )}

          {activeView === 'reach-out' && (
            <ReachOutView
              chatUsers={chatUsers}
              selectedChatUser={reachOutChatUser}
              messages={messages}
              newMessage={newMessage}
              unreadCounts={unreadCounts}
              imagePreview={imagePreview}
              sendingImage={sendingImage}
              messagesScrollRef={coadminChatScrollRef}
              hasMoreOlderMessages={pagedCoadminChat.hasMoreOlder}
              loadingOlderMessages={pagedCoadminChat.loadingOlder}
              onLoadOlderMessages={pagedCoadminChat.loadOlder}
              onSelectUser={handleReachOutUserSelect}
              onMessageChange={setNewMessage}
              onSendMessage={handleSendMessage}
              onImageSelect={handleImageSelect}
              onClearImage={handleClearImage}
              onlineByUid={coadminOnlineByUid}
              nameMode="coadmin"
            />
          )}
      </RoleSidebarLayout>

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
                Player: {latestCarerEscalation.playerUsername} / {latestCarerEscalation.gameName}
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
