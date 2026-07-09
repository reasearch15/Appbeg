import {
  getDocs,
  limit,
  writeBatch,
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  updateDoc,
  where,
} from 'firebase/firestore';

import { getCachedSessionUser } from '@/features/auth/sessionUser';
import { requireSqlSessionUid } from '@/lib/client/carerSessionIdentity';
import { getSqlApiReadHeaders } from '@/lib/client/sqlApiHeaders';
import { auth, db } from '@/lib/firebase/client';
import {
  attachCarerCashoutsByCarerSqlPoll,
  attachPendingCarerCashoutsSqlPoll,
} from '@/features/live/coadminCarerCashoutsSqlRead';
import { logClientFirebaseRuntimeRemoved } from '@/lib/client/sqlClientMigration';
import { clientOnSnapshot } from '@/lib/client/clientFirestoreQuery';
import { isClientSqlReadMode } from '@/lib/client/sqlReadMode';

const CARER_CASHOUT_PENDING_LISTENER_LIMIT = 100;
const CARER_CASHOUT_HISTORY_LISTENER_LIMIT = 50;

async function getAuthHeaders() {
  if (isClientSqlReadMode()) {
    return getSqlApiReadHeaders(true);
  }
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error('Not authenticated.');
  }
  const token = await currentUser.getIdToken();
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

function readApiError(messageFallback: string, payload: unknown) {
  if (
    payload &&
    typeof payload === 'object' &&
    'error' in payload &&
    typeof (payload as { error?: unknown }).error === 'string'
  ) {
    return String((payload as { error: string }).error || messageFallback);
  }
  return messageFallback;
}

export type CarerCashoutRequest = {
  id: string;
  coadminUid: string;
  carerUid: string;
  carerUsername: string;
  amountNpr: number;
  paymentQrUrl?: string | null;
  paymentQrPublicId?: string | null;
  paymentDetails?: string | null;
  status: 'pending' | 'completed' | 'declined';
  completedAmountNpr?: number | null;
  remainingAmountNpr?: number | null;
  createdAt?: Date | null;
  completedAt?: Date | null;
};

function getDateMs(value: unknown) {
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

export async function saveCarerPaymentDetails(values: {
  paymentQrUrl: string;
  paymentQrPublicId?: string;
  paymentDetails: string;
}) {
  if (isClientSqlReadMode()) {
    const carerUid = await requireSqlSessionUid();
    const response = await fetch('/api/carer/payment-details', {
      method: 'POST',
      headers: await getSqlApiReadHeaders(true),
      body: JSON.stringify({
        paymentQrUrl: values.paymentQrUrl.trim(),
        paymentQrPublicId: values.paymentQrPublicId?.trim() || null,
        paymentDetails: values.paymentDetails.trim(),
      }),
    });
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    console.info('[CARER_PAYMENT_DETAILS_SQL_WRITE]', {
      carerUid,
      hasQrUrl: Boolean(values.paymentQrUrl.trim()),
      source: 'sql',
      firestoreAttempted: false,
      ok: response.ok,
    });
    if (!response.ok) {
      throw new Error(readApiError('Failed to save payment details.', payload));
    }
    return;
  }

  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error('Not authenticated.');
  }

  await updateDoc(doc(db, 'users', currentUser.uid), {
    paymentQrUrl: values.paymentQrUrl.trim(),
    paymentQrPublicId: values.paymentQrPublicId?.trim() || null,
    paymentDetails: values.paymentDetails.trim(),
  });
}

export async function createCarerCashoutRequest(values: {
  coadminUid: string;
  carerUid: string;
  carerUsername: string;
  amountNpr: number;
  paymentQrUrl?: string;
  paymentQrPublicId?: string;
  paymentDetails?: string;
}) {
  const amountNpr = Math.round(Number(values.amountNpr || 0));

  if (amountNpr <= 0) {
    throw new Error('Cash box amount must be greater than zero.');
  }

  const expectedCarerUid = String(values.carerUid || '').trim();
  const actorUid = isClientSqlReadMode()
    ? await requireSqlSessionUid(expectedCarerUid)
    : auth.currentUser?.uid || expectedCarerUid;

  if (!actorUid) {
    throw new Error('Session changed. Please refresh.');
  }

  if (actorUid !== expectedCarerUid) {
    throw new Error('Only the current carer can create a cashout request.');
  }

  const response = await fetch('/api/carer/cashouts', {
    method: 'POST',
    headers: await getAuthHeaders(),
    body: JSON.stringify({
      action: 'create',
      amountNpr,
      paymentQrUrl: values.paymentQrUrl,
      paymentQrPublicId: values.paymentQrPublicId,
      paymentDetails: values.paymentDetails,
    }),
  });
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  console.info('[CARER_CASHOUT_SQL_ACTION]', {
    action: 'create_carer_cashout',
    carerUid: actorUid,
    role: getCachedSessionUser()?.role || 'carer',
    authSource: isClientSqlReadMode() ? 'app_session_sql' : 'firebase_bearer',
    firestoreAttempted: false,
    status: response.status,
  });
  if (!response.ok) {
    throw new Error(readApiError('Failed to create claim pay request.', payload));
  }
}

