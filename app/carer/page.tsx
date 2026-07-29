'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { onAuthStateChanged, User } from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  getDocFromServer,
  getDocsFromServer,
  limit,
  onSnapshot,
  orderBy,
  query,
  where,
} from 'firebase/firestore';

import ProtectedRoute from '../../components/auth/ProtectedRoute';
import LogoutButton from '../../components/auth/LogoutButton';
import { getAppSessionRequestHeaders, getLocalAppSessionId } from '@/features/auth/appSession';
import { discardStalePlayerSessionIdForRole } from '@/features/auth/playerSession';
import { getCachedSessionUser, getSessionUserOnce, type SessionUser } from '@/features/auth/sessionUser';
import { fetchCarerDashboardProfile } from '@/features/carer/carerProfileClient';
import { logCarerPageStartup, logCarerPageTaskSync, resetCarerPageStartupTiming, tryLogCarerPageStartupReady } from '@/features/carer/carerStartupLogs';
import RoleSidebarLayout, { type NavigationItem } from '@/components/navigation/RoleSidebarLayout';
import ImageUploadField from '@/components/common/ImageUploadField';
import { assertClientFirestoreDisabled } from '@/lib/client/clientFirestoreGuard';
import { logCarerAction } from '@/lib/client/carerActionAudit';
import { logCarerFirestoreBlockedSuppressed } from '@/lib/client/carerPageRequestAudit';
import {
  reportCarerActionError,
  reportCarerUiError,
  shouldSuppressCarerFirestoreBlockedUiError,
} from '@/lib/client/carerPageError';
import { isClientSqlReadMode } from '@/lib/client/sqlReadMode';
import { getSqlApiReadHeaders } from '@/lib/client/sqlApiHeaders';
import { auth, db, getClientDb } from '@/lib/firebase/client';
import { getFirebaseApiHeaders } from '@/lib/firebase/apiClient';
import {
  firestoreErrorCode,
  isFirestoreQuotaExhausted,
  logCarerStartupFirestore,
} from '@/lib/firestore/quota';
import { GameLogin } from '@/features/games/gameLogins';
import {
  createPlayerGameLogin,
  listenToPlayerGameLoginsByCoadmin,
  PlayerGameLogin,
  updatePlayerGameLogin,
} from '@/features/games/playerGameLogins';
import {
  dismissPendingRechargeAsCarer,
  dismissPendingRedeemAsCarer,
  PlayerGameRequest,
} from '@/features/games/playerGameRequests';
import { blockPlayer, PlayerUser, unblockPlayer } from '@/features/users/adminUsers';
import {
  createCarerCashoutRequest,
  saveCarerPaymentDetails,
} from '@/features/cashouts/carerCashouts';
import {
  CarerRechargeRedeemTotals,
  CarerTask,
  type CarerBaseData,
  completeRechargeRedeemTask,
  completeUsernameTaskForPlayerGame,
  deletePendingCarerTask,
  isRealCompletedCarerTask,
  getCurrentUserCoadminUid,
  listenToAvailableCarerTasks,
  releaseExpiredCarerTasks,
  sendCarerEscalationAlert,
  sendCarerCashboxInquiryAlert,
  fetchCarerBaseDataForCoadmin,
  syncCarerTasksForCoadmin,
} from '@/features/games/carerTasks';
import { attachCarerTaskLiveShadowCompare } from '@/features/live/carerTaskShadowCompare';
import {
  attachCarerTaskSqlReadListener,
  CARER_TASKS_SQL_READ_ENABLED,
} from '@/features/live/carerTaskSqlRead';
import { attachAutomationJobLiveShadowCompare } from '@/features/live/automationJobShadowCompare';
import {
  attachAutomationJobsSqlReadListener,
  AUTOMATION_JOBS_SQL_READ_ENABLED,
} from '@/features/live/automationJobsSqlRead';
import {
  flagPlayerRisk,
  getPlayerRiskSnapshot,
  listenPlayerRiskSnapshotsByCoadmin,
  PlayerRiskSnapshot,
  sendRiskAlertToStaff,
} from '@/features/risk/playerRisk';
import {
  heartbeatShiftSession,
  endShiftSession,
  startShiftSession,
} from '@/features/shifts/userShifts';
import { usePresenceOnlineMap } from '@/features/presence/userPresence';
import { OnlineIndicator } from '@/components/presence/OnlineIndicator';
import {
  disconnectCarerAutomationAgent,
  getCarerAutomationAgent,
  setCarerAutomationAgent,
  validateAutomationAgentId,
} from '@/features/automation/carerAutomationAgent';
import {
  setCarerAutomationAutoEnabled,
  subscribeCarerAutomationAutoState,
  type CarerAutomationAutoStateDoc,
} from '@/features/automation/automationAutoState';
import {
  buildAutomationPayload,
  claimTaskAndCreateJob,
  listenAutomationUiStatusByTask,
  mapTaskType,
  returnTaskToPendingAndCancelAutomation,
  type AutomationUiStatus,
} from '@/features/automation/automationJobs';
import {
  hasVendorAwareness,
  type VendorAwareness,
} from '@/features/vendors/vendorAwareness';

type CarerView =
  | 'dashboard'
  | 'create-username'
  | 'tasks'
  | 'view-players'
  | 'login-details';

type CarerIdentity = {
  uid: string;
  username: string;
  paymentQrUrl?: string;
  paymentQrPublicId?: string;
  paymentDetails?: string;
  /** Linked local automation agent string (same as agent .env AGENT_ID). */
  automationAgentId?: string | null;
};

type DashboardCard = {
  label: string;
  value: number;
  tone?: 'default' | 'amber' | 'blue' | 'red';
};

type TaskSection = 'pending' | 'mine' | 'completed';
type WarmupStatus = 'not_warmed' | 'warming' | 'ready' | 'partial_ready' | 'failed';
type BrowserWarmupGameResult = {
  ready?: boolean;
  reason?: string;
  statusLabel?: string;
  visibleError?: string;
  error?: string;
};

const DEBUG_TAB_FILTER_LOGS = false;
const CARER_COMPLETED_RENDER_STEP = 7;
const CREATE_USERNAME_UI_GRACE_MS = 5 * 60 * 1000;
const TASK_CLAIM_STALE_TIMEOUT_MS = 5 * 60 * 1000;
const WARMUP_GAME_NAMES = [
  'Orion Stars',
  'Milky Way',
  'Fire Kirin',
  'Juwa',
  'Juwa2',
  'Mafia',
  'Game Vault',
  'Cash Frenzy',
  'Vegas Sweeps',
] as const;
const LOCAL_WARMUP_URL =
  process.env.NEXT_PUBLIC_CARER_AGENT_WARMUP_URL || 'http://127.0.0.1:8765/warmup-browsers';
const LOCAL_WARMUP_STATUS_URL = (() => {
  try {
    const url = new URL(LOCAL_WARMUP_URL);
    url.pathname = '/warmup-browsers/status';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return 'http://127.0.0.1:8765/warmup-browsers/status';
  }
})();
const WARMUP_POLL_INTERVAL_MS = 2_000;
const WARMUP_POLL_TIMEOUT_MS = 120_000;
const LIVE_SHADOW_COMPARE_ENABLED =
  String(process.env.NEXT_PUBLIC_LIVE_SHADOW_COMPARE || '').trim() === '1';
const CARER_PROFILE_FIRESTORE_ENRICH_MS = 5_000;

type WarmupAgentResponse = {
  ok?: boolean;
  status?: string;
  warmupId?: string;
  statusUrl?: string;
  error?: string;
  reason?: string;
  games?: Record<string, BrowserWarmupGameResult>;
};

function resolveWarmupStatusUrl(statusUrl?: string) {
  const clean = String(statusUrl || '').trim();
  return clean || LOCAL_WARMUP_STATUS_URL;
}

function isWarmupTerminalStatus(status: string) {
  const normalized = status.trim().toLowerCase();
  return normalized === 'completed' || normalized === 'failed';
}

function isWarmupInProgressStatus(status: string) {
  const normalized = status.trim().toLowerCase();
  return normalized === 'started' || normalized === 'queued' || normalized === 'running';
}

