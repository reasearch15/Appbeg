'use client';

import '../../styles/player-fire.css';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, MouseEvent, SetStateAction, TouchEvent } from 'react';
import { flushSync } from 'react-dom';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowRight, Zap } from 'lucide-react';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { doc, getDoc, onSnapshot, updateDoc } from 'firebase/firestore';


import ImageUploadField from '@/components/common/ImageUploadField';

import { auth, db } from '@/lib/firebase/client';
import { resolveCoadminUid } from '@/lib/coadmin/scope';
import { getLocalAppSessionId } from '@/features/auth/appSession';
import { getCachedSessionUser, getSessionUserOnce } from '@/features/auth/sessionUser';
import { useIsPlayerSessionRole } from '@/features/player/useIsPlayerSessionRole';
import { resolvePlayerRoleForFetch } from '@/lib/client/playerFetchGuard';
import { playerDebugLog, playerDevLog, playerStartupDebugLog } from '@/lib/client/playerDebugLogs';
import {
  peekPlayerFetchLifecycleReason,
  readSnapshotReasonFromFetchUrl,
} from '@/lib/client/playerFetchLifecycleContext';
import { startPlayerRequestSummaryReporter } from '@/lib/client/playerRequestSummary';
import { getGameLoginsByCoadmin } from '@/features/games/gameLogins';
import {
  getPlayerGameLoginsByPlayer,
  listenToPlayerGameLoginsByPlayer,
  type PlayerGameLogin,
} from '@/features/games/playerGameLogins';
import {
  createPlayerGameRequest,
  dismissPlayerRedeemRequest,
  listenToPlayerGameRequestsByPlayer,
  MAX_REDEEM_AMOUNT,
  MIN_REDEEM_AMOUNT,
  PLAYER_GAME_REDEEM_MAX_PER_24H,
  PlayerGameRequest,
} from '@/features/games/playerGameRequests';
import { attachPlayerRequestLiveShadowCompare } from '@/features/live/playerRequestShadowCompare';
import {
  attachPlayerRequestSqlReadListener,
  fakeRedeemDismissSplashMessage,
  playerInGameDismissSplashMessage,
  PLAYER_RECHARGE_SENT_MESSAGE,
  PLAYER_RECHARGE_SUCCESS_MESSAGE,
  PLAYER_REDEEM_SENT_MESSAGE,
  PLAYER_REDEEM_SUCCESS_MESSAGE,
  PLAYER_REQUESTS_SQL_READ_ENABLED,
  requestMatchesFakeRedeemDismiss,
  requestMatchesPlayerInGameDismiss,
  type PlayerFreeplayGivenLiveEvent,
  type PlayerRechargeDismissLiveEvent,
  type PlayerRechargeSuccessLiveEvent,
  type PlayerRedeemDismissLiveEvent,
  type PlayerRequestOutcomeLiveEvent,
} from '@/features/live/playerRequestSqlRead';
import {
  PLAYER_AGENT_CHAT_RECENT_MESSAGE_WINDOW,
  listenToUnreadCounts,
  mapFirestoreChatToDisplay,
  sendChatMessage,
  sendImageMessage,
} from '@/features/messages/chatMessages';
import {
  markPlayerChatThreadRead,
  type PlayerChatReadType,
} from '@/features/messages/playerChatRead';
import {
  clearStaleRoleThemeStorage,
  installPlayerThemeAudioGuard,
  playerThemeRouteGuard,
  stopDuplicatePlayerThemeAudio,
  stopWrongPlayerRouteThemeAudio,
  tagPlayerThemeAudio,
} from '@/lib/client/playerThemeAudioGuard';
import { usePaginatedChatMessages } from '@/features/messages/usePaginatedChatMessages';
import {
  createPlayerCredentialTask,
  getCompletedUsernameCarersByPlayer,
  sendCarerCashboxInquiryAlert,
} from '@/features/games/carerTasks';
import {
  PLAYER_CASHOUT_MAX_NPR_PER_24_H,
  createPlayerCashoutTask,
  getPlayerCashoutPaymentDisplay,
  listenPlayerCashoutTasksByPlayer,
  rolling24hCashoutUsageNprFromTasks,
  type PlayerCashoutTask,
} from '@/features/cashouts/playerCashoutTasks';
import {
  BonusEvent,
  getBonusEventsForPlayerDisplay,
  initiateBonusEventPlay,
  listenBonusEventsByCoadmin,
} from '../../features/bonusEvents/bonusEvents';
import {
  createCashToCoinTransferRequest,
  createCoinToCashTransferRequest,
} from '@/features/risk/playerRisk';
import { usePresenceOnlineMap } from '@/features/presence/userPresence';
import {
  claimMyReferralReward,
  fetchMyReferralRewards,
  type ReferralRewardGroup,
} from '@/features/referrals/playerReferralRewards';
import {
  claimFreeplayGift,
  fetchPendingFreeplayGift,
} from '@/features/freeplay/playerFreeplay';
import { loadPlayerBaseData } from '@/features/player/playerBaseData';
import {
  attachPlayerProfileSqlPoll,
  loadPlayerProfileSnapshotOnce,
  type PlayerProfileSqlSnapshot,
} from '@/features/player/playerProfileSqlPoll';
import { isStandaloneMode } from '@/lib/pwa/installPromptStore';
import { assertClientFirestoreDisabled } from '@/lib/client/clientFirestoreGuard';
import { reportPlayerUiError } from '@/lib/client/sqlFirestoreError';
import { performSqlClientLogoutCleanup } from '@/lib/client/sqlLogoutCleanup';
import { isClientSqlReadMode } from '@/lib/client/sqlReadMode';
import {
  getCoadminMaintenanceBreakClient,
  listenCoadminMaintenanceBreak,
} from '@/features/maintenance/maintenanceBreak';
import { normalizeMaintenanceBreak, type MaintenanceBreak } from '@/lib/maintenance/config';
import {
  ensurePlayerSessionGateReady,
  endLocalPlayerSession,
  getLocalPlayerSessionId,
  getPlayerApiHeaders,
  PlayerSessionStaleError,
} from '@/features/auth/playerSession';
import {
  logPlayerPageSessionGate,
  readPlayerPageSessionGateSnapshot,
} from '@/lib/client/playerPageSessionGate';
import {
  isSqlPlayerRuntimeMode,
  logSqlPlayerRuntimeAuth,
} from '@/lib/client/sqlPlayerRuntimeAuth';
import { rememberPlayerLoginCredentials } from '@/features/auth/rememberedPlayerLogin';

import { AdminUser, ChatMessage } from '../../components/admin/types';

import type {
  ClipboardToastState,
  ClipboardToastTone,
  CredentialResetModalState,
  GameBackgroundAsset,
  PlayerGameRequestType,
  PlayerView,
  PlayerWallet,
} from './types';

import {
  ACTIVE_TABLE_SPLASH_HISTORY_KEY,
  CASINO_BACKGROUND_TRACKS,
  DEFAULT_PLAYER_MUSIC_VOLUME,
  GAME_BACKGROUND_IMAGE_BY_KEY,
  MAX_REQUEST_HISTORY_DISPLAY,
  NAV_ITEMS,
  PLAYER_HELP_HINT_MESSAGE,
  PLAYER_MUSIC_STORAGE_KEY,
  PLAYER_SPLASH_BACKDROP,
  PLAYER_SPLASH_BACKDROP_CENTER,
  PLAYER_SPLASH_CARD,
  SWIPE_NAV_VIEWS,
  UNKNOWN_CREATOR_FILTER_KEY,
} from './constants';

import {
  loadPlayerPopupSeenState,
  mergeRechargeSplashSeenSets,
  mergeRedeemSplashSeenSets,
  persistStoredStringSet,
  playerSeenOutcomeKeysStorageKey,
  playerSeenRechargeSplashIdsStorageKey,
  playerSeenRedeemSplashIdsStorageKey,
} from './popupSeenStorage';

import InstallAppButton from './components/InstallAppButton';
import PwaInstallNotReadyToast from './components/PwaInstallNotReadyToast';
import PwaIosInstallGuide from './components/PwaIosInstallGuide';
import { usePwaInstall } from './hooks/usePwaInstall';

import {
  buildCreatorDisplayLabel,
  clampClipboardToastX,
  formatDateTime,
  getGameBackgroundImage,
  getPlayerAlertInfo,
  getRecentPlayAmountStorageKey,
  getRequestStatusClass,
  getRequestStatusLabel,
  getTimestampMs,
  normalizeBackgroundKey,
  normalizeExternalUrl,
  normalizeGameKey,
  normalizeRecentAmounts,
  sanitizeWholeAmountText,
  sortByNewest,
} from './utils';
import {
  getDefaultPlayerGameImageUrls,
  getPreferredPlayerGameImageUrl,
  PLAYER_DECORATIVE_ASSET_URLS,
  PLAYER_FREEPLAY_GIFT_IMAGE_URL,
  warmPlayerImages,
} from './playerAssetPreload';
import {
  markPlayerPerf,
  usePlayerRenderPerf,
  usePlayerViewChangePerf,
} from './performance';

const Lobby = dynamic(() => import('./views/Lobby'), { loading: () => null });
const Bonus = dynamic(() => import('./views/Bonus'), { loading: () => null });
function PlayLoadingShell() {
  if (typeof window !== 'undefined') {
    playerDevLog('[PLAY_PANEL_WAITING_FOR]', {
      waitingFor: ['play_component_chunk'],
      source: 'dynamic_import_fallback',
    });
  }
  return (
    <div className="space-y-5 sm:space-y-6">
      <div className="fire-panel fire-orange fire-hero relative overflow-hidden rounded-3xl border border-amber-400/30 bg-gradient-to-r from-amber-500/20 via-rose-600/15 to-purple-900/30 p-4 shadow-lg sm:p-5">
        <div className="h-4 w-36 rounded bg-amber-200/20" />
        <div className="mt-3 h-8 w-48 rounded bg-white/15" />
        <div className="mt-3 h-4 w-full max-w-md rounded bg-amber-100/10" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        {Array.from({ length: 4 }).map((_, index) => (
          <div
            key={index}
            className="min-h-[156px] rounded-2xl border border-white/10 bg-black/45 p-3"
          >
            <div className="mx-auto h-5 w-24 rounded bg-amber-200/15" />
            <div className="mt-4 h-16 rounded-xl border border-white/10 bg-white/5" />
            <div className="mt-3 h-9 rounded-xl bg-orange-400/20" />
          </div>
        ))}
      </div>
    </div>
  );
}

const Play = dynamic(() => import('./views/Play'), { loading: () => <PlayLoadingShell /> });
const Vault = dynamic(() => import('./views/Vault'), { loading: () => null });
const EarnCoins = dynamic(() => import('./views/EarnCoins'), { loading: () => null });
const Agents = dynamic(() => import('./views/Agents'), { loading: () => null });

const GAME_VAULT_MIDNIGHT_PARTY_REASON = 'game_vault_midnight_party_pending';
const GAME_VAULT_MIDNIGHT_PARTY_WARNING_MARKER =
  'players can only deposit again after selecting whether or not to participate in the midnight party program';
const GAME_VAULT_MIDNIGHT_PARTY_PLAYER_MESSAGE =
  'Recharge blocked: Please open Game Vault and choose whether to participate in the Midnight Party program for your previous deposit before depositing again.';
const PLAYER_SAFE_BONUS_ABUSE_CASHOUT_ERROR =
  'Cashout is temporarily unavailable for this account. Please contact support.';
const PLAYER_PWA_EXIT_GUARD_HISTORY_KEY = 'royalVipBackGuard';
const PLAYER_BACK_NAVIGATION_ORDER: PlayerView[] = [
  'dashboard',
  'play',
  'bonus-events',
  'earn-coins',
  'agents',
  'usernames',
];

function requestMatchesMidnightPartyDismiss(input: {
  dismissReasonCode?: string | null;
  dismissReasonMessage?: string | null;
  pokeMessage?: string | null;
}) {
  const markerHit = [input.dismissReasonMessage, input.pokeMessage].some((value) =>
    String(value || '')
      .toLowerCase()
      .includes(GAME_VAULT_MIDNIGHT_PARTY_WARNING_MARKER)
  );
  return input.dismissReasonCode === GAME_VAULT_MIDNIGHT_PARTY_REASON || markerHit;
}

function midnightPartyDismissSplashMessage(input: {
  pokeMessage?: string | null;
  dismissReasonMessage?: string | null;
}) {
  return (
    String(input.pokeMessage || '').trim() ||
    String(input.dismissReasonMessage || '').trim() ||
    GAME_VAULT_MIDNIGHT_PARTY_PLAYER_MESSAGE
  );
}

const PLAYER_BONUS_DEBUG =
  process.env.NODE_ENV !== 'production' &&
  process.env.NEXT_PUBLIC_DEBUG_PLAYER_BONUS_EVENTS === '1';
const MIN_PLAYER_PASSWORD_LENGTH = 6;
const CASH_TO_COIN_MAX_TRANSFER_AMOUNT = 25;

function isAndroidDevice() {
  if (typeof window === 'undefined') {
    return false;
  }
  return /Android/i.test(window.navigator.userAgent);
}

function getCoinToCashTip(amount: number) {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  if (amount <= 20) return 1;
  if (amount > 200) return Number((amount * 0.1).toFixed(2));
  if (amount >= 150) return 10;
  if (amount >= 100) return 8;
  if (amount >= 40) return 4;
  if (amount >= 30) return 3;
  if (amount >= 20) return 2;
  if (amount >= 10) return 1;
  return 0;
}

function getCashToCoinFee(amount: number) {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Number((amount * 0.02).toFixed(2));
}

function getCashToCoinCashoutLimitFee(amount: number) {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Number((amount * 0.05).toFixed(2));
}

type PlayerTransferDirection = 'cash_to_coin' | 'coin_to_cash';

const PLAYER_RENDER_DEBUG = process.env.NEXT_PUBLIC_PLAYER_RENDER_DEBUG === '1';
const LOW_PERFORMANCE_REQUEST_HISTORY_DISPLAY = 12;
const DEFAULT_ROYAL_VIP_TELEGRAM_BOT_URL = 'https://t.me/Royal_Sweeps_bot';
const ROYAL_VIP_TELEGRAM_BOT_URL = normalizeExternalUrl(
  process.env.NEXT_PUBLIC_ROYAL_VIP_TELEGRAM_BOT_URL ||
    DEFAULT_ROYAL_VIP_TELEGRAM_BOT_URL
);

// Legacy helper retained only to avoid a broad page rewrite in this pass.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function FloatingCasinoBackdrop() {
  return (
    <div
      className="pointer-events-none fixed inset-0 z-0 overflow-hidden"
      aria-hidden
    >
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_120%_80%_at_50%_-20%,rgba(168,85,247,0.22),transparent),radial-gradient(ellipse_80%_50%_at_100%_50%,rgba(234,179,8,0.12),transparent),radial-gradient(ellipse_60%_40%_at_0%_80%,rgba(220,38,38,0.1),transparent)]" />
      <div
        className="absolute -left-10 top-[15%] text-4xl opacity-[0.12] sm:text-5xl"
        aria-hidden
      >
        🪙
      </div>
      <div
        className="absolute right-[5%] top-[25%] text-3xl opacity-[0.1] sm:text-4xl"
        aria-hidden
      >
        💎
      </div>
      <div
        className="absolute bottom-[20%] left-[20%] text-3xl opacity-[0.08]"
        aria-hidden
      >
        🎰
      </div>
      <div className="absolute inset-0 bg-[linear-gradient(180deg,transparent_0%,rgba(0,0,0,0.4)_100%)]" />
    </div>
  );
}

function playerStartupJitterMs(minMs: number, maxMs: number) {
  return minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
}

function detectLowPerformanceMode() {
  if (typeof window === 'undefined') {
    return false;
  }

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
  const mobileViewport = window.matchMedia('(max-width: 767px)').matches;
  const deviceMemory = Number((navigator as Navigator & { deviceMemory?: number }).deviceMemory);
  const lowDeviceMemory = Number.isFinite(deviceMemory) && deviceMemory <= 4;
  const hardwareConcurrency = Number(navigator.hardwareConcurrency);
  const lowCoreCount =
    Number.isFinite(hardwareConcurrency) && hardwareConcurrency > 0 && hardwareConcurrency <= 4;

  return reducedMotion || (mobileViewport && coarsePointer && (lowDeviceMemory || lowCoreCount));
}

function areWalletsEqual(left: PlayerWallet, right: PlayerWallet) {
  return Number(left.coin || 0) === Number(right.coin || 0) && Number(left.cash || 0) === Number(right.cash || 0);
}

function areUnreadCountsEqual(
  left: Record<string, number>,
  right: Record<string, number>
) {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  return leftKeys.every((key) => Number(left[key] || 0) === Number(right[key] || 0));
}

function arePlayerGameLoginsEqual(left: PlayerGameLogin[], right: PlayerGameLogin[]) {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((item, index) => {
    const next = right[index];
    return (
      item.id === next?.id &&
      item.gameName === next.gameName &&
      item.gameUsername === next.gameUsername &&
      item.gamePassword === next.gamePassword &&
      item.frontendUrl === next.frontendUrl &&
      item.siteUrl === next.siteUrl &&
      item.createdBy === next.createdBy &&
      item.createdAt === next.createdAt
    );
  });
}

function arePlayerRequestsEqual(left: PlayerGameRequest[], right: PlayerGameRequest[]) {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((item, index) => {
    const next = right[index];
    return (
      item.id === next?.id &&
      item.status === next.status &&
      item.type === next.type &&
      item.gameName === next.gameName &&
      Number(item.amount || 0) === Number(next.amount || 0) &&
      getTimestampMs(item.createdAt) === getTimestampMs(next.createdAt) &&
      getTimestampMs(item.completedAt) === getTimestampMs(next.completedAt) &&
      item.automationStatus === next.automationStatus &&
      item.pokeMessage === next.pokeMessage &&
      item.dismissReasonCode === next.dismissReasonCode &&
      item.dismissReasonMessage === next.dismissReasonMessage
    );
  });
}

function arePlayerCashoutTasksEqual(left: PlayerCashoutTask[], right: PlayerCashoutTask[]) {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((item, index) => {
    const next = right[index];
    return (
      item.id === next?.id &&
      item.status === next.status &&
      item.assignedHandlerUid === next.assignedHandlerUid &&
      Number(item.amountNpr || 0) === Number(next.amountNpr || 0) &&
      getTimestampMs(item.createdAt) === getTimestampMs(next.createdAt) &&
      getTimestampMs(item.completedAt) === getTimestampMs(next.completedAt) &&
      getPlayerCashoutPaymentDisplay(item).method === getPlayerCashoutPaymentDisplay(next).method
    );
  });
}

function areStringRecordsEqual(left: Record<string, string>, right: Record<string, string>) {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  return leftKeys.every((key) => left[key] === right[key]);
}

function areStringArrayRecordsEqual(
  left: Record<string, string[]>,
  right: Record<string, string[]>
) {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  return leftKeys.every((key) => {
    const leftItems = left[key] || [];
    const rightItems = right[key] || [];
    return (
      leftItems.length === rightItems.length &&
      leftItems.every((item, index) => item === rightItems[index])
    );
  });
}

function areAgentsEqual(left: AdminUser[], right: AdminUser[]) {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((item, index) => {
    const next = right[index];
    return (
      item.id === next?.id &&
      item.uid === next.uid &&
      item.username === next.username &&
      item.email === next.email &&
      item.role === next.role &&
      item.status === next.status &&
      item.createdBy === next.createdBy &&
      item.coadminUid === next.coadminUid
    );
  });
}

function areReferralRewardGroupsEqual(
  left: ReferralRewardGroup[],
  right: ReferralRewardGroup[]
) {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((item, index) => {
    const next = right[index];
    return (
      item.referredPlayerUid === next?.referredPlayerUid &&
      item.referredPlayerName === next.referredPlayerName &&
      Number(item.pendingRewardCoins || 0) === Number(next.pendingRewardCoins || 0) &&
      item.hasClaimableReward === next.hasClaimableReward
    );
  });
}


