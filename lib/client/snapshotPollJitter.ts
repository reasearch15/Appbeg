'use client';

import { playerDebugLog } from '@/lib/client/playerDebugLogs';

export function safetyIntervalWithJitter(baseMs: number, jitterFraction = 0.2) {
  const cap = Math.max(1, Math.floor(baseMs * jitterFraction));
  const delta = Math.floor(Math.random() * (cap * 2 + 1)) - cap;
  return Math.max(1_000, baseMs + delta);
}

export function scheduleSafetyInterval(input: {
  baseMs: number;
  pollName: string;
  onTick: () => void;
}) {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const scheduleNext = () => {
    if (cancelled) {
      return;
    }
    const delayMs = safetyIntervalWithJitter(input.baseMs);
    playerDebugLog('[SNAPSHOT_SAFETY_JITTER]', {
      pollName: input.pollName,
      baseMs: input.baseMs,
      delayMs,
    });
    timer = setTimeout(() => {
      if (cancelled) {
        return;
      }
      input.onTick();
      scheduleNext();
    }, delayMs);
  };

  scheduleNext();

  return () => {
    cancelled = true;
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

export function visibilityRefetchDelayMs() {
  const delayMs = 250 + Math.floor(Math.random() * (3_000 - 250 + 1));
  playerDebugLog('[VISIBILITY_REFETCH_JITTER]', { delayMs });
  return delayMs;
}

export function reconnectRecoveryDelayMs() {
  const delayMs = 500 + Math.floor(Math.random() * (5_000 - 500 + 1));
  playerDebugLog('[RECONNECT_RECOVERY_JITTER]', { delayMs });
  return delayMs;
}

export function waitMs(delayMs: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, delayMs);
  });
}
