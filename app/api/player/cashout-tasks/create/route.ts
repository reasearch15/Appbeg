import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { evaluateWithdrawalPolicy } from '@/lib/economy/policy';
import { apiError, requireApiUser } from '@/lib/firebase/apiAuth';
import { adminDb } from '@/lib/firebase/admin';
import {
  getCoadminMaintenanceBreak,
  maintenanceBreakApiResponse,
  rejectIfPlayerMaintenanceBreak,
  rejectIfPlayerMaintenanceBreakFromUser,
} from '@/lib/maintenance/admin';
import { isCacheSqlAuthoritative } from '@/lib/server/cacheSqlRead';
import {
  authoritySqlWriteEnvLogFields,
  isAuthoritySqlWriteEnabled,
  logAuthorityFirestoreFallbackBlocked,
  logAuthoritySqlWrite,
} from '@/lib/server/authoritySqlWrite';
import { isDatabaseUrlConfigured, shouldBlockFirestoreFallback } from '@/lib/server/sqlRuntime';
import { createPlayerCashoutTaskInSql } from '@/lib/sql/authorityCashout';
import { getPlayerMirrorPoolStats } from '@/lib/sql/playerMirrorCommon';
import { mirrorFinancialEventById } from '@/lib/sql/financialEventsCache';
import { mirrorPlayerCashoutTaskById } from '@/lib/sql/playerCashoutTasksCache';
import { mirrorUserBalanceSnapshotById } from '@/lib/sql/userBalanceSnapshotsCache';

export const runtime = 'nodejs';

const ROUTE = '/api/player/cashout-tasks/create';
const PLAYER_CASHOUT_MAX_NPR_PER_24_H = 1000;
const PLAYER_CASHOUT_ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;

type Body = {
  coadminUid?: unknown;
  paymentDetails?: unknown;
  payoutMethod?: unknown;
  qrImageUrl?: unknown;
  paymentAppName?: unknown;
  paymentAppCashTag?: unknown;
  paymentAppAccountName?: unknown;
  reuseLastPaymentDetails?: unknown;
  idempotencyKey?: unknown;
};

type ResolvedCashoutPaymentDetails = {
  paymentDetails: string;
  payoutMethod: 'qr' | 'app';
  qrImageUrl: string | null;
  paymentAppName: string | null;
  paymentAppCashTag: string | null;
  paymentAppAccountName: string | null;
  reusedPaymentDetails: boolean;
  reusedFromCashoutTaskId: string | null;
};

async function fetchRolling24hCashoutUsageNprForPlayer(playerUid: string): Promise<number> {
  const since = new Date(Date.now() - PLAYER_CASHOUT_ROLLING_WINDOW_MS);
  const snapshot = await adminDb
    .collection('playerCashoutTasks')
    .where('playerUid', '==', playerUid)
    .where('createdAt', '>=', since)
    .get();
  let total = 0;
  snapshot.forEach((docSnap) => {
    const row = docSnap.data() as { status?: string; amountNpr?: number };
    if (String(row.status || '').toLowerCase() === 'declined') return;
    total += Math.max(0, Number(row.amountNpr || 0));
  });
  return total;
}

async function fetchCompletedCashoutCountForPlayer(playerUid: string): Promise<number> {
  const snapshot = await adminDb
    .collection('playerCashoutTasks')
    .where('playerUid', '==', playerUid)
    .where('status', '==', 'completed')
    .get();
  return snapshot.size;
}

async function fetchLatestCompletedRechargeAmountForPlayer(playerUid: string): Promise<number> {
  const snapshot = await adminDb
    .collection('playerGameRequests')
    .where('playerUid', '==', playerUid)
    .where('type', '==', 'recharge')
    .where('status', '==', 'completed')
    .orderBy('completedAt', 'desc')
    .limit(1)
    .get();
  const latest = snapshot.docs[0]?.data() as { amount?: number } | undefined;
  return Math.max(0, Math.round(Number(latest?.amount || 0)));
}

