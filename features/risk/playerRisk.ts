import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';

import { assertClientFirestoreDisabled } from '@/lib/client/clientFirestoreGuard';
import { auth, db } from '@/lib/firebase/client';
import { resolveCoadminUid } from '@/lib/coadmin/scope';
import {
  getPlayerApiHeaders,
  PlayerSessionStaleError,
} from '@/features/auth/playerSession';

const PLAYER_TRANSFER_SESSION_EXPIRED_MESSAGE =
  'Session expired. Please refresh or log in again.';

type TransferDirection = 'cash_to_coin' | 'coin_to_cash';

type PlayerTransferApiPayload = {
  error?: string | boolean;
  message?: string;
  cash?: number;
  coin?: number;
  cashBalance?: number;
  coinBalance?: number;
  cashBoxNpr?: number | null;
  transferAmount?: number;
  feeAmount?: number;
  tipAmount?: number;
  coinsReceived?: number;
  cashReceived?: number;
  transferId?: string;
  eventId?: string;
  authority?: string;
};

function mapPlayerTransferAuthError(error: unknown) {
  if (error instanceof PlayerSessionStaleError) {
    return PLAYER_TRANSFER_SESSION_EXPIRED_MESSAGE;
  }
  const message = error instanceof Error ? error.message : '';
  if (/not authenticated|authorization|session|token/i.test(message)) {
    return PLAYER_TRANSFER_SESSION_EXPIRED_MESSAGE;
  }
  return message;
}

function mapPlayerTransferApiError(
  status: number,
  payload: PlayerTransferApiPayload,
  fallback: string
) {
  const raw =
    payload.message ||
    (typeof payload.error === 'string' ? payload.error : '') ||
    '';
  if (status === 401 || /not authenticated|authorization|session|token/i.test(raw)) {
    return PLAYER_TRANSFER_SESSION_EXPIRED_MESSAGE;
  }
  return raw || fallback;
}

async function postPlayerTransferApi(input: {
  direction: TransferDirection;
  path: string;
  body: Record<string, unknown>;
  transferId?: string;
  failureFallback: string;
}) {
  console.info('[PLAYER_TRANSFER_FETCH_CREDENTIALS]', {
    include: true,
    direction: input.direction,
    transferId: input.transferId || null,
  });
  console.info('[PLAYER_TRANSFER_API_REQUEST]', {
    direction: input.direction,
    transferId: input.transferId || null,
    ...input.body,
  });
  console.info('[PLAYER_TRANSFER_CLIENT_FIRESTORE_BLOCKED]', {
    direction: input.direction,
    reason: 'server_sql_authority_route',
  });

  let headers: Record<string, string>;
  try {
    headers = await getPlayerApiHeaders(true, { route: input.path });
  } catch (error) {
    const errorMessage =
      mapPlayerTransferAuthError(error) || input.failureFallback;
    console.info('[PLAYER_TRANSFER_API_ERROR]', {
      direction: input.direction,
      transferId: input.transferId || null,
      status: null,
      error: errorMessage,
      phase: 'headers',
    });
    throw new Error(errorMessage);
  }

  const response = await fetch(input.path, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify(input.body),
  });

  const payload = (await response.json().catch(() => ({}))) as PlayerTransferApiPayload;
  console.info('[PLAYER_TRANSFER_API_RESPONSE]', {
    direction: input.direction,
    transferId: input.transferId || null,
    ok: response.ok,
    status: response.status,
    authority: payload.authority || null,
    body: payload,
  });

  if (!response.ok) {
    const errorMessage = mapPlayerTransferApiError(
      response.status,
      payload,
      input.failureFallback
    );
    console.info('[PLAYER_TRANSFER_API_ERROR]', {
      direction: input.direction,
      transferId: input.transferId || null,
      status: response.status,
      error: errorMessage,
      phase: 'response',
    });
    throw new Error(errorMessage);
  }

  return payload;
}

