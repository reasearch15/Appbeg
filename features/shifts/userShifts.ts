import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from 'firebase/firestore';

import { auth, db } from '@/lib/firebase/client';
import { clientOnSnapshot } from '@/lib/client/clientFirestoreQuery';
import {
  logClientFirebaseRuntimeRemoved,
  logSqlClientMigration,
} from '@/lib/client/sqlClientMigration';
import { getSqlApiReadHeaders } from '@/lib/client/sqlApiHeaders';
import { isClientSqlReadMode, logClientFirestoreSkipped } from '@/lib/client/sqlReadMode';
import { getFirebaseApiHeaders } from '@/lib/firebase/apiClient';

export type ShiftRole = 'staff' | 'carer';

export type ShiftSession = {
  id: string;
  coadminUid: string;
  userUid: string;
  userRole: ShiftRole;
  userUsername: string;
  loginAt?: Date | null;
  logoutAt?: Date | null;
  lastSeenAt?: Date | null;
  isActive: boolean;
};

async function postShiftSessionAction(body: Record<string, unknown>) {
  const response = await fetch('/api/shift-sessions', {
    method: 'POST',
    headers: await getSqlApiReadHeaders(true),
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  const payload = (await response.json().catch(() => ({}))) as {
    sessionId?: string;
    error?: string;
  };
  if (!response.ok) {
    throw new Error(payload.error || 'Shift session request failed.');
  }
  return payload;
}

export async function startShiftSession(values: {
  coadminUid: string;
  userUid: string;
  userRole: ShiftRole;
  userUsername: string;
}) {
  if (isClientSqlReadMode()) {
    logClientFirebaseRuntimeRemoved({
      feature: 'shift_session_start',
      file: 'features/shifts/userShifts.ts',
      operation: 'addDoc',
      replacement: 'POST /api/shift-sessions',
    });
    const payload = await postShiftSessionAction({
      action: 'start',
      coadminUid: values.coadminUid,
      userUid: values.userUid,
      userRole: values.userRole,
      userUsername: values.userUsername,
    });
    logSqlClientMigration({
      feature: 'shift_session_start',
      oldFirebaseOperation: 'addDoc',
      newSqlRoute: '/api/shift-sessions',
      result: 'ok',
      fallbackUsed: false,
    });
    return String(payload.sessionId || '');
  }

  const currentUser = auth.currentUser;
  if (!currentUser || currentUser.uid !== values.userUid) {
    throw new Error('Not authenticated.');
  }

  const activeQuery = query(
    collection(db, 'shiftSessions'),
    where('userUid', '==', values.userUid),
    where('isActive', '==', true)
  );
  const activeSnap = await getDocs(activeQuery);
  await Promise.all(
    activeSnap.docs.map((docSnap) =>
      updateDoc(docSnap.ref, {
        isActive: false,
        logoutAt: serverTimestamp(),
        lastSeenAt: serverTimestamp(),
      })
    )
  );

  const created = await addDoc(collection(db, 'shiftSessions'), {
    coadminUid: values.coadminUid,
    userUid: values.userUid,
    userRole: values.userRole,
    userUsername: values.userUsername || 'User',
    loginAt: serverTimestamp(),
    logoutAt: null,
    lastSeenAt: serverTimestamp(),
    isActive: true,
  });

  return created.id;
}

export async function heartbeatShiftSession(sessionId: string) {
  if (!sessionId) {
    return;
  }
  if (isClientSqlReadMode()) {
    await postShiftSessionAction({
      action: 'heartbeat',
      sessionId,
      userUid: auth.currentUser?.uid || '',
    });
    return;
  }
  await updateDoc(doc(db, 'shiftSessions', sessionId), {
    lastSeenAt: serverTimestamp(),
    isActive: true,
  });
}

export async function endShiftSession(sessionId: string) {
  if (!sessionId) {
    return;
  }
  if (isClientSqlReadMode()) {
    await postShiftSessionAction({
      action: 'end',
      sessionId,
      userUid: auth.currentUser?.uid || '',
    });
    return;
  }
  await updateDoc(doc(db, 'shiftSessions', sessionId), {
    isActive: false,
    logoutAt: serverTimestamp(),
    lastSeenAt: serverTimestamp(),
  });
}

function isoToDate(iso: string | null | undefined): Date | null {
  if (!iso) {
    return null;
  }
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

export function listenShiftSessionsByCoadmin(
  coadminUid: string,
  onChange: (items: ShiftSession[]) => void,
  onError?: (error: Error) => void
) {
  if (isClientSqlReadMode()) {
    logClientFirestoreSkipped('shift_sessions_listener', { coadminUid });
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled) {
        return;
      }
      try {
        const response = await fetch(
          `/api/shift-sessions?coadminUid=${encodeURIComponent(coadminUid)}`,
          {
            method: 'GET',
            headers: await getSqlApiReadHeaders(false),
            cache: 'no-store',
          }
        );
        const payload = (await response.json().catch(() => ({}))) as {
          sessions?: Array<{
            id: string;
            coadminUid: string;
            userUid: string;
            userRole: ShiftRole;
            userUsername: string;
            loginAt: string | null;
            logoutAt: string | null;
            lastSeenAt: string | null;
            isActive: boolean;
          }>;
        };
        if (!cancelled) {
          onChange(
            (payload.sessions || []).map((session) => ({
              id: session.id,
              coadminUid: session.coadminUid,
              userUid: session.userUid,
              userRole: session.userRole,
              userUsername: session.userUsername,
              loginAt: isoToDate(session.loginAt),
              logoutAt: isoToDate(session.logoutAt),
              lastSeenAt: isoToDate(session.lastSeenAt),
              isActive: session.isActive,
            }))
          );
        }
      } catch (error) {
        if (!cancelled) {
          onError?.(error instanceof Error ? error : new Error(String(error)));
        }
      } finally {
        if (!cancelled) {
          timer = setTimeout(() => {
            void tick();
          }, 12_000);
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

  const sessionsQuery = query(
    collection(db, 'shiftSessions'),
    where('coadminUid', '==', coadminUid)
  );
  return clientOnSnapshot(
    sessionsQuery,
    {
      file: 'features/shifts/userShifts.ts',
      hook: 'listenShiftSessionsByCoadmin',
      collection: 'shiftSessions',
      where: { coadminUid },
    },
    (snapshot) => {
      const items = snapshot.docs.map((docSnap) => ({
        id: docSnap.id,
        ...(docSnap.data() as Omit<ShiftSession, 'id'>),
      }));
      onChange(items);
    },
    (error) => onError?.(error as Error)
  );
}

export function calculateWorkedHoursLast24h(
  sessions: ShiftSession[],
  nowMs: number = Date.now()
) {
  const windowStart = nowMs - 24 * 60 * 60 * 1000;
  let totalMs = 0;
  for (const session of sessions) {
    const login = toDateMs(session.loginAt);
    if (!login) {
      continue;
    }
    const logout = toDateMs(session.logoutAt) || nowMs;
    const start = Math.max(login, windowStart);
    const end = Math.min(logout, nowMs);
    if (end > start) {
      totalMs += end - start;
    }
  }
  return totalMs / (1000 * 60 * 60);
}

function toDateMs(value: unknown) {
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

export async function cutWorkerReward(values: {
  workerUid: string;
  workerRole: ShiftRole;
  workerUsername: string;
  amountNpr: number;
  reason: string;
}) {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error('Not authenticated.');
  }
  const response = await fetch('/api/coadmin/workers/cut-reward', {
    method: 'POST',
    headers: await getFirebaseApiHeaders(),
    body: JSON.stringify(values),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    updatedCashBox?: number;
  };
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to cut reward.');
  }
  return { updatedCashBox: Number(payload.updatedCashBox || 0) };
}
