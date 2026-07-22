'use client';

import { playerDebugLog, playerRuntimeWarn } from '@/lib/client/playerDebugLogs';

const CONSECUTIVE_INVALID_LOGOUT_THRESHOLD = 2;

let consecutiveInvalidSessionStatusCount = 0;
let lastInvalidSessionReason: string | null = null;

export function resetConsecutiveInvalidSessionStatus(reason = 'session_ok') {
  if (consecutiveInvalidSessionStatusCount > 0) {
    playerDebugLog('[PLAYER_SESSION_INVALID_GUARD]', {
      action: 'reset',
      reason,
      previousCount: consecutiveInvalidSessionStatusCount,
      previousReason: lastInvalidSessionReason,
    });
  }
  consecutiveInvalidSessionStatusCount = 0;
  lastInvalidSessionReason = null;
}

/**
 * Returns true only after the same definitive status failure repeats consecutively.
 */
export function shouldLogoutAfterInvalidPlayerSessionStatus(reason: string) {
  if (reason !== 'session_replaced' && reason !== 'session_inactive') {
    resetConsecutiveInvalidSessionStatus('non_definitive_failure');
    return false;
  }

  if (lastInvalidSessionReason === reason) {
    consecutiveInvalidSessionStatusCount += 1;
  } else {
    consecutiveInvalidSessionStatusCount = 1;
    lastInvalidSessionReason = reason;
  }

  const shouldLogout =
    consecutiveInvalidSessionStatusCount >= CONSECUTIVE_INVALID_LOGOUT_THRESHOLD;

  const log = shouldLogout ? playerRuntimeWarn : playerDebugLog;
  log('[PLAYER_SESSION_INVALID_GUARD]', {
    reason,
    consecutiveCount: consecutiveInvalidSessionStatusCount,
    threshold: CONSECUTIVE_INVALID_LOGOUT_THRESHOLD,
    shouldLogout,
  });

  return shouldLogout;
}