export type RiskLevel = 'low' | 'medium' | 'high';
export type TransferRequestStatus = 'pending' | 'approved' | 'rejected';
export type FinancialEventType =
  | 'deposit'
  | 'cashout'
  | 'transfer'
  | 'bonus'
  | 'recharge'
  | 'redeem'
  | 'cash_to_coin_transfer'
  | 'coin_to_cash_transfer'
  | 'coadmin_coin_add'
  | 'coadmin_coin_deduct'
  | 'coadmin_cash_add'
  | 'coadmin_cash_deduct'
  | 'recharge_refund';

export type FinancialActivityWindow = {
  cashouts: number;
  transfers: number;
  bonus: number;
  deposits: number;
};

export type TransferRequest = {
  id: string;
  playerUid: string;
  playerUsername: string;
  coadminUid: string;
  amountNpr: number;
  cashBalanceSnapshot: number;
  status: TransferRequestStatus;
  requestedByUid: string;
  requestedByUsername: string;
  requestedAt?: Date | null;
  approvedByUid?: string | null;
  approvedByUsername?: string | null;
  approvedAt?: Date | null;
  rejectedByUid?: string | null;
  rejectedByUsername?: string | null;
  rejectedAt?: Date | null;
  rejectionReason?: string | null;
  autoApproved?: boolean;
  reviewed?: boolean;
  processedAt?: Date | null;
};

type FinancialEvent = {
  playerUid: string;
  coadminUid: string;
  amountNpr: number;
  type: FinancialEventType;
  createdAt?: Date | null;
};

type HistoricalSourceRow = {
  amountNpr: number;
  createdAt?: Date | null;
  type: FinancialEventType;
};

export type PlayerRiskSnapshot = {
  playerUid: string;
  playerUsername: string;
  coadminUid: string;
  totalDeposits: number;
  totalCashouts: number;
  totalTransfers: number;
  totalBonusClaimed: number;
  transferCount24h: number;
  transferCount7d: number;
  transferCount30d: number;
  cashoutCount24h: number;
  cashoutCount7d: number;
  cashoutCount30d: number;
  activity24h: FinancialActivityWindow;
  activity7d: FinancialActivityWindow;
  depositToCashoutRatio: number;
  bonusToDepositRatio: number;
  cycleCount: number;
  riskScore: number;
  riskLevel: RiskLevel;
  alerts: string[];
  reviewedAt?: Date | null;
  reviewedByUid?: string | null;
  reviewedByUsername?: string | null;
  bonusBlockedUntil?: Date | null;
  transferBlockedUntil?: Date | null;
  lastActivityAt?: Date | null;
  updatedAt?: Date | null;
};

type ActorIdentity = {
  uid: string;
  username: string;
  role: string;
  coadminUid: string;
};

const TRANSFER_COOLDOWN_MS = 2 * 60 * 1000;
const AUTO_APPROVE_DAILY_TRANSFER_COUNT = 0;
const FAST_CASHOUT_WINDOW_MS = 60 * 60 * 1000;
const BONUS_AFTER_TRANSFER_WINDOW_MS = 24 * 60 * 60 * 1000;
const LOW_DEPOSIT_WITHDRAWAL_RATIO = 1.4;
const TEMP_BLOCK_DURATION_MS = 12 * 60 * 60 * 1000;

