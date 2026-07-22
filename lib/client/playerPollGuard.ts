'use client';

import { getCachedSessionUser, getSessionUserOnce } from '@/features/auth/sessionUser';
import {
  getLocalPlayerSessionId,
  getPlayerSessionGeneration,
} from '@/features/auth/playerSession';
import { playerDebugLog } from '@/lib/client/playerDebugLogs';
import { recordPlayerRequest } from '@/lib/client/playerRequestSummary';
import {
  handleStalePlayerFetchError,
  isPlayerSessionStale,
  markPlayerSessionStale,
  registerPlayerRuntimeStopper,
} from '@/lib/client/playerStaleSession';

export function logPlayerPollBlockedRole(values: {
  pollName: string;
  uid: string | null;
  role: string | null;
  reason?: string;
}) {
  playerDebugLog('[PLAYER_POLL_BLOCKED_ROLE]', {
    pollName: values.pollName,
    uid: values.uid,
    role: values.role,
    expectedRole: 'player',
    reason: values.reason || 'non_player_role',
  });
}

export async function checkPlayerPollRole(pollName: string) {
  if (isPlayerSessionStale()) {
    return null;
  }

  const pathname = typeof window === 'undefined' ? '' : window.location.pathname || '';
  const isPlayerRoute = pathname === '/player' || pathname.startsWith('/player/');
  if (!isPlayerRoute) {
    playerDebugLog('[PLAYER_SESSION_STATUS] skippedNonPlayerRoute', {
      pollName,
      pathname: pathname || null,
      hasPlayerSessionId: Boolean(getLocalPlayerSessionId()),
    });
    return null;
  }

  const cached = getCachedSessionUser();
  if (cached?.role === 'player') {
    return cached;
  }

  const fetched = await getSessionUserOnce().catch(() => null);
  if (fetched?.role === 'player') {
    return fetched;
  }

  logPlayerPollBlockedRole({
    pollName,
    uid: fetched?.uid ?? cached?.uid ?? null,
    role: fetched?.role ?? cached?.role ?? null,
  });
  playerDebugLog('[PLAYER_SESSION_STATUS] skippedNonPlayerRole', {
    pollName,
    uid: fetched?.uid ?? cached?.uid ?? null,
    role: fetched?.role ?? cached?.role ?? null,
    hasPlayerSessionId: Boolean(getLocalPlayerSessionId()),
  });
  return null;
}

function shouldStopPollForSessionGuard(
  pollName: string,
  generationAtStart: number,
  sessionIdAtStart: string
) {
  if (isPlayerSessionStale()) {
    return true;
  }

  const currentSessionId = getLocalPlayerSessionId();
  const currentGeneration = getPlayerSessionGeneration();

  if (
    currentGeneration !== generationAtStart ||
    !currentSessionId ||
    currentSessionId !== sessionIdAtStart
  ) {
    markPlayerSessionStale('player_session_generation_stale', pollName, {
      skipRedirect: true,
    });
    return true;
  }

  return false;
}

function pollIntervalWithJitter(intervalMs: number) {
  if (intervalMs <= 0) {
    return 0;
  }
  const jitterCap = Math.min(2_000, Math.floor(intervalMs * 0.15));
  return intervalMs + Math.floor(Math.random() * (jitterCap + 1));
}

export function createPlayerScopedPoll(input: {
  pollName: string;
  intervalMs: number;
  onTick: () => Promise<void>;
  onError?: (error: Error) => void;
  pauseWhenHidden?: boolean;
  initialDelayMs?: number;
  summaryRoute?: string;
}) {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const generationAtStart = getPlayerSessionGeneration();
  const sessionIdAtStart = getLocalPlayerSessionId();

  const stop = () => {
    cancelled = true;
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const unregister = registerPlayerRuntimeStopper(stop);

  const tick = async () => {
    if (cancelled || shouldStopPollForSessionGuard(input.pollName, generationAtStart, sessionIdAtStart)) {
      stop();
      return;
    }

    const sessionUser = await checkPlayerPollRole(input.pollName);
    if (!sessionUser) {
      stop();
      return;
    }

    if (input.pauseWhenHidden !== false && typeof document !== 'undefined' && document.hidden) {
      playerDebugLog('[PLAYER_POLL_PAUSED]', {
        pollName: input.pollName,
        reason: 'document_hidden',
      });
      const onVisible = () => {
        if (document.hidden || cancelled) {
          return;
        }
        document.removeEventListener('visibilitychange', onVisible);
        playerDebugLog('[PLAYER_POLL_RESUMED]', {
          pollName: input.pollName,
          reason: 'document_visible',
        });
        void tick();
      };
      document.addEventListener('visibilitychange', onVisible);
      return;
    }

    const requestStartedAt = Date.now();
    try {
      await input.onTick();
    } catch (error) {
      if (!cancelled) {
        if (
          handleStalePlayerFetchError(input.pollName, error, sessionIdAtStart)
        ) {
          stop();
          return;
        }
        input.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      recordPlayerRequest(
        input.summaryRoute || input.pollName,
        Date.now() - requestStartedAt
      );
      if (
        !cancelled &&
        !shouldStopPollForSessionGuard(input.pollName, generationAtStart, sessionIdAtStart)
      ) {
        const nextIntervalMs = pollIntervalWithJitter(input.intervalMs);
        if (nextIntervalMs <= 0) {
          return;
        }
        timer = setTimeout(() => {
          void tick();
        }, nextIntervalMs);
      }
    }
  };

  void (async () => {
    if (shouldStopPollForSessionGuard(input.pollName, generationAtStart, sessionIdAtStart)) {
      stop();
      return;
    }
    const sessionUser = await checkPlayerPollRole(input.pollName);
    if (!sessionUser || cancelled) {
      return;
    }
    const initialDelayMs = Math.max(0, Number(input.initialDelayMs || 0));
    if (initialDelayMs > 0) {
      timer = setTimeout(() => {
        void tick();
      }, initialDelayMs);
      return;
    }
    await tick();
  })();

  return () => {
    unregister();
    stop();
  };
}

export function startPlayerRoleGuardedInterval(input: {
  pollName: string;
  intervalMs: number;
  onTick: () => void;
  pauseWhenHidden?: boolean;
}) {
  let cancelled = false;
  let intervalId: ReturnType<typeof setInterval> | null = null;
  const generationAtStart = getPlayerSessionGeneration();
  const sessionIdAtStart = getLocalPlayerSessionId();

  const stop = () => {
    cancelled = true;
    if (intervalId != null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  };

  const unregister = registerPlayerRuntimeStopper(stop);

  void (async () => {
    if (shouldStopPollForSessionGuard(input.pollName, generationAtStart, sessionIdAtStart)) {
      stop();
      return;
    }

    const sessionUser = await checkPlayerPollRole(input.pollName);
    if (!sessionUser || cancelled) {
      return;
    }

      intervalId = setInterval(() => {
      void (async () => {
        if (
          cancelled ||
          shouldStopPollForSessionGuard(input.pollName, generationAtStart, sessionIdAtStart)
        ) {
          stop();
          return;
        }
        const current = await checkPlayerPollRole(input.pollName);
        if (!current) {
          stop();
          return;
        }
        if (
          input.pauseWhenHidden !== false &&
          typeof document !== 'undefined' &&
          document.hidden
        ) {
          playerDebugLog('[PLAYER_POLL_PAUSED]', {
            pollName: input.pollName,
            reason: 'document_hidden',
          });
          return;
        }
        input.onTick();
      })();
    }, input.intervalMs);
  })();

  return () => {
    unregister();
    stop();
  };
}