export function listenPendingCashoutsByCoadmin(
  coadminUid: string,
  onChange: (items: CarerCashoutRequest[]) => void,
  onError?: (error: Error) => void
) {
  if (isClientSqlReadMode()) {
    return attachPendingCarerCashoutsSqlPoll({
      coadminUid,
      limit: CARER_CASHOUT_PENDING_LISTENER_LIMIT,
      onChange,
      onError,
    });
  }

  const cashoutQuery = query(
    collection(db, 'carerCashouts'),
    where('coadminUid', '==', coadminUid),
    where('status', '==', 'pending'),
    orderBy('createdAt', 'desc'),
    limit(CARER_CASHOUT_PENDING_LISTENER_LIMIT)
  );

  return clientOnSnapshot(
    cashoutQuery,
    {
      file: 'features/cashouts/carerCashouts.ts',
      hook: 'listenPendingCashoutsByCoadmin',
      collection: 'carerCashouts',
      where: { coadminUid, status: 'pending' },
      orderBy: { field: 'createdAt', direction: 'desc' },
    },
    (snapshot) => {
      const items = snapshot.docs
        .map((docSnap) => ({
          id: docSnap.id,
          ...(docSnap.data() as Omit<CarerCashoutRequest, 'id'>),
        }))
        .sort((a, b) => {
          const aTime = getDateMs(a.createdAt);
          const bTime = getDateMs(b.createdAt);
          return bTime - aTime;
        });
      onChange(items);
    },
    (error) => onError?.(error as Error)
  );
}

/** Claim Pay history for staff/carers (staff use `carerUid` matching their UID). */
export function listenCarerCashoutsByCarerUid(
  carerUid: string,
  onChange: (items: CarerCashoutRequest[]) => void,
  onError?: (error: Error) => void
) {
  if (isClientSqlReadMode()) {
    logClientFirebaseRuntimeRemoved({
      feature: 'carer_cashouts_by_carer',
      file: 'features/cashouts/carerCashouts.ts',
      operation: 'onSnapshot',
      replacement: '/api/carer-cashouts/cache?scope=carer',
    });
    return attachCarerCashoutsByCarerSqlPoll({
      carerUid,
      onChange,
      onError,
    });
  }

  const cashoutsQuery = query(
    collection(db, 'carerCashouts'),
    where('carerUid', '==', carerUid),
    orderBy('createdAt', 'desc'),
    limit(CARER_CASHOUT_HISTORY_LISTENER_LIMIT)
  );

  return onSnapshot(
    cashoutsQuery,
    (snapshot) => {
      const items = snapshot.docs
        .map((docSnap) => ({
          id: docSnap.id,
          ...(docSnap.data() as Omit<CarerCashoutRequest, 'id'>),
        }))
        .sort((a, b) => {
          const aTime = Math.max(
            getDateMs(a.completedAt),
            getDateMs(a.createdAt)
          );
          const bTime = Math.max(
            getDateMs(b.completedAt),
            getDateMs(b.createdAt)
          );
          return bTime - aTime;
        });
      onChange(items);
    },
    (error) => onError?.(error as Error)
  );
}

export async function completeCarerCashoutRequest(cashoutId: string, doneAmountNpr?: number) {
  const response = await fetch('/api/carer/cashouts', {
    method: 'POST',
    headers: await getAuthHeaders(),
    body: JSON.stringify({
      action: 'complete',
      cashoutId,
      amountNpr: doneAmountNpr,
    }),
  });
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    throw new Error(readApiError('Failed to complete claim pay request.', payload));
  }
}

export async function declineCarerCashoutRequest(cashoutId: string) {
  const response = await fetch('/api/carer/cashouts', {
    method: 'POST',
    headers: await getAuthHeaders(),
    body: JSON.stringify({
      action: 'decline',
      cashoutId,
    }),
  });
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    throw new Error(readApiError('Failed to decline claim pay request.', payload));
  }
}