function toMs(value?: unknown) {
  if (!value) {
    return 0;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  const maybe = value as { toMillis?: () => number; toDate?: () => Date; seconds?: number };
  if (typeof maybe.toMillis === 'function') {
    return maybe.toMillis();
  }
  if (typeof maybe.toDate === 'function') {
    return maybe.toDate().getTime();
  }
  if (typeof maybe.seconds === 'number') {
    return maybe.seconds * 1000;
  }
  return 0;
}

function getStartMs(windowMs: number) {
  return Date.now() - windowMs;
}

function getDayStartMs() {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now.getTime();
}

function mapTransferRequest(docId: string, value: Omit<TransferRequest, 'id'>): TransferRequest {
  return { id: docId, ...value };
}

async function getCurrentActorIdentity() {
  const currentUser = auth.currentUser;

  if (!currentUser) {
    throw new Error('Not authenticated.');
  }

  const userSnap = await getDoc(doc(db, 'users', currentUser.uid));

  if (!userSnap.exists()) {
    throw new Error('Current user profile not found.');
  }

  const userData = userSnap.data() as {
    username?: string;
    role?: string;
    coadminUid?: string | null;
    createdBy?: string | null;
  };
  const role = String(userData.role || '').toLowerCase();
  const coadminUid =
    role === 'coadmin'
      ? currentUser.uid
      : String(userData.coadminUid || userData.createdBy || '').trim();

  return {
    uid: currentUser.uid,
    username: userData.username?.trim() || 'User',
    role,
    coadminUid,
  } satisfies ActorIdentity;
}

async function createRiskAction(values: {
  playerUid: string;
  playerUsername?: string;
  coadminUid?: string;
  action: string;
  details?: string;
}) {
  let actor: ActorIdentity | null = null;
  try {
    actor = await getCurrentActorIdentity();
  } catch {
    actor = null;
  }

  await addDoc(collection(db, 'riskActions'), {
    playerUid: values.playerUid,
    playerUsername: values.playerUsername || 'Player',
    coadminUid: values.coadminUid || actor?.coadminUid || null,
    action: values.action,
    details: values.details || null,
    actorUid: actor?.uid || null,
    actorUsername: actor?.username || 'System',
    actorRole: actor?.role || 'system',
    createdAt: serverTimestamp(),
  });
}

function countByTypeWithin(events: FinancialEvent[], type: FinancialEventType, windowMs: number) {
  const startMs = getStartMs(windowMs);
  return events.filter((event) => event.type === type && toMs(event.createdAt) >= startMs).length;
}

function activityWindow(events: FinancialEvent[], windowMs: number): FinancialActivityWindow {
  const startMs = getStartMs(windowMs);
  const scoped = events.filter((event) => toMs(event.createdAt) >= startMs);
  return {
    cashouts: scoped.filter((event) => event.type === 'cashout').length,
    transfers: scoped.filter((event) => event.type === 'transfer').length,
    bonus: scoped.filter((event) => event.type === 'bonus').length,
    deposits: scoped.filter((event) => event.type === 'deposit' || event.type === 'recharge').length,
  };
}

function calculateCycleCount(events: FinancialEvent[]) {
  const sorted = [...events].sort((left, right) => toMs(left.createdAt) - toMs(right.createdAt));
  let phase = 0;
  let cycles = 0;

  sorted.forEach((event) => {
    if (phase === 0 && event.type === 'cashout') {
      phase = 1;
      return;
    }
    if (phase === 1 && event.type === 'transfer') {
      phase = 2;
      return;
    }
    if (phase === 2 && event.type === 'bonus') {
      phase = 3;
      return;
    }
    if (phase === 3 && event.type === 'cashout') {
      cycles += 1;
      phase = 1;
      return;
    }
    if (event.type === 'cashout') {
      phase = 1;
    }
  });

  return cycles;
}

function hasBonusAfterTransfer(events: FinancialEvent[]) {
  const transfers = events.filter((event) => event.type === 'transfer');
  const bonuses = events.filter((event) => event.type === 'bonus');
  return transfers.some((transfer) => {
    const transferMs = toMs(transfer.createdAt);
    return bonuses.some((bonus) => {
      const bonusMs = toMs(bonus.createdAt);
      return bonusMs >= transferMs && bonusMs - transferMs <= BONUS_AFTER_TRANSFER_WINDOW_MS;
    });
  });
}

function hasFastCashoutAfterBonus(events: FinancialEvent[]) {
  const bonuses = events.filter((event) => event.type === 'bonus');
  const cashouts = events.filter((event) => event.type === 'cashout');
  return bonuses.some((bonus) => {
    const bonusMs = toMs(bonus.createdAt);
    return cashouts.some((cashout) => {
      const cashoutMs = toMs(cashout.createdAt);
      return cashoutMs >= bonusMs && cashoutMs - bonusMs <= FAST_CASHOUT_WINDOW_MS;
    });
  });
}

async function loadPlayerEvents(playerUid: string) {
  const snapshot = await getDocs(query(collection(db, 'financialEvents'), where('playerUid', '==', playerUid)));
  return snapshot.docs.map((docSnap) => docSnap.data() as FinancialEvent);
}

async function loadHistoricalPlayerEvents(playerUid: string) {
  const [cashoutSnap, transferSnap, requestSnap] = await Promise.all([
    getDocs(
      query(
        collection(db, 'playerCashoutTasks'),
        where('playerUid', '==', playerUid),
        where('status', '==', 'completed')
      )
    ),
    getDocs(
      query(
        collection(db, 'transferRequests'),
        where('playerUid', '==', playerUid),
        where('status', '==', 'approved')
      )
    ),
    getDocs(
      query(
        collection(db, 'playerGameRequests'),
        where('playerUid', '==', playerUid),
        where('status', '==', 'completed')
      )
    ),
  ]);

  const cashoutRows: HistoricalSourceRow[] = cashoutSnap.docs.map((docSnap) => {
    const value = docSnap.data() as { amountNpr?: number; completedAt?: Date | null };
    return {
      amountNpr: Number(value.amountNpr || 0),
      createdAt: value.completedAt || null,
      type: 'cashout',
    };
  });

  const transferRows: HistoricalSourceRow[] = transferSnap.docs.map((docSnap) => {
    const value = docSnap.data() as { amountNpr?: number; approvedAt?: Date | null };
    return {
      amountNpr: Number(value.amountNpr || 0),
      createdAt: value.approvedAt || null,
      type: 'transfer',
    };
  });

  const requestRows: HistoricalSourceRow[] = requestSnap.docs.flatMap((docSnap) => {
    const value = docSnap.data() as {
      type?: string;
      amount?: number;
      completedAt?: Date | null;
      bonusPercentage?: number;
      baseAmount?: number;
    };
    const rows: HistoricalSourceRow[] = [];
    const completedAt = value.completedAt || null;
    const amount = Number(value.amount || 0);

    if (value.type === 'recharge' && amount > 0) {
      rows.push({
        amountNpr: amount,
        createdAt: completedAt,
        type: 'deposit',
      });

      const baseAmount = Math.max(0, Number(value.baseAmount || 0));
      const bonusAmount = Math.max(0, amount - baseAmount);
      if (bonusAmount > 0 || Number(value.bonusPercentage || 0) > 0) {
        rows.push({
          amountNpr: bonusAmount,
          createdAt: completedAt,
          type: 'bonus',
        });
      }
    }

    if (value.type === 'redeem' && amount > 0) {
      rows.push({
        amountNpr: amount,
        createdAt: completedAt,
        type: 'redeem',
      });
    }

    return rows;
  });

  return [...cashoutRows, ...transferRows, ...requestRows];
}

function mergeFinancialEvents(primary: FinancialEvent[], historical: HistoricalSourceRow[]) {
  const merged: FinancialEvent[] = [...primary];
  const index = new Set(
    primary.map((event) => `${event.type}:${Math.round(Number(event.amountNpr || 0))}:${toMs(event.createdAt || null)}`)
  );

  historical.forEach((item) => {
    const key = `${item.type}:${Math.round(Number(item.amountNpr || 0))}:${toMs(item.createdAt || null)}`;
    if (index.has(key)) {
      return;
    }
    index.add(key);
    merged.push({
      playerUid: '',
      coadminUid: '',
      amountNpr: Number(item.amountNpr || 0),
      type: item.type,
      createdAt: item.createdAt || null,
    });
  });

  return merged;
}

export async function computeAndStorePlayerRiskSnapshot(playerUid: string) {
  const playerSnap = await getDoc(doc(db, 'users', playerUid));

  if (!playerSnap.exists()) {
    return;
  }

  const playerData = playerSnap.data() as {
    username?: string;
    coadminUid?: string | null;
    createdBy?: string | null;
    bonusBlockedUntil?: Date | null;
    transferBlockedUntil?: Date | null;
  };
  const coadminUid = String(playerData.coadminUid || playerData.createdBy || '').trim();
  const [financialEvents, historicalEvents] = await Promise.all([
    loadPlayerEvents(playerUid),
    loadHistoricalPlayerEvents(playerUid),
  ]);
  const events = mergeFinancialEvents(financialEvents, historicalEvents);

  const totalDeposits = events
    .filter((event) => event.type === 'deposit' || event.type === 'recharge')
    .reduce((sum, event) => sum + Number(event.amountNpr || 0), 0);
  const totalCashouts = events
    .filter((event) => event.type === 'cashout')
    .reduce((sum, event) => sum + Number(event.amountNpr || 0), 0);
  const totalTransfers = events
    .filter((event) => event.type === 'transfer')
    .reduce((sum, event) => sum + Number(event.amountNpr || 0), 0);
  const totalBonusClaimed = events
    .filter((event) => event.type === 'bonus')
    .reduce((sum, event) => sum + Number(event.amountNpr || 0), 0);

  const transferCount24h = countByTypeWithin(events, 'transfer', 24 * 60 * 60 * 1000);
  const transferCount7d = countByTypeWithin(events, 'transfer', 7 * 24 * 60 * 60 * 1000);
  const transferCount30d = countByTypeWithin(events, 'transfer', 30 * 24 * 60 * 60 * 1000);
  const cashoutCount24h = countByTypeWithin(events, 'cashout', 24 * 60 * 60 * 1000);
  const cashoutCount7d = countByTypeWithin(events, 'cashout', 7 * 24 * 60 * 60 * 1000);
  const cashoutCount30d = countByTypeWithin(events, 'cashout', 30 * 24 * 60 * 60 * 1000);

  const depositToCashoutRatio = Number((totalDeposits / Math.max(totalCashouts, 1)).toFixed(2));
  const bonusToDepositRatio = Number((totalBonusClaimed / Math.max(totalDeposits, 1)).toFixed(2));
  const cycleCount = calculateCycleCount(events);
  const bonusAfterTransfer = hasBonusAfterTransfer(events);
  const fastCashoutAfterBonus = hasFastCashoutAfterBonus(events);
  const lowDepositHighWithdrawal =
    (totalDeposits === 0 && totalCashouts > 0) ||
    (totalDeposits > 0 && totalCashouts > totalDeposits * LOW_DEPOSIT_WITHDRAWAL_RATIO);

  const alerts: string[] = [];
  let riskScore = 0;

  if (cashoutCount24h > 3) {
    riskScore += 2;
    alerts.push('High cashout frequency');
  }
  if (transferCount24h > 3) {
    riskScore += 2;
    alerts.push('High transfer frequency');
  }
  if (bonusAfterTransfer) {
    riskScore += 3;
    alerts.push('Bonus used after transfer');
  }
  if (fastCashoutAfterBonus) {
    riskScore += 3;
    alerts.push('Fast cashout after bonus');
  }
  if (lowDepositHighWithdrawal) {
    riskScore += 4;
    alerts.push('Low deposit, high withdrawal');
  }
  if (cycleCount > 0) {
    riskScore += 2;
    alerts.push('Repeated recycle pattern detected');
  }

  const riskLevel: RiskLevel = riskScore >= 8 ? 'high' : riskScore >= 4 ? 'medium' : 'low';
  const sortedEvents = [...events].sort((left, right) => toMs(right.createdAt) - toMs(left.createdAt));
  const lastActivityAt = sortedEvents[0]?.createdAt || null;

  await setDoc(
    doc(db, 'playerRiskSnapshots', playerUid),
    {
      playerUid,
      playerUsername: playerData.username?.trim() || 'Player',
      coadminUid,
      totalDeposits,
      totalCashouts,
      totalTransfers,
      totalBonusClaimed,
      transferCount24h,
      transferCount7d,
      transferCount30d,
      cashoutCount24h,
      cashoutCount7d,
      cashoutCount30d,
      activity24h: activityWindow(events, 24 * 60 * 60 * 1000),
      activity7d: activityWindow(events, 7 * 24 * 60 * 60 * 1000),
      depositToCashoutRatio,
      bonusToDepositRatio,
      cycleCount,
      riskScore,
      riskLevel,
      alerts,
      bonusBlockedUntil: playerData.bonusBlockedUntil || null,
      transferBlockedUntil: playerData.transferBlockedUntil || null,
      lastActivityAt,
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
}

export async function recordFinancialEvent(values: {
  playerUid: string;
  coadminUid: string;
  amountNpr: number;
  type: FinancialEventType;
}) {
  const eventRef = await addDoc(collection(db, 'financialEvents'), {
    playerUid: values.playerUid,
    coadminUid: values.coadminUid,
    amountNpr: Math.max(0, Number(values.amountNpr || 0)),
    type: values.type,
    createdAt: serverTimestamp(),
  });
  void (async () => {
    try {
      const token = await auth.currentUser?.getIdToken();
      if (!token) return;
      await fetch('/api/financial-events/cache/mirror', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          action: 'upsert',
          financialEventId: eventRef.id,
        }),
      });
    } catch (error) {
      console.warn('[FINANCIAL_EVENTS_CACHE] mirror failed', { firebaseId: eventRef.id, error });
    }
  })();
  const { recordDevUsageEstimate } = await import('@/features/dev/devUsageEstimates');
  recordDevUsageEstimate({
    financialEventsCreated: 1,
    estWrites: 1,
  });
}