function ttlAfterDays(days: number) {
  const DAY_MS = 24 * 60 * 60 * 1000;
  return new Date(Date.now() + days * DAY_MS);
}

function buildPaymentDetails(input: {
  payoutMethod: string | null;
  qrImageUrl: string | null;
  paymentAppName: string | null;
  paymentAppCashTag: string | null;
  paymentAppAccountName: string | null;
}) {
  if (input.payoutMethod === 'qr') {
    return input.qrImageUrl ? `Payout method: QR\nQR image: ${input.qrImageUrl}` : '';
  }
  if (input.payoutMethod === 'app') {
    return [
      'Payout method: Payment app',
      input.paymentAppName ? `App name: ${input.paymentAppName}` : '',
      input.paymentAppCashTag ? `Cash tag: ${input.paymentAppCashTag}` : '',
      input.paymentAppAccountName ? `Name on app: ${input.paymentAppAccountName}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function normalizePayoutMethod(value: unknown): 'qr' | 'app' | null {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'qr') return 'qr';
  if (raw === 'app' || raw === 'payment app' || raw === 'payment_app') return 'app';
  return null;
}

function parsePaymentDetailsText(rawText: string) {
  const text = String(rawText || '').trim();
  if (/Payout method:\s*QR/i.test(text)) {
    const qrMatch = text.match(/QR image:\s*(.+)/i);
    return {
      payoutMethod: 'qr' as const,
      qrImageUrl: String(qrMatch?.[1] || '').trim() || null,
      paymentAppName: null as string | null,
      paymentAppCashTag: null as string | null,
      paymentAppAccountName: null as string | null,
    };
  }
  if (/Payout method:\s*Payment app/i.test(text)) {
    const appNameMatch = text.match(/App name:\s*(.+)/i);
    const cashTagMatch = text.match(/Cash tag:\s*(.+)/i);
    const accountNameMatch = text.match(/Name on app:\s*(.+)/i);
    return {
      payoutMethod: 'app' as const,
      qrImageUrl: null as string | null,
      paymentAppName: String(appNameMatch?.[1] || '').trim() || null,
      paymentAppCashTag: String(cashTagMatch?.[1] || '').trim() || null,
      paymentAppAccountName: String(accountNameMatch?.[1] || '').trim() || null,
    };
  }
  return {
    payoutMethod: null as 'qr' | 'app' | null,
    qrImageUrl: null as string | null,
    paymentAppName: null as string | null,
    paymentAppCashTag: null as string | null,
    paymentAppAccountName: null as string | null,
  };
}

function resolveUsablePaymentDetailsFromBody(input: {
  payoutMethod: string | null;
  qrImageUrl: string | null;
  paymentAppName: string | null;
  paymentAppCashTag: string | null;
  paymentAppAccountName: string | null;
  paymentDetails: string;
}): ResolvedCashoutPaymentDetails | null {
  let payoutMethod = normalizePayoutMethod(input.payoutMethod);
  let qrImageUrl = String(input.qrImageUrl || '').trim() || null;
  let paymentAppName = String(input.paymentAppName || '').trim() || null;
  let paymentAppCashTag = String(input.paymentAppCashTag || '').trim() || null;
  let paymentAppAccountName = String(input.paymentAppAccountName || '').trim() || null;
  const parsed = parsePaymentDetailsText(input.paymentDetails);

  if (!payoutMethod) {
    payoutMethod = parsed.payoutMethod;
  }
  if (payoutMethod === 'qr') {
    qrImageUrl = qrImageUrl || parsed.qrImageUrl;
  }
  if (payoutMethod === 'app') {
    paymentAppName = paymentAppName || parsed.paymentAppName;
    paymentAppCashTag = paymentAppCashTag || parsed.paymentAppCashTag;
    paymentAppAccountName = paymentAppAccountName || parsed.paymentAppAccountName;
  }

  if (payoutMethod === 'qr' && qrImageUrl) {
    const paymentDetails = buildPaymentDetails({
      payoutMethod: 'qr',
      qrImageUrl,
      paymentAppName: null,
      paymentAppCashTag: null,
      paymentAppAccountName: null,
    });
    if (paymentDetails.length < 5) return null;
    return {
      paymentDetails,
      payoutMethod: 'qr',
      qrImageUrl,
      paymentAppName: null,
      paymentAppCashTag: null,
      paymentAppAccountName: null,
      reusedPaymentDetails: true,
      reusedFromCashoutTaskId: null,
    };
  }

  if (
    payoutMethod === 'app' &&
    paymentAppName &&
    paymentAppCashTag &&
    paymentAppAccountName
  ) {
    const paymentDetails = buildPaymentDetails({
      payoutMethod: 'app',
      qrImageUrl: null,
      paymentAppName,
      paymentAppCashTag,
      paymentAppAccountName,
    });
    if (paymentDetails.length < 5) return null;
    return {
      paymentDetails,
      payoutMethod: 'app',
      qrImageUrl: null,
      paymentAppName,
      paymentAppCashTag,
      paymentAppAccountName,
      reusedPaymentDetails: true,
      reusedFromCashoutTaskId: null,
    };
  }

  return null;
}

async function resolveLastPaymentDetailsFromFirestore(
  playerUid: string
): Promise<ResolvedCashoutPaymentDetails | null> {
  const snapshot = await adminDb
    .collection('playerCashoutTasks')
    .where('playerUid', '==', playerUid)
    .get();

  const candidates = snapshot.docs
    .map((docSnap) => {
      const data = docSnap.data() as Record<string, unknown>;
      const status = String(data.status || '').trim().toLowerCase();
      if (status === 'declined' || status === 'cancelled' || status === 'failed') {
        return null;
      }
      const completedAtMs =
        typeof (data.completedAt as { toMillis?: () => number } | undefined)?.toMillis === 'function'
          ? (data.completedAt as { toMillis: () => number }).toMillis()
          : 0;
      const createdAtMs =
        typeof (data.createdAt as { toMillis?: () => number } | undefined)?.toMillis === 'function'
          ? (data.createdAt as { toMillis: () => number }).toMillis()
          : 0;
      const resolved = resolveUsablePaymentDetailsFromBody({
        payoutMethod: String(data.payoutMethod || '').trim() || null,
        qrImageUrl: String(data.qrImageUrl || '').trim() || null,
        paymentAppName: String(data.paymentAppName || '').trim() || null,
        paymentAppCashTag: String(data.paymentAppCashTag || '').trim() || null,
        paymentAppAccountName: String(data.paymentAppAccountName || '').trim() || null,
        paymentDetails: String(data.paymentDetails || '').trim(),
      });
      if (!resolved) {
        return null;
      }
      return {
        ...resolved,
        reusedFromCashoutTaskId: docSnap.id,
        sortMs: Math.max(completedAtMs, createdAtMs),
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    .sort((left, right) => right.sortMs - left.sortMs);

  const picked = candidates[0];
  if (!picked) {
    return null;
  }

  return {
    paymentDetails: picked.paymentDetails,
    payoutMethod: picked.payoutMethod,
    qrImageUrl: picked.qrImageUrl,
    paymentAppName: picked.paymentAppName,
    paymentAppCashTag: picked.paymentAppCashTag,
    paymentAppAccountName: picked.paymentAppAccountName,
    reusedPaymentDetails: true,
    reusedFromCashoutTaskId: picked.reusedFromCashoutTaskId,
  };
}

/** Staff/coadmin read SQL cache — create must write SQL when reads are SQL-authoritative. */
function shouldCreateCashoutInSql() {
  return (
    isAuthoritySqlWriteEnabled() ||
    (isCacheSqlAuthoritative() && isDatabaseUrlConfigured())
  );
}

export async function POST(request: Request) {
  console.info('[CASHOUT_CREATE_START]', {
    route: ROUTE,
    authority_sql_write: isAuthoritySqlWriteEnabled(),
    cache_sql_authoritative: isCacheSqlAuthoritative(),
    database_url_configured: isDatabaseUrlConfigured(),
    create_path: shouldCreateCashoutInSql() ? 'sql' : 'firestore',
  });
  try {
    const auth = await requireApiUser(request, ['player']);
    if ('response' in auth) return auth.response;

    console.info('[CASHOUT_CREATE_AUTH_OK]', {
      playerUid: auth.user.uid,
      role: auth.user.role,
      coadminUid: auth.user.coadminUid,
      authPath: auth.authPath,
    });

    const body = (await request.json()) as Body;
    const reuseLastPaymentDetails = body.reuseLastPaymentDetails === true;
    let paymentDetails = String(body.paymentDetails || '').trim();
    let payoutMethod = String(body.payoutMethod || '').trim() || null;
    let qrImageUrl = String(body.qrImageUrl || '').trim() || null;
    let paymentAppName = String(body.paymentAppName || '').trim() || null;
    let paymentAppCashTag = String(body.paymentAppCashTag || '').trim() || null;
    let paymentAppAccountName = String(body.paymentAppAccountName || '').trim() || null;
    let reusedFromCashoutTaskId: string | null = null;

    const idempotencyKey =
      String(body.idempotencyKey || request.headers.get('Idempotency-Key') || '').trim() || null;

    const requestedCoadminUid =
      auth.user.coadminUid ||
      String(body.coadminUid || '').trim() ||
      auth.user.createdBy ||
      null;

    if (shouldCreateCashoutInSql()) {
      if (!isDatabaseUrlConfigured()) {
        console.error('[CASHOUT_CREATE_FAILED]', {
          reason: 'database_url_missing',
          playerUid: auth.user.uid,
        });
        return apiError('Cashout is unavailable right now.', 503);
      }

      await rejectIfPlayerMaintenanceBreakFromUser(auth.user, 'cashout');

      console.info('[CASHOUT_CREATE_INSERT_START]', {
        playerUid: auth.user.uid,
        coadminUid: requestedCoadminUid,
        payoutMethod,
        reuseLastPaymentDetails,
        table: 'player_cashout_tasks_cache',
      });

      const result = await createPlayerCashoutTaskInSql({
        playerUid: auth.user.uid,
        playerUsername: auth.user.username,
        paymentDetails,
        payoutMethod,
        qrImageUrl,
        paymentAppName,
        paymentAppCashTag,
        paymentAppAccountName,
        reuseLastPaymentDetails,
        idempotencyKey,
        requestedCoadminUid,
      });
      const poolStats = getPlayerMirrorPoolStats();

      console.info('[CASHOUT_CREATE_TASK_ID]', {
        taskId: result.taskId,
        duplicate: result.duplicate,
        playerUid: auth.user.uid,
        coadminUid: requestedCoadminUid,
        table: 'player_cashout_tasks_cache',
        status: 'pending',
      });

      logAuthoritySqlWrite(ROUTE, {
        ...authoritySqlWriteEnvLogFields(),
        playerUid: auth.user.uid,
        taskId: result.taskId,
        duplicate: result.duplicate,
        route: ROUTE,
        pool_totalCount: poolStats?.totalCount ?? null,
        pool_idleCount: poolStats?.idleCount ?? null,
        pool_waitingCount: poolStats?.waitingCount ?? null,
        pool_max: poolStats?.max ?? null,
      });

      return NextResponse.json({
        success: true,
        taskId: result.taskId,
        duplicate: result.duplicate,
        authority: 'sql',
      });
    }

    if (shouldBlockFirestoreFallback()) {
      logAuthorityFirestoreFallbackBlocked(ROUTE, 'cashout_create', {
        playerUid: auth.user.uid,
        reason: 'sql_cache_authoritative_requires_sql_create',
      });
      console.error('[CASHOUT_CREATE_FAILED]', {
        reason: 'firestore_fallback_blocked',
        playerUid: auth.user.uid,
      });
      return apiError('Cashout create requires SQL authority.', 503);
    }

    await rejectIfPlayerMaintenanceBreak(auth.user.uid, 'cashout');

    if (reuseLastPaymentDetails) {
      const fromBody = resolveUsablePaymentDetailsFromBody({
        payoutMethod,
        qrImageUrl,
        paymentAppName,
        paymentAppCashTag,
        paymentAppAccountName,
        paymentDetails,
      });
      const resolved = fromBody || (await resolveLastPaymentDetailsFromFirestore(auth.user.uid));
      if (!resolved) {
        return apiError(
          'No previous payment details found. Please upload a QR or enter payment app details first.',
          400
        );
      }
      paymentDetails = resolved.paymentDetails;
      payoutMethod = resolved.payoutMethod;
      qrImageUrl = resolved.qrImageUrl;
      paymentAppName = resolved.paymentAppName;
      paymentAppCashTag = resolved.paymentAppCashTag;
      paymentAppAccountName = resolved.paymentAppAccountName;
      reusedFromCashoutTaskId = resolved.reusedFromCashoutTaskId;
    }

    const method = String(payoutMethod || '').trim().toLowerCase();
    if (method === 'qr') {
      if (!String(qrImageUrl || '').trim()) {
        return apiError('Upload your QR before sending cashout.', 400);
      }
      payoutMethod = 'qr';
      paymentAppName = null;
      paymentAppCashTag = null;
      paymentAppAccountName = null;
      paymentDetails =
        paymentDetails ||
        buildPaymentDetails({
          payoutMethod: 'qr',
          qrImageUrl,
          paymentAppName: null,
          paymentAppCashTag: null,
          paymentAppAccountName: null,
        });
    } else if (method === 'app') {
      if (
        !String(paymentAppName || '').trim() ||
        !String(paymentAppCashTag || '').trim() ||
        !String(paymentAppAccountName || '').trim()
      ) {
        return apiError(
          'Enter your payment app name, cash tag, and name on the app.',
          400
        );
      }
      payoutMethod = 'app';
      qrImageUrl = null;
      paymentDetails =
        paymentDetails ||
        buildPaymentDetails({
          payoutMethod: 'app',
          qrImageUrl: null,
          paymentAppName,
          paymentAppCashTag,
          paymentAppAccountName,
        });
    } else if (paymentDetails.length < 5) {
      return apiError('Please provide clear payment details.', 400);
    }

    const playerUid = auth.user.uid;
    const [rollingUsed, completedCashoutCount, lastRechargeAmountNpr] = await Promise.all([
      fetchRolling24hCashoutUsageNprForPlayer(playerUid),
      fetchCompletedCashoutCountForPlayer(playerUid),
      fetchLatestCompletedRechargeAmountForPlayer(playerUid),
    ]);
    const remainingQuota = Math.max(0, PLAYER_CASHOUT_MAX_NPR_PER_24_H - rollingUsed);
    const playerRef = adminDb.collection('users').doc(playerUid);
    const taskRef = adminDb.collection('playerCashoutTasks').doc();
    const eventRef = adminDb.collection('financialEvents').doc();

    await adminDb.runTransaction(async (transaction) => {
      const playerSnap = await transaction.get(playerRef);
      if (!playerSnap.exists) {
        throw new Error('Player profile not found.');
      }
      const playerData = playerSnap.data() as {
        role?: string;
        username?: string;
        cash?: number;
        coadminUid?: string | null;
        createdBy?: string | null;
      };
      if (String(playerData.role || '').toLowerCase() !== 'player') {
        throw new Error('Only players can create cashout tasks.');
      }

      const availableCash = Number(playerData.cash || 0);
      if (availableCash <= 0) {
        throw new Error('No cash available to cash out.');
      }
      const amountThisRequest = Math.min(availableCash, remainingQuota);
      const limitPassed = rollingUsed + amountThisRequest <= PLAYER_CASHOUT_MAX_NPR_PER_24_H;
      if (!limitPassed || amountThisRequest <= 0) {
        throw new Error('Maximum withdrawal is 1000 in 24 hours.');
      }

      const decision = evaluateWithdrawalPolicy({
        amountNpr: amountThisRequest,
        completedWithdrawalCount: completedCashoutCount,
        lastRechargeAmountNpr,
      });
      if (!decision.allowed) {
        throw new Error(decision.message);
      }

      const coadminUid =
        String(playerData.coadminUid || '').trim() || String(playerData.createdBy || '').trim();
      if (!coadminUid) {
        throw new Error('Player coadmin scope not found.');
      }
      const maintenanceBreak = await getCoadminMaintenanceBreak(coadminUid);
      if (maintenanceBreak.enabled) {
        console.info('[MAINTENANCE] blocked redeem request', { playerUid, coadminUid });
        throw new Error(`MAINTENANCE_BREAK:${maintenanceBreak.message}`);
      }

      transaction.update(playerRef, {
        cash: availableCash - amountThisRequest,
      });
      transaction.set(taskRef, {
        coadminUid,
        playerUid,
        playerUsername: String(playerData.username || '').trim() || 'Player',
        amountNpr: amountThisRequest,
        paymentDetails,
        payoutMethod,
        qrImageUrl,
        paymentAppName,
        paymentAppCashTag,
        paymentAppAccountName,
        reusedPaymentDetails: reuseLastPaymentDetails,
        reusedFromCashoutTaskId,
        cashDeductedOnRequest: true,
        status: 'pending',
        assignedHandlerUid: null,
        assignedHandlerUsername: null,
        startedAt: null,
        expiresAt: null,
        createdAt: FieldValue.serverTimestamp(),
        completedAt: null,
      });
      transaction.set(eventRef, {
        playerUid,
        coadminUid,
        amountNpr: amountThisRequest,
        type: 'cashout_request_deduct',
        cashoutTaskId: taskRef.id,
        createdAt: FieldValue.serverTimestamp(),
        ttlExpiresAt: ttlAfterDays(90),
      });
    });

    void mirrorFinancialEventById(eventRef.id, 'appbeg_cashout_create');
    void mirrorPlayerCashoutTaskById(taskRef.id, 'appbeg_cashout_create');
    void mirrorUserBalanceSnapshotById(playerUid, 'appbeg_cashout_create');
    return NextResponse.json({ success: true, taskId: taskRef.id, authority: 'firestore' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create cashout request.';
    const pgCode =
      error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code || '')
        : '';
    const isValidation =
      !pgCode &&
      /Maximum withdrawal|Possible Bonus|No cash|Please provide|Upload your QR|Enter your payment app|Only players|Duplicate cashout|No previous payment details/i.test(
        message
      );
    if (isValidation) {
      console.info('[CASHOUT_CREATE_VALIDATION_FAILED]', { message });
    } else {
      console.error('[CASHOUT_CREATE_FAILED]', { message, pgCode: pgCode || null, error });
    }
    if (message.startsWith('MAINTENANCE_BREAK:')) {
      return maintenanceBreakApiResponse(message.replace(/^MAINTENANCE_BREAK:/, ''));
    }
    const status =
      pgCode
        ? 500
        : /not authenticated|authorization|token/i.test(message)
          ? 401
          : /forbidden|outside your scope/i.test(message)
            ? 403
            : /already|conflict|not available/i.test(message)
              ? 409
              : isValidation ||
                  /Maximum withdrawal|Possible Bonus|No cash|Please provide|Only players|Player profile not found/i.test(
                    message
                  )
                ? 400
                : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