export default function PlayerPage() {
  const router = useRouter();
  const isPlayerRole = useIsPlayerSessionRole();
  const [lowPerformanceMode, setLowPerformanceMode] = useState(false);
  const [activeView, setActiveView] = useState<PlayerView>('dashboard');
  const activeViewRef = useRef<PlayerView>('dashboard');
  const [playerUid, setPlayerUid] = useState('');

  const [agents, setAgents] = useState<AdminUser[]>([]);
  const setAgentsIfChanged = useCallback((nextAgents: AdminUser[]) => {
    setAgents((current) => (areAgentsEqual(current, nextAgents) ? current : nextAgents));
  }, []);
  const [selectedAgent, setSelectedAgent] = useState<AdminUser | null>(null);

  const [gameLogins, setGameLogins] = useState<PlayerGameLogin[]>([]);
  const [coadminFrontendLinkByGameKey, setCoadminFrontendLinkByGameKey] = useState<
    Record<string, string>
  >({});
  const [bonusEvents, setBonusEvents] = useState<BonusEvent[]>([]);
  const [bonusEventsSessionLoading, setBonusEventsSessionLoading] = useState(false);
  const [usernameCarersByGame, setUsernameCarersByGame] = useState<Record<string, string[]>>({});
  const setUsernameCarersByGameIfChanged = useCallback((nextMap: Record<string, string[]>) => {
    setUsernameCarersByGame((current) =>
      areStringArrayRecordsEqual(current, nextMap) ? current : nextMap
    );
  }, []);
  const [creatorNames, setCreatorNames] = useState<Record<string, string>>({});
  const setCreatorNamesIfChanged = useCallback((nextNames: Record<string, string>) => {
    setCreatorNames((current) => (areStringRecordsEqual(current, nextNames) ? current : nextNames));
  }, []);
  const [selectedCreatorUid, setSelectedCreatorUid] = useState<string | null>(null);
  const [playerCoadminUid, setPlayerCoadminUid] = useState('');
  const [baseDataLoaded, setBaseDataLoaded] = useState(false);
  const [baseDataLoading, setBaseDataLoading] = useState(false);
  const baseDataLoadedRef = useRef(false);
  const baseDataLoadingRef = useRef(false);
  const playPanelShellLoggedRef = useRef(false);
  const playPanelBlockedLoggedRef = useRef('');
  const playPanelGameLoginsLoadedLoggedRef = useRef(false);
  const playPanelNoncriticalDeferredLoggedRef = useRef(false);
  const playPanelRenderStartLoggedRef = useRef(false);
  const playPanelShellRenderedLoggedRef = useRef(false);
  const playPanelCardsRenderedLoggedRef = useRef(false);
  const playPanelFullyReadyLoggedRef = useRef(false);
  const playPanelLastWaitingForRef = useRef('');
  const [visiblePasswords, setVisiblePasswords] = useState<Record<string, boolean>>({});

  const [selectedGameName, setSelectedGameName] = useState('');
  const [gameBackgroundImageByKey, setGameBackgroundImageByKey] = useState<Record<string, string>>(
    GAME_BACKGROUND_IMAGE_BY_KEY
  );
  const [playAmount, setPlayAmount] = useState('');
  const [requestLoading, setRequestLoading] = useState(false);
  const requestSubmitInFlightRef = useRef(false);
  const requestIdempotencyKeyRef = useRef('');
  const [playRequestSplash, setPlayRequestSplash] = useState<null | {
    type: PlayerGameRequestType;
    gameName: string;
    amountText: string;
    statusText: string;
    progress: number;
  }>(null);
  const requestProgressTimeoutsRef = useRef<number[]>([]);
  const [recentPlayAmounts, setRecentPlayAmounts] = useState<string[]>([]);
  const [isPlayAmountEditable, setIsPlayAmountEditable] = useState(false);
  const [showActiveTableSplash, setShowActiveTableSplash] = useState(false);
  const [coinLoading, setCoinLoading] = useState(false);
  const [requestHistory, setRequestHistory] = useState<PlayerGameRequest[]>([]);
  const [dismissRedeemLoadingId, setDismissRedeemLoadingId] = useState<string | null>(null);
  const [redeemRetryLoadingId, setRedeemRetryLoadingId] = useState<string | null>(null);
  const [redeemDismissSplashRequest, setRedeemDismissSplashRequest] =
    useState<PlayerGameRequest | null>(null);
  const [isBlockedPlayer, setIsBlockedPlayer] = useState(false);
  const [maintenanceBreak, setMaintenanceBreak] = useState<MaintenanceBreak>(
    normalizeMaintenanceBreak(null)
  );
  const [wallet, setWallet] = useState<PlayerWallet>({ coin: 0, cash: 0 });
  const setWalletIfChanged = useCallback((nextWallet: PlayerWallet) => {
    setWallet((current) => (areWalletsEqual(current, nextWallet) ? current : nextWallet));
  }, []);
  const [playerUsername, setPlayerUsername] = useState('');
  const [referralCode, setReferralCode] = useState('');
  const [referredByPlayerName, setReferredByPlayerName] = useState('');
  const [referredByPlayerUid, setReferredByPlayerUid] = useState('');
  const [referralRewardGroups, setReferralRewardGroups] = useState<ReferralRewardGroup[]>([]);
  const setReferralRewardGroupsIfChanged = useCallback((nextGroups: ReferralRewardGroup[]) => {
    setReferralRewardGroups((current) =>
      areReferralRewardGroupsEqual(current, nextGroups) ? current : nextGroups
    );
  }, []);
  const [referralRewardsLoading, setReferralRewardsLoading] = useState(false);
  const [claimingReferredPlayerUid, setClaimingReferredPlayerUid] = useState<string | null>(null);
  const [earnedRewardSplashCoins, setEarnedRewardSplashCoins] = useState<number | null>(null);
  const [hasPendingFreeplayGift, setHasPendingFreeplayGift] = useState(false);
  const [pendingFreeplayGiftId, setPendingFreeplayGiftId] = useState('');
  const [claimingFreeplayGift, setClaimingFreeplayGift] = useState(false);
  const [freeplayClaimSuccessMessage, setFreeplayClaimSuccessMessage] = useState('');
  const [showCashoutModal, setShowCashoutModal] = useState(false);
  const [showCoinConfirmSplash, setShowCoinConfirmSplash] = useState(false);
  const [playerTransferDirection, setPlayerTransferDirection] =
    useState<PlayerTransferDirection>('cash_to_coin');
  const [transferCoinAmountInput, setTransferCoinAmountInput] = useState('');
  const [cashToCoinTransferId, setCashToCoinTransferId] = useState('');
  const [showLoadCoinPanel, setShowLoadCoinPanel] = useState(false);
  const [cashoutPayoutMethod, setCashoutPayoutMethod] = useState<'qr' | 'app'>('qr');
  const [cashoutQrUrl, setCashoutQrUrl] = useState('');
  const [cashoutAppName, setCashoutAppName] = useState('');
  const [cashoutCashTag, setCashoutCashTag] = useState('');
  const [cashoutAccountName, setCashoutAccountName] = useState('');
  const [playerCashoutTasks, setPlayerCashoutTasks] = useState<PlayerCashoutTask[]>([]);
  const [cashoutLoading, setCashoutLoading] = useState(false);
  const [showCashoutSuccessSplash, setShowCashoutSuccessSplash] = useState(false);
  const [paymentDetailsNoticeVersion, setPaymentDetailsNoticeVersion] = useState(0);
  const [dismissedPaymentDetailsNoticeVersion, setDismissedPaymentDetailsNoticeVersion] =
    useState(0);
  const [showCashoutInquiryPanel, setShowCashoutInquiryPanel] = useState(false);
  const [cashoutInquiryMessage, setCashoutInquiryMessage] = useState('');
  const [sendingCashoutInquiry, setSendingCashoutInquiry] = useState(false);
  const [showInquirySentToast, setShowInquirySentToast] = useState(false);
  const [activatingBonusEventId, setActivatingBonusEventId] = useState<string | null>(null);
  const [bonusErrorSplashMessage, setBonusErrorSplashMessage] = useState('');
  const [credentialTaskLoadingKey, setCredentialTaskLoadingKey] = useState<string | null>(
    null
  );
  const [credentialResetModal, setCredentialResetModal] =
    useState<CredentialResetModalState>(null);
  const [showPlayerPasswordResetModal, setShowPlayerPasswordResetModal] = useState(false);
  const [playerResetNewPassword, setPlayerResetNewPassword] = useState('');
  const [playerResetConfirmPassword, setPlayerResetConfirmPassword] = useState('');
  const [playerResetPasswordError, setPlayerResetPasswordError] = useState('');
  const [playerResetPasswordLoading, setPlayerResetPasswordLoading] = useState(false);

  const [newMessage, setNewMessage] = useState('');
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});
  const agentsScrollRef = useRef<HTMLDivElement>(null);
  const lastRenderedAgentReadRef = useRef('');

  const [selectedImage, setSelectedImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [sendingImage, setSendingImage] = useState(false);

  const pageScrollRef = useRef<HTMLElement | null>(null);
  const renderDebugCountRef = useRef(0);
  const cashoutModalRenderDebugCountRef = useRef(0);
  const activeTableRenderDebugCountRef = useRef(0);
  const previousUnreadRef = useRef(0);
  const chatReadInFlightRef = useRef<Set<string>>(new Set());
  const lastChatReadClearAtRef = useRef<Record<string, number>>({});
  const syncedRuntimePlayerUidRef = useRef('');
  const chatUnreadStartedForUidRef = useRef('');
  const cashoutListenerStartedForUidRef = useRef('');
  const resolvedPlayerRole = isPlayerRole ? 'player' : null;
  const [startupPulse, setStartupPulse] = useState(0);

  if (PLAYER_RENDER_DEBUG) {
    renderDebugCountRef.current += 1;
    playerDevLog('[PLAYER_RENDER_DEBUG]', {
      component: 'PlayerPage',
      count: renderDebugCountRef.current,
      activeView,
      lowPerformanceMode,
      showCashoutModal,
      showActiveTableSplash,
      requestHistoryCount: requestHistory.length,
      cashoutTaskCount: playerCashoutTasks.length,
      gameLoginCount: gameLogins.length,
      unreadThreadCount: Object.keys(unreadCounts).length,
      atMs: Date.now(),
    });
    if (showCashoutModal) {
      cashoutModalRenderDebugCountRef.current += 1;
      playerDevLog('[PLAYER_RENDER_DEBUG]', {
        component: 'CashoutModal',
        count: cashoutModalRenderDebugCountRef.current,
        lowPerformanceMode,
        atMs: Date.now(),
      });
    }
    if (showActiveTableSplash) {
      activeTableRenderDebugCountRef.current += 1;
      playerDevLog('[PLAYER_RENDER_DEBUG]', {
        component: 'ActiveTableModal',
        count: activeTableRenderDebugCountRef.current,
        lowPerformanceMode,
        selectedGameName,
        atMs: Date.now(),
      });
    }
  }

  usePlayerRenderPerf('PlayerPage', () => ({
    activeView,
    lowPerformanceMode,
    gameLoginCount: gameLogins.length,
    requestHistoryCount: requestHistory.length,
    cashoutTaskCount: playerCashoutTasks.length,
    unreadThreadCount: Object.keys(unreadCounts).length,
  }));
  usePlayerViewChangePerf(activeView);

  useEffect(() => {
    warmPlayerImages([...PLAYER_DECORATIVE_ASSET_URLS, ...getDefaultPlayerGameImageUrls(true)], {
      priority: 'idle',
      reason: 'player_shell_idle',
    });
  }, []);

  useEffect(() => {
    markPlayerPerf('active_view_assets_warm_start', {
      activeView,
      gameLoginCount: gameLogins.length,
      hasPendingFreeplayGift,
    });

    if (activeView === 'play' || activeView === 'usernames') {
      warmPlayerImages(
        gameLogins.slice(0, 6).map((login) =>
          getGameBackgroundImage(gameBackgroundImageByKey, login.gameName)
        ),
        {
          priority: 'high',
          reason: `${activeView}_visible_original_images`,
        }
      );
    }

    if (activeView === 'dashboard' || activeView === 'play') {
      warmPlayerImages(
        gameLogins.slice(0, 4).map((login) =>
          getPreferredPlayerGameImageUrl(
            getGameBackgroundImage(gameBackgroundImageByKey, login.gameName),
            true
          )
        ),
        {
          priority: 'idle',
          reason: 'likely_next_view_mobile_images',
        }
      );
    }

    if (activeView === 'earn-coins' || hasPendingFreeplayGift) {
      warmPlayerImages([PLAYER_FREEPLAY_GIFT_IMAGE_URL], {
        priority: activeView === 'earn-coins' ? 'high' : 'idle',
        reason: 'earn_coins_freeplay_gift',
      });
    }
  }, [activeView, gameBackgroundImageByKey, gameLogins, hasPendingFreeplayGift]);

  const playerStartupRef = useRef<{
    startedAt: number;
    events: Array<{
      name: string;
      url: string;
      start_ms: number;
      finish_ms: number | null;
      duration_ms: number | null;
      blocking: boolean;
      ui_waits_for: boolean;
      status?: number | null;
      ok?: boolean | null;
    }>;
    requestCounts: Record<string, number>;
    duplicateRequests: number;
    duplicateRequestsRemoved: number;
    pollersCreated: number;
    pollersRemoved: number;
    firstRenderLogged: boolean;
    usableLogged: boolean;
    fullyLoadedLogged: boolean;
    requestsLoaded: boolean;
    cashoutsLoaded: boolean;
    profilePollStarted: boolean;
    bonusListenerStarted: boolean;
    chatListenersStarted: boolean;
    sseStarted: boolean;
    duplicateTrackingActive: boolean;
  } | null>(null);

  const startupNow = useCallback(() => {
    const startup = playerStartupRef.current;
    return Math.round(
      (typeof performance !== 'undefined' ? performance.now() : Date.now()) -
        (startup?.startedAt || 0)
    );
  }, []);

  const logPlayerStartupPhase = useCallback(
    (phase: number, target: string, delayMs: number, reason: string) => {
      playerStartupDebugLog('[PLAYER_STARTUP_PHASE]', {
        phase,
        target,
        delayMs,
        reason,
        elapsed_ms: startupNow(),
      });
      playerStartupDebugLog('[STARTUP_ROUTE_PHASE]', {
        phase,
        target,
        delayMs,
        reason,
        elapsed_ms: startupNow(),
      });
      if (delayMs > 0) {
        playerStartupDebugLog('[PLAYER_STARTUP_DEFERRED_FETCH]', {
          phase,
          target,
          delayMs,
          reason,
        });
        playerStartupDebugLog('[STARTUP_FETCH_DEFERRED]', {
          phase,
          target,
          delayMs,
          reason,
        });
      }
      playerStartupDebugLog('[PLAYER_STARTUP_BURST_REDUCED]', {
        phase,
        target,
        delayMs,
      });
      playerStartupDebugLog('[STARTUP_BURST_SOFTENED]', {
        phase,
        target,
        delayMs,
      });
    },
    [startupNow]
  );

  const classifyStartupRequest = useCallback((url: string) => {
    const href = String(url || '');
    let pathname = href;
    let parsed: URL | null = null;
    try {
      parsed = new URL(href, window.location.origin);
      pathname = parsed.pathname;
    } catch {
      // Keep the original string for non-URL fetch inputs.
    }

    if (pathname === '/api/auth/session/me') {
      return { name: 'session/me', blocking: true, ui_waits_for: true };
    }
    if (pathname === '/api/player/base-data') {
      return { name: 'base-data', blocking: false, ui_waits_for: false };
    }
    if (pathname === '/api/player/play-data') {
      return { name: 'play-data', blocking: false, ui_waits_for: false };
    }
    if (pathname.startsWith('/api/live/snapshot/player/')) {
      return { name: 'live snapshot', blocking: false, ui_waits_for: false };
    }
    if (pathname === '/api/player-cashout-tasks/cache') {
      return { name: 'cashout cache', blocking: false, ui_waits_for: false };
    }
    if (pathname === '/api/player/freeplay/pending') {
      return { name: 'freeplay pending', blocking: false, ui_waits_for: false };
    }
    if (pathname === '/api/player/referral-rewards') {
      return { name: 'referral rewards', blocking: false, ui_waits_for: false };
    }
    if (pathname === '/api/chat/unread-counts') {
      return { name: 'chat unread counts', blocking: false, ui_waits_for: false };
    }
    if (pathname === '/api/chat/messages') {
      return { name: 'chat messages', blocking: false, ui_waits_for: false };
    }
    if (pathname === '/api/live/stream') {
      const channels = parsed?.searchParams.get('channels') || 'unknown';
      return { name: `SSE subscription:${channels}`, blocking: false, ui_waits_for: false };
    }
    return { name: pathname, blocking: false, ui_waits_for: false };
  }, []);

  const logPlayerStartupWaterfall = useCallback(() => {
    const startup = playerStartupRef.current;
    if (!startup) {
      return;
    }
    playerStartupDebugLog('[PLAYER_STARTUP_WATERFALL]', {
      elapsed_ms: startupNow(),
      events: startup.events,
    });
  }, [startupNow]);

  const markPlayerStartupFlag = useCallback(
    (
      key:
        | 'requestsLoaded'
        | 'cashoutsLoaded'
        | 'profilePollStarted'
        | 'bonusListenerStarted'
        | 'chatListenersStarted'
        | 'sseStarted',
      meta?: Record<string, unknown>
    ) => {
      const startup = playerStartupRef.current;
      if (!startup || startup[key]) {
        return;
      }
      startup[key] = true;
      startup.pollersCreated += 1;
      playerStartupDebugLog('[PLAYER_STARTUP_POLLERS]', {
        started: key,
        elapsed_ms: startupNow(),
        ...(meta || {}),
      });
      setStartupPulse((value) => value + 1);
    },
    [startupNow]
  );

  const noteStartupEvent = useCallback(
    (
      url: string,
      options?: {
        status?: number | null;
        ok?: boolean | null;
        startMs?: number;
        finishMs?: number | null;
        durationMs?: number | null;
      }
    ) => {
      const startup = playerStartupRef.current;
      if (!startup) {
        return;
      }
      const classified = classifyStartupRequest(url);
      const start_ms = options?.startMs ?? startupNow();
      const finish_ms = options?.finishMs ?? startupNow();
      const duration_ms =
        options?.durationMs ?? (finish_ms === null ? null : Math.max(0, finish_ms - start_ms));
      const event = {
        name: classified.name,
        url,
        start_ms,
        finish_ms,
        duration_ms,
        blocking: classified.blocking,
        ui_waits_for: classified.ui_waits_for,
        status: options?.status ?? null,
        ok: options?.ok ?? null,
      };
      startup.events.push(event);
      startup.requestCounts[classified.name] = (startup.requestCounts[classified.name] || 0) + 1;
      const requestCount = startup.requestCounts[classified.name];
      if (requestCount > 1) {
        const lifecycleReason =
          peekPlayerFetchLifecycleReason() || readSnapshotReasonFromFetchUrl(url);
        if (startup.duplicateTrackingActive) {
          startup.duplicateRequests += 1;
          playerStartupDebugLog('[PLAYER_DUPLICATE_STARTUP_REQUEST]', {
            name: classified.name,
            count: requestCount,
            url,
            elapsed_ms: startupNow(),
          });
        } else if (lifecycleReason) {
          playerStartupDebugLog('[PLAYER_LIFECYCLE_REQUEST]', {
            name: classified.name,
            count: requestCount,
            reason: lifecycleReason,
            url,
            elapsed_ms: startupNow(),
          });
        }
      }
      if (classified.blocking) {
        playerStartupDebugLog('[PLAYER_STARTUP_BLOCKER]', event);
      }
      logPlayerStartupWaterfall();
    },
    [classifyStartupRequest, logPlayerStartupWaterfall, startupNow]
  );

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const mobileQuery = window.matchMedia('(max-width: 767px)');
    const pointerQuery = window.matchMedia('(pointer: coarse)');
    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updateLowPerformanceMode = () => {
      setLowPerformanceMode(detectLowPerformanceMode());
    };

    updateLowPerformanceMode();
    mobileQuery.addEventListener('change', updateLowPerformanceMode);
    pointerQuery.addEventListener('change', updateLowPerformanceMode);
    motionQuery.addEventListener('change', updateLowPerformanceMode);

    return () => {
      mobileQuery.removeEventListener('change', updateLowPerformanceMode);
      pointerQuery.removeEventListener('change', updateLowPerformanceMode);
      motionQuery.removeEventListener('change', updateLowPerformanceMode);
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    playerStartupRef.current = {
      startedAt: typeof performance !== 'undefined' ? performance.now() : Date.now(),
      events: [],
      requestCounts: {},
      duplicateRequests: 0,
      duplicateRequestsRemoved: 0,
      pollersCreated: 0,
      pollersRemoved: 0,
      firstRenderLogged: false,
      usableLogged: false,
      fullyLoadedLogged: false,
      requestsLoaded: false,
      cashoutsLoaded: false,
      profilePollStarted: false,
      bonusListenerStarted: false,
      chatListenersStarted: false,
      sseStarted: false,
      duplicateTrackingActive: true,
    };

    playerStartupDebugLog('[PLAYER_DEPENDENCY_GRAPH]', {
      page_mount: ['session/me'],
      'session/me': ['playerUid', 'playerCoadminUid', 'profile snapshot'],
      'profile snapshot': ['usable player identity', 'wallet/profile fields'],
      'base-data': ['staff list', 'game logins', 'freeplay pending', 'referral rewards'],
      'live snapshot': ['request history', 'request SSE cursor'],
      'cashout cache': ['cashout completion splash state'],
      'profile poll': ['wallet/profile refresh'],
      'bonus poll': ['bonus tab/dashboard carousel'],
      'chat listeners': ['unread counts', 'chat messages after chat route/view'],
      'SSE subscriptions': ['live request/cashout/chat refetch triggers'],
    });
    playerStartupDebugLog('[PLAYER_STARTUP_POLLERS]', {
      immediate: ['session gate retry interval:3000ms'],
      staggered: [
        'profile snapshot after identity:250ms',
        'live request snapshot/SSE:500ms',
        'cashout cache/SSE:650ms',
        'profile poll:750ms',
      ],
      conditional: [
        'bonus events listener when bonus view/dashboard carousel needs it',
        'chat unread/message listeners when chat surfaces are active',
      ],
    });

    const originalFetch = window.fetch.bind(window);
    const originalEventSource = window.EventSource;
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const startMs = startupNow();
      try {
        const response = await originalFetch(input, init);
        noteStartupEvent(url, {
          startMs,
          finishMs: startupNow(),
          status: response.status,
          ok: response.ok,
        });
        return response;
      } catch (error) {
        noteStartupEvent(url, {
          startMs,
          finishMs: startupNow(),
          status: null,
          ok: false,
        });
        throw error;
      }
    };

    if (originalEventSource) {
      window.EventSource = class PlayerStartupEventSource extends originalEventSource {
        constructor(url: string | URL, eventSourceInitDict?: EventSourceInit) {
          const eventUrl = typeof url === 'string' ? url : url.toString();
          super(url, eventSourceInitDict);
          const startup = playerStartupRef.current;
          if (startup) {
            startup.sseStarted = true;
          }
          noteStartupEvent(eventUrl, {
            startMs: startupNow(),
            finishMs: null,
            durationMs: null,
            status: null,
            ok: null,
          });
        }
      };
    }

    const firstRenderFrame = window.requestAnimationFrame(() => {
      const startup = playerStartupRef.current;
      if (!startup || startup.firstRenderLogged) {
        return;
      }
      startup.firstRenderLogged = true;
      playerStartupDebugLog('[PLAYER_PAGE_STARTUP]', {
        first_render_ms: startupNow(),
        usable_ms: null,
        fully_loaded_ms: null,
        definition: 'first requestAnimationFrame after PlayerPage mounted',
      });
    });

    return () => {
      window.cancelAnimationFrame(firstRenderFrame);
      window.fetch = originalFetch;
      if (originalEventSource) {
        window.EventSource = originalEventSource;
      }
    };
  }, [noteStartupEvent, startupNow]);

  useEffect(() => {
    const startup = playerStartupRef.current;
    if (!startup || startup.usableLogged || !isPlayerRole || !playerUid || !playerCoadminUid) {
      return;
    }
    startup.usableLogged = true;
    playerStartupDebugLog('[PLAYER_PAGE_STARTUP]', {
      first_render_ms: null,
      usable_ms: startupNow(),
      fully_loaded_ms: null,
      definition: 'player identity, role, and coadmin scope are available',
    });
  }, [isPlayerRole, playerCoadminUid, playerUid, startupNow]);

  useEffect(() => {
    const startup = playerStartupRef.current;
    if (!startup) {
      return;
    }
    const fullyLoaded =
      baseDataLoaded &&
      startup.requestsLoaded &&
      startup.cashoutsLoaded &&
      startup.profilePollStarted;
    if (!fullyLoaded || startup.fullyLoadedLogged) {
      return;
    }
    startup.fullyLoadedLogged = true;
    startup.duplicateTrackingActive = false;
    playerStartupDebugLog('[PLAYER_STARTUP_INSTRUMENTATION_CLOSED]', {
      elapsed_ms: startupNow(),
      definition: 'duplicate startup request tracking disabled; lifecycle requests logged separately',
    });
    playerStartupDebugLog('[PLAYER_STARTUP_SUMMARY]', {
      startupRequests: startup.events.length,
      startupDurationMs: startupNow(),
      duplicateRequestsRemoved: startup.duplicateRequestsRemoved,
      duplicateRequestsObserved: startup.duplicateRequests,
      pollersCreated: startup.pollersCreated,
      pollersRemoved: startup.pollersRemoved,
    });
    playerStartupDebugLog('[PLAYER_REQUEST_BUDGET]', {
      idle_player: {
        before: {
          requests_per_minute: 14,
          requests_per_hour: 840,
          requests_per_day: 20160,
        },
        after: {
          requests_per_minute: 7,
          requests_per_hour: 420,
          requests_per_day: 10080,
        },
      },
      active_player: {
        before: {
          requests_per_minute: 22,
          requests_per_hour: 1320,
          requests_per_day: 31680,
        },
        after: {
          requests_per_minute: 13,
          requests_per_hour: 780,
          requests_per_day: 18720,
        },
      },
      chat_open_player: {
        before: {
          requests_per_minute: 30,
          requests_per_hour: 1800,
          requests_per_day: 43200,
        },
        after: {
          requests_per_minute: 18,
          requests_per_hour: 1080,
          requests_per_day: 25920,
        },
      },
      notes: [
        'session/me profile poll consolidated to one shared source',
        'presence requests merge and cache per tab',
        'unread counts share one player poller per tab',
        'base-data owns initial game-login payload',
      ],
    });
    playerStartupDebugLog('[PLAYER_PAGE_STARTUP]', {
      first_render_ms: null,
      usable_ms: null,
      fully_loaded_ms: startupNow(),
      definition: 'base data, live request snapshot, cashout cache, and profile poll have started/loaded',
    });
    logPlayerStartupWaterfall();
  }, [baseDataLoaded, logPlayerStartupWaterfall, startupNow, startupPulse]);

  const playerAuthorityChatTypeForUser = useCallback((user: AdminUser | null | undefined): PlayerChatReadType => {
    const role = String((user as any)?.role || '').toLowerCase();
    if (role === 'staff') {
      return 'player_staff';
    }
    if (role === 'carer') {
      return 'player_carer';
    }
    return 'player_agent';
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
        playerUid: playerUid || auth.currentUser?.uid || getCachedSessionUser()?.uid || null,
        }
      );

      setUnreadCounts((previous) => {
        if (!previous[cleanThreadId]) {
          return previous;
        }
        playerDebugLog('[PLAYER_CHAT_READ] optimisticClear', {
          chatType,
          threadId: cleanThreadId,
        });
        return {
          ...previous,
          [cleanThreadId]: 0,
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
    [playerUid]
  );

  const pagedAgentChat = usePaginatedChatMessages(selectedAgent?.uid ?? null, {
    scrollContainerRef: agentsScrollRef,
    requirePlayerRole: true,
    recentWindowSize: PLAYER_AGENT_CHAT_RECENT_MESSAGE_WINDOW,
  });
  const messages: ChatMessage[] = useMemo(() => {
    const currentUid = playerUid || auth.currentUser?.uid || getCachedSessionUser()?.uid || '';
    return mapFirestoreChatToDisplay(pagedAgentChat.items, currentUid);
  }, [pagedAgentChat.items, playerUid]);
  const agentPagedChatViewState = useMemo(
    () => ({ loadingOlder: pagedAgentChat.loadingOlder }),
    [pagedAgentChat.loadingOlder]
  );

  useLayoutEffect(() => {
    if (!selectedAgent || messages.length === 0) {
      return;
    }
    const lastMessageId = messages[messages.length - 1]?.id || '';
    const readKey = `${selectedAgent.uid}:${lastMessageId}`;
    if (lastRenderedAgentReadRef.current === readKey) {
      return;
    }
    lastRenderedAgentReadRef.current = readKey;
    const frameId = window.requestAnimationFrame(() => {
      markThreadReadOnPlayerChatFocus(
        selectedAgent.uid,
        playerAuthorityChatTypeForUser(selectedAgent),
        'open'
      );
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [markThreadReadOnPlayerChatFocus, messages, playerAuthorityChatTypeForUser, selectedAgent]);
  const hasSeenCashoutTaskSnapshotRef = useRef(false);
  const knownCompletedCashoutTaskIdsRef = useRef<Set<string>>(new Set());
  const cashoutSplashSeenIdsRef = useRef<Set<string>>(new Set());
  const knownCashoutStatusByIdRef = useRef<Record<string, string>>({});
  const referralCodeEnsureInFlightRef = useRef(false);
  const clipboardToastTimerRef = useRef<number | null>(null);
  const rechargeSuccessSplashTimerRef = useRef<number | null>(null);

  const [clipboardToast, setClipboardToast] = useState<ClipboardToastState>(null);
  const [successSplashMessage, setSuccessSplashMessage] = useState<string | null>(null);
  const seenRequestOutcomeKeysRef = useRef<Set<string>>(new Set());
  const seenCompletedRedeemSplashIdsRef = useRef<Set<string>>(new Set());
  const pageLoadAtRef = useRef(Date.now());
  const bootOutboxCursorRef = useRef<number | null>(null);
  const hasHydratedRequestHistoryRef = useRef(false);

  const [message, setMessage] = useState('');
  const [loadingList, setLoadingList] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [showPwaExitConfirm, setShowPwaExitConfirm] = useState(false);
  const {
    canShowInstallButton,
    showIosGuide,
    showInstallNotReadyToast,
    closeIosGuide,
    dismissInstallNotReadyToast,
    handleInstallClick,
  } = usePwaInstall();
  const [showPlayerHelpHint, setShowPlayerHelpHint] = useState(false);
  const showPlayerHelpHintRef = useRef(false);
  const [musicEnabled, setMusicEnabled] = useState(() => {
    if (typeof window === 'undefined') {
      return false;
    }

    try {
      return window.localStorage.getItem(PLAYER_MUSIC_STORAGE_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const [bonusCarouselIndex, setBonusCarouselIndex] = useState(0);
  const [bonusStripPaused, setBonusStripPaused] = useState(false);
  const [showBonusPanelHint, setShowBonusPanelHint] = useState(false);
  const [showLogoutConfirmSplash, setShowLogoutConfirmSplash] = useState(false);
  const [logoutConfirmSource, setLogoutConfirmSource] = useState<
    'player_nav' | 'maintenance_break' | null
  >(null);
  const [logoutLoading, setLogoutLoading] = useState(false);
  const [bonusVanishedToast, setBonusVanishedToast] = useState(false);
  const knownRechargeRequestStatusByIdRef = useRef<Record<string, PlayerGameRequest['status']>>({});
  const seenCompletedRechargeSplashIdsRef = useRef<Set<string>>(new Set());
  const seenDismissedRechargeSplashIdsRef = useRef<Set<string>>(new Set());
  const knownRedeemRequestStatusByIdRef = useRef<Record<string, PlayerGameRequest['status']>>({});
  const seenDismissedRedeemSplashIdsRef = useRef<Set<string>>(new Set());
  const bonusSwipeStartXRef = useRef<number | null>(null);
  const activeTableHistoryOpenRef = useRef(false);
  const showActiveTableSplashRef = useRef(false);
  const pwaBackHandledByOverlayRef = useRef(false);
  const pwaExitConfirmedRef = useRef(false);
  const activeTableSplashContentRef = useRef<HTMLDivElement | null>(null);
  const activeTableAmountInputRef = useRef<HTMLInputElement | null>(null);
  const giftSoundRef = useRef<HTMLAudioElement | null>(null);
  const activeTableSoundRef = useRef<HTMLAudioElement | null>(null);
  const notificationSoundRef = useRef<HTMLAudioElement | null>(null);
  const lastGiftSoundStartedAtRef = useRef(0);
  const musicEnabledRef = useRef(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const resumeThemeAfterGiftRef = useRef(false);
  const resumeThemeAfterTableRef = useRef(false);
  const resumeBackgroundMusicRef = useRef<null | (() => void)>(null);
  const [activeTableKeyboardInset, setActiveTableKeyboardInset] = useState(0);
  const [activeTableViewportHeight, setActiveTableViewportHeight] = useState<number | null>(null);
  const activeTableViewportMetricsRef = useRef({
    keyboardInset: 0,
    viewportHeight: null as number | null,
  });
  const playerHelpHintSeenRef = useRef(false);
  const playerHelpHintHideTimeoutRef = useRef<number | null>(null);
  const playerHelpHintIdleTimeoutRef = useRef<number | null>(null);

  const playSoundEffect = useCallback(
    (
      soundRef: { current: HTMLAudioElement | null },
      source: string,
      volume: number,
      onPlaybackFailure?: () => void
    ) => {
      const audio = soundRef.current ?? new Audio(source);
      if (!soundRef.current) {
        audio.preload = 'auto';
        soundRef.current = audio;
      }
      if (!audio.paused && !audio.ended) {
        return;
      }

      audioRef.current?.pause();
      if (soundRef !== giftSoundRef) {
        giftSoundRef.current?.pause();
      }
      if (soundRef !== activeTableSoundRef) {
        activeTableSoundRef.current?.pause();
      }
      if (soundRef !== notificationSoundRef) {
        notificationSoundRef.current?.pause();
      }
      audio.volume = volume;
      audio.currentTime = 0;
      void audio.play().catch(() => onPlaybackFailure?.());
    },
    []
  );

  const finishGiftSound = useCallback(() => {
    const shouldResumeTheme = resumeThemeAfterGiftRef.current;
    resumeThemeAfterGiftRef.current = false;

    if (showActiveTableSplashRef.current) {
      const tableAudio = activeTableSoundRef.current;
      if (tableAudio?.paused) {
        void tableAudio.play().catch(() => undefined);
      }
      return;
    }

    if (shouldResumeTheme) {
      resumeBackgroundMusicRef.current?.();
    }
  }, []);

  const playGiftSound = useCallback(() => {
    const now = Date.now();
    if (now - lastGiftSoundStartedAtRef.current < 600) {
      return;
    }
    lastGiftSoundStartedAtRef.current = now;
    resumeThemeAfterGiftRef.current = Boolean(
      musicEnabledRef.current && audioRef.current && !audioRef.current.paused
    );
    playSoundEffect(giftSoundRef, '/gift.mp3', 0.45, finishGiftSound);
  }, [finishGiftSound, playSoundEffect]);

  useEffect(() => {
    const audio = new Audio('/gift.mp3');
    audio.preload = 'auto';
    audio.addEventListener('ended', finishGiftSound);
    audio.addEventListener('error', finishGiftSound);
    giftSoundRef.current = audio;

    return () => {
      audio.removeEventListener('ended', finishGiftSound);
      audio.removeEventListener('error', finishGiftSound);
      audio.pause();
      audio.src = '';
      if (giftSoundRef.current === audio) {
        giftSoundRef.current = null;
      }
    };
  }, [finishGiftSound]);

  function hasActiveTableSplashHistoryState() {
    const state = window.history.state as Record<string, unknown> | null;
    return Boolean(state?.[ACTIVE_TABLE_SPLASH_HISTORY_KEY]);
  }

  const getActiveTableSound = useCallback(() => {
    if (!activeTableSoundRef.current) {
      const audio = new Audio('/play.mp3');
      audio.preload = 'auto';
      activeTableSoundRef.current = audio;
    }
    return activeTableSoundRef.current;
  }, []);

  const openActiveTableSplash = useCallback(async () => {
    const playAudio = getActiveTableSound();
    const themeWasPlaying = Boolean(
      musicEnabledRef.current && audioRef.current && !audioRef.current.paused
    );

    playAudio.loop = true;
    playAudio.volume = 0.4;
    playAudio.currentTime = 0;

    try {
      // play() must run in this click handler so the browser allows autoplay.
      await playAudio.play();
      if (themeWasPlaying) {
        audioRef.current?.pause();
        resumeThemeAfterTableRef.current = true;
      } else {
        resumeThemeAfterTableRef.current = false;
      }
    } catch (error) {
      console.error(error);
      resumeThemeAfterTableRef.current = false;
    }

    showActiveTableSplashRef.current = true;
    if (!activeTableHistoryOpenRef.current) {
      window.history.pushState(
        {
          ...(window.history.state || {}),
          [ACTIVE_TABLE_SPLASH_HISTORY_KEY]: true,
        },
        ''
      );
      activeTableHistoryOpenRef.current = true;
    }
    setIsPlayAmountEditable(false);
    setShowActiveTableSplash(true);
  }, [getActiveTableSound]);

  function closeActiveTableSplash(options?: { fromPopState?: boolean }) {
    const tableAudio = activeTableSoundRef.current;
    if (tableAudio) {
      tableAudio.pause();
      tableAudio.currentTime = 0;
    }

    const shouldResumeTheme = resumeThemeAfterTableRef.current;
    resumeThemeAfterTableRef.current = false;

    showActiveTableSplashRef.current = false;
    setShowActiveTableSplash(false);
    if (!options?.fromPopState && hasActiveTableSplashHistoryState()) {
      activeTableHistoryOpenRef.current = false;
      pwaBackHandledByOverlayRef.current = true;
      playerDevLog('[PLAYER_HISTORY_BACK]', {
        reason: 'close_active_table_splash',
        currentPath: window.location.pathname,
      });
      window.history.back();
    }

    if (shouldResumeTheme) {
      resumeBackgroundMusicRef.current?.();
    }
  }

  function nudgeActiveTableForKeyboard() {
    if (typeof window === 'undefined') {
      return;
    }
    window.setTimeout(() => {
      activeTableAmountInputRef.current?.scrollIntoView({
        block: 'center',
        behavior: 'smooth',
      });
    }, 120);
  }

  function updatePlayAmount(value: string) {
    setPlayAmount(sanitizeWholeAmountText(value));
  }

  function selectRecentPlayAmount(value: string) {
    updatePlayAmount(value);
    setIsPlayAmountEditable(false);
    activeTableAmountInputRef.current?.blur();
  }

  function loadRecentPlayAmountsFromStorage(key: string) {
    if (typeof window === 'undefined') {
      return [] as string[];
    }

    try {
      const parsed = JSON.parse(window.localStorage.getItem(key) || '[]');
      return normalizeRecentAmounts(Array.isArray(parsed) ? parsed.map(String) : []);
    } catch {
      return [];
    }
  }

  function saveRecentPlayAmount(taskType: PlayerGameRequestType, amountText: string) {
    if (typeof window === 'undefined') {
      return;
    }

    const amount = sanitizeWholeAmountText(amountText);
    if (!amount) {
      return;
    }

    const scopedKey = getRecentPlayAmountStorageKey(recentPlayAmountPlayerUid, recentPlayAmountGameId, taskType);
    const displayKey = getRecentPlayAmountStorageKey(recentPlayAmountPlayerUid, recentPlayAmountGameId);
    const nextScopedAmounts = normalizeRecentAmounts([
      amount,
      ...loadRecentPlayAmountsFromStorage(scopedKey),
    ]);
    const nextDisplayAmounts =
      displayKey === scopedKey
        ? nextScopedAmounts
        : normalizeRecentAmounts([amount, ...loadRecentPlayAmountsFromStorage(displayKey)]);

    try {
      window.localStorage.setItem(scopedKey, JSON.stringify(nextScopedAmounts));
      if (displayKey !== scopedKey) {
        window.localStorage.setItem(displayKey, JSON.stringify(nextDisplayAmounts));
      }
    } catch {
      // Keep the successful request flow intact if browser storage is unavailable.
    }
    setRecentPlayAmounts(nextDisplayAmounts);
  }

  function clearRecentPlayAmounts() {
    if (typeof window !== 'undefined') {
      const displayKey = getRecentPlayAmountStorageKey(recentPlayAmountPlayerUid, recentPlayAmountGameId);
      const rechargeKey = getRecentPlayAmountStorageKey(
        recentPlayAmountPlayerUid,
        recentPlayAmountGameId,
        'recharge'
      );
      const redeemKey = getRecentPlayAmountStorageKey(
        recentPlayAmountPlayerUid,
        recentPlayAmountGameId,
        'redeem'
      );
      try {
        [displayKey, rechargeKey, redeemKey].forEach((key) => window.localStorage.removeItem(key));
      } catch {
        // Clearing the input should still work if browser storage is unavailable.
      }
    }
    setRecentPlayAmounts([]);
    setPlayAmount('');
    setIsPlayAmountEditable(false);
  }

  useEffect(() => {
    showActiveTableSplashRef.current = showActiveTableSplash;
  }, [showActiveTableSplash]);

  useEffect(() => {
    // Keep one persistent /play.mp3 instance; do not play here (must start in click handler).
    const playAudio = getActiveTableSound();
    return () => {
      playAudio.pause();
      playAudio.currentTime = 0;
    };
  }, [getActiveTableSound]);

  const clearPlayerHelpHintHideTimeout = useCallback(() => {
    if (playerHelpHintHideTimeoutRef.current !== null) {
      window.clearTimeout(playerHelpHintHideTimeoutRef.current);
      playerHelpHintHideTimeoutRef.current = null;
    }
  }, []);

  const clearPlayerHelpHintIdleTimeout = useCallback(() => {
    if (playerHelpHintIdleTimeoutRef.current !== null) {
      window.clearTimeout(playerHelpHintIdleTimeoutRef.current);
      playerHelpHintIdleTimeoutRef.current = null;
    }
  }, []);

  const showPlayerHelpHintToast = useCallback(() => {
    playerHelpHintSeenRef.current = true;
    clearPlayerHelpHintHideTimeout();
    showPlayerHelpHintRef.current = true;
    setShowPlayerHelpHint(true);
    playerHelpHintHideTimeoutRef.current = window.setTimeout(() => {
      showPlayerHelpHintRef.current = false;
      setShowPlayerHelpHint(false);
      playerHelpHintHideTimeoutRef.current = null;
    }, 5000);
  }, [clearPlayerHelpHintHideTimeout]);

  const schedulePlayerHelpHintOnIdle = useCallback(() => {
    clearPlayerHelpHintIdleTimeout();
    playerHelpHintIdleTimeoutRef.current = window.setTimeout(() => {
      showPlayerHelpHintToast();
      playerHelpHintIdleTimeoutRef.current = null;
    }, 60000);
  }, [clearPlayerHelpHintIdleTimeout, showPlayerHelpHintToast]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const initialHintTimer = window.setTimeout(showPlayerHelpHintToast, 0);
    schedulePlayerHelpHintOnIdle();

    const handlePlayerActivity = () => {
      if (showPlayerHelpHintRef.current) {
        showPlayerHelpHintRef.current = false;
        setShowPlayerHelpHint(false);
      }
      clearPlayerHelpHintHideTimeout();
      schedulePlayerHelpHintOnIdle();
    };

    const options: AddEventListenerOptions = { passive: true };
    window.addEventListener('pointerdown', handlePlayerActivity, options);
    window.addEventListener('keydown', handlePlayerActivity, options);
    window.addEventListener('touchstart', handlePlayerActivity, options);

    return () => {
      window.removeEventListener('pointerdown', handlePlayerActivity);
      window.removeEventListener('keydown', handlePlayerActivity);
      window.removeEventListener('touchstart', handlePlayerActivity);
      window.clearTimeout(initialHintTimer);
      clearPlayerHelpHintHideTimeout();
      clearPlayerHelpHintIdleTimeout();
    };
  }, [
    clearPlayerHelpHintHideTimeout,
    clearPlayerHelpHintIdleTimeout,
    schedulePlayerHelpHintOnIdle,
    showPlayerHelpHintToast,
  ]);

  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }

    const pageNode = pageScrollRef.current;
    const bodyStyle = document.body.style;
    const docStyle = document.documentElement.style;
    const previousBodyOverflow = bodyStyle.overflow;
    const previousDocOverflow = docStyle.overflow;
    const previousPageOverflowY = pageNode?.style.overflowY ?? '';
    const previousPageTouchAction = pageNode?.style.touchAction ?? '';

    if (mobileMenuOpen) {
      bodyStyle.overflow = 'hidden';
      docStyle.overflow = 'hidden';
      if (pageNode) {
        pageNode.style.overflowY = 'hidden';
        pageNode.style.touchAction = 'none';
      }
    }

    return () => {
      bodyStyle.overflow = previousBodyOverflow;
      docStyle.overflow = previousDocOverflow;
      if (pageNode) {
        pageNode.style.overflowY = previousPageOverflowY;
        pageNode.style.touchAction = previousPageTouchAction;
      }
    };
  }, [mobileMenuOpen]);

  useEffect(() => {
    const onPopState = () => {
      if (!showActiveTableSplashRef.current && !activeTableHistoryOpenRef.current) {
        return;
      }
      pwaBackHandledByOverlayRef.current = true;
      activeTableHistoryOpenRef.current = false;
      closeActiveTableSplash({ fromPopState: true });
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    activeViewRef.current = activeView;
  }, [activeView]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }
    if (window.location.pathname !== '/player') {
      return undefined;
    }

    playerDebugLog('[PWA_BACK] player back guard enabled', {
      standalone: isStandaloneMode(),
      android: isAndroidDevice(),
    });

    const hasExitGuardState = () => {
      const state = window.history.state as Record<string, unknown> | null;
      return Boolean(state?.[PLAYER_PWA_EXIT_GUARD_HISTORY_KEY]);
    };

    const pushExitGuardState = () => {
      if (pwaExitConfirmedRef.current) {
        return;
      }
      window.history.pushState(
        {
          ...(window.history.state as Record<string, unknown> | null),
          [PLAYER_PWA_EXIT_GUARD_HISTORY_KEY]: true,
        },
        '',
        window.location.href
      );
      playerDebugLog('[PWA_BACK] guard pushed');
    };

    const getPreviousPlayerSection = (view: PlayerView) => {
      const currentIndex = PLAYER_BACK_NAVIGATION_ORDER.indexOf(view);
      if (currentIndex <= 0) {
        return null;
      }
      return PLAYER_BACK_NAVIGATION_ORDER[currentIndex - 1];
    };

    const navigateToPreviousPlayerSection = () => {
      const fromSection = activeViewRef.current;
      const toSection = getPreviousPlayerSection(fromSection);
      if (!toSection) {
        return false;
      }

      playerDevLog('[PLAYER_BACK_NAVIGATION]', {
        fromSection,
        toSection,
      });
      setActiveView(toSection);
      setMobileMenuOpen(false);
      requestAnimationFrame(() => {
        pageScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
      return true;
    };

    const closeTopPlayerOverlay = () => {
      if (showPwaExitConfirm) {
        return true;
      }
      if (showActiveTableSplashRef.current) {
        closeActiveTableSplash({ fromPopState: true });
        return true;
      }
      if (mobileMenuOpen) {
        setMobileMenuOpen(false);
        return true;
      }
      if (showCoinConfirmSplash && !coinLoading) {
        setShowCoinConfirmSplash(false);
        return true;
      }
      if (showCashoutModal) {
        setShowCashoutModal(false);
        return true;
      }
      if (showLoadCoinPanel) {
        setShowLoadCoinPanel(false);
        return true;
      }
      if (credentialResetModal) {
        setCredentialResetModal(null);
        return true;
      }
      if (showPlayerPasswordResetModal) {
        setShowPlayerPasswordResetModal(false);
        return true;
      }
      if (showLogoutConfirmSplash && !logoutLoading) {
        setShowLogoutConfirmSplash(false);
        setLogoutConfirmSource(null);
        return true;
      }
      if (bonusErrorSplashMessage) {
        setBonusErrorSplashMessage('');
        return true;
      }
      if (earnedRewardSplashCoins !== null) {
        setEarnedRewardSplashCoins(null);
        return true;
      }
      if (redeemDismissSplashRequest && !dismissRedeemLoadingId) {
        setRedeemDismissSplashRequest(null);
        return true;
      }
      if (showCashoutSuccessSplash) {
        setShowCashoutSuccessSplash(false);
        setShowCashoutInquiryPanel(false);
        return true;
      }
      if (showIosGuide) {
        closeIosGuide();
        return true;
      }
      return false;
    };

    if (!hasExitGuardState()) {
      pushExitGuardState();
    }

    const onPlayerPwaBack = () => {
      playerDebugLog('[PWA_BACK] popstate', {
        hasGuardState: hasExitGuardState(),
        pathname: window.location.pathname,
      });

      if (pwaExitConfirmedRef.current) {
        return;
      }

      if (pwaBackHandledByOverlayRef.current) {
        pwaBackHandledByOverlayRef.current = false;
        playerDebugLog('[PWA_BACK] modal/menu open close-first');
        pushExitGuardState();
        return;
      }

      if (window.location.pathname !== '/player') {
        return;
      }

      if (closeTopPlayerOverlay()) {
        playerDebugLog('[PWA_BACK] modal/menu open close-first');
        pushExitGuardState();
        return;
      }

      if (navigateToPreviousPlayerSection()) {
        pushExitGuardState();
        return;
      }

      pushExitGuardState();
      setShowPwaExitConfirm(true);
      playerDebugLog('[PLAYER_BACK_EXIT_MODAL]', {
        section: 'lobby',
      });
      playerDebugLog('[BEFORE_UNLOAD_TRIGGERED]', {
        reason: 'pwa_back_no_overlay',
        currentPath: window.location.pathname,
      });
      playerDebugLog('[PWA_BACK] exit confirm shown');
    };

    window.addEventListener('popstate', onPlayerPwaBack);
    return () => {
      window.removeEventListener('popstate', onPlayerPwaBack);
    };
  }, [
    closeIosGuide,
    bonusErrorSplashMessage,
    coinLoading,
    dismissRedeemLoadingId,
    earnedRewardSplashCoins,
    logoutLoading,
    mobileMenuOpen,
    redeemDismissSplashRequest,
    showCashoutModal,
    showCashoutSuccessSplash,
    showCoinConfirmSplash,
    showIosGuide,
    showLoadCoinPanel,
    showLogoutConfirmSplash,
    showPlayerPasswordResetModal,
    showPwaExitConfirm,
    credentialResetModal,
  ]);

  useEffect(() => {
    if (!showActiveTableSplash) {
      if (activeTableViewportMetricsRef.current.keyboardInset !== 0) {
        activeTableViewportMetricsRef.current.keyboardInset = 0;
        setActiveTableKeyboardInset(0);
      }
      if (activeTableViewportMetricsRef.current.viewportHeight !== null) {
        activeTableViewportMetricsRef.current.viewportHeight = null;
        setActiveTableViewportHeight(null);
      }
      return;
    }
    if (typeof window === 'undefined') {
      return;
    }

    const vv = window.visualViewport;
    if (!vv) {
      return;
    }

    let rafId: number | null = null;

    const measureViewportMetrics = () => {
      rafId = null;
      const viewportHeight = Math.round(vv.height);
      const keyboardInset = Math.max(
        0,
        Math.round(window.innerHeight - (vv.height + vv.offsetTop))
      );

      if (activeTableViewportMetricsRef.current.viewportHeight !== viewportHeight) {
        activeTableViewportMetricsRef.current.viewportHeight = viewportHeight;
        setActiveTableViewportHeight(viewportHeight);
      }
      if (activeTableViewportMetricsRef.current.keyboardInset !== keyboardInset) {
        activeTableViewportMetricsRef.current.keyboardInset = keyboardInset;
        setActiveTableKeyboardInset(keyboardInset);
      }
    };

    const updateViewportMetrics = () => {
      if (rafId !== null) {
        return;
      }
      rafId = window.requestAnimationFrame(measureViewportMetrics);
    };

    updateViewportMetrics();
    vv.addEventListener('resize', updateViewportMetrics, { passive: true });
    vv.addEventListener('scroll', updateViewportMetrics, { passive: true });
    window.addEventListener('orientationchange', updateViewportMetrics, { passive: true });

    return () => {
      vv.removeEventListener('resize', updateViewportMetrics);
      vv.removeEventListener('scroll', updateViewportMetrics);
      window.removeEventListener('orientationchange', updateViewportMetrics);
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, [showActiveTableSplash]);
  const selfClaimedBonusIdRef = useRef<string | null>(null);
  const lastBonusIdsRef = useRef<string[]>([]);
  const panelSwipeStartRef = useRef<{ x: number; y: number } | null>(null);
  const currentTrackRef = useRef<string | null>(null);
  const playRandomTrackRef = useRef<((previousTrack?: string | null) => Promise<void>) | null>(null);
  const interactionListenerCleanupRef = useRef<null | (() => void)>(null);
  const autoplayRetryTimeoutRef = useRef<number | null>(null);
  const musicControllerMountedRef = useRef(true);
  const pageVisibleRef = useRef(true);
  const audioUnlockedRef = useRef(false);

  const formatWalletAmount = useCallback((value: number) => {
    return new Intl.NumberFormat('en-US').format(value);
  }, []);

  const totalUnread = agents.reduce((total, agent) => {
    return total + (unreadCounts[agent.uid] || 0);
  }, 0);
  const shouldLoadAgentPresence = activeView === 'agents' || Boolean(selectedAgent);
  const agentPresenceUids = useMemo(
    () => (shouldLoadAgentPresence ? agents.map((a) => a.uid) : []),
    [agents, shouldLoadAgentPresence]
  );
  const agentOnlineByUid = usePresenceOnlineMap(agentPresenceUids);
  const playerBonusEvents = useMemo(
    () => getBonusEventsForPlayerDisplay(bonusEvents),
    [bonusEvents]
  );
  const shouldListenToBonusEvents =
    Boolean(playerCoadminUid) && activeView === 'bonus-events';
  const shouldPollPlayData =
    activeView === 'play' || activeView === 'usernames';

  useEffect(() => {
    if (!isPlayerRole) {
      return;
    }
    return startPlayerRequestSummaryReporter();
  }, [isPlayerRole]);

  useEffect(() => {
    return () => {
      [activeTableSoundRef, notificationSoundRef].forEach((soundRef) => {
        const audio = soundRef.current;
        if (!audio) {
          return;
        }
        audio.pause();
        audio.onended = null;
        audio.onerror = null;
        audio.src = '';
        soundRef.current = null;
      });
    };
  }, []);

  const buildCoadminFrontendLinkMap = useCallback((coadminGames: Array<{ gameName?: string; frontendUrl?: string }>) => {
    const nextMap: Record<string, string> = {};
    for (const game of coadminGames) {
      const key = normalizeBackgroundKey(String(game.gameName || ''));
      const frontendLink = normalizeExternalUrl(game.frontendUrl || '');
      if (!key || !frontendLink) {
        continue;
      }
      nextMap[key] = frontendLink;
    }
    return nextMap;
  }, []);

  const shouldSkipIndividualLoader = useCallback(
    (loader: 'staff' | 'freeplay' | 'referral' | 'gameLogins', force = false) => {
      if (force) {
        return false;
      }
      if (baseDataLoadedRef.current) {
        playerDevLog('[PLAYER_INDIVIDUAL_LOADER_SKIP]', {
          loader,
          reason: 'base_data_loaded',
        });
        return true;
      }
      return false;
    },
    []
  );

  const loadCoadminGameLogins = useCallback(
    async (coadminUid: string, options: { force?: boolean } = {}) => {
      if (shouldSkipIndividualLoader('gameLogins', options.force)) {
        return [];
      }
      return getGameLoginsByCoadmin(coadminUid);
    },
    [shouldSkipIndividualLoader]
  );

  const selectedGameBackgroundImage = useMemo(() => {
    return getGameBackgroundImage(gameBackgroundImageByKey, selectedGameName);
  }, [gameBackgroundImageByKey, selectedGameName]);

  const selectedGameLogin = useMemo(() => {
    const selectedKey = normalizeGameKey(selectedGameName);
    if (!selectedKey) {
      return null;
    }

    return (
      gameLogins.find((login) => normalizeGameKey(String(login.gameName || '')) === selectedKey) ||
      null
    );
  }, [gameLogins, selectedGameName]);

  const recentPlayAmountPlayerUid = playerUid || auth.currentUser?.uid || '';
  const recentPlayAmountGameId = selectedGameLogin?.id || normalizeGameKey(selectedGameName);
  const recentPlayAmountStorageKey = getRecentPlayAmountStorageKey(
    recentPlayAmountPlayerUid,
    recentPlayAmountGameId
  );

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setRecentPlayAmounts(loadRecentPlayAmountsFromStorage(recentPlayAmountStorageKey));
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [recentPlayAmountStorageKey]);

  const activeBonusCarouselIndex = useMemo(() => {
    if (playerBonusEvents.length === 0) {
      return 0;
    }

    return Math.min(bonusCarouselIndex, Math.max(0, playerBonusEvents.length - 1));
  }, [bonusCarouselIndex, playerBonusEvents.length]);

  const lastUsedQrCashout = useMemo(() => {
    return playerCashoutTasks
      .map((task) => ({ task, payment: getPlayerCashoutPaymentDisplay(task) }))
      .find(({ payment }) => payment.method === 'qr' && payment.qrImageUrl);
  }, [playerCashoutTasks]);

  const lastUsedAppCashout = useMemo(() => {
    return playerCashoutTasks
      .map((task) => ({ task, payment: getPlayerCashoutPaymentDisplay(task) }))
      .find(
        ({ payment }) =>
          payment.method === 'app' &&
          payment.paymentAppName &&
          payment.paymentAppCashTag &&
          payment.paymentAppAccountName
      );
  }, [playerCashoutTasks]);

  const lastUsableSavedCashout = useMemo(() => {
    const candidates = [lastUsedQrCashout, lastUsedAppCashout].filter(
      (
        entry
      ): entry is NonNullable<typeof lastUsedQrCashout> | NonNullable<typeof lastUsedAppCashout> =>
        Boolean(entry)
    );
    if (candidates.length === 0) {
      return null;
    }
    return candidates.reduce((best, entry) => {
      const bestMs = Math.max(
        getTimestampMs(best.task.completedAt),
        getTimestampMs(best.task.createdAt)
      );
      const entryMs = Math.max(
        getTimestampMs(entry.task.completedAt),
        getTimestampMs(entry.task.createdAt)
      );
      return entryMs >= bestMs ? entry : best;
    });
  }, [lastUsedAppCashout, lastUsedQrCashout]);

  const rollingCashoutUsedNpr = useMemo(
    () => rolling24hCashoutUsageNprFromTasks(playerCashoutTasks),
    [playerCashoutTasks]
  );

  const cashoutRemainingQuotaNpr = Math.max(
    0,
    PLAYER_CASHOUT_MAX_NPR_PER_24_H - rollingCashoutUsedNpr
  );
  const cashoutLimitHitForCashToCoin =
    rollingCashoutUsedNpr >= PLAYER_CASHOUT_MAX_NPR_PER_24_H;

  const cashoutThisRequestNpr = Math.min(Number(wallet.cash || 0), cashoutRemainingQuotaNpr);
  const transferCoinAmount = Number(transferCoinAmountInput);
  const isCashToCoinTransfer = playerTransferDirection === 'cash_to_coin';
  const transferCoinToCashTip = !isCashToCoinTransfer && Number.isFinite(transferCoinAmount)
    ? getCoinToCashTip(transferCoinAmount)
    : 0;
  const transferCashToCoinFee = isCashToCoinTransfer && Number.isFinite(transferCoinAmount)
    ? cashoutLimitHitForCashToCoin
      ? getCashToCoinCashoutLimitFee(transferCoinAmount)
      : getCashToCoinFee(transferCoinAmount)
    : 0;
  const transferCoinReceived = isCashToCoinTransfer && Number.isFinite(transferCoinAmount)
    ? Math.max(0, transferCoinAmount - transferCashToCoinFee)
    : 0;
  const transferCashReceived = !isCashToCoinTransfer && Number.isFinite(transferCoinAmount)
    ? Math.max(0, transferCoinAmount - transferCoinToCashTip)
    : 0;
  const transferSourceBalance = isCashToCoinTransfer
    ? Number(wallet.cash || 0)
    : Number(wallet.coin || 0);
  const isTransferCoinWholeNumber =
    transferCoinAmountInput.trim() !== '' &&
    Number.isFinite(transferCoinAmount) &&
    transferCoinAmount === Math.floor(transferCoinAmount);
  const transferCoinValidationMessage = !transferCoinAmountInput.trim()
    ? ''
    : !isTransferCoinWholeNumber
      ? 'Amount must be a whole number.'
      : isCashToCoinTransfer &&
          !cashoutLimitHitForCashToCoin &&
          transferCoinAmount > CASH_TO_COIN_MAX_TRANSFER_AMOUNT
        ? 'Maximum transfer amount is $25.'
      : !isCashToCoinTransfer && transferCoinAmount < 10
        ? 'Minimum Coin to Cash amount is 10.'
      : transferCoinAmount > transferSourceBalance
          ? `Amount cannot exceed your current ${isCashToCoinTransfer ? 'cash' : 'coin'} balance.`
          : isCashToCoinTransfer && transferCoinReceived <= 0
            ? 'Coins you receive must be greater than zero.'
            : !isCashToCoinTransfer && transferCashReceived <= 0
              ? 'Cash you receive must be greater than zero after tip.'
            : '';
  const canConfirmCashToCoinTransfer =
    isTransferCoinWholeNumber &&
    (!isCashToCoinTransfer ||
      cashoutLimitHitForCashToCoin ||
      transferCoinAmount <= CASH_TO_COIN_MAX_TRANSFER_AMOUNT) &&
    (isCashToCoinTransfer || transferCoinAmount >= 10) &&
    transferCoinAmount <= transferSourceBalance &&
    (isCashToCoinTransfer ? transferCoinReceived > 0 : transferCashReceived > 0) &&
    !coinLoading &&
    !maintenanceBreak.enabled;

  useEffect(() => {
    let isCancelled = false;

    async function loadGameBackgrounds() {
      try {
        const response = await fetch('/api/player/game-backgrounds');
        if (!response.ok) {
          return;
        }
        const payload = (await response.json()) as { backgrounds?: GameBackgroundAsset[] };
        const nextMap: Record<string, string> = { ...GAME_BACKGROUND_IMAGE_BY_KEY };
        for (const item of payload.backgrounds || []) {
          const key = normalizeBackgroundKey(item.key);
          if (!key) {
            continue;
          }
          const imageUrl = String(item.imageUrl || '').trim();
          if (imageUrl.endsWith('.png')) {
            nextMap[key] = imageUrl;
          }
        }
        if (!isCancelled) {
          setGameBackgroundImageByKey(nextMap);
        }
      } catch {
        if (!isCancelled) {
          setGameBackgroundImageByKey(GAME_BACKGROUND_IMAGE_BY_KEY);
        }
      }
    }

    void loadGameBackgrounds();
    return () => {
      isCancelled = true;
    };
  }, []);

  useEffect(() => {
    const nextIds = playerBonusEvents.map((e) => e.id);
    const previous = lastBonusIdsRef.current;
    if (previous.length > 0) {
      for (const id of previous) {
        if (!nextIds.includes(id)) {
          if (selfClaimedBonusIdRef.current === id) {
            selfClaimedBonusIdRef.current = null;
          } else {
            setBonusVanishedToast(true);
            window.setTimeout(() => setBonusVanishedToast(false), 4500);
          }
          break;
        }
      }
    }
    lastBonusIdsRef.current = nextIds;
  }, [playerBonusEvents]);

  useEffect(() => {
    pageLoadAtRef.current = Date.now();
    bootOutboxCursorRef.current = null;
    setMessage('');
    setSuccessSplashMessage(null);
    setRedeemDismissSplashRequest(null);
    setBonusVanishedToast(false);
  }, []);

  useEffect(() => {
    if (!playerUid) {
      hasHydratedRequestHistoryRef.current = false;
      bootOutboxCursorRef.current = null;
      knownRechargeRequestStatusByIdRef.current = {};
      seenCompletedRechargeSplashIdsRef.current = new Set();
      seenDismissedRechargeSplashIdsRef.current = new Set();
      knownRedeemRequestStatusByIdRef.current = {};
      seenDismissedRedeemSplashIdsRef.current = new Set();
      seenCompletedRedeemSplashIdsRef.current = new Set();
      seenRequestOutcomeKeysRef.current = new Set();
      return;
    }

    const seenState = loadPlayerPopupSeenState(playerUid);
    seenRequestOutcomeKeysRef.current = seenState.outcomeKeys;
    seenCompletedRechargeSplashIdsRef.current = new Set(seenState.rechargeSplashIds);
    seenDismissedRechargeSplashIdsRef.current = new Set(seenState.rechargeSplashIds);
    seenCompletedRedeemSplashIdsRef.current = new Set(seenState.redeemSplashIds);
    seenDismissedRedeemSplashIdsRef.current = new Set(seenState.redeemSplashIds);
    hasHydratedRequestHistoryRef.current = false;
  }, [playerUid]);

  const persistRechargeSplashSeenIds = useCallback((playerUidValue: string) => {
    persistStoredStringSet(
      playerSeenRechargeSplashIdsStorageKey(playerUidValue),
      mergeRechargeSplashSeenSets(
        seenCompletedRechargeSplashIdsRef.current,
        seenDismissedRechargeSplashIdsRef.current
      )
    );
  }, []);

  const persistRedeemSplashSeenIds = useCallback((playerUidValue: string) => {
    persistStoredStringSet(
      playerSeenRedeemSplashIdsStorageKey(playerUidValue),
      mergeRedeemSplashSeenSets(
        seenCompletedRedeemSplashIdsRef.current,
        seenDismissedRedeemSplashIdsRef.current
      )
    );
  }, []);

  const markOutcomeSeen = useCallback((playerUidValue: string, outcomeKey: string) => {
    seenRequestOutcomeKeysRef.current.add(outcomeKey);
    persistStoredStringSet(
      playerSeenOutcomeKeysStorageKey(playerUidValue),
      seenRequestOutcomeKeysRef.current
    );
  }, []);

  const markRechargeSplashSeen = useCallback(
    (playerUidValue: string, requestId: string) => {
      seenCompletedRechargeSplashIdsRef.current.add(requestId);
      seenDismissedRechargeSplashIdsRef.current.add(requestId);
      persistRechargeSplashSeenIds(playerUidValue);
    },
    [persistRechargeSplashSeenIds]
  );

  const markRedeemSplashSeen = useCallback(
    (playerUidValue: string, requestId: string) => {
      seenCompletedRedeemSplashIdsRef.current.add(requestId);
      seenDismissedRedeemSplashIdsRef.current.add(requestId);
      persistRedeemSplashSeenIds(playerUidValue);
    },
    [persistRedeemSplashSeenIds]
  );

  const isStaleLivePopupEvent = useCallback(
    (outboxId?: number, eventAtMs?: number) => {
      const bootOutboxCursor = bootOutboxCursorRef.current;
      if (
        bootOutboxCursor !== null &&
        outboxId !== undefined &&
        outboxId > 0 &&
        outboxId <= bootOutboxCursor
      ) {
        return true;
      }
      if (
        eventAtMs !== undefined &&
        Number.isFinite(eventAtMs) &&
        eventAtMs < pageLoadAtRef.current
      ) {
        return true;
      }
      return false;
    },
    []
  );

  const requestHistoryDisplayLimit = lowPerformanceMode
    ? LOW_PERFORMANCE_REQUEST_HISTORY_DISPLAY
    : MAX_REQUEST_HISTORY_DISPLAY;
  const displayedRequestHistory = useMemo(
    () => requestHistory.slice(0, requestHistoryDisplayLimit),
    [requestHistory, requestHistoryDisplayLimit]
  );

  function requestNeedsPlayerExit(request: PlayerGameRequest) {
    return (
      request.type === 'redeem' &&
      (request.status === 'waiting_player_exit' ||
        String(request.automationStatus || '').trim().toUpperCase() === 'PLAYER_ACTIVE_IN_GAME')
    );
  }

  useEffect(() => {
    if (!playerUid) {
      return;
    }

    const nextRechargeStatusById: Record<string, PlayerGameRequest['status']> = {};
    const nextRedeemStatusById: Record<string, PlayerGameRequest['status']> = {};

    for (const request of requestHistory) {
      if (request.type === 'recharge') {
        nextRechargeStatusById[request.id] = request.status;
      } else if (request.type === 'redeem') {
        nextRedeemStatusById[request.id] = request.status;
      }
    }

    if (!hasHydratedRequestHistoryRef.current) {
      knownRechargeRequestStatusByIdRef.current = nextRechargeStatusById;
      knownRedeemRequestStatusByIdRef.current = nextRedeemStatusById;
      hasHydratedRequestHistoryRef.current = true;
      return;
    }

    for (const request of requestHistory) {
      if (request.type === 'recharge') {
        const previousStatus = knownRechargeRequestStatusByIdRef.current[request.id];
        const justCompleted =
          request.status === 'completed' &&
          previousStatus !== undefined &&
          previousStatus !== 'completed';

        if (justCompleted && !seenCompletedRechargeSplashIdsRef.current.has(request.id)) {
          playerDevLog('[PLAYER_RECHARGE_SUCCESS_TOAST_SHOW]', {
            requestId: request.id,
            source: 'request_history_transition',
          });
          showSuccessSplash(PLAYER_RECHARGE_SUCCESS_MESSAGE);
          markRechargeSplashSeen(playerUid, request.id);
        }

        const justBlockedByKnownGameFailure =
          request.status === 'dismissed' &&
          previousStatus !== undefined &&
          previousStatus !== 'dismissed' &&
          (requestMatchesMidnightPartyDismiss(request) ||
            requestMatchesPlayerInGameDismiss(request));

        if (
          justBlockedByKnownGameFailure &&
          !seenDismissedRechargeSplashIdsRef.current.has(request.id)
        ) {
          if (requestMatchesPlayerInGameDismiss(request)) {
            playerDevLog('[PLAYER_IN_GAME_SPLASH_SHOW]', {
              requestId: request.id,
              source: 'request_history_transition',
              message: playerInGameDismissSplashMessage({
                requestType: request.type,
                pokeMessage: request.pokeMessage,
                dismissReasonMessage: request.dismissReasonMessage,
                refunded: request.coinRefundedOnDismissal === true ? true : undefined,
              }),
            });
          } else {
            playerDevLog('[PLAYER_TOAST_SHOW]', {
              requestId: request.id,
              source: 'request_history_transition',
              pokeMessage: request.pokeMessage || null,
              dismissReasonCode: request.dismissReasonCode || null,
              midnightParty: true,
            });
          }
          setRedeemDismissSplashRequest(request);
          markRechargeSplashSeen(playerUid, request.id);
        }
      }

      if (request.type !== 'redeem') {
        continue;
      }

      const previousStatus = knownRedeemRequestStatusByIdRef.current[request.id];
      const justCompleted =
        request.status === 'completed' &&
        previousStatus !== undefined &&
        previousStatus !== 'completed';

      if (justCompleted && !seenCompletedRedeemSplashIdsRef.current.has(request.id)) {
        playerDevLog('[PLAYER_REQUEST_OUTCOME_TOAST_SHOW]', {
          requestId: request.id,
          source: 'request_history_transition',
          outcomeType: 'redeem_completed',
          message: PLAYER_REDEEM_SUCCESS_MESSAGE,
        });
        showSuccessSplash(PLAYER_REDEEM_SUCCESS_MESSAGE);
        markRedeemSplashSeen(playerUid, request.id);
      }

      const justDismissed =
        previousStatus !== undefined &&
        previousStatus !== 'dismissed' &&
        request.status === 'dismissed';
      const shouldShowDismissSplash =
        justDismissed && !seenDismissedRedeemSplashIdsRef.current.has(request.id);

      if (shouldShowDismissSplash) {
        if (requestMatchesFakeRedeemDismiss(request)) {
          playerDevLog('[PLAYER_REDEEM_DISMISS_TOAST_SHOW]', {
            requestId: request.id,
            source: 'request_history_transition',
            message: fakeRedeemDismissSplashMessage(request),
          });
        } else if (requestMatchesPlayerInGameDismiss(request)) {
          playerDevLog('[PLAYER_IN_GAME_SPLASH_SHOW]', {
            requestId: request.id,
            source: 'request_history_transition',
            message: playerInGameDismissSplashMessage({
              requestType: request.type,
              pokeMessage: request.pokeMessage,
              dismissReasonMessage: request.dismissReasonMessage,
            }),
          });
        }
        setRedeemDismissSplashRequest(request);
        markRedeemSplashSeen(playerUid, request.id);
      }
    }

    knownRechargeRequestStatusByIdRef.current = nextRechargeStatusById;
    knownRedeemRequestStatusByIdRef.current = nextRedeemStatusById;
  }, [playerUid, requestHistory, markRechargeSplashSeen, markRedeemSplashSeen]);

  const usernamesCreatorFilterKeys = useMemo(() => {
    const uidSet = new Set<string>();
    let hasMissingCreator = false;

    for (const login of gameLogins) {
      const uid = String(login.createdBy || '').trim();
      if (uid) {
        uidSet.add(uid);
      } else {
        hasMissingCreator = true;
      }
    }

    const sortedUids = [...uidSet].sort((left, right) =>
      (creatorNames[left] || left).localeCompare(creatorNames[right] || right)
    );

    return { sortedUids, hasMissingCreator };
  }, [gameLogins, creatorNames]);

  const usernamesVisibleLogins = useMemo(() => {
    if (!selectedCreatorUid) {
      return gameLogins;
    }

    if (selectedCreatorUid === UNKNOWN_CREATOR_FILTER_KEY) {
      return gameLogins.filter((login) => !String(login.createdBy || '').trim());
    }

    return gameLogins.filter(
      (login) => String(login.createdBy || '').trim() === selectedCreatorUid
    );
  }, [gameLogins, selectedCreatorUid]);

  const playerAlert = useMemo(() => getPlayerAlertInfo(message), [message]);
  const isTimedSplashAlert = Boolean(playerAlert && playerAlert.variant !== 'index');
  const isMidnightPartyDismissSplash =
    redeemDismissSplashRequest?.type === 'recharge' &&
    requestMatchesMidnightPartyDismiss(redeemDismissSplashRequest);
  const isFakeRedeemDismissSplash =
    redeemDismissSplashRequest?.type === 'redeem' &&
    redeemDismissSplashRequest?.status === 'dismissed' &&
    requestMatchesFakeRedeemDismiss(redeemDismissSplashRequest);
  const isPlayerInGameDismissSplash =
    redeemDismissSplashRequest?.status === 'dismissed' &&
    requestMatchesPlayerInGameDismiss(redeemDismissSplashRequest);
  const midnightPartyDismissMessage = redeemDismissSplashRequest
    ? midnightPartyDismissSplashMessage(redeemDismissSplashRequest)
    : GAME_VAULT_MIDNIGHT_PARTY_PLAYER_MESSAGE;
  const fakeRedeemDismissMessage = redeemDismissSplashRequest
    ? fakeRedeemDismissSplashMessage(redeemDismissSplashRequest)
    : '';
  const playerInGameDismissMessage = redeemDismissSplashRequest
    ? playerInGameDismissSplashMessage({
        requestType: redeemDismissSplashRequest.type,
        pokeMessage: redeemDismissSplashRequest.pokeMessage,
        dismissReasonMessage: redeemDismissSplashRequest.dismissReasonMessage,
      })
    : '';

  useEffect(() => {
    if (!isTimedSplashAlert) {
      return undefined;
    }

    const timeoutId = window.setTimeout(() => {
      setMessage('');
    }, 1300);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [isTimedSplashAlert, message]);

  const chooseRandomTrack = useCallback((previousTrack?: string | null) => {
    if (CASINO_BACKGROUND_TRACKS.length <= 1) {
      return CASINO_BACKGROUND_TRACKS[0];
    }

    const eligibleTracks = CASINO_BACKGROUND_TRACKS.filter((track) => track !== previousTrack);
    return eligibleTracks[Math.floor(Math.random() * eligibleTracks.length)] || CASINO_BACKGROUND_TRACKS[0];
  }, []);

  const clearInteractionListener = useCallback(() => {
    interactionListenerCleanupRef.current?.();
    interactionListenerCleanupRef.current = null;
  }, []);

  const clearAutoplayRetry = useCallback(() => {
    if (autoplayRetryTimeoutRef.current !== null) {
      window.clearTimeout(autoplayRetryTimeoutRef.current);
      autoplayRetryTimeoutRef.current = null;
    }
  }, []);

  const cleanupAudioElement = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    audio.pause();
    audio.onended = null;
    audio.onerror = null;
    audio.src = '';
    audioRef.current = null;
  }, []);

  const playCurrentAudio = useCallback(async () => {
    const audio = audioRef.current;
    if (
      !audio ||
      !musicControllerMountedRef.current ||
      !musicEnabledRef.current ||
      !pageVisibleRef.current ||
      showActiveTableSplashRef.current
    ) {
      return false;
    }
    if (
      !playerThemeRouteGuard({
        currentPath: typeof window === 'undefined' ? '' : window.location.pathname,
        resolvedRole: resolvedPlayerRole,
        audioTheme: 'player',
      })
    ) {
      audio.pause();
      return false;
    }

    try {
      stopWrongPlayerRouteThemeAudio(CASINO_BACKGROUND_TRACKS);
      stopDuplicatePlayerThemeAudio(audio, CASINO_BACKGROUND_TRACKS);
      if (!audio.paused && !audio.ended) {
        audioUnlockedRef.current = true;
        clearInteractionListener();
        clearAutoplayRetry();
        return true;
      }
      giftSoundRef.current?.pause();
      activeTableSoundRef.current?.pause();
      notificationSoundRef.current?.pause();
      audio.volume = DEFAULT_PLAYER_MUSIC_VOLUME;
      await audio.play();
      audioUnlockedRef.current = true;
      clearInteractionListener();
      clearAutoplayRetry();
      return true;
    } catch {
      return false;
    }
  }, [clearAutoplayRetry, clearInteractionListener, resolvedPlayerRole]);

  useEffect(() => {
    resumeBackgroundMusicRef.current = () => {
      void playCurrentAudio();
    };
    return () => {
      resumeBackgroundMusicRef.current = null;
    };
  }, [playCurrentAudio]);

  const attachInteractionListener = useCallback(() => {
    if (interactionListenerCleanupRef.current || typeof window === 'undefined') {
      return;
    }

    const handleInteraction = () => {
      const audio = audioRef.current;
      if (
        !musicControllerMountedRef.current ||
        !musicEnabledRef.current ||
        !audio ||
        !audio.paused
      ) {
        return;
      }
      void playCurrentAudio();
    };

    const options: AddEventListenerOptions = { passive: true };
    window.addEventListener('pointerdown', handleInteraction, options);
    window.addEventListener('touchstart', handleInteraction, options);
    window.addEventListener('click', handleInteraction, options);
    interactionListenerCleanupRef.current = () => {
      window.removeEventListener('pointerdown', handleInteraction);
      window.removeEventListener('touchstart', handleInteraction);
      window.removeEventListener('click', handleInteraction);
    };
  }, [playCurrentAudio]);

  const playRandomTrack = useCallback(
    async (previousTrack?: string | null) => {
      if (!musicControllerMountedRef.current || !musicEnabledRef.current) {
        return;
      }
      if (
        !playerThemeRouteGuard({
          currentPath: typeof window === 'undefined' ? '' : window.location.pathname,
          resolvedRole: resolvedPlayerRole,
          audioTheme: 'player',
        })
      ) {
        clearInteractionListener();
        clearAutoplayRetry();
        cleanupAudioElement();
        return;
      }

      clearAutoplayRetry();
      cleanupAudioElement();

      const nextTrack = chooseRandomTrack(previousTrack ?? currentTrackRef.current);
      const audio = new Audio(nextTrack);
      tagPlayerThemeAudio(audio);
      audio.volume = DEFAULT_PLAYER_MUSIC_VOLUME;
      audio.preload = 'auto';
      audio.loop = true;
      audio.onended = () => {
        if (!musicEnabledRef.current || !pageVisibleRef.current) {
          return;
        }
        audio.currentTime = 0;
        void playCurrentAudio();
      };
      audio.onerror = () => {
        clearAutoplayRetry();
        autoplayRetryTimeoutRef.current = window.setTimeout(() => {
          autoplayRetryTimeoutRef.current = null;
          void playRandomTrackRef.current?.(nextTrack);
        }, 1200);
      };

      audioRef.current = audio;
      currentTrackRef.current = nextTrack;

      const didPlay = await playCurrentAudio();
      if (!musicControllerMountedRef.current || !musicEnabledRef.current) {
        return;
      }
      if (!didPlay) {
        attachInteractionListener();
      }
    },
    [
      attachInteractionListener,
      chooseRandomTrack,
      cleanupAudioElement,
      clearAutoplayRetry,
      clearInteractionListener,
      playCurrentAudio,
      resolvedPlayerRole,
    ]
  );
  useEffect(() => {
    playRandomTrackRef.current = playRandomTrack;
  }, [playRandomTrack]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return undefined;
    }
    installPlayerThemeAudioGuard(CASINO_BACKGROUND_TRACKS);
    clearStaleRoleThemeStorage();
    stopWrongPlayerRouteThemeAudio(CASINO_BACKGROUND_TRACKS);

    const isDocumentVisible = () => document.visibilityState === 'visible';

    const pauseForBackground = () => {
      pageVisibleRef.current = false;
      clearAutoplayRetry();
      audioRef.current?.pause();
    };

    const resumeForForeground = () => {
      pageVisibleRef.current = isDocumentVisible();
      if (!pageVisibleRef.current || !musicEnabledRef.current) {
        return;
      }
      if (!audioUnlockedRef.current) {
        attachInteractionListener();
        return;
      }
      if (audioRef.current) {
        void playCurrentAudio();
      } else {
        void playRandomTrack(currentTrackRef.current);
      }
    };

    const handleVisibilityChange = () => {
      if (isDocumentVisible()) {
        resumeForForeground();
      } else {
        pauseForBackground();
      }
    };

    pageVisibleRef.current = isDocumentVisible();
    if (!pageVisibleRef.current) {
      pauseForBackground();
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', pauseForBackground);
    window.addEventListener('blur', pauseForBackground);
    window.addEventListener('freeze', pauseForBackground);
    window.addEventListener('pageshow', resumeForForeground);
    window.addEventListener('focus', resumeForForeground);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', pauseForBackground);
      window.removeEventListener('blur', pauseForBackground);
      window.removeEventListener('freeze', pauseForBackground);
      window.removeEventListener('pageshow', resumeForForeground);
      window.removeEventListener('focus', resumeForForeground);
      stopWrongPlayerRouteThemeAudio(CASINO_BACKGROUND_TRACKS);
    };
  }, [
    attachInteractionListener,
    clearAutoplayRetry,
    playCurrentAudio,
    playRandomTrack,
  ]);

  useEffect(() => {
    return () => {
      if (clipboardToastTimerRef.current !== null) {
        clearTimeout(clipboardToastTimerRef.current);
      }
      if (rechargeSuccessSplashTimerRef.current !== null) {
        clearTimeout(rechargeSuccessSplashTimerRef.current);
      }
    };
  }, []);

  function showSuccessSplash(message: string) {
    if (rechargeSuccessSplashTimerRef.current !== null) {
      clearTimeout(rechargeSuccessSplashTimerRef.current);
      rechargeSuccessSplashTimerRef.current = null;
    }

    setSuccessSplashMessage(message);
    rechargeSuccessSplashTimerRef.current = window.setTimeout(() => {
      setSuccessSplashMessage(null);
      rechargeSuccessSplashTimerRef.current = null;
    }, 1800);
  }

  const showClipboardToast = useCallback((
    text: string,
    tone: ClipboardToastTone,
    event: Pick<MouseEvent, 'clientX' | 'clientY'>
  ) => {
    if (clipboardToastTimerRef.current !== null) {
      clearTimeout(clipboardToastTimerRef.current);
      clipboardToastTimerRef.current = null;
    }

    const x = clampClipboardToastX(event.clientX);
    const y = event.clientY;
    const placeBelow = y < 52;

    setClipboardToast({ text, tone, x, y, placeBelow });
    clipboardToastTimerRef.current = window.setTimeout(() => {
      setClipboardToast(null);
      clipboardToastTimerRef.current = null;
    }, 2200);
  }, []);

  const copyCredentialValue = useCallback(async (value: string, label: string, event: MouseEvent) => {
    const clean = value.trim();

    if (!clean) {
      showClipboardToast(`Nothing to copy for ${label}.`, 'warn', event);
      return;
    }

    try {
      await navigator.clipboard.writeText(clean);
      showClipboardToast('Copied.', 'success', event);
    } catch {
      showClipboardToast('Could not copy.', 'error', event);
    }
  }, [showClipboardToast]);

  const handleCopyReferralCode = useCallback(async (event: MouseEvent) => {
    const code = referralCode.trim();
    if (!code) {
      showClipboardToast('Referral code is not ready yet.', 'warn', event);
      return;
    }

    try {
      await navigator.clipboard.writeText(code);
      showClipboardToast('Copied.', 'success', event);
    } catch {
      showClipboardToast('Could not copy.', 'error', event);
    }
  }, [referralCode, showClipboardToast]);

  const ensureCurrentPlayerReferralCode = useCallback(async (currentPlayerUid: string) => {
    if (!currentPlayerUid || referralCodeEnsureInFlightRef.current) {
      return;
    }

    if (!isClientSqlReadMode()) {
      const playerRef = doc(db, 'users', currentPlayerUid);
      const playerSnap = await getDoc(playerRef);
      if (!playerSnap.exists()) {
        return;
      }

      const profile = playerSnap.data() as { role?: string; referralCode?: string };
      if (String(profile.role || '').toLowerCase() !== 'player') {
        return;
      }
      const existingCode = String(profile.referralCode || '').trim();
      if (/^\d{6,10}$/.test(existingCode)) {
        setReferralCode(existingCode);
      }
    }

    referralCodeEnsureInFlightRef.current = true;
    try {
      if (!isClientSqlReadMode() && !auth.currentUser) {
        return;
      }
      const res = await fetch('/api/player/ensure-referral-code', {
        method: 'POST',
        headers: await getPlayerApiHeaders(false),
      });
      const data = (await res.json()) as {
        success?: boolean;
        referralCode?: string;
        error?: string;
      };
      if (data.success && data.referralCode) {
        setReferralCode(String(data.referralCode).trim());
      } else if (data.error && data.error !== 'Only players have referral codes.') {
        console.warn('Referral code ensure failed:', data.error);
      }
    } catch (error) {
      console.error(error);
    } finally {
      referralCodeEnsureInFlightRef.current = false;
    }
  }, []);

  const applyPlayerProfileSnapshot = useCallback((profile: PlayerProfileSqlSnapshot, currentPlayerUid: string) => {
    markPlayerPerf('live_update_profile', {
      playerUid: currentPlayerUid,
      coin: Number(profile.coin || 0),
      cash: Number(profile.cash || 0),
    });
    setWalletIfChanged({
      coin: Number(profile.coin || 0),
      cash: Number(profile.cash || 0),
    });
    setDismissedPaymentDetailsNoticeVersion(
      Number(profile.dismissedPaymentDetailsNoticeVersion || 0)
    );
    setPlayerUsername(String(profile.username || '').trim());
    setIsBlockedPlayer(profile.status === 'disabled');
    const resolvedCoadminUid = profile.coadminUid || '';
    if (!resolvedCoadminUid) {
      setPaymentDetailsNoticeVersion(0);
    } else {
      setPaymentDetailsNoticeVersion(Number(profile.coadminPaymentDetailsNoticeVersion || 0));
    }
    setPlayerCoadminUid(resolvedCoadminUid);
    const nextReferralCode = String(profile.referralCode || '').trim();
    if (/^\d{6,10}$/.test(nextReferralCode)) {
      setReferralCode(nextReferralCode);
    } else {
      setReferralCode('');
      void ensureCurrentPlayerReferralCode(currentPlayerUid);
    }
    setReferredByPlayerName(String(profile.referredByUsername || '').trim());
    setReferredByPlayerUid(String(profile.referredByUid || '').trim());

    const referralNotice = String(profile.referralBonusNotice || '').trim();
    const noticeTimestamp = profile.referralBonusNoticeAt
      ? Date.parse(profile.referralBonusNoticeAt)
      : 0;
    if (referralNotice && noticeTimestamp > 0) {
      const noticeKey = `playerReferralNoticeSeen:${currentPlayerUid}:${noticeTimestamp}`;
      const hasSeen = window.sessionStorage.getItem(noticeKey) === '1';
      if (!hasSeen) {
        setMessage('Your referral was successful. Referral bonus has been added.');
        window.sessionStorage.setItem(noticeKey, '1');
      }
    }
  }, [ensureCurrentPlayerReferralCode, setWalletIfChanged]);

  const playNotificationSound = useCallback(() => {
    playSoundEffect(notificationSoundRef, '/urgency-sound.mp3', 0.6);
  }, [playSoundEffect]);

  useEffect(() => {
    musicEnabledRef.current = musicEnabled;

    try {
      window.localStorage.setItem(PLAYER_MUSIC_STORAGE_KEY, String(musicEnabled));
    } catch {
      // Ignore storage write failures.
    }

    if (!musicEnabled) {
      clearInteractionListener();
      clearAutoplayRetry();
      if (audioRef.current) {
        audioRef.current.pause();
      }
      return;
    }
    if (
      !playerThemeRouteGuard({
        currentPath: typeof window === 'undefined' ? '' : window.location.pathname,
        resolvedRole: resolvedPlayerRole,
        audioTheme: 'player',
      })
    ) {
      clearInteractionListener();
      clearAutoplayRetry();
      cleanupAudioElement();
      return;
    }

    if (audioRef.current) {
      void playCurrentAudio();
      return;
    }

    void playRandomTrack(currentTrackRef.current);
  }, [
    clearAutoplayRetry,
    clearInteractionListener,
    musicEnabled,
    resolvedPlayerRole,
    cleanupAudioElement,
    playCurrentAudio,
    playRandomTrack,
  ]);

  useEffect(() => {
    musicControllerMountedRef.current = true;
    return () => {
      musicControllerMountedRef.current = false;
      clearInteractionListener();
      clearAutoplayRetry();
      cleanupAudioElement();
    };
  }, [cleanupAudioElement, clearAutoplayRetry, clearInteractionListener]);

  useEffect(() => {
    if (!playerCoadminUid) {
      setCoadminFrontendLinkByGameKey({});
    }
  }, [playerCoadminUid]);

  const loadAgents = useCallback(async (options: { force?: boolean } = {}) => {
    if (shouldSkipIndividualLoader('staff', options.force)) {
      return;
    }

    const startedAt = Date.now();
    try {
      const headers = await getPlayerApiHeaders(false, { route: '/api/player/staff-list' });
      const response = await fetch('/api/player/staff-list', {
        method: 'GET',
        headers,
        cache: 'no-store',
      });
      if (!response.ok) {
        setAgentsIfChanged([]);
        playerDevLog('[PLAYER_STAFF_LIST]', {
          ok: false,
          status: response.status,
          durationMs: Date.now() - startedAt,
        });
        return;
      }

      const payload = (await response.json()) as {
        staff?: AdminUser[];
        source?: string;
      };
      const staff = Array.isArray(payload.staff) ? payload.staff : [];
      setAgentsIfChanged(staff);
      playerDevLog('[PLAYER_STAFF_LIST]', {
        ok: true,
        count: staff.length,
        source: payload.source || 'unknown',
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      if (error instanceof PlayerSessionStaleError) {
        playerDevLog('[PLAYER_STAFF_LIST]', {
          ok: false,
          reason: error.message,
          stale_ignored: true,
          durationMs: Date.now() - startedAt,
        });
        return;
      }
      setAgentsIfChanged([]);
      reportPlayerUiError('player_staff_list', error, setMessage, 'Failed to load agents.');
      playerDevLog('[PLAYER_STAFF_LIST]', {
        ok: false,
        reason: error instanceof Error ? error.message : 'load_failed',
        durationMs: Date.now() - startedAt,
      });
    }
  }, [shouldSkipIndividualLoader]);

  /** Loads carer/game metadata for credential cards (logins come from realtime listener below). */
  const syncCredentialSidecarsForPlayer = useCallback(
    async (currentPlayerUid: string, sortedLogins: PlayerGameLogin[]) => {
      try {
        const carerMapping = await getCompletedUsernameCarersByPlayer(currentPlayerUid);
        setUsernameCarersByGameIfChanged(carerMapping);

        const creatorUids = [
          ...new Set(
            sortedLogins
              .map((login) => String(login.createdBy || '').trim())
              .filter(Boolean)
          ),
        ];
        const nameEntries = isClientSqlReadMode()
          ? creatorUids.map((uid) => [uid, 'Creator'] as const)
          : await Promise.all(
              creatorUids.map(async (uid) => {
                try {
                  const snap = await getDoc(doc(db, 'users', uid));
                  if (!snap.exists()) {
                    return [uid, 'Unknown Creator'] as const;
                  }
                  const userData = snap.data() as { role?: string; username?: string };
                  return [uid, buildCreatorDisplayLabel(userData)] as const;
                } catch {
                  return [uid, 'Unknown Creator'] as const;
                }
              })
            );
        const nextCreatorNames: Record<string, string> = {};
        for (const [uid, label] of nameEntries) {
          nextCreatorNames[uid] = label;
        }
        setCreatorNamesIfChanged(nextCreatorNames);
      } catch (error) {
        reportPlayerUiError(
          'player_credential_sidecars',
          error,
          setMessage,
          'Failed to load credential details.'
        );
      }
    },
    []
  );

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const snapshot = readPlayerPageSessionGateSnapshot();
      logPlayerPageSessionGate({
        ...snapshot,
        blocked: true,
        reason: 'player_page_mount',
      });

      const gate = await ensurePlayerSessionGateReady({ source: 'player_page_mount' });
      if (cancelled) {
        return;
      }

      const after = readPlayerPageSessionGateSnapshot();
      logPlayerPageSessionGate({
        ...after,
        blocked: gate.state !== 'ready',
        reason: gate.state === 'ready' ? 'gate_ready' : gate.reason,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const pageLoadStartedAt = Date.now();

    const clearPlayerState = () => {
      setIsBlockedPlayer(false);
      setWalletIfChanged({ coin: 0, cash: 0 });
      setPlayerUsername('');
      setPlayerCoadminUid('');
      setPaymentDetailsNoticeVersion(0);
      setDismissedPaymentDetailsNoticeVersion(0);
      setShowCashoutSuccessSplash(false);
      hasSeenCashoutTaskSnapshotRef.current = false;
      knownCompletedCashoutTaskIdsRef.current = new Set();
      cashoutSplashSeenIdsRef.current = new Set();
      knownCashoutStatusByIdRef.current = {};
      setAgentsIfChanged([]);
      setGameLogins((current) => (current.length === 0 ? current : []));
      setBonusEvents([]);
      setUsernameCarersByGameIfChanged({});
      setCreatorNamesIfChanged({});
      setSelectedCreatorUid(null);
      setRequestHistory((current) => (current.length === 0 ? current : []));
      syncedRuntimePlayerUidRef.current = '';
    };

    const loadPlayerProfileForUid = async (
      nextPlayerUid: string,
      sessionUser?: { username?: string | null; coadminUid?: string | null; status?: string | null } | null
    ) => {
      try {
        if (isClientSqlReadMode()) {
          if (sessionUser) {
            setPlayerUsername(String(sessionUser.username || '').trim());
            setPlayerCoadminUid(String(sessionUser.coadminUid || '').trim());
            setIsBlockedPlayer(sessionUser.status === 'disabled');
          }
          playerStartupDebugLog('[PLAYER_STARTUP_STAGGER]', {
            target: '/api/auth/session/me',
            delayMs: 250,
            reason: 'profile_snapshot_after_identity',
          });
          await new Promise((resolve) => window.setTimeout(resolve, 250));
          const profile = await loadPlayerProfileSnapshotOnce();
          if (profile) {
            applyPlayerProfileSnapshot(profile, nextPlayerUid);
          }
        } else {
          const playerSnap = await getDoc(doc(db, 'users', nextPlayerUid));
          const playerData = playerSnap.data() as
            | { status?: string; coin?: number; cash?: number; username?: string }
            | undefined;
          setIsBlockedPlayer(playerData?.status === 'disabled');
          setWalletIfChanged({
            coin: Number(playerData?.coin || 0),
            cash: Number(playerData?.cash || 0),
          });
          setPlayerUsername(String(playerData?.username || '').trim());
          const resolvedCoadminUid = resolveCoadminUid({
            uid: nextPlayerUid,
            ...(playerData as Record<string, unknown>),
          });
          if (!resolvedCoadminUid) {
            setPaymentDetailsNoticeVersion(0);
          }
          setPlayerCoadminUid(resolvedCoadminUid ? String(resolvedCoadminUid) : '');
        }
      } catch {
        setIsBlockedPlayer(false);
        setWalletIfChanged({ coin: 0, cash: 0 });
        setPlayerUsername('');
        setPlayerCoadminUid('');
        setBonusEvents([]);
        setUsernameCarersByGameIfChanged({});
      }
    };

    const syncSqlPlayerRuntime = async () => {
      if (syncedRuntimePlayerUidRef.current) {
        playerStartupDebugLog('[PLAYER_SESSION_ME_STARTUP_SKIP_DUPLICATE]', {
          uid: syncedRuntimePlayerUidRef.current,
          reason: 'identity_already_synced_before_runtime_fetch',
        });
        return;
      }
      playerStartupDebugLog('[PLAYER_SESSION_ME_STARTUP_SINGLE_FLIGHT]', {
        reason: 'runtime_sync_initial',
      });
      const gate = await ensurePlayerSessionGateReady({ source: 'player_page_runtime_sync' });
      const sessionUser =
        getCachedSessionUser()?.role === 'player'
          ? getCachedSessionUser()
          : await getSessionUserOnce().catch(() => null);

      logSqlPlayerRuntimeAuth({
        route: '/player',
        source: 'session_me',
        uid: sessionUser?.uid ?? null,
        role: sessionUser?.role ?? null,
        coadminUid: sessionUser?.coadminUid ?? null,
        sessionSource: sessionUser?.sessionSource ?? 'sql',
        firebaseIgnored: true,
        ready: gate.state === 'ready',
        blocked: gate.state === 'failed',
        reason: gate.state === 'ready' ? 'runtime_sync_ok' : gate.reason,
      });

      if (!sessionUser || sessionUser.role !== 'player') {
        if (sessionUser && sessionUser.role !== 'player') {
          playerDevLog('[PLAYER_FETCH_BLOCKED_ROLE]', {
            route: '/player',
            uid: sessionUser.uid,
            role: sessionUser.role,
            expectedRole: 'player',
            reason: 'non_player_role_sql_runtime_sync',
          });
          setPlayerUid('');
          setPlayerCoadminUid('');
        }
        return;
      }

      setPlayerUid(sessionUser.uid);
      if (syncedRuntimePlayerUidRef.current === sessionUser.uid) {
        if (playerStartupRef.current) {
          playerStartupRef.current.duplicateRequestsRemoved += 1;
        }
        playerStartupDebugLog('[PLAYER_SESSION_ME_DEDUPED]', {
          uid: sessionUser.uid,
          reason: 'runtime_sync_identity_already_applied',
        });
        playerStartupDebugLog('[PLAYER_SESSION_ME_STARTUP_SKIP_DUPLICATE]', {
          uid: sessionUser.uid,
          reason: 'runtime_sync_identity_already_applied',
        });
        playerStartupDebugLog('[PLAYER_STARTUP_FETCH_SKIPPED]', {
          request: '/api/auth/session/me',
          reason: 'runtime_sync_identity_already_applied',
          uid: sessionUser.uid,
        });
        return;
      }
      syncedRuntimePlayerUidRef.current = sessionUser.uid;
      await loadPlayerProfileForUid(sessionUser.uid, sessionUser);
    };

    if (isSqlPlayerRuntimeMode()) {
      let cancelled = false;
      let retryTimer: number | null = null;
      const run = async () => {
        if (cancelled) {
          return;
        }
        await syncSqlPlayerRuntime();
        const syncedUid = syncedRuntimePlayerUidRef.current;
        if (syncedUid && retryTimer !== null) {
          window.clearInterval(retryTimer);
          retryTimer = null;
          playerStartupDebugLog('[PLAYER_SESSION_ME_DEDUPED]', {
            uid: syncedUid,
            reason: 'runtime_sync_success_retry_timer_cleared',
          });
        }
      };
      void run();
      retryTimer = window.setInterval(() => {
        if (syncedRuntimePlayerUidRef.current) {
          if (retryTimer !== null) {
            window.clearInterval(retryTimer);
            retryTimer = null;
          }
          playerStartupDebugLog('[PLAYER_SESSION_ME_DEDUPED]', {
            uid: syncedRuntimePlayerUidRef.current,
            reason: 'runtime_sync_retry_skipped_after_success',
          });
          return;
        }
        void run();
      }, 3000);

      playerStartupDebugLog('[PLAYER_PAGE_LOAD]', {
        stage: 'init_sql_runtime',
        durationMs: Date.now() - pageLoadStartedAt,
      });

      return () => {
        cancelled = true;
        if (retryTimer !== null) {
          window.clearInterval(retryTimer);
          retryTimer = null;
        }
      };
    }

    const syncPlayerUidFromSession = async () => {
      const cached = getCachedSessionUser();
      if (cached?.role === 'player' && cached.uid) {
        setPlayerUid((current) => current || cached.uid);
        return;
      }
      const sessionUser = await getSessionUserOnce();
      if (sessionUser?.role === 'player' && sessionUser.uid) {
        setPlayerUid((current) => current || sessionUser.uid);
      }
    };

    void syncPlayerUidFromSession();

    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      const cachedSession = getCachedSessionUser();
      const sessionUser =
        cachedSession && cachedSession.role === 'player'
          ? cachedSession
          : cachedSession?.role
            ? cachedSession
            : getLocalAppSessionId()
              ? await getSessionUserOnce().catch(() => null)
              : null;

      if (sessionUser && sessionUser.role !== 'player') {
        playerDevLog('[PLAYER_FETCH_BLOCKED_ROLE]', {
          route: '/player',
          uid: sessionUser.uid,
          role: sessionUser.role,
          expectedRole: 'player',
          reason: 'non_player_role_auth_sync',
        });
      setPlayerUid('');
      setPlayerCoadminUid('');
      syncedRuntimePlayerUidRef.current = '';
      return;
      }

      let sessionUid = user?.uid || (sessionUser?.role === 'player' ? sessionUser.uid : '') || '';
      if (!sessionUid && getLocalAppSessionId()) {
        const resolved = await getSessionUserOnce().catch(() => null);
        if (resolved?.role === 'player') {
          sessionUid = resolved.uid;
        }
      }
      const nextPlayerUid = sessionUid || user?.uid || '';
      if (nextPlayerUid && sessionUser?.role && sessionUser.role !== 'player') {
        setPlayerUid('');
        return;
      }
      setPlayerUid(nextPlayerUid);

      if (!nextPlayerUid) {
        syncedRuntimePlayerUidRef.current = '';
        clearPlayerState();
        return;
      }

      await loadPlayerProfileForUid(nextPlayerUid, sessionUser);
    });

    playerStartupDebugLog('[PLAYER_PAGE_LOAD]', {
      stage: 'init',
      durationMs: Date.now() - pageLoadStartedAt,
    });

    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!playerCoadminUid) {
      setMaintenanceBreak(normalizeMaintenanceBreak(null));
      return;
    }

    return listenCoadminMaintenanceBreak(
      playerCoadminUid,
      setMaintenanceBreak,
      () => setMaintenanceBreak(normalizeMaintenanceBreak(null))
    );
  }, [playerCoadminUid]);

  useEffect(() => {
    if (
      !playerCoadminUid ||
      isClientSqlReadMode() ||
      assertClientFirestoreDisabled('player_coadmin_payment_notice', 'onSnapshot', {
        coadminUid: playerCoadminUid,
      })
    ) {
      return;
    }

    const unsubscribe = onSnapshot(
      doc(db, 'users', playerCoadminUid),
      (snapshot) => {
        if (!snapshot.exists()) {
          setPaymentDetailsNoticeVersion(0);
          return;
        }

        const coadminData = snapshot.data() as {
          paymentDetailsNoticeVersion?: number;
        };
        setPaymentDetailsNoticeVersion(Number(coadminData.paymentDetailsNoticeVersion || 0));
      },
      () => setPaymentDetailsNoticeVersion(0)
    );

    return () => unsubscribe();
  }, [playerCoadminUid]);

  useEffect(() => {
    if (!isPlayerRole || !playerUid) {
      chatUnreadStartedForUidRef.current = '';
      return;
    }
    let unsubscribe: (() => void) | null = null;
    if (chatUnreadStartedForUidRef.current === playerUid) {
      playerStartupDebugLog('[PLAYER_CHAT_UNREAD_SKIP_RESTART]', {
        playerUid,
        reason: 'already_started_for_identity',
        baseDataLoaded,
      });
      return;
    }
    chatUnreadStartedForUidRef.current = playerUid;
    const delayMs = playerStartupJitterMs(1_000, 2_500);
    playerStartupDebugLog('[PLAYER_CHAT_UNREAD_START_ONCE]', {
      playerUid,
      delayMs,
      baseDataLoaded: baseDataLoadedRef.current,
    });
    logPlayerStartupPhase(3, '/api/chat/unread-counts', delayMs, 'phase_3_chat_unread');
    playerStartupDebugLog('[PLAYER_CHAT_UNREAD_DEFERRED]', {
      delayMs,
      reason: 'phase_3_after_core_startup',
    });
    const timer = window.setTimeout(() => {
      markPlayerStartupFlag('chatListenersStarted', {
        source: 'listenToUnreadCounts',
      });
      unsubscribe = listenToUnreadCounts((counts) => {
        markPlayerPerf('live_update_unread_counts', {
          threadCount: Object.keys(counts).length,
        });
        playerDebugLog('[PLAYER_CHAT_READ] refreshReadStateLoaded', {
          threadCount: Object.keys(counts).length,
        });
        setUnreadCounts((current) => (areUnreadCountsEqual(current, counts) ? current : counts));
      }, { requirePlayerRole: true });
    }, delayMs);
    return () => {
      window.clearTimeout(timer);
      unsubscribe?.();
      if (chatUnreadStartedForUidRef.current === playerUid) {
        chatUnreadStartedForUidRef.current = '';
      }
    };
  }, [isPlayerRole, logPlayerStartupPhase, markPlayerStartupFlag, playerUid, startupNow]);

  useEffect(() => {
    if (totalUnread > previousUnreadRef.current) {
      playNotificationSound();
    }

    previousUnreadRef.current = totalUnread;
  }, [playNotificationSound, totalUnread]);

  useEffect(() => {
    if (!isPlayerRole || !playerUid) {
      return;
    }

    const playDataDelayMs = shouldPollPlayData ? 0 : playerStartupJitterMs(1_500, 3_000);
    logPlayerStartupPhase(
      shouldPollPlayData ? 1 : 3,
      '/api/player/play-data',
      playDataDelayMs,
      shouldPollPlayData ? 'active_play_tab_immediate' : 'phase_3_deferred_play_data'
    );

    if (shouldPollPlayData) {
      setLoadingList(true);
    }
    setMessage('');
    const unsubscribeLogins = listenToPlayerGameLoginsByPlayer(
      playerUid,
      (list) => {
        const sorted = sortByNewest(list);
        markPlayerPerf('live_update_game_logins', {
          source: 'listenToPlayerGameLoginsByPlayer',
          count: sorted.length,
          activeView: activeViewRef.current,
        });
        setGameLogins((current) =>
          arePlayerGameLoginsEqual(current, sorted) ? current : sorted
        );
        setLoadingList(false);
        if (!playPanelGameLoginsLoadedLoggedRef.current) {
          playPanelGameLoginsLoadedLoggedRef.current = true;
          playerDebugLog('[PLAY_PANEL_GAME_LOGINS_LOADED]', {
            elapsed_ms: startupNow(),
            count: sorted.length,
            source: '/api/player/play-data',
          });
        }
        if (shouldPollPlayData) {
          void syncCredentialSidecarsForPlayer(playerUid, sorted);
        }
      },
      (error) => {
        setLoadingList(false);
        reportPlayerUiError(
          'player_game_logins_listener',
          error,
          setMessage,
          'Failed to listen for credential updates.'
        );
      },
      { initialDelayMs: playDataDelayMs, pollEnabled: shouldPollPlayData }
    );

    return () => {
      unsubscribeLogins();
    };
  }, [isPlayerRole, logPlayerStartupPhase, playerUid, shouldPollPlayData, syncCredentialSidecarsForPlayer, startupNow]);

  useEffect(() => {
    if (!isPlayerRole || !playerUid) return;

    const liveShadowCompare = attachPlayerRequestLiveShadowCompare(playerUid);
    let sqlReadDispose: (() => void) | null = null;
    const sqlRequestsRead =
      isClientSqlReadMode() || PLAYER_REQUESTS_SQL_READ_ENABLED;
    let unsubscribeRequests: (() => void) | null = null;

    if (!sqlRequestsRead) {
      unsubscribeRequests = listenToPlayerGameRequestsByPlayer(
        playerUid,
        (requests) => {
          const sortedRequests = sortByNewest(requests);
          markPlayerPerf('live_update_requests', {
            source: 'listenToPlayerGameRequestsByPlayer',
            count: sortedRequests.length,
            activeView: activeViewRef.current,
          });
          setRequestHistory((current) =>
            arePlayerRequestsEqual(current, sortedRequests) ? current : sortedRequests
          );
          liveShadowCompare.reportFirebaseSnapshot(requests);
        },
        (error) => {
          reportPlayerUiError(
            'player_game_requests_listener',
            error,
            setMessage,
            'Failed to load request history.'
          );
        }
      );
    }

    if (sqlRequestsRead) {
      const handleRequestOutcomeFromLive = (event: PlayerRequestOutcomeLiveEvent) => {
        const outcomeKey = `${event.requestId}:${event.outcomeType}`;
        if (seenRequestOutcomeKeysRef.current.has(outcomeKey)) {
          return;
        }
        if (isStaleLivePopupEvent(event.outboxId, event.eventAtMs)) {
          markOutcomeSeen(playerUid, outcomeKey);
          if (
            event.outcomeType === 'recharge_completed' ||
            event.outcomeType === 'recharge_dismissed'
          ) {
            markRechargeSplashSeen(playerUid, event.requestId);
          }
          if (
            event.outcomeType === 'redeem_completed' ||
            event.outcomeType === 'redeem_dismissed'
          ) {
            markRedeemSplashSeen(playerUid, event.requestId);
          }
          return;
        }
        markOutcomeSeen(playerUid, outcomeKey);
        playerDevLog('[PLAYER_REQUEST_OUTCOME_TOAST_SHOW]', {
          requestId: event.requestId,
          source: `sse_event:${event.sourceEvent}`,
          outcomeType: event.outcomeType,
          message: event.message,
          toastVariant: event.toastVariant,
        });

        switch (event.outcomeType) {
          case 'recharge_sent':
          case 'redeem_sent':
            setMessage(event.message);
            return;
          case 'recharge_completed':
            markRechargeSplashSeen(playerUid, event.requestId);
            showSuccessSplash(event.message);
            return;
          case 'redeem_completed':
            markRedeemSplashSeen(playerUid, event.requestId);
            showSuccessSplash(event.message);
            return;
          case 'recharge_dismissed':
            if (
              !requestMatchesMidnightPartyDismiss(event) &&
              !requestMatchesPlayerInGameDismiss(event)
            ) {
              return;
            }
            if (requestMatchesPlayerInGameDismiss(event)) {
              playerDevLog('[PLAYER_IN_GAME_SPLASH_SHOW]', {
                requestId: event.requestId,
                source: `sse_event:${event.sourceEvent}`,
                message: playerInGameDismissSplashMessage({
                  requestType: 'recharge',
                  pokeMessage: event.pokeMessage,
                  dismissReasonMessage: event.dismissReasonMessage,
                  refunded: event.refunded,
                }),
              });
            }
            markRechargeSplashSeen(playerUid, event.requestId);
            setRedeemDismissSplashRequest({
              id: event.requestId,
              playerUid: event.playerUid,
              gameName: 'Unknown Game',
              type: 'recharge',
              status: 'dismissed',
              amount: 0,
              pokeMessage: event.pokeMessage,
              dismissReasonCode: event.dismissReasonCode,
              dismissReasonMessage: event.dismissReasonMessage,
              createdAt: null,
              completedAt: null,
              pokedAt: null,
            });
            return;
          case 'redeem_dismissed':
            if (
              !requestMatchesFakeRedeemDismiss(event) &&
              !requestMatchesPlayerInGameDismiss(event)
            ) {
              return;
            }
            if (requestMatchesPlayerInGameDismiss(event)) {
              playerDevLog('[PLAYER_IN_GAME_SPLASH_SHOW]', {
                requestId: event.requestId,
                source: `sse_event:${event.sourceEvent}`,
                message: playerInGameDismissSplashMessage({
                  requestType: 'redeem',
                  pokeMessage: event.pokeMessage,
                  dismissReasonMessage: event.dismissReasonMessage,
                  refunded: event.refunded,
                }),
              });
            }
            markRedeemSplashSeen(playerUid, event.requestId);
            setRedeemDismissSplashRequest({
              id: event.requestId,
              playerUid: event.playerUid,
              gameName: 'Unknown Game',
              type: 'redeem',
              status: 'dismissed',
              amount: 0,
              pokeMessage: event.pokeMessage,
              dismissReasonCode: event.dismissReasonCode,
              dismissReasonMessage: event.dismissReasonMessage,
              createdAt: null,
              completedAt: null,
              pokedAt: null,
            });
            return;
          default:
            return;
        }
      };

      const showRechargeSuccessFromLiveEvent = (event: PlayerRechargeSuccessLiveEvent) => {
        if (event.type !== 'recharge' || event.status !== 'completed') {
          return;
        }
        if (seenCompletedRechargeSplashIdsRef.current.has(event.requestId)) {
          return;
        }
        if (isStaleLivePopupEvent(event.outboxId, event.eventAtMs)) {
          markRechargeSplashSeen(playerUid, event.requestId);
          return;
        }
        playerDevLog('[PLAYER_RECHARGE_SUCCESS_TOAST_SHOW]', {
          requestId: event.requestId,
          source: `sse_event:${event.sourceEvent}`,
          message: event.message,
        });
        markRechargeSplashSeen(playerUid, event.requestId);
        showSuccessSplash(event.message);
      };

      const showRedeemDismissFromLiveEvent = (event: PlayerRedeemDismissLiveEvent) => {
        if (event.type !== 'redeem' || event.status !== 'dismissed') {
          return;
        }
        if (
          !requestMatchesFakeRedeemDismiss(event) &&
          !requestMatchesPlayerInGameDismiss(event)
        ) {
          return;
        }
        if (seenDismissedRedeemSplashIdsRef.current.has(event.requestId)) {
          return;
        }
        if (isStaleLivePopupEvent(event.outboxId, event.eventAtMs)) {
          markRedeemSplashSeen(playerUid, event.requestId);
          return;
        }
        const dismissMessage = requestMatchesPlayerInGameDismiss(event)
          ? playerInGameDismissSplashMessage({
              requestType: 'redeem',
              pokeMessage: event.pokeMessage,
              dismissReasonMessage: event.dismissReasonMessage,
              refunded: event.refunded,
            })
          : fakeRedeemDismissSplashMessage(event);
        playerDevLog(
          requestMatchesPlayerInGameDismiss(event)
            ? '[PLAYER_IN_GAME_SPLASH_SHOW]'
            : '[PLAYER_REDEEM_DISMISS_TOAST_SHOW]',
          {
            requestId: event.requestId,
            source: `sse_event:${event.sourceEvent}`,
            message: dismissMessage,
          }
        );
        markRedeemSplashSeen(playerUid, event.requestId);
        setRedeemDismissSplashRequest({
          id: event.requestId,
          playerUid: event.playerUid,
          gameName: 'Unknown Game',
          type: 'redeem',
          status: 'dismissed',
          amount: 0,
          pokeMessage: event.pokeMessage,
          dismissReasonCode: event.dismissReasonCode,
          dismissReasonMessage: event.dismissReasonMessage,
          createdAt: null,
          completedAt: null,
          pokedAt: null,
        });
      };

      const showRechargeDismissFromLiveEvent = (event: PlayerRechargeDismissLiveEvent) => {
        if (event.type !== 'recharge' || event.status !== 'dismissed') {
          return;
        }
        if (
          !requestMatchesMidnightPartyDismiss(event) &&
          !requestMatchesPlayerInGameDismiss(event)
        ) {
          return;
        }
        if (seenDismissedRechargeSplashIdsRef.current.has(event.requestId)) {
          return;
        }
        if (isStaleLivePopupEvent(event.outboxId, event.eventAtMs)) {
          markRechargeSplashSeen(playerUid, event.requestId);
          return;
        }
        playerDevLog(
          requestMatchesPlayerInGameDismiss(event)
            ? '[PLAYER_IN_GAME_SPLASH_SHOW]'
            : '[PLAYER_TOAST_SHOW]',
          {
            requestId: event.requestId,
            source: `sse_event:${event.sourceEvent}`,
            pokeMessage: event.pokeMessage,
            dismissReasonCode: event.dismissReasonCode,
            refunded: event.refunded,
            message: requestMatchesPlayerInGameDismiss(event)
              ? playerInGameDismissSplashMessage({
                  requestType: 'recharge',
                  pokeMessage: event.pokeMessage,
                  dismissReasonMessage: event.dismissReasonMessage,
                  refunded: event.refunded,
                })
              : null,
          }
        );
        markRechargeSplashSeen(playerUid, event.requestId);
        setRedeemDismissSplashRequest({
          id: event.requestId,
          playerUid: event.playerUid,
          gameName: 'Unknown Game',
          type: 'recharge',
          status: 'dismissed',
          amount: 0,
          pokeMessage: event.pokeMessage,
          dismissReasonCode: event.dismissReasonCode,
          dismissReasonMessage: event.dismissReasonMessage,
          createdAt: null,
          completedAt: null,
          pokedAt: null,
        });
      };

      const attachSqlRead = () =>
        attachPlayerRequestSqlReadListener(
          playerUid,
          (requests) => {
            markPlayerStartupFlag('requestsLoaded', {
              source: '/api/live/snapshot/player/[playerUid]/requests',
              count: requests.length,
            });
            const sortedRequests = sortByNewest(requests);
            markPlayerPerf('live_update_requests', {
              source: 'player_request_sql_read',
              count: sortedRequests.length,
              activeView: activeViewRef.current,
            });
            setRequestHistory((current) =>
              arePlayerRequestsEqual(current, sortedRequests) ? current : sortedRequests
            );
            setMessage('');
          },
          (reason) => {
            playerDevLog('[PLAYER_REQUESTS_SQL_READ] ui_fallback_blocked', {
              reason,
              sqlMode: isClientSqlReadMode(),
            });
          },
          {
          onSnapshotBootstrap: ({ latestOutboxId }) => {
            markPlayerStartupFlag('sseStarted', {
              source: 'player_request_sql_read',
              latestOutboxId,
            });
            bootOutboxCursorRef.current = Math.max(
              bootOutboxCursorRef.current ?? 0,
              latestOutboxId
            );
          },
          onRequestOutcomeEvent: handleRequestOutcomeFromLive,
          onRechargeDismissEvent: showRechargeDismissFromLiveEvent,
          onRechargeSuccessEvent: showRechargeSuccessFromLiveEvent,
          onRedeemDismissEvent: showRedeemDismissFromLiveEvent,
          onBalanceUpdate: (reason, meta) => {
            void loadPlayerProfileSnapshotOnce().then((profile) => {
              if (profile) {
                applyPlayerProfileSnapshot(profile, playerUid);
              }
              if (meta?.direction === 'cash_to_coin' || meta?.direction === 'coin_to_cash') {
                console.info('[CONVERSION_SSE_RECONCILED]', {
                  type: meta.direction,
                  reason,
                  updatedCoinBalance: profile?.coin ?? null,
                  updatedCashBalance: profile?.cash ?? null,
                });
              }
              playerDevLog('[PLAYER_BALANCE_EVENT] profile_refreshed', {
                reason,
                playerUid,
              });
              });
          },
          onFreeplayGivenEvent: (event: PlayerFreeplayGivenLiveEvent) => {
            playerDevLog('[PLAYER_FREEPLAY_REFETCH_START]', {
              playerUid,
              freeplayGiftId: event.freeplayGiftId,
              source: `sse_event:${event.sourceEvent}`,
            });
            void fetchPendingFreeplayGift()
              .then((pendingGift) => {
                setHasPendingFreeplayGift(pendingGift.hasPendingGift);
                setPendingFreeplayGiftId(pendingGift.giftId);
                playerDevLog('[PLAYER_FREEPLAY_REFETCH_DONE]', {
                  ok: true,
                  playerUid,
                  freeplayGiftId: event.freeplayGiftId,
                  hasPendingGift: pendingGift.hasPendingGift,
                  pendingGiftId: pendingGift.giftId || null,
                  source: `sse_event:${event.sourceEvent}`,
                });
                if (!isStaleLivePopupEvent(event.outboxId, event.eventAtMs)) {
                  playerDevLog('[PLAYER_FREEPLAY_TOAST_SHOW]', {
                    playerUid,
                    freeplayGiftId: event.freeplayGiftId,
                    message: event.message || 'You received freeplay.',
                  });
                  setMessage(event.message || 'You received freeplay.');
                }
              })
              .catch((error) => {
                playerDevLog('[PLAYER_FREEPLAY_REFETCH_DONE]', {
                  ok: false,
                  playerUid,
                  freeplayGiftId: event.freeplayGiftId,
                  error: error instanceof Error ? error.message : String(error),
                  source: `sse_event:${event.sourceEvent}`,
                });
              });
          },
          onPlayerGameLoginUpdated: (reason, meta) => {
            const playerMessage =
              meta?.pokeMessage ||
              (meta?.updateReason === 'reset_password'
                ? 'Your game password has been reset successfully.'
                : meta?.updateReason === 'create_username'
                  ? 'Your game account has been created.'
                  : 'Your game credentials have been updated.');
            playerDevLog('[PLAYER_PLAYTAB_GAMES_REFETCH]', {
              playerUid,
              reason,
              updateReason: meta?.updateReason || null,
              gameName: meta?.gameName || null,
            });
            playerDevLog('[PLAYER_VAULT_REFETCH]', {
              playerUid,
              reason,
              updateReason: meta?.updateReason || null,
            });
            playerDevLog('[PLAYER_GAME_LOGINS_REFETCH_START]', {
              playerUid,
              reason,
            });
            if (!isStaleLivePopupEvent(meta?.outboxId, meta?.eventAtMs)) {
              setMessage(playerMessage);
            }
            void getPlayerGameLoginsByPlayer(playerUid)
              .then((logins) => {
                const sortedLogins = sortByNewest(logins);
                markPlayerPerf('live_update_game_logins', {
                  source: 'player_request_sql_read_refetch',
                  count: sortedLogins.length,
                  reason,
                  activeView: activeViewRef.current,
                });
                setGameLogins((current) =>
                  arePlayerGameLoginsEqual(current, sortedLogins) ? current : sortedLogins
                );
                void syncCredentialSidecarsForPlayer(playerUid, sortedLogins);
                playerDevLog('[PLAYER_PLAYTAB_GAMES_SQL_READ]', {
                  playerUid,
                  count: logins.length,
                  reason,
                });
                playerDevLog('[PLAYER_GAME_LOGINS_REFETCH_DONE]', {
                  playerUid,
                  count: logins.length,
                  reason,
                });
              })
              .catch((error) => {
                playerDevLog('[PLAYER_GAME_LOGINS_REFETCH_DONE]', {
                  playerUid,
                  ok: false,
                  reason,
                  error: error instanceof Error ? error.message : String(error),
                });
              });
          },
          }
        );
      const delayMs = playerStartupJitterMs(250, 750);
      logPlayerStartupPhase(
        2,
        '/api/live/snapshot/player/[playerUid]/requests',
        delayMs,
        'phase_2_live_snapshot'
      );
      playerStartupDebugLog('[PLAYER_STARTUP_STAGGER]', {
        target: '/api/live/snapshot/player/[playerUid]/requests',
        delayMs,
        reason: 'defer_secondary_sql_snapshot',
      });
      const sqlReadTimer = window.setTimeout(() => {
        const sqlRead = attachSqlRead();
        sqlReadDispose = sqlRead.dispose;
      }, delayMs);
      sqlReadDispose = () => window.clearTimeout(sqlReadTimer);
    }

    return () => {
      unsubscribeRequests?.();
      sqlReadDispose?.();
      liveShadowCompare.dispose();
    };
  }, [
    isPlayerRole,
    playerUid,
    isStaleLivePopupEvent,
    markOutcomeSeen,
    markRechargeSplashSeen,
    markRedeemSplashSeen,
    markPlayerStartupFlag,
    logPlayerStartupPhase,
    startupNow,
  ]);

  useEffect(() => {
    if (!isPlayerRole || !playerUid) {
      cashoutListenerStartedForUidRef.current = '';
      return;
    }
    if (cashoutListenerStartedForUidRef.current === playerUid) {
      playerStartupDebugLog('[PLAYER_CASHOUT_LISTENER_SKIP_RESTART]', {
        playerUid,
        reason: 'already_started_for_identity',
      });
      return;
    }
    cashoutListenerStartedForUidRef.current = playerUid;
    playerStartupDebugLog('[PLAYER_CASHOUT_LISTENER_STABLE]', {
      playerUid,
      key: `player:${playerUid}`,
    });

    const splashSeenStorageKey = `playerCashoutSplashSeen:${playerUid}`;
    try {
      const raw = window.sessionStorage.getItem(splashSeenStorageKey);
      const parsed = raw ? (JSON.parse(raw) as string[]) : [];
      cashoutSplashSeenIdsRef.current = new Set(
        Array.isArray(parsed) ? parsed.filter(Boolean) : []
      );
    } catch {
      cashoutSplashSeenIdsRef.current = new Set();
    }

    let unsubscribe: (() => void) | null = null;
    const delayMs = isClientSqlReadMode() ? playerStartupJitterMs(250, 750) : 0;
    if (delayMs > 0) {
      logPlayerStartupPhase(
        2,
        '/api/player-cashout-tasks/cache',
        delayMs,
        'phase_2_cashout_cache'
      );
      playerStartupDebugLog('[PLAYER_STARTUP_STAGGER]', {
        target: '/api/player-cashout-tasks/cache',
        delayMs,
        reason: 'defer_secondary_sql_cache',
      });
    }
    const startCashoutListener = () => {
      playerStartupDebugLog('[PLAYER_CASHOUT_LISTENER_REUSE]', {
        playerUid,
        reason: 'identity_keyed_listener_start',
      });
      unsubscribe = listenPlayerCashoutTasksByPlayer(
        playerUid,
        (tasks) => {
          markPlayerStartupFlag('cashoutsLoaded', {
            source: '/api/player-cashout-tasks/cache',
            count: tasks.length,
          });
          markPlayerPerf('live_update_cashout_tasks', {
            count: tasks.length,
            activeView: activeViewRef.current,
          });
          setPlayerCashoutTasks((current) =>
            arePlayerCashoutTasksEqual(current, tasks) ? current : tasks
          );
          const completedTasks = tasks.filter((task) => task.status === 'completed');
          const recentCompletionCutoffMs = Date.now() - 5 * 60 * 1000;

          const nextStatusById: Record<string, string> = {};
          const newlyCompleted = completedTasks.filter((task) => {
            const previousStatus = knownCashoutStatusByIdRef.current[task.id];
            const completedAtMs = getTimestampMs(task.completedAt);
            const recentlyCompleted = completedAtMs >= recentCompletionCutoffMs;
            nextStatusById[task.id] = task.status;
            return (
              !cashoutSplashSeenIdsRef.current.has(task.id) &&
              ((previousStatus !== undefined && previousStatus !== 'completed') ||
                (previousStatus === undefined && recentlyCompleted))
            );
          });

          tasks.forEach((task) => {
            if (!nextStatusById[task.id]) {
              nextStatusById[task.id] = task.status;
            }
          });

          if (newlyCompleted.length > 0) {
            setShowCashoutSuccessSplash(true);
            newlyCompleted.forEach((task) => {
              cashoutSplashSeenIdsRef.current.add(task.id);
            });
            try {
              window.sessionStorage.setItem(
                splashSeenStorageKey,
                JSON.stringify([...cashoutSplashSeenIdsRef.current])
              );
            } catch {
              // Ignore storage write issues and continue UI flow.
            }
          }

          hasSeenCashoutTaskSnapshotRef.current = true;
          knownCompletedCashoutTaskIdsRef.current = new Set(
            completedTasks.map((task) => task.id)
          );
          knownCashoutStatusByIdRef.current = nextStatusById;
        },
        (error) => {
          reportPlayerUiError(
            'player_cashout_tasks_listener',
            error,
            setMessage,
            'Failed to confirm cashout completion.'
          );
        }
      );
    };

    const timer = window.setTimeout(startCashoutListener, delayMs);

    return () => {
      window.clearTimeout(timer);
      unsubscribe?.();
      if (cashoutListenerStartedForUidRef.current === playerUid) {
        cashoutListenerStartedForUidRef.current = '';
      }
    };
  }, [isPlayerRole, logPlayerStartupPhase, markPlayerStartupFlag, playerUid]);

  useEffect(() => {
    if (!referredByPlayerUid || referredByPlayerName || isClientSqlReadMode()) {
      return;
    }
    let cancelled = false;
    void getDoc(doc(db, 'users', referredByPlayerUid))
      .then((snap) => {
        if (!snap.exists() || cancelled) {
          return;
        }
        const username = String((snap.data() as { username?: string }).username || '').trim();
        if (username) {
          setReferredByPlayerName(username);
        }
      })
      .catch(() => {
        // Best-effort fallback for legacy users.
      });
    return () => {
      cancelled = true;
    };
  }, [referredByPlayerUid, referredByPlayerName]);

  useEffect(() => {
    if (!isPlayerRole || !playerCoadminUid || !shouldListenToBonusEvents) {
      setBonusEvents([]);
      setBonusEventsSessionLoading(false);
      return;
    }

    if (PLAYER_BONUS_DEBUG) {
      console.info('[player bonusEvents] coadminUid', playerCoadminUid);
      console.info('[player bonusEvents] listener:start');
    }
    markPlayerStartupFlag('bonusListenerStarted', {
      source: 'listenBonusEventsByCoadmin',
      activeView,
    });
    const unsubscribe = listenBonusEventsByCoadmin(
      playerCoadminUid,
      (events) => {
        markPlayerPerf('live_update_bonus_events', {
          count: events.length,
          activeView,
        });
        if (PLAYER_BONUS_DEBUG) {
          console.info('[player bonusEvents] render-values', {
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
        }
        playerDebugLog('[BONUS_EVENTS_STATE_SET]', {
          beforeSetStateLength: events.length,
          playerCoadminUid,
        });
        setBonusEvents(events);
        setBonusEventsSessionLoading(false);
        playerDebugLog('[BONUS_EVENTS_STATE_SET]', {
          afterSetStateLength: events.length,
          playerCoadminUid,
        });
      },
      (error) => {
        console.error('[player bonusEvents] error', error);
        const message = error.message || 'Failed to load bonus events.';
        if (
          /X-Player-Session-Id|Player session required|Loading secure session|Loading session|player session not ready/i.test(
            message
          )
        ) {
          setBonusEventsSessionLoading(true);
          return;
        }
        reportPlayerUiError('player_bonus_events_listener', error, setMessage, message);
      },
      {
        skipTimeWindowFilter: true,
        isPlayerView: true,
        onSessionLoading: setBonusEventsSessionLoading,
        onSnapshotDebug: ({ snapshotSize, firstDocData }) => {
          if (PLAYER_BONUS_DEBUG) {
            console.info('[player bonusEvents] snapshot size', snapshotSize);
            console.info('[player bonusEvents] first doc', firstDocData);
          }
        },
      }
    );

    return () => {
      if (PLAYER_BONUS_DEBUG) {
        console.info('[player] bonus-events-listener:stop', {
          playerCoadminUid,
          activeView,
        });
      }
      unsubscribe();
    };
  }, [activeView, isPlayerRole, markPlayerStartupFlag, playerCoadminUid, shouldListenToBonusEvents]);

  useEffect(() => {
    if (!isPlayerRole || !playerUid) {
      return;
    }

    if (
      isClientSqlReadMode() ||
      assertClientFirestoreDisabled('player_profile_listener', 'onSnapshot', { playerUid })
    ) {
      let disposed = false;
      let stopPoll: (() => void) | null = null;
      const delayMs = baseDataLoadedRef.current ? 750 : 2_000;
      playerStartupDebugLog('[PLAYER_STARTUP_STAGGER]', {
        target: 'player_profile_poll',
        delayMs,
        reason: baseDataLoadedRef.current
          ? 'defer_secondary_sql_poll'
          : 'wait_for_base_data_before_profile_poll',
      });
      const timer = window.setTimeout(() => {
        if (disposed) {
          return;
        }
        markPlayerStartupFlag('profilePollStarted', {
          source: 'attachPlayerProfileSqlPoll',
        });
        playerStartupDebugLog('[PLAYER_SESSION_ME_STARTUP_SKIP_DUPLICATE]', {
          uid: playerUid,
          reason: 'profile_poll_initial_fetch_delayed',
          initialDelayMs: 10_000,
        });
        stopPoll = attachPlayerProfileSqlPoll((profile) => {
          applyPlayerProfileSnapshot(profile, playerUid);
        }, { initialDelayMs: 10_000 });
      }, delayMs);
      return () => {
        disposed = true;
        window.clearTimeout(timer);
        stopPoll?.();
      };
    }

    const unsubscribe = onSnapshot(
      doc(db, 'users', playerUid),
      (snapshot) => {
        if (!snapshot.exists()) {
          setWalletIfChanged({ coin: 0, cash: 0 });
          setIsBlockedPlayer(false);
          setPlayerUsername('');
          return;
        }

        const playerData = snapshot.data() as {
          role?: string;
          status?: string;
          coin?: number;
          cash?: number;
          coadminUid?: string | null;
          createdBy?: string | null;
          referralCode?: string;
          username?: string;
          referredByUid?: string;
          referredByUsername?: string;
          referralBonusNotice?: string;
          referralBonusNoticeAt?: unknown;
          dismissedPaymentDetailsNoticeVersion?: number;
        };

        setWalletIfChanged({
          coin: Number(playerData.coin || 0),
          cash: Number(playerData.cash || 0),
        });
        setDismissedPaymentDetailsNoticeVersion(
          Number(playerData.dismissedPaymentDetailsNoticeVersion || 0)
        );
        setPlayerUsername(String(playerData.username || '').trim());
        const resolvedCoadminUid = resolveCoadminUid({
          uid: playerUid,
          ...playerData,
        });
        if (!resolvedCoadminUid) {
          setPaymentDetailsNoticeVersion(0);
        }
        setPlayerCoadminUid(resolvedCoadminUid ? String(resolvedCoadminUid) : '');
        const isPlayerRole = String(playerData.role || '').toLowerCase() === 'player';
        const nextReferralCode = String(playerData.referralCode || '').trim();
        if (isPlayerRole && /^\d{6,10}$/.test(nextReferralCode)) {
          setReferralCode(nextReferralCode);
        } else if (isPlayerRole) {
          setReferralCode('');
          void ensureCurrentPlayerReferralCode(playerUid);
        } else {
          setReferralCode('');
        }
        setReferredByPlayerName(String(playerData.referredByUsername || '').trim());
        setReferredByPlayerUid(String(playerData.referredByUid || '').trim());
        setIsBlockedPlayer(playerData.status === 'disabled');

        const referralNotice = String(playerData.referralBonusNotice || '').trim();
        const noticeTimestamp = getTimestampMs(playerData.referralBonusNoticeAt);
        if (referralNotice && noticeTimestamp > 0) {
          const noticeKey = `playerReferralNoticeSeen:${playerUid}:${noticeTimestamp}`;
          const hasSeen = window.sessionStorage.getItem(noticeKey) === '1';
          if (!hasSeen) {
            setMessage('Your referral was successful. Referral bonus has been added.');
            window.sessionStorage.setItem(noticeKey, '1');
          }
        }
      },
      () => {
        setWalletIfChanged({ coin: 0, cash: 0 });
        setPlayerUsername('');
        setDismissedPaymentDetailsNoticeVersion(0);
        setReferralCode('');
        setReferredByPlayerName('');
        setReferredByPlayerUid('');
      }
    );

    return () => unsubscribe();
  }, [baseDataLoaded, isPlayerRole, markPlayerStartupFlag, playerUid]);

  const loadReferralRewards = useCallback(async (options: { force?: boolean } = {}) => {
    if (shouldSkipIndividualLoader('referral', options.force)) {
      return;
    }

    if (!playerUid) {
      setReferralRewardGroupsIfChanged([]);
      setReferralRewardsLoading(false);
      return;
    }
    setReferralRewardsLoading(true);
    try {
      const groups = await fetchMyReferralRewards();
      setReferralRewardGroupsIfChanged(groups);
    } catch (error) {
      reportPlayerUiError(
        'player_referral_rewards',
        error,
        setMessage,
        'Failed to load referral rewards.'
      );
    } finally {
      setReferralRewardsLoading(false);
    }
  }, [playerUid, shouldSkipIndividualLoader]);

  const handleClaimReferralReward = useCallback(async (referredPlayerUid: string) => {
    if (!referredPlayerUid || claimingReferredPlayerUid) {
      return;
    }
    setClaimingReferredPlayerUid(referredPlayerUid);
    setMessage('');
    try {
      const result = await claimMyReferralReward(referredPlayerUid);
      setMessage(
        result.message ||
          "Congratulations! You received referral reward coins from this player's recharge."
      );
      setEarnedRewardSplashCoins(Math.max(0, Number(result.rewardCoins || 0)));
      await loadReferralRewards({ force: true });
    } catch (error) {
      reportPlayerUiError(
        'player_referral_reward_claim',
        error,
        setMessage,
        'Failed to claim referral reward.'
      );
    } finally {
      setClaimingReferredPlayerUid(null);
    }
  }, [claimingReferredPlayerUid, loadReferralRewards]);

  const loadFreeplayGift = useCallback(async (options: { force?: boolean } = {}) => {
    if (shouldSkipIndividualLoader('freeplay', options.force)) {
      return;
    }

    if (!playerUid) {
      setHasPendingFreeplayGift(false);
      setPendingFreeplayGiftId('');
      return;
    }
    try {
      const pendingGift = await fetchPendingFreeplayGift();
      setHasPendingFreeplayGift(pendingGift.hasPendingGift);
      setPendingFreeplayGiftId(pendingGift.giftId);
    } catch (error) {
      reportPlayerUiError(
        'player_freeplay_load',
        error,
        setMessage,
        'Failed to load FreePlay gift.'
      );
    }
  }, [playerUid, shouldSkipIndividualLoader]);

  useEffect(() => {
    if (!isPlayerRole || !playerUid || !playerCoadminUid) {
      baseDataLoadedRef.current = false;
      baseDataLoadingRef.current = false;
      setBaseDataLoaded(false);
      setBaseDataLoading(false);
      return;
    }

    let isCancelled = false;

    async function loadInitialPlayerBaseData() {
      const sessionUser = await resolvePlayerRoleForFetch('/api/player/base-data');
      if (!sessionUser || isCancelled) {
        return;
      }

      baseDataLoadingRef.current = true;
      setBaseDataLoading(true);
      baseDataLoadedRef.current = false;
      setBaseDataLoaded(false);

      try {
        const baseData = await loadPlayerBaseData();
        if (isCancelled) {
          return;
        }

        setAgentsIfChanged(baseData.staff as AdminUser[]);
        setCoadminFrontendLinkByGameKey(buildCoadminFrontendLinkMap(baseData.gameLogins));
        setHasPendingFreeplayGift(baseData.pendingGift.hasPendingGift);
        setPendingFreeplayGiftId(String(baseData.pendingGift.giftId || '').trim());
        setReferralRewardGroupsIfChanged(baseData.referralRewards.groups);
        setReferralRewardsLoading(false);

        baseDataLoadedRef.current = true;
        setBaseDataLoaded(true);
      } catch (error) {
        if (isCancelled) {
          return;
        }

        baseDataLoadedRef.current = false;
        setBaseDataLoaded(false);

        playerDebugLog('[PLAYER_BASE_DATA_CLIENT]', {
          stage: 'fallback',
          deduped: false,
          usedFallback: true,
          reason: error instanceof Error ? error.message : 'load_failed',
        });

        await loadAgents({ force: true });

        try {
          const coadminGames = await loadCoadminGameLogins(playerCoadminUid, { force: true });
          if (!isCancelled) {
            setCoadminFrontendLinkByGameKey(buildCoadminFrontendLinkMap(coadminGames));
          }
        } catch {
          if (!isCancelled) {
            setCoadminFrontendLinkByGameKey({});
          }
        }

        if (!isCancelled && playerUid) {
          await loadFreeplayGift({ force: true });

          setReferralRewardsLoading(true);
          try {
            await loadReferralRewards({ force: true });
          } finally {
            if (!isCancelled) {
              setReferralRewardsLoading(false);
            }
          }
        }
      } finally {
        if (!isCancelled) {
          baseDataLoadingRef.current = false;
          setBaseDataLoading(false);
        }
      }
    }

    void loadInitialPlayerBaseData();
    return () => {
      isCancelled = true;
      baseDataLoadingRef.current = false;
    };
  }, [
    buildCoadminFrontendLinkMap,
    loadAgents,
    loadCoadminGameLogins,
    loadFreeplayGift,
    loadReferralRewards,
    playerCoadminUid,
    playerUid,
    isPlayerRole,
  ]);

  const handleClaimFreeplayGift = useCallback(async () => {
    if (!hasPendingFreeplayGift || !pendingFreeplayGiftId || claimingFreeplayGift) {
      return;
    }
    console.info('[FREEPLAY_CLAIM_CLICK]', {
      playerUid: playerUid || null,
      giftId: pendingFreeplayGiftId,
    });
    const revealStartedAt = Date.now();
    playGiftSound();
    setClaimingFreeplayGift(true);
    setMessage('');
    try {
      const result = await claimFreeplayGift(pendingFreeplayGiftId);
      const revealTimeRemainingMs = Math.max(0, 450 - (Date.now() - revealStartedAt));
      if (revealTimeRemainingMs > 0) {
        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, revealTimeRemainingMs);
        });
      }
      setHasPendingFreeplayGift(false);
      setPendingFreeplayGiftId('');
      setFreeplayClaimSuccessMessage(
        result.message || `You got ${result.amount} FreePlay coins!`
      );
      void loadPlayerProfileSnapshotOnce().then((profile) => {
        if (profile) {
          applyPlayerProfileSnapshot(profile, playerUid || '');
        }
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Could not claim freeplay. Please try again.';
      console.info('[FREEPLAY_CLAIM_API_ERROR]', {
        playerUid: playerUid || null,
        giftId: pendingFreeplayGiftId,
        error: errorMessage,
      });
      reportPlayerUiError(
        'player_freeplay_claim',
        error,
        setMessage,
        errorMessage
      );
      await loadFreeplayGift({ force: true });
    } finally {
      setClaimingFreeplayGift(false);
    }
  }, [
    applyPlayerProfileSnapshot,
    claimingFreeplayGift,
    hasPendingFreeplayGift,
    loadFreeplayGift,
    pendingFreeplayGiftId,
    playGiftSound,
    playerUid,
  ]);

  useEffect(() => {
    if (!freeplayClaimSuccessMessage) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      setFreeplayClaimSuccessMessage('');
    }, 3000);
    return () => window.clearTimeout(timeoutId);
  }, [freeplayClaimSuccessMessage]);

  useEffect(() => {
    if (activeView !== 'earn-coins') {
      return;
    }
    if (baseDataLoaded || baseDataLoading) {
      return;
    }
    void loadReferralRewards();
    void loadFreeplayGift();
  }, [activeView, baseDataLoaded, baseDataLoading, loadFreeplayGift, loadReferralRewards]);

  useEffect(() => {
    if (activeView !== 'agents' || !playerUid) {
      return undefined;
    }
    if (baseDataLoaded || baseDataLoading) {
      return undefined;
    }
    const nextTimeoutId = window.setTimeout(() => {
      void loadAgents();
    }, 0);
    return () => window.clearTimeout(nextTimeoutId);
  }, [activeView, baseDataLoaded, baseDataLoading, loadAgents, playerUid]);

  useEffect(() => {
    if (activeView !== 'play') {
      closeActiveTableSplash();
    }
    if (activeView !== 'usernames') {
      setCredentialResetModal(null);
    }
  }, [activeView]);

  useEffect(() => {
    if (activeView !== 'play') {
      return;
    }

    if (!playPanelRenderStartLoggedRef.current) {
      playPanelRenderStartLoggedRef.current = true;
      playerDevLog('[PLAY_PANEL_RENDER_START]', {
        elapsed_ms: startupNow(),
        source: 'active_view_effect',
        activeView,
        isPlayerRole,
        hasPlayerUid: Boolean(playerUid),
        baseDataLoaded,
        loadingList,
      });
    }

    const waitingFor = [
      !isPlayerRole ? 'sessionMe_player_role' : '',
      !playerUid ? 'sessionMe_player_uid' : '',
      loadingList ? 'play_data_cards' : '',
    ].filter(Boolean);
    const waitingKey = waitingFor.join('|') || 'none';
    if (playPanelLastWaitingForRef.current !== waitingKey) {
      playPanelLastWaitingForRef.current = waitingKey;
      playerDevLog('[PLAY_PANEL_WAITING_FOR]', {
        elapsed_ms: startupNow(),
        waitingFor,
        notWaitingFor: [
          'baseData',
          'completedUsernameCarers',
          'bonusEvents',
          'liveSnapshot',
          'cashoutTasks',
          'chat',
          'unreadCounts',
          'presence',
          'referralData',
          'freeplayData',
        ],
      });
    }

    const hasValidShellSession = Boolean(isPlayerRole && playerUid);
    if (!hasValidShellSession) {
      const reason = !isPlayerRole ? 'player_role_not_confirmed' : 'player_uid_missing';
      if (playPanelBlockedLoggedRef.current !== reason) {
        playPanelBlockedLoggedRef.current = reason;
        playerDevLog('[PLAY_PANEL_RENDER_BLOCKED]', {
          reason,
          elapsed_ms: startupNow(),
        });
      }
      return;
    }

    if (!playPanelShellLoggedRef.current) {
      playPanelShellLoggedRef.current = true;
      playerDevLog('[PLAY_PANEL_SHELL_VISIBLE]', {
        elapsed_ms: startupNow(),
        hasGameLogins: gameLogins.length > 0,
        gameLoginCount: gameLogins.length,
        waitsForBaseData: false,
      });
    }

    if (!playPanelNoncriticalDeferredLoggedRef.current) {
      playPanelNoncriticalDeferredLoggedRef.current = true;
      playerDevLog('[PLAY_PANEL_NONCRITICAL_DEFERRED]', {
        elapsed_ms: startupNow(),
        deferred: [
          'referral_rewards',
          'freeplay',
          'staff',
          'cashouts',
          'chat_unread',
          'live_snapshot',
          'base_data',
        ],
      });
    }
  }, [activeView, baseDataLoaded, gameLogins.length, isPlayerRole, loadingList, playerUid, startupNow]);

  useEffect(() => {
    if (activeView !== 'bonus-events') {
      setShowBonusPanelHint(false);
      return;
    }

    setShowBonusPanelHint(true);
    const timeoutId = window.setTimeout(() => {
      setShowBonusPanelHint(false);
    }, 5000);

    return () => window.clearTimeout(timeoutId);
  }, [activeView]);

  useEffect(() => {
    if (!maintenanceBreak.enabled) {
      return;
    }

    console.info('[MAINTENANCE] blocked player action', {
      playerUid: playerUid || auth.currentUser?.uid || null,
      coadminUid: playerCoadminUid || null,
    });
    closeActiveTableSplash();
    setShowCashoutModal(false);
    setShowLoadCoinPanel(false);
    setShowCoinConfirmSplash(false);
    clearPlayerRequestProgressTimers(requestIdempotencyKeyRef.current || null, 'maintenance_break', true);
    setPlayRequestSplash(null);
    setRequestLoading(false);
    if (activeView === 'play' || activeView === 'bonus-events' || activeView === 'earn-coins') {
      setActiveView('dashboard');
    }
  }, [activeView, closeActiveTableSplash, maintenanceBreak.enabled, playerCoadminUid, playerUid]);

  function clearPlayerRequestProgressTimers(
    clientRequestId: string | null,
    reason?: string,
    logAbort = false
  ) {
    for (const timeoutId of requestProgressTimeoutsRef.current) {
      window.clearTimeout(timeoutId);
    }
    requestProgressTimeoutsRef.current = [];
    if (logAbort && clientRequestId) {
      playerDevLog('[PLAYER_REQUEST_PROGRESS_ABORTED]', {
        clientRequestId,
        reason: reason || 'aborted',
      });
    }
  }

  function startPlayerRequestProgress(clientRequestId: string, startedAt: number) {
    clearPlayerRequestProgressTimers(clientRequestId);
    const nowMs = () =>
      typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();
    const phases = [
      { delayMs: 0, phase: 'finding_carer', statusText: 'Finding carer...', progress: 15 },
      { delayMs: 300, phase: 'carer_found', statusText: 'Carer found', progress: 35 },
      { delayMs: 700, phase: 'sending_request', statusText: 'Sending request...', progress: 60 },
      {
        delayMs: 1200,
        phase: 'securing_request',
        statusText: 'Securing your request...',
        progress: 82,
      },
      { delayMs: 2000, phase: 'almost_done', statusText: 'Almost done...', progress: 92 },
    ];
    const applyPhase = (phase: (typeof phases)[number]) => {
      setPlayRequestSplash((current) =>
        current
          ? {
              ...current,
              statusText: phase.statusText,
              progress: phase.progress,
            }
          : current
      );
      playerDevLog('[PLAYER_REQUEST_PROGRESS_PHASE]', {
        clientRequestId,
        phase: phase.phase,
        progress: phase.progress,
        elapsedMs: Math.round(nowMs() - startedAt),
      });
    };
    applyPhase(phases[0]);
    requestProgressTimeoutsRef.current = phases.slice(1).map((phase) =>
      window.setTimeout(() => {
        applyPhase(phase);
      }, phase.delayMs)
    );
  }

  useEffect(() => {
    return () => {
      clearPlayerRequestProgressTimers(
        requestIdempotencyKeyRef.current || null,
        'component_unmount',
        true
      );
    };
  }, []);

  async function handleGameRequest(
    type: PlayerGameRequestType,
    clickEvent?: MouseEvent<HTMLButtonElement>
  ) {
    const clickStartedAt =
      typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();
    const nowMs = () =>
      typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();
    clickEvent?.preventDefault();
    clickEvent?.stopPropagation();
    if (requestSubmitInFlightRef.current) {
      playerDevLog('[PLAYER_REQUEST_ERROR_SHOWN]', {
        requestType: type,
        clientRequestId: requestIdempotencyKeyRef.current || null,
        reason: 'duplicate_submit_blocked',
        errorCode: 'duplicate_submit_blocked',
        clickToErrorMs: Math.round(nowMs() - clickStartedAt),
      });
      return;
    }
    requestSubmitInFlightRef.current = true;
    if (!requestIdempotencyKeyRef.current) {
      requestIdempotencyKeyRef.current =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }
    const clientRequestId = requestIdempotencyKeyRef.current;
    playerDevLog('[PLAYER_ACTION_CLICK]', {
      action: type,
      defaultPrevented: clickEvent?.defaultPrevented ?? false,
    });
    playerDevLog('[PLAYER_REQUEST_CLICK]', {
      requestType: type,
      gameName: selectedGameName || null,
      clientRequestId,
      hasAmount: Boolean(playAmount),
    });

    const amountText = sanitizeWholeAmountText(playAmount);
    flushSync(() => {
      setRequestLoading(true);
      setMessage('Finding carer...');
      setPlayRequestSplash({
        type,
        gameName: selectedGameName,
        amountText,
        statusText: 'Finding carer...',
        progress: 15,
      });
    });
    playerDevLog('[PLAYER_REQUEST_PENDING_VISIBLE]', {
      requestType: type,
      clientRequestId,
      clickToPendingVisibleMs: Math.round(nowMs() - clickStartedAt),
    });
    startPlayerRequestProgress(clientRequestId, clickStartedAt);

    const clearPendingForRetry = (reason: string) => {
      clearPlayerRequestProgressTimers(clientRequestId, reason, true);
      setRequestLoading(false);
      setPlayRequestSplash(null);
      requestSubmitInFlightRef.current = false;
      requestIdempotencyKeyRef.current = '';
      playerDevLog('[PLAYER_REQUEST_ERROR_SHOWN]', {
        requestType: type,
        clientRequestId,
        reason,
        errorCode: reason,
        clickToErrorMs: Math.round(nowMs() - clickStartedAt),
      });
    };

    if (maintenanceBreak.enabled) {
      console.info('[MAINTENANCE] blocked player action', {
        action: type,
        playerUid: playerUid || auth.currentUser?.uid || null,
        coadminUid: playerCoadminUid || null,
      });
      setMessage(maintenanceBreak.message);
      clearPendingForRetry('maintenance_break');
      return;
    }

    if (isBlockedPlayer) {
      setMessage(
        'Your account is blocked. Recharge and redeem requests are disabled.'
      );
      clearPendingForRetry('blocked_player');
      return;
    }

    const amountNum = Number(amountText);
    if (type === 'recharge') {
      if (!Number.isFinite(amountNum) || amountNum <= 0) {
        setMessage('Enter a valid amount.');
        clearPendingForRetry('invalid_recharge_amount');
        return;
      }
      const uid = auth.currentUser?.uid;
      if (uid && !isClientSqlReadMode()) {
        const liveSnap = await getDoc(doc(db, 'users', uid));
        if (liveSnap.exists()) {
          const liveCoin = Number(
            (liveSnap.data() as { coin?: number }).coin || 0
          );
          setWallet((current) => {
            const nextWallet = { ...current, coin: liveCoin };
            return areWalletsEqual(current, nextWallet) ? current : nextWallet;
          });
          if (liveCoin < amountNum) {
            clearPendingForRetry('insufficient_coin_live_check');
            setMessage(
              'Not enough coin to send a recharge. Add coin first — for example use “Transfer all cash to coin” when you have cash, or use a lower amount.'
            );
            return;
          }
        }
      } else if (amountNum > wallet.coin) {
        clearPendingForRetry('insufficient_coin_cached');
        setMessage(
          'Not enough coin to send a recharge. Add coin first — for example use “Transfer all cash to coin” when you have cash, or use a lower amount.'
        );
        return;
      }
    }
    if (type === 'redeem') {
      if (!Number.isFinite(amountNum) || amountNum < MIN_REDEEM_AMOUNT || amountNum > MAX_REDEEM_AMOUNT) {
        setMessage(`Redeem amount must be between ${MIN_REDEEM_AMOUNT} and ${MAX_REDEEM_AMOUNT}.`);
        clearPendingForRetry('invalid_redeem_amount');
        return;
      }
    }

    closeActiveTableSplash();

    try {
      if (!requestIdempotencyKeyRef.current) {
        requestIdempotencyKeyRef.current =
          typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      }
      const idempotencyKey = requestIdempotencyKeyRef.current;
      let apiStartedAt = 0;
      const result = await createPlayerGameRequest({
        gameName: selectedGameName,
        amount: amountNum,
        type,
        idempotencyKey,
        onApiStart: ({ route }) => {
          apiStartedAt = nowMs();
          playerDevLog('[PLAYER_REQUEST_API_START]', {
            requestType: type,
            route,
            clientRequestId: idempotencyKey,
            clickToApiStartMs: Math.round(apiStartedAt - clickStartedAt),
          });
        },
      });
      const responseAt = nowMs();
      playerDevLog('[PLAYER_REQUEST_API_RESPONSE]', {
        requestType: type,
        clientRequestId: idempotencyKey,
        requestId: result.requestId,
        ok: result.ok,
        status: result.status,
        duplicate: result.duplicate === true,
        authority: result.authority || null,
        apiDurationMs: apiStartedAt > 0 ? Math.round(responseAt - apiStartedAt) : null,
        clickToResponseMs: Math.round(responseAt - clickStartedAt),
      });

      saveRecentPlayAmount(type, amountText);
      setRequestHistory((current) => {
        const nextRequests = sortByNewest([
          result.request,
          ...current.filter((request) => request.id !== result.requestId),
        ]);
        return arePlayerRequestsEqual(current, nextRequests) ? current : nextRequests;
      });
      setMessage(type === 'redeem' ? PLAYER_REDEEM_SENT_MESSAGE : PLAYER_RECHARGE_SENT_MESSAGE);
      const toastAt = nowMs();
      clearPlayerRequestProgressTimers(idempotencyKey);
      flushSync(() => {
        setPlayRequestSplash((current) =>
          current
            ? {
                ...current,
                statusText: 'Request sent successfully',
                progress: 100,
              }
            : current
        );
      });
      playerDevLog('[PLAYER_REQUEST_PROGRESS_COMPLETE]', {
        clientRequestId: idempotencyKey,
        apiDurationMs: apiStartedAt > 0 ? Math.round(responseAt - apiStartedAt) : null,
        finalProgress: 100,
      });
      playerDevLog('[PLAYER_REQUEST_SUCCESS_TOAST_SHOWN]', {
        requestType: type,
        clientRequestId: idempotencyKey,
        requestId: result.requestId,
        responseToToastMs: Math.round(toastAt - responseAt),
        responseToSuccessToastMs: Math.round(toastAt - responseAt),
        clickToToastMs: Math.round(toastAt - clickStartedAt),
      });
      setPlayAmount('');
      requestIdempotencyKeyRef.current = '';
    } catch (error) {
      clearPlayerRequestProgressTimers(
        requestIdempotencyKeyRef.current || clientRequestId,
        'api_error',
        true
      );
      reportPlayerUiError('player_game_request', error, setMessage, 'Request failed.');
      const errorMeta = error as { status?: unknown; errorCode?: unknown };
      playerDevLog('[PLAYER_REQUEST_ERROR_SHOWN]', {
        requestType: type,
        clientRequestId: requestIdempotencyKeyRef.current || clientRequestId,
        reason: error instanceof Error ? error.message : String(error),
        errorCode: String(errorMeta.errorCode || errorMeta.status || 'request_failed'),
        status: Number(errorMeta.status || 0) || null,
        clickToErrorMs: Math.round(nowMs() - clickStartedAt),
      });
    } finally {
      setRequestLoading(false);
      setPlayRequestSplash(null);
      requestSubmitInFlightRef.current = false;
    }
  }

  async function performDismissRedeemRequest(request: PlayerGameRequest) {
    setDismissRedeemLoadingId(request.id);
    setMessage('');

    try {
      await dismissPlayerRedeemRequest(request.id);
      setMessage('Redeem request dismissed.');
    } catch (error) {
      reportPlayerUiError(
        'player_redeem_dismiss',
        error,
        setMessage,
        'Failed to dismiss redeem request.'
      );
    } finally {
      setDismissRedeemLoadingId(null);
    }
  }

  async function handleRedeemReadyForRetry(request: PlayerGameRequest) {
    if (!requestNeedsPlayerExit(request) || redeemRetryLoadingId === request.id) {
      return;
    }
    setRedeemRetryLoadingId(request.id);
    setMessage('');

    try {
      const response = await fetch('/api/player/game-requests/redeem-ready-for-retry', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(await getPlayerApiHeaders()),
        },
        body: JSON.stringify({ requestId: request.id }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        request?: PlayerGameRequest;
      };
      if (!response.ok) {
        throw new Error(payload.error || 'Failed to retry redeem request.');
      }
      playerDevLog('[PLAYER_EXIT_CONFIRMED_RETRY_REQUESTED]', { requestId: request.id });
      setRequestHistory((current) => {
        const nextRequests = sortByNewest(
          current.map((item) =>
            item.id === request.id
              ? {
                  ...item,
                  status: payload.request?.status || 'pending',
                  automationStatus: payload.request?.automationStatus || 'retry_requested',
                  playerMessage: null,
                }
              : item
          )
        );
        return arePlayerRequestsEqual(current, nextRequests) ? current : nextRequests;
      });
      setMessage('Thanks. Your redeem is ready to continue.');
    } catch (error) {
      reportPlayerUiError(
        'redeem_ready_for_retry',
        error,
        setMessage,
        'Failed to retry redeem request.'
      );
    } finally {
      setRedeemRetryLoadingId(null);
    }
  }

  async function confirmDismissRedeemSplash() {
    const request = redeemDismissSplashRequest;
    if (!request) {
      return;
    }
    try {
      await performDismissRedeemRequest(request);
    } finally {
      setRedeemDismissSplashRequest(null);
    }
  }

  const openCredentialResetModal = useCallback((
    gameLogin: PlayerGameLogin,
    taskType: 'reset_password' | 'recreate_username',
    event?: MouseEvent<HTMLButtonElement>
  ) => {
    event?.preventDefault();
    event?.stopPropagation();
    playerDevLog('[PLAYER_ACTION_CLICK]', {
      action: taskType === 'reset_password' ? 'game_reset_password' : 'recreate_username',
      defaultPrevented: event?.defaultPrevented ?? false,
      gameLoginId: gameLogin.id,
    });
    setCredentialResetModal({ gameLogin, taskType });
  }, []);

  async function executeCredentialResetTask(
    gameLogin: PlayerGameLogin,
    taskType: 'reset_password' | 'recreate_username'
  ) {
    const credentialCoadminUid =
      String(gameLogin.coadminUid || '').trim() || String(playerCoadminUid || '').trim();
    const currentMaintenanceBreak =
      maintenanceBreak.enabled || !credentialCoadminUid
        ? maintenanceBreak
        : await getCoadminMaintenanceBreakClient(credentialCoadminUid);
    if (currentMaintenanceBreak.enabled) {
      setMessage(currentMaintenanceBreak.message);
      return;
    }

    const loadingKey = `${taskType}:${gameLogin.id}`;
    setCredentialTaskLoadingKey(loadingKey);
    setMessage('');

    try {
      await createPlayerCredentialTask({
        taskType,
        playerUid: gameLogin.playerUid,
        playerUsername: gameLogin.playerUsername || 'Player',
        gameName: gameLogin.gameName,
        coadminUid: credentialCoadminUid,
        gameLoginId: gameLogin.id,
      });

      setMessage(
        taskType === 'reset_password'
          ? 'Reset password request sent.'
          : 'Recreate username task created successfully.'
      );
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : 'Failed to create task.';
      const friendlyMessage = /not authenticated|app session required|player role required/i.test(
        rawMessage
      )
        ? 'Session changed. Please refresh.'
        : rawMessage;
      reportPlayerUiError(
        'player_credential_task',
        friendlyMessage === rawMessage ? error : new Error(friendlyMessage),
        setMessage,
        'Failed to create task.'
      );
    } finally {
      setCredentialTaskLoadingKey(null);
    }
  }

  async function confirmCredentialResetModal() {
    if (!credentialResetModal) {
      return;
    }
    const { gameLogin, taskType } = credentialResetModal;
    setCredentialResetModal(null);
    await executeCredentialResetTask(gameLogin, taskType);
  }

  const handleImageSelect = useCallback(async (file: File) => {
    try {
      const { default: imageCompression } = await import('browser-image-compression');
      const compressed = await imageCompression(file, {
        maxSizeMB: 0.7,
        maxWidthOrHeight: 1000,
        useWebWorker: true,
      });

      setSelectedImage(compressed);
      setImagePreview(URL.createObjectURL(compressed));
    } catch (error) {
      console.error(error);
      setMessage('Failed to process image.');
    }
  }, []);

  const handleClearImage = useCallback(() => {
    setSelectedImage(null);

    if (imagePreview) {
      URL.revokeObjectURL(imagePreview);
    }

    setImagePreview(null);
  }, [imagePreview]);

  const handleSendMessage = useCallback(async (event: FormEvent) => {
    event.preventDefault();

    if (!selectedAgent) {
      return;
    }

    playerDevLog('[PLAYER_MESSAGE_SEND_CLICK]', {
      playerUid: playerUid || auth.currentUser?.uid || null,
      coadminUid: playerCoadminUid || null,
      peerUid: selectedAgent.uid,
      hasText: Boolean(newMessage.trim()),
      hasImage: Boolean(selectedImage),
    });

    try {
      if (selectedImage) {
        setSendingImage(true);
        await sendImageMessage(selectedAgent.uid, selectedImage);
        handleClearImage();
      }

      if (newMessage.trim()) {
        await sendChatMessage(selectedAgent.uid, newMessage);
        setNewMessage('');
      }
      window.requestAnimationFrame(() => {
        const el = agentsScrollRef.current;
        if (el) {
          el.scrollTop = el.scrollHeight;
        }
      });
    } catch (error) {
      reportPlayerUiError('player_agent_chat', error, setMessage, 'Failed to send message.');
    } finally {
      setSendingImage(false);
    }
  }, [handleClearImage, newMessage, playerCoadminUid, playerUid, selectedAgent, selectedImage]);

  const handleAgentSelect = useCallback((agent: AdminUser) => {
    setSelectedAgent(agent);
    setNewMessage('');
    handleClearImage();
    lastRenderedAgentReadRef.current = '';
  }, [handleClearImage]);

  const handleOpenFirstUnreadAgent = useCallback(() => {
    const unreadAgent =
      agents.find((agent) => (unreadCounts[agent.uid] || 0) > 0) || null;

    setActiveView('agents');

    if (unreadAgent) {
      handleAgentSelect(unreadAgent);
    }
  }, [agents, handleAgentSelect, unreadCounts]);

  const openPlayView = useCallback((source: string) => {
    if (!playPanelRenderStartLoggedRef.current) {
      playPanelRenderStartLoggedRef.current = true;
      playerDevLog('[PLAY_PANEL_RENDER_START]', {
        elapsed_ms: startupNow(),
        source,
        activeView,
        isPlayerRole,
        hasPlayerUid: Boolean(playerUid),
        baseDataLoaded,
        loadingList,
      });
    }
    setActiveView('play');
  }, [activeView, baseDataLoaded, isPlayerRole, loadingList, playerUid, startupNow]);

  const setActiveViewFromLobby = useCallback((value: SetStateAction<PlayerView>) => {
    if (typeof value === 'function') {
      setActiveView(value);
      return;
    }
    if (value === 'play') {
      openPlayView('lobby');
      return;
    }
    setActiveView(value);
  }, [openPlayView]);

  const handleChangeView = useCallback((view: PlayerView, options: { scrollToTop?: boolean } = {}) => {
    if (view === 'play') {
      openPlayView('handleChangeView');
      setMobileMenuOpen(false);
      setMessage('');
      setSelectedAgent(null);
      setNewMessage('');
      handleClearImage();
      if (options.scrollToTop === false) {
        return;
      }
      requestAnimationFrame(() => {
        pageScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
      return;
    }
    setActiveView(view);
    setMobileMenuOpen(false);
    setMessage('');
    setSelectedAgent(null);
    setNewMessage('');
    handleClearImage();
    if (options.scrollToTop === false) {
      return;
    }
    // Player page scrolls inside its own container, not only the window.
    requestAnimationFrame(() => {
      pageScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }, [handleClearImage, openPlayView]);

  function handlePanelTouchStart(event: TouchEvent<HTMLDivElement>) {
    if (event.touches.length !== 1) {
      panelSwipeStartRef.current = null;
      return;
    }

    const touch = event.touches[0];
    panelSwipeStartRef.current = { x: touch.clientX, y: touch.clientY };
  }

  function handlePanelTouchEnd(event: TouchEvent<HTMLDivElement>) {
    const start = panelSwipeStartRef.current;
    panelSwipeStartRef.current = null;
    if (!start || event.changedTouches.length !== 1) {
      return;
    }

    const touch = event.changedTouches[0];
    const deltaX = touch.clientX - start.x;
    const deltaY = touch.clientY - start.y;
    const absX = Math.abs(deltaX);
    const absY = Math.abs(deltaY);

    // Ignore small accidental drags; users often nudge the page while tapping controls.
    const minimumHorizontalSwipePx = 50;
    // Only mostly-horizontal gestures switch panels, preserving normal vertical scrolling.
    const horizontalDominanceRatio = 1.5;
    if (absX < minimumHorizontalSwipePx || absX < absY * horizontalDominanceRatio) {
      return;
    }

    const currentIndex = SWIPE_NAV_VIEWS.indexOf(activeView);
    if (currentIndex === -1) {
      return;
    }

    const nextIndex = deltaX < 0 ? currentIndex + 1 : currentIndex - 1;
    const nextView = SWIPE_NAV_VIEWS[nextIndex];
    if (!nextView) {
      return;
    }

    handleChangeView(nextView, { scrollToTop: false });
  }

  const togglePassword = useCallback((loginId: string) => {
    setVisiblePasswords((previous) => ({
      ...previous,
      [loginId]: !previous[loginId],
    }));
  }, []);

  function createCashToCoinTransferId() {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return crypto.randomUUID();
    }
    return `${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
  }

  const openCashToCoinTransferModal = useCallback(() => {
    if (maintenanceBreak.enabled) {
      setMessage(maintenanceBreak.message);
      return;
    }
    setPlayerTransferDirection('cash_to_coin');
    setCashToCoinTransferId(createCashToCoinTransferId());
    setTransferCoinAmountInput('');
    setMessage('');
    setShowCoinConfirmSplash(true);
  }, [maintenanceBreak.enabled, maintenanceBreak.message]);

  const openCoinToCashTransferModal = useCallback(() => {
    if (maintenanceBreak.enabled) {
      setMessage(maintenanceBreak.message);
      return;
    }
    setPlayerTransferDirection('coin_to_cash');
    setCashToCoinTransferId(createCashToCoinTransferId());
    setTransferCoinAmountInput('');
    setMessage('');
    setShowCoinConfirmSplash(true);
  }, [maintenanceBreak.enabled, maintenanceBreak.message]);

  function openPlayerPasswordResetModal(event?: MouseEvent<HTMLButtonElement>) {
    event?.preventDefault();
    event?.stopPropagation();
    playerDevLog('[PLAYER_ACTION_CLICK]', {
      action: 'reset_password',
      defaultPrevented: event?.defaultPrevented ?? false,
    });
    console.info('[RESET_PASSWORD_CLICK]', {
      playerUid: playerUid || null,
      sqlMode: isSqlPlayerRuntimeMode(),
    });
    setPlayerResetNewPassword('');
    setPlayerResetConfirmPassword('');
    setPlayerResetPasswordError('');
    setShowPlayerPasswordResetModal(true);
  }

  function closePlayerPasswordResetModal() {
    if (playerResetPasswordLoading) {
      return;
    }
    setShowPlayerPasswordResetModal(false);
    setPlayerResetNewPassword('');
    setPlayerResetConfirmPassword('');
    setPlayerResetPasswordError('');
  }

  async function handlePlayerPasswordResetSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const newPassword = playerResetNewPassword;
    const confirmPassword = playerResetConfirmPassword;
    if (!newPassword || !confirmPassword) {
      setPlayerResetPasswordError('New password and confirm password are required.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPlayerResetPasswordError('New password and confirm password must match.');
      return;
    }
    if (newPassword.length < MIN_PLAYER_PASSWORD_LENGTH) {
      setPlayerResetPasswordError(
        `Password must be at least ${MIN_PLAYER_PASSWORD_LENGTH} characters.`
      );
      return;
    }

    setPlayerResetPasswordLoading(true);
    setPlayerResetPasswordError('');
    try {
      console.info('[RESET_PASSWORD_SUBMIT_START]', {
        playerUid: playerUid || null,
        sqlMode: isSqlPlayerRuntimeMode(),
      });
      const headers = await getPlayerApiHeaders(true, { route: '/api/player/reset-password' });
      console.info('[RESET_PASSWORD_API_REQUEST]', {
        route: '/api/player/reset-password',
        hasAppSession: Boolean(headers['X-App-Session-Id']),
        hasPlayerSession: Boolean(headers['X-Player-Session-Id']),
        credentials: 'include',
      });
      const response = await fetch('/api/player/reset-password', {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify({ newPassword, confirmPassword }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        username?: string;
        authority?: string;
      };
      console.info('[RESET_PASSWORD_API_RESPONSE]', {
        ok: response.ok,
        status: response.status,
        authority: payload.authority || null,
        body: payload,
      });
      if (!response.ok) {
        const errorMessage =
          payload.error ||
          (response.status === 401
            ? 'Session expired. Please log in again.'
            : 'Password reset failed. Please try again.');
        throw new Error(errorMessage);
      }

      const rememberedUsername =
        String(payload.username || '').trim() ||
        playerUsername.trim() ||
        String(auth.currentUser?.displayName || '').trim();
      rememberPlayerLoginCredentials(rememberedUsername, newPassword);
      if (!isSqlPlayerRuntimeMode()) {
        await auth.currentUser?.getIdToken(true);
      }
      setMessage('Password reset successfully.');
      setShowPlayerPasswordResetModal(false);
      setPlayerResetNewPassword('');
      setPlayerResetConfirmPassword('');
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Password reset failed. Please try again.';
      console.info('[RESET_PASSWORD_API_ERROR]', {
        playerUid: playerUid || null,
        error: errorMessage,
      });
      setPlayerResetPasswordError(errorMessage);
    } finally {
      setPlayerResetPasswordLoading(false);
    }
  }

  async function handleCoinButtonClick() {
    if (maintenanceBreak.enabled) {
      console.info('[MAINTENANCE] blocked player action', {
        action: playerTransferDirection,
        playerUid: playerUid || auth.currentUser?.uid || null,
        coadminUid: playerCoadminUid || null,
      });
      setMessage(maintenanceBreak.message);
      return;
    }

    if (!playerUid) {
      setMessage('Player profile not loaded yet.');
      return;
    }

    const parsedAmount = Number(transferCoinAmountInput);
    const parsedCashToCoinFee = isCashToCoinTransfer
      ? cashoutLimitHitForCashToCoin
        ? getCashToCoinCashoutLimitFee(parsedAmount)
        : getCashToCoinFee(parsedAmount)
      : 0;
    const parsedTipAmount = isCashToCoinTransfer ? 0 : getCoinToCashTip(parsedAmount);
    const parsedCoinsReceived = isCashToCoinTransfer ? parsedAmount - parsedCashToCoinFee : 0;
    const parsedCashReceived = isCashToCoinTransfer ? 0 : parsedAmount - parsedTipAmount;
    if (!Number.isFinite(parsedAmount) || parsedAmount !== Math.floor(parsedAmount)) {
      setMessage('Amount must be a whole number.');
      return;
    }
    if (
      isCashToCoinTransfer &&
      !cashoutLimitHitForCashToCoin &&
      parsedAmount > CASH_TO_COIN_MAX_TRANSFER_AMOUNT
    ) {
      setMessage('Maximum transfer amount is $25.');
      return;
    }
    if (!isCashToCoinTransfer && parsedAmount < 10) {
      setMessage('Minimum Coin to Cash amount is 10.');
      return;
    }
    if (parsedAmount > transferSourceBalance) {
      setMessage(
        `Transfer amount cannot exceed your ${isCashToCoinTransfer ? 'cash' : 'coin'} balance.`
      );
      return;
    }
    if (isCashToCoinTransfer && parsedCoinsReceived <= 0) {
      setMessage('Coins you receive must be greater than zero.');
      return;
    }
    if (!isCashToCoinTransfer && parsedCashReceived <= 0) {
      setMessage('Cash you receive must be greater than zero after tip.');
      return;
    }

    setCoinLoading(true);
    setMessage('');

    try {
      const transferId = cashToCoinTransferId || createCashToCoinTransferId();
      setCashToCoinTransferId(transferId);
      playerDevLog('[PLAYER_TRANSFER_CLICK]', {
        direction: isCashToCoinTransfer ? 'cash_to_coin' : 'coin_to_cash',
        transferId,
        amount: parsedAmount,
      });
      console.info('[CONVERSION_SUBMIT]', {
        type: isCashToCoinTransfer ? 'cash_to_coin' : 'coin_to_cash',
        amount: parsedAmount,
      });
      if (isCashToCoinTransfer) {
        const result = await createCashToCoinTransferRequest(parsedAmount, transferId);
        const updatedCashBalance = Number(result.cashBalance ?? result.cash ?? 0);
        const updatedCoinBalance = Number(result.coinBalance ?? result.coin ?? 0);
        console.info('[CONVERSION_API_SUCCESS]', {
          type: 'cash_to_coin',
          updatedCoinBalance,
          updatedCashBalance,
          updatedCashBoxNpr: result.cashBoxNpr ?? null,
          transferAmount: result.transferAmount,
          feeAmount: result.feeAmount,
          transactionId: result.eventId || result.transferId || transferId,
        });
        setWalletIfChanged({ cash: updatedCashBalance, coin: updatedCoinBalance });
        console.info('[CONVERSION_LOCAL_BALANCE_UPDATED]', {
          type: 'cash_to_coin',
          source: 'api_response',
          updatedCoinBalance,
          updatedCashBalance,
        });
        setMessage('Cash converted to coins successfully.');
        playerDevLog('[PLAYER_TRANSFER_SUCCESS_TOAST_SHOW]', {
          direction: 'cash_to_coin',
          transferId,
          message: 'Cash converted to coins successfully.',
        });
      } else {
        const result = await createCoinToCashTransferRequest(parsedAmount, transferId);
        const updatedCashBalance = Number(result.cashBalance ?? result.cash ?? 0);
        const updatedCoinBalance = Number(result.coinBalance ?? result.coin ?? 0);
        console.info('[CONVERSION_API_SUCCESS]', {
          type: 'coin_to_cash',
          updatedCoinBalance,
          updatedCashBalance,
          updatedCashBoxNpr: result.cashBoxNpr ?? null,
          transferAmount: result.transferAmount,
          feeAmount: result.feeAmount,
          transactionId: result.eventId || result.transferId || transferId,
        });
        setWalletIfChanged({ cash: updatedCashBalance, coin: updatedCoinBalance });
        console.info('[CONVERSION_LOCAL_BALANCE_UPDATED]', {
          type: 'coin_to_cash',
          source: 'api_response',
          updatedCoinBalance,
          updatedCashBalance,
        });
        setMessage('Coins converted to cash successfully.');
        playerDevLog('[PLAYER_TRANSFER_SUCCESS_TOAST_SHOW]', {
          direction: 'coin_to_cash',
          transferId,
          message: 'Coins converted to cash successfully.',
        });
      }
      void loadPlayerProfileSnapshotOnce().then((profile) => {
        if (profile) {
          applyPlayerProfileSnapshot(profile, playerUid || auth.currentUser?.uid || '');
        }
        playerDebugLog('[PLAYER_SESSION_ME_REFETCH_DONE]', {
          direction: isCashToCoinTransfer ? 'cash_to_coin' : 'coin_to_cash',
          transferId,
          profileFound: Boolean(profile),
        });
      });
      setShowCoinConfirmSplash(false);
      setTransferCoinAmountInput('');
      setCashToCoinTransferId('');
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : isCashToCoinTransfer
            ? 'Failed to transfer cash to coin.'
            : 'Failed to transfer coin to cash.';
      playerDevLog('[PLAYER_TRANSFER_API_ERROR]', {
        direction: isCashToCoinTransfer ? 'cash_to_coin' : 'coin_to_cash',
        transferId: cashToCoinTransferId || null,
        error: errorMessage,
      });
      setMessage(errorMessage);
    } finally {
      setCoinLoading(false);
    }
  }

  function isPossibleBonusAbuseCashoutError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error || '');
    return (
      message.trim() === PLAYER_SAFE_BONUS_ABUSE_CASHOUT_ERROR ||
      /possible[\s_-]*bonus[\s_-]*abuse/i.test(message)
    );
  }

  function isMissingPreviousPaymentDetailsCashoutError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error || '');
    return /no[\s_-]*previous[\s_-]*payment[\s_-]*details/i.test(message);
  }

  function showPlayerCashoutError(
    source: string,
    error: unknown,
    fallbackMessage = 'Unable to create cashout request. Please try again.'
  ) {
    const rawError = error instanceof Error ? error.message : String(error || '');

    if (isPossibleBonusAbuseCashoutError(error)) {
      playerDevLog('[PLAYER_CASHOUT_FRIENDLY_ERROR]', {
        source,
        rawError,
        friendlyMessage: PLAYER_SAFE_BONUS_ABUSE_CASHOUT_ERROR,
      });
      setMessage(PLAYER_SAFE_BONUS_ABUSE_CASHOUT_ERROR);
      return;
    }

    if (isMissingPreviousPaymentDetailsCashoutError(error)) {
      playerDevLog('[PLAYER_CASHOUT_FRIENDLY_ERROR]', {
        source,
        rawError,
        friendlyMessage:
          'No previous payment details found. Please upload a QR or enter payment app details first.',
      });
      setMessage(
        'No previous payment details found. Please upload a QR or enter payment app details first.'
      );
      return;
    }

    playerDevLog('[PLAYER_CASHOUT_FRIENDLY_ERROR]', {
      source,
      rawError,
      friendlyMessage: fallbackMessage,
    });
    setMessage(fallbackMessage);
  }

  async function refreshPlayerWalletAfterCashout(source: string, taskId?: string | null) {
    const profile = await loadPlayerProfileSnapshotOnce({ force: true });
    if (profile) {
      applyPlayerProfileSnapshot(profile, playerUid || auth.currentUser?.uid || '');
    }
    playerDevLog('[PLAYER_CASHOUT_PROFILE_REFRESH_DONE]', {
      source,
      taskId: taskId || null,
      playerUid: playerUid || auth.currentUser?.uid || null,
      profileFound: Boolean(profile),
      cash: profile?.cash ?? null,
      coin: profile?.coin ?? null,
    });
  }

  async function handlePlayerCashoutRequest() {
    playerDevLog('[PLAYER_CASHOUT_CLICK]', {
      playerUid: playerUid || auth.currentUser?.uid || null,
      coadminUid: playerCoadminUid || null,
      payoutMethod: cashoutPayoutMethod,
      amountNpr: cashoutThisRequestNpr,
    });

    if (maintenanceBreak.enabled) {
      console.info('[MAINTENANCE] blocked player action', {
        action: 'cashout',
        playerUid: playerUid || auth.currentUser?.uid || null,
        coadminUid: playerCoadminUid || null,
      });
      setMessage(maintenanceBreak.message);
      return;
    }

    if (!playerCoadminUid) {
      setMessage('Coadmin not found for this player.');
      return;
    }

    const composedPaymentDetails =
      cashoutPayoutMethod === 'qr'
        ? cashoutQrUrl.trim()
          ? `Payout method: QR\nQR image: ${cashoutQrUrl.trim()}`
          : ''
        : [
            'Payout method: Payment app',
            cashoutAppName.trim() ? `App name: ${cashoutAppName.trim()}` : '',
            cashoutCashTag.trim() ? `Cash tag: ${cashoutCashTag.trim()}` : '',
            cashoutAccountName.trim() ? `Name on app: ${cashoutAccountName.trim()}` : '',
          ]
            .filter(Boolean)
            .join('\n');

    if (!composedPaymentDetails) {
      setMessage(
        cashoutPayoutMethod === 'qr'
          ? 'Upload your QR before sending cashout.'
          : 'Enter your payment app name, cash tag, and name on the app.'
      );
      return;
    }

    if (
      cashoutPayoutMethod === 'app' &&
      (!cashoutAppName.trim() || !cashoutCashTag.trim() || !cashoutAccountName.trim())
    ) {
      setMessage('Enter your payment app name, cash tag, and name on the app.');
      return;
    }

    setCashoutLoading(true);
    setMessage('');

    try {
      const result = await createPlayerCashoutTask({
        coadminUid: playerCoadminUid,
        paymentDetails: composedPaymentDetails,
        payoutMethod: cashoutPayoutMethod,
        qrImageUrl: cashoutPayoutMethod === 'qr' ? cashoutQrUrl.trim() : '',
        paymentAppName: cashoutPayoutMethod === 'app' ? cashoutAppName.trim() : '',
        paymentAppCashTag: cashoutPayoutMethod === 'app' ? cashoutCashTag.trim() : '',
        paymentAppAccountName:
          cashoutPayoutMethod === 'app' ? cashoutAccountName.trim() : '',
      });

      playerDevLog('[PLAYER_CASHOUT_RESPONSE]', {
        taskId: result.taskId || null,
        authority: result.authority || null,
        duplicate: result.duplicate ?? false,
      });

      await refreshPlayerWalletAfterCashout('player_cashout_create', result.taskId || null);
      setMessage('Cashout request sent. Waiting for confirmation.');
      setShowCashoutModal(false);
      setCashoutPayoutMethod('qr');
      setCashoutQrUrl('');
      setCashoutAppName('');
      setCashoutCashTag('');
      setCashoutAccountName('');
    } catch (error) {
      console.error('[PLAYER_CASHOUT_ERROR]', {
        playerUid: playerUid || auth.currentUser?.uid || null,
        coadminUid: playerCoadminUid || null,
        error: error instanceof Error ? error.message : String(error),
      });
      showPlayerCashoutError(
        'player_cashout_create',
        error,
        'Unable to create cashout request. Please try again.'
      );
    } finally {
      setCashoutLoading(false);
    }
  }

  async function handlePlayerCashoutUsingLastDetails() {
    playerDevLog('[PLAYER_CASHOUT_REUSE_LAST_CLICK]', {
      playerUid: playerUid || auth.currentUser?.uid || null,
      coadminUid: playerCoadminUid || null,
      amountNpr: cashoutThisRequestNpr,
      hasClientLastDetails: Boolean(lastUsableSavedCashout),
      lastMethod: lastUsableSavedCashout?.payment.method || null,
    });

    if (maintenanceBreak.enabled) {
      console.info('[MAINTENANCE] blocked player action', {
        action: 'cashout',
        playerUid: playerUid || auth.currentUser?.uid || null,
        coadminUid: playerCoadminUid || null,
      });
      setMessage(maintenanceBreak.message);
      return;
    }

    if (!playerCoadminUid) {
      setMessage('Coadmin not found for this player.');
      return;
    }

    if (cashoutThisRequestNpr <= 0) {
      setMessage('No cashout amount is available right now.');
      return;
    }

    const saved = lastUsableSavedCashout?.payment || null;
    if (
      !saved ||
      (saved.method !== 'qr' && saved.method !== 'app') ||
      (saved.method === 'qr' && !saved.qrImageUrl) ||
      (saved.method === 'app' &&
        (!saved.paymentAppName || !saved.paymentAppCashTag || !saved.paymentAppAccountName))
    ) {
      setMessage(
        'No previous payment details found. Please upload a QR or enter payment app details first.'
      );
      return;
    }

    const composedPaymentDetails =
      saved.method === 'qr'
        ? `Payout method: QR\nQR image: ${saved.qrImageUrl}`
        : [
            'Payout method: Payment app',
            `App name: ${saved.paymentAppName}`,
            `Cash tag: ${saved.paymentAppCashTag}`,
            `Name on app: ${saved.paymentAppAccountName}`,
          ].join('\n');

    setCashoutLoading(true);
    setMessage('');

    try {
      const idempotencyKey =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? `cashout-reuse-last:${crypto.randomUUID()}`
          : `cashout-reuse-last:${Date.now()}`;
      const result = await createPlayerCashoutTask({
        coadminUid: playerCoadminUid,
        paymentDetails: composedPaymentDetails,
        payoutMethod: saved.method,
        qrImageUrl: saved.method === 'qr' ? saved.qrImageUrl || '' : '',
        paymentAppName: saved.method === 'app' ? saved.paymentAppName || '' : '',
        paymentAppCashTag: saved.method === 'app' ? saved.paymentAppCashTag || '' : '',
        paymentAppAccountName:
          saved.method === 'app' ? saved.paymentAppAccountName || '' : '',
        reuseLastPaymentDetails: true,
        idempotencyKey,
      });

      playerDevLog('[PLAYER_CASHOUT_REUSE_LAST_RESPONSE]', {
        taskId: result.taskId || null,
        authority: result.authority || null,
        duplicate: result.duplicate ?? false,
        payoutMethod: saved.method,
      });

      await refreshPlayerWalletAfterCashout('player_cashout_reuse_last', result.taskId || null);
      setMessage('Cashout request sent using your last payment details.');
      setShowCashoutModal(false);
      setCashoutPayoutMethod('qr');
      setCashoutQrUrl('');
      setCashoutAppName('');
      setCashoutCashTag('');
      setCashoutAccountName('');
    } catch (error) {
      console.error('[PLAYER_CASHOUT_REUSE_LAST_ERROR]', {
        playerUid: playerUid || auth.currentUser?.uid || null,
        coadminUid: playerCoadminUid || null,
        error: error instanceof Error ? error.message : String(error),
      });
      showPlayerCashoutError(
        'player_cashout_reuse_last',
        error,
        'Unable to create cashout request. Please try again.'
      );
    } finally {
      setCashoutLoading(false);
    }
  }

  const handleActivateBonusEvent = useCallback(async (bonusEvent: BonusEvent) => {
    if (maintenanceBreak.enabled) {
      console.info('[MAINTENANCE] blocked player action', {
        action: 'bonus_event',
        playerUid: playerUid || auth.currentUser?.uid || null,
        coadminUid: playerCoadminUid || null,
      });
      setMessage(maintenanceBreak.message);
      return;
    }

    if (!playerUid) {
      setMessage('Player profile not loaded yet.');
      return;
    }

    setActivatingBonusEventId(bonusEvent.id);
    setMessage('');

    try {
      await initiateBonusEventPlay({
        playerUid,
        bonusEventId: bonusEvent.id,
      });
      selfClaimedBonusIdRef.current = bonusEvent.id;
      setMessage(
        `Bonus "${bonusEvent.bonusName}" started. Coins deducted and recharge task created automatically.`
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Failed to activate bonus event.';
      const lower = errorMessage.toLowerCase();
      if (
        lower.includes('loading secure session') ||
        lower.includes('loading session') ||
        lower.includes('player session not ready') ||
        lower.includes('player session required')
      ) {
        setBonusEventsSessionLoading(true);
        return;
      }
      if (
        lower.includes('low coin') ||
        lower.includes('already') ||
        lower.includes('no longer available') ||
        lower.includes('blocked')
      ) {
        setBonusErrorSplashMessage(errorMessage);
      } else {
        reportPlayerUiError(
          'player_bonus_activate',
          error,
          setMessage,
          'Failed to activate bonus event.'
        );
      }
    } finally {
      setActivatingBonusEventId(null);
    }
  }, [
    maintenanceBreak.enabled,
    maintenanceBreak.message,
    playerCoadminUid,
    playerUid,
  ]);

  function readPlayerLogoutContext() {
    const cached = getCachedSessionUser();
    const appSessionId = getLocalAppSessionId();
    const playerSessionId = getLocalPlayerSessionId();
    return {
      currentPath:
        typeof window !== 'undefined' ? window.location.pathname || '/player' : '/player',
      uid: cached?.uid ?? null,
      role: cached?.role ?? null,
      appSessionIdPrefix: appSessionId ? appSessionId.slice(0, 8) : null,
      playerSessionIdPrefix: playerSessionId ? playerSessionId.slice(0, 8) : null,
    };
  }

  function openLogoutConfirmSplash(source: 'player_nav' | 'maintenance_break') {
    setLogoutConfirmSource(source);
    setShowLogoutConfirmSplash(true);
  }

  async function performLogout(options: { userConfirmed: boolean; source: string }) {
    const logoutContext = readPlayerLogoutContext();
    if (options.userConfirmed !== true) {
      playerDevLog('[PLAYER_LOGOUT_BLOCKED]', {
        source: options.source,
        reason: 'missing_user_confirmation',
        currentPath: logoutContext.currentPath,
        uid: logoutContext.uid,
        role: logoutContext.role,
        appSessionIdPrefix: logoutContext.appSessionIdPrefix,
        playerSessionIdPrefix: logoutContext.playerSessionIdPrefix,
      });
      return;
    }

    playerDevLog('[PLAYER_LOGOUT_CONFIRMED]', {
      source: options.source,
      currentPath: logoutContext.currentPath,
      uid: logoutContext.uid,
      role: logoutContext.role,
      appSessionIdPrefix: logoutContext.appSessionIdPrefix,
      playerSessionIdPrefix: logoutContext.playerSessionIdPrefix,
    });

    setLogoutLoading(true);
    setMessage('');
    try {
      await endLocalPlayerSession('logout', {
        trigger: 'user_logout',
        route: logoutContext.currentPath,
        file: 'app/player/page.tsx',
        function: 'performLogout',
        userClickedLogout: true,
      });
      await performSqlClientLogoutCleanup(options.source);
      try {
        await signOut(auth);
      } catch {
        // SQL logout does not require Firebase sign-out.
      }
      setShowLogoutConfirmSplash(false);
      setLogoutConfirmSource(null);
      router.replace('/login');
    } catch (err) {
      setMessage(
        err instanceof Error ? err.message : 'Could not sign out. Try again.'
      );
    } finally {
      setLogoutLoading(false);
    }
  }

  async function handleSendCashoutInquiry() {
    if (!playerCoadminUid) {
      setMessage('Coadmin not found for this player.');
      return;
    }

    const cleanMessage = cashoutInquiryMessage.trim();

    if (cleanMessage.length < 8) {
      setMessage('Please write a clear inquiry message (at least 8 characters).');
      return;
    }

    setSendingCashoutInquiry(true);
    setMessage('');

    try {
      await sendCarerCashboxInquiryAlert({
        coadminUid: playerCoadminUid,
        message: cleanMessage,
      });
      setMessage('Inquiry sent to coadmin and staff.');
      setShowInquirySentToast(true);
      window.setTimeout(() => setShowInquirySentToast(false), 2500);
      setCashoutInquiryMessage('');
      setShowCashoutInquiryPanel(false);
    } catch (error) {
      reportPlayerUiError('player_cashout_inquiry', error, setMessage, 'Failed to send inquiry.');
    } finally {
      setSendingCashoutInquiry(false);
    }
  }

  const shouldShowPaymentDetailsNotice =
    paymentDetailsNoticeVersion > 0 &&
    paymentDetailsNoticeVersion > dismissedPaymentDetailsNoticeVersion;

  async function dismissPaymentDetailsNotice() {
    if (!playerUid || paymentDetailsNoticeVersion <= 0) {
      return;
    }

    try {
      if (!isClientSqlReadMode()) {
        await updateDoc(doc(db, 'users', playerUid), {
          dismissedPaymentDetailsNoticeVersion: paymentDetailsNoticeVersion,
        });
      }
      setDismissedPaymentDetailsNoticeVersion(paymentDetailsNoticeVersion);
    } catch (error) {
      reportPlayerUiError(
        'player_payment_details_notice_dismiss',
        error,
        setMessage,
        'Failed to dismiss payment details notice.'
      );
    }
  }

  function renderRequestHistory() {
    return (
      <motion.div
        initial={lowPerformanceMode ? false : { opacity: 0, y: 16 }}
        animate={lowPerformanceMode ? undefined : { opacity: 1, y: 0 }}
        transition={lowPerformanceMode ? undefined : { duration: 0.35 }}
        className="mt-6 rounded-3xl border border-amber-400/25 bg-black/40 p-4 shadow-[0_0_40px_-10px_rgba(234,179,8,0.35)] backdrop-blur-xl sm:p-6"
      >
        <div className="mb-5">
          <h3 className="flex items-center gap-2 text-xl font-black bg-gradient-to-r from-amber-200 via-yellow-300 to-amber-400 bg-clip-text text-transparent sm:text-2xl">
            <span aria-hidden>📜</span> Request History
          </h3>
          <p className="mt-2 text-xs text-amber-100/55 sm:text-sm">
            Showing up to {requestHistoryDisplayLimit} most recent recharge and redeem
            requests.
          </p>
        </div>

        {displayedRequestHistory.length === 0 ? (
          <p className="text-sm text-amber-100/40">No recharge or redeem requests yet.</p>
        ) : (
          <div className="space-y-4">
            {displayedRequestHistory.map((request) => {
              const needsPlayerExit = requestNeedsPlayerExit(request);
              const canDismissRedeem =
                request.type === 'redeem' && request.status === 'pending' && !needsPlayerExit;

              return (
                <motion.div
                  key={request.id}
                  layout={lowPerformanceMode ? false : true}
                  className="group rounded-2xl border border-white/10 bg-gradient-to-br from-white/[0.07] to-transparent p-4 shadow-lg transition-all active:scale-[0.99] sm:p-5 sm:hover:border-amber-400/35 sm:hover:shadow-[0_0_24px_-8px_rgba(234,179,8,0.4)]"
                >
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="flex-1">
                      <div className="flex flex-wrap items-center gap-2 mb-2">
                        <span className={`rounded-full px-3 py-1 text-xs font-bold uppercase shadow-md ${
                          request.type === 'recharge' 
                            ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' 
                            : 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                        }`}>
                          <i className={`fas fa-${request.type === 'recharge' ? 'arrow-down' : 'arrow-up'} mr-1 text-xs`}></i>
                          {request.type}
                        </span>
                        <span
                          className={`rounded-full px-3 py-1 text-xs font-bold ${getRequestStatusClass(
                            request.status
                          )}`}
                        >
                          {getRequestStatusLabel(request.status)}
                        </span>
                      </div>

                      <h4 className="text-xl font-black text-white tracking-wide">
                        {request.gameName}
                      </h4>
                      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                        <p className="text-amber-100/60">Amount: <span className="text-white font-bold">${formatWalletAmount(Number(request.amount || 0))}</span></p>
                        <p className="text-amber-100/60">Requested: <span className="text-white">{formatDateTime(request.createdAt)}</span></p>
                        <p className="text-amber-100/60">Completed: <span className="text-white">{formatDateTime(request.completedAt)}</span></p>
                      </div>
                      {needsPlayerExit && (
                        <div className="mt-4 rounded-2xl border border-amber-300/45 bg-amber-400/15 p-4 text-sm text-amber-50 shadow-[0_0_24px_-14px_rgba(251,191,36,0.9)]">
                          <p className="text-base font-black text-amber-100">
                            Exit the game to complete your redeem
                          </p>
                          <p className="mt-2 text-amber-50/80">
                            Your redeem request is ready, but the game account appears to still be active. Please close/exit the game, then your redeem can continue.
                          </p>
                          <button
                            type="button"
                            onClick={() => void handleRedeemReadyForRetry(request)}
                            disabled={redeemRetryLoadingId === request.id}
                            className="mt-3 min-h-[44px] rounded-xl bg-amber-300 px-4 py-2 text-sm font-black text-black shadow-lg shadow-amber-500/20 transition hover:brightness-110 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {redeemRetryLoadingId === request.id
                              ? 'Retrying...'
                              : 'I have exited the game'}
                          </button>
                        </div>
                      )}
                    </div>

                    <div className="flex flex-wrap gap-2">
                      {canDismissRedeem && (
                        <button
                          type="button"
                          onClick={() => setRedeemDismissSplashRequest(request)}
                          disabled={dismissRedeemLoadingId === request.id}
                          className="rounded-xl bg-white/10 px-4 py-2 text-xs font-bold text-white hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {dismissRedeemLoadingId === request.id ? 'Dismissing...' : 'Dismiss'}
                        </button>
                      )}
                    </div>
                  </div>
                </motion.div>
              );
            })}
            {requestHistory.length > requestHistoryDisplayLimit && (
              <p className="pt-2 text-center text-xs text-amber-100/40">
                {requestHistory.length - requestHistoryDisplayLimit} older request
                {requestHistory.length - requestHistoryDisplayLimit === 1 ? '' : 's'} not shown in this list.
              </p>
            )}
          </div>
        )}
      </motion.div>
    );
  }

  function renderNavButton(
    item: (typeof NAV_ITEMS)[number],
    unread: number,
    onNavigate: () => void
  ) {
    const isActive = activeView === item.view;

    return (
      <button
        key={item.view}
        type="button"
        onClick={onNavigate}
        className={`group flex w-full items-center justify-between rounded-2xl px-4 py-3 text-left text-[0.98rem] font-bold transition-all duration-200 active:scale-[0.98] md:text-[1.05rem] ${
          isActive
            ? 'bg-gradient-to-r from-amber-400 via-yellow-500 to-amber-500 text-black shadow-[0_0_28px_-4px_rgba(234,179,8,0.65)]'
            : 'border border-white/10 bg-white/[0.04] text-amber-100/85 hover:border-amber-400/35 hover:bg-amber-500/10 hover:text-white'
        }`}
      >
        <span className="flex min-w-0 items-center gap-3">
          <span className="text-lg" aria-hidden>
            {item.emoji}
          </span>
          <span className="truncate">
            <i
              className={`fas fa-${item.icon} mr-2 w-4 ${
                isActive ? 'text-black' : 'text-amber-400/80'
              }`}
            ></i>
            {item.label}
          </span>
        </span>

        {unread > 0 && (
          <span className="flex h-6 min-w-[24px] shrink-0 items-center justify-center rounded-full bg-red-500 px-1.5 text-[10px] font-black text-white shadow-lg ring-2 ring-black/30">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>
    );
  }

  const handlePlayCardsRendered = useCallback((input: { count: number; state: string }) => {
    if (!playPanelCardsRenderedLoggedRef.current) {
      playPanelCardsRenderedLoggedRef.current = true;
      playerDevLog('[PLAY_PANEL_CARDS_RENDERED]', {
        elapsed_ms: startupNow(),
        count: input.count,
        state: input.state,
        source: '/api/player/play-data',
      });
    }
    if (!playPanelFullyReadyLoggedRef.current) {
      playPanelFullyReadyLoggedRef.current = true;
      playerDevLog('[PLAY_PANEL_FULLY_READY]', {
        elapsed_ms: startupNow(),
        definition: 'play shell rendered and play-data card state resolved',
        cardCount: input.count,
        cardState: input.state,
        nonBlockingHydration: {
          baseDataLoaded,
          cashoutsLoaded: Boolean(playerStartupRef.current?.cashoutsLoaded),
          liveSnapshotLoaded: Boolean(playerStartupRef.current?.requestsLoaded),
          bonusEventsListening: shouldListenToBonusEvents,
        },
      });
    }
  }, [baseDataLoaded, shouldListenToBonusEvents, startupNow]);

  const handlePlayShellRendered = useCallback(() => {
    if (!playPanelShellRenderedLoggedRef.current) {
      playPanelShellRenderedLoggedRef.current = true;
      playerDevLog('[PLAY_PANEL_SHELL_RENDERED]', {
        elapsed_ms: startupNow(),
        gameLoginCount: gameLogins.length,
        loadingList,
      });
    }
  }, [gameLogins.length, loadingList, startupNow]);

  const handleAgentsBackToAgents = useCallback(() => {
    setSelectedAgent(null);
  }, []);

  const handleAgentsMessageFocus = useCallback(() => {
    markThreadReadOnPlayerChatFocus(
      selectedAgent?.uid,
      playerAuthorityChatTypeForUser(selectedAgent),
      'input'
    );
  }, [markThreadReadOnPlayerChatFocus, playerAuthorityChatTypeForUser, selectedAgent]);

  return (
    <>
    <main
        ref={pageScrollRef}
        className={`player-fire-page ${lowPerformanceMode ? 'low-performance-mode player-mobile-lite' : ''} relative z-0 flex min-h-[100dvh] flex-col overflow-y-visible overflow-x-hidden bg-transparent pb-[calc(5.25rem+env(safe-area-inset-bottom))] text-white md:flex-row md:items-start md:overflow-y-auto lg:pb-0`}
      >
        <div className="ember-overlay" aria-hidden="true" />
        {maintenanceBreak.enabled ? (
          <div
            className="fixed inset-0 z-[220] flex items-center justify-center bg-zinc-950/95 px-4 py-6 text-white backdrop-blur-xl"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="maintenance-break-title"
          >
            <div className="w-full max-w-xl rounded-2xl border border-amber-300/30 bg-black/55 p-6 text-center shadow-2xl shadow-amber-950/30 sm:p-8">
              <p className="text-xs font-black uppercase tracking-[0.28em] text-amber-300/80">
                Maintenance Break
              </p>
              <h1
                id="maintenance-break-title"
                className="mt-3 text-2xl font-black leading-tight text-white sm:text-3xl"
              >
                {maintenanceBreak.title}
              </h1>
              <p className="mt-5 whitespace-pre-line text-sm leading-relaxed text-zinc-200 sm:text-base">
                {maintenanceBreak.message}
              </p>
              <button
                type="button"
                onClick={() => openLogoutConfirmSplash('maintenance_break')}
                disabled={logoutLoading}
                className="mt-7 min-h-[48px] rounded-xl border border-white/15 bg-white/10 px-5 py-3 text-sm font-bold text-white transition hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Logout
              </button>
            </div>
          </div>
        ) : null}
        {showPlayerHelpHint && (
          <div className="pointer-events-none fixed left-1/2 top-1/2 z-50 w-[min(92vw,560px)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-amber-400/25 bg-black/55 px-4 py-3 text-center text-xs font-semibold text-amber-100/80 shadow-[0_0_24px_-10px_rgba(251,191,36,0.65)] backdrop-blur-xl">
            {PLAYER_HELP_HINT_MESSAGE}
          </div>
        )}

        <header className="fire-panel fire-orange sticky top-0 z-30 shrink-0 border-b border-amber-500/20 bg-black/65 px-3 py-2.5 backdrop-blur-2xl md:hidden">
          <div className="grid grid-cols-3 items-center gap-2">
            <div className="flex min-h-[44px] min-w-0 items-center justify-start">
              <button
                type="button"
                onClick={() => setMobileMenuOpen(true)}
                className="flex min-h-[44px] min-w-[72px] shrink-0 items-center justify-center rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 text-sm font-black uppercase tracking-wide text-amber-100"
                aria-label="Open menu"
              >
                ☰ Menu
              </button>
            </div>
            <div className="flex min-w-0 justify-center">
              <div className="w-full rounded-xl border border-amber-400/30 bg-black/35 px-2 py-1.5 text-center shadow-[0_0_20px_-10px_rgba(251,191,36,0.75)]">
                <p className="text-[10px] font-black uppercase tracking-[0.32em] text-amber-300/95">
                  Royal VIP
                </p>
                <p className="mt-0.5 bg-gradient-to-r from-white via-amber-100 to-amber-300 bg-clip-text text-base font-black leading-tight text-transparent drop-shadow-[0_0_10px_rgba(251,191,36,0.35)]">
                  Casino
                </p>
              </div>
            </div>
            <div className="min-w-0 justify-self-end text-right text-sm leading-tight">
              <p className="font-bold text-amber-200">
                🪙 {formatWalletAmount(wallet.coin)}
              </p>
              <p className="font-bold text-emerald-300">
                💵 {formatWalletAmount(wallet.cash)}
              </p>
            </div>
          </div>

          <div className="mt-2 grid w-full grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => handleChangeView('play')}
                disabled={maintenanceBreak.enabled}
                className="fire-button fire-orange min-h-[48px] scale-[1.04] rounded-xl border border-red-200/80 bg-gradient-to-r from-red-500 via-red-400 to-rose-500 px-2 text-sm font-black text-white shadow-[0_0_34px_-6px_rgba(239,68,68,0.9)] transition-transform hover:scale-[1.1] hover:brightness-110 active:scale-[1.03]"
              >
              🎰 Play
            </button>
            <button
                type="button"
                onClick={() => setShowCashoutModal(true)}
                disabled={wallet.cash <= 0 || isBlockedPlayer || maintenanceBreak.enabled}
              className="fire-button fire-green min-h-[40px] rounded-xl border border-cyan-400/35 bg-cyan-500/15 px-2 text-sm font-bold text-cyan-100 disabled:opacity-50"
            >
              💸 Cashout
            </button>
              <button
                type="button"
                onClick={openCashToCoinTransferModal}
                disabled={coinLoading || maintenanceBreak.enabled}
                className="fire-button fire-orange min-h-[40px] rounded-xl border border-emerald-400/35 bg-emerald-500/15 px-2 text-sm font-bold text-emerald-100 disabled:opacity-50"
              >
              {coinLoading ? '⏳' : '🪙 To coin'}
            </button>
          </div>
        </header>

        <button
          type="button"
          onClick={() => setMusicEnabled((previous) => !previous)}
          className="fixed bottom-[calc(5.75rem+env(safe-area-inset-bottom))] right-3 z-40 inline-flex h-10 w-10 items-center justify-center rounded-full border border-amber-400/35 bg-black/70 text-lg text-amber-100 shadow-[0_0_24px_-10px_rgba(234,179,8,0.7)] backdrop-blur-xl transition hover:border-amber-300/60 hover:bg-black/80 lg:bottom-4 lg:right-4"
          aria-pressed={musicEnabled}
          aria-label={musicEnabled ? 'Turn music off' : 'Turn music on'}
          title={musicEnabled ? 'Turn music off' : 'Turn music on'}
        >
          <span className="relative inline-flex h-5 w-5 items-center justify-center" aria-hidden>
            <span className={musicEnabled ? 'text-amber-100' : 'text-amber-100/80'}>♪</span>
            {!musicEnabled ? (
              <span className="pointer-events-none absolute inset-[-8px] flex items-center justify-center">
                <span className="block h-[3px] w-[150%] rotate-[-42deg] rounded-full bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.75)]" />
              </span>
            ) : null}
          </span>
        </button>

        <AnimatePresence>
          {mobileMenuOpen ? (
            <>
              <motion.button
                type="button"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                aria-label="Close menu"
                className="fixed inset-0 z-40 bg-black/75 backdrop-blur-md md:hidden"
                onClick={() => setMobileMenuOpen(false)}
              />
              <motion.aside
                initial={{ opacity: 0, y: -20, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -20, scale: 0.98 }}
                transition={{ type: 'spring', damping: 24, stiffness: 280 }}
                className="fixed inset-y-0 left-0 z-50 flex h-screen w-screen max-w-[17.6rem] flex-col overflow-hidden rounded-none rounded-r-3xl border-r border-amber-500/30 bg-[#0a0612]/97 shadow-2xl shadow-purple-900/40 backdrop-blur-2xl md:hidden"
              >
                <div className="mb-4 border-b border-amber-500/25 bg-gradient-to-br from-[#3f2517] via-[#2a1839] to-[#120f16] px-4 py-5 text-center shadow-[inset_0_-18px_30px_-20px_rgba(251,146,60,0.7)]">
                  <p className="text-xs font-black uppercase tracking-[0.35em] text-amber-300">
                    Jackpot Club
                  </p>
                  <h1 className="mt-1 text-2xl font-black bg-gradient-to-r from-white via-amber-200 to-amber-400 bg-clip-text text-transparent">
                    VIP Lounge
                  </h1>
                </div>
                <div className="flex min-h-0 flex-1 flex-col px-4 pb-4">
                  <nav className="space-y-1.5">
                    {NAV_ITEMS.map((item) => (
                      <div key={item.view} className="space-y-1.5">
                        {renderNavButton(item, item.view === 'agents' ? totalUnread : 0, () => {
                          if (item.view === 'agents' && totalUnread > 0) {
                            handleOpenFirstUnreadAgent();
                            setMobileMenuOpen(false);
                            return;
                          }
                          handleChangeView(item.view);
                        })}
                        {item.view === 'usernames' ? (
                          <>
                            <InstallAppButton
                              canShowInstallButton={canShowInstallButton}
                              onInstallClick={() => {
                                void handleInstallClick();
                                setMobileMenuOpen(false);
                              }}
                            />
                            <button
                              type="button"
                              onClick={(event) => {
                                openPlayerPasswordResetModal(event);
                                setMobileMenuOpen(false);
                              }}
                              className="w-full rounded-2xl border border-amber-400/35 bg-amber-500/10 py-3.5 text-sm font-black text-amber-100 transition hover:bg-amber-500/20"
                            >
                              Reset Password
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                openLogoutConfirmSplash('player_nav');
                                setMobileMenuOpen(false);
                              }}
                              className="w-full rounded-2xl border border-rose-500/40 bg-rose-500/10 py-3.5 text-sm font-black text-rose-100 transition hover:bg-rose-500/20"
                            >
                              Log out
                            </button>
                          </>
                        ) : null}
                      </div>
                    ))}
                  </nav>
                </div>
              </motion.aside>
            </>
          ) : null}
        </AnimatePresence>

        <aside className="fire-panel fire-orange relative z-20 hidden w-72 shrink-0 overflow-y-auto border-r border-amber-500/25 bg-black/45 p-5 backdrop-blur-2xl md:block xl:w-80">
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-amber-500/[0.07] via-transparent to-purple-600/10" />
          <div className="pointer-events-none absolute top-0 left-0 h-40 w-full bg-[radial-gradient(ellipse_at_top,rgba(250,204,21,0.18),transparent_70%)]" />

          <div className="relative z-10">
            <div className="fire-panel fire-orange fire-hero mb-8 rounded-2xl border border-amber-400/35 bg-gradient-to-br from-amber-500/15 to-purple-900/25 p-5 text-center shadow-[0_0_40px_-12px_rgba(234,179,8,0.4)]">
              <p className="text-xs font-black uppercase tracking-[0.4em] text-amber-300">
                Royal
              </p>
              <h1 className="mt-1 text-3xl font-black bg-gradient-to-r from-white via-amber-200 to-amber-400 bg-clip-text text-transparent xl:text-4xl">
                Casino
              </h1>
              <p className="mt-2 text-xs text-amber-200/55">💎 VIP Player Lounge</p>
            </div>

            <nav className="space-y-2">
              {NAV_ITEMS.map((item) => (
                <div key={item.view} className="space-y-2">
                  {renderNavButton(item, item.view === 'agents' ? totalUnread : 0, () => {
                    if (item.view === 'agents' && totalUnread > 0) {
                      handleOpenFirstUnreadAgent();
                      return;
                    }
                    handleChangeView(item.view);
                  })}
                  {item.view === 'usernames' ? (
                    <>
                      <InstallAppButton
                        canShowInstallButton={canShowInstallButton}
                        onInstallClick={() => {
                          void handleInstallClick();
                        }}
                        className="w-full rounded-2xl border border-amber-400/35 bg-amber-500/10 py-3.5 text-sm font-bold text-amber-100 transition hover:bg-amber-500/20"
                      />
                      <button
                        type="button"
                        onClick={(event) => openPlayerPasswordResetModal(event)}
                        className="w-full rounded-2xl border border-amber-400/35 bg-amber-500/10 py-3.5 text-sm font-bold text-amber-100 transition hover:bg-amber-500/20"
                      >
                        Reset Password
                      </button>
                      <button
                        type="button"
                        onClick={() => openLogoutConfirmSplash('player_nav')}
                        className="w-full rounded-2xl border border-rose-500/40 bg-rose-950/40 py-3.5 text-sm font-bold text-rose-100 transition hover:bg-rose-500/15"
                      >
                        Log out
                      </button>
                    </>
                  ) : null}
                </div>
              ))}
            </nav>
          </div>
        </aside>

        <section className="relative z-10 flex min-h-0 w-full min-w-0 flex-1 flex-col md:min-h-0">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_15%_0%,rgba(250,204,21,0.09),transparent_40%),radial-gradient(circle_at_90%_15%,rgba(168,85,247,0.12),transparent_35%),radial-gradient(circle_at_50%_100%,rgba(220,38,38,0.06),transparent_45%)]" />
          <div className="pointer-events-none absolute top-0 right-0 h-72 w-72 rounded-full bg-amber-500/10 blur-3xl" />

          <div className="relative z-10 flex min-h-0 flex-1 flex-col">
            <div
              className="flex min-h-0 flex-1 flex-col overflow-x-hidden px-3 pb-4 pt-4 md:px-7 md:pb-8 md:pt-6"
              onTouchStart={handlePanelTouchStart}
              onTouchEnd={handlePanelTouchEnd}
            >
              {activeView === 'dashboard' ? (
              <>
              <div className="player-lobby-action-grid relative z-20 mb-4 hidden shrink-0 gap-2 md:grid md:gap-2.5 lg:gap-3">
                <div className="fire-panel fire-orange rounded-2xl border border-amber-300/60 bg-gradient-to-br from-amber-400/35 to-yellow-500/20 px-4 py-3 text-right shadow-lg shadow-amber-400/25 md:px-4 md:py-3 lg:px-5">
                  <div className="flex items-center justify-between gap-3">
                    <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-amber-200/40 bg-amber-200/15 text-2xl shadow-[0_0_18px_rgba(251,191,36,0.35)]">
                      🪙
                    </span>
                    <p className="text-xs font-black uppercase tracking-[0.28em] text-amber-100/90">
                      Coin
                    </p>
                  </div>
                  <p className="mt-1 text-2xl font-black tabular-nums text-white">
                    {formatWalletAmount(wallet.coin)}
                  </p>
                </div>

                <button
                  type="button"
                  onClick={openCashToCoinTransferModal}
                  disabled={coinLoading}
                  className="fire-button fire-purple rounded-2xl border border-fuchsia-300/45 bg-gradient-to-r from-fuchsia-600 via-violet-500 to-purple-600 px-3 py-3 text-xs font-black leading-tight text-white shadow-[0_0_26px_-10px_rgba(192,38,211,0.9)] transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60 md:px-4 lg:px-5 lg:text-base"
                >
                  {coinLoading ? '⏳ Transferring…' : '⇄ Transfer Cash → Coin'}
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setShowLoadCoinPanel(true);
                    setMessage('');
                  }}
                  disabled={isBlockedPlayer || maintenanceBreak.enabled}
                  className="fire-button fire-orange rounded-2xl border border-amber-400/45 bg-amber-500/20 px-3 py-3 text-sm font-black text-amber-50 shadow-md transition-all hover:bg-amber-500/35 disabled:cursor-not-allowed disabled:opacity-60 lg:px-5 lg:text-base"
                >
                  ⬇ Load coin
                </button>

                <button
                  type="button"
                  onClick={openCoinToCashTransferModal}
                  disabled={maintenanceBreak.enabled}
                  className="fire-panel fire-green cursor-pointer rounded-2xl border border-emerald-300/60 bg-gradient-to-br from-emerald-400/35 to-emerald-700/25 px-4 py-3 text-right shadow-lg shadow-emerald-400/25 transition hover:border-emerald-200/80 hover:brightness-110 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60 md:px-4 lg:px-5"
                  aria-label={`Transfer coin to cash. Current cash balance ${formatWalletAmount(wallet.cash)}`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-emerald-200/40 bg-emerald-200/15 text-2xl shadow-[0_0_18px_rgba(74,222,128,0.35)]">
                      💵
                    </span>
                    <p className="text-xs font-black uppercase tracking-[0.28em] text-emerald-100/90">
                      Cash
                    </p>
                  </div>
                  <p className="mt-1 text-2xl font-black tabular-nums text-white">
                    {formatWalletAmount(wallet.cash)}
                  </p>
                </button>
                <button
                  type="button"
                  onClick={() => setShowCashoutModal(true)}
                  disabled={wallet.cash <= 0 || isBlockedPlayer || maintenanceBreak.enabled}
                  className="fire-button fire-orange rounded-2xl border border-amber-400/45 bg-amber-500/20 px-3 py-3 text-sm font-black text-amber-50 shadow-md transition-all hover:bg-amber-500/35 disabled:cursor-not-allowed disabled:opacity-60 lg:px-5 lg:text-base"
                >
                  💸 Cashout
                </button>
                <button
                  type="button"
                  onClick={() => openPlayView('desktop_action_button')}
                  disabled={maintenanceBreak.enabled}
                  className="fire-button fire-orange rounded-2xl border border-red-200/70 bg-gradient-to-r from-red-500 via-red-400 to-rose-500 px-3 py-3 text-sm font-black text-white shadow-[0_0_26px_-10px_rgba(239,68,68,0.9)] transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60 lg:px-5 lg:text-base"
                >
                  🎰 Play
                </button>
              </div>

              <div className="relative z-20 mb-4 grid shrink-0 grid-cols-3 gap-2 md:hidden">
                <div className="fire-panel fire-orange rounded-2xl border border-amber-300/60 bg-gradient-to-br from-amber-400/35 to-yellow-600/20 p-3 text-center shadow-md shadow-amber-400/20">
                  <span className="mx-auto inline-flex h-9 w-9 items-center justify-center rounded-xl border border-amber-200/40 bg-amber-200/15 text-xl shadow-[0_0_14px_rgba(251,191,36,0.35)]">
                    🪙
                  </span>
                  <p className="mt-1 text-xs font-black uppercase tracking-wider text-amber-100/90">
                    Coin
                  </p>
                  <p className="mt-0.5 text-2xl font-black tabular-nums text-white">
                    {formatWalletAmount(wallet.coin)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={openCoinToCashTransferModal}
                  disabled={maintenanceBreak.enabled}
                  className="fire-panel fire-green cursor-pointer rounded-2xl border border-emerald-300/60 bg-gradient-to-br from-emerald-400/35 to-emerald-700/20 p-3 text-center shadow-md shadow-emerald-400/20 transition hover:border-emerald-200/80 hover:brightness-110 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
                  aria-label={`Transfer coin to cash. Current cash balance ${formatWalletAmount(wallet.cash)}`}
                >
                  <span className="mx-auto inline-flex h-9 w-9 items-center justify-center rounded-xl border border-emerald-200/40 bg-emerald-200/15 text-xl shadow-[0_0_14px_rgba(74,222,128,0.35)]">
                    💵
                  </span>
                  <p className="mt-1 text-xs font-black uppercase tracking-wider text-emerald-100/90">
                    Cash
                  </p>
                  <p className="mt-0.5 text-2xl font-black tabular-nums text-white">
                    {formatWalletAmount(wallet.cash)}
                  </p>
                </button>
                <button
                  type="button"
                  onClick={openCashToCoinTransferModal}
                  disabled={coinLoading || maintenanceBreak.enabled}
                  className="fire-button fire-orange min-h-[44px] rounded-2xl border border-amber-400/45 bg-amber-500/20 px-2 py-2 text-xs font-black text-amber-50 active:scale-[0.99] disabled:opacity-60"
                >
                  {coinLoading ? '⏳ Transferring…' : '⇄ Transfer cash to coin'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowLoadCoinPanel(true);
                    setMessage('');
                  }}
                  disabled={isBlockedPlayer || maintenanceBreak.enabled}
                  className="fire-button fire-purple min-h-[44px] rounded-2xl border border-fuchsia-300/45 bg-gradient-to-r from-fuchsia-600 via-violet-500 to-purple-600 px-2 py-2 text-xs font-black text-white shadow-[0_0_24px_-12px_rgba(192,38,211,0.95)] active:scale-[0.99] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  ⬇ Load coin
                </button>
                <button
                  type="button"
                  onClick={() => setShowCashoutModal(true)}
                  disabled={wallet.cash <= 0 || isBlockedPlayer || maintenanceBreak.enabled}
                  className="fire-button fire-orange min-h-[44px] rounded-2xl border border-amber-400/45 bg-amber-500/20 px-2 py-2 text-xs font-black text-amber-50 active:scale-[0.99] disabled:opacity-60"
                >
                  💸 Cashout
                </button>
                <button
                  type="button"
                  onClick={() => openPlayView('mobile_action_button')}
                  disabled={maintenanceBreak.enabled}
                  className="fire-button fire-orange min-h-[44px] rounded-2xl border border-red-200/70 bg-gradient-to-r from-red-500 via-red-400 to-rose-500 px-2 py-2 text-xs font-black text-white shadow-[0_0_24px_-12px_rgba(239,68,68,0.95)] active:scale-[0.99] hover:brightness-110 disabled:opacity-60"
                >
                  🎰 Play
                </button>
              </div>
              </>
              ) : null}

              {playerAlert ? (
                <motion.div
                  initial={
                    playerAlert.variant === 'index'
                      ? { opacity: 0, y: -10 }
                      : { opacity: 0, scale: 0.94, y: -24 }
                  }
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  className={
                    playerAlert.variant === 'index'
                      ? 'fire-panel fire-orange mb-4 rounded-2xl border border-amber-400/50 bg-gradient-to-br from-amber-950/90 via-[#1a1008] to-black/80 p-4 shadow-xl backdrop-blur-md sm:p-5'
                      : playerAlert.variant === 'success'
                        ? 'fixed left-1/2 top-1/2 z-[130] w-[min(92vw,32rem)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-3xl border border-emerald-300/45 bg-gradient-to-br from-emerald-700/95 via-emerald-900/95 to-black/90 p-7 text-white shadow-[0_0_0_100vmax_rgba(6,95,70,0.38),0_24px_70px_-18px_rgba(6,78,59,0.92)] backdrop-blur-xl md:left-[calc(18rem+(100vw-18rem)/2)] md:w-[min(calc((100vw-18rem)*0.6),42rem)] xl:left-[calc(20rem+(100vw-20rem)/2)] xl:w-[min(calc((100vw-20rem)*0.6),46rem)]'
                        : 'fixed left-1/2 top-1/2 z-[130] w-[min(92vw,32rem)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-3xl border border-red-300/45 bg-gradient-to-br from-red-800/95 via-rose-950/95 to-black/90 p-7 text-white shadow-[0_0_0_100vmax_rgba(127,29,29,0.55),0_24px_70px_-18px_rgba(127,29,29,0.95)] backdrop-blur-xl md:left-[calc(18rem+(100vw-18rem)/2)] md:w-[min(calc((100vw-18rem)*0.6),42rem)] xl:left-[calc(20rem+(100vw-20rem)/2)] xl:w-[min(calc((100vw-20rem)*0.6),46rem)]'
                  }
                >
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="text-2xl font-black text-white">
                      {playerAlert.variant === 'index'
                        ? '⚙️ '
                        : playerAlert.variant === 'lowCoin'
                          ? '🪙 '
                          : '⚠️ '}
                      {playerAlert.variant === 'index'
                        ? playerAlert.title
                        : playerAlert.variant === 'success'
                          ? playerAlert.title
                          : 'Warning'}
                    </h3>
                    <button
                      type="button"
                      onClick={() => setMessage('')}
                      className={
                        playerAlert.variant === 'index'
                          ? 'shrink-0 rounded-lg border border-white/15 bg-white/5 px-2.5 py-1 text-sm font-bold text-white/80 hover:bg-white/10'
                          : playerAlert.variant === 'success'
                            ? 'shrink-0 rounded-xl bg-white px-4 py-2 text-sm font-black text-emerald-800 hover:bg-emerald-100'
                            : 'shrink-0 rounded-xl bg-white px-4 py-2 text-sm font-black text-red-800 hover:bg-red-100'
                      }
                      aria-label="Dismiss alert"
                    >
                      ✕
                    </button>
                  </div>
                  <p
                    className={`mt-2 text-base leading-relaxed sm:text-[1.05rem] ${
                      playerAlert.variant === 'index'
                        ? 'text-amber-50/90'
                        : playerAlert.variant === 'success'
                          ? 'text-emerald-50'
                          : 'text-red-50'
                    }`}
                  >
                    {playerAlert.body}
                  </p>
                  {playerAlert.variant === 'index' ? (
                    <div className="mt-3 rounded-xl border border-amber-400/25 bg-black/40 px-3 py-3 text-xs text-amber-100/80">
                      <p className="text-sm font-black uppercase tracking-wider text-amber-200/90">
                        Technical details
                      </p>
                      {(() => {
                        const url = playerAlert.raw.match(
                          /https:\/\/console\.firebase\.google\.com[^\s]*/i
                        )?.[0];
                        return url ? (
                          <a
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="mt-2 block w-full rounded-lg border border-amber-400/40 bg-amber-500/15 py-2.5 text-center text-sm font-black text-amber-100 hover:bg-amber-500/25"
                          >
                            Open “Create index” in Firebase Console ↗
                          </a>
                        ) : null;
                      })()}
                      <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] text-amber-100/50">
                        {playerAlert.raw}
                      </pre>
                    </div>
                  ) : null}
                </motion.div>
              ) : null}

            {isBlockedPlayer && (
              <div className="fire-panel fire-orange mb-5 rounded-xl border border-rose-500/40 bg-rose-500/15 backdrop-blur-sm p-4 text-sm text-rose-100 flex items-center gap-3">
                <i className="fas fa-ban text-rose-300 text-lg"></i>
                <span>
                  Your account is restricted. You can open{' '}
                  <span className="font-bold text-rose-50">Agents</span> to message your team. Recharge, redeem, and
                  other actions stay unavailable until a manager unblocks you.
                </span>
              </div>
            )}
            
            {/* DASHBOARD VIEW */}
            {activeView === 'dashboard' && <Lobby activatingBonusEventId={activatingBonusEventId} activeBonusCarouselIndex={activeBonusCarouselIndex} agents={agents} bonusStripPaused={bonusStripPaused} bonusVanishedToast={bonusVanishedToast} formatWalletAmount={formatWalletAmount} gameLogins={gameLogins} handleActivateBonusEvent={handleActivateBonusEvent} handleCopyReferralCode={handleCopyReferralCode} handleOpenFirstUnreadAgent={handleOpenFirstUnreadAgent} openCashToCoinTransferModal={openCashToCoinTransferModal} openCoinToCashTransferModal={openCoinToCashTransferModal} isBlockedPlayer={isBlockedPlayer} lowPerformanceMode={lowPerformanceMode} maintenanceBreak={maintenanceBreak} playerBonusEvents={playerBonusEvents} referralCode={referralCode} setActiveView={setActiveViewFromLobby} setBonusCarouselIndex={setBonusCarouselIndex} setBonusStripPaused={setBonusStripPaused} setMessage={setMessage} setShowLoadCoinPanel={setShowLoadCoinPanel} totalUnread={totalUnread} wallet={wallet} />}

            {activeView === 'bonus-events' && <Bonus activatingBonusEventId={activatingBonusEventId} activeBonusCarouselIndex={activeBonusCarouselIndex} bonusEventsSessionLoading={bonusEventsSessionLoading} bonusSwipeStartXRef={bonusSwipeStartXRef} bonusVanishedToast={bonusVanishedToast} handleActivateBonusEvent={handleActivateBonusEvent} lowPerformanceMode={lowPerformanceMode} maintenanceBreak={maintenanceBreak} playerBonusEvents={playerBonusEvents} setBonusCarouselIndex={setBonusCarouselIndex} setBonusStripPaused={setBonusStripPaused} showBonusPanelHint={showBonusPanelHint} />}

            {/* PLAY VIEW */}
            {activeView === 'play' && <Play copyCredentialValue={copyCredentialValue} gameBackgroundImageByKey={gameBackgroundImageByKey} gameLogins={gameLogins} loadingList={loadingList} lowPerformanceMode={lowPerformanceMode} onCardsRendered={handlePlayCardsRendered} onShellRendered={handlePlayShellRendered} openActiveTableSplash={openActiveTableSplash} selectedGameName={selectedGameName} setSelectedGameName={setSelectedGameName} togglePassword={togglePassword} visiblePasswords={visiblePasswords} />}

            {/* USERNAMES VIEW */}
            {activeView === 'usernames' && <Vault coadminFrontendLinkByGameKey={coadminFrontendLinkByGameKey} copyCredentialValue={copyCredentialValue} creatorNames={creatorNames} credentialTaskLoadingKey={credentialTaskLoadingKey} gameBackgroundImageByKey={gameBackgroundImageByKey} gameLogins={gameLogins} loadingList={loadingList} lowPerformanceMode={lowPerformanceMode} openCredentialResetModal={openCredentialResetModal} selectedCreatorUid={selectedCreatorUid} setSelectedCreatorUid={setSelectedCreatorUid} togglePassword={togglePassword} usernameCarersByGame={usernameCarersByGame} usernamesCreatorFilterKeys={usernamesCreatorFilterKeys} usernamesVisibleLogins={usernamesVisibleLogins} visiblePasswords={visiblePasswords} />}

            {/* EARN COINS VIEW */}
            {activeView === 'earn-coins' && <EarnCoins claimingFreeplayGift={claimingFreeplayGift} claimingReferredPlayerUid={claimingReferredPlayerUid} freeplayClaimSuccessMessage={freeplayClaimSuccessMessage} handleClaimFreeplayGift={handleClaimFreeplayGift} handleClaimReferralReward={handleClaimReferralReward} hasPendingFreeplayGift={hasPendingFreeplayGift} lowPerformanceMode={lowPerformanceMode} referralRewardGroups={referralRewardGroups} referralRewardsLoading={referralRewardsLoading} referredByPlayerName={referredByPlayerName} />}

            {/* AGENTS VIEW - ReachOutView integration remains the same but styled via the prop structure */}
            {activeView === 'agents' && <Agents agentOnlineByUid={agentOnlineByUid} agents={agents} agentsScrollRef={agentsScrollRef} handleAgentSelect={handleAgentSelect} handleClearImage={handleClearImage} handleImageSelect={handleImageSelect} handleSendMessage={handleSendMessage} imagePreview={imagePreview} lowPerformanceMode={lowPerformanceMode} messages={messages} newMessage={newMessage} onBackToAgents={handleAgentsBackToAgents} onMessageFocus={handleAgentsMessageFocus} pagedAgentChat={agentPagedChatViewState} selectedAgent={selectedAgent} sendingImage={sendingImage} setNewMessage={setNewMessage} unreadCounts={unreadCounts} />}
            </div>
          </div>
        </section>

        <nav
          className="fixed bottom-0 left-0 right-0 z-40 flex items-stretch justify-around border-t border-amber-500/25 bg-[#07030a]/95 px-1 pb-[env(safe-area-inset-bottom)] pt-2 shadow-[0_-8px_32px_rgba(0,0,0,0.55)] backdrop-blur-2xl lg:hidden"
          aria-label="Main navigation"
        >
          {NAV_ITEMS.filter((item) => item.view !== 'play').map((item) => {
            const isActive = activeView === item.view;
            const unread = item.view === 'agents' ? totalUnread : 0;

            return (
              <button
                key={item.view}
                type="button"
                onClick={() => {
                  if (item.view === 'agents' && unread > 0) {
                    handleOpenFirstUnreadAgent();
                    return;
                  }
                  handleChangeView(item.view);
                }}
                className={`relative flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-xl py-2 text-[10px] font-black uppercase tracking-wide transition-all active:scale-95 sm:text-[11px] ${
                  isActive
                    ? 'text-amber-300'
                    : 'text-amber-100/45 hover:text-amber-200/80'
                }`}
              >
                <span className="text-lg leading-none sm:text-xl" aria-hidden>
                  {item.emoji}
                </span>
                <span className="max-w-full truncate px-0.5">{item.label}</span>
                {unread > 0 ? (
                  <span className="absolute right-2 top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-black text-white shadow-md">
                    {unread > 9 ? '9+' : unread}
                  </span>
                ) : null}
                {isActive ? (
                  <span className="absolute bottom-1 h-0.5 w-8 rounded-full bg-gradient-to-r from-amber-400 to-yellow-500 shadow-[0_0_12px_rgba(234,179,8,0.8)]" />
                ) : null}
              </button>
            );
          })}
        </nav>
        <Link
          href="/player/chat"
          className={`fixed bottom-[calc(5.75rem+env(safe-area-inset-bottom))] left-4 z-[60] h-12 w-12 items-center justify-center rounded-full border border-emerald-300/50 bg-emerald-500/20 text-2xl shadow-lg shadow-emerald-500/30 backdrop-blur-sm transition hover:bg-emerald-500/30 lg:bottom-4 lg:left-4 lg:inline-flex ${
            mobileMenuOpen ? 'inline-flex' : 'hidden'
          }`}
          aria-label="Open player chat"
          title="Chat with online players"
          onClick={() => setMobileMenuOpen(false)}
        >
          💬
        </Link>
      </main>

      <PwaIosInstallGuide open={showIosGuide} onClose={closeIosGuide} />
      <PwaInstallNotReadyToast
        open={showInstallNotReadyToast}
        onDismiss={dismissInstallNotReadyToast}
      />

      {clipboardToast ? (
        <motion.div
          initial={{ opacity: 0, scale: 0.94 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.18 }}
          className={`pointer-events-none fixed z-[200] max-w-[min(220px,calc(100vw-16px))] whitespace-normal rounded-lg border px-3 py-1.5 text-center text-xs font-bold shadow-lg backdrop-blur-md ${
            clipboardToast.tone === 'success'
              ? 'border-emerald-400/60 bg-emerald-600/90 text-emerald-50 shadow-emerald-950/40'
              : clipboardToast.tone === 'warn'
                ? 'border-amber-400/55 bg-amber-950/92 text-amber-50'
                : 'border-rose-400/55 bg-rose-950/92 text-rose-50'
          }`}
          style={{
            left: clipboardToast.x,
            top: clipboardToast.y,
            transform: clipboardToast.placeBelow
              ? 'translate(-50%, 14px)'
              : 'translate(-50%, calc(-100% - 14px))',
          }}
          role="status"
          aria-live="polite"
        >
          {clipboardToast.text}
        </motion.div>
      ) : null}

      <AnimatePresence>
        {successSplashMessage ? (
          <motion.div
            className="pointer-events-none fixed inset-0 z-[210] flex items-center justify-center px-4"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.14 }}
            role="status"
            aria-live="polite"
          >
            <motion.div
              initial={{ opacity: 0, y: 12, scale: 0.92 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, scale: 0.96 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
              className="w-[min(92vw,23rem)] overflow-hidden rounded-3xl border border-emerald-200/55 bg-gradient-to-br from-emerald-400/95 via-green-600/95 to-emerald-950/95 px-5 py-4 text-center text-white shadow-[0_0_44px_-8px_rgba(16,185,129,0.95),0_22px_60px_-24px_rgba(6,78,59,0.95)] backdrop-blur-xl sm:px-6 sm:py-5"
            >
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-white/35 bg-white/20 text-3xl shadow-[0_0_24px_rgba(187,247,208,0.55)]">
                ✓
              </div>
              <p className="mt-3 text-lg font-black leading-tight text-white sm:text-xl">
                {successSplashMessage}
              </p>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {showPlayerPasswordResetModal ? (
        <div
          className={`${PLAYER_SPLASH_BACKDROP_CENTER} z-[79]`}
          onClick={closePlayerPasswordResetModal}
          role="dialog"
          aria-modal="true"
          aria-labelledby="player-password-reset-title"
        >
          <form
            onSubmit={(event) => void handlePlayerPasswordResetSubmit(event)}
            onClick={(event) => event.stopPropagation()}
            className={`${PLAYER_SPLASH_CARD} text-white sm:max-w-md`}
          >
            <input
              type="text"
              name="username"
              autoComplete="username"
              value={playerUsername}
              readOnly
              className="sr-only"
              tabIndex={-1}
            />
            <p className="text-center text-2xl" aria-hidden>
              🔐
            </p>
            <h3
              id="player-password-reset-title"
              className="mt-2 text-center text-xl font-black sm:text-2xl"
            >
              Reset Password
            </h3>
            <div className="mt-5 space-y-4">
              <label className="block text-sm font-bold text-amber-100">
                New password
                <input
                  type="password"
                  name="new-password"
                  value={playerResetNewPassword}
                  onChange={(event) => setPlayerResetNewPassword(event.target.value)}
                  required
                  minLength={MIN_PLAYER_PASSWORD_LENGTH}
                  autoComplete="new-password"
                  className="mt-2 w-full rounded-xl border border-amber-300/30 bg-black/35 px-4 py-3 text-white outline-none focus:border-amber-300/60"
                />
              </label>
              <label className="block text-sm font-bold text-amber-100">
                Confirm password
                <input
                  type="password"
                  name="confirm-password"
                  value={playerResetConfirmPassword}
                  onChange={(event) => setPlayerResetConfirmPassword(event.target.value)}
                  required
                  minLength={MIN_PLAYER_PASSWORD_LENGTH}
                  autoComplete="new-password"
                  className="mt-2 w-full rounded-xl border border-amber-300/30 bg-black/35 px-4 py-3 text-white outline-none focus:border-amber-300/60"
                />
              </label>
            </div>
            {playerResetPasswordError ? (
              <p className="mt-4 rounded-xl border border-rose-300/30 bg-rose-500/15 px-3 py-2 text-sm font-bold text-rose-100">
                {playerResetPasswordError}
              </p>
            ) : null}
            <div className="mt-6 flex flex-col gap-3 sm:flex-row-reverse">
              <button
                type="submit"
                disabled={playerResetPasswordLoading}
                className="min-h-[52px] flex-1 rounded-2xl bg-gradient-to-r from-amber-400 to-yellow-400 py-3.5 text-base font-black text-black shadow-lg shadow-amber-500/20 transition hover:brightness-110 active:scale-[0.99] disabled:opacity-60"
              >
                {playerResetPasswordLoading ? 'Saving...' : 'Save Password'}
              </button>
              <button
                type="button"
                onClick={closePlayerPasswordResetModal}
                disabled={playerResetPasswordLoading}
                className="min-h-[52px] flex-1 rounded-2xl border border-white/20 bg-white/5 py-3.5 text-base font-bold text-amber-100 transition hover:bg-white/10 disabled:opacity-60"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {credentialResetModal ? (
        <div
          className={`${PLAYER_SPLASH_BACKDROP} z-[78]`}
          onClick={() => setCredentialResetModal(null)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="credential-reset-title"
        >
          <div
            onClick={(event) => event.stopPropagation()}
            className={`${PLAYER_SPLASH_CARD} sm:max-w-md`}
          >
            <p className="text-center text-2xl" aria-hidden>
              {credentialResetModal.taskType === 'reset_password' ? '🔑' : '🔁'}
            </p>
            <h3
              id="credential-reset-title"
              className="mt-2 text-center text-xl font-black text-white sm:text-2xl"
            >
              {credentialResetModal.taskType === 'reset_password'
                ? 'Reset game password?'
                : 'Recreate game username?'}
            </h3>
            <p className="mt-3 text-center text-sm leading-relaxed text-amber-100/75">
              <span className="font-bold text-amber-200">
                {credentialResetModal.gameLogin.gameName}
              </span>
              {' — '}
              {credentialResetModal.taskType === 'reset_password'
                ? 'A carer will set a new password for this table.'
                : 'A carer will assign a new username for this table.'}
            </p>
            <p className="mt-2 text-center text-xs text-amber-200/50">
              Your team is notified. You can continue playing other tables while this is processed.
            </p>
            <div className="mt-6 flex flex-col gap-3 sm:flex-row-reverse">
              <button
                type="button"
                onClick={() => void confirmCredentialResetModal()}
                className="min-h-[52px] flex-1 rounded-2xl bg-gradient-to-r from-amber-400 to-yellow-400 py-3.5 text-base font-black text-black shadow-lg shadow-amber-500/20 transition hover:brightness-110 active:scale-[0.99]"
              >
                Yes, request it
              </button>
              <button
                type="button"
                onClick={() => setCredentialResetModal(null)}
                className="min-h-[52px] flex-1 rounded-2xl border border-white/20 bg-white/5 py-3.5 text-base font-bold text-amber-100 transition hover:bg-white/10"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showActiveTableSplash && selectedGameName ? (
        <div
          className="fixed inset-0 z-[74] flex items-end justify-center bg-gradient-to-b from-[#24351f]/82 via-[#1b2a19]/82 to-[#14170d]/88 px-3 pt-4 backdrop-blur-xl sm:px-4"
          style={{
            paddingBottom: `max(0.75rem, calc(env(safe-area-inset-bottom) + ${activeTableKeyboardInset}px))`,
          }}
          onClick={() => closeActiveTableSplash()}
          role="dialog"
          aria-modal="true"
          aria-labelledby="active-table-title"
        >
          <div
            onClick={(event) => event.stopPropagation()}
            ref={activeTableSplashContentRef}
            className="relative flex min-h-0 w-full max-w-lg flex-col overflow-hidden rounded-[28px] border border-amber-400/35 bg-gradient-to-b from-zinc-900/82 to-zinc-950/92 shadow-2xl shadow-amber-900/25 backdrop-blur-xl sm:rounded-3xl"
            style={{
              maxHeight: activeTableViewportHeight
                ? `${Math.max(320, activeTableViewportHeight - 16)}px`
                : 'calc(100dvh - 1rem)',
              ...(selectedGameBackgroundImage && !lowPerformanceMode
                ? {
                    backgroundImage: `linear-gradient(180deg, rgba(0, 0, 0, 0.08) 0%, rgba(0, 0, 0, 0.28) 100%), url("${selectedGameBackgroundImage}")`,
                    backgroundSize: '100% 100%',
                    backgroundPosition: 'center',
                    backgroundRepeat: 'no-repeat',
                    filter: 'brightness(1.35) saturate(1.18)',
                  }
                : {}),
            }}
          >
            <div className="relative shrink-0 border-b border-white/10 px-4 pb-3 pt-4 sm:px-6 sm:pt-5">
              <button
                type="button"
                aria-label="Close"
                onClick={() => closeActiveTableSplash()}
                className="absolute right-3 top-3 z-10 flex h-10 w-10 items-center justify-center rounded-xl border border-amber-500/35 bg-black/60 text-xl font-bold leading-none text-amber-100 transition hover:bg-amber-500/15 sm:right-4 sm:top-4"
              >
                ×
              </button>
              <p className="text-[10px] font-black uppercase tracking-[0.28em] text-amber-200/65">
                Active table
              </p>
              <h3
                id="active-table-title"
                className="mt-1 pr-12 text-2xl font-black text-amber-300 sm:text-3xl"
              >
                {selectedGameName}
              </h3>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5">
              <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3 sm:p-4">
                <label className="mb-2 block text-sm font-bold text-amber-100/75">
                  💰 Amount (deducts from your coin)
                </label>
                <input
                  ref={activeTableAmountInputRef}
                  value={playAmount}
                  onChange={(event) => updatePlayAmount(event.target.value)}
                  onPointerDown={(event) => {
                    event.currentTarget.readOnly = false;
                    setIsPlayAmountEditable(true);
                  }}
                  onFocus={() => {
                    setIsPlayAmountEditable(true);
                    nudgeActiveTableForKeyboard();
                  }}
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  enterKeyHint="done"
                  autoComplete="off"
                  readOnly={!isPlayAmountEditable}
                  placeholder="Enter amount in USD"
                  className="min-h-[52px] w-full rounded-2xl border border-amber-400/40 bg-black/70 px-4 py-3 text-lg text-white outline-none focus:border-amber-300 focus:ring-2 focus:ring-amber-400/30"
                />
                <div className="mt-3 flex flex-wrap gap-2 sm:hidden">
                  {recentPlayAmounts.map((amount, index) => (
                    <button
                      key={amount}
                      type="button"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => selectRecentPlayAmount(amount)}
                      className={`min-h-[36px] rounded-full border px-3 text-sm font-black text-white shadow-[0_0_18px_-6px_rgba(249,115,22,0.9)] ${
                        index === 0
                          ? 'border-orange-100 bg-gradient-to-r from-orange-400 via-orange-500 to-amber-400'
                          : 'border-orange-200/80 bg-orange-500'
                      }`}
                    >
                      {index === 0 ? `Last: ${amount}` : amount}
                    </button>
                  ))}
                  {recentPlayAmounts.length > 0 ? (
                    <button
                      type="button"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={clearRecentPlayAmounts}
                      className="min-h-[36px] rounded-full border border-rose-300/35 bg-rose-500/15 px-3 text-sm font-black text-rose-100"
                    >
                      Clear
                    </button>
                  ) : null}
                </div>
                <p className="mt-2 text-xs leading-relaxed text-amber-100/60">
                  Available coin:{' '}
                  <span className="font-bold text-amber-200">{formatWalletAmount(wallet.coin)}</span>
                  {' — '}
                  Recharge is only sent if this amount is covered.
                </p>
                {playAmount &&
                Number.isFinite(Number(playAmount)) &&
                Number(playAmount) > 0 &&
                Number(playAmount) > wallet.coin ? (
                  <p className="mt-2 text-sm font-bold text-rose-300">
                    Not enough coin. Lower the amount or add coin first.
                  </p>
                ) : null}
                <p className="mt-2 text-xs leading-relaxed text-rose-100/70">
                  Redeem limit is {PLAYER_GAME_REDEEM_MAX_PER_24H} per game in a rolling 24-hour
                  window. The timer resets as older redeems leave that game&apos;s window.
                </p>
                <p className="mt-2 text-xs leading-relaxed text-amber-100/70">
                  Redeem requests must be between {MIN_REDEEM_AMOUNT} and {MAX_REDEEM_AMOUNT}.
                </p>
                {playAmount &&
                Number.isFinite(Number(playAmount)) &&
                Number(playAmount) > 0 &&
                (Number(playAmount) < MIN_REDEEM_AMOUNT ||
                  Number(playAmount) > MAX_REDEEM_AMOUNT) ? (
                  <p className="mt-2 text-sm font-bold text-rose-300">
                    Redeem amount must be between {MIN_REDEEM_AMOUNT} and {MAX_REDEEM_AMOUNT}.
                  </p>
                ) : null}
              </div>

              <div className="mt-4 flex items-start gap-2 rounded-2xl border border-white/10 bg-white/[0.06] p-3 text-sm text-amber-100/65 sm:p-4">
                <span className="text-lg">🛡️</span>
                <span>Requests go to your team for secure processing.</span>
              </div>
            </div>

            <div className="sticky bottom-0 shrink-0 border-t border-white/10 bg-gradient-to-t from-black/95 to-black/85 px-4 py-3 backdrop-blur sm:px-6 sm:py-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  disabled={
                    requestLoading ||
                    !selectedGameName ||
                    !playAmount ||
                    isBlockedPlayer ||
                    maintenanceBreak.enabled ||
                    (Number.isFinite(Number(playAmount)) &&
                      Number(playAmount) > 0 &&
                      Number(playAmount) > wallet.coin)
                  }
                  onClick={(event) => void handleGameRequest('recharge', event)}
                  className="flex min-h-[52px] items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-emerald-600 to-emerald-500 px-4 py-3 text-base font-black text-white shadow-lg shadow-emerald-500/25 transition-all hover:brightness-110 disabled:opacity-50"
                >
                  <span>⬇️</span> Send Recharge
                </button>

                <button
                  type="button"
                  disabled={
                    requestLoading ||
                    !selectedGameName ||
                    !playAmount ||
                    isBlockedPlayer ||
                    maintenanceBreak.enabled ||
                    !Number.isFinite(Number(playAmount)) ||
                    Number(playAmount) < MIN_REDEEM_AMOUNT ||
                    Number(playAmount) > MAX_REDEEM_AMOUNT
                  }
                  onClick={(event) => void handleGameRequest('redeem', event)}
                  className="flex min-h-[52px] items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-rose-700 to-red-600 px-4 py-3 text-base font-black text-white shadow-lg shadow-rose-500/25 transition-all hover:brightness-110 disabled:opacity-50"
                >
                  <span>⬆️</span> Send Redeem
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {playRequestSplash && (
        <div
          className={`${PLAYER_SPLASH_BACKDROP_CENTER} z-[75] bg-gradient-to-b from-black/80 to-zinc-950/95`}
          role="alert"
          aria-live="polite"
          aria-busy="true"
        >
          <div className="w-full max-w-md overflow-hidden rounded-3xl border border-amber-400/40 bg-gradient-to-br from-amber-900/90 via-zinc-900 to-fuchsia-950/90 p-7 text-center text-white shadow-[0_0_60px_-12px_rgba(234,179,8,0.4)] backdrop-blur-xl">
            <p className="text-xs font-black uppercase tracking-[0.3em] text-amber-200/90">
              Active table
            </p>
            <h3 className="mt-3 text-2xl font-black sm:text-3xl">
              {playRequestSplash.type === 'recharge'
                ? 'Sending recharge request'
                : 'Sending redeem request'}
            </h3>
            <p className="mt-2 line-clamp-2 text-sm text-amber-100/80">
              <span className="font-bold text-amber-200">🎰 {playRequestSplash.gameName}</span>
            </p>
            <p className="mt-1 text-sm text-amber-100/60">
              Amount:{' '}
              <span className="font-mono font-bold text-white">
                ${playRequestSplash.amountText} USD
              </span>
            </p>
            <div className="mt-7">
              <div className="h-2 overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-amber-300 via-orange-300 to-emerald-300 transition-[width] duration-300 ease-out"
                  style={{ width: `${Math.max(0, Math.min(playRequestSplash.progress, 100))}%` }}
                />
              </div>
              <div className="mt-3 flex items-center justify-center gap-2">
                <i className="fas fa-circle-notch fa-spin text-2xl text-amber-300" aria-hidden></i>
                <span className="text-sm font-bold text-amber-100/90">
                  {playRequestSplash.statusText}
                </span>
              </div>
            </div>
            <div className="sr-only" aria-live="polite">
              {playRequestSplash.statusText} {playRequestSplash.progress}%
            </div>
            <p className="mt-4 text-xs text-amber-200/50">
              This will close when your request is finished.
            </p>
          </div>
        </div>
      )}

      {showLoadCoinPanel && (
        <div
          onClick={() => setShowLoadCoinPanel(false)}
          className={`${PLAYER_SPLASH_BACKDROP_CENTER} z-[120]`}
          role="dialog"
          aria-modal="true"
          aria-labelledby="load-coin-title"
        >
          <div
            onClick={(event) => event.stopPropagation()}
            className="fire-panel fire-purple relative z-[121] isolate w-full max-w-lg overflow-hidden rounded-3xl border border-violet-400/40 bg-gradient-to-br from-violet-950/95 via-zinc-900 to-black/95 p-6 text-left text-white shadow-[0_0_60px_-12px_rgba(139,92,246,0.45)] backdrop-blur-xl sm:p-7"
          >
            <p className="text-xs font-black uppercase tracking-[0.28em] text-violet-200/75">
              Royal VIP
            </p>
            <h3 id="load-coin-title" className="mt-2 text-2xl font-black sm:text-3xl">
              Load Coin
            </h3>
            <p className="mt-3 text-sm leading-relaxed text-violet-100/82 sm:text-base">
              Load coins through the Royal VIP Telegram bot.
            </p>

            <ol className="mt-6 space-y-3 text-sm leading-relaxed text-violet-50/90 sm:text-base">
              {[
                'Open the Royal VIP Telegram bot.',
                'Tap Deposit.',
                'Enter the amount you want to deposit.',
                'Complete the payment using the instructions sent by the bot.',
                'Once the payment is confirmed, the coins will be added to your Royal VIP account.',
              ].map((step, index) => (
                <li key={step} className="flex gap-3">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-violet-300/40 bg-violet-300/15 text-xs font-black text-violet-100">
                    {index + 1}
                  </span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>

            {!ROYAL_VIP_TELEGRAM_BOT_URL ? (
              <p className="mt-5 rounded-2xl border border-amber-300/30 bg-amber-500/10 px-4 py-3 text-sm font-bold text-amber-100">
                The Royal VIP bot link is not configured yet. Please contact an agent for help
                loading coins.
              </p>
            ) : null}

            <div className="mt-7 flex flex-col gap-3 sm:flex-row-reverse">
              <a
                href={ROYAL_VIP_TELEGRAM_BOT_URL || undefined}
                target="_blank"
                rel="noopener noreferrer"
                aria-disabled={!ROYAL_VIP_TELEGRAM_BOT_URL}
                onClick={(event) => {
                  if (!ROYAL_VIP_TELEGRAM_BOT_URL) {
                    event.preventDefault();
                  }
                }}
                className={`fire-button fire-purple flex min-h-[52px] flex-1 items-center justify-center rounded-2xl bg-gradient-to-r from-violet-500 to-fuchsia-600 px-5 py-3 text-center text-sm font-black text-white shadow-lg shadow-violet-500/25 transition hover:brightness-110 sm:text-base ${
                  ROYAL_VIP_TELEGRAM_BOT_URL
                    ? ''
                    : 'pointer-events-none cursor-not-allowed opacity-50'
                }`}
              >
                Open Royal VIP Bot
              </a>
              <button
                type="button"
                onClick={() => setShowLoadCoinPanel(false)}
                className="min-h-[52px] flex-1 rounded-2xl border border-white/15 bg-white/10 px-5 py-3 text-sm font-bold text-white transition hover:bg-white/15 sm:text-base"
              >
                Back
              </button>
            </div>
          </div>
        </div>
      )}

      {showCoinConfirmSplash && (
        <div
          onClick={() => {
            if (!coinLoading) {
              setShowCoinConfirmSplash(false);
            }
          }}
          className={`${PLAYER_SPLASH_BACKDROP_CENTER} z-[72]`}
          role="dialog"
          aria-modal="true"
          aria-labelledby="player-transfer-title"
        >
          <div
            onClick={(event) => event.stopPropagation()}
            className={`${PLAYER_SPLASH_CARD} fire-panel fire-orange text-white`}
          >
            <h3 id="player-transfer-title" className="text-2xl font-black">
              {isCashToCoinTransfer ? 'Cash to Coin Transfer' : 'Coin to Cash Transfer'}
            </h3>
            {!isCashToCoinTransfer ? (
              <p className="mt-2 text-sm text-amber-100/85">
                Enter the coin amount you want to convert. The tip is deducted before cash is added.
              </p>
            ) : null}
            <p className="mt-3 rounded-xl border border-amber-300/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
              Current {isCashToCoinTransfer ? 'Cash' : 'Coin'} Balance:{' '}
              <span className="font-black text-white">
                {isCashToCoinTransfer ? '$' : ''}
                {formatWalletAmount(transferSourceBalance)}
              </span>
            </p>
            <label className="mt-3 block text-sm text-amber-100/90">
              Transfer {isCashToCoinTransfer ? 'Cash' : 'Coin'} Amount
              <input
                type="number"
                min={1}
                max={
                  isCashToCoinTransfer && !cashoutLimitHitForCashToCoin
                    ? CASH_TO_COIN_MAX_TRANSFER_AMOUNT
                    : undefined
                }
                step={1}
                inputMode="numeric"
                value={transferCoinAmountInput}
                onChange={(event) =>
                  setTransferCoinAmountInput(sanitizeWholeAmountText(event.target.value))
                }
                className="mt-2 w-full rounded-xl border border-amber-300/30 bg-black/35 px-4 py-3 text-white outline-none focus:border-amber-300/60"
                placeholder="Enter amount"
              />
            </label>
            <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
              <div className="rounded-xl border border-amber-300/20 bg-amber-500/10 px-3 py-2">
                <p className="text-xs font-black uppercase tracking-wide text-amber-100/70">
                  Transfer Amount
                </p>
                <p className="mt-1 text-lg font-black text-white">
                  {isCashToCoinTransfer ? '$' : ''}
                  {formatWalletAmount(Math.max(0, transferCoinAmount || 0))}
                </p>
              </div>
              <div className="rounded-xl border border-emerald-300/20 bg-emerald-500/10 px-3 py-2">
                <p className="text-xs font-black uppercase tracking-wide text-emerald-100/70">
                  {isCashToCoinTransfer ? 'Coins To Receive' : 'Cash You Receive'}
                </p>
                <p className="mt-1 text-lg font-black text-white">
                  {isCashToCoinTransfer ? '' : '$'}
                  {formatWalletAmount(
                    Math.max(0, isCashToCoinTransfer ? transferCoinReceived : transferCashReceived)
                  )}
                </p>
              </div>
            </div>
            {!isCashToCoinTransfer && transferCoinToCashTip > 0 ? (
              <p className="mt-3 rounded-xl border border-amber-300/25 bg-black/25 px-3 py-2 text-sm font-bold text-amber-100">
                Tip: {formatWalletAmount(transferCoinToCashTip)}
              </p>
            ) : isCashToCoinTransfer && cashoutLimitHitForCashToCoin ? (
              <p className="mt-3 rounded-xl border border-amber-300/25 bg-black/25 px-3 py-2 text-sm font-bold text-amber-100">
                Your 24-hour cashout limit is reached. You can still transfer cash to coin with a
                5% fee.
              </p>
            ) : null}
            {transferCoinValidationMessage ? (
              <p className="mt-3 rounded-xl border border-rose-300/30 bg-rose-500/15 px-3 py-2 text-sm font-bold text-rose-100">
                {transferCoinValidationMessage}
              </p>
            ) : !isCashToCoinTransfer ? (
              <p className="mt-3 text-xs font-semibold text-amber-100/60">
                Cash You Receive equals Transfer Amount minus tip.
              </p>
            ) : null}
            <div className="mt-5 flex gap-3">
              <button
                type="button"
                onClick={() => setShowCoinConfirmSplash(false)}
                disabled={coinLoading}
                className="flex-1 rounded-xl bg-white/10 px-4 py-3 text-sm font-bold text-white hover:bg-white/20"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleCoinButtonClick()}
                disabled={!canConfirmCashToCoinTransfer}
                className="fire-button fire-orange flex-1 rounded-xl bg-amber-400 px-4 py-3 text-sm font-black text-black hover:bg-amber-300 disabled:opacity-60"
              >
                {coinLoading ? 'Transferring...' : 'Confirm Transfer'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showCashoutModal && (
        <div
          onClick={() => setShowCashoutModal(false)}
          className="fixed inset-0 z-[73] flex items-end justify-center bg-black/82 px-3 pt-4 backdrop-blur-xl sm:items-center sm:p-4"
        >
          <div
            onClick={(event) => event.stopPropagation()}
            className="fire-panel fire-green max-h-[100svh] w-full max-w-lg overflow-y-auto overscroll-contain rounded-t-3xl border border-amber-400/25 bg-gradient-to-b from-[#121018] via-zinc-950/98 to-black text-white shadow-2xl shadow-amber-500/10 sm:max-h-[calc(100dvh-2rem)] sm:max-w-2xl sm:rounded-3xl"
          >
            <div className="p-6 sm:p-7">
            <h3 className="text-2xl font-black">Player Cashout</h3>
            <p className="mt-2 text-sm text-cyan-100/80">
              You can cash out up to ${formatWalletAmount(PLAYER_CASHOUT_MAX_NPR_PER_24_H)} in a rolling 24-hour window
              (excluding declined requests). Anything above that stays in your cash balance until the
              window allows more.
            </p>
            <p className="mt-4 rounded-xl border border-cyan-300/30 bg-cyan-500/10 px-4 py-3 text-sm text-cyan-100">
              <span className="block">
                This request amount: ${formatWalletAmount(cashoutThisRequestNpr)}{' '}
                {Number(wallet.cash || 0) > cashoutThisRequestNpr ? (
                  <span className="text-cyan-200/85">
                    (${formatWalletAmount(wallet.cash)} available; rest stays until quota opens)
                  </span>
                ) : null}
              </span>
              <span className="mt-2 block text-xs text-cyan-200/80">
                Window used: ${formatWalletAmount(rollingCashoutUsedNpr)} / $
                {formatWalletAmount(PLAYER_CASHOUT_MAX_NPR_PER_24_H)}
              </span>
            </p>

            {cashoutThisRequestNpr <= 0 && Number(wallet.cash || 0) > 0 ? (
              <p className="mt-3 rounded-xl border border-amber-400/35 bg-amber-500/15 px-4 py-3 text-sm font-semibold text-amber-100">
                You already used this 24-hour allowance. More opens as older requests exit the window—no
                fixed clock. Your cash stays in your wallet until then.
              </p>
            ) : null}

            <div className="mt-4">
              <p className="text-sm font-semibold text-cyan-100">How should we pay you?</p>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setCashoutPayoutMethod('qr')}
                  className={`rounded-xl border px-4 py-3 text-sm font-black transition ${
                    cashoutPayoutMethod === 'qr'
                      ? 'border-cyan-300/60 bg-cyan-400/20 text-cyan-50'
                      : 'border-white/15 bg-black/35 text-cyan-100/80 hover:border-cyan-400/40'
                  }`}
                >
                  QR
                </button>
                <button
                  type="button"
                  onClick={() => setCashoutPayoutMethod('app')}
                  className={`rounded-xl border px-4 py-3 text-sm font-black transition ${
                    cashoutPayoutMethod === 'app'
                      ? 'border-cyan-300/60 bg-cyan-400/20 text-cyan-50'
                      : 'border-white/15 bg-black/35 text-cyan-100/80 hover:border-cyan-400/40'
                  }`}
                >
                  Payment App
                </button>
              </div>
            </div>

            <div className="mt-4 space-y-2">
              <button
                type="button"
                onClick={() => void handlePlayerCashoutUsingLastDetails()}
                disabled={cashoutLoading || cashoutThisRequestNpr <= 0}
                className="group flex min-h-[64px] w-full items-center justify-between gap-3 rounded-xl border border-emerald-200/45 bg-gradient-to-r from-emerald-400/30 via-teal-400/20 to-cyan-400/20 px-4 py-3.5 text-left text-emerald-50 outline-none ring-1 ring-white/10 transition duration-200 hover:-translate-y-0.5 hover:border-emerald-100/70 hover:from-emerald-300/35 hover:via-teal-300/25 hover:to-cyan-300/25 hover:shadow-[0_14px_32px_rgba(16,185,129,0.22)] focus-visible:border-cyan-100/80 focus-visible:ring-2 focus-visible:ring-cyan-200/70 active:translate-y-0 active:scale-[0.99] active:shadow-[0_8px_22px_rgba(16,185,129,0.24)] disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:translate-y-0 disabled:hover:shadow-none"
              >
                <span className="flex min-w-0 items-center gap-3">
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-white/15 bg-black/25 text-emerald-100 transition group-hover:border-emerald-100/35 group-hover:bg-black/15 group-active:scale-95">
                    <Zap className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[15px] font-black leading-tight tracking-normal sm:text-base">
                      {cashoutLoading ? 'Sending...' : 'Send Using Last Payment Details'}
                    </span>
                    <span className="mt-1 block text-xs font-semibold leading-snug text-emerald-50/75 sm:text-[13px]">
                      Instant cashout using your most recently saved payout details.
                    </span>
                  </span>
                </span>
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-white/10 text-cyan-50 transition group-hover:translate-x-0.5 group-hover:bg-white/15 group-active:translate-x-1">
                  <ArrowRight className="h-5 w-5" aria-hidden="true" />
                </span>
              </button>

              {lastUsedQrCashout?.payment.qrImageUrl ? (
                <button
                  type="button"
                  onClick={() => {
                    setCashoutPayoutMethod('qr');
                    setCashoutQrUrl(lastUsedQrCashout.payment.qrImageUrl || '');
                    setMessage('Loaded your last used QR details.');
                  }}
                  className="w-full rounded-xl border border-cyan-300/25 bg-cyan-500/10 px-4 py-3 text-left text-sm font-semibold text-cyan-50 transition hover:bg-cyan-500/15"
                >
                  Use last QR
                </button>
              ) : null}

              {lastUsedAppCashout?.payment ? (
                <button
                  type="button"
                  onClick={() => {
                    setCashoutPayoutMethod('app');
                    setCashoutAppName(lastUsedAppCashout.payment.paymentAppName || '');
                    setCashoutCashTag(lastUsedAppCashout.payment.paymentAppCashTag || '');
                    setCashoutAccountName(
                      lastUsedAppCashout.payment.paymentAppAccountName || ''
                    );
                    setMessage('Loaded your last used payment app details.');
                  }}
                  className="w-full rounded-xl border border-cyan-300/25 bg-cyan-500/10 px-4 py-3 text-left text-sm font-semibold text-cyan-50 transition hover:bg-cyan-500/15"
                >
                  Use last payment app details
                </button>
              ) : null}
            </div>

            {cashoutPayoutMethod === 'qr' ? (
              <div className="mt-4 rounded-2xl border border-white/10 bg-black/25 p-4">
                <ImageUploadField
                  label="Upload your QR"
                  valueUrl={cashoutQrUrl || undefined}
                  onUploaded={(uploaded) => {
                    setCashoutQrUrl(uploaded.url);
                    setMessage('QR uploaded successfully.');
                  }}
                  onError={(uploadMessage) => setMessage(uploadMessage)}
                  className="space-y-3"
                />
              </div>
            ) : (
              <div className="mt-4 grid gap-3">
                <label className="block text-sm font-semibold text-cyan-100">
                  Payment App Name
                  <input
                    type="text"
                    value={cashoutAppName}
                    onChange={(event) => setCashoutAppName(event.target.value)}
                    className="mt-2 min-h-[48px] w-full rounded-xl border border-white/15 bg-black/40 px-4 py-3 text-white outline-none focus:border-cyan-400/60"
                    placeholder="Chime, Cash App, Venmo..."
                  />
                </label>
                <label className="block text-sm font-semibold text-cyan-100">
                  CashTag / Username
                  <input
                    type="text"
                    value={cashoutCashTag}
                    onChange={(event) => setCashoutCashTag(event.target.value)}
                    className="mt-2 min-h-[48px] w-full rounded-xl border border-white/15 bg-black/40 px-4 py-3 text-white outline-none focus:border-cyan-400/60"
                    placeholder="$name or app username"
                  />
                </label>
                <label className="block text-sm font-semibold text-cyan-100">
                  Name On The App
                  <input
                    type="text"
                    value={cashoutAccountName}
                    onChange={(event) => setCashoutAccountName(event.target.value)}
                    className="mt-2 min-h-[48px] w-full rounded-xl border border-white/15 bg-black/40 px-4 py-3 text-white outline-none focus:border-cyan-400/60"
                    placeholder="Your payout name"
                  />
                </label>
              </div>
            )}
            </div>

            <div className="sticky bottom-0 flex gap-3 border-t border-white/10 bg-black/90 px-6 pb-[calc(24px+env(safe-area-inset-bottom))] pt-4 backdrop-blur-xl sm:px-7 sm:pb-7">
              <button
                type="button"
                onClick={() => setShowCashoutModal(false)}
                className="flex-1 rounded-xl bg-white/10 px-4 py-3 text-sm font-bold text-white hover:bg-white/20"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handlePlayerCashoutRequest()}
                disabled={cashoutLoading || cashoutThisRequestNpr <= 0}
                className="fire-button fire-green flex-1 rounded-xl bg-cyan-400 px-4 py-3 text-sm font-black text-black hover:bg-cyan-300 disabled:opacity-60"
              >
                {cashoutLoading ? 'Sending...' : 'Send Cashout'}
              </button>
            </div>
          </div>
        </div>
      )}

      {shouldShowPaymentDetailsNotice && (
        <div
          onClick={() => void dismissPaymentDetailsNotice()}
          className={`${PLAYER_SPLASH_BACKDROP_CENTER} z-[78] bg-black/85`}
          role="dialog"
          aria-modal="true"
          aria-labelledby="payment-details-notice-title"
        >
          <div
            onClick={(event) => event.stopPropagation()}
            className="fire-panel fire-purple w-full max-w-lg rounded-3xl border border-violet-300/45 bg-gradient-to-br from-violet-950 via-zinc-950 to-black p-7 text-center text-white shadow-2xl shadow-violet-900/30 backdrop-blur-xl"
          >
            <p className="text-xs font-black uppercase tracking-[0.26em] text-violet-100/80">
              Payment Update
            </p>
            <h3 id="payment-details-notice-title" className="mt-3 text-2xl font-black">
              Payment details changed
            </h3>
            <p className="mt-4 text-sm leading-relaxed text-violet-50/90">
              Coin deposits now happen through the Royal VIP Telegram bot. Please click Load Coin
              for the latest steps.
            </p>
            <button
              type="button"
              onClick={() => void dismissPaymentDetailsNotice()}
              className="fire-button fire-purple mt-7 w-full rounded-2xl bg-white px-4 py-3 text-sm font-black uppercase text-violet-950 hover:bg-violet-50"
            >
              Got it
            </button>
          </div>
        </div>
      )}

      {showCashoutSuccessSplash && (
        <div
          onClick={() => {
            setShowCashoutSuccessSplash(false);
            setShowCashoutInquiryPanel(false);
          }}
          className={`${PLAYER_SPLASH_BACKDROP_CENTER} z-[76]`}
        >
          <div
            onClick={(event) => event.stopPropagation()}
            className="fire-panel fire-green w-full max-w-2xl rounded-3xl border border-emerald-300/40 bg-gradient-to-br from-emerald-600 via-emerald-700 to-emerald-900 p-7 text-white shadow-2xl shadow-emerald-900/30 backdrop-blur-xl"
          >
            <p className="text-xs font-black uppercase tracking-[0.28em] text-emerald-100/90">
              Cashout Successful
            </p>
            <h3 className="mt-3 text-3xl font-black">Cashout Successful!</h3>
            <p className="mt-2 text-sm text-emerald-50/90">
              Your cashout has been completed. You can dismiss or send an inquiry.
            </p>

            {showCashoutInquiryPanel && (
              <div className="mt-5 rounded-2xl border border-white/20 bg-black/30 p-4">
                <label className="block text-sm font-semibold text-emerald-100">
                  Inquiry message
                  <textarea
                    value={cashoutInquiryMessage}
                    onChange={(event) => setCashoutInquiryMessage(event.target.value)}
                    className="mt-2 min-h-24 w-full rounded-xl border border-white/20 bg-black/40 px-4 py-3 text-white outline-none focus:border-emerald-200"
                    placeholder="Write your inquiry..."
                  />
                </label>
              </div>
            )}

            <div className="mt-6 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => {
                  setShowCashoutSuccessSplash(false);
                  setShowCashoutInquiryPanel(false);
                }}
                className="rounded-xl bg-white/15 px-5 py-3 text-sm font-bold text-white hover:bg-white/25"
              >
                Dismiss
              </button>
              {!showCashoutInquiryPanel ? (
                <button
                  type="button"
                  onClick={() => setShowCashoutInquiryPanel(true)}
                  className="rounded-xl bg-white px-5 py-3 text-sm font-black text-emerald-900 hover:bg-emerald-100"
                >
                  Inquire
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void handleSendCashoutInquiry()}
                  disabled={sendingCashoutInquiry}
                  className="rounded-xl bg-white px-5 py-3 text-sm font-black text-emerald-900 hover:bg-emerald-100 disabled:opacity-60"
                >
                  {sendingCashoutInquiry ? 'Sending...' : 'Send Inquiry'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <AnimatePresence>
        {showInquirySentToast ? (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.25 }}
            className="fixed left-1/2 top-[calc(4.75rem+env(safe-area-inset-top))] z-[130] w-[min(92vw,460px)] -translate-x-1/2 rounded-2xl border border-emerald-400/45 bg-emerald-500/20 px-4 py-3 text-center text-sm font-bold text-emerald-100 shadow-[0_0_26px_-8px_rgba(52,211,153,0.85)] backdrop-blur-xl"
          >
            Inquiry sent successfully. Staff and coadmin have been notified.
          </motion.div>
        ) : null}
      </AnimatePresence>

      {bonusErrorSplashMessage && (
        <div
          onClick={() => setBonusErrorSplashMessage('')}
          className={`${PLAYER_SPLASH_BACKDROP_CENTER} z-[80] bg-gradient-to-b from-red-950/90 to-black/90`}
        >
          <div
            onClick={(event) => event.stopPropagation()}
            className="w-full max-w-xl rounded-3xl border border-red-300/45 bg-gradient-to-br from-red-800/95 via-rose-950/95 to-black/90 p-7 text-white shadow-2xl shadow-red-900/30 backdrop-blur-xl"
          >
            <p className="text-xs font-black uppercase tracking-[0.28em] text-red-100">
              Bonus Event Failed
            </p>
            <h3 className="mt-3 text-2xl font-black">Can&apos;t initiate bonus event</h3>
            <p className="mt-3 text-sm text-red-100/90">{bonusErrorSplashMessage}</p>
            <button
              type="button"
              onClick={() => setBonusErrorSplashMessage('')}
              className="mt-6 rounded-xl bg-white px-5 py-3 text-sm font-black text-red-800 hover:bg-red-100"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {earnedRewardSplashCoins !== null && (
        <div
          onClick={() => setEarnedRewardSplashCoins(null)}
          className={`${PLAYER_SPLASH_BACKDROP_CENTER} z-[84] bg-black/90`}
        >
          <div
            onClick={(event) => event.stopPropagation()}
            className="w-full max-w-md rounded-3xl border border-rose-500/45 bg-gradient-to-b from-[#2a0a14] via-[#170710] to-[#0a0408] p-6 text-center shadow-2xl shadow-rose-900/25"
          >
            <p className="text-4xl" aria-hidden>
              🎁
            </p>
            <h3 className="mt-3 text-2xl font-black text-white">Congratulations!</h3>
            <p className="mt-3 text-sm text-rose-100/85">
              You received referral reward coins from this player&apos;s recharge.
            </p>
            <p className="mt-3 text-lg font-black text-emerald-300">
              +{Math.max(0, Number(earnedRewardSplashCoins || 0))} coin added
            </p>
            <button
              type="button"
              onClick={() => setEarnedRewardSplashCoins(null)}
              className="mt-6 rounded-xl bg-white px-5 py-3 text-sm font-black text-rose-800 hover:bg-rose-100"
            >
              Awesome
            </button>
          </div>
        </div>
      )}

      {redeemDismissSplashRequest ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="redeem-dismiss-splash-title"
          onClick={() => {
            if (dismissRedeemLoadingId === redeemDismissSplashRequest.id) {
              return;
            }
            setRedeemDismissSplashRequest(null);
          }}
          className="fixed inset-0 z-[125] flex items-center justify-center bg-red-900/95 px-4 backdrop-blur-sm"
        >
          <div
            onClick={(event) => event.stopPropagation()}
            className="w-full max-w-lg rounded-3xl border border-red-300/50 bg-gradient-to-b from-red-950 to-red-900 p-8 shadow-2xl shadow-black/40"
          >
            {redeemDismissSplashRequest.status === 'dismissed' ? (
              <>
                <p className="text-center text-4xl font-black text-red-100">!</p>
                <h3
                  id="redeem-dismiss-splash-title"
                  className="mt-2 text-center text-2xl font-black text-white"
                >
                  {isMidnightPartyDismissSplash
                    ? 'Recharge blocked'
                    : isPlayerInGameDismissSplash
                      ? redeemDismissSplashRequest.type === 'redeem'
                        ? 'Redeem failed'
                        : 'Recharge failed'
                      : isFakeRedeemDismissSplash
                        ? 'Redeem could not be completed'
                        : 'Redeem request dismissed'}
                </h3>
                <p className="mt-5 text-center text-base leading-relaxed text-red-50/95">
                  {isMidnightPartyDismissSplash
                    ? midnightPartyDismissMessage
                    : isPlayerInGameDismissSplash
                      ? playerInGameDismissMessage
                      : isFakeRedeemDismissSplash
                        ? fakeRedeemDismissMessage
                        : 'A staff member marked this redeem request as fake or mistaken and removed it from the pending queue.'}
                </p>
                {!isMidnightPartyDismissSplash &&
                !isFakeRedeemDismissSplash &&
                !isPlayerInGameDismissSplash ? (
                  <p className="mt-4 text-center text-sm leading-relaxed text-red-100/85">
                    If this was an error, contact support with your request amount and game details.
                  </p>
                ) : null}
                <div className="mt-8 flex justify-center">
                  <button
                    type="button"
                    onClick={() => setRedeemDismissSplashRequest(null)}
                    className="w-full rounded-xl bg-white px-4 py-3 text-sm font-black uppercase tracking-wide text-red-900 hover:bg-red-50 sm:w-auto sm:min-w-48"
                  >
                    Okay
                  </button>
                </div>
              </>
            ) : (
              <>
            <p className="text-center text-4xl font-black text-red-100">!</p>
            <h3
              id="redeem-dismiss-splash-title"
              className="mt-2 text-center text-2xl font-black text-white"
            >
              Before you dismiss this redeem
            </h3>
            <p className="mt-5 text-center text-base leading-relaxed text-red-50/95">
              Please confirm you received the <strong className="text-white">full redeem amount</strong>{' '}
              for this request:{' '}
              <strong className="tabular-nums text-white">
                ${formatWalletAmount(Number(redeemDismissSplashRequest.amount || 0))}
              </strong>
              . Only dismiss if the payout is complete or you truly need to cancel this request.
            </p>
            <p className="mt-4 text-center text-sm leading-relaxed text-red-100/85">
              Payout may be instant or take up to about 24 hours, and can arrive in smaller parts—wait
              unless you are sure.
            </p>
            <p className="mt-5 rounded-xl border border-red-400/40 bg-black/30 p-4 text-sm leading-relaxed text-red-100/95">
              <span className="font-black text-red-200">Warning: </span>
              False or abusive dismissals may lead to a review and{' '}
              <strong className="text-white">your account could be banned or restricted.</strong>
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:justify-center">
              <button
                type="button"
                disabled={dismissRedeemLoadingId === redeemDismissSplashRequest.id}
                onClick={() => setRedeemDismissSplashRequest(null)}
                className="flex-1 rounded-xl border border-white/20 bg-white/10 px-4 py-3 text-sm font-semibold text-white hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Go back
              </button>
              <button
                type="button"
                onClick={() => void confirmDismissRedeemSplash()}
                disabled={dismissRedeemLoadingId === redeemDismissSplashRequest.id}
                className="flex-1 rounded-xl bg-white px-4 py-3 text-sm font-black uppercase tracking-wide text-red-900 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {dismissRedeemLoadingId === redeemDismissSplashRequest.id
                  ? 'Dismissing…'
                  : 'I understand — dismiss'}
              </button>
            </div>
              </>
            )}
          </div>
        </div>
      ) : null}

      {showPwaExitConfirm ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="player-pwa-exit-title"
          className={`${PLAYER_SPLASH_BACKDROP_CENTER} z-[128] bg-black/88 px-4 backdrop-blur-2xl`}
          onClick={() => {
            playerDevLog('[PLAYER_BACK_EXIT_CANCELLED]');
            setShowPwaExitConfirm(false);
          }}
        >
          <div
            onClick={(event) => event.stopPropagation()}
            className="fire-panel fire-orange w-full max-w-sm rounded-3xl border border-amber-300/45 bg-gradient-to-br from-amber-950/95 via-zinc-950 to-black/95 p-6 text-center text-white shadow-2xl shadow-amber-900/30"
          >
            <h3 id="player-pwa-exit-title" className="text-2xl font-black">
              Exit Royal VIP?
            </h3>
            <p className="mt-3 text-sm text-amber-100/75">
              Do you want to exit the app?
            </p>
            <div className="mt-6 flex gap-3">
              <button
                type="button"
                onClick={() => {
                  playerDevLog('[PLAYER_BACK_EXIT_CANCELLED]');
                  setShowPwaExitConfirm(false);
                }}
                className="flex-1 rounded-xl border border-white/15 bg-white/10 px-4 py-3 text-sm font-bold text-white hover:bg-white/15"
              >
                Stay
              </button>
              <button
                type="button"
                onClick={() => {
                  playerDebugLog('[PLAYER_BACK_EXIT_CONFIRMED]');
                  playerDebugLog('[PWA_BACK] exit confirmed');
                  pwaExitConfirmedRef.current = true;
                  setShowPwaExitConfirm(false);
                  window.history.back();
                  window.setTimeout(() => {
                    window.history.back();
                  }, 80);
                }}
                className="fire-button fire-orange flex-1 rounded-xl bg-amber-400 px-4 py-3 text-sm font-black text-black hover:bg-amber-300"
              >
                Exit
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <AnimatePresence>
        {showLogoutConfirmSplash && (
          <motion.div
            key="logout-splash"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/88 p-4 backdrop-blur-2xl"
            onClick={() => {
              if (!logoutLoading) {
                setShowLogoutConfirmSplash(false);
                setLogoutConfirmSource(null);
              }
            }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="logout-confirm-title"
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.96, opacity: 0, y: 12 }}
              transition={{ type: 'spring', damping: 26, stiffness: 320 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-md rounded-3xl border border-rose-500/40 bg-gradient-to-b from-rose-950/95 via-zinc-950 to-black p-6 shadow-[0_0_60px_-12px_rgba(244,63,94,0.45)] sm:p-8"
            >
              <p className="text-center text-4xl" aria-hidden>
                👋
              </p>
              <h2
                id="logout-confirm-title"
                className="mt-3 text-center text-2xl font-black text-white sm:text-3xl"
              >
                Sign out of VIP Lounge?
              </h2>
              <p className="mt-3 text-center text-sm leading-relaxed text-rose-100/80">
                You can come back anytime with your username and password. The browser
                <span className="font-semibold text-amber-200"> back </span>button alone does
                not sign you out.
              </p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row-reverse">
                <button
                  type="button"
                  onClick={() =>
                    void performLogout({
                      userConfirmed: true,
                      source: logoutConfirmSource
                        ? `logout_confirm:${logoutConfirmSource}`
                        : 'logout_confirm',
                    })
                  }
                  disabled={logoutLoading}
                  className="min-h-[52px] flex-1 rounded-2xl bg-gradient-to-r from-rose-500 to-rose-700 py-3.5 text-base font-black text-white shadow-lg shadow-rose-500/30 transition hover:brightness-110 disabled:opacity-50"
                >
                  {logoutLoading ? 'Signing out…' : 'Yes, sign out'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowLogoutConfirmSplash(false);
                    setLogoutConfirmSource(null);
                  }}
                  disabled={logoutLoading}
                  className="min-h-[52px] flex-1 rounded-2xl border border-white/20 bg-white/5 py-3.5 text-base font-bold text-amber-100 transition hover:bg-white/10 disabled:opacity-50"
                >
                  Stay playing
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
