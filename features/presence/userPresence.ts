'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  collection,
  documentId,
  onSnapshot,
  query,
  where,
} from 'firebase/firestore';

import { getLocalAppSessionId } from '@/features/auth/appSession';
import { getLocalPlayerSessionId } from '@/features/auth/playerSession';
import { getCachedSessionUser } from '@/features/auth/sessionUser';
import { fetchChatApi } from '@/lib/client/chatLogoutDiagnostics';
import { getSqlApiReadHeaders } from '@/lib/client/sqlApiHeaders';
import { checkPlayerPollRole } from '@/lib/client/playerPollGuard';
import { assertClientFirestoreDisabled } from '@/lib/client/clientFirestoreGuard';
import { isClientSqlReadMode, logClientFirestoreSkipped } from '@/lib/client/sqlReadMode';
import { db } from '@/lib/firebase/client';

/** A user is "online" if their client wrote presence within this window. */
export const PRESENCE_TTL_MS = 120_000;

const PRESENCE_POLL_MS = 30_000;
const PRESENCE_CACHE_MS = 15_000;
const PRESENCE_MERGE_DELAY_MS = 40;

export function isPresenceTimeOnline(
  lastSeenMs: number | null | undefined,
  now: number = Date.now()
) {
  if (lastSeenMs == null || !Number.isFinite(lastSeenMs)) {
    return false;
  }
  return now - lastSeenMs < PRESENCE_TTL_MS;
}

const CHUNK = 30;

function stableUidListKey(uids: string[]) {
  return JSON.stringify(
    [...new Set((uids || []).map((u) => String(u || '').trim()).filter(Boolean))].sort()
  );
}

const presenceCache = new Map<string, { lastSeenMs: number | null; cachedAt: number }>();
let pendingPresenceUids = new Set<string>();
let pendingPresenceTimer: ReturnType<typeof setTimeout> | null = null;
let pendingPresencePromise: Promise<Record<string, number | null>> | null = null;
let pendingPresenceResolve:
  | ((value: Record<string, number | null> | PromiseLike<Record<string, number | null>>) => void)
  | null = null;

async function fetchPresenceBatch(uids: string[], options?: { logAsChatApi?: boolean }) {
  if (!uids.length) {
    return {} as Record<string, number | null>;
  }
  const now = Date.now();
  const out: Record<string, number | null> = {};
  const missing: string[] = [];
  for (const uid of uids) {
    const cached = presenceCache.get(uid);
    if (cached && now - cached.cachedAt <= PRESENCE_CACHE_MS) {
      out[uid] = cached.lastSeenMs;
      console.info('[PRESENCE_CACHE_HIT]', {
        uid,
        ageMs: now - cached.cachedAt,
      });
    } else {
      missing.push(uid);
    }
  }
  if (!missing.length) {
    return out;
  }

  for (const uid of missing) {
    pendingPresenceUids.add(uid);
  }
  console.info('[PRESENCE_BATCH_MERGE]', {
    requested: missing.length,
    pending: pendingPresenceUids.size,
  });

  if (!pendingPresencePromise) {
    pendingPresencePromise = new Promise((resolve) => {
      pendingPresenceResolve = resolve;
    });
  }
  if (!pendingPresenceTimer) {
    pendingPresenceTimer = setTimeout(async () => {
      const batchUids = [...pendingPresenceUids];
      pendingPresenceUids = new Set();
      pendingPresenceTimer = null;
      const resolve = pendingPresenceResolve;
      pendingPresenceResolve = null;
      const promise = pendingPresencePromise;
      pendingPresencePromise = null;
      try {
        const batch = await fetchPresenceBatchNetwork(batchUids, options);
        resolve?.(batch);
      } catch {
        resolve?.({});
      }
      void promise;
    }, PRESENCE_MERGE_DELAY_MS);
  }

  const merged = await pendingPresencePromise;
  for (const uid of missing) {
    out[uid] = merged[uid] ?? null;
  }
  return out;
}

async function fetchPresenceBatchNetwork(uids: string[], options?: { logAsChatApi?: boolean }) {
  if (!uids.length) {
    return {} as Record<string, number | null>;
  }
  const url = `/api/presence/batch?uids=${encodeURIComponent(uids.join(','))}`;
  const headers = await getSqlApiReadHeaders(false);
  const cached = getCachedSessionUser();
  const requestContext = {
    role: cached?.role ?? null,
    uid: cached?.uid ?? null,
    hasAppSessionId: Boolean(getLocalAppSessionId()),
    hasPlayerSessionId: Boolean(getLocalPlayerSessionId()),
    headersSent: Object.keys(headers),
  };
  const response = options?.logAsChatApi
    ? await fetchChatApi(
        url,
        {
          method: 'GET',
          headers,
          cache: 'no-store',
        },
        requestContext
      )
    : await fetch(url, {
        method: 'GET',
        headers,
        cache: 'no-store',
      });
  const payload = (await response.json().catch(() => ({}))) as {
    presence?: Array<{ uid?: string; lastSeenAt?: string }>;
  };
  if (!response.ok) {
    return {};
  }
  const out: Record<string, number | null> = {};
  for (const uid of uids) {
    out[uid] = null;
  }
  for (const row of payload.presence || []) {
    const uid = String(row.uid || '').trim();
    const ms = row.lastSeenAt ? Date.parse(row.lastSeenAt) : NaN;
    if (uid) {
      out[uid] = Number.isFinite(ms) ? ms : null;
      presenceCache.set(uid, {
        lastSeenMs: out[uid],
        cachedAt: Date.now(),
      });
    }
  }
  for (const uid of uids) {
    if (!presenceCache.has(uid)) {
      presenceCache.set(uid, {
        lastSeenMs: null,
        cachedAt: Date.now(),
      });
    }
  }
  return out;
}