export async function recordFinancialEventAndRefreshRisk(values: {
  playerUid: string;
  coadminUid: string;
  amountNpr: number;
  type: FinancialEventType;
}) {
  await recordFinancialEvent(values);
  await computeAndStorePlayerRiskSnapshot(values.playerUid);
}

export async function createCashToCoinTransferRequest(
  requestedAmountNpr?: number,
  transferId?: string
) {
  const payload = await postPlayerTransferApi({
    direction: 'cash_to_coin',
    path: '/api/player/transfer/cash-to-coin',
    transferId,
    failureFallback: 'Failed to transfer cash to coin.',
    body: { amountNpr: requestedAmountNpr ?? 0, transferId },
  });

  return {
    message: 'Cash transferred to coin.',
    cash: payload.cash ?? 0,
    coin: payload.coin ?? 0,
    cashBalance: payload.cashBalance ?? payload.cash ?? 0,
    coinBalance: payload.coinBalance ?? payload.coin ?? 0,
    cashBoxNpr: payload.cashBoxNpr ?? null,
    transferAmount: payload.transferAmount ?? requestedAmountNpr ?? 0,
    feeAmount: payload.feeAmount ?? 0,
    tipAmount: payload.tipAmount ?? 0,
    coinsReceived: payload.coinsReceived ?? 0,
    transferId: payload.transferId ?? transferId ?? '',
    eventId: payload.eventId ?? '',
  };
}