function sleepMs(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function applyWarmupGamesToUi(
  games: Record<string, BrowserWarmupGameResult>,
  setBrowserWarmupGames: (value: Record<string, BrowserWarmupGameResult>) => void,
  setBrowserWarmupStatus: (value: WarmupStatus) => void,
  setBrowserWarmupMessage: (value: string) => void
) {
  setBrowserWarmupGames(games);
  const total = Object.keys(games).length;
  const readyCount = Object.values(games).filter((result) => Boolean(result.ready)).length;
  if (total > 0 && readyCount === total) {
    setBrowserWarmupStatus('ready');
    setBrowserWarmupMessage(`Ready (${readyCount}/${total})`);
    return { total, readyCount, outcome: 'ready' as const };
  }
  if (readyCount > 0) {
    setBrowserWarmupStatus('partial_ready');
    setBrowserWarmupMessage(`Partial ready (${readyCount}/${total})`);
    return { total, readyCount, outcome: 'partial_ready' as const };
  }
  setBrowserWarmupStatus('failed');
  setBrowserWarmupMessage(total > 0 ? 'Failed' : 'No warmup game results returned.');
  return { total, readyCount, outcome: 'failed' as const };
}

async function pollWarmupBrowserStatus(input: {
  statusUrl: string;
  agentId: string;
  warmupId?: string;
}): Promise<WarmupAgentResponse> {
  const deadline = Date.now() + WARMUP_POLL_TIMEOUT_MS;
  const expectedWarmupId = String(input.warmupId || '').trim();

  while (Date.now() < deadline) {
    await sleepMs(WARMUP_POLL_INTERVAL_MS);

    let response: Response;
    try {
      response = await fetch(input.statusUrl, {
        method: 'GET',
        cache: 'no-store',
        headers: {
          'x-carer-agent-id': input.agentId,
        },
      });
    } catch {
      throw new Error('Carer agent is not reachable. Start carer-agent on this machine.');
    }

    const payload = (await response.json().catch(() => ({}))) as WarmupAgentResponse;
    const status = String(payload.status || '').trim().toLowerCase();
    console.info('[WARMUP_BROWSER_UI] poll status=%s ok=%s warmupId=%s', status || '-', payload.ok ?? '-', payload.warmupId || '-');

    if (!response.ok) {
      throw new Error(String(payload.error || `Warmup status failed (${response.status}).`));
    }

    if (
      expectedWarmupId &&
      String(payload.warmupId || '').trim() &&
      String(payload.warmupId || '').trim() !== expectedWarmupId &&
      isWarmupInProgressStatus(status)
    ) {
      continue;
    }

    if (isWarmupTerminalStatus(status)) {
      return payload;
    }
  }

  throw new Error('Warmup timed out after 2 minutes.');
}

function getTimestampMs(value: unknown) {
  if (!value) {
    return 0;
  }

  if (typeof value === 'object' && value !== null) {
    const maybeTimestamp = value as {
      toDate?: () => Date;
      toMillis?: () => number;
      getTime?: () => number;
      seconds?: number;
    };

    if (typeof maybeTimestamp.toMillis === 'function') {
      return maybeTimestamp.toMillis();
    }

    if (typeof maybeTimestamp.toDate === 'function') {
      return maybeTimestamp.toDate().getTime();
    }

    if (typeof maybeTimestamp.getTime === 'function') {
      return maybeTimestamp.getTime();
    }

    if (typeof maybeTimestamp.seconds === 'number') {
      return maybeTimestamp.seconds * 1000;
    }
  }

  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function formatTaskTimelineTime(value: unknown) {
  const ms = getTimestampMs(value);
  if (!ms) {
    return '—';
  }
  return new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(ms));
}

function renderVendorTaskBadge(vendor: VendorAwareness | null | undefined) {
  if (vendor?.configured === false) {
    return (
      <span className="rounded-full border border-amber-300/20 bg-amber-300/10 px-3 py-1 text-xs text-amber-100/85">
        Vendor data unavailable
      </span>
    );
  }
  if (!hasVendorAwareness(vendor)) {
    return (
      <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs text-neutral-400">
        Unassigned player
      </span>
    );
  }
  return (
    <span className="inline-flex max-w-full flex-wrap items-center gap-1.5 rounded-full border border-cyan-300/20 bg-cyan-300/10 px-3 py-1 text-xs text-cyan-50/85">
      <span className="font-mono text-cyan-100">[{vendor.code}]</span>
      <span className="truncate">Vendor: {vendor.name}</span>
      <span className="text-cyan-100/55">· {vendor.status}</span>
    </span>
  );
}

type CleanTaskTimeline = {
  createdMs: number;
  claimedMs: number;
  startedMs: number;
  completedMs: number;
  totalDurationMs: number | null;
  claimToCompleteMs: number | null;
  automationRunMs: number | null;
  inconsistencies: string[];
};

function buildCleanTaskTimeline(task: CarerTask): CleanTaskTimeline {
  const createdMs = getTimestampMs(task.createdAt);
  const rawClaimedMs = getTimestampMs(task.claimedAt);
  const rawStartedMs = getTimestampMs(task.startedAt);
  const completedMs = getTimestampMs(task.completedAt);
  const inconsistencies: string[] = [];

  let claimedMs = rawClaimedMs;
  if (claimedMs && createdMs && claimedMs < createdMs) {
    inconsistencies.push('claimed_before_created');
    claimedMs = 0;
  }
  if (claimedMs && completedMs && claimedMs > completedMs) {
    inconsistencies.push('claimed_after_completed');
    claimedMs = 0;
  }

  let startedMs = rawStartedMs;
  if (!startedMs && claimedMs) {
    startedMs = claimedMs;
  }
  if (startedMs && createdMs && startedMs < createdMs) {
    inconsistencies.push('started_before_created');
    startedMs = claimedMs && (!createdMs || claimedMs >= createdMs) ? claimedMs : 0;
  }
  if (startedMs && claimedMs && startedMs < claimedMs) {
    inconsistencies.push('started_before_claimed');
    startedMs = claimedMs;
  }
  if (startedMs && completedMs && startedMs > completedMs) {
    inconsistencies.push('started_after_completed');
    startedMs = claimedMs && claimedMs <= completedMs ? claimedMs : 0;
  }

  const totalDurationMs =
    createdMs && completedMs && completedMs >= createdMs ? completedMs - createdMs : null;
  const claimToCompleteMs =
    claimedMs && completedMs && completedMs >= claimedMs ? completedMs - claimedMs : null;
  const automationRunMs =
    startedMs && completedMs && completedMs >= startedMs ? completedMs - startedMs : null;

  return {
    createdMs,
    claimedMs,
    startedMs,
    completedMs,
    totalDurationMs,
    claimToCompleteMs,
    automationRunMs,
    inconsistencies,
  };
}

function formatTaskDuration(totalMs: number | null) {
  if (totalMs == null || !Number.isFinite(totalMs)) {
    return '—';
  }
  if (totalMs <= 0) {
    return 'Under 1s';
  }
  const totalSeconds = Math.max(1, Math.round(totalMs / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function sortByNewest<T extends { createdAt?: unknown; completedAt?: unknown; pokedAt?: unknown }>(
  items: T[]
) {
  return [...items].sort((left, right) => {
    const leftTime =
      getTimestampMs(left.pokedAt) ||
      getTimestampMs(left.completedAt) ||
      getTimestampMs(left.createdAt);
    const rightTime =
      getTimestampMs(right.pokedAt) ||
      getTimestampMs(right.completedAt) ||
      getTimestampMs(right.createdAt);

    return rightTime - leftTime;
  });
}

function normalizeGameName(gameName: string) {
  return gameName.trim().toLowerCase();
}

function isFreshActiveTaskClaim(task: CarerTask, hasFreshLinkedAutomationJob: boolean) {
  const taskStatus = String(task.status || '').trim().toLowerCase();
  const claimedStatus = String(task.claimedStatus || '').trim().toLowerCase();
  const automationStatus = String(task.automationStatus || '').trim().toLowerCase();
  const hasAutomationError = Boolean(String(task.automationError || '').trim());
  const heartbeatMs = Math.max(
    getTimestampMs(task.lastHeartbeatAt),
    getTimestampMs(task.claimedAt)
  );

  if (taskStatus !== 'in_progress') {
    return false;
  }

  if (claimedStatus !== 'running') {
    return false;
  }

  if (automationStatus === 'failed' || automationStatus === 'waiting' || hasAutomationError) {
    return false;
  }

  if (hasFreshLinkedAutomationJob) {
    return true;
  }

  // Legacy fallback for task records created before job liveness became authoritative.
  return Boolean(heartbeatMs) && Date.now() - heartbeatMs < TASK_CLAIM_STALE_TIMEOUT_MS;
}

function getStartTaskDisabledReason(task: CarerTask, options: {
  isLoading: boolean;
  automationStatus: string | null;
  hasFreshTaskClaim: boolean;
  hasFreshRunnableJob: boolean;
}) {
  const isPendingCleanTask =
    String(task.status || '').trim().toLowerCase() === 'pending' &&
    !String(task.claimedByUid || '').trim() &&
    !String(task.assignedCarerUid || '').trim() &&
    !String(task.automationJobId || '').trim();
  if (options.isLoading) {
    return 'queueing';
  }
  if (isPendingCleanTask) {
    if (options.automationStatus && options.hasFreshRunnableJob) {
      console.info('[CARER_UI] pending clean task claim allowed despite stale job', {
        taskId: task.id,
        automationStatus: options.automationStatus,
      });
    }
    return null;
  }
  if (options.automationStatus === 'waiting' && options.hasFreshRunnableJob) {
    return 'already_queued_same_task';
  }
  if (options.automationStatus === 'running' && options.hasFreshRunnableJob) {
    return 'already_running_same_task';
  }
  if (options.hasFreshTaskClaim) {
    return 'fresh_claim_running_same_task';
  }
  return null;
}

function isActiveAutomationUiStatus(status: string | null | undefined) {
  const normalized = String(status || '').trim().toLowerCase();
  return (
    normalized === 'queued' ||
    normalized === 'claimed' ||
    normalized === 'waiting' ||
    normalized === 'running' ||
    normalized === 'in_progress' ||
    normalized === 'processing'
  );
}

function logTaskTabFilter(task: CarerTask, includedIn: TaskSection | null, excludedReason: string | null) {
  if (!DEBUG_TAB_FILTER_LOGS) {
    return;
  }
  console.info(
    '[TAB_FILTER] taskId=%s status=%s automationStatus=%s linkedJobId=%s automationJobId=%s assignedCarer=%s assignedCarerUid=%s includedIn=%s reason=%s',
    task.id,
    String(task.status || '').trim() || null,
    String(task.automationStatus || '').trim() || null,
    String((task as { linkedJobId?: string | null }).linkedJobId || '').trim() || null,
    String(task.automationJobId || '').trim() || null,
    String(task.assignedCarerUsername || task.assignedCarer || '').trim() || null,
    String(task.assignedCarerUid || '').trim() || null,
    includedIn,
    excludedReason
  );
}

function normalizeSiteUrl(siteUrl?: string | null) {
  const trimmed = String(siteUrl || '').trim();

  if (!trimmed) {
    return '';
  }

  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function getTaskTypeKey(task: CarerTask) {
  const fallbackKind = (task as CarerTask & { kind?: string | null }).kind;
  return String(task.type || fallbackKind || '').trim().toLowerCase();
}

function getTaskTypeLabel(task: CarerTask) {
  const taskType = getTaskTypeKey(task);

  if (taskType === 'create_game_username') {
    return 'Create Username';
  }

  if (taskType === 'recreate_username') {
    return 'Recreate Username';
  }

  if (taskType === 'reset_password') {
    return 'Reset Password';
  }

  if (taskType === 'recharge') {
    return 'Recharge';
  }

  return 'Redeem';
}

function getTaskTypeClass(task: CarerTask) {
  const taskType = getTaskTypeKey(task);

  if (taskType === 'create_game_username') {
    return 'bg-yellow-500/20 text-yellow-200';
  }

  if (taskType === 'recreate_username') {
    return 'bg-amber-500/20 text-amber-200';
  }

  if (taskType === 'reset_password') {
    return 'bg-indigo-500/20 text-indigo-200';
  }

  if (taskType === 'recharge') {
    return 'bg-green-500/20 text-green-200';
  }

  return 'bg-red-500/20 text-red-200';
}

function getTaskActionLabel(task: CarerTask) {
  const taskType = getTaskTypeKey(task);

  if (taskType === 'recharge' || taskType === 'redeem') {
    return 'Done';
  }

  return 'Done';
}

function mapCarerTaskToAutomationType(task: CarerTask) {
  const taskType = getTaskTypeKey(task);

  if (taskType === 'create_game_username') return mapTaskType('CREATE USERNAME');
  if (taskType === 'recreate_username') return mapTaskType('RECREATE USERNAME');
  if (taskType === 'reset_password') return mapTaskType('RESET PASSWORD');
  if (taskType === 'recharge') return mapTaskType('RECHARGE');
  if (taskType === 'redeem') return mapTaskType('REDEEM');
  return mapTaskType('COMPLETE TASK');
}

function isUsernameWorkflowTask(task: CarerTask) {
  const taskType = getTaskTypeKey(task);

  return (
    taskType === 'create_game_username' ||
    taskType === 'recreate_username' ||
    taskType === 'reset_password'
  );
}

function formatNpr(value: number) {
  return `NPR ${Math.round(value).toLocaleString()}`;
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

/** Rolling window for Work details recharge / redeem sums. */
const WORK_DETAILS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const AUTO_PENDING_LISTENER_LIMIT = 5;
const AUTO_LISTENER_DEBOUNCE_MS = 0;
const RETURN_TO_PENDING_AUTOTICK_COOLDOWN_MS = 30_000;
const BROWSER_AUTO_TICK_INSTANCE_ID = `carer-ui-${Date.now()}-${Math.random()
  .toString(36)
  .slice(2)}`;

function getNepalClockLabel() {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kathmandu',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  }).format(new Date());
}

function NepalClockCard() {
  const [nepalClock, setNepalClock] = useState(getNepalClockLabel());

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setNepalClock(getNepalClockLabel());
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, []);

  return (
    <div className="rounded-xl border border-blue-500/20 bg-blue-500/10 p-3 sm:p-4 md:rounded-2xl md:p-6">
      <p className="text-xs text-blue-100/80 sm:text-sm">Nepal Clock</p>
      <p className="mt-1 text-xl font-bold text-blue-200 sm:text-2xl md:mt-2 md:text-3xl">
        {nepalClock}
      </p>
      <p className="mt-1 text-[11px] text-blue-100/80 sm:text-xs md:mt-2">
        Timezone: Asia/Kathmandu
      </p>
    </div>
  );
}

function isNepalNightNow() {
  const hour = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Kathmandu',
      hour: '2-digit',
      hour12: false,
    }).format(new Date())
  );

  return hour >= 22 || hour < 6;
}

export default function CarerPage() {
  const [activeView, setActiveView] = useState<CarerView>('dashboard');
  const [carerIdentity, setCarerIdentity] = useState<CarerIdentity | null>(null);
  const [coadminUid, setCoadminUid] = useState('');
  const baseDataRefreshInFlightRef = useRef(false);
  const loggedTaskTimelineInconsistenciesRef = useRef<Set<string>>(new Set());

  const [players, setPlayers] = useState<PlayerUser[]>([]);
  const [gameOptions, setGameOptions] = useState<GameLogin[]>([]);
  const [allPlayerLogins, setAllPlayerLogins] = useState<PlayerGameLogin[]>([]);
  const [pendingRequests, setPendingRequests] = useState<PlayerGameRequest[]>([]);
  const [tasks, setTasks] = useState<CarerTask[]>([]);

  const [selectedPlayerUid, setSelectedPlayerUid] = useState('');
  const [editingLogin, setEditingLogin] = useState<PlayerGameLogin | null>(null);
  const [activeUsernameTask, setActiveUsernameTask] = useState<CarerTask | null>(null);

  const [gameName, setGameName] = useState('');
  const [gameUsername, setGameUsername] = useState('');
  const [gamePassword, setGamePassword] = useState('');

  const [bootstrapping, setBootstrapping] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [taskSyncRunning, setTaskSyncRunning] = useState(false);
  const [taskSyncError, setTaskSyncError] = useState<string | null>(null);
  const [taskSyncLastDoneAt, setTaskSyncLastDoneAt] = useState<number | null>(null);
  const [savingUsername, setSavingUsername] = useState(false);
  const [blockingPlayerUid, setBlockingPlayerUid] = useState<string | null>(null);
  const [taskLoadingId, setTaskLoadingId] = useState<string | null>(null);
  const [dismissRedeemRequestId, setDismissRedeemRequestId] = useState<
    string | null
  >(null);
  const [dismissRechargeRequestId, setDismissRechargeRequestId] = useState<
    string | null
  >(null);
  const [dismissedRechargeRequestIds, setDismissedRechargeRequestIds] = useState<
    Record<string, true>
  >({});
  const [deletedCarerTaskIds, setDeletedCarerTaskIds] = useState<Record<string, true>>({});
  const [deletingPendingTaskId, setDeletingPendingTaskId] = useState<string | null>(null);
  const [showRevTotals, setShowRevTotals] = useState(false);
  const [completedVisibleLimit, setCompletedVisibleLimit] = useState(CARER_COMPLETED_RENDER_STEP);

  const [errorMessage, setErrorMessage] = useState('');
  const [noticeMessage, setNoticeMessage] = useState('');
  const [showTaskSplash, setShowTaskSplash] = useState(false);
  const [loginDetailsTask, setLoginDetailsTask] = useState<CarerTask | null>(null);
  const [pendingTaskPayloadPreview, setPendingTaskPayloadPreview] = useState<CarerTask | null>(null);
  const [cashBoxNpr, setCashBoxNpr] = useState(0);
  const [cashoutLoading, setCashoutLoading] = useState(false);
  const [savingPaymentDetails, setSavingPaymentDetails] = useState(false);
  const [showPaymentDetailsPanel, setShowPaymentDetailsPanel] = useState(false);
  const [paymentQrUrl, setPaymentQrUrl] = useState('');
  const [paymentQrPublicId, setPaymentQrPublicId] = useState('');
  const [paymentDetails, setPaymentDetails] = useState('');
  const [showInquiryPanel, setShowInquiryPanel] = useState(false);
  const [inquiryMessage, setInquiryMessage] = useState('');
  const [sendingInquiry, setSendingInquiry] = useState(false);
  const [riskSnapshots, setRiskSnapshots] = useState<PlayerRiskSnapshot[]>([]);
  const [showRiskPanel, setShowRiskPanel] = useState(false);
  const [selectedRiskSnapshot, setSelectedRiskSnapshot] = useState<PlayerRiskSnapshot | null>(
    null
  );
  const [riskActionLoading, setRiskActionLoading] = useState<string | null>(null);
  const [automationLoadingTaskId, setAutomationLoadingTaskId] = useState<string | null>(null);
  const [automationAutoStateDoc, setAutomationAutoStateDoc] =
    useState<CarerAutomationAutoStateDoc | null>(null);
  const autoAutomationEnabled = Boolean(automationAutoStateDoc?.enabled);
  const [automationStatusByTaskId, setAutomationStatusByTaskId] = useState<
    Record<string, AutomationUiStatus>
  >({});
  const [freshAutomationJobByTaskId, setFreshAutomationJobByTaskId] = useState<
    Record<string, boolean>
  >({});
  const [pendingAutomationResetTaskIds, setPendingAutomationResetTaskIds] = useState<
    Record<string, true>
  >({});
  const [localAutomationProcessingByTaskId, setLocalAutomationProcessingByTaskId] = useState<
    Record<string, number>
  >({});
  const [agentInputDraft, setAgentInputDraft] = useState('');
  const [agentPanelNotice, setAgentPanelNotice] = useState('');
  const [agentPanelError, setAgentPanelError] = useState('');
  const [automationTokenWarning, setAutomationTokenWarning] = useState('');
  const [agentSaving, setAgentSaving] = useState(false);
  const [browserWarmupStatus, setBrowserWarmupStatus] = useState<WarmupStatus>('not_warmed');
  const [browserWarmupMessage, setBrowserWarmupMessage] = useState('Not warmed');
  const [browserWarmupGames, setBrowserWarmupGames] = useState<Record<string, BrowserWarmupGameResult>>({});
  const [isTickRunning, setIsTickRunning] = useState(false);
  const [isListenerActive, setIsListenerActive] = useState(false);
  const [isQueueDraining, setIsQueueDraining] = useState(false);
  const [autoDrainRequestId, setAutoDrainRequestId] = useState(0);

  const previousPendingCountRef = useRef(0);
  const shiftSessionIdRef = useRef<string | null>(null);
  const startTaskInFlightIdsRef = useRef<Set<string>>(new Set());

  const selectedPlayer = useMemo((): PlayerUser | null => {
    if (!selectedPlayerUid.trim()) {
      return null;
    }
    const fromList = players.find((player) => player.uid === selectedPlayerUid);
    if (fromList) {
      return fromList;
    }
    return {
      id: selectedPlayerUid,
      uid: selectedPlayerUid,
      username: 'Unknown player',
      email: '',
      role: 'player',
      status: 'active',
      createdBy: null,
      coadminUid: coadminUid || null,
    };
  }, [players, selectedPlayerUid, coadminUid]);

  const selectedPlayerLogins = useMemo(
    () =>
      sortByNewest(
        allPlayerLogins.filter((login) => login.playerUid === selectedPlayerUid)
      ),
    [allPlayerLogins, selectedPlayerUid]
  );

  const existingLoginForSelectedGame = useMemo(() => {
    if (!selectedPlayerUid || !gameName) {
      return null;
    }

    return (
      allPlayerLogins.find(
        (login) =>
          login.playerUid === selectedPlayerUid &&
          normalizeGameName(login.gameName || '') === normalizeGameName(gameName)
      ) || null
    );
  }, [allPlayerLogins, gameName, selectedPlayerUid]);

  const claimablePendingTasks = useMemo(
    () => {
      const filtered = tasks.filter((task) => {
        const status = String(task.status || '').trim().toLowerCase();
        const included = status === 'pending';
        logTaskTabFilter(task, included ? 'pending' : null, included ? null : `status_${status || 'missing'}`);
        return included;
      });
      console.info('[CARER_TASK_GROUPING_DEBUG]', {
        section: 'pending',
        count: filtered.length,
        taskIds: filtered.map((task) => task.id),
      });
      return sortByNewest(filtered);
    },
    [tasks]
  );

  const myInProgressTasks = useMemo(
    () => {
      const filtered = tasks.filter((task) => {
        const status = String(task.status || '').trim().toLowerCase();
        const uid = carerIdentity?.uid?.trim();
        if (status !== 'in_progress') {
          logTaskTabFilter(task, null, `status_${status || 'missing'}`);
          return false;
        }
        if (!uid) {
          logTaskTabFilter(task, null, 'missing_carer_uid');
          return false;
        }
        const included = task.assignedCarerUid === uid || task.claimedByUid === uid;
        logTaskTabFilter(
          task,
          included ? 'mine' : null,
          included ? null : `assigned_carer_mismatch_current_${uid}`
        );
        return included;
      });
      console.info('[CARER_TASK_GROUPING_DEBUG]', {
        section: 'mine',
        count: filtered.length,
        taskIds: filtered.map((task) => task.id),
        statuses: filtered.map((task) => ({
          taskId: task.id,
          status: task.status,
          assignedCarerUid: task.assignedCarerUid ?? null,
          claimedByUid: task.claimedByUid ?? null,
          automationJobId: task.automationJobId ?? null,
        })),
      });
      return sortByNewest(filtered);
    },
    [carerIdentity?.uid, tasks]
  );

  const completedTasks = useMemo(
    () => {
      const filtered = tasks.filter((task) => {
        const included = isRealCompletedCarerTask(task);
        logTaskTabFilter(
          task,
          included ? 'completed' : null,
          included ? null : `not_real_completed_status_${String(task.status || '').trim() || 'missing'}`
        );
        return included;
      });
      return sortByNewest(filtered);
    },
    [tasks]
  );

  const renderedCompletedTasks = useMemo(
    () => completedTasks.slice(0, completedVisibleLimit),
    [completedTasks, completedVisibleLimit]
  );

  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') {
      return;
    }
    console.info('[CARER_COMPLETED_RENDER_LIMIT]', {
      totalCompleted: completedTasks.length,
      renderedCompleted: renderedCompletedTasks.length,
      visibleLimit: completedVisibleLimit,
    });
  }, [completedTasks.length, renderedCompletedTasks.length, completedVisibleLimit]);

  const workDetails30d = useMemo(() => {
    const carerUid = carerIdentity?.uid?.trim();
    if (!carerUid) {
      return {
        rechargeTotal: 0,
        redeemTotal: 0,
        rechargeCount: 0,
        redeemCount: 0,
      };
    }

    const cutoff = Date.now() - WORK_DETAILS_WINDOW_MS;
    let rechargeTotal = 0;
    let redeemTotal = 0;
    let rechargeCount = 0;
    let redeemCount = 0;

    for (const task of tasks) {
      if (!isRealCompletedCarerTask(task)) {
        continue;
      }

      if (task.type !== 'recharge' && task.type !== 'redeem') {
        continue;
      }

      const completerUid = String(
        task.completedByCarerUid || task.assignedCarerUid || ''
      ).trim();

      if (completerUid !== carerUid) {
        continue;
      }

      const completedMs = getTimestampMs(task.completedAt);
      if (!completedMs || completedMs < cutoff) {
        continue;
      }

      const amount = Number(task.amount || 0);

      if (task.type === 'recharge') {
        rechargeTotal += amount;
        rechargeCount += 1;
      } else {
        redeemTotal += amount;
        redeemCount += 1;
      }
    }

    return { rechargeTotal, redeemTotal, rechargeCount, redeemCount };
  }, [carerIdentity?.uid, tasks]);

  const carerRechargeRedeemTotals = useMemo<Record<string, CarerRechargeRedeemTotals>>(() => {
    const totals: Record<string, CarerRechargeRedeemTotals> = {};
    const cutoff = Date.now() - WORK_DETAILS_WINDOW_MS;

    for (const task of tasks) {
      if (!isRealCompletedCarerTask(task)) {
        continue;
      }
      if (task.type !== 'recharge' && task.type !== 'redeem') {
        continue;
      }
      const completedMs = getTimestampMs(task.completedAt);
      if (!completedMs || completedMs < cutoff) {
        continue;
      }
      const carerUid = String(task.completedByCarerUid || task.assignedCarerUid || '').trim();
      if (!carerUid) {
        continue;
      }
      if (!totals[carerUid]) {
        totals[carerUid] = {
          totalRechargeAmount: 0,
          totalRedeemAmount: 0,
        };
      }
      const amount = Number(task.amount || 0);
      if (task.type === 'recharge') {
        totals[carerUid].totalRechargeAmount += amount;
      } else {
        totals[carerUid].totalRedeemAmount += amount;
      }
    }

    return totals;
  }, [tasks]);

  const redeemShareVsRecharge =
    workDetails30d.rechargeTotal > 0
      ? workDetails30d.redeemTotal / workDetails30d.rechargeTotal
      : workDetails30d.redeemTotal > 0
        ? Number.POSITIVE_INFINITY
        : 0;

  const showRedeemPatternWarning =
    workDetails30d.redeemTotal > 0 &&
    (workDetails30d.rechargeTotal <= 0 || redeemShareVsRecharge > 0.5);

  const usernameNeededCount = useMemo(() => {
    const uniqueLogins = new Set(
      allPlayerLogins.map(
        (login) => `${login.playerUid}::${normalizeGameName(login.gameName || '')}`
      )
    );
    let missingCount = 0;

    for (const player of players) {
      for (const game of gameOptions) {
        if (
          !uniqueLogins.has(
            `${player.uid}::${normalizeGameName(game.gameName || '')}`
          )
        ) {
          missingCount += 1;
        }
      }
    }

    return missingCount;
  }, [allPlayerLogins, gameOptions, players]);

  const pendingRequestCount = pendingRequests.filter(
    (request) => request.status === 'pending'
  ).length;

  const dashboardCards: DashboardCard[] = [
    { label: 'Players Available', value: players.length },
    { label: 'Games Available', value: gameOptions.length },
    { label: 'Username Needed', value: usernameNeededCount, tone: 'amber' },
    { label: 'Pending Requests', value: pendingRequestCount, tone: 'blue' },
  ];
  const riskyPlayers = useMemo(
    () => riskSnapshots.filter((entry) => entry.riskLevel !== 'low').slice(0, 8),
    [riskSnapshots]
  );

  const carerPlayerPresenceUids = useMemo(() => {
    const uids = new Set<string>();
    for (const p of players) {
      uids.add(p.uid);
    }
    for (const t of tasks) {
      const uid = String(t.playerUid || '').trim();
      if (uid) {
        uids.add(uid);
      }
    }
    return [...uids];
  }, [players, tasks]);
  const carerPlayerOnlineByUid = usePresenceOnlineMap(carerPlayerPresenceUids);
  const autoTickRequestInFlightRef = useRef(false);
  const recentlyReturnedTaskIdsRef = useRef<Record<string, number>>({});
  const autoTickBrowserTokenRef = useRef<{ token: string; expiresAt: number } | null>(null);
  const autoQueueDrainInFlightRef = useRef(false);
  const autoAutomationEnabledRef = useRef(false);
  const lastAutoDispatchSignatureRef = useRef('');
  const myInProgressCountRef = useRef(0);
  const autoCooldownRetryTimeoutRef = useRef<number | null>(null);
  const fastDispatchCoalesceRef = useRef<number | null>(null);
  const fastDispatchPendingRef = useRef<{
    eventName: string;
    taskId: string;
    receivedAt: number;
    outboxId: number | null;
  } | null>(null);
  const pageInitInFlightUidRef = useRef<string | null>(null);
  const startupMountStartedAtRef = useRef<number>(Date.now());

  useEffect(() => {
    if (bootstrapping || refreshing) {
      return;
    }
    tryLogCarerPageStartupReady({
      bootstrapping,
      refreshing,
      spinner_visible: false,
    });
  }, [bootstrapping, refreshing]);

  useEffect(() => {
    autoAutomationEnabledRef.current = autoAutomationEnabled;
  }, [autoAutomationEnabled]);

  async function refreshAutoTickBrowserToken(agentId: string) {
    if (!agentId) {
      autoTickBrowserTokenRef.current = null;
      return null;
    }
    if (isClientSqlReadMode()) {
      if (!getLocalAppSessionId()) {
        autoTickBrowserTokenRef.current = null;
        return null;
      }
    } else if (!getLocalAppSessionId() && !auth.currentUser) {
      autoTickBrowserTokenRef.current = null;
      return null;
    }
    const existing = autoTickBrowserTokenRef.current;
    if (existing && existing.expiresAt > Date.now() + 15_000) {
      return existing.token;
    }
    const tokenRequestStartedAt = Date.now();
    logCarerPageStartup({
      stage: 'auto_tick_token_start',
      ok: true,
      uid: carerIdentity?.uid ?? null,
      role: 'carer',
    });
    try {
      console.info('[START_TIMING] auto tick token request start at=%s', new Date(tokenRequestStartedAt).toISOString());
      const headers = isClientSqlReadMode()
        ? await getSqlApiReadHeaders(false)
        : await getFirebaseApiHeaders(false);
      if (isClientSqlReadMode()) {
        console.info('[CARER_AUTOTICK_SQL_HEADERS]', {
          route: '/api/carer/automation-auto-tick-token',
          authSource: 'app_session_sql',
          firebaseAttempted: false,
        });
      }
      const response = await fetch('/api/carer/automation-auto-tick-token', {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ agentId }),
      });
      const payload = (await response.json().catch(() => null)) as {
        token?: string;
        expiresAt?: number;
      } | null;
      console.info('[START_TIMING] auto tick token response status=%s durationMs=%s', response.status, Date.now() - tokenRequestStartedAt);
      if (!response.ok || !payload?.token || !payload.expiresAt) {
        console.info('[AUTO_UI] browser auto tick token skipped', {
          status: response.status,
          reason: 'token_request_failed',
        });
        autoTickBrowserTokenRef.current = null;
        setAutomationTokenWarning(
          'Automation browser token unavailable. Auto-tick may not work until Firestore/API recovers.'
        );
        logCarerPageStartup({
          stage: 'auto_tick_token_done',
          ok: false,
          uid: carerIdentity?.uid ?? null,
          role: 'carer',
          durationMs: Date.now() - tokenRequestStartedAt,
          reason: `token_http_${response.status}`,
        });
        return null;
      }
      autoTickBrowserTokenRef.current = {
        token: payload.token,
        expiresAt: payload.expiresAt,
      };
      setAutomationTokenWarning('');
      logCarerPageStartup({
        stage: 'auto_tick_token_done',
        ok: true,
        uid: carerIdentity?.uid ?? null,
        role: 'carer',
        durationMs: Date.now() - tokenRequestStartedAt,
      });
      return payload.token;
    } catch (error) {
      console.info('[AUTO_UI] browser auto tick token skipped', {
        reason: 'network_error',
        error: error instanceof Error ? error.message : String(error),
      });
      autoTickBrowserTokenRef.current = null;
      setAutomationTokenWarning(
        'Automation browser token unavailable. Auto-tick may not work until connectivity recovers.'
      );
      logCarerPageStartup({
        stage: 'auto_tick_token_done',
        ok: false,
        uid: carerIdentity?.uid ?? null,
        role: 'carer',
        durationMs: Date.now() - tokenRequestStartedAt,
        reason: error instanceof Error ? error.message : 'network_error',
      });
      return null;
    }
  }

  async function fireAutomationAutoTick(source: 'immediate' | 'listener' | 'queue') {
    const linkedAgentId =
      String(carerIdentity?.automationAgentId || '').trim() ||
      String(agentInputDraft || '').trim();
    const logPrefix =
      source === 'immediate'
        ? '[AUTO_UI] immediate auto tick'
        : source === 'listener'
          ? '[AUTO_UI] listener auto tick'
          : '[AUTO_UI] queue drain auto tick';

    if (!carerIdentity?.uid || !linkedAgentId) {
      console.info(`${logPrefix} skipped`, {
        reason: 'missing_carer_or_agent',
        carerUid: carerIdentity?.uid || null,
        hasAgentId: Boolean(linkedAgentId),
      });
      return null;
    }
    if (autoTickRequestInFlightRef.current) {
      console.info(`${logPrefix} skipped`, {
        reason: 'request_in_flight',
        carerUid: carerIdentity.uid,
        hasAgentId: Boolean(linkedAgentId),
      });
      return null;
    }
    autoTickRequestInFlightRef.current = true;
    setIsTickRunning(true);
    if (source === 'immediate') {
      setNoticeMessage('Claiming pending task...');
    }

    const body = {
      carerUid: carerIdentity.uid,
      agentId: linkedAgentId,
      instanceId: BROWSER_AUTO_TICK_INSTANCE_ID,
      // Automation is the task consumer: reclaim retryPending after cooldown.
      allowRetryPendingClaim: true,
      source,
    };

    console.info(`${logPrefix} request`, {
      carerUid: body.carerUid,
      agentId: body.agentId,
      instanceId: body.instanceId,
    });
    console.info('[START_AUTOMATION_AUTO_TICK_REQUEST]', {
      source,
      carerUid: body.carerUid,
      agentId: body.agentId,
      instanceId: body.instanceId,
      allowRetryPendingClaim: body.allowRetryPendingClaim,
    });
    console.info('[AUTO_TICK_REQUEST_SENT]', {
      source,
      carerUid: body.carerUid,
      agentId: body.agentId,
      instanceId: body.instanceId,
      sentAt: Date.now(),
    });

    let payload: Record<string, unknown> | null = null;
    let response: Response;
    try {
      const browserTickToken = await refreshAutoTickBrowserToken(linkedAgentId);
      const apiHeaders = isClientSqlReadMode()
        ? await getSqlApiReadHeaders(false)
        : await getFirebaseApiHeaders(false);
      if (isClientSqlReadMode()) {
        console.info('[CARER_AUTOTICK_SQL_HEADERS]', {
          route: '/api/carer/automation-auto-tick',
          authSource: 'app_session_sql',
          firebaseAttempted: false,
        });
      }
      const autoTickStartedAt = Date.now();
      console.info('[START_TIMING] auto tick request start at=%s', new Date(autoTickStartedAt).toISOString());
      response = await fetch('/api/carer/automation-auto-tick', {
        method: 'POST',
        headers: {
          ...apiHeaders,
          ...(browserTickToken ? { 'x-carer-auto-tick-token': browserTickToken } : {}),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      console.info('[START_TIMING] auto tick request response status=%s durationMs=%s', response.status, Date.now() - autoTickStartedAt);
      console.info('[START_AUTOMATION_AUTO_TICK_RESPONSE]', {
        source,
        ok: response.ok,
        status: response.status,
        payload,
        durationMs: Date.now() - autoTickStartedAt,
      });
    } catch (error) {
      console.warn(`${logPrefix} response`, {
        ok: false,
        status: null,
        reason: 'network_error',
        error: error instanceof Error ? error.message : String(error),
      });
      console.info('[START_AUTOMATION_AUTO_TICK_RESPONSE]', {
        source,
        ok: false,
        status: null,
        reason: 'network_error',
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    } finally {
      autoTickRequestInFlightRef.current = false;
      setIsTickRunning(false);
    }

    const reason = String(payload?.['reason'] || '').trim() || null;
    const logPayload = {
      ok: response.ok,
      status: response.status,
      reason,
      payload,
    };
    if (response.status === 401 || response.status === 403) {
      console.warn(`${logPrefix} response`, logPayload);
      return payload;
    }
    if (!response.ok) {
      console.warn(`${logPrefix} response`, logPayload);
      return payload;
    }

    console.info(`${logPrefix} response`, logPayload);
    return payload;
  }

  function requestFastAutomationDispatch(signal: {
    eventName: string;
    taskId: string;
    receivedAt: number;
    outboxId?: number;
  }) {
    const linkedAgentId =
      String(carerIdentity?.automationAgentId || '').trim() ||
      String(agentInputDraft || '').trim();

    if (!autoAutomationEnabledRef.current) {
      console.info('[FAST_DISPATCH_SKIPPED]', {
        reason: 'automation_disabled',
        sourceEvent: signal.eventName,
        taskId: signal.taskId || null,
      });
      return;
    }
    if (!carerIdentity?.uid || !coadminUid) {
      console.info('[FAST_DISPATCH_SKIPPED]', {
        reason: 'missing_carer_or_coadmin',
        sourceEvent: signal.eventName,
        taskId: signal.taskId || null,
      });
      return;
    }
    if (!linkedAgentId) {
      console.info('[FAST_DISPATCH_SKIPPED]', {
        reason: 'missing_agent_id',
        sourceEvent: signal.eventName,
        taskId: signal.taskId || null,
      });
      return;
    }

    fastDispatchPendingRef.current = {
      eventName: signal.eventName,
      taskId: signal.taskId,
      receivedAt: signal.receivedAt,
      outboxId: signal.outboxId ?? null,
    };
    if (fastDispatchCoalesceRef.current) {
      return;
    }

    fastDispatchCoalesceRef.current = window.setTimeout(() => {
      fastDispatchCoalesceRef.current = null;
      const pending = fastDispatchPendingRef.current;
      fastDispatchPendingRef.current = null;
      if (!pending || !autoAutomationEnabledRef.current) {
        return;
      }

      const delayMs = Date.now() - pending.receivedAt;
      console.info('[FAST_DISPATCH_PATH]', {
        taskId: pending.taskId || null,
        sourceEvent: pending.eventName,
        autoEnabled: true,
        triggered: true,
        delayMs,
        outboxId: pending.outboxId,
      });
      console.info('[DISPATCH_TRIGGER]', {
        source: 'sse_fast_dispatch',
        carerUid: carerIdentity?.uid || null,
        coadminUid: coadminUid || null,
        sourceEvent: pending.eventName,
        taskId: pending.taskId || null,
        delayMs,
      });

      if (autoQueueDrainInFlightRef.current || autoTickRequestInFlightRef.current) {
        console.info('[FAST_DISPATCH_SKIPPED]', {
          reason: 'drain_already_running',
          sourceEvent: pending.eventName,
          taskId: pending.taskId || null,
        });
        return;
      }

      if (
        myInProgressCountRef.current > 0 &&
        pending.eventName !== 'task.completed' &&
        pending.eventName !== 'task.returned_to_pending' &&
        pending.eventName !== 'task.failed' &&
        pending.eventName !== 'task.released'
      ) {
        console.info('[FAST_DISPATCH_SKIPPED]', {
          reason: 'awaiting_in_progress_completion',
          sourceEvent: pending.eventName,
          taskId: pending.taskId || null,
          inProgressCount: myInProgressCountRef.current,
        });
        return;
      }

      void drainAutomationQueueUntilEmpty('listener');
    }, 0);
  }

  async function drainAutomationQueueUntilEmpty(source: 'start_button' | 'listener') {
    if (autoQueueDrainInFlightRef.current || autoTickRequestInFlightRef.current) {
      console.info('[AUTO_LISTENER_TRIGGER_SKIPPED_ALREADY_RUNNING]', {
        source,
        carerUid: carerIdentity?.uid || null,
        coadminUid: coadminUid || null,
      });
      return;
    }

    autoQueueDrainInFlightRef.current = true;
    setIsQueueDraining(true);
    setNoticeMessage('Claiming pending task...');
    console.info('[AUTO_QUEUE_DRAIN_STARTED]', {
      source,
      carerUid: carerIdentity?.uid || null,
      coadminUid: coadminUid || null,
      inProgressCount: myInProgressCountRef.current,
    });

    let finishReason = 'unknown';
    let tickCount = 0;
    let claimedTaskId: string | null = null;
    let earliestCooldownRetryMs: number | null = null;

    try {
      while (autoAutomationEnabledRef.current) {
        // One-at-a-time: wait until current in-progress work finishes before claiming next.
        if (myInProgressCountRef.current > 0 && !claimedTaskId) {
          finishReason = 'awaiting_in_progress_completion';
          console.info('[AUTO_NEXT_TASK]', {
            status: 'waiting_for_in_progress',
            carerUid: carerIdentity?.uid || null,
            inProgressCount: myInProgressCountRef.current,
            source,
          });
          break;
        }

        tickCount += 1;
        const tickSource =
          tickCount === 1 && source === 'start_button'
            ? 'immediate'
            : tickCount === 1 && source === 'listener'
              ? 'listener'
              : 'queue';
        const payload = await fireAutomationAutoTick(tickSource);
        const reason = String(payload?.['reason'] || '').trim();
        const claimed = payload?.['claimed'] === true || Number(payload?.['claimedCount'] || 0) > 0;
        const claimedJobs = Array.isArray(payload?.['claimedJobs'])
          ? (payload?.['claimedJobs'] as Array<{ taskId?: unknown }>)
          : [];
        const skippedTasks = Array.isArray(payload?.['skippedTasks'])
          ? (payload?.['skippedTasks'] as Array<{ reason?: unknown; remainingCooldownMs?: unknown }>)
          : [];

        for (const skipped of skippedTasks) {
          if (String(skipped?.reason || '') !== 'returned_to_pending_cooldown') {
            continue;
          }
          const remaining = Number(skipped?.remainingCooldownMs);
          if (!Number.isFinite(remaining) || remaining <= 0) {
            continue;
          }
          earliestCooldownRetryMs =
            earliestCooldownRetryMs == null
              ? remaining
              : Math.min(earliestCooldownRetryMs, remaining);
        }

        if (reason === 'no_claimable_task') {
          finishReason = reason;
          break;
        }
        if (!payload || !claimed) {
          finishReason = reason || 'tick_failed_or_no_claim';
          break;
        }

        claimedTaskId = String(claimedJobs[0]?.taskId || '').trim() || 'claimed';
        // Optimistic: block next claim until SSE confirms in-progress / completion.
        myInProgressCountRef.current = Math.max(1, myInProgressCountRef.current + 1);
        console.info('[AUTO_TASK_CLAIM]', {
          taskId: claimedTaskId,
          automationUser: carerIdentity?.uid || null,
          source,
          claimTime: new Date().toISOString(),
        });
        console.info('[AUTO_TASK_STARTED]', {
          taskId: claimedTaskId,
          automationUser: carerIdentity?.uid || null,
          source,
          claimTime: new Date().toISOString(),
        });
        // Claimed one task — stop and let the agent process; reclaim next on complete/fail.
        finishReason = 'claimed_awaiting_completion';
        console.info('[AUTO_NEXT_TASK]', {
          status: 'waiting_for_completion',
          taskId: claimedTaskId,
          carerUid: carerIdentity?.uid || null,
          source,
        });
        break;
      }

      if (!autoAutomationEnabledRef.current) {
        finishReason = 'automation_disabled';
      }
    } finally {
      autoQueueDrainInFlightRef.current = false;
      setIsQueueDraining(false);
      console.info('[AUTO_QUEUE_DRAIN_FINISHED]', {
        source,
        carerUid: carerIdentity?.uid || null,
        coadminUid: coadminUid || null,
        tickCount,
        reason: finishReason,
        claimedTaskId,
      });

      // Allow refill effect to retry when drain stopped without clearing pending work.
      if (
        finishReason !== 'no_claimable_task' &&
        finishReason !== 'claimed_awaiting_completion' &&
        finishReason !== 'awaiting_in_progress_completion' &&
        finishReason !== 'automation_disabled'
      ) {
        lastAutoDispatchSignatureRef.current = '';
      }

      if (
        earliestCooldownRetryMs != null &&
        autoAutomationEnabledRef.current &&
        myInProgressCountRef.current === 0
      ) {
        if (autoCooldownRetryTimeoutRef.current != null) {
          window.clearTimeout(autoCooldownRetryTimeoutRef.current);
        }
        const delayMs = Math.max(250, Math.min(RETURN_TO_PENDING_AUTOTICK_COOLDOWN_MS, earliestCooldownRetryMs + 50));
        console.info('[AUTO_NEXT_TASK]', {
          status: 'scheduled_after_cooldown',
          delayMs,
          carerUid: carerIdentity?.uid || null,
          source,
        });
        autoCooldownRetryTimeoutRef.current = window.setTimeout(() => {
          autoCooldownRetryTimeoutRef.current = null;
          if (!autoAutomationEnabledRef.current) {
            return;
          }
          lastAutoDispatchSignatureRef.current = '';
          void drainAutomationQueueUntilEmpty('listener');
        }, delayMs);
      }
    }
  }

  useEffect(() => {
    if (autoDrainRequestId === 0) {
      return;
    }
    autoAutomationEnabledRef.current = true;
    void drainAutomationQueueUntilEmpty('start_button');
  }, [autoDrainRequestId]);

  useEffect(() => {
    let cancelled = false;
    let firebaseUnsubscribe: (() => void) | undefined;

    logCarerPageStartup({ stage: 'mount', ok: true });
    resetCarerPageStartupTiming();
    startupMountStartedAtRef.current = Date.now();

    void (async () => {
      const sessionStartedAt = Date.now();
      let sessionUser = getCachedSessionUser();
      if (!sessionUser?.uid) {
        sessionUser = await getSessionUserOnce();
      }
      if (cancelled) {
        return;
      }

      logCarerPageStartup({
        stage: 'session_user_loaded',
        ok: Boolean(sessionUser?.uid && sessionUser.role === 'carer'),
        uid: sessionUser?.uid ?? null,
        role: sessionUser?.role ?? null,
        reason:
          sessionUser?.role === 'carer'
            ? null
            : sessionUser?.uid
              ? 'not_carer_role'
              : 'missing_session_user',
        durationMs: Date.now() - sessionStartedAt,
      });

      if (sessionUser?.role === 'carer' && sessionUser.uid) {
        discardStalePlayerSessionIdForRole(sessionUser.role, 'carer_page_startup');
        await initializePageFromAppSession(sessionUser);
        return;
      }

      const firebaseUser = auth.currentUser;
      if (firebaseUser) {
        await initializePageFromFirebase(firebaseUser);
        return;
      }

      firebaseUnsubscribe = onAuthStateChanged(auth, (user) => {
        if (cancelled || !user) {
          return;
        }
        firebaseUnsubscribe?.();
        firebaseUnsubscribe = undefined;
        void initializePageFromFirebase(user);
      });
    })();

    return () => {
      cancelled = true;
      firebaseUnsubscribe?.();
    };
  }, []);

  useEffect(() => {
    if (!coadminUid || !carerIdentity?.uid) {
      return;
    }

    const liveShadowCompare = attachCarerTaskLiveShadowCompare(carerIdentity.uid, coadminUid);
    let sqlReadDispose: (() => void) | null = null;
    let firebaseUnsubscribe: (() => void) | null = null;
    const attachFirebaseListener =
      (!CARER_TASKS_SQL_READ_ENABLED || LIVE_SHADOW_COMPARE_ENABLED) && !isClientSqlReadMode();

    if (attachFirebaseListener) {
      firebaseUnsubscribe = listenToAvailableCarerTasks(
        coadminUid,
        carerIdentity.uid,
        (incomingTasks) => {
          for (const task of incomingTasks) {
            const status = String(task.status || '').trim().toLowerCase();
            const uid = carerIdentity.uid;
            const eligible =
              status === 'in_progress' &&
              (task.assignedCarerUid === uid || task.claimedByUid === uid);
            const reason =
              status !== 'in_progress'
                ? `status_${status || 'missing'}`
                : task.assignedCarerUid !== uid && task.claimedByUid !== uid
                  ? `assigned_carer_mismatch_current_${uid}`
                  : null;
            console.info(
              '[START_TIMING] appears in progress eligible=%s reason=%s taskId=%s status=%s automationStatus=%s assignedCarerUid=%s claimedByUid=%s automationJobId=%s linkedJobId=%s',
              eligible,
              reason,
              task.id,
              status || null,
              String(task.automationStatus || '').trim() || null,
              task.assignedCarerUid || null,
              task.claimedByUid || null,
              task.automationJobId || null,
              String((task as { linkedJobId?: string | null }).linkedJobId || '').trim() || null
            );
          }
          if (!CARER_TASKS_SQL_READ_ENABLED) {
            console.info('[CARER_TASKS_STATE_UPDATED]', {
              source: 'firebase_listener',
              count: incomingTasks.length,
              pendingCount: incomingTasks.filter(
                (task) => String(task.status || '').trim().toLowerCase() === 'pending'
              ).length,
              inProgressCount: incomingTasks.filter(
                (task) => String(task.status || '').trim().toLowerCase() === 'in_progress'
              ).length,
              completedCount: incomingTasks.filter(
                (task) => String(task.status || '').trim().toLowerCase() === 'completed'
              ).length,
            });
            setTasks(sortByNewest(incomingTasks));
          }
          liveShadowCompare.reportFirebaseSnapshot(incomingTasks);
        },
        (error) => {
          if (!CARER_TASKS_SQL_READ_ENABLED) {
            reportCarerUiError('task_listener', error, setErrorMessage, 'Failed to listen for tasks.', {
              file: 'app/carer/page.tsx',
              operation: 'listenToAvailableCarerTasks',
            });
          }
        }
      );
    }

    if (CARER_TASKS_SQL_READ_ENABLED) {
      const sqlRead = attachCarerTaskSqlReadListener(
        carerIdentity.uid,
        coadminUid,
        (incomingTasks) => {
          console.info('[CARER_TASKS_STATE_UPDATED]', {
            source: 'sql_read_listener',
            count: incomingTasks.length,
            pendingCount: incomingTasks.filter(
              (task) => String(task.status || '').trim().toLowerCase() === 'pending'
            ).length,
            inProgressCount: incomingTasks.filter(
              (task) => String(task.status || '').trim().toLowerCase() === 'in_progress'
            ).length,
            completedCount: incomingTasks.filter(
              (task) => String(task.status || '').trim().toLowerCase() === 'completed'
            ).length,
          });
          setTasks(sortByNewest(incomingTasks));
          setErrorMessage('');
        },
        (reason) => {
          console.warn('[CARER_PAGE_STARTUP] tasks live read degraded reason=%s', reason);
        },
        {
          onFastDispatchSignal: (signal) => {
            requestFastAutomationDispatch(signal);
          },
        }
      );
      sqlReadDispose = sqlRead.dispose;
    }

    return () => {
      if (fastDispatchCoalesceRef.current) {
        window.clearTimeout(fastDispatchCoalesceRef.current);
        fastDispatchCoalesceRef.current = null;
      }
      fastDispatchPendingRef.current = null;
      firebaseUnsubscribe?.();
      sqlReadDispose?.();
      liveShadowCompare.dispose();
    };
  }, [carerIdentity?.uid, coadminUid]);

  useEffect(() => {
    if (!coadminUid) {
      setAllPlayerLogins([]);
      return;
    }

    const unsubscribe = listenToPlayerGameLoginsByCoadmin(
      coadminUid,
      (incomingLogins) => {
        setAllPlayerLogins(sortByNewest(incomingLogins));
      },
      (error) => {
        reportCarerUiError(
          'player_game_logins_listener',
          error,
          setErrorMessage,
          'Failed to listen for player game logins.',
          { file: 'app/carer/page.tsx', operation: 'listenToPlayerGameLoginsByCoadmin' }
        );
      }
    );

    return () => unsubscribe();
  }, [coadminUid]);

  useEffect(() => {
    if (!carerIdentity?.uid) {
      setAutomationStatusByTaskId({});
      setFreshAutomationJobByTaskId({});
      return;
    }

    const liveShadowCompare = coadminUid
      ? attachAutomationJobLiveShadowCompare(carerIdentity.uid, coadminUid)
      : {
          reportFirebaseJobSnapshot: () => undefined,
          dispose: () => undefined,
        };
    let sqlReadDispose: (() => void) | null = null;
    let firebaseUnsubscribe: (() => void) | null = null;
    const attachFirebaseListener =
      !AUTOMATION_JOBS_SQL_READ_ENABLED ||
      !coadminUid ||
      LIVE_SHADOW_COMPARE_ENABLED;

    if (attachFirebaseListener) {
      firebaseUnsubscribe = listenAutomationUiStatusByTask(
        carerIdentity.uid,
        (statuses, freshJobs) => {
          if (!AUTOMATION_JOBS_SQL_READ_ENABLED || !coadminUid) {
            setAutomationStatusByTaskId(statuses);
            setFreshAutomationJobByTaskId(freshJobs);
          }
          liveShadowCompare.reportFirebaseJobSnapshot(statuses, freshJobs);
        },
        (error) => {
          if (!AUTOMATION_JOBS_SQL_READ_ENABLED || !coadminUid) {
            reportCarerUiError(
              'automation_job_listener',
              error,
              setErrorMessage,
              'Failed to listen to automation jobs.',
              { file: 'app/carer/page.tsx', operation: 'listenAutomationUiStatusByTask' }
            );
          }
        }
      );
    }

    if (AUTOMATION_JOBS_SQL_READ_ENABLED && coadminUid) {
      const sqlRead = attachAutomationJobsSqlReadListener(
        carerIdentity.uid,
        coadminUid,
        (statuses, freshJobs) => {
          setAutomationStatusByTaskId(statuses);
          setFreshAutomationJobByTaskId(freshJobs);
          setErrorMessage('');
        },
        (reason) => {
          console.warn('[CARER_PAGE_STARTUP] jobs live read degraded reason=%s', reason);
        }
      );
      sqlReadDispose = sqlRead.dispose;
    }

    return () => {
      firebaseUnsubscribe?.();
      sqlReadDispose?.();
      liveShadowCompare.dispose();
    };
  }, [carerIdentity?.uid, coadminUid]);

  useEffect(() => {
    if (!carerIdentity?.uid) {
      setAutomationAutoStateDoc(null);
      return;
    }

    const unsubscribe = subscribeCarerAutomationAutoState(
      carerIdentity.uid,
      (data) => {
        setAutomationAutoStateDoc(data);
      },
      (error) => {
        reportCarerUiError(
          'automation_auto_state',
          error,
          setErrorMessage,
          'Failed to load persistent automation state.',
          { file: 'app/carer/page.tsx', operation: 'subscribeCarerAutomationAutoState' }
        );
      }
    );

    return () => unsubscribe();
  }, [carerIdentity?.uid]);

  useEffect(() => {
    if (!autoAutomationEnabled || !carerIdentity?.uid || !coadminUid) {
      return;
    }
    const linkedAgentId =
      String(carerIdentity.automationAgentId || '').trim() ||
      String(agentInputDraft || '').trim();
    if (!linkedAgentId) {
      console.info('[AUTO_UI] listener auto tick skipped', {
        reason: 'missing_agent_id',
        carerUid: carerIdentity.uid,
      });
      return;
    }

    void drainAutomationQueueUntilEmpty('start_button');
  }, [
    autoAutomationEnabled,
    carerIdentity?.uid,
    carerIdentity?.automationAgentId,
    agentInputDraft,
    coadminUid,
  ]);

  useEffect(() => {
    if (!autoAutomationEnabled || isQueueDraining || !carerIdentity?.uid || !coadminUid) {
      return;
    }
    const linkedAgentId =
      String(carerIdentity.automationAgentId || '').trim() ||
      String(agentInputDraft || '').trim();
    if (!linkedAgentId) {
      return;
    }

    if (
      isClientSqlReadMode() ||
      assertClientFirestoreDisabled('carer_auto_pending_tasks_listener', 'onSnapshot', {
        coadminUid,
      })
    ) {
      return;
    }

    const pendingTasksQuery = query(
      collection(db, 'carerTasks'),
      where('coadminUid', '==', coadminUid),
      where('status', '==', 'pending'),
      orderBy('createdAt', 'desc'),
      limit(AUTO_PENDING_LISTENER_LIMIT)
    );
    let sawInitialSnapshot = false;
    let debounceId: number | null = null;
    const activeStateId = window.setTimeout(() => {
      setIsListenerActive(true);
    }, 0);

    console.info('[AUTO_LISTENER_STARTED]', {
      carerUid: carerIdentity.uid,
      coadminUid,
      limit: AUTO_PENDING_LISTENER_LIMIT,
    });

    const unsubscribe = onSnapshot(
      pendingTasksQuery,
      { includeMetadataChanges: true },
      (snapshot) => {
        const docChanges = snapshot.docChanges();
        console.info(
          '[FIRESTORE] snapshot fromCache=%s hasPendingWrites=%s docCount=%s docChanges=%s at=%s',
          snapshot.metadata.fromCache,
          snapshot.metadata.hasPendingWrites,
          snapshot.size,
          docChanges.length,
          new Date().toISOString()
        );
        if (!sawInitialSnapshot) {
          sawInitialSnapshot = true;
          return;
        }
        const addedPendingDocs = docChanges.filter((change) => change.type === 'added');
        if (addedPendingDocs.length === 0) {
          return;
        }
        const recentlyReturnedTaskIds = Object.entries(recentlyReturnedTaskIdsRef.current)
          .filter(([, returnedAt]) => Date.now() - returnedAt < RETURN_TO_PENDING_AUTOTICK_COOLDOWN_MS)
          .map(([taskId]) => taskId);
        const blockedReturnedTaskIds = addedPendingDocs
          .map((change) => change.doc.id)
          .filter((taskId) => recentlyReturnedTaskIds.includes(taskId));
        if (blockedReturnedTaskIds.length > 0) {
          console.info('[AUTO_LISTENER_SKIP_RECENTLY_RETURNED_TASK]', {
            carerUid: carerIdentity.uid,
            coadminUid,
            blockedReturnedTaskIds,
            cooldownMs: RETURN_TO_PENDING_AUTOTICK_COOLDOWN_MS,
          });
          return;
        }
        if (autoQueueDrainInFlightRef.current || autoTickRequestInFlightRef.current) {
          console.info('[AUTO_LISTENER_TRIGGER_SKIPPED_ALREADY_RUNNING]', {
            carerUid: carerIdentity.uid,
            coadminUid,
            pendingCount: snapshot.size,
            detectedTaskIds: addedPendingDocs.map((change) => change.doc.id),
          });
          return;
        }

        console.info('[AUTO_LISTENER_PENDING_DETECTED]', {
          carerUid: carerIdentity.uid,
          coadminUid,
          pendingCount: snapshot.size,
          detectedTaskIds: addedPendingDocs.map((change) => change.doc.id),
        });

        if (debounceId !== null) {
          window.clearTimeout(debounceId);
        }
        debounceId = window.setTimeout(() => {
          debounceId = null;
          void drainAutomationQueueUntilEmpty('listener');
        }, AUTO_LISTENER_DEBOUNCE_MS);
      },
      (error) => {
        reportCarerUiError(
          'pending_automation_listener',
          error,
          setErrorMessage,
          'Failed to listen for pending automation tasks.',
          { file: 'app/carer/page.tsx', operation: 'pendingTasksQuery' }
        );
        try {
          const normalized = String(error?.message || '').toLowerCase();
          if (normalized.includes('bloom')) {
            // Try a manual server refetch of the pending tasks list to verify server state
            (async () => {
              try {
                const serverSnap = await getDocsFromServer(pendingTasksQuery);
                console.info('[SERVER_REFETCH] pendingTasks docCount=%s ids=%o', serverSnap.size, serverSnap.docs.map((d) => d.id));
              } catch (err) {
                console.error('[SERVER_REFETCH] failed to refetch pendingTasks', err);
              }
            })();
          }
        } catch (err) {
          /* ignore */
        }
      }
    );

    return () => {
      window.clearTimeout(activeStateId);
      if (debounceId !== null) {
        window.clearTimeout(debounceId);
      }
      unsubscribe();
      setIsListenerActive(false);
      console.info('[AUTO_LISTENER_STOPPED]', {
        carerUid: carerIdentity.uid,
        coadminUid,
      });
    };
  }, [
    autoAutomationEnabled,
    isQueueDraining,
    carerIdentity?.uid,
    carerIdentity?.automationAgentId,
    agentInputDraft,
    coadminUid,
  ]);

  useEffect(() => {
    if (!carerIdentity?.uid) {
      autoTickBrowserTokenRef.current = null;
      return;
    }
    const linkedAgentId =
      String(carerIdentity.automationAgentId || '').trim() ||
      String(agentInputDraft || '').trim();
    if (!linkedAgentId) {
      autoTickBrowserTokenRef.current = null;
      return;
    }
    void refreshAutoTickBrowserToken(linkedAgentId);
  }, [carerIdentity?.uid, carerIdentity?.automationAgentId, agentInputDraft]);

  useEffect(() => {
    if (!coadminUid || isClientSqlReadMode()) {
      setRiskSnapshots([]);
      if (isClientSqlReadMode() && coadminUid) {
        console.info('[CARER_RISK_ACTION_SQL_MODE]', {
          action: 'listen_risk_snapshots',
          enabled: false,
          reason: 'sql_risk_api_not_ready',
          firestoreAttempted: false,
        });
      }
      return;
    }

    const unsubscribe = listenPlayerRiskSnapshotsByCoadmin(
      coadminUid,
      (snapshots) => {
        setRiskSnapshots(snapshots);
      },
      (error) => {
        reportCarerUiError(
          'risk_snapshots',
          error,
          setErrorMessage,
          'Failed to load risk snapshots.',
          { file: 'app/carer/page.tsx', operation: 'listenPlayerRiskSnapshotsByCoadmin' }
        );
      }
    );

    return () => unsubscribe();
  }, [coadminUid]);

  useEffect(() => {
    if (!coadminUid) {
      return;
    }
    console.info('[POLLING_INVENTORY]', {
      route: '/api/carer-tasks/cache?scope=carer_totals',
      intervalMs: 0,
      previousIntervalMs: 10_000,
      reason: 'rev_totals_derived_from_live_carer_tasks',
      trigger: 'carerRechargeRedeemTotals useMemo',
      canUseSSE: true,
      required: false,
    });
    console.info('[POLLING_DISABLED]', {
      route: '/api/carer-tasks/cache?scope=carer_totals',
      replacement: 'derive recharge/redeem totals from task SSE snapshot already in React state',
    });
  }, [coadminUid]);

  useEffect(() => {
    if (!carerIdentity?.uid || !coadminUid) {
      return;
    }

    const activeCarer = carerIdentity;
    let disposed = false;
    let heartbeatId: number | null = null;
    let startDelayId: number | null = null;
    let sessionIdForThisEffect: string | null = null;

    async function startMyShift() {
      const currentUser = auth.currentUser;
      if (!currentUser || currentUser.uid !== activeCarer.uid || disposed) {
        return;
      }

      const sessionId = await startShiftSession({
        coadminUid,
        userUid: currentUser.uid,
        userRole: 'carer',
        userUsername: activeCarer.username?.trim() || 'Carer',
      });
      sessionIdForThisEffect = sessionId;

      if (disposed) {
        await endShiftSession(sessionId).catch(() => undefined);
        return;
      }

      shiftSessionIdRef.current = sessionId;
      heartbeatId = window.setInterval(() => {
        if (!sessionIdForThisEffect || shiftSessionIdRef.current !== sessionIdForThisEffect) {
          return;
        }
        void heartbeatShiftSession(sessionIdForThisEffect).catch(() => undefined);
      }, 60_000);
    }

    startDelayId = window.setTimeout(() => {
      startDelayId = null;
      void startMyShift().catch(() => undefined);
    }, 0);

    return () => {
      disposed = true;
      if (startDelayId !== null) {
        window.clearTimeout(startDelayId);
      }
      if (heartbeatId !== null) {
        window.clearInterval(heartbeatId);
      }
      const id = sessionIdForThisEffect;
      if (!id) {
        return;
      }
      if (shiftSessionIdRef.current === id) {
        shiftSessionIdRef.current = null;
      }
      void endShiftSession(id).catch(() => undefined);
    };
  }, [carerIdentity?.uid, carerIdentity?.username, coadminUid]);

  useEffect(() => {
    const pendingCount = claimablePendingTasks.length;

    if (pendingCount > previousPendingCountRef.current) {
      playPendingNotificationSound();
      setShowTaskSplash(true);
    }

    if (pendingCount === 0) {
      setShowTaskSplash(false);
    }

    previousPendingCountRef.current = pendingCount;
  }, [claimablePendingTasks.length]);

  useEffect(() => {
    myInProgressCountRef.current = myInProgressTasks.length;
  }, [myInProgressTasks.length]);

  useEffect(() => {
    return () => {
      if (autoCooldownRetryTimeoutRef.current != null) {
        window.clearTimeout(autoCooldownRetryTimeoutRef.current);
        autoCooldownRetryTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const pendingCount = claimablePendingTasks.length;
    const activeCount = myInProgressTasks.length;
    if (!autoAutomationEnabled || pendingCount === 0 || !carerIdentity?.uid || !coadminUid) {
      lastAutoDispatchSignatureRef.current = '';
      return;
    }

    const linkedAgentId =
      String(carerIdentity.automationAgentId || '').trim() ||
      String(agentInputDraft || '').trim();
    if (!linkedAgentId) {
      return;
    }

    // Sequential consumer: only auto-claim when this carer has no in-progress task.
    if (activeCount > 0) {
      console.info('[AUTO_NEXT_TASK]', {
        status: 'deferred_while_in_progress',
        carerUid: carerIdentity.uid,
        pendingCount,
        activeCount,
      });
      return;
    }

    const signature = [
      carerIdentity.uid,
      coadminUid,
      pendingCount,
      activeCount,
      claimablePendingTasks.map((task) => task.id).join(','),
      myInProgressTasks.map((task) => `${task.id}:${task.status}:${task.automationStatus || ''}`).join(','),
    ].join('|');
    if (lastAutoDispatchSignatureRef.current === signature) {
      return;
    }
    lastAutoDispatchSignatureRef.current = signature;

    console.info('[DISPATCH_TRIGGER]', {
      source: 'carer_page_refill_effect',
      carerUid: carerIdentity.uid,
      coadminUid,
      pendingCount,
      activeCount,
      pendingTaskIds: claimablePendingTasks.map((task) => task.id),
      activeTaskIds: myInProgressTasks.map((task) => task.id),
    });

    if (autoQueueDrainInFlightRef.current || autoTickRequestInFlightRef.current || isQueueDraining) {
      console.info('[DISPATCH_IDLE_WITH_PENDING]', {
        source: 'carer_page_refill_effect',
        carerUid: carerIdentity.uid,
        coadminUid,
        pendingCount,
        activeCount,
        reason: 'drain_already_running',
      });
      // Clear signature so a later idle pass can retry the same pending set.
      lastAutoDispatchSignatureRef.current = '';
      return;
    }

    console.info('[DISPATCH_IDLE_WITH_PENDING]', {
      source: 'carer_page_refill_effect',
      carerUid: carerIdentity.uid,
      coadminUid,
      pendingCount,
      activeCount,
      reason: 'refill_requested',
    });
    void drainAutomationQueueUntilEmpty('listener');
  }, [
    autoAutomationEnabled,
    claimablePendingTasks,
    myInProgressTasks,
    carerIdentity?.uid,
    carerIdentity?.automationAgentId,
    agentInputDraft,
    coadminUid,
    isQueueDraining,
  ]);

  useEffect(() => {
    if (claimablePendingTasks.length === 0) {
      return;
    }

    const intervalId = window.setInterval(() => {
      setShowTaskSplash(true);
      playPendingNotificationSound();
    }, 5000);

    return () => window.clearInterval(intervalId);
  }, [claimablePendingTasks.length]);

  useEffect(() => {
    if (!selectedPlayerUid) {
      setEditingLogin(null);
    }
  }, [selectedPlayerUid]);

  useEffect(() => {
    const now = Date.now();
    let changed = false;
    const next: Record<string, number> = {};

    for (const [taskId, expiresAt] of Object.entries(localAutomationProcessingByTaskId)) {
      if (expiresAt > now) {
        next[taskId] = expiresAt;
      } else {
        changed = true;
      }
    }

    if (changed) {
      setLocalAutomationProcessingByTaskId(next);
    }
  }, [localAutomationProcessingByTaskId]);

  useEffect(() => {
    setLocalAutomationProcessingByTaskId((current) => {
      let changed = false;
      const next = { ...current };

      for (const [taskId, status] of Object.entries(automationStatusByTaskId)) {
        if (
          status === 'completed' ||
          status === 'failed' ||
          status === 'pending_review'
        ) {
          if (next[taskId]) {
            delete next[taskId];
            changed = true;
          }
        }
      }

      for (const task of tasks) {
        if (task.status === 'completed' && next[task.id]) {
          delete next[task.id];
          changed = true;
        }
      }

      return changed ? next : current;
    });
  }, [automationStatusByTaskId, tasks]);

  async function enrichCarerProfileFromFirestoreOptional(uid: string) {
    const startedAt = Date.now();
    const path = `users/${uid}`;
    try {
      const snap = await Promise.race([
        getDoc(doc(db, 'users', uid)),
        new Promise<never>((_, reject) => {
          window.setTimeout(
            () => reject(new Error('firestore_profile_enrich_timeout')),
            CARER_PROFILE_FIRESTORE_ENRICH_MS
          );
        }),
      ]);
      logCarerStartupFirestore({
        collection: 'users',
        path,
        reason: 'payment_fields_enrich',
        durationMs: Date.now() - startedAt,
        ok: true,
      });
      if (!snap.exists()) {
        return;
      }
      const userData = snap.data() as {
        paymentQrUrl?: string;
        paymentQrPublicId?: string;
        paymentDetails?: string;
        cashBoxNpr?: number;
        automationAgentId?: string | null;
      };
      const linkedAgent = String(userData.automationAgentId || '').trim() || null;
      setCarerIdentity((prev) =>
        prev
          ? {
              ...prev,
              paymentQrUrl: userData.paymentQrUrl?.trim() || prev.paymentQrUrl,
              paymentQrPublicId: userData.paymentQrPublicId?.trim() || prev.paymentQrPublicId,
              paymentDetails: userData.paymentDetails?.trim() || prev.paymentDetails,
              automationAgentId: linkedAgent || prev.automationAgentId,
            }
          : prev
      );
      if (userData.paymentQrUrl?.trim()) {
        setPaymentQrUrl(userData.paymentQrUrl.trim());
      }
      if (userData.paymentQrPublicId?.trim()) {
        setPaymentQrPublicId(userData.paymentQrPublicId.trim());
      }
      if (userData.paymentDetails?.trim()) {
        setPaymentDetails(userData.paymentDetails.trim());
      }
      if (Number.isFinite(Number(userData.cashBoxNpr))) {
        setCashBoxNpr(Number(userData.cashBoxNpr));
      }
      if (linkedAgent) {
        setAgentInputDraft(linkedAgent);
      }
    } catch (error) {
      logCarerStartupFirestore({
        collection: 'users',
        path,
        reason: 'payment_fields_enrich',
        durationMs: Date.now() - startedAt,
        ok: false,
        error_code: firestoreErrorCode(error) || (error instanceof Error ? error.message : 'enrich_failed'),
      });
    }
  }

  function applyCarerProfileToState(
    profile: {
      uid: string;
      username: string;
      automationAgentId?: string | null;
      paymentQrUrl?: string;
      paymentQrPublicId?: string;
      paymentDetails?: string;
      cashBoxNpr?: number;
    },
    firebaseUid: string
  ) {
    const linkedAgent = String(profile.automationAgentId || '').trim() || null;
    setCarerIdentity({
      uid: firebaseUid,
      username: profile.username?.trim() || 'Carer',
      paymentQrUrl: profile.paymentQrUrl?.trim() || '',
      paymentQrPublicId: profile.paymentQrPublicId?.trim() || '',
      paymentDetails: profile.paymentDetails?.trim() || '',
      automationAgentId: linkedAgent,
    });
    setAgentInputDraft(linkedAgent || '');
    setPaymentQrUrl(profile.paymentQrUrl?.trim() || '');
    setPaymentQrPublicId(profile.paymentQrPublicId?.trim() || '');
    setPaymentDetails(profile.paymentDetails?.trim() || '');
    setCashBoxNpr(Number(profile.cashBoxNpr || 0));
  }

  async function loadCarerProfileFromFirestoreFallback(firebaseUser: User) {
    const startedAt = Date.now();
    const path = `users/${firebaseUser.uid}`;
    const userSnap = await getDoc(doc(db, 'users', firebaseUser.uid));
    logCarerStartupFirestore({
      collection: 'users',
      path,
      reason: 'initialize_page_profile',
      durationMs: Date.now() - startedAt,
      ok: userSnap.exists(),
      error_code: userSnap.exists() ? null : 'profile_not_found',
    });

    if (!userSnap.exists()) {
      throw new Error('Carer profile not found.');
    }

    const userData = userSnap.data() as {
      username?: string;
      paymentQrUrl?: string;
      paymentQrPublicId?: string;
      paymentDetails?: string;
      cashBoxNpr?: number;
      automationAgentId?: string | null;
    };
    const resolvedCoadminUid = await getCurrentUserCoadminUid();
    applyCarerProfileToState(
      {
        uid: firebaseUser.uid,
        username: userData.username?.trim() || 'Carer',
        automationAgentId: userData.automationAgentId,
        paymentQrUrl: userData.paymentQrUrl,
        paymentQrPublicId: userData.paymentQrPublicId,
        paymentDetails: userData.paymentDetails,
        cashBoxNpr: userData.cashBoxNpr,
      },
      firebaseUser.uid
    );
    setCoadminUid(resolvedCoadminUid);

    const baseDataStartedAt = Date.now();
    await refreshPageData(true, resolvedCoadminUid);
    logCarerPageStartup({
      stage: 'base_data_done',
      ok: true,
      uid: firebaseUser.uid,
      role: 'carer',
      durationMs: Date.now() - baseDataStartedAt,
      reason: 'firebase_fallback',
    });
  }

  async function initializePageFromAppSession(sessionUser: SessionUser) {
    if (pageInitInFlightUidRef.current === sessionUser.uid) {
      return;
    }
    pageInitInFlightUidRef.current = sessionUser.uid;

    setBootstrapping(true);
    setErrorMessage('');
    setAutomationTokenWarning('');

    try {
      const profileStartedAt = Date.now();
      const profile = await fetchCarerDashboardProfile();
      const actorUid = sessionUser.uid;

      let resolvedCoadminUid = String(sessionUser.coadminUid || profile?.coadminUid || '').trim();
      if (!resolvedCoadminUid) {
        try {
          resolvedCoadminUid = await getCurrentUserCoadminUid();
        } catch {
          resolvedCoadminUid = '';
        }
      }
      if (!resolvedCoadminUid) {
        throw new Error('No coadmin assigned to this user.');
      }

      const identityProfile = profile ?? {
        uid: actorUid,
        username: sessionUser.username || 'Carer',
        automationAgentId: null,
        paymentQrUrl: '',
        paymentQrPublicId: '',
        paymentDetails: '',
        cashBoxNpr: 0,
      };

      applyCarerProfileToState(identityProfile, actorUid);
      setCoadminUid(resolvedCoadminUid);

      logCarerPageStartup({
        stage: 'actor_ready',
        ok: true,
        uid: actorUid,
        role: 'carer',
        durationMs: Date.now() - profileStartedAt,
        extra: {
          coadminUid: resolvedCoadminUid,
          profile_source: profile?.source || 'session_only',
        },
      });

      void enrichCarerProfileFromFirestoreOptional(actorUid);

      const linkedAgent = String(identityProfile.automationAgentId || '').trim();
      if (linkedAgent) {
        void refreshAutoTickBrowserToken(linkedAgent);
      }

      await refreshPageData(true, resolvedCoadminUid);
    } catch (error) {
      logCarerPageStartup({
        stage: 'base_data_done',
        ok: false,
        uid: sessionUser.uid,
        role: 'carer',
        reason: error instanceof Error ? error.message : 'initialize_failed',
        firestore_code: firestoreErrorCode(error),
      });
      reportCarerUiError('page_init', error, setErrorMessage, 'Failed to load the carer page.', {
        file: 'app/carer/page.tsx',
        operation: 'initializeCarerPage',
      });
    } finally {
      pageInitInFlightUidRef.current = null;
      logCarerPageStartup({
        stage: 'bootstrap_complete',
        ok: true,
        uid: sessionUser.uid,
        role: 'carer',
        durationMs: Date.now() - startupMountStartedAtRef.current,
        extra: {
          path: 'app_session',
          refreshing_still_blocking: false,
        },
      });
      setBootstrapping(false);
    }
  }

  async function runBackgroundCarerTaskSync(nextCoadminUid: string, baseData: CarerBaseData) {
    if (isClientSqlReadMode()) {
      console.info('[CARER_BACKGROUND_SYNC_SKIPPED]', {
        coadminUid: nextCoadminUid,
        carerUid: carerIdentity?.uid ?? null,
        sqlMode: true,
        reason: 'sql_task_listener_authoritative',
      });
      return;
    }

    const taskSyncStartedAt = Date.now();
    setTaskSyncRunning(true);
    setTaskSyncError(null);

    logCarerPageTaskSync({
      stage: 'start',
      coadminUid: nextCoadminUid,
    });
    logCarerPageStartup({
      stage: 'task_sync_start',
      ok: true,
      uid: carerIdentity?.uid ?? null,
      role: 'carer',
      extra: {
        coadminUid: nextCoadminUid,
        task_sync_background: true,
        blocks_refreshing_spinner: false,
        carer_tasks_sql_read: CARER_TASKS_SQL_READ_ENABLED,
        automation_jobs_sql_read: AUTOMATION_JOBS_SQL_READ_ENABLED,
      },
    });

    try {
      await releaseExpiredCarerTasks(nextCoadminUid);
      const synced = await syncCarerTasksForCoadmin(nextCoadminUid, baseData);

      setPendingRequests(sortByNewest(synced.pendingRequests));
      setTaskSyncLastDoneAt(Date.now());
      setTaskSyncError(null);

      const durationMs = Date.now() - taskSyncStartedAt;
      logCarerPageTaskSync({
        stage: 'done',
        ok: true,
        durationMs,
        coadminUid: nextCoadminUid,
        pendingRequestsCount: synced.pendingRequests.length,
      });
      logCarerPageStartup({
        stage: 'task_sync_done',
        ok: true,
        uid: carerIdentity?.uid ?? null,
        role: 'carer',
        durationMs,
        extra: {
          pendingRequestsCount: synced.pendingRequests.length,
          task_sync_background: true,
          blocks_refreshing_spinner: false,
        },
      });

      console.info(
        `[CARER_BOOTSTRAP_TIMING] stage='task_sync_done' durationMs=${durationMs}`
      );
    } catch (error) {
      const durationMs = Date.now() - taskSyncStartedAt;
      const quotaExhausted = isFirestoreQuotaExhausted(error);
      const message = error instanceof Error ? error.message : 'task_sync_failed';
      const firestoreCode =
        firestoreErrorCode(error) ||
        (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'number'
          ? (error as { code: number }).code
          : null);

      if (shouldSuppressCarerFirestoreBlockedUiError(error)) {
        logCarerFirestoreBlockedSuppressed({
          feature: 'task_sync',
          file: 'features/games/carerTasks.ts',
          operation: 'syncCarerTasksForCoadmin',
        });
      } else {
        setTaskSyncError(
          quotaExhausted
            ? 'Task sync skipped because Firebase quota is exhausted'
            : message
        );
      }

      logCarerPageTaskSync({
        stage: 'error',
        ok: false,
        durationMs,
        error_code: quotaExhausted ? 'RESOURCE_EXHAUSTED' : 'task_sync_failed',
        firestore_code: firestoreCode,
        coadminUid: nextCoadminUid,
      });
      logCarerPageStartup({
        stage: 'task_sync_done',
        ok: false,
        uid: carerIdentity?.uid ?? null,
        role: 'carer',
        durationMs,
        reason: message,
        error_code: quotaExhausted ? 'RESOURCE_EXHAUSTED' : 'task_sync_failed',
        firestore_code: typeof firestoreCode === 'number' ? String(firestoreCode) : firestoreCode,
        extra: {
          task_sync_background: true,
          blocks_refreshing_spinner: false,
        },
      });
      console.error(
        `[CARER_BOOTSTRAP_TIMING] stage='task_sync_failed' durationMs=${durationMs}`,
        error
      );
    } finally {
      setTaskSyncRunning(false);
    }
  }

  async function initializePageFromFirebase(firebaseUser: User) {
    if (pageInitInFlightUidRef.current === firebaseUser.uid) {
      return;
    }
    pageInitInFlightUidRef.current = firebaseUser.uid;

    setBootstrapping(true);
    setErrorMessage('');
    setAutomationTokenWarning('');

    try {
      await loadCarerProfileFromFirestoreFallback(firebaseUser);
      logCarerPageStartup({
        stage: 'actor_ready',
        ok: true,
        uid: firebaseUser.uid,
        role: 'carer',
        reason: 'firebase_fallback',
      });
    } catch (error) {
      logCarerPageStartup({
        stage: 'actor_ready',
        ok: false,
        uid: firebaseUser.uid,
        role: 'carer',
        reason: error instanceof Error ? error.message : 'initialize_failed',
        firestore_code: firestoreErrorCode(error),
      });
      reportCarerUiError('page_init', error, setErrorMessage, 'Failed to load the carer page.', {
        file: 'app/carer/page.tsx',
        operation: 'initializeCarerPage',
      });
    } finally {
      pageInitInFlightUidRef.current = null;
      logCarerPageStartup({
        stage: 'bootstrap_complete',
        ok: true,
        uid: firebaseUser.uid,
        role: 'carer',
        durationMs: Date.now() - startupMountStartedAtRef.current,
        extra: {
          path: 'firebase',
          refreshing_still_blocking: false,
        },
      });
      setBootstrapping(false);
    }
  }

  async function refreshPageData(showLoader = true, nextCoadminUid = coadminUid) {
    if (!nextCoadminUid) {
      return;
    }
    if (baseDataRefreshInFlightRef.current) {
      console.info('[POLLING_DISABLED]', {
        route: '/api/carer/base-data',
        replacement: 'single_flight_skip_duplicate_refresh',
        trigger: 'refreshPageData',
      });
      return;
    }

    console.info('[POLLING_INVENTORY]', {
      route: '/api/carer/base-data',
      intervalMs: 0,
      reason: showLoader ? 'initial_or_manual_page_refresh' : 'action_requested_refresh',
      trigger: 'refreshPageData',
      canUseSSE: true,
      required: showLoader ? 'initial_load_and_manual_refresh' : 'not_required_for_live_task_updates',
    });

    logCarerAction({
      action: 'refresh_page_data',
      file: 'app/carer/page.tsx',
      function: 'refreshPageData',
      route: '/api/carer/base-data',
      method: 'GET',
      carerUid: carerIdentity?.uid ?? null,
      coadminUid: nextCoadminUid,
      role: 'carer',
      authHeaderMode: 'sql_api_read',
    });

    if (showLoader) {
      setRefreshing(true);
    }
    baseDataRefreshInFlightRef.current = true;

    const bootstrapStartedAt = Date.now();
    logCarerPageStartup({
      stage: 'base_data_start',
      ok: true,
      uid: carerIdentity?.uid ?? null,
      role: 'carer',
      extra: { coadminUid: nextCoadminUid },
    });

    try {
      const baseData = await fetchCarerBaseDataForCoadmin(nextCoadminUid);

      setPlayers(sortByNewest(baseData.players));
      setGameOptions(sortByNewest(baseData.games));
      setAllPlayerLogins(sortByNewest(baseData.logins));
      setErrorMessage('');

      logCarerPageStartup({
        stage: 'base_data_done',
        ok: true,
        uid: carerIdentity?.uid ?? null,
        role: 'carer',
        durationMs: Date.now() - bootstrapStartedAt,
        extra: {
          playersCount: baseData.players.length,
          gameOptionsCount: baseData.games.length,
          playerGameLoginsCount: baseData.logins.length,
        },
      });

      console.info(
        `[CARER_BOOTSTRAP_TIMING] stage='base_data_loaded' playersCount=${baseData.players.length} gameOptionsCount=${baseData.games.length} playerGameLoginsCount=${baseData.logins.length} durationMs=${Date.now() - bootstrapStartedAt}`
      );

      if (showLoader) {
        setRefreshing(false);
      }

      logCarerPageStartup({
        stage: 'ready_after_base_data',
        ok: true,
        uid: carerIdentity?.uid ?? null,
        role: 'carer',
        durationMs: Date.now() - bootstrapStartedAt,
        extra: {
          refreshing: false,
          task_sync_background: true,
        },
      });

      void runBackgroundCarerTaskSync(nextCoadminUid, baseData);
    } catch (error) {
      logCarerPageStartup({
        stage: 'base_data_done',
        ok: false,
        uid: carerIdentity?.uid ?? null,
        role: 'carer',
        durationMs: Date.now() - bootstrapStartedAt,
        reason: error instanceof Error ? error.message : 'base_data_failed',
      });
      reportCarerActionError(
        'refresh_page_data',
        error,
        setErrorMessage,
        'Failed to refresh carer data.',
        {
          route: '/api/carer/base-data',
          method: 'GET',
          carerUid: carerIdentity?.uid ?? null,
          coadminUid: nextCoadminUid,
          allowedRoles: ['admin', 'coadmin', 'staff', 'carer'],
          authPath: 'app_session_sql',
        }
      );

      if (showLoader) {
        setRefreshing(false);
      }
    } finally {
      baseDataRefreshInFlightRef.current = false;
    }
  }

  async function refreshPageDataAfterMutation(reason: string, nextCoadminUid = coadminUid) {
    if (isClientSqlReadMode()) {
      console.info('[POLLING_DISABLED]', {
        route: '/api/carer/base-data',
        replacement: 'task_and_job_sse_plus_local_state',
        trigger: reason,
      });
      return;
    }
    await refreshPageData(false, nextCoadminUid);
  }

  async function persistCarerAutomationEnabled(
    enabled: boolean,
    source: 'dashboard' | 'tasks_header'
  ) {
    if (!carerIdentity?.uid || !coadminUid) {
      setErrorMessage('Coadmin scope is not ready yet.');
      return;
    }

    logCarerAction({
      action: enabled ? 'start_automation' : 'stop_automation',
      file: 'app/carer/page.tsx',
      function: 'persistCarerAutomationEnabled',
      route: '/api/carer/automation-auto-state',
      method: 'POST',
      carerUid: carerIdentity.uid,
      coadminUid,
      role: 'carer',
      authHeaderMode: 'app_session_sql',
    });
    if (enabled) {
      console.info('[START_AUTOMATION_CLICK]', {
        source,
        carerUid: carerIdentity.uid,
        coadminUid,
        previousEnabled: autoAutomationEnabled,
      });
      console.info('[START_AUTOMATION_ENABLE_REQUEST]', {
        source,
        carerUid: carerIdentity.uid,
        coadminUid,
        enabled: true,
      });
    }

    setErrorMessage('');
    try {
      await setCarerAutomationAutoEnabled({
        carerUid: carerIdentity.uid,
        coadminUid,
        enabled,
      });
      setAutomationAutoStateDoc((previous) => ({
        ...(previous || {}),
        enabled,
      }));
      if (enabled) {
        console.info('[START_AUTOMATION_ENABLE_SUCCESS]', {
          source,
          carerUid: carerIdentity.uid,
          coadminUid,
          enabled: true,
        });
        setAutoDrainRequestId((current) => current + 1);
      } else {
        window.setTimeout(() => {
          autoAutomationEnabledRef.current = false;
        }, 0);
      }
      setNoticeMessage(
        enabled
          ? source === 'dashboard'
            ? 'Claiming pending task...'
            : 'Claiming pending task...'
          : 'Auto automation stopped.'
      );
      if (enabled && source === 'dashboard') {
        setActiveView('tasks');
        void refreshPageDataAfterMutation('start_automation_dashboard');
      }
    } catch (error) {
      reportCarerActionError(
        enabled ? 'start_automation' : 'stop_automation',
        error,
        setErrorMessage,
        enabled ? 'Failed to start automation.' : 'Failed to update automation.',
        {
          route: '/api/carer/automation-auto-state',
          method: 'POST',
          carerUid: carerIdentity.uid,
          coadminUid,
          allowedRoles: ['carer'],
          authPath: 'app_session_sql',
        }
      );
    }
  }

  function buildAutomationAgentEnvFileSnippet() {
    if (!carerIdentity) {
      return '';
    }
    const agentForEnv =
      String(carerIdentity.automationAgentId || '').trim() || String(agentInputDraft || '').trim();
    return [
      '# carer-agent/.env — use the same AGENT_ID you saved in the carer panel.',
      `CARER_UID=${carerIdentity.uid}`,
      `AGENT_ID=${agentForEnv || 'your_agent_id_here'}`,
      'FIREBASE_SERVICE_ACCOUNT_PATH=./serviceAccount.json',
    ].join('\n');
  }

  async function handleSaveAutomationAgentConnection() {
    if (!carerIdentity) {
      return;
    }
    setAgentSaving(true);
    setAgentPanelError('');
    setAgentPanelNotice('');
    const check = validateAutomationAgentId(agentInputDraft);
    if (!check.valid) {
      setAgentPanelError(check.error || 'Invalid agent ID');
      setAgentSaving(false);
      return;
    }
    try {
      await setCarerAutomationAgent(carerIdentity.uid, agentInputDraft);
      const fresh = await getCarerAutomationAgent(carerIdentity.uid);
      setCarerIdentity((prev) =>
        prev ? { ...prev, automationAgentId: fresh.automationAgentId } : prev
      );
      setAgentInputDraft(fresh.automationAgentId || '');
      setAgentPanelNotice('Saved successfully');
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : 'Failed to save agent connection.';
      if (shouldSuppressCarerFirestoreBlockedUiError(error)) {
        logCarerFirestoreBlockedSuppressed({
          feature: 'link_automation_agent',
          file: 'features/automation/carerAutomationAgent.ts',
          operation: 'setCarerAutomationAgent',
        });
      } else if (
        rawMessage.toLowerCase().includes('not authenticated') ||
        rawMessage.toLowerCase().includes('not signed in')
      ) {
        setAgentPanelError('Session changed. Please refresh.');
      } else {
        setAgentPanelError(rawMessage);
      }
    } finally {
      setAgentSaving(false);
    }
  }

  async function handleDisconnectAutomationAgent() {
    if (!carerIdentity) {
      return;
    }
    const ok = window.confirm(
      'Disconnect this automation agent? New tasks will stay manual until you connect again.'
    );
    if (!ok) {
      return;
    }
    setAgentSaving(true);
    setAgentPanelError('');
    setAgentPanelNotice('');
    try {
      await disconnectCarerAutomationAgent(carerIdentity.uid);
      setCarerIdentity((prev) => (prev ? { ...prev, automationAgentId: null } : prev));
      setAgentInputDraft('');
      setAgentPanelNotice('Agent disconnected.');
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : 'Failed to disconnect agent.';
      if (shouldSuppressCarerFirestoreBlockedUiError(error)) {
        logCarerFirestoreBlockedSuppressed({
          feature: 'disconnect_automation_agent',
          file: 'features/automation/carerAutomationAgent.ts',
          operation: 'disconnectCarerAutomationAgent',
        });
      } else if (
        rawMessage.toLowerCase().includes('not authenticated') ||
        rawMessage.toLowerCase().includes('not signed in')
      ) {
        setAgentPanelError('Session changed. Please refresh.');
      } else {
        setAgentPanelError(rawMessage);
      }
    } finally {
      setAgentSaving(false);
    }
  }

  function warmupStatusLabel() {
    if (browserWarmupStatus === 'warming') return 'Warming...';
    if (browserWarmupStatus === 'ready') return 'Ready';
    if (browserWarmupStatus === 'partial_ready') return 'Partial ready';
    if (browserWarmupStatus === 'failed') return 'Failed';
    return 'Not warmed';
  }

  function normalizeWarmupGameName(value: string) {
    return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  function buildWarmupLoginUrl(login: GameLogin) {
    return String(login.backendUrl || login.siteUrl || login.frontendUrl || '').trim();
  }

  async function handleWarmUpBrowser() {
    if (!carerIdentity?.uid || !coadminUid) {
      setBrowserWarmupStatus('failed');
      setBrowserWarmupMessage('Coadmin scope is not ready yet.');
      return;
    }
    const agentId =
      String(carerIdentity.automationAgentId || '').trim() || String(agentInputDraft || '').trim();
    const agentCheck = validateAutomationAgentId(agentId);
    if (!agentCheck.valid || !agentCheck.normalized) {
      setBrowserWarmupStatus('failed');
      setBrowserWarmupMessage('Connect automation agent first.');
      return;
    }

    setBrowserWarmupStatus('warming');
    setBrowserWarmupMessage('Warming...');
    setBrowserWarmupGames({});
    try {
      const byGame = new Map(
        gameOptions.map((login) => [normalizeWarmupGameName(login.gameName), login])
      );
      const games = WARMUP_GAME_NAMES.flatMap((gameName) => {
        const login = byGame.get(normalizeWarmupGameName(gameName));
        return login
          ? {
              gameName,
              credentialUsername: String(login.username || '').trim(),
              credentialPassword: String(login.password || ''),
              loginUrl: buildWarmupLoginUrl(login),
            }
          : [];
      }).filter((game) => Boolean(game.credentialUsername && game.credentialPassword));

      if (games.length === 0) {
        setBrowserWarmupStatus('failed');
        setBrowserWarmupMessage('No game credentials found.');
        return;
      }

      const response = await fetch(LOCAL_WARMUP_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-carer-agent-id': agentCheck.normalized,
        },
        body: JSON.stringify({
          carerUid: carerIdentity.uid,
          agentId: agentCheck.normalized,
          games,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as WarmupAgentResponse;

      if (response.status === 403 || String(payload.error || '').trim() === 'agent_auth_failed') {
        throw new Error('Agent authentication failed. Check agent ID matches carer-agent .env.');
      }
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || `Warmup failed (${response.status}).`);
      }

      const postStatus = String(payload.status || '').trim().toLowerCase();
      const warmupId = String(payload.warmupId || '').trim();
      let finalPayload = payload;

      if (
        (postStatus === 'started' || postStatus === 'already_running') &&
        (payload.statusUrl || LOCAL_WARMUP_STATUS_URL)
      ) {
        console.info('[WARMUP_BROWSER_UI] started warmupId=%s status=%s', warmupId || '-', postStatus || '-');
        setBrowserWarmupStatus('warming');
        setBrowserWarmupMessage('Warming...');
        finalPayload = await pollWarmupBrowserStatus({
          statusUrl: resolveWarmupStatusUrl(payload.statusUrl),
          agentId: agentCheck.normalized,
          warmupId: warmupId || undefined,
        });
      } else if (isWarmupInProgressStatus(postStatus)) {
        console.info('[WARMUP_BROWSER_UI] started warmupId=%s status=%s', warmupId || '-', postStatus || '-');
        setBrowserWarmupStatus('warming');
        setBrowserWarmupMessage('Warming...');
        finalPayload = await pollWarmupBrowserStatus({
          statusUrl: LOCAL_WARMUP_STATUS_URL,
          agentId: agentCheck.normalized,
          warmupId: warmupId || undefined,
        });
      }

      const finalStatus = String(finalPayload.status || '').trim().toLowerCase();
      const readyByGame = finalPayload.games || {};
      const summary = applyWarmupGamesToUi(
        readyByGame,
        setBrowserWarmupGames,
        setBrowserWarmupStatus,
        setBrowserWarmupMessage
      );

      if (finalStatus === 'failed' || summary.outcome === 'failed') {
        const reason =
          String(finalPayload.reason || finalPayload.error || '').trim() || 'warmup_failed';
        console.info(
          '[WARMUP_BROWSER_UI] failed reason=%s total=%s ok=%s',
          reason,
          summary.total,
          summary.readyCount
        );
        if (summary.total === 0) {
          setBrowserWarmupMessage(reason.replace(/_/g, ' ') || 'Warmup failed.');
        }
      } else {
        console.info(
          '[WARMUP_BROWSER_UI] completed total=%s ok=%s status=%s',
          summary.total,
          summary.readyCount,
          finalStatus || postStatus || '-'
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Warmup failed.';
      console.info('[WARMUP_BROWSER_UI] failed reason=%s', message);
      setBrowserWarmupStatus('failed');
      if (message.includes('Failed to fetch') || message.includes('NetworkError')) {
        setBrowserWarmupMessage('Carer agent is not reachable. Start carer-agent on this machine.');
      } else {
        setBrowserWarmupMessage(message);
      }
    }
  }

  async function handleCopyAutomationAgentEnvSnippet() {
    const text = buildAutomationAgentEnvFileSnippet();
    if (!text) {
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setAgentPanelNotice('Copied .env snippet to clipboard');
    } catch {
      setAgentPanelError('Could not copy to clipboard.');
    }
  }

  function resetUsernameForm() {
    setEditingLogin(null);
    setActiveUsernameTask(null);
    setGameName('');
    setGameUsername('');
    setGamePassword('');
  }

  function playPendingNotificationSound() {
    const audio = new Audio('/urgency-sound.mp3');
    audio.volume = 0.9;
    void audio.play().catch(() => undefined);
  }

  async function handleUsernameSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!selectedPlayer) {
      setErrorMessage('Select a player first.');
      return;
    }

    if (!coadminUid) {
      setErrorMessage('Coadmin scope is still loading. Please try again.');
      return;
    }

    if (!gameName.trim() || !gameUsername.trim() || !gamePassword.trim()) {
      setErrorMessage('Player, game, username, and password are all required.');
      return;
    }

    setSavingUsername(true);
    setErrorMessage('');
    setNoticeMessage('');

    try {
      const loginToUpdate = editingLogin || existingLoginForSelectedGame;
      const matchingCoadminGame =
        gameOptions.find(
          (game) =>
            normalizeGameName(game.gameName || '') === normalizeGameName(gameName.trim())
        ) || null;
      const resolvedFrontendUrl = String(matchingCoadminGame?.frontendUrl || '').trim();
      const activeTaskType = activeUsernameTask
        ? (getTaskTypeKey(activeUsernameTask) as
            | 'reset_password'
            | 'recreate_username'
            | 'create_game_username')
        : 'create_game_username';

      if (activeTaskType === 'reset_password' && activeUsernameTask) {
        const sqlMode = isClientSqlReadMode();
        const hasAppSessionId = Boolean(getLocalAppSessionId());
        console.info('[CARER_RESET_PASSWORD_CLICK]', {
          taskId: activeUsernameTask.id,
          playerUid: selectedPlayer.uid,
          playerGameLoginId: (loginToUpdate || existingLoginForSelectedGame)?.id || null,
          gameName: gameName.trim(),
          carerUid: carerIdentity?.uid ?? null,
          coadminUid,
          sqlMode,
          hasAppSessionId,
          source: 'carer_page_handleUsernameSubmit',
        });
        console.info('[CARER_RESET_PASSWORD_AUTH_AUDIT]', {
          file: 'app/carer/page.tsx',
          function: 'handleUsernameSubmit',
          authSource: sqlMode ? 'app_session_sql' : 'firebase_token',
          hasAppSessionId,
          firebaseCurrentUserUid: null,
          expectedCarerUid: carerIdentity?.uid ?? null,
          firebaseAttempted: !sqlMode,
          reason: 'reset_password_submit',
        });
      }

      let savedLoginId = loginToUpdate?.id || '';
      const savedLoginFields = {
        gameName: gameName.trim(),
        gameUsername: gameUsername.trim(),
        gamePassword,
        siteUrl: resolvedFrontendUrl,
        frontendUrl: resolvedFrontendUrl,
      };

      if (loginToUpdate) {
        await updatePlayerGameLogin(loginToUpdate.id, {
          ...savedLoginFields,
        });
        setNoticeMessage('Game username updated successfully.');
      } else {
        savedLoginId = await createPlayerGameLogin({
          playerUid: selectedPlayer.uid,
          playerUsername: selectedPlayer.username || 'Unknown player',
          ...savedLoginFields,
          coadminUid,
        }) || '';
        setNoticeMessage('Game username created successfully.');
      }

      if (savedLoginId) {
        setAllPlayerLogins((previous) => {
          const nextLogin: PlayerGameLogin = {
            id: savedLoginId,
            playerUid: selectedPlayer.uid,
            playerUsername: selectedPlayer.username || 'Unknown player',
            gameName: savedLoginFields.gameName,
            gameUsername: savedLoginFields.gameUsername,
            gamePassword: savedLoginFields.gamePassword,
            siteUrl: savedLoginFields.siteUrl,
            frontendUrl: savedLoginFields.frontendUrl,
            coadminUid,
            createdBy: coadminUid,
            createdAt: loginToUpdate?.createdAt || new Date(),
          };
          return sortByNewest([
            nextLogin,
            ...previous.filter((login) => login.id !== savedLoginId),
          ]);
        });
      }

      const rewardSummary = await completeUsernameTaskForPlayerGame(
        coadminUid,
        selectedPlayer.uid,
        gameName.trim(),
        {
          taskType: activeTaskType,
          taskId: activeUsernameTask?.id || null,
          playerGameLoginId: (loginToUpdate || existingLoginForSelectedGame)?.id || null,
          carerUid: carerIdentity?.uid ?? null,
          source: 'carer_page_handleUsernameSubmit',
        }
      );

      if (rewardSummary.totalAwardNpr > 0) {
        setCashBoxNpr((previous) => previous + rewardSummary.totalAwardNpr);
        setNoticeMessage(
          `Username task completed. Reward +${formatNpr(
            rewardSummary.totalAwardNpr
          )} added to Cash Box.`
        );
      }
      await refreshPageDataAfterMutation('username_submit', coadminUid);
      resetUsernameForm();
    } catch (error) {
      reportCarerActionError(
        'save_username',
        error,
        setErrorMessage,
        'Failed to save the username.'
      );
    } finally {
      setSavingUsername(false);
    }
  }

  async function handleStartTask(task: CarerTask) {
    logCarerAction({
      action: 'start_task',
      file: 'app/carer/page.tsx',
      function: 'handleStartTask',
      route: isClientSqlReadMode() ? '/api/carer/tasks/claim' : null,
      method: isClientSqlReadMode() ? 'POST' : null,
      carerUid: carerIdentity?.uid ?? null,
      coadminUid,
      role: 'carer',
      authHeaderMode: isClientSqlReadMode() ? 'sql_api_write' : 'firestore_transaction',
    });
    const clickStartedAt = Date.now();
    console.info('[START_TIMING] clickStart at=%s taskId=%s', new Date(clickStartedAt).toISOString(), task.id);
    const isTaskLoading = automationLoadingTaskId === task.id;
    console.info('[START_TASK] before task visible status=%s', task.status || null);
    const disabledReason = getStartTaskDisabledReason(task, {
      isLoading: isTaskLoading,
      automationStatus: automationStatusByTaskId[task.id] || null,
      hasFreshTaskClaim: isFreshActiveTaskClaim(task, Boolean(freshAutomationJobByTaskId[task.id])),
      hasFreshRunnableJob:
        Boolean(freshAutomationJobByTaskId[task.id]) &&
        isActiveAutomationUiStatus(automationStatusByTaskId[task.id] || null),
    });
    const isStartInFlight = startTaskInFlightIdsRef.current.has(task.id);
    const canStart = !isTaskLoading && !isStartInFlight;
    console.info('[CARER_UI] start clicked taskId', {
      taskId: task.id,
      canStart,
      cachedDisabledReason: disabledReason || null,
      disabledReason: isStartInFlight ? 'in_flight' : isTaskLoading ? 'queueing' : null,
      existingAutomationJobId: task.automationJobId || null,
      claimedByUid: task.claimedByUid || null,
      claimedStatus: task.claimedStatus || null,
      status: task.status || null,
    });
    if (!canStart) {
      return;
    }
    if (disabledReason) {
      console.info('[CARER_UI] cached start block ignored pending server verification', {
        taskId: task.id,
        cachedDisabledReason: disabledReason,
        cachedAutomationJobId: task.automationJobId || null,
        cachedAutomationStatus: task.automationStatus || automationStatusByTaskId[task.id] || null,
      });
    }
    startTaskInFlightIdsRef.current.add(task.id);
    if (!carerIdentity) {
      console.warn('[CARER_UI] canStart=False blocked-no-carer-identity', {
        taskId: task.id,
      });
      startTaskInFlightIdsRef.current.delete(task.id);
      setErrorMessage('Carer profile not ready yet. Please try again.');
      return;
    }

    setAutomationLoadingTaskId(task.id);
    setErrorMessage('');
    setNoticeMessage('');

    try {
      if (isClientSqlReadMode()) {
        console.info('[CARER_START_TASK_SQL_ONLY]', {
          taskId: task.id,
          carerUid: carerIdentity.uid,
          coadminUid,
          firestoreAttempted: false,
        });
      } else {
        getClientDb('handleStartTask');
      }
      console.info('[CARER_UI] canStart=True start-task', {
        taskId: task.id,
      });
      const loginForTask =
        allPlayerLogins.find(
          (login) =>
            login.playerUid === task.playerUid &&
            normalizeGameName(login.gameName || '') ===
              normalizeGameName(task.gameName || '')
        ) || null;
      const resolvedCurrentUsername =
        String(
          loginForTask?.gameUsername ||
            (task as { currentUsername?: string | null }).currentUsername ||
            (task as { gameAccountUsername?: string | null }).gameAccountUsername ||
            ''
        ).trim() || null;
      const relatedCoadminGame =
        gameOptions.find(
          (game) =>
            normalizeGameName(game.gameName || '') === normalizeGameName(task.gameName || '')
        ) || null;

      const claimStartedAt = Date.now();
      console.info('[START_TIMING] server claim start at=%s taskId=%s', new Date(claimStartedAt).toISOString(), task.id);
      const claimResult = await claimTaskAndCreateJob({
        taskId: task.id,
        currentUsername: resolvedCurrentUsername,
        carerName: carerIdentity.username,
        gameLoginDetails: relatedCoadminGame
          ? {
              username: relatedCoadminGame.username,
              password: relatedCoadminGame.password,
              backendUrl: relatedCoadminGame.backendUrl || relatedCoadminGame.siteUrl || '',
              frontendUrl: relatedCoadminGame.frontendUrl || '',
              siteUrl: relatedCoadminGame.siteUrl || '',
            }
          : null,
      });
      console.info(
        '[START_TIMING] server write completed at=%s durationMs=%s taskId=%s status=%s jobId=%s',
        new Date().toISOString(),
        Date.now() - claimStartedAt,
        task.id,
        claimResult.status,
        claimResult.jobId
      );
      console.info('[START_TASK] commit success jobId=%s', claimResult.jobId || null);
      setPendingAutomationResetTaskIds((previous) => {
        if (!previous[task.id]) return previous;
        const next = { ...previous };
        delete next[task.id];
        return next;
      });

      setAutomationStatusByTaskId((previous) => ({
        ...previous,
        [task.id]: claimResult.status === 'running' ? 'running' : 'waiting',
      }));
      console.info('[START_TIMING] ui local state updated status=%s taskId=%s automationStatus=%s durationSinceClickMs=%s', 'in_progress', task.id, claimResult.status === 'running' ? 'running' : 'waiting', Date.now() - clickStartedAt);
      if (isUsernameWorkflowTask(task)) {
        setLocalAutomationProcessingByTaskId((previous) => ({
          ...previous,
          [task.id]: Date.now() + CREATE_USERNAME_UI_GRACE_MS,
        }));
      }
      console.info('[CARER_UI] start-task success', {
        taskId: task.id,
        queuedStatus: claimResult.status,
        reusedExistingJob: claimResult.reusedExistingJob,
        createdAutomationJobId: claimResult.jobId,
      });
      await refreshPageDataAfterMutation('start_task_success');
      setNoticeMessage(
        claimResult.reusedExistingJob
          ? claimResult.status === 'running'
            ? 'Your existing automation job was resumed and is already running.'
            : 'Your existing automation job was resumed.'
          : isUsernameWorkflowTask(task)
            ? 'Task claimed. Username automation is processing in the background.'
            : 'Task claimed and automation job queued.'
      );
    } catch (error) {
      const fallback =
        error instanceof Error ? error.message : 'Failed to queue the task.';
      console.error('[CARER_UI] start-task error', {
        taskId: task.id,
        message: fallback,
      });
      const normalized = fallback.toLowerCase();
      const isConcurrencyIssue =
        normalized.includes('failed-precondition') ||
        normalized.includes('aborted') ||
        normalized.includes('contention') ||
        normalized.includes('updated at the same time');
      if (normalized.includes('resource_exhausted') || normalized.includes('quota exceeded')) {
        if (carerIdentity && coadminUid) {
          try {
            await setCarerAutomationAutoEnabled({
              carerUid: carerIdentity.uid,
              coadminUid,
              enabled: false,
            });
          } catch {
            /* ignore secondary failure while surfacing quota message */
          }
        }
        setErrorMessage(
          'Firestore quota exceeded. Auto automation has been paused to prevent repeated errors.'
        );
        return;
      }
      if (isConcurrencyIssue) {
        console.error('[START_TASK] commit failed code=%s', String((error as { code?: string } | null | undefined)?.code || 'failed-precondition'));
        console.info('[START_TASK] refetch after failed-precondition');
        await refreshPageDataAfterMutation('start_task_concurrency_error');
        if (!isClientSqlReadMode()) {
          try {
            const latestSnap = await getDocFromServer(doc(db, 'carerTasks', task.id));
            console.info('[SERVER_REFETCH] taskId=%s exists=%s status=%s', task.id, latestSnap.exists(), latestSnap.exists() ? String((latestSnap.data() as any).status || '') : null);
          } catch (err) {
            console.error('[SERVER_REFETCH] failed for taskId=%s err=%o', task.id, err);
          }
        }
        console.info('[START_TASK] restoring UI taskId=%s', task.id);
        setErrorMessage('Task was already changed. Please refresh and try again.');
      } else if (fallback === 'Task already claimed' && isClientSqlReadMode()) {
        await refreshPageDataAfterMutation('start_task_already_claimed_sql');
        setErrorMessage(
          'This task was already claimed or changed. The latest state has been refreshed.'
        );
      } else if (fallback === 'Task already claimed') {
        const latestTaskSnap = await getDocFromServer(doc(db, 'carerTasks', task.id));
        console.info('[FIRESTORE] forced server refresh taskId=%s', task.id);
        const latestTask = latestTaskSnap.exists()
          ? (latestTaskSnap.data() as Record<string, unknown>)
          : null;
        const latestAutomationJobId = String(latestTask?.automationJobId || '').trim();
        const latestJobSnaps = await getDocsFromServer(
          query(collection(db, 'automation_jobs'), where('taskId', '==', task.id), limit(10))
        );
        const latestJobs = latestJobSnaps.docs.map((jobSnap) => {
          const job = jobSnap.data() as Record<string, unknown>;
          return {
            jobId: jobSnap.id,
            status: String(job.status || '').trim() || null,
            claimedStatus: String(job.claimedStatus || '').trim() || null,
            updatedAt: job.updatedAt || null,
            lastHeartbeatAt: job.lastHeartbeatAt || null,
            completedAt: job.completedAt || null,
          };
        });
        const activeJobs = latestJobs.filter((job) =>
          ['queued', 'waiting', 'running', 'in_progress', 'processing', 'claimed', 'cancelled_requested'].includes(
            String(job.status || '').trim().toLowerCase()
          )
        );
        console.warn('[CARER_UI] startBlockedByActiveJob', {
          taskId: task.id,
          taskExists: latestTaskSnap.exists(),
          status: latestTask ? String(latestTask.status || '').trim() || null : null,
          claimedStatus: latestTask ? String(latestTask.claimedStatus || '').trim() || null : null,
          claimedByUid: latestTask ? String(latestTask.claimedByUid || '').trim() || null : null,
          assignedCarerUid: latestTask ? String(latestTask.assignedCarerUid || '').trim() || null : null,
          automationStatus: latestTask ? String(latestTask.automationStatus || '').trim() || null : null,
          automationJobId: latestAutomationJobId || null,
          activeJobs,
          latestJobs,
        });
        await refreshPageDataAfterMutation('start_task_already_claimed_firebase');
        if (activeJobs.length > 0) {
          setErrorMessage(
            `This task still has an active automation job (${activeJobs[0].status}). Return it to pending, wait a moment, then try again.`
          );
        } else if (latestTask && String(latestTask.status || '').trim().toLowerCase() !== 'pending') {
          setErrorMessage(
            `This task is currently ${String(latestTask.status || '').trim() || 'not pending'}.`
          );
        } else if (
          latestTask &&
          (String(latestTask.claimedStatus || '').trim() ||
            String(latestTask.claimedByUid || '').trim() ||
            String(latestTask.assignedCarerUid || '').trim() ||
            latestAutomationJobId)
        ) {
          setErrorMessage('This task still has stale claim fields. Move it back to pending once more, then start again.');
        } else {
          setErrorMessage('This task was already claimed, but no active job was found. The latest state has been refreshed.');
        }
      } else if (fallback === 'Task not found') {
        setErrorMessage('This task no longer exists.');
      } else {
        reportCarerUiError('start_task', error, setErrorMessage, fallback, {
          file: 'app/carer/page.tsx',
          operation: 'handleStartTask',
        });
      }
    } finally {
      startTaskInFlightIdsRef.current.delete(task.id);
      setAutomationLoadingTaskId(null);
    }
  }

  async function handleDismissPendingRedeem(task: CarerTask) {
    const requestId = task.requestId?.trim();

    if (!requestId) {
      setErrorMessage('This task has no linked request to dismiss.');
      return;
    }

    if (task.type !== 'redeem') {
      return;
    }

    const ok = window.confirm(
      'Dismiss this redeem request as fake or mistaken? It will be removed from the queue.'
    );

    if (!ok) {
      return;
    }

    setDismissRedeemRequestId(requestId);
    setErrorMessage('');
    setNoticeMessage('');

    try {
      await dismissPendingRedeemAsCarer(requestId);
      console.info('[CARER_DELETE_TASK] requestId=%s', requestId);
      console.info('[CARER_DELETE_TASK] optimisticRemoveTaskId=%s', task.id);
      setTasks((previous) => previous.filter((current) => current.id !== task.id));
      setNoticeMessage('Pending redeem request dismissed.');
      console.info('[CARER_DELETE_TASK] refreshAfterDelete=true');
      await refreshPageDataAfterMutation('dismiss_pending_redeem');
    } catch (error) {
      reportCarerActionError(
        'dismiss_redeem',
        error,
        setErrorMessage,
        'Failed to dismiss redeem request.',
        {
          route: '/api/carer/game-requests/dismiss-redeem',
          method: 'POST',
          carerUid: carerIdentity?.uid ?? null,
          coadminUid,
        }
      );
    } finally {
      setDismissRedeemRequestId(null);
    }
  }

  function applyDismissedRechargeTaskUi(task: CarerTask, requestId: string, reason: string) {
    const wasInProgress = String(task.status || '').trim().toLowerCase() === 'in_progress';
    const wasPending = String(task.status || '').trim().toLowerCase() === 'pending';
    setDismissedRechargeRequestIds((previous) => ({
      ...previous,
      [requestId]: true,
    }));
    setTasks((previous) => previous.filter((current) => current.id !== task.id));
    setAutomationStatusByTaskId((previous) => {
      if (!previous[task.id]) return previous;
      const next = { ...previous };
      delete next[task.id];
      return next;
    });
    setFreshAutomationJobByTaskId((previous) => {
      if (!previous[task.id]) return previous;
      const next = { ...previous };
      delete next[task.id];
      return next;
    });
    setLocalAutomationProcessingByTaskId((previous) => {
      if (!previous[task.id]) return previous;
      const next = { ...previous };
      delete next[task.id];
      return next;
    });
    console.info('[CARER_DISMISS_RECHARGE_UI_UPDATE]', {
      taskId: task.id,
      requestId,
      removedFromInProgress: wasInProgress,
      removedFromPending: wasPending,
      disabledButton: true,
      reason,
    });
  }

  async function handleDismissPendingRecharge(task: CarerTask) {
    const requestId = task.requestId?.trim();

    if (!requestId) {
      setErrorMessage('This task has no linked request to dismiss.');
      return;
    }

    if (task.type !== 'recharge') {
      return;
    }

    if (dismissedRechargeRequestIds[requestId]) {
      applyDismissedRechargeTaskUi(task, requestId, 'already_dismissed_local');
      return;
    }

    if (dismissRechargeRequestId === requestId) {
      return;
    }

    const ok = window.confirm(
      'Dismiss this pending recharge request? It will be removed from the queue.'
    );

    if (!ok) {
      return;
    }

    setDismissRechargeRequestId(requestId);
    setErrorMessage('');
    setNoticeMessage('');

    try {
      const outcome = await dismissPendingRechargeAsCarer(requestId, {
        taskId: task.id,
        taskStatus: task.status,
        amount: typeof task.amount === 'number' ? task.amount : null,
        playerUid: task.playerUid,
      });
      applyDismissedRechargeTaskUi(
        task,
        requestId,
        outcome.duplicate || outcome.alreadyDismissed
          ? 'duplicate_success'
          : 'dismiss_success'
      );
      setNoticeMessage(
        outcome.duplicate || outcome.alreadyDismissed
          ? 'This recharge request was already dismissed.'
          : 'Pending recharge request dismissed.'
      );
    } catch (error) {
      reportCarerActionError(
        'dismiss_recharge',
        error,
        setErrorMessage,
        'Failed to dismiss pending recharge request.',
        {
          route: '/api/carer/game-requests/dismiss-recharge',
          method: 'POST',
          carerUid: carerIdentity?.uid ?? null,
          coadminUid,
        }
      );
    } finally {
      setDismissRechargeRequestId(null);
    }
  }

  async function handleDeletePendingTask(task: CarerTask) {
    if (String(task.status || '').trim().toLowerCase() !== 'pending') {
      setErrorMessage('Only pending tasks can be deleted.');
      return;
    }

    if (deletedCarerTaskIds[task.id]) {
      setTasks((previous) => previous.filter((current) => current.id !== task.id));
      return;
    }

    const ok = window.confirm(
      'Delete this pending task? It will be removed from the pending queue.'
    );

    if (!ok) {
      return;
    }

    console.info('[CARER_DELETE_TASK_CLICK]', {
      taskId: task.id,
      taskFirebaseId: task.id,
      statusBefore: task.status,
      assignedCarerUid: task.assignedCarerUid ?? null,
      carerUid: carerIdentity?.uid ?? null,
      coadminUid,
      sqlMode: isClientSqlReadMode(),
      hasAppSessionId: Boolean(getLocalAppSessionId()),
    });

    setDeletingPendingTaskId(task.id);
    setErrorMessage('');
    setNoticeMessage('');

    try {
      await deletePendingCarerTask(task.id);

      console.info('[CARER_DELETE_TASK] optimisticRemoveTaskId=%s', task.id);
      setTasks((previous) => previous.filter((current) => current.id !== task.id));
      setAutomationStatusByTaskId((previous) => {
        if (!previous[task.id]) return previous;
        const next = { ...previous };
        delete next[task.id];
        return next;
      });
      setLocalAutomationProcessingByTaskId((previous) => {
        if (!previous[task.id]) return previous;
        const next = { ...previous };
        delete next[task.id];
        return next;
      });
      setPendingAutomationResetTaskIds((previous) => {
        if (!previous[task.id]) return previous;
        const next = { ...previous };
        delete next[task.id];
        return next;
      });
      setPendingTaskPayloadPreview((current) => (current?.id === task.id ? null : current));
      setDeletedCarerTaskIds((previous) => ({
        ...previous,
        [task.id]: true,
      }));
      console.info('[CARER_DELETE_TASK] refreshAfterDelete=false sqlMode=%s', isClientSqlReadMode());
      if (!isClientSqlReadMode()) {
        await refreshPageDataAfterMutation('delete_pending_task_firebase');
      }
      setNoticeMessage('Pending task deleted.');
    } catch (error) {
      reportCarerActionError(
        'delete_pending_task',
        error,
        setErrorMessage,
        'Failed to delete pending task.',
        {
          route: '/api/carer/tasks/delete-pending',
          method: 'POST',
          carerUid: carerIdentity?.uid ?? null,
          coadminUid,
        }
      );
    } finally {
      setDeletingPendingTaskId(null);
    }
  }

  async function handleCompleteRechargeRedeem(task: CarerTask) {
    setTaskLoadingId(task.id);
    setErrorMessage('');
    setNoticeMessage('');

    try {
      const rewardSummary = await completeRechargeRedeemTask(task);
      setCashBoxNpr((previous) => previous + rewardSummary.totalAwardNpr);
      setNoticeMessage(
        `Task completed. Reward +${formatNpr(
          rewardSummary.totalAwardNpr
        )} added to Cash Box.`
      );
      await refreshPageDataAfterMutation('complete_recharge_redeem');
    } catch (error) {
      reportCarerActionError(
        'complete_recharge_redeem',
        error,
        setErrorMessage,
        'Failed to complete the task.',
        {
          route: '/api/carer/tasks/complete-recharge-redeem',
          method: 'POST',
          carerUid: carerIdentity?.uid ?? null,
          coadminUid,
        }
      );
    } finally {
      setTaskLoadingId(null);
    }
  }

  async function handleMoveTaskBackToPending(task: CarerTask) {
    if (!carerIdentity) {
      setErrorMessage('Carer profile not ready yet. Please try again.');
      return;
    }

    console.info('[carer-ui] reset-automation:start', {
      taskId: task.id,
      taskType: task.type,
      automationJobId: task.automationJobId || null,
      automationStatus: task.automationStatus || null,
      sectionStatus: task.status,
    });
    console.info('[RETURN_TO_PENDING_CLICK]', {
      taskId: task.id,
      statusBefore: task.status,
      assignedCarerUid: task.assignedCarerUid ?? null,
      carerUid: carerIdentity.uid,
      coadminUid,
    });
    console.info('[CARER_RETURN_TO_PENDING_CLICK]', {
      taskId: task.id,
      statusBefore: task.status,
      assignedCarerUid: task.assignedCarerUid ?? null,
      carerUid: carerIdentity.uid,
      coadminUid,
      hasAppSessionId: Boolean(getLocalAppSessionId()),
      sqlMode: isClientSqlReadMode(),
    });

    setTaskLoadingId(task.id);
    setErrorMessage('');
    setNoticeMessage('');

    try {
      await returnTaskToPendingAndCancelAutomation(task.id);
      recentlyReturnedTaskIdsRef.current = {
        ...recentlyReturnedTaskIdsRef.current,
        [task.id]: Date.now(),
      };
      setTasks((previous) =>
        sortByNewest(
          previous.map((current) =>
            current.id === task.id
              ? {
                  ...current,
                  status: 'pending',
                  assignedCarerUid: null,
                  assignedCarerUsername: null,
                  claimedByUid: null,
                  claimedStatus: null,
                  automationStatus: null,
                  automationJobId: null,
                }
              : current
          )
        )
      );
      setAutomationStatusByTaskId((previous) => {
        const next = { ...previous };
        delete next[task.id];
        return next;
      });
      setFreshAutomationJobByTaskId((previous) => {
        const next = { ...previous };
        delete next[task.id];
        return next;
      });
      setLocalAutomationProcessingByTaskId((previous) => {
        if (!previous[task.id]) {
          return previous;
        }
        const next = { ...previous };
        delete next[task.id];
        return next;
      });
      setPendingAutomationResetTaskIds((previous) => ({
        ...previous,
        [task.id]: true,
      }));
      await refreshPageDataAfterMutation('return_to_pending_success');
      console.info('[carer-ui] reset-automation:success', {
        taskId: task.id,
        pendingOverrideSet: true,
      });
      setNoticeMessage('Task moved back to pending.');
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      const lower = rawMessage.toLowerCase();
      const isConcurrencyIssue =
        lower.includes('failed-precondition') ||
        lower.includes('aborted') ||
        lower.includes('contention') ||
        lower.includes('updated at the same time');
      if (isConcurrencyIssue) {
        await refreshPageDataAfterMutation('return_to_pending_concurrency_error');
      }
      console.error('[carer-ui] reset-automation:error', {
        taskId: task.id,
        message: rawMessage,
      });
      if (isConcurrencyIssue) {
        setErrorMessage('Task was already changed. Please refresh and try again.');
      } else {
        reportCarerActionError(
          'return_to_pending',
          error,
          setErrorMessage,
          'Failed to move task back to pending.',
          {
            route: '/api/carer/tasks/return-to-pending',
            method: 'POST',
            carerUid: carerIdentity?.uid ?? null,
            coadminUid,
          }
        );
      }
    } finally {
      setTaskLoadingId(null);
    }
  }

  async function handleForceResetAutomation(task: CarerTask) {
    console.info('[carer-ui] reset-automation:clicked', {
      taskId: task.id,
      taskType: task.type,
      automationJobId: task.automationJobId || null,
      automationStatus: task.automationStatus || null,
    });
    console.info('[carer-ui] reset-automation:auto-confirmed', {
      taskId: task.id,
    });
    await handleMoveTaskBackToPending(task);
  }

  async function handleStartAutomation(task: CarerTask) {
    setAutomationLoadingTaskId(task.id);
    setErrorMessage('');
    setNoticeMessage('');
    const loginForTask =
      allPlayerLogins.find(
        (login) =>
          login.playerUid === task.playerUid &&
          normalizeGameName(login.gameName || '') ===
            normalizeGameName(task.gameName || '')
      ) || null;
    const resolvedCurrentUsername =
      String(
        loginForTask?.gameUsername ||
          (task as { currentUsername?: string | null }).currentUsername ||
          (task as { gameAccountUsername?: string | null }).gameAccountUsername ||
          ''
      ).trim() || null;
    const relatedCoadminGame =
      gameOptions.find(
        (game) =>
          normalizeGameName(game.gameName || '') === normalizeGameName(task.gameName || '')
      ) || null;
    try {
      if (carerIdentity?.uid && coadminUid) {
        await setCarerAutomationAutoEnabled({
          carerUid: carerIdentity.uid,
          coadminUid,
          enabled: true,
        });
        setAutomationAutoStateDoc((previous) => ({
          ...(previous || {}),
          enabled: true,
        }));
      }
      const claimResult = await claimTaskAndCreateJob({
        taskId: task.id,
        currentUsername: resolvedCurrentUsername,
        carerName: carerIdentity?.username || null,
        gameLoginDetails: relatedCoadminGame
          ? {
              username: relatedCoadminGame.username,
              password: relatedCoadminGame.password,
              backendUrl: relatedCoadminGame.backendUrl || relatedCoadminGame.siteUrl || '',
              frontendUrl: relatedCoadminGame.frontendUrl || '',
              siteUrl: relatedCoadminGame.siteUrl || '',
            }
          : null,
      });
      setPendingAutomationResetTaskIds((previous) => {
        if (!previous[task.id]) return previous;
        const next = { ...previous };
        delete next[task.id];
        return next;
      });
      setAutomationStatusByTaskId((previous) => ({
        ...previous,
        [task.id]: claimResult.status === 'running' ? 'running' : 'waiting',
      }));
      if (isUsernameWorkflowTask(task)) {
        setLocalAutomationProcessingByTaskId((previous) => ({
          ...previous,
          [task.id]: Date.now() + CREATE_USERNAME_UI_GRACE_MS,
        }));
      }
      setNoticeMessage(
        claimResult.reusedExistingJob
          ? claimResult.status === 'running'
            ? 'Your existing automation job was resumed and is already running.'
            : 'Your existing automation job was resumed.'
          : 'Automation job queued. Waiting for local agent.'
      );
    } catch (error) {
      reportCarerActionError(
        'start_automation_task',
        error,
        setErrorMessage,
        'Failed to start automation.',
        {
          route: isClientSqlReadMode() ? '/api/carer/tasks/claim' : null,
          method: 'POST',
          carerUid: carerIdentity?.uid ?? null,
          coadminUid,
        }
      );
    } finally {
      setAutomationLoadingTaskId(null);
    }
  }

  async function handleCashoutRequest() {
    logCarerAction({
      action: 'request_cashout',
      file: 'app/carer/page.tsx',
      function: 'handleCashoutRequest',
      route: '/api/carer/cashouts',
      method: 'POST',
      carerUid: carerIdentity?.uid ?? null,
      coadminUid,
      role: 'carer',
      authHeaderMode: 'firebase_bearer',
    });
    if (!carerIdentity || !coadminUid) {
      setErrorMessage('Cashout is not ready. Please wait.');
      return;
    }

    if (cashBoxNpr <= 0) {
      setErrorMessage('Cash box is empty.');
      return;
    }

    if (!paymentQrUrl.trim()) {
      setErrorMessage('Please add payment QR details before requesting cashout.');
      setShowPaymentDetailsPanel(true);
      return;
    }

    setCashoutLoading(true);
    setErrorMessage('');
    setNoticeMessage('');

    try {
      await createCarerCashoutRequest({
        coadminUid,
        carerUid: carerIdentity.uid,
        carerUsername: carerIdentity.username,
        amountNpr: cashBoxNpr,
        paymentQrUrl: paymentQrUrl.trim(),
        paymentQrPublicId: paymentQrPublicId.trim(),
        paymentDetails: paymentDetails.trim(),
      });
      setNoticeMessage(
        `Cashout request of ${formatNpr(cashBoxNpr)} sent to coadmin successfully.`
      );
    } catch (error) {
      reportCarerActionError(
        'request_cashout',
        error,
        setErrorMessage,
        'Failed to request cashout.',
        {
          route: '/api/carer/cashouts',
          method: 'POST',
          carerUid: carerIdentity?.uid ?? null,
          coadminUid,
          allowedRoles: ['carer', 'staff', 'coadmin', 'admin'],
        }
      );
    } finally {
      setCashoutLoading(false);
    }
  }

  async function handleSavePaymentDetails() {
    logCarerAction({
      action: 'save_payment_details',
      file: 'app/carer/page.tsx',
      function: 'handleSavePaymentDetails',
      route: null,
      method: null,
      carerUid: carerIdentity?.uid ?? null,
      coadminUid,
      role: 'carer',
      authHeaderMode: 'firestore_client_only',
    });
    setSavingPaymentDetails(true);
    setErrorMessage('');
    setNoticeMessage('');

    try {
      await saveCarerPaymentDetails({
        paymentQrUrl,
        paymentQrPublicId,
        paymentDetails,
      });
      setCarerIdentity((previous) =>
        previous
          ? {
              ...previous,
              paymentQrUrl: paymentQrUrl.trim(),
              paymentQrPublicId: paymentQrPublicId.trim(),
              paymentDetails: paymentDetails.trim(),
            }
          : previous
      );
      setNoticeMessage('Payment details saved successfully.');
      setShowPaymentDetailsPanel(false);
    } catch (error) {
      reportCarerActionError(
        'save_payment_details',
        error,
        setErrorMessage,
        'Failed to save payment details.'
      );
    } finally {
      setSavingPaymentDetails(false);
    }
  }

  async function handleSendInquiry() {
    if (!coadminUid) {
      setErrorMessage('Coadmin is not ready yet. Please try again.');
      return;
    }

    const cleanMessage = inquiryMessage.trim();

    if (cleanMessage.length < 8) {
      setErrorMessage('Please write a clear inquiry message (at least 8 characters).');
      return;
    }

    logCarerAction({
      action: 'send_cashbox_inquiry',
      file: 'app/carer/page.tsx',
      function: 'handleSendInquiry',
      route: '/api/carer/escalation-alerts',
      method: 'POST',
      carerUid: carerIdentity?.uid ?? null,
      coadminUid,
      role: 'carer',
      authHeaderMode: 'sql_api_write',
    });
    setSendingInquiry(true);
    setErrorMessage('');
    setNoticeMessage('');

    try {
      await sendCarerCashboxInquiryAlert({
        coadminUid,
        message: cleanMessage,
      });
      setNoticeMessage('Urgent inquiry sent to coadmin and staff.');
      setShowInquiryPanel(false);
      setInquiryMessage('');
    } catch (error) {
      reportCarerActionError(
        'send_cashbox_inquiry',
        error,
        setErrorMessage,
        'Failed to send inquiry.',
        {
          route: '/api/carer/escalation-alerts',
          method: 'POST',
          carerUid: carerIdentity?.uid ?? null,
          coadminUid,
          allowedRoles: ['admin', 'coadmin', 'staff', 'carer', 'player'],
        }
      );
    } finally {
      setSendingInquiry(false);
    }
  }

  async function handleCarerEscalation(task: CarerTask) {
    setTaskLoadingId(task.id);
    setErrorMessage('');
    setNoticeMessage('');

    try {
      await sendCarerEscalationAlert(task);
      setNoticeMessage('Help alert sent to coadmin and staff.');
    } catch (error) {
      reportCarerActionError(
        'send_escalation',
        error,
        setErrorMessage,
        'Failed to send help alert.',
        {
          route: '/api/carer/escalation-alerts',
          method: 'POST',
          carerUid: carerIdentity?.uid ?? null,
          coadminUid,
        }
      );
    } finally {
      setTaskLoadingId(null);
    }
  }

  function handleSelectPlayer(playerUid: string) {
    setSelectedPlayerUid(playerUid);
    setEditingLogin(null);
    setActiveUsernameTask(null);
    setGameName('');
    setGameUsername('');
    setGamePassword('');
    setErrorMessage('');
    setNoticeMessage('');
  }

  function startEdit(login: PlayerGameLogin) {
    setSelectedPlayerUid(login.playerUid);
    setEditingLogin(login);
    setActiveUsernameTask(null);
    setGameName(login.gameName || '');
    setGameUsername(login.gameUsername || '');
    setGamePassword(login.gamePassword || '');
    setActiveView('create-username');
    setErrorMessage('');
    setNoticeMessage('');
  }

  function continueUsernameTask(task: CarerTask) {
    const uid = String(task.playerUid || '').trim();
    if (!uid) {
      setErrorMessage('This task has no player id.');
      return;
    }

    const loginForTask =
      allPlayerLogins.find(
        (login) =>
          login.playerUid === uid &&
          normalizeGameName(login.gameName || '') === normalizeGameName(task.gameName || '')
      ) || null;

    setSelectedPlayerUid(uid);
    setActiveUsernameTask(task);
    setEditingLogin(null);
    setGameName(task.gameName || '');
    setGameUsername(
      String(
        loginForTask?.gameUsername ||
          (task as { currentUsername?: string | null }).currentUsername ||
          (task as { gameAccountUsername?: string | null }).gameAccountUsername ||
          ''
      ).trim()
    );
    setGamePassword('');
    setActiveView('create-username');
    setShowTaskSplash(false);
    setNoticeMessage('');
  }

  async function handleTogglePlayerStatus(player: PlayerUser) {
    if (isClientSqlReadMode()) {
      console.info('[CARER_BLOCK_PLAYER_DISABLED]', {
        carerUid: carerIdentity?.uid ?? null,
        playerUid: player.uid,
        reason: 'coadmin_only_action_hidden',
      });
      setNoticeMessage('This action is not available for carers.');
      return;
    }
    logCarerAction({
      action: player.status === 'disabled' ? 'unblock_player' : 'block_player',
      file: 'app/carer/page.tsx',
      function: 'handleTogglePlayerStatus',
      route: '/api/admin/set-user-status',
      method: 'POST',
      carerUid: carerIdentity?.uid ?? null,
      coadminUid,
      role: 'carer',
      authHeaderMode: 'admin_action_headers',
    });
    setBlockingPlayerUid(player.uid);
    setErrorMessage('');
    setNoticeMessage('');

    try {
      if (player.status === 'disabled') {
        await unblockPlayer(player);
      } else {
        await blockPlayer(player);
      }

      await refreshPageDataAfterMutation('block_unblock_player');
      setNoticeMessage(
        `Player ${player.status === 'disabled' ? 'unblocked' : 'blocked'} successfully.`
      );
    } catch (error) {
      reportCarerActionError(
        player.status === 'disabled' ? 'unblock_player' : 'block_player',
        error,
        setErrorMessage,
        'Failed to update player status.',
        {
          route: '/api/admin/set-user-status',
          method: 'POST',
          status: 403,
          carerUid: carerIdentity?.uid ?? null,
          coadminUid,
          allowedRoles: ['admin', 'coadmin'],
          authPath: 'admin_action_headers',
          reason: 'role_not_allowed_for_carer',
        }
      );
    } finally {
      setBlockingPlayerUid(null);
    }
  }

  async function handleOpenRiskPanel(playerUid: string) {
    if (isClientSqlReadMode()) {
      console.info('[CARER_RISK_ACTION_SQL_MODE]', {
        action: 'open_risk_panel',
        enabled: false,
        reason: 'sql_risk_api_not_ready',
        firestoreAttempted: false,
      });
      setNoticeMessage('Risk tools are temporarily unavailable.');
      return;
    }
    logCarerAction({
      action: 'open_risk_panel',
      file: 'app/carer/page.tsx',
      function: 'handleOpenRiskPanel',
      route: null,
      method: null,
      carerUid: carerIdentity?.uid ?? null,
      coadminUid,
      role: 'carer',
      authHeaderMode: 'firestore_client_only',
    });
    setRiskActionLoading(`open-${playerUid}`);
    setErrorMessage('');
    try {
      const snapshot = await getPlayerRiskSnapshot(playerUid);
      if (!snapshot) {
        setErrorMessage('Risk data is not ready for this player yet.');
        return;
      }
      setSelectedRiskSnapshot(snapshot);
      setShowRiskPanel(true);
    } catch (error) {
      reportCarerActionError(
        'open_risk_panel',
        error,
        setErrorMessage,
        'Failed to load risk profile.'
      );
    } finally {
      setRiskActionLoading(null);
    }
  }

  async function handleFlagRiskPlayer() {
    if (!selectedRiskSnapshot) {
      return;
    }
    if (isClientSqlReadMode()) {
      console.info('[CARER_RISK_ACTION_SQL_MODE]', {
        action: 'flag_risk_player',
        enabled: false,
        reason: 'sql_risk_api_not_ready',
        firestoreAttempted: false,
      });
      setNoticeMessage('Risk tools are temporarily unavailable.');
      return;
    }

    logCarerAction({
      action: 'flag_risk_player',
      file: 'app/carer/page.tsx',
      function: 'handleFlagRiskPlayer',
      route: null,
      method: null,
      carerUid: carerIdentity?.uid ?? null,
      coadminUid,
      role: 'carer',
      authHeaderMode: 'firestore_client_only',
    });
    setRiskActionLoading(`flag-${selectedRiskSnapshot.playerUid}`);
    setErrorMessage('');
    try {
      await flagPlayerRisk({
        playerUid: selectedRiskSnapshot.playerUid,
        playerUsername: selectedRiskSnapshot.playerUsername,
        reason: 'Carer flagged player for risk review.',
      });
      setNoticeMessage('Player flagged for staff review.');
    } catch (error) {
      reportCarerActionError(
        'flag_risk_player',
        error,
        setErrorMessage,
        'Failed to flag player.'
      );
    } finally {
      setRiskActionLoading(null);
    }
  }

  async function handleSendRiskAlertToStaff() {
    if (!selectedRiskSnapshot || !coadminUid) {
      return;
    }
    if (isClientSqlReadMode()) {
      console.info('[CARER_RISK_ACTION_SQL_MODE]', {
        action: 'send_risk_alert',
        enabled: false,
        reason: 'sql_risk_api_not_ready',
        firestoreAttempted: false,
      });
      setNoticeMessage('Risk tools are temporarily unavailable.');
      return;
    }

    logCarerAction({
      action: 'send_risk_alert',
      file: 'app/carer/page.tsx',
      function: 'handleSendRiskAlertToStaff',
      route: null,
      method: null,
      carerUid: carerIdentity?.uid ?? null,
      coadminUid,
      role: 'carer',
      authHeaderMode: 'firestore_client_only',
    });
    setRiskActionLoading(`alert-${selectedRiskSnapshot.playerUid}`);
    setErrorMessage('');
    try {
      await sendRiskAlertToStaff({
        playerUid: selectedRiskSnapshot.playerUid,
        playerUsername: selectedRiskSnapshot.playerUsername,
        coadminUid,
        reason: `Risk alert from carer: ${selectedRiskSnapshot.alerts[0] || 'Suspicious recycle pattern observed.'}`,
      });
      setNoticeMessage('Risk alert sent to staff.');
    } catch (error) {
      reportCarerActionError(
        'send_risk_alert',
        error,
        setErrorMessage,
        'Failed to send risk alert.'
      );
    } finally {
      setRiskActionLoading(null);
    }
  }

  function renderDashboard() {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-3xl font-bold">Dashboard</h2>
          <p className="mt-2 text-sm text-neutral-400">
            Track players, games, missing usernames, and shared recharge/redeem requests.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-6">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm text-emerald-100/80">Cash Box</p>
              <button
                type="button"
                onClick={() => setShowInquiryPanel(true)}
                className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-red-500"
              >
                Inquire
              </button>
            </div>
            <p className="mt-2 text-3xl font-bold text-emerald-200">
              {formatNpr(cashBoxNpr)}
            </p>
            <p className="mt-2 text-xs text-emerald-100/80">
              {isNepalNightNow() ? 'Night bonus active (+10%-15%).' : ''}
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void handleCashoutRequest()}
                disabled={cashoutLoading || cashBoxNpr <= 0}
                className="rounded-xl bg-emerald-500 px-4 py-2 text-xs font-bold text-black hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {cashoutLoading ? 'Sending...' : 'Cashout'}
              </button>
              <button
                type="button"
                onClick={() => setShowPaymentDetailsPanel(true)}
                className="rounded-xl bg-white/10 px-4 py-2 text-xs font-bold text-white hover:bg-white/20"
              >
                Payment Details
              </button>
            </div>
          </div>

          <NepalClockCard />
        </div>

        <div className="rounded-2xl border border-violet-500/35 bg-violet-950/30 p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h3 className="text-lg font-bold text-violet-100">Connect Automation Agent</h3>
              <p className="mt-1 text-xs text-violet-200/70">
                Link exactly one agent ID to this account. Your local carer-agent must use the
                same <span className="font-mono text-violet-100">CARER_UID</span> and{' '}
                <span className="font-mono text-violet-100">AGENT_ID</span> as in your .env file.
              </p>
              <p className="mt-2 text-xs text-violet-200/80">
                CARER_UID:{' '}
                <span className="font-mono text-violet-100">
                  {carerIdentity?.uid || 'Loading...'}
                </span>
              </p>
              <p className="mt-2 text-sm font-semibold text-violet-50">
                {carerIdentity?.automationAgentId
                  ? `Agent connected: ${carerIdentity.automationAgentId}`
                  : 'No agent connected'}
              </p>
            </div>
          </div>

          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="min-w-0 flex-1">
              <label className="block text-xs font-bold uppercase tracking-wide text-violet-200/80">
                Agent ID
              </label>
              <input
                type="text"
                value={agentInputDraft}
                onChange={(e) => {
                  setAgentInputDraft(e.target.value);
                  setAgentPanelError('');
                  setAgentPanelNotice('');
                }}
                placeholder="e.g. car001"
                autoComplete="off"
                className="mt-1 w-full rounded-xl border border-violet-400/40 bg-black/50 px-3 py-2.5 font-mono text-sm text-white outline-none focus:border-violet-300 focus:ring-2 focus:ring-violet-400/30"
              />
              {(() => {
                const check = validateAutomationAgentId(agentInputDraft);
                if (agentInputDraft.trim() && !check.valid) {
                  return (
                    <p className="mt-1 text-xs font-semibold text-rose-300">Invalid agent ID</p>
                  );
                }
                return null;
              })()}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={agentSaving || !carerIdentity}
                onClick={() => void handleSaveAutomationAgentConnection()}
                className="rounded-xl bg-violet-500 px-4 py-2.5 text-sm font-bold text-white hover:bg-violet-400 disabled:opacity-50"
              >
                {agentSaving ? 'Saving…' : 'Save'}
              </button>
              <button
                type="button"
                disabled={agentSaving || !carerIdentity?.automationAgentId}
                onClick={() => void handleDisconnectAutomationAgent()}
                className="rounded-xl border border-violet-400/50 bg-transparent px-4 py-2.5 text-sm font-bold text-violet-100 hover:bg-violet-500/15 disabled:opacity-50"
              >
                Disconnect
              </button>
              <button
                type="button"
                disabled={browserWarmupStatus === 'warming' || !carerIdentity?.automationAgentId}
                onClick={() => void handleWarmUpBrowser()}
                className="rounded-xl border border-emerald-400/40 bg-emerald-500/15 px-4 py-2.5 text-sm font-bold text-emerald-100 hover:bg-emerald-500/25 disabled:opacity-50"
              >
                {browserWarmupStatus === 'warming'
                  ? 'Warming...'
                  : browserWarmupStatus === 'ready' || browserWarmupStatus === 'partial_ready'
                    ? 'Re-warm'
                    : 'Warm Up Browser'}
              </button>
              <button
                type="button"
                disabled={!carerIdentity}
                onClick={() => void handleCopyAutomationAgentEnvSnippet()}
                className="rounded-xl border border-white/20 bg-white/5 px-4 py-2.5 text-sm font-bold text-white hover:bg-white/10"
              >
                Copy .env snippet
              </button>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-violet-100/80">
            <span className="rounded-full border border-white/10 bg-black/30 px-3 py-1 font-semibold">
              {warmupStatusLabel()}
            </span>
            <span>{browserWarmupMessage}</span>
            {Object.keys(browserWarmupGames).length > 0 ? (
              <span>
                {Object.entries(browserWarmupGames)
                  .map(([gameName, result]) => {
                    const detail =
                      result.statusLabel ||
                      result.reason?.replace(/_/g, ' ') ||
                      result.visibleError ||
                      result.error ||
                      (result.ready ? 'ready' : 'failed');
                    return `${gameName}: ${detail}`;
                  })
                  .join(' | ')}
              </span>
            ) : null}
          </div>

          {agentPanelError ? (
            <p className="mt-3 text-sm font-semibold text-rose-300">{agentPanelError}</p>
          ) : null}
          {agentPanelNotice ? (
            <p className="mt-2 text-sm font-semibold text-emerald-300">{agentPanelNotice}</p>
          ) : null}
          {automationTokenWarning ? (
            <p className="mt-2 text-sm font-semibold text-amber-300">{automationTokenWarning}</p>
          ) : null}

          <p className="mt-3 text-[11px] text-violet-200/55">
            Firestore job document id format:{' '}
            <span className="font-mono text-violet-100/90">carerUid--taskId</span> (one document per
            carer + task).
          </p>
        </div>

        <div className="rounded-2xl border border-amber-500/30 bg-amber-950/25 p-6">
          <h3 className="text-lg font-bold text-amber-100">Work details</h3>
          <p className="mt-1 text-xs text-amber-200/70">
            Your completed recharge and redeem totals in the last 30 days (tasks you
            finished).
          </p>
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="rounded-xl border border-emerald-500/25 bg-emerald-950/30 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-emerald-200/80">
                Total recharged (30d)
              </p>
              <p className="mt-2 text-2xl font-bold text-emerald-100">
                {formatNpr(workDetails30d.rechargeTotal)}
              </p>
              <p className="mt-1 text-xs text-emerald-200/60">
                {workDetails30d.rechargeCount} completed task
                {workDetails30d.rechargeCount === 1 ? '' : 's'}
              </p>
            </div>
            <div className="rounded-xl border border-rose-500/25 bg-rose-950/30 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-rose-200/80">
                Total redeemed (30d)
              </p>
              <p className="mt-2 text-2xl font-bold text-rose-100">
                {formatNpr(workDetails30d.redeemTotal)}
              </p>
              <p className="mt-1 text-xs text-rose-200/60">
                {workDetails30d.redeemCount} completed task
                {workDetails30d.redeemCount === 1 ? '' : 's'}
              </p>
            </div>
          </div>
          {workDetails30d.rechargeTotal > 0 && workDetails30d.redeemTotal > 0 ? (
            <p className="mt-3 text-xs text-amber-100/60">
              Redeem vs recharge (amount):{' '}
              <span className="font-semibold text-amber-200">
                {Math.round(
                  (workDetails30d.redeemTotal / workDetails30d.rechargeTotal) * 100
                )}
                %
              </span>{' '}
              of recharge.
            </p>
          ) : null}

          {showRedeemPatternWarning ? (
            <div
              role="alert"
              className="mt-4 rounded-xl border border-rose-500/45 bg-rose-950/50 p-4 text-sm leading-relaxed text-rose-50"
            >
              <p className="font-bold text-rose-200">⚠️ Redeem pattern notice</p>
              <p className="mt-2">
                Your account may be reviewed to confirm redeem requests were legitimate and
                match real gameplay. Redeem totals that look unlikely compared to recharges
                can be flagged.
              </p>
              <p className="mt-2">
                Mistakes or abuse found on a regular basis can lead to{' '}
                <span className="font-semibold text-rose-200">account deactivation</span>.
              </p>
            </div>
          ) : null}
        </div>

        {isClientSqlReadMode() && (
          <div className="rounded-2xl border border-white/10 bg-white/5 p-4 text-sm text-neutral-300">
            Risk tools are temporarily unavailable.
          </div>
        )}

        {!isClientSqlReadMode() && riskyPlayers.length > 0 && (
          <div className="rounded-2xl border border-orange-500/35 bg-orange-500/10 p-6">
            <h3 className="text-lg font-bold text-rose-200">Risky Players</h3>
            <div className="mt-3 space-y-2">
              {riskyPlayers.map((risk) => (
                <button
                  key={risk.playerUid}
                  type="button"
                  onClick={() => void handleOpenRiskPanel(risk.playerUid)}
                  className={`flex w-full items-center justify-between rounded-xl border px-4 py-3 text-left ${getRiskCardTone(
                    risk.riskLevel,
                    risk.riskScore || 0
                  )}`}
                >
                  <div>
                    <p className="text-sm font-semibold text-white">{risk.playerUsername}</p>
                    <p className="text-xs text-rose-100/70">
                      {risk.alerts[0] || 'Risk pattern detected'} · Last:{' '}
                      {getTimestampMs(risk.lastActivityAt)
                        ? new Date(getTimestampMs(risk.lastActivityAt)).toLocaleString()
                        : 'N/A'}
                    </p>
                  </div>
                  <span
                    className={`text-xs font-bold uppercase ${getRiskTone(
                      risk.riskLevel,
                      risk.riskScore || 0
                    )}`}
                  >
                    {risk.riskLevel} ({risk.riskScore})
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-5">
          {dashboardCards.map((card) => {
            const toneClass =
              card.tone === 'amber'
                ? 'border-yellow-500/20 bg-yellow-500/10 text-yellow-100'
                : card.tone === 'blue'
                  ? 'border-blue-500/20 bg-blue-500/10 text-blue-100'
                  : card.tone === 'red'
                    ? 'border-red-500/20 bg-red-500/10 text-red-100'
                    : 'border-white/10 bg-white/5 text-white';

            return (
              <div key={card.label} className={`rounded-2xl border p-6 ${toneClass}`}>
                <p className="text-sm opacity-80">{card.label}</p>
                <p className="mt-2 text-3xl font-bold">{card.value}</p>
              </div>
            );
          })}
        </div>

        <div className="flex flex-wrap gap-3">
          <button
            onClick={() => {
              console.log('[AUTO_UI] Start Automation click received', {
                source: 'dashboard',
                hasCarerUid: Boolean(carerIdentity?.uid),
                carerUid: carerIdentity?.uid || null,
                carerUsername: carerIdentity?.username || null,
                coadminUid: coadminUid || null,
              });
              if (!carerIdentity?.uid || !coadminUid) {
                console.log('[AUTO_UI] Start Automation click blocked', {
                  source: 'dashboard',
                  reason: 'missing_carer_or_coadmin',
                  hasCarerUid: Boolean(carerIdentity?.uid),
                  coadminUid: coadminUid || null,
                });
                setErrorMessage('Coadmin scope is not ready yet.');
                return;
              }
              void persistCarerAutomationEnabled(true, 'dashboard');
            }}
            aria-busy={isTickRunning || isQueueDraining}
            data-listener-active={isListenerActive}
            className="rounded-2xl bg-white px-4 py-3 text-sm font-bold text-black hover:bg-neutral-200"
          >
            Start Automation
          </button>

          {!isClientSqlReadMode() && (
            <button
              onClick={() => {
                const firstRiskPlayer = riskyPlayers[0]?.playerUid || players[0]?.uid || '';
                if (!firstRiskPlayer) {
                  setErrorMessage('No player available to inspect.');
                  return;
                }
                void handleOpenRiskPanel(firstRiskPlayer);
              }}
              className="rounded-2xl bg-white/10 px-4 py-3 text-sm font-bold text-white hover:bg-white/20"
            >
              View Player Risk Data
            </button>
          )}
        </div>
      </div>
    );
  }

  function renderCreateUsername() {
    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-3xl font-bold">Create Username</h2>
            <p className="mt-2 text-sm text-neutral-400">
              Create or update a player game username from the shared coadmin game list.
            </p>
          </div>

          {activeUsernameTask && (
            <div className="rounded-2xl border border-yellow-500/20 bg-yellow-500/10 px-4 py-3 text-sm text-yellow-100">
              Active task: {(activeUsernameTask.playerUsername || 'Unknown player').trim()} /{' '}
              {(activeUsernameTask.gameName || 'Unknown Game').trim()}
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[320px_1fr]">
          <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
            <div className="mb-4">
              <h3 className="text-lg font-semibold">Select Player</h3>
              <p className="mt-1 text-sm text-neutral-400">
                Choose a player before creating or editing a game login.
              </p>
            </div>

            {players.length === 0 ? (
              <p className="text-sm text-neutral-400">No players available.</p>
            ) : (
              <div className="space-y-3">
                {players.map((player) => {
                  const isSelected = player.uid === selectedPlayerUid;

                  return (
                    <button
                      key={player.uid}
                      onClick={() => handleSelectPlayer(player.uid)}
                      className={`w-full rounded-2xl px-4 py-3 text-left ${
                        isSelected
                          ? 'bg-white text-black'
                          : 'bg-neutral-900 text-white hover:bg-neutral-800'
                      }`}
                    >
                      <p className="font-semibold">{player.username || 'Unnamed Player'}</p>
                      <p
                        className={`mt-1 text-xs ${
                          isSelected ? 'text-black/60' : 'text-neutral-500'
                        }`}
                      >
                        {player.status || 'unknown'}
                      </p>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="space-y-6">
            <form
              onSubmit={handleUsernameSubmit}
              className="rounded-2xl border border-white/10 bg-white/5 p-6"
            >
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="md:col-span-2">
                  <p className="mb-2 text-sm text-neutral-400">Selected Player</p>
                  <div className="rounded-xl bg-neutral-900 px-4 py-3 font-semibold">
                    {selectedPlayer?.username || 'No player selected'}
                  </div>
                </div>

                <label className="block">
                  <span className="mb-2 block text-sm text-neutral-400">Game</span>
                  <select
                    value={gameName}
                    onChange={(event) => setGameName(event.target.value)}
                    className="w-full rounded-xl border border-white/10 bg-neutral-900 px-4 py-3 text-white outline-none focus:border-white/30"
                    disabled={!selectedPlayer}
                    required
                  >
                    <option value="">Select Game</option>
                    {gameOptions.map((game) => (
                      <option key={game.id} value={game.gameName}>
                        {game.gameName || 'Unnamed Game'}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="block">
                  <span className="mb-2 block text-sm text-neutral-400">Game Username</span>
                  <input
                    value={gameUsername}
                    onChange={(event) => setGameUsername(event.target.value)}
                    className="w-full rounded-xl border border-white/10 bg-neutral-900 px-4 py-3 text-white outline-none focus:border-white/30"
                    placeholder="Enter game username"
                    disabled={!selectedPlayer}
                    required
                  />
                </label>

                <label className="block md:col-span-2">
                  <span className="mb-2 block text-sm text-neutral-400">Game Password</span>
                  <input
                    value={gamePassword}
                    onChange={(event) => setGamePassword(event.target.value)}
                    className="w-full rounded-xl border border-white/10 bg-neutral-900 px-4 py-3 text-white outline-none focus:border-white/30"
                    placeholder="Enter game password"
                    disabled={!selectedPlayer}
                    required
                  />
                </label>
              </div>

              {existingLoginForSelectedGame && !editingLogin && (
                <div className="mt-4 rounded-2xl border border-blue-500/20 bg-blue-500/10 px-4 py-3 text-sm text-blue-100">
                  A username already exists for this player/game. Submitting will update it.
                </div>
              )}

              <div className="mt-6 flex flex-wrap gap-3">
                <button
                  type="submit"
                  disabled={!selectedPlayer || savingUsername}
                  className="rounded-xl bg-white px-4 py-3 font-semibold text-black hover:bg-neutral-200 disabled:opacity-60"
                >
                  {savingUsername
                    ? editingLogin || existingLoginForSelectedGame
                      ? 'Updating...'
                      : 'Creating...'
                    : editingLogin || existingLoginForSelectedGame
                      ? 'Update Username'
                      : 'Create Username'}
                </button>

                {(editingLogin || activeUsernameTask || gameName || gameUsername || gamePassword) && (
                  <button
                    type="button"
                    onClick={resetUsernameForm}
                    className="rounded-xl bg-white/10 px-4 py-3 font-semibold text-white hover:bg-white/20"
                  >
                    Cancel
                  </button>
                )}
              </div>
            </form>

            <div className="rounded-2xl border border-white/10 bg-white/5 p-6">
              <div className="mb-4">
                <h3 className="text-xl font-bold">Existing Usernames</h3>
                <p className="mt-1 text-sm text-neutral-400">
                  Review and edit any existing username for the selected player.
                </p>
              </div>

              {!selectedPlayer ? (
                <p className="text-sm text-neutral-400">
                  Select a player to view existing usernames.
                </p>
              ) : selectedPlayerLogins.length === 0 ? (
                <p className="text-sm text-neutral-400">
                  No usernames have been created for this player yet.
                </p>
              ) : (
                <div className="space-y-3">
                  {selectedPlayerLogins.map((login) => (
                    <div
                      key={login.id}
                      className="rounded-2xl border border-white/10 bg-neutral-900 p-4"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-4">
                        <div>
                          <h4 className="text-lg font-bold">
                            {login.gameName || 'Unnamed Game'}
                          </h4>
                          <p className="mt-2 text-sm text-neutral-400">
                            Username:{' '}
                            <span className="text-white">
                              {login.gameUsername || 'Not set'}
                            </span>
                          </p>
                          <p className="mt-1 text-sm text-neutral-400">
                            Password:{' '}
                            <span className="text-white">
                              {login.gamePassword || 'Not set'}
                            </span>
                          </p>
                        </div>

                        <button
                          onClick={() => startEdit(login)}
                          className="rounded-xl bg-yellow-400 px-4 py-2 text-sm font-bold text-black hover:bg-yellow-300"
                        >
                          Edit
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  function renderTaskCard(task: CarerTask, section: TaskSection) {
    const loginForTask =
      allPlayerLogins.find(
        (login) =>
          login.playerUid === task.playerUid &&
          normalizeGameName(login.gameName || '') ===
            normalizeGameName(task.gameName || '')
      ) || null;
    const taskCurrentUsername =
      String(
        loginForTask?.gameUsername ||
          (task as { currentUsername?: string | null }).currentUsername ||
          (task as { gameAccountUsername?: string | null }).gameAccountUsername ||
          ''
      ).trim() || null;

    const isRequestTask = task.type === 'recharge' || task.type === 'redeem';

    const statusLabel =
      section === 'pending'
        ? 'Pending'
        : section === 'mine'
          ? 'In Progress'
          : 'Completed';
    const wasResetToPending = Boolean(pendingAutomationResetTaskIds[task.id]);
    const hasLinkedAutomationJob = Boolean(String(task.automationJobId || '').trim());
    const liveAutomationStatus = automationStatusByTaskId[task.id] || null;
    const hasActiveLinkedAutomationJob =
      hasLinkedAutomationJob &&
      Boolean(freshAutomationJobByTaskId[task.id]) &&
      isActiveAutomationUiStatus(liveAutomationStatus);
    const hasLocalProcessingGrace =
      Boolean(localAutomationProcessingByTaskId[task.id]) &&
      localAutomationProcessingByTaskId[task.id] > Date.now();
    const automationStatus =
      section === 'pending'
        ? wasResetToPending
          ? null
          : hasActiveLinkedAutomationJob
            ? liveAutomationStatus || (hasLocalProcessingGrace ? 'running' : null)
            : null
        : liveAutomationStatus || (hasLocalProcessingGrace ? 'running' : null) || task.automationStatus || null;
    const isAutomationQueued =
      automationStatus === 'waiting' || automationStatus === 'running';
    const hasFreshTaskClaim = isFreshActiveTaskClaim(
      task,
      hasActiveLinkedAutomationJob
    );
    const isPendingCard = section === 'pending';
    const startTaskDisabledReason = getStartTaskDisabledReason(task, {
      isLoading: automationLoadingTaskId === task.id,
      automationStatus,
      hasFreshTaskClaim,
      hasFreshRunnableJob: hasActiveLinkedAutomationJob,
    });
    const canStartTask =
      automationLoadingTaskId !== task.id && startTaskDisabledReason !== 'queueing';
    const isDeletingPendingTask =
      deletingPendingTaskId === task.id ||
      (Boolean(task.requestId) &&
        (dismissRedeemRequestId === task.requestId ||
          dismissRechargeRequestId === task.requestId));
    const cleanTimeline = buildCleanTaskTimeline(task);
    if (section === 'completed' && cleanTimeline.inconsistencies.length > 0) {
      const logKey = `${task.id}:${cleanTimeline.inconsistencies.join(',')}`;
      if (!loggedTaskTimelineInconsistenciesRef.current.has(logKey)) {
        loggedTaskTimelineInconsistenciesRef.current.add(logKey);
        console.info('[TASK_TIMELINE_INCONSISTENT]', {
          taskId: task.id,
          createdAt: formatTaskTimelineTime(task.createdAt),
          claimedAt: formatTaskTimelineTime(task.claimedAt),
          startedAt: formatTaskTimelineTime(task.startedAt),
          completedAt: formatTaskTimelineTime(task.completedAt),
          reason: cleanTimeline.inconsistencies.join(','),
        });
      }
    }
    const claimedBy =
      String(task.claimedByUsername || task.assignedCarerUsername || '').trim() ||
      String(task.claimedByUid || task.assignedCarerUid || '').trim() ||
      null;
    const completedBy =
      String(task.completedByCarerUsername || '').trim() ||
      String(task.completedByCarerUid || '').trim() ||
      null;

    return (
      <div
        key={task.id}
        onClick={isPendingCard ? () => setPendingTaskPayloadPreview(task) : undefined}
        className={`rounded-2xl border border-white/10 bg-neutral-950/70 p-4 ${
          isPendingCard ? 'cursor-pointer hover:border-violet-400/40' : ''
        }`}
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span
                className={`rounded-full px-3 py-1 text-xs font-bold uppercase ${getTaskTypeClass(task)}`}
              >
                {getTaskTypeLabel(task)}
              </span>

              <span className="rounded-full bg-white/10 px-3 py-1 text-xs text-white">
                {statusLabel}
              </span>
              {renderVendorTaskBadge(task.vendor)}
              {automationStatus && (
                <span className="rounded-full bg-violet-500/20 px-3 py-1 text-xs font-bold uppercase text-violet-200">
                  Automation:{' '}
                  {automationStatus === 'pending_review'
                    ? 'review needed'
                    : automationStatus === 'running'
                      ? 'processing'
                      : automationStatus}
                </span>
              )}
            </div>

            <h4 className="text-lg font-bold">
              {(task.playerUsername || 'Unknown player').trim()} /{' '}
              {(task.gameName || 'Unknown Game').trim()}
            </h4>

            <p className="mt-2 text-sm text-neutral-400">
              Player:{' '}
              <span className="text-white">{task.playerUsername || 'Unknown player'}</span>
            </p>

            <p className="mt-1 text-sm text-neutral-400">
              Game: <span className="text-white">{task.gameName || 'Unknown Game'}</span>
            </p>

            <p className="mt-1 text-sm text-neutral-400">
              Current Username:{' '}
              <span className="text-white">
                {taskCurrentUsername || 'Not assigned'}
              </span>
            </p>

            {typeof task.amount === 'number' && (
              <p className="mt-1 text-sm text-neutral-400">
                Amount: <span className="text-white">{task.amount}</span>
              </p>
            )}

            {task.assignedCarerUsername && (
              <p className="mt-1 text-sm text-neutral-400">
                Assigned Carer:{' '}
                <span className="text-white">{task.assignedCarerUsername}</span>
              </p>
            )}

            {section === 'completed' && (
              <div className="mt-4 border-t border-white/10 pt-3 text-xs text-neutral-300">
                <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                  <span className="text-neutral-500">Created</span>
                  <span className="text-white">
                    {formatTaskTimelineTime(cleanTimeline.createdMs)}
                  </span>
                  <span className="text-neutral-500">Claimed</span>
                  <span className="text-white">
                    {formatTaskTimelineTime(cleanTimeline.claimedMs)}
                  </span>
                  <span className="text-neutral-500">Started</span>
                  <span className="text-white">
                    {formatTaskTimelineTime(cleanTimeline.startedMs)}
                  </span>
                  <span className="text-neutral-500">Completed</span>
                  <span className="text-white">
                    {formatTaskTimelineTime(cleanTimeline.completedMs)}
                  </span>
                  <span className="text-neutral-500">Duration</span>
                  <span className="font-semibold text-emerald-200">
                    {formatTaskDuration(cleanTimeline.totalDurationMs)}
                  </span>
                  <span className="text-neutral-500">Claim to Complete</span>
                  <span className="text-white">
                    {formatTaskDuration(cleanTimeline.claimToCompleteMs)}
                  </span>
                  <span className="text-neutral-500">Automation Run</span>
                  <span className="text-white">
                    {formatTaskDuration(cleanTimeline.automationRunMs)}
                  </span>
                  <span className="text-neutral-500">Claimed By</span>
                  <span className="text-white">{claimedBy || '—'}</span>
                  <span className="text-neutral-500">Completed By</span>
                  <span className="text-white">{completedBy || '—'}</span>
                </div>
              </div>
            )}
          </div>

          {section === 'pending' && (
            <div className="flex flex-col gap-2">
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  setLoginDetailsTask(task);
                }}
                className="rounded-xl bg-blue-500/20 px-4 py-2 text-sm font-bold text-blue-100 hover:bg-blue-500/30"
              >
                Login Details
              </button>
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  void handleStartTask(task);
                }}
                disabled={!canStartTask}
                className="rounded-xl bg-white px-4 py-2 text-sm font-bold text-black hover:bg-neutral-200 disabled:opacity-60"
              >
                {automationLoadingTaskId === task.id
                  ? 'Queueing...'
                  : automationStatus === 'waiting'
                    ? 'Queued'
                    : automationStatus === 'running'
                      ? 'Running...'
                      : 'Start Task'}
              </button>
              {isAutomationQueued && (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    void handleForceResetAutomation(task);
                  }}
                  disabled={taskLoadingId === task.id}
                  className="rounded-xl border border-orange-500/40 bg-orange-500/15 px-4 py-2 text-sm font-bold text-orange-100 hover:bg-orange-500/25 disabled:opacity-60"
                >
                  {taskLoadingId === task.id ? 'Resetting...' : 'Reset Automation'}
                </button>
              )}
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  void handleDeletePendingTask(task);
                }}
                disabled={isDeletingPendingTask || taskLoadingId === task.id}
                className="rounded-xl border border-red-500/40 bg-red-500/15 px-4 py-2 text-sm font-bold text-red-100 hover:bg-red-500/25 disabled:opacity-60"
              >
                {isDeletingPendingTask ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          )}

          {section === 'mine' && isUsernameWorkflowTask(task) && (
            <div className="flex flex-col gap-2">
              <button
                onClick={() => setLoginDetailsTask(task)}
                className="rounded-xl bg-blue-500/20 px-4 py-2 text-sm font-bold text-blue-100 hover:bg-blue-500/30"
              >
                Login Details
              </button>
              <button
                onClick={() => void handleStartAutomation(task)}
                disabled={automationLoadingTaskId === task.id}
                className="rounded-xl border border-violet-400/40 bg-violet-500/15 px-4 py-2 text-sm font-bold text-violet-100 hover:bg-violet-500/25 disabled:opacity-60"
              >
                {automationLoadingTaskId === task.id
                  ? 'Queueing...'
                  : automationStatus === 'waiting'
                    ? 'Queued'
                    : automationStatus === 'running'
                      ? 'Running...'
                      : 'Start Automation'}
              </button>
              <button
                type="button"
                onClick={() => void handleMoveTaskBackToPending(task)}
                disabled={taskLoadingId === task.id}
                className="rounded-xl border border-orange-500/40 bg-orange-500/15 px-4 py-2 text-sm font-bold text-orange-100 hover:bg-orange-500/25 disabled:opacity-60"
              >
                {taskLoadingId === task.id ? 'Saving...' : 'Back to Pending'}
              </button>
              <button
                onClick={() => continueUsernameTask(task)}
                className="rounded-xl bg-yellow-400 px-4 py-2 text-sm font-bold text-black hover:bg-yellow-300"
              >
                Continue Task
              </button>
            </div>
          )}

          {section === 'mine' && isRequestTask && (
            <div className="flex flex-col gap-2">
              <button
                onClick={() => setLoginDetailsTask(task)}
                className="rounded-xl bg-blue-500/20 px-4 py-2 text-sm font-bold text-blue-100 hover:bg-blue-500/30"
              >
                Login Details
              </button>
              {task.type === 'redeem' && task.requestId && (
                <button
                  type="button"
                  onClick={() => void handleDismissPendingRedeem(task)}
                  disabled={
                    dismissRedeemRequestId === task.requestId ||
                    taskLoadingId === task.id
                  }
                  className="rounded-xl border border-amber-500/40 bg-amber-500/15 px-4 py-2 text-sm font-bold text-amber-100 hover:bg-amber-500/25 disabled:opacity-60"
                >
                  {dismissRedeemRequestId === task.requestId
                    ? 'Dismissing...'
                    : 'Dismiss fake redeem'}
                </button>
              )}
              {task.type === 'recharge' && task.requestId && (
                <button
                  type="button"
                  onClick={() => void handleDismissPendingRecharge(task)}
                  disabled={
                    dismissedRechargeRequestIds[task.requestId] === true ||
                    dismissRechargeRequestId === task.requestId
                  }
                  className="rounded-xl border border-amber-500/40 bg-amber-500/15 px-4 py-2 text-sm font-bold text-amber-100 hover:bg-amber-500/25 disabled:opacity-60"
                >
                  {dismissRechargeRequestId === task.requestId
                    ? 'Dismissing...'
                    : dismissedRechargeRequestIds[task.requestId]
                      ? 'Dismissed'
                      : 'Dismiss recharge'}
                </button>
              )}
              <button
                onClick={() => void handleStartAutomation(task)}
                disabled={automationLoadingTaskId === task.id}
                className="rounded-xl border border-violet-400/40 bg-violet-500/15 px-4 py-2 text-sm font-bold text-violet-100 hover:bg-violet-500/25 disabled:opacity-60"
              >
                {automationLoadingTaskId === task.id
                  ? 'Queueing...'
                  : automationStatus === 'waiting'
                    ? 'Queued'
                    : automationStatus === 'running'
                      ? 'Running...'
                      : 'Start Automation'}
              </button>
              <button
                type="button"
                onClick={() => void handleMoveTaskBackToPending(task)}
                disabled={taskLoadingId === task.id}
                className="rounded-xl border border-orange-500/40 bg-orange-500/15 px-4 py-2 text-sm font-bold text-orange-100 hover:bg-orange-500/25 disabled:opacity-60"
              >
                {taskLoadingId === task.id ? 'Saving...' : 'Back to Pending'}
              </button>
              <button
                onClick={() => void handleCompleteRechargeRedeem(task)}
                disabled={taskLoadingId === task.id}
                className="rounded-xl bg-white px-4 py-2 text-sm font-bold text-black hover:bg-neutral-200 disabled:opacity-60"
              >
                {taskLoadingId === task.id ? 'Saving...' : getTaskActionLabel(task)}
              </button>
            </div>
          )}

        </div>
      </div>
    );
  }

  function renderTasks() {
    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-3xl font-bold">Tasks</h2>
            <p className="mt-2 text-sm text-neutral-400">
              Shared task pool for all carers under the same coadmin.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                console.log('[AUTO_UI] Start Automation click received', {
                  source: 'tasks_header',
                  hasCarerUid: Boolean(carerIdentity?.uid),
                  carerUid: carerIdentity?.uid || null,
                  carerUsername: carerIdentity?.username || null,
                  coadminUid: coadminUid || null,
                  previousEnabled: autoAutomationEnabled,
                });
                if (!carerIdentity?.uid || !coadminUid) {
                  console.log('[AUTO_UI] Start Automation click blocked', {
                    source: 'tasks_header',
                    reason: 'missing_carer_or_coadmin',
                    hasCarerUid: Boolean(carerIdentity?.uid),
                    coadminUid: coadminUid || null,
                  });
                  setErrorMessage('Coadmin scope is not ready yet.');
                  return;
                }
                const next = !autoAutomationEnabled;
                void persistCarerAutomationEnabled(next, 'tasks_header');
              }}
              aria-busy={isTickRunning || isQueueDraining}
              data-listener-active={isListenerActive}
              className="rounded-xl border border-violet-500/40 bg-violet-500/15 px-4 py-2 text-sm font-bold text-violet-100 hover:bg-violet-500/25"
            >
              {autoAutomationEnabled ? 'Stop Automation' : 'Start Automation'}
            </button>
            <button
              type="button"
              onClick={() => setShowRevTotals((open) => !open)}
              className="rounded-xl border border-emerald-500/40 bg-emerald-500/15 px-4 py-2 text-sm font-bold text-emerald-100 hover:bg-emerald-500/25"
            >
              Rev
            </button>
            <button
              onClick={() => void refreshPageData()}
              className="rounded-xl bg-white px-4 py-2 text-sm font-bold text-black hover:bg-neutral-200"
            >
              Refresh
            </button>
          </div>
        </div>

        {showRevTotals && carerIdentity && (
          <div className="rounded-2xl border border-emerald-500/30 bg-emerald-950/30 p-5 text-sm text-emerald-50">
            <p className="text-xs font-bold uppercase tracking-wider text-emerald-200/80">
              Your completed totals (recharge / redeem amounts)
            </p>
            <p className="mt-3 text-lg font-bold text-white">
              Total recharged:{' '}
              <span className="text-emerald-300">
                {formatNpr(
                  carerRechargeRedeemTotals[carerIdentity.uid]?.totalRechargeAmount ||
                    0
                )}
              </span>
            </p>
            <p className="mt-1 text-lg font-bold text-white">
              Total redeemed:{' '}
              <span className="text-emerald-300">
                {formatNpr(
                  carerRechargeRedeemTotals[carerIdentity.uid]?.totalRedeemAmount || 0
                )}
              </span>
            </p>
            <p className="mt-3 text-xs text-emerald-100/60">
              Based on tasks you completed under this coadmin. Updates as you finish
              recharge and redeem tasks.
            </p>
          </div>
        )}

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
          <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-5">
            <h3 className="mb-4 text-xl font-bold text-red-200">Pending Tasks</h3>
            {claimablePendingTasks.length === 0 ? (
              <p className="text-sm text-red-100/70">No pending tasks right now.</p>
            ) : (
              <div className="space-y-3">
                {claimablePendingTasks.map((task) => renderTaskCard(task, 'pending'))}
              </div>
            )}
          </div>

          <div className="rounded-2xl border border-blue-500/20 bg-blue-500/10 p-5">
            <h3 className="mb-4 text-xl font-bold text-blue-200">In Progress By Me</h3>
            {myInProgressTasks.length === 0 ? (
              <p className="text-sm text-blue-100/70">No tasks are currently assigned to you.</p>
            ) : (
              <div className="space-y-3">
                {myInProgressTasks.map((task) => renderTaskCard(task, 'mine'))}
              </div>
            )}
          </div>

          <div className="rounded-2xl border border-green-500/20 bg-green-500/10 p-5">
            <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
              <h3 className="text-xl font-bold text-green-200">Completed Tasks</h3>
              {completedTasks.length > 0 ? (
                <span className="text-xs font-semibold text-green-100/65">
                  Showing {renderedCompletedTasks.length} of {completedTasks.length}
                </span>
              ) : null}
            </div>
            {completedTasks.length === 0 ? (
              <p className="text-sm text-green-100/70">No completed tasks yet.</p>
            ) : (
              <div className="space-y-3">
                {renderedCompletedTasks.map((task) => renderTaskCard(task, 'completed'))}
                {completedTasks.length > renderedCompletedTasks.length ? (
                  <button
                    type="button"
                    onClick={() => {
                      setCompletedVisibleLimit((previousLimit) => {
                        const newLimit = previousLimit + CARER_COMPLETED_RENDER_STEP;
                        if (process.env.NODE_ENV === 'development') {
                          console.info('[CARER_COMPLETED_SEE_MORE]', {
                            previousLimit,
                            newLimit,
                          });
                        }
                        return newLimit;
                      });
                    }}
                    className="w-full rounded-xl border border-green-300/30 bg-green-300/10 px-4 py-2 text-sm font-bold text-green-100 hover:bg-green-300/20"
                  >
                    See more completed
                  </button>
                ) : null}
                {completedVisibleLimit > CARER_COMPLETED_RENDER_STEP &&
                completedTasks.length > CARER_COMPLETED_RENDER_STEP ? (
                  <button
                    type="button"
                    onClick={() => setCompletedVisibleLimit(CARER_COMPLETED_RENDER_STEP)}
                    className="w-full rounded-xl border border-white/10 px-4 py-2 text-xs font-semibold text-green-100/70 hover:bg-white/5"
                  >
                    Show less
                  </button>
                ) : null}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  function renderPlayers() {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-3xl font-bold">View Players</h2>
          <p className="mt-2 text-sm text-neutral-400">
            Review players under your coadmin scope and block or unblock access.
          </p>
        </div>

        {players.length === 0 ? (
          <div className="rounded-2xl border border-white/10 bg-white/5 p-6 text-sm text-neutral-400">
            No players found.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {players.map((player) => (
              <div
                key={player.uid}
                className="rounded-2xl border border-white/10 bg-white/5 p-5"
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 className="flex flex-wrap items-center gap-2 text-2xl font-bold">
                      <OnlineIndicator
                        online={Boolean(carerPlayerOnlineByUid[player.uid])}
                        sizeClassName="h-3 w-3"
                      />
                      <span>{player.username || 'Unnamed Player'}</span>
                    </h3>
                    <p className="mt-2 text-sm text-neutral-400">
                      Status: <span className="text-white">{player.status}</span>
                    </p>
                  </div>

                  <div className="flex flex-col gap-2">
                    {!isClientSqlReadMode() && (
                      <button
                        type="button"
                        onClick={() => void handleTogglePlayerStatus(player)}
                        disabled={blockingPlayerUid === player.uid}
                        className="rounded-xl bg-yellow-500/20 px-4 py-2 text-sm font-semibold text-yellow-300 hover:bg-yellow-500/30 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {blockingPlayerUid === player.uid
                          ? 'Updating...'
                          : player.status === 'disabled'
                            ? 'Unblock'
                            : 'Block'}
                      </button>
                    )}
                    {!isClientSqlReadMode() && (
                      <button
                        type="button"
                        onClick={() => void handleOpenRiskPanel(player.uid)}
                        disabled={riskActionLoading === `open-${player.uid}`}
                        className="rounded-xl bg-white/10 px-4 py-2 text-xs font-semibold text-white hover:bg-white/20 disabled:opacity-60"
                      >
                        {riskActionLoading === `open-${player.uid}`
                          ? 'Loading...'
                          : 'View Player Risk Data'}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  function renderLoginDetails() {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-3xl font-bold">Login Details</h2>
          <p className="mt-2 text-sm text-neutral-400">
            Coadmin game login credentials by respective game.
          </p>
        </div>

        {gameOptions.length === 0 ? (
          <div className="rounded-2xl border border-white/10 bg-white/5 p-6 text-sm text-neutral-400">
            No game login details found.
          </div>
        ) : (
          <div className="space-y-4">
            {gameOptions.map((game) => (
              <div
                key={game.id}
                className="rounded-2xl border border-white/10 bg-white/5 p-5"
              >
                <h3 className="text-2xl font-bold">{game.gameName || 'Unnamed Game'}</h3>
                <p className="mt-3 text-sm text-neutral-400">
                  Username: <span className="text-white">{game.username || 'Not set'}</span>
                </p>
                <p className="mt-1 text-sm text-neutral-400">
                  Password:{' '}
                  <span className="break-all text-white">{game.password || 'Not set'}</span>
                </p>
                <p className="mt-1 text-sm text-neutral-400">
                  Site:{' '}
                  {game.backendUrl || game.siteUrl ? (
                    <a
                      href={normalizeSiteUrl(game.backendUrl || game.siteUrl)}
                      target="_blank"
                      rel="noreferrer"
                      className="break-all text-cyan-300 underline underline-offset-2 hover:text-cyan-200"
                    >
                      {game.backendUrl || game.siteUrl}
                    </a>
                  ) : (
                    <span className="text-white">Not set</span>
                  )}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  const menuItems: (NavigationItem & { view: CarerView })[] = [
    { view: 'dashboard', label: 'Dashboard' },
    { view: 'create-username', label: 'Create Username' },
    {
      view: 'tasks',
      label: 'Tasks',
      unread: claimablePendingTasks.length + myInProgressTasks.length,
    },
    { view: 'view-players', label: 'View Players' },
    { view: 'login-details', label: 'Login Details' },
  ];

  function handleChangeView(view: CarerView) {
    setActiveView(view);
    setNoticeMessage('');
  }

  return (
    <ProtectedRoute allowedRoles={['carer']}>
      <RoleSidebarLayout
        title="Carer Panel"
        subtitle={carerIdentity?.username || 'Carer'}
        activeView={activeView}
        items={menuItems.map((item) => ({
          ...item,
          onClick: () => handleChangeView(item.view as CarerView),
        }))}
        footer={<LogoutButton />}
      >
          {errorMessage && (
            <div className="mb-4 rounded-2xl border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-100">
              {errorMessage}
            </div>
          )}

          {noticeMessage && (
            <div className="mb-4 rounded-2xl border border-green-500/20 bg-green-500/10 p-4 text-sm text-green-100">
              {noticeMessage}
            </div>
          )}

          {showTaskSplash && claimablePendingTasks.length > 0 && (
            <div className="mb-6 rounded-3xl border border-yellow-400/30 bg-yellow-500/10 p-5">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.2em] text-yellow-200">
                    Task Alert
                  </p>
                  <h2 className="mt-2 text-2xl font-bold">
                    {claimablePendingTasks.length} claimable pending task
                    {claimablePendingTasks.length === 1 ? '' : 's'}
                  </h2>
                  <p className="mt-1 text-sm text-yellow-100/80">
                    Start a task before another carer claims it.
                  </p>
                </div>

                <div className="flex gap-3">
                  <button
                    onClick={() => {
                      setActiveView('tasks');
                      setShowTaskSplash(false);
                    }}
                    className="rounded-2xl bg-white px-4 py-3 text-sm font-bold text-black hover:bg-neutral-200"
                  >
                    Open Tasks
                  </button>
                  <button
                    onClick={() => setShowTaskSplash(false)}
                    className="rounded-2xl bg-white/10 px-4 py-3 text-sm font-bold text-white hover:bg-white/20"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            </div>
          )}

          {(bootstrapping || refreshing) && (
            <div className="mb-6 rounded-2xl border border-white/10 bg-white/5 p-4 text-sm text-neutral-300">
              {bootstrapping ? 'Loading carer page...' : 'Refreshing data...'}
            </div>
          )}

          {!bootstrapping && !refreshing && (taskSyncRunning || taskSyncError) && (
            <div className="mb-4 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-neutral-400">
              {taskSyncRunning
                ? 'Syncing old Firestore tasks...'
                : taskSyncError}
            </div>
          )}

          {activeView === 'dashboard' && renderDashboard()}
          {activeView === 'create-username' && renderCreateUsername()}
          {activeView === 'tasks' && renderTasks()}
          {activeView === 'view-players' && renderPlayers()}
          {activeView === 'login-details' && renderLoginDetails()}
      </RoleSidebarLayout>

      {showRiskPanel && selectedRiskSnapshot && (
        <div
          onClick={() => setShowRiskPanel(false)}
          className="fixed inset-0 z-[58] flex items-center justify-center bg-black/80 px-4"
        >
          <div
            onClick={(event) => event.stopPropagation()}
            className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-3xl border border-white/20 bg-neutral-900 p-6"
          >
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-2xl font-bold">Player Risk Data</h3>
              <button
                type="button"
                onClick={() => setShowRiskPanel(false)}
                className="rounded-lg bg-white/10 px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/20"
              >
                Close
              </button>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <p className="text-xs text-neutral-400">Player Summary</p>
                <p className="mt-2 text-lg font-semibold text-white">
                  {selectedRiskSnapshot.playerUsername}
                </p>
                <p
                  className={`text-sm font-bold uppercase ${getRiskTone(
                    selectedRiskSnapshot.riskLevel,
                    selectedRiskSnapshot.riskScore || 0
                  )}`}
                >
                  {selectedRiskSnapshot.riskLevel} risk
                </p>
                <p className="text-sm text-neutral-200">Score: {selectedRiskSnapshot.riskScore}</p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <p className="text-xs text-neutral-400">Financial Data</p>
                <p className="mt-2 text-sm text-neutral-200">
                  Deposits: {formatNpr(selectedRiskSnapshot.totalDeposits || 0)}
                </p>
                <p className="text-sm text-neutral-200">
                  Cashouts: {formatNpr(selectedRiskSnapshot.totalCashouts || 0)}
                </p>
                <p className="text-sm text-neutral-200">
                  Transfers: {formatNpr(selectedRiskSnapshot.totalTransfers || 0)}
                </p>
                <p className="text-sm text-neutral-200">
                  Bonus claimed: {formatNpr(selectedRiskSnapshot.totalBonusClaimed || 0)}
                </p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <p className="text-xs text-neutral-400">Activity (last 24h / 7d)</p>
                <p className="mt-2 text-sm text-neutral-200">
                  Cashouts: {selectedRiskSnapshot.activity24h?.cashouts || 0} /{' '}
                  {selectedRiskSnapshot.activity7d?.cashouts || 0}
                </p>
                <p className="text-sm text-neutral-200">
                  Transfers: {selectedRiskSnapshot.activity24h?.transfers || 0} /{' '}
                  {selectedRiskSnapshot.activity7d?.transfers || 0}
                </p>
                <p className="text-sm text-neutral-200">
                  Bonus usage: {selectedRiskSnapshot.activity24h?.bonus || 0} /{' '}
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
                onClick={() => void handleFlagRiskPlayer()}
                disabled={riskActionLoading === `flag-${selectedRiskSnapshot.playerUid}`}
                className="rounded-lg bg-rose-500 px-3 py-2 text-xs font-semibold text-white hover:bg-rose-400 disabled:opacity-60"
              >
                Flag player
              </button>
              <button
                type="button"
                onClick={() => void handleSendRiskAlertToStaff()}
                disabled={riskActionLoading === `alert-${selectedRiskSnapshot.playerUid}`}
                className="rounded-lg bg-white/15 px-3 py-2 text-xs font-semibold text-white hover:bg-white/25 disabled:opacity-60"
              >
                Send alert to staff
              </button>
            </div>
          </div>
        </div>
      )}

      {showPaymentDetailsPanel && (
        <div
          onClick={() => setShowPaymentDetailsPanel(false)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 px-4"
        >
          <div
            onClick={(event) => event.stopPropagation()}
            className="w-full max-w-xl rounded-3xl border border-white/20 bg-neutral-900 p-6 shadow-2xl"
          >
            <h3 className="text-2xl font-bold text-white">Payment Details</h3>
            <p className="mt-2 text-sm text-neutral-400">
              Add your payment QR and details. Coadmin will use this for cashout transfer.
            </p>

            <label className="mt-4 block text-sm text-neutral-300">
              Payment QR URL
              <input
                value={paymentQrUrl}
                onChange={(event) => setPaymentQrUrl(event.target.value)}
                placeholder="https://example.com/qr-image.png"
                className="mt-2 w-full rounded-xl border border-white/10 bg-black px-4 py-3 text-white outline-none focus:border-white/30"
              />
            </label>
            <div className="mt-4">
              <ImageUploadField
                label="Upload payment QR image"
                valueUrl={paymentQrUrl}
                autoUpload
                onUploaded={(uploaded) => {
                  setPaymentQrUrl(uploaded.url);
                  setPaymentQrPublicId(uploaded.publicId);
                  setNoticeMessage('Image uploaded successfully.');
                  setErrorMessage('');
                }}
                onError={() => {
                  setErrorMessage('Image upload failed. Please try again.');
                }}
              />
            </div>

            <label className="mt-4 block text-sm text-neutral-300">
              Payment Notes / UPI / Bank Details
              <textarea
                value={paymentDetails}
                onChange={(event) => setPaymentDetails(event.target.value)}
                placeholder="UPI ID / account details / notes"
                className="mt-2 min-h-24 w-full rounded-xl border border-white/10 bg-black px-4 py-3 text-white outline-none focus:border-white/30"
              />
            </label>

            <div className="mt-5 flex gap-3">
              <button
                type="button"
                onClick={() => setShowPaymentDetailsPanel(false)}
                className="flex-1 rounded-xl bg-white/10 px-4 py-3 font-semibold text-white hover:bg-white/20"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleSavePaymentDetails()}
                disabled={savingPaymentDetails}
                className="flex-1 rounded-xl bg-white px-4 py-3 font-semibold text-black hover:bg-neutral-200 disabled:opacity-60"
              >
                {savingPaymentDetails ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showInquiryPanel && (
        <div
          onClick={() => setShowInquiryPanel(false)}
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 px-4"
        >
          <div
            onClick={(event) => event.stopPropagation()}
            className="w-full max-w-xl rounded-3xl border border-red-400/40 bg-red-950 p-6 shadow-2xl"
          >
            <h3 className="text-2xl font-bold text-white">Urgent Inquiry</h3>
            <p className="mt-2 text-sm text-red-100/80">
              Write a clear urgent message. This will be shown as a red splash to coadmin and staff.
            </p>

            <label className="mt-4 block text-sm text-red-100">
              Inquiry message
              <textarea
                value={inquiryMessage}
                onChange={(event) => setInquiryMessage(event.target.value)}
                placeholder="Write the issue clearly..."
                className="mt-2 min-h-28 w-full rounded-xl border border-red-200/20 bg-black/40 px-4 py-3 text-white outline-none focus:border-red-300"
              />
            </label>

            <div className="mt-5 flex gap-3">
              <button
                type="button"
                onClick={() => setShowInquiryPanel(false)}
                className="flex-1 rounded-xl bg-white/10 px-4 py-3 font-semibold text-white hover:bg-white/20"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleSendInquiry()}
                disabled={sendingInquiry}
                className="flex-1 rounded-xl bg-white px-4 py-3 font-semibold text-black hover:bg-neutral-200 disabled:opacity-60"
              >
                {sendingInquiry ? 'Sending...' : 'Send Urgent'}
              </button>
            </div>
          </div>
        </div>
      )}

      {loginDetailsTask && (
        <div
          onClick={() => setLoginDetailsTask(null)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 px-4"
        >
          <div
            onClick={(event) => event.stopPropagation()}
            className="w-full max-w-xl rounded-3xl border border-white/20 bg-neutral-900 p-6 shadow-2xl"
          >
            <h3 className="text-2xl font-bold text-white">Login Details</h3>
            <p className="mt-2 text-sm text-neutral-400">
              {(loginDetailsTask.playerUsername || 'Unknown player').trim()} /{' '}
              {(loginDetailsTask.gameName || 'Unknown Game').trim()}
            </p>

            {(() => {
              const relatedPlayerLogin =
                allPlayerLogins.find(
                  (login) =>
                    login.playerUid === loginDetailsTask.playerUid &&
                    normalizeGameName(login.gameName || '') ===
                      normalizeGameName(loginDetailsTask.gameName || '')
                ) || null;
              const relatedCoadminGame =
                gameOptions.find(
                  (game) =>
                    normalizeGameName(game.gameName || '') ===
                    normalizeGameName(loginDetailsTask.gameName || '')
                ) || null;

              if (!relatedPlayerLogin && !relatedCoadminGame) {
                return (
                  <div className="mt-4 rounded-2xl border border-yellow-500/30 bg-yellow-500/10 p-4 text-sm text-yellow-100">
                    No login details found yet for this player/game.
                  </div>
                );
              }

              return (
                <div className="mt-4 space-y-3">
                  <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                    <p className="text-xs text-neutral-400">Game Name</p>
                    <p className="mt-1 text-lg font-semibold text-white">
                      {relatedPlayerLogin?.gameName ||
                        relatedCoadminGame?.gameName ||
                        'Unknown Game'}
                    </p>
                  </div>
                  <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                    <p className="text-xs text-neutral-400">
                      Username (Coadmin Game List)
                    </p>
                    <p className="mt-1 text-lg font-semibold text-white">
                      {relatedCoadminGame?.username || relatedPlayerLogin?.gameUsername || 'Not set'}
                    </p>
                  </div>
                  <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                    <p className="text-xs text-neutral-400">
                      Password (Coadmin Game List)
                    </p>
                    <p className="mt-1 text-lg font-semibold text-white break-all">
                      {relatedCoadminGame?.password || relatedPlayerLogin?.gamePassword || 'Not set'}
                    </p>
                  </div>
                  <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                    <p className="text-xs text-neutral-400">Game Site Link</p>
                    {relatedCoadminGame?.backendUrl || relatedCoadminGame?.siteUrl ? (
                      <a
                        href={normalizeSiteUrl(
                          relatedCoadminGame.backendUrl || relatedCoadminGame.siteUrl
                        )}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-1 block break-all text-lg font-semibold text-cyan-300 underline underline-offset-2 hover:text-cyan-200"
                      >
                        {relatedCoadminGame.backendUrl || relatedCoadminGame.siteUrl}
                      </a>
                    ) : (
                      <p className="mt-1 text-lg font-semibold text-white">Not set</p>
                    )}
                  </div>
                  {relatedPlayerLogin && (
                    <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-4">
                      <p className="text-xs text-emerald-200">Player Specific Username</p>
                      <p className="mt-1 text-sm text-white">
                        {relatedPlayerLogin.gameUsername || 'Not set'}
                      </p>
                      <p className="mt-2 text-xs text-emerald-200">Player Specific Password</p>
                      <p className="mt-1 text-sm text-white break-all">
                        {relatedPlayerLogin.gamePassword || 'Not set'}
                      </p>
                    </div>
                  )}
                </div>
              );
            })()}

            <button
              type="button"
              onClick={() => setLoginDetailsTask(null)}
              className="mt-5 w-full rounded-2xl bg-white px-4 py-3 font-bold text-black hover:bg-neutral-200"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {pendingTaskPayloadPreview && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/80 px-4"
          onClick={() => setPendingTaskPayloadPreview(null)}
        >
          <div
            className="w-full max-w-3xl rounded-3xl border border-violet-500/30 bg-neutral-950 p-6 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <h3 className="text-2xl font-bold text-white">Pending Task Payload Preview</h3>
            <p className="mt-2 text-sm text-violet-100/80">
              This is the data prepared before creating the automation job.
            </p>

            <div className="mt-4 overflow-auto rounded-2xl border border-white/10 bg-black/40 p-4">
              <pre className="text-xs leading-relaxed text-neutral-100">
                {JSON.stringify(
                  (() => {
                    const loginForTask =
                      allPlayerLogins.find(
                        (login) =>
                          login.playerUid === pendingTaskPayloadPreview.playerUid &&
                          normalizeGameName(login.gameName || '') ===
                            normalizeGameName(pendingTaskPayloadPreview.gameName || '')
                      ) || null;
                    const currentUsername =
                      String(
                        loginForTask?.gameUsername ||
                          (
                            pendingTaskPayloadPreview as {
                              currentUsername?: string | null;
                              gameAccountUsername?: string | null;
                            }
                          ).currentUsername ||
                          (
                            pendingTaskPayloadPreview as {
                              currentUsername?: string | null;
                              gameAccountUsername?: string | null;
                            }
                          ).gameAccountUsername ||
                          ''
                      ).trim() || null;
                    const carerUid = carerIdentity?.uid || '';
                    const carerName = carerIdentity?.username?.trim() || 'Carer';
                    const mappedType = mapCarerTaskToAutomationType(pendingTaskPayloadPreview);
                    const freshTask = {
                      ...pendingTaskPayloadPreview,
                      status: 'in_progress',
                      assignedCarerUid: carerUid,
                      assignedCarer: carerName,
                      assignedCarerUsername: carerName,
                      currentUsername,
                    } as Record<string, unknown>;

                    return {
                      taskId: pendingTaskPayloadPreview.id,
                      type: mappedType,
                      carerUid: carerUid || null,
                      coadminUid: String(
                        pendingTaskPayloadPreview.coadminUid || coadminUid || ''
                      ).trim(),
                      currentUsername,
                      amount: pendingTaskPayloadPreview.amount ?? null,
                      payload: buildAutomationPayload({
                        taskId: pendingTaskPayloadPreview.id,
                        freshTask,
                        currentUserUid: carerUid,
                        currentCarerName: carerName,
                        currentUsername,
                      }),
                    };
                  })(),
                  null,
                  2
                )}
              </pre>
            </div>

            <button
              type="button"
              onClick={() => setPendingTaskPayloadPreview(null)}
              className="mt-5 w-full rounded-2xl bg-white px-4 py-3 font-bold text-black hover:bg-neutral-200"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </ProtectedRoute>
  );
}
