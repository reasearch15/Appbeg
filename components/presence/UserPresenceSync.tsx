'use client';

import { useEffect } from 'react';

import { getSqlApiReadHeaders } from '@/lib/client/sqlApiHeaders';
import { isClientSqlReadMode, logClientFirestoreSkipped } from '@/lib/client/sqlReadMode';
import { getCachedSessionUser, getSessionUserOnce } from '@/features/auth/sessionUser';
import {
  isPlayerSessionStale,
  registerPlayerRuntimeStopper,
} from '@/lib/client/playerStaleSession';

const HEARTBEAT_MS = 90_000;
const LEADER_LOCK_KEY = 'user-presence-heartbeat-lock';
const LEADER_LOCK_TTL_MS = HEARTBEAT_MS + 20_000;

/**
 * Periodically writes `userPresence/{uid}.lastSeenAt` so other users can show online dots.
 * Mount once under a signed-in app shell (e.g. with {@link ProtectedRoute}).
 */
export default function UserPresenceSync() {
  useEffect(() => {
    const cleanups: Array<() => void> = [];
    const tabId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const startHeartbeat = (uid: string) => {
      for (const c of cleanups) {
        c();
      }
      cleanups.length = 0;

      if (!uid) {
        return;
      }

      const sqlReadMode = isClientSqlReadMode();
      let heartbeatId: number | null = null;
      let leadershipCheckId: number | null = null;
      let isLeader = false;

      const readLeader = () => {
        try {
          const raw = window.localStorage.getItem(LEADER_LOCK_KEY);
          if (!raw) {
            return null;
          }
          return JSON.parse(raw) as { tabId?: string; expiresAt?: number };
        } catch {
          return null;
        }
      };

      const writeLeader = (expiresAt: number) => {
        try {
          window.localStorage.setItem(
            LEADER_LOCK_KEY,
            JSON.stringify({ tabId, expiresAt })
          );
        } catch {
          // Ignore storage failures and continue best-effort.
        }
      };

      const clearLeader = () => {
        try {
          const current = readLeader();
          if (current?.tabId === tabId) {
            window.localStorage.removeItem(LEADER_LOCK_KEY);
          }
        } catch {
          // Ignore storage failures and continue best-effort.
        }
      };

      const pulse = () => {
        if (!isLeader || isPlayerSessionStale()) {
          return;
        }
        if (sqlReadMode) {
          logClientFirestoreSkipped('user_presence_heartbeat', { uid });
          void (async () => {
            try {
              await fetch('/api/presence/heartbeat', {
                method: 'POST',
                headers: await getSqlApiReadHeaders(true),
              });
            } catch {
              // Best-effort heartbeat.
            }
          })();
          return;
        }
        logClientFirestoreSkipped('user_presence_heartbeat', { uid });
      };
      const claimLeadership = () => {
        const now = Date.now();
        const current = readLeader();
        if (
          current?.tabId &&
          current.tabId !== tabId &&
          Number(current.expiresAt || 0) > now
        ) {
          isLeader = false;
          return false;
        }

        const expiresAt = now + LEADER_LOCK_TTL_MS;
        writeLeader(expiresAt);
        const confirmed = readLeader();
        isLeader = confirmed?.tabId === tabId;
        return isLeader;
      };
      const ensureLeadership = () => {
        if (claimLeadership()) {
          pulse();
        }
      };
      const renewLeadership = () => {
        if (!isLeader) {
          ensureLeadership();
          return;
        }
        writeLeader(Date.now() + LEADER_LOCK_TTL_MS);
      };

      ensureLeadership();
      heartbeatId = window.setInterval(() => {
        if (isPlayerSessionStale()) {
          if (heartbeatId !== null) {
            window.clearInterval(heartbeatId);
            heartbeatId = null;
          }
          return;
        }
        renewLeadership();
        pulse();
      }, HEARTBEAT_MS);
      leadershipCheckId = window.setInterval(() => {
        const current = readLeader();
        if (!current || Number(current.expiresAt || 0) <= Date.now()) {
          ensureLeadership();
        }
      }, 15_000);
      const onVis = () => {
        if (document.visibilityState === 'visible') {
          ensureLeadership();
        }
      };
      const onStorage = () => {
        const current = readLeader();
        if (current?.tabId !== tabId) {
          isLeader = false;
        }
      };
      document.addEventListener('visibilitychange', onVis);
      const onPageShow = () => ensureLeadership();
      const onBeforeUnload = () => clearLeader();
      window.addEventListener('storage', onStorage);
      window.addEventListener('pageshow', onPageShow);
      window.addEventListener('beforeunload', onBeforeUnload);

      const stopHeartbeat = () => {
        isLeader = false;
        clearLeader();
        if (heartbeatId !== null) {
          window.clearInterval(heartbeatId);
          heartbeatId = null;
        }
        if (leadershipCheckId !== null) {
          window.clearInterval(leadershipCheckId);
          leadershipCheckId = null;
        }
        document.removeEventListener('visibilitychange', onVis);
        window.removeEventListener('storage', onStorage);
        window.removeEventListener('pageshow', onPageShow);
        window.removeEventListener('beforeunload', onBeforeUnload);
      };

      cleanups.push(stopHeartbeat);
      cleanups.push(registerPlayerRuntimeStopper(stopHeartbeat));
    };

    let cancelled = false;
    void (async () => {
      const cached = getCachedSessionUser();
      const sessionUser =
        cached?.uid ? cached : await getSessionUserOnce().catch(() => null);
      if (!cancelled && sessionUser?.uid) {
        startHeartbeat(sessionUser.uid);
      }
    })();

    return () => {
      cancelled = true;
      for (const c of cleanups) {
        c();
      }
    };
  }, []);

  return null;
}
