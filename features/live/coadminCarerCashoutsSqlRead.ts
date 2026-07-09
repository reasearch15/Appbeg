'use client';

import type { CarerCashoutRequest } from '@/features/cashouts/carerCashouts';
import { getSqlApiReadHeaders } from '@/lib/client/sqlApiHeaders';
import { assertClientFirestoreDisabled } from '@/lib/client/clientFirestoreGuard';
import { logClientFirestoreSkipped } from '@/lib/client/sqlReadMode';

const POLL_MS = 10_000;

function isoToTimestamp(iso: string | null | undefined): Date | null {
  if (!iso) {
    return null;
  }
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

function mapCachedCashout(row: Record<string, unknown>): CarerCashoutRequest {
  return {
    id: String(row.id || ''),
    coadminUid: String(row.coadminUid || ''),
    carerUid: String(row.carerUid || ''),
    carerUsername: String(row.carerUsername || ''),
    amountNpr: Number(row.amountNpr || 0),
    paymentQrUrl: String(row.paymentQrUrl || '').trim() || null,
    paymentQrPublicId: String(row.paymentQrPublicId || '').trim() || null,
    paymentDetails: String(row.paymentDetails || '').trim() || null,
    status: (String(row.status || 'pending') as CarerCashoutRequest['status']) || 'pending',
    completedAmountNpr:
      row.completedAmountNpr == null ? null : Number(row.completedAmountNpr || 0),
    remainingAmountNpr:
      row.remainingAmountNpr == null ? null : Number(row.remainingAmountNpr || 0),
    createdAt: isoToTimestamp(String(row.createdAt || '') || null),
    completedAt: isoToTimestamp(String(row.completedAt || '') || null),
  };
}

async function fetchPendingCashouts(coadminUid: string, limit: number) {
  const response = await fetch(
    `/api/carer-cashouts/cache?scope=pending&coadminUid=${encodeURIComponent(coadminUid)}&limit=${limit}`,
    {
      method: 'GET',
      headers: await getSqlApiReadHeaders(false),
      cache: 'no-store',
    }
  );
  const payload = (await response.json().catch(() => ({}))) as {
    cashouts?: Array<Record<string, unknown>>;
    error?: string;
  };
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to load pending carer cashouts.');
  }
  return (payload.cashouts || []).map(mapCachedCashout);
}

async function fetchCarerCashoutsByCarerUid(carerUid: string, limit: number) {
  const response = await fetch(
    `/api/carer-cashouts/cache?scope=carer&carerUid=${encodeURIComponent(carerUid)}&limit=${limit}`,
    {
      method: 'GET',
      headers: await getSqlApiReadHeaders(false),
      cache: 'no-store',
    }
  );
  const payload = (await response.json().catch(() => ({}))) as {
    cashouts?: Array<Record<string, unknown>>;
    error?: string;
  };
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to load carer cashout history.');
  }
  return (payload.cashouts || []).map(mapCachedCashout);
}

export function attachCarerCashoutsByCarerSqlPoll(input: {
  carerUid: string;
  limit?: number;
  onChange: (items: CarerCashoutRequest[]) => void;
  onError?: (error: Error) => void;
}) {
  void assertClientFirestoreDisabled('carer_cashouts_by_carer_sql_poll', 'onSnapshot', {
    carerUid: input.carerUid,
  });
  logClientFirestoreSkipped('carer_cashouts_by_carer_listener', {
    carerUid: input.carerUid,
  });

  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async () => {
    if (cancelled) {
      return;
    }
    try {
      const cashouts = await fetchCarerCashoutsByCarerUid(input.carerUid, input.limit || 100);
      if (!cancelled) {
        input.onChange(cashouts);
      }
    } catch (error) {
      if (!cancelled) {
        input.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      if (!cancelled) {
        timer = setTimeout(() => {
          void tick();
        }, POLL_MS);
      }
    }
  };

  void tick();

  return () => {
    cancelled = true;
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

export function attachPendingCarerCashoutsSqlPoll(input: {
  coadminUid: string;
  limit?: number;
  onChange: (items: CarerCashoutRequest[]) => void;
  onError?: (error: Error) => void;
}) {
  void assertClientFirestoreDisabled('pending_carer_cashouts_sql_poll', 'onSnapshot', {
    coadminUid: input.coadminUid,
  });
  logClientFirestoreSkipped('pending_carer_cashouts_listener', {
    coadminUid: input.coadminUid,
  });

  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async () => {
    if (cancelled) {
      return;
    }
    try {
      const cashouts = await fetchPendingCashouts(input.coadminUid, input.limit || 100);
      if (!cancelled) {
        input.onChange(cashouts);
      }
    } catch (error) {
      if (!cancelled) {
        input.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      if (!cancelled) {
        timer = setTimeout(() => {
          void tick();
        }, POLL_MS);
      }
    }
  };

  void tick();

  return () => {
    cancelled = true;
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
  };
}