export async function createCoinToCashTransferRequest(
  requestedAmountCoins?: number,
  transferId?: string
) {
  const payload = await postPlayerTransferApi({
    direction: 'coin_to_cash',
    path: '/api/player/transfer/coin-to-cash',
    transferId,
    failureFallback: 'Failed to transfer coin to cash.',
    body: { amountCoins: requestedAmountCoins ?? 0, transferId },
  });

  return {
    message: 'Coin transferred to cash.',
    cash: payload.cash ?? 0,
    coin: payload.coin ?? 0,
    cashBalance: payload.cashBalance ?? payload.cash ?? 0,
    coinBalance: payload.coinBalance ?? payload.coin ?? 0,
    cashBoxNpr: payload.cashBoxNpr ?? null,
    transferAmount: payload.transferAmount ?? requestedAmountCoins ?? 0,
    feeAmount: payload.feeAmount ?? 0,
    tipAmount: payload.tipAmount ?? 0,
    cashReceived: payload.cashReceived ?? 0,
    transferId: payload.transferId ?? transferId ?? '',
    eventId: payload.eventId ?? '',
  };
}

export async function approveTransferRequest(requestId: string) {
  const requestRef = doc(db, 'transferRequests', requestId);
  const requestSnap = await getDoc(requestRef);
  if (!requestSnap.exists()) {
    throw new Error('Transfer request not found.');
  }
  const requestData = requestSnap.data() as Omit<TransferRequest, 'id'>;
  const token = await auth.currentUser?.getIdToken();
  if (!token) throw new Error('Not authenticated.');
  const response = await fetch('/api/risk/transfer-requests/approve', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ requestId }),
  });
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to approve transfer request.');
  }

  await createRiskAction({
    playerUid: requestData.playerUid,
    coadminUid: requestData.coadminUid || '',
    playerUsername: requestData.playerUsername || 'Player',
    action: 'transfer_request_approved',
    details:
      'Most profit comes from cashouts. Repeated cash-to-coin transfers may reduce long-term gains. Use this mainly for gameplay retention.',
  });
}