/**
 * Real-time map of whether each uid is "online" (fresh lastSeen) for UI dots.
 * Ensure {@link UserPresenceSync} (or equivalent heartbeat) is mounted for the signed-in app.
 */
export function usePresenceOnlineMap(
  uids: string[],
  options?: { requirePlayerRole?: boolean }
) {
  const contentKey = stableUidListKey(uids);
  const uniqueSorted = useMemo(
    () => (contentKey ? (JSON.parse(contentKey) as string[]) : []),
    [contentKey]
  );
  const key = contentKey;

  const [lastSeenMsByUid, setLastSeenMsByUid] = useState<Record<string, number | null>>(
    {}
  );
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (uniqueSorted.length === 0) {
      return;
    }
    const t = setInterval(() => setTick((n) => n + 1), 15000);
    return () => clearInterval(t);
  }, [uniqueSorted.length]);

  useEffect(() => {
    if (uniqueSorted.length === 0) {
      setLastSeenMsByUid({});
      return;
    }

    if (isClientSqlReadMode()) {
      logClientFirestoreSkipped('user_presence_listener', { count: uniqueSorted.length });
      let cancelled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let pausedForHidden = false;

      const poll = async () => {
        if (cancelled) {
          return;
        }
        if (typeof document !== 'undefined' && document.hidden) {
          pausedForHidden = true;
          if (!cancelled) {
            timer = setTimeout(() => {
              void poll();
            }, PRESENCE_POLL_MS);
          }
          return;
        }
        if (pausedForHidden) {
          pausedForHidden = false;
        }
        if (options?.requirePlayerRole) {
          const sessionUser = await checkPlayerPollRole('player_presence');
          if (!sessionUser) {
            cancelled = true;
            if (timer != null) {
              clearTimeout(timer);
              timer = null;
            }
            return;
          }
        }
        try {
          for (let i = 0; i < uniqueSorted.length; i += CHUNK) {
            const chunk = uniqueSorted.slice(i, i + CHUNK);
            const batch = await fetchPresenceBatch(chunk, {
              logAsChatApi: options?.requirePlayerRole === true,
            });
            if (cancelled) {
              return;
            }
            setLastSeenMsByUid((prev) => ({ ...prev, ...batch }));
          }
        } finally {
          if (!cancelled) {
            timer = setTimeout(() => {
              void poll();
            }, PRESENCE_POLL_MS);
          }
        }
      };

      void poll();
      return () => {
        cancelled = true;
        if (timer != null) {
          clearTimeout(timer);
          timer = null;
        }
      };
    }

    if (assertClientFirestoreDisabled('user_presence_listener', 'onSnapshot')) {
      setLastSeenMsByUid({});
      return;
    }

    const unsubs: (() => void)[] = [];

    for (let i = 0; i < uniqueSorted.length; i += CHUNK) {
      const chunk = uniqueSorted.slice(i, i + CHUNK);
      const q = query(
        collection(db, 'userPresence'),
        where(documentId(), 'in', chunk)
      );

      unsubs.push(
        onSnapshot(q, (snap) => {
          setLastSeenMsByUid((prev) => {
            const next = { ...prev };
            for (const id of chunk) {
              const docSnap = snap.docs.find((d) => d.id === id);
              if (!docSnap) {
                next[id] = null;
                continue;
              }
              next[id] = toDateMs(docSnap.data().lastSeenAt);
            }
            return next;
          });
        })
      );
    }

    return () => {
      for (const u of unsubs) {
        u();
      }
    };
  }, [key, uniqueSorted, options?.requirePlayerRole]);

  return useMemo(() => {
    const now = Date.now() + tick * 0;
    const out: Record<string, boolean> = {};
    for (const uid of uniqueSorted) {
      out[uid] = isPresenceTimeOnline(lastSeenMsByUid[uid] ?? null, now);
    }
    return out;
  }, [uniqueSorted, lastSeenMsByUid, tick]);
}

function toDateMs(value: unknown): number | null {
  if (!value) {
    return null;
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
  return null;
}
