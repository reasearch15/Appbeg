'use client';

/**
 * Re-enable verbose player/SQL-runtime browser instrumentation (startup waterfall,
 * per-poll refetch traces, chat message live events, etc.).
 *
 * Set either:
 * - NEXT_PUBLIC_PLAYER_DEBUG_LOGS=1
 * - NEXT_PUBLIC_DEBUG_SQL_RUNTIME=1
 */
export function isPlayerDebugLogsEnabled() {
  return (
    process.env.NEXT_PUBLIC_PLAYER_DEBUG_LOGS === '1' ||
    process.env.NEXT_PUBLIC_DEBUG_SQL_RUNTIME === '1'
  );
}

export function playerDebugLog(message: string, details?: Record<string, unknown>) {
  if (!isPlayerDebugLogsEnabled()) {
    return;
  }
  if (details) {
    console.info(message, details);
    return;
  }
  console.info(message);
}

export function playerDevLog(message: string, details?: Record<string, unknown>) {
  if (process.env.NODE_ENV === 'production') {
    return;
  }
  if (details) {
    console.info(message, details);
    return;
  }
  console.info(message);
}

/** Startup / lifecycle investigation instrumentation (same gate as playerDebugLog). */
export function playerStartupDebugLog(message: string, details?: Record<string, unknown>) {
  playerDebugLog(message, details);
}

/** Important operational events (SSE errors, reconnects, session failures) — always logged. */
export function playerLiveOpsLog(message: string, details?: Record<string, unknown>) {
  if (details) {
    console.info(message, details);
    return;
  }
  console.info(message);
}

/** Warnings that should remain visible in production (auth/session/SSE issues). */
export function playerRuntimeWarn(message: string, details?: Record<string, unknown>) {
  if (details) {
    console.warn(message, details);
    return;
  }
  console.warn(message);
}