export async function rejectTransferRequest(requestId: string, reason?: string) {
  const actor = await getCurrentActorIdentity();
  const requestRef = doc(db, 'transferRequests', requestId);
  const requestSnap = await getDoc(requestRef);

  if (!requestSnap.exists()) {
    throw new Error('Transfer request not found.');
  }

  const requestData = requestSnap.data() as Omit<TransferRequest, 'id'>;

  if (requestData.status !== 'pending') {
    throw new Error('Transfer request already processed.');
  }

  await updateDoc(requestRef, {
    status: 'rejected',
    rejectedByUid: actor.uid,
    rejectedByUsername: actor.username,
    rejectedAt: serverTimestamp(),
    rejectionReason: reason || 'Transfer denied due to suspected misuse.',
    processedAt: serverTimestamp(),
  });
  void (async () => {
    try {
      const token = await auth.currentUser?.getIdToken();
      if (!token) return;
      await fetch('/api/transfer-requests/cache/mirror', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ action: 'upsert', requestId }),
      });
    } catch (error) {
      console.warn('[TRANSFER_REQUESTS_CACHE] mirror failed', { requestId, error });
    }
  })();

  await createRiskAction({
    playerUid: requestData.playerUid,
    playerUsername: requestData.playerUsername,
    coadminUid: requestData.coadminUid,
    action: 'transfer_request_rejected',
    details: reason || 'Transfer denied due to suspected misuse.',
  });
}

