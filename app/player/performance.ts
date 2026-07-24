'use client';

import { useEffect, useRef } from 'react';
import { playerDevLog } from '@/lib/client/playerDebugLogs';

type PlayerPerfDetail = Record<string, unknown>;

export const PLAYER_PERF_DEBUG =
  process.env.NODE_ENV !== 'production' &&
  (process.env.NEXT_PUBLIC_PLAYER_PERF_DEBUG === '1' ||
    process.env.NEXT_PUBLIC_PLAYER_RENDER_DEBUG === '1');

function nowMs() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function safeMark(name: string) {
  if (typeof performance === 'undefined' || typeof performance.mark !== 'function') {
    return;
  }
  try {
    performance.mark(name);
  } catch {
    // Perf marks are diagnostic only.
  }
}

export function markPlayerPerf(name: string, detail: PlayerPerfDetail = {}) {
  if (!PLAYER_PERF_DEBUG) {
    return;
  }
  const atMs = Math.round(nowMs());
  safeMark(`player:${name}:${atMs}`);
  playerDevLog('[PLAYER_PERF]', {
    name,
    atMs,
    ...detail,
  });
}

export function usePlayerRenderPerf(
  component: string,
  getDetail?: () => PlayerPerfDetail
) {
  const renderStartedAt = nowMs();
  const renderCountRef = useRef(0);
  renderCountRef.current += 1;
  const renderCount = renderCountRef.current;

  useEffect(() => {
    if (!PLAYER_PERF_DEBUG) {
      return;
    }
    markPlayerPerf('render_commit', {
      component,
      renderCount,
      renderToCommitMs: Math.round(nowMs() - renderStartedAt),
      ...(getDetail?.() || {}),
    });
  });
}

export function usePlayerViewChangePerf(activeView: string) {
  const previousViewRef = useRef<string | null>(null);

  useEffect(() => {
    const previousView = previousViewRef.current;
    previousViewRef.current = activeView;
    markPlayerPerf('view_change', {
      previousView,
      activeView,
    });
  }, [activeView]);
}
