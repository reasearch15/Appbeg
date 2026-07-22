'use client';

import { playerDebugLog } from '@/lib/client/playerDebugLogs';

type RouteStats = {
  count: number;
  totalMs: number;
  maxMs: number;
};

const statsByRoute = new Map<string, RouteStats>();
let reporterStarted = false;

export function recordPlayerRequest(route: string, durationMs: number) {
  const cleanRoute = String(route || '').trim() || 'unknown';
  const safeMs = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
  const current = statsByRoute.get(cleanRoute) || { count: 0, totalMs: 0, maxMs: 0 };
  current.count += 1;
  current.totalMs += safeMs;
  current.maxMs = Math.max(current.maxMs, safeMs);
  statsByRoute.set(cleanRoute, current);
}

export function startPlayerRequestSummaryReporter() {
  if (reporterStarted || typeof window === 'undefined') {
    return () => {};
  }
  reporterStarted = true;

  const intervalId = window.setInterval(() => {
    if (statsByRoute.size === 0) {
      return;
    }
    const summary = [...statsByRoute.entries()]
      .map(([route, stats]) => ({
        route,
        count: stats.count,
        avgMs: stats.count > 0 ? Math.round(stats.totalMs / stats.count) : 0,
        maxMs: stats.maxMs,
      }))
      .sort((a, b) => b.count - a.count);

    playerDebugLog('[PLAYER_REQUEST_SUMMARY]', { routes: summary });
    statsByRoute.clear();
  }, 60_000);

  return () => {
    window.clearInterval(intervalId);
    reporterStarted = false;
    statsByRoute.clear();
  };
}

export async function trackPlayerRequest<T>(
  route: string,
  run: () => Promise<T>
): Promise<T> {
  const startedAt = Date.now();
  try {
    return await run();
  } finally {
    recordPlayerRequest(route, Date.now() - startedAt);
  }
}