export function listenPendingTransferRequestsByCoadminOrGlobal(
  coadminUid: string,
  onChange: (requests: TransferRequest[]) => void,
  onError?: (error: Error) => void
) {
  if (assertClientFirestoreDisabled('transfer_requests_pending_listener', 'onSnapshot', { coadminUid })) {
    onChange([]);
    return () => {};
  }

  const scopedQuery = coadminUid
    ? query(
        collection(db, 'transferRequests'),
        where('status', '==', 'pending'),
        where('coadminUid', '==', coadminUid)
      )
    : query(collection(db, 'transferRequests'), where('status', '==', 'pending'));

  return onSnapshot(
    scopedQuery,
    (snapshot) => {
      const requests = snapshot.docs
        .map((docSnap) => mapTransferRequest(docSnap.id, docSnap.data() as Omit<TransferRequest, 'id'>))
        .sort((left, right) => toMs(right.requestedAt || null) - toMs(left.requestedAt || null));
      onChange(requests);
    },
    (error) => onError?.(error as Error)
  );
}

export function listenTransferRequestsByPlayer(
  playerUid: string,
  onChange: (requests: TransferRequest[]) => void,
  onError?: (error: Error) => void
) {
  if (assertClientFirestoreDisabled('transfer_requests_player_listener', 'onSnapshot', { playerUid })) {
    onChange([]);
    return () => {};
  }

  const transfersQuery = query(collection(db, 'transferRequests'), where('playerUid', '==', playerUid));

  return onSnapshot(
    transfersQuery,
    (snapshot) => {
      const requests = snapshot.docs
        .map((docSnap) => mapTransferRequest(docSnap.id, docSnap.data() as Omit<TransferRequest, 'id'>))
        .sort((left, right) => toMs(right.requestedAt || null) - toMs(left.requestedAt || null));
      onChange(requests);
    },
    (error) => onError?.(error as Error)
  );
}

export function listenPlayerRiskSnapshotsByCoadmin(
  coadminUid: string,
  onChange: (snapshots: PlayerRiskSnapshot[]) => void,
  onError?: (error: Error) => void
) {
  if (assertClientFirestoreDisabled('player_risk_snapshots_listener', 'onSnapshot', { coadminUid })) {
    onChange([]);
    return () => {};
  }

  const riskQuery = coadminUid
    ? query(collection(db, 'playerRiskSnapshots'), where('coadminUid', '==', coadminUid))
    : collection(db, 'playerRiskSnapshots');

  return onSnapshot(
    riskQuery,
    (snapshot) => {
      const rows = snapshot.docs
        .map((docSnap) => docSnap.data() as PlayerRiskSnapshot)
        .sort((left, right) => (right.riskScore || 0) - (left.riskScore || 0));
      onChange(rows);
    },
    (error) => onError?.(error as Error)
  );
}

