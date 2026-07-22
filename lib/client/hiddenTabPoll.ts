'use client';

import { playerDebugLog } from '@/lib/client/playerDebugLogs';

export const HIDDEN_THROTTLED_POLL_MS = 3 * 60 * 1000;

export function isDocumentHidden() {
  return typeof document !== 'undefined' && document.hidden;
}

export function resolveVisiblePollIntervalMs(visibleMs: number) {
  return isDocumentHidden() ? HIDDEN_THROTTLED_POLL_MS : visibleMs;
}

export function logHiddenTabPollPaused(pollName: string) {
  playerDebugLog('[HIDDEN_TAB_POLL_PAUSED]', { pollName });
}

export function logHiddenTabPollThrottled(pollName: string, intervalMs: number) {
  playerDebugLog('[HIDDEN_TAB_POLL_THROTTLED]', { pollName, intervalMs });
}

export function logHiddenTabPollResumed(pollName: string) {
  playerDebugLog('[HIDDEN_TAB_POLL_RESUMED]', { pollName });
}

export function attachHiddenTabPollResume(pollName: string, onResume: () => void) {
  if (typeof document === 'undefined') {
    return () => {};
  }

  const handler = () => {
    if (document.visibilityState !== 'visible') {
      return;
    }
    logHiddenTabPollResumed(pollName);
    onResume();
  };

  document.addEventListener('visibilitychange', handler);
  return () => document.removeEventListener('visibilitychange', handler);
}
