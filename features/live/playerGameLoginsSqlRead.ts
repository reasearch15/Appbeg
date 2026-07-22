'use client';

import type { PlayerGameLogin } from '@/features/games/playerGameLogins';
import { playerDebugLog } from '@/lib/client/playerDebugLogs';
import { getSqlApiReadHeaders } from '@/lib/client/sqlApiHeaders';
import { createPlayerScopedPoll } from '@/lib/client/playerPollGuard';
import { isClientSqlReadMode, logClientFirestoreSkipped } from '@/lib/client/sqlReadMode';

const POLL_MS = 20_000;

function mapCachedLogin(row: Record<string, unknown>): PlayerGameLogin {
  return {
    id: String(row.id || ''),
    playerUid: String(row.playerUid || ''),
    playerUsername: String(row.playerUsername || ''),
    gameName: String(row.gameName || ''),
    gameUsername: String(row.gameUsername || ''),
    gamePassword: String(row.gamePassword || ''),
    frontendUrl: String(row.frontendUrl || '').trim() || undefined,
    siteUrl: String(row.siteUrl || '').trim() || undefined,
    coadminUid: String(row.coadminUid || ''),
    createdBy: String(row.createdBy || ''),
    createdAt: row.createdAt ?? null,
  };
}

async function fetchPlayerGameLogins(scope: 'player' | 'coadmin', uid: string) {
  if (scope === 'player') {
    const response = await fetch('/api/player/play-data', {
      method: 'GET',
      headers: await getSqlApiReadHeaders(false),
      cache: 'no-store',
    });
    const payload = (await response.json().catch(() => ({}))) as {
      gameLogins?: Array<Record<string, unknown>>;
      error?: string;
    };
    if (!response.ok) {
      throw new Error(payload.error || 'Failed to load player play data.');
    }
    return (payload.gameLogins || []).map(mapCachedLogin);
  }

  const query = `coadminUid=${encodeURIComponent(uid)}`;
  const response = await fetch(`/api/player-game-logins/cache?${query}`, {
    method: 'GET',
    headers: await getSqlApiReadHeaders(false),
    cache: 'no-store',
  });
  const payload = (await response.json().catch(() => ({}))) as {
    playerGameLogins?: Array<Record<string, unknown>>;
    error?: string;
  };
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to load player game logins.');
  }
  return (payload.playerGameLogins || []).map(mapCachedLogin);
}

export function attachPlayerGameLoginsSqlPoll(input: {
  scope: 'player' | 'coadmin';
  uid: string;
  onChange: (logins: PlayerGameLogin[]) => void;
  onError?: (error: Error) => void;
  initialDelayMs?: number;
  pollEnabled?: boolean;
}) {
  logClientFirestoreSkipped('player_game_logins_listener', {
    scope: input.scope,
    uid: input.uid,
  });

  const runPoll = async () => {
    const logins = await fetchPlayerGameLogins(input.scope, input.uid);
    input.onChange(logins);
  };

  if (input.scope === 'player') {
    const pollEnabled = input.pollEnabled !== false;
    playerDebugLog('[POLLER_RETAINED]', {
      pollName: 'player_game_logins',
      reason: pollEnabled ? 'play_view_active_poll' : 'initial_fetch_only',
      initialDelayMs: Math.max(0, Number(input.initialDelayMs || 0)),
    });
    return createPlayerScopedPoll({
      pollName: 'player_game_logins',
      intervalMs: pollEnabled ? POLL_MS : 0,
      summaryRoute: '/api/player/play-data',
      onTick: runPoll,
      onError: input.onError,
      initialDelayMs: input.initialDelayMs,
    });
  }

  let cancelled = false;
  playerDebugLog('[POLLING_INVENTORY]', {
    route: '/api/player-game-logins/cache',
    intervalMs: 0,
    previousIntervalMs: POLL_MS,
    reason: 'coadmin_player_game_logins_startup_load',
    trigger: 'listenToPlayerGameLoginsByCoadmin',
    canUseSSE: true,
    required: 'initial_load_only',
  });
  playerDebugLog('[POLLING_DISABLED]', {
    route: '/api/player-game-logins/cache',
    replacement: 'initial_fetch_only_for_carer_page; local username mutations update page state and task SSE drives task cards',
  });

  const tick = async () => {
    if (cancelled) {
      return;
    }
    try {
      await runPoll();
    } catch (error) {
      if (!cancelled) {
        input.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    }
  };

  void tick();

  return () => {
    cancelled = true;
  };
}

export function isPlayerGameLoginsSqlReadEnabled() {
  return isClientSqlReadMode();
}