export async function getPlayerRiskSnapshot(playerUid: string) {
  await computeAndStorePlayerRiskSnapshot(playerUid);
  const snapshot = await getDoc(doc(db, 'playerRiskSnapshots', playerUid));
  return snapshot.exists() ? (snapshot.data() as PlayerRiskSnapshot) : null;
}

export async function markRiskReviewed(playerUid: string) {
  const actor = await getCurrentActorIdentity();
  const snapshotRef = doc(db, 'playerRiskSnapshots', playerUid);
  await setDoc(
    snapshotRef,
    {
      reviewedAt: serverTimestamp(),
      reviewedByUid: actor.uid,
      reviewedByUsername: actor.username,
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );

  await createRiskAction({
    playerUid,
    action: 'risk_marked_reviewed',
    details: 'Marked player risk as reviewed.',
  });
}

export async function setPlayerBonusBlock(playerUid: string, shouldBlock: boolean) {
  const until = shouldBlock ? new Date(Date.now() + TEMP_BLOCK_DURATION_MS) : null;
  await setDoc(doc(db, 'users', playerUid), { bonusBlockedUntil: until }, { merge: true });
  await setDoc(doc(db, 'playerRiskSnapshots', playerUid), { bonusBlockedUntil: until }, { merge: true });

  await createRiskAction({
    playerUid,
    action: shouldBlock ? 'bonus_block_enabled' : 'bonus_block_cleared',
    details: shouldBlock
      ? 'Bonus temporarily blocked due to risk review.'
      : 'Bonus block cleared.',
  });
}

export async function setPlayerTransferBlock(playerUid: string, shouldBlock: boolean) {
  const until = shouldBlock ? new Date(Date.now() + TEMP_BLOCK_DURATION_MS) : null;
  await setDoc(doc(db, 'users', playerUid), { transferBlockedUntil: until }, { merge: true });
  await setDoc(doc(db, 'playerRiskSnapshots', playerUid), { transferBlockedUntil: until }, { merge: true });

  await createRiskAction({
    playerUid,
    action: shouldBlock ? 'transfer_block_enabled' : 'transfer_block_cleared',
    details: shouldBlock
      ? 'Transfer temporarily blocked due to risk review.'
      : 'Transfer block cleared.',
  });
}

export async function flagPlayerRisk(values: { playerUid: string; reason: string; playerUsername?: string }) {
  const actor = await getCurrentActorIdentity();
  await createRiskAction({
    playerUid: values.playerUid,
    playerUsername: values.playerUsername,
    coadminUid: actor.coadminUid,
    action: 'player_flagged',
    details: values.reason,
  });
}

export async function sendRiskAlertToStaff(values: {
  playerUid: string;
  playerUsername: string;
  reason: string;
  coadminUid: string;
}) {
  const actor = await getCurrentActorIdentity();
  await addDoc(collection(db, 'carerEscalationAlerts'), {
    coadminUid: values.coadminUid,
    contextType: 'cashbox_inquiry',
    escalationFrom: 'risk_auto',
    taskId: null,
    playerUid: values.playerUid,
    playerUsername: values.playerUsername,
    gameName: null,
    message: values.reason,
    createdByCarerUid: actor.uid,
    createdByCarerUsername: actor.username,
    createdAt: serverTimestamp(),
  });

  await createRiskAction({
    playerUid: values.playerUid,
    playerUsername: values.playerUsername,
    coadminUid: values.coadminUid,
    action: 'risk_alert_sent_to_staff',
    details: values.reason,
  });
}

export function getTransferCooldownMs() {
  return TRANSFER_COOLDOWN_MS;
}

export function getRiskRuleConfig() {
  return {
    fastCashoutWindowMs: FAST_CASHOUT_WINDOW_MS,
    bonusAfterTransferWindowMs: BONUS_AFTER_TRANSFER_WINDOW_MS,
    lowDepositWithdrawalRatio: LOW_DEPOSIT_WITHDRAWAL_RATIO,
    autoApproveDailyTransferCount: AUTO_APPROVE_DAILY_TRANSFER_COUNT,
  };
}
