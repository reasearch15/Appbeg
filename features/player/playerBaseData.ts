import { playerDebugLog } from '@/lib/client/playerDebugLogs';
import { getPlayerApiHeaders, PlayerSessionStaleError } from '@/features/auth/playerSession';
import { resolvePlayerRoleForFetch } from '@/lib/client/playerFetchGuard';
import type { GameLogin } from '@/features/games/gameLogins';
import type { ReferralRewardGroup } from '@/features/referrals/playerReferralRewards';

export type PlayerBaseDataStaff = {
  id: string;
  uid: string;
  username: string;
  email: string;
  role: 'staff';
  status: 'active' | 'disabled';
  createdBy: string | null;
  coadminUid?: string | null;
};

export type PlayerBaseDataResponse = {
  staff: PlayerBaseDataStaff[];
  gameLogins: GameLogin[];
  pendingGift: {
    hasPendingGift: boolean;
    giftId: string | null;
    source: 'postgres' | 'firestore' | 'none';
  };
  referralRewards: {
    groups: ReferralRewardGroup[];
    source: 'postgres' | 'firestore' | 'none';
  };
  source: 'postgres' | 'mixed' | 'fallback';
  snapshotAt: string;
};

let inFlightBaseData: Promise<PlayerBaseDataResponse> | null = null;

function normalizeBaseDataResponse(
  payload: PlayerBaseDataResponse & { error?: string }
): PlayerBaseDataResponse {
  return {
    staff: Array.isArray(payload.staff) ? payload.staff : [],
    gameLogins: Array.isArray(payload.gameLogins) ? payload.gameLogins : [],
    pendingGift: {
      hasPendingGift: Boolean(payload.pendingGift?.hasPendingGift),
      giftId: payload.pendingGift?.giftId ?? null,
      source: payload.pendingGift?.source || 'none',
    },
    referralRewards: {
      groups: Array.isArray(payload.referralRewards?.groups)
        ? payload.referralRewards.groups
        : [],
      source: payload.referralRewards?.source || 'none',
    },
    source: payload.source || 'fallback',
    snapshotAt: payload.snapshotAt || new Date().toISOString(),
  };
}

export async function loadPlayerBaseData(): Promise<PlayerBaseDataResponse> {
  if (inFlightBaseData) {
    playerDebugLog('[PLAYER_BASE_DATA_CLIENT]', {
      stage: 'start',
      deduped: true,
      usedFallback: false,
    });
    return inFlightBaseData;
  }

  playerDebugLog('[PLAYER_BASE_DATA_CLIENT]', {
    stage: 'start',
    deduped: false,
    usedFallback: false,
  });

  inFlightBaseData = (async () => {
    const startedAt = Date.now();
    try {
      const sessionUser = await resolvePlayerRoleForFetch('/api/player/base-data');
      if (!sessionUser) {
        throw new Error('Player role required.');
      }
      const headers = await getPlayerApiHeaders(false, { route: '/api/player/base-data' });
      const response = await fetch('/api/player/base-data', {
        method: 'GET',
        headers,
        cache: 'no-store',
      });
      const payload = (await response.json().catch(() => ({}))) as PlayerBaseDataResponse & {
        error?: string;
      };
      if (!response.ok) {
        playerDebugLog('[PLAYER_BASE_DATA_CLIENT]', {
          stage: 'http_error',
          status: response.status,
          logout_suppressed: response.status === 401,
        });
        throw new Error(payload.error || 'Failed to load player base data.');
      }

      const normalized = normalizeBaseDataResponse(payload);
      playerDebugLog('[PLAYER_BASE_DATA_CLIENT]', {
        stage: 'done',
        deduped: false,
        usedFallback: false,
        staffCount: normalized.staff.length,
        gameLoginCount: normalized.gameLogins.length,
        referralGroupCount: normalized.referralRewards.groups.length,
        hasPendingGift: normalized.pendingGift.hasPendingGift,
        source: normalized.source,
        durationMs: Date.now() - startedAt,
      });

      return normalized;
    } catch (error) {
      if (error instanceof PlayerSessionStaleError) {
        playerDebugLog('[PLAYER_BASE_DATA_CLIENT]', {
          stage: 'stale_ignored',
          reason: error.message,
          durationMs: Date.now() - startedAt,
        });
        return normalizeBaseDataResponse({
          staff: [],
          gameLogins: [],
          pendingGift: { hasPendingGift: false, giftId: null, source: 'none' },
          referralRewards: { groups: [], source: 'none' },
          source: 'postgres',
          snapshotAt: new Date().toISOString(),
        });
      }
      throw error;
    }
  })();

  try {
    return await inFlightBaseData;
  } finally {
    inFlightBaseData = null;
  }
}
