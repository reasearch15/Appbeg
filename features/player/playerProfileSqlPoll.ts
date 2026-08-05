'use client';

import {
  getSessionMeOnce,
  patchCachedSessionMeBalances,
  subscribeSessionMe,
  type SessionMePayload,
} from '@/features/auth/sessionUser';
import { logClientFirestoreSkipped } from '@/lib/client/sqlReadMode';

export type PlayerProfileSqlSnapshot = {
  coin: number;
  cash: number;
  username: string;
  status: string | null;
  coadminUid: string | null;
  referralCode: string | null;
  referredByUid: string | null;
  referredByUsername: string | null;
  dismissedPaymentDetailsNoticeVersion: number;
  coadminPaymentDetailsNoticeVersion: number;
  referralBonusNotice: string | null;
  referralBonusNoticeAt: string | null;
  automaticBonusEnabled: boolean;
  bonusCooldownEndsAt: string | null;
  automaticBonusMode: 'enabled' | 'cooldown' | 'disabled';
  automaticBonusAvailable: boolean;
  automaticBonusPlayerModeEnabled: boolean;
  canDisableAutomaticBonus: boolean;
  automaticBonusFeatureEnabled: boolean;
  automaticBonusRiskBlocked: boolean;
  canClaimBonusEvent: boolean;
};

const DEFAULT_POLL_INTERVAL_MS = 20_000;

function mapSessionMeToProfile(payload: SessionMePayload): PlayerProfileSqlSnapshot | null {
  if (!payload.ok || !payload.uid) {
    return null;
  }

  const player = payload.player;
  const mode = player?.automaticBonusMode;
  return {
    coin: Number(player?.coin || 0),
    cash: Number(player?.cash || 0),
    username: String(payload.username || '').trim(),
    status: payload.status ?? null,
    coadminUid: String(payload.coadminUid || '').trim() || null,
    referralCode: String(player?.referralCode || '').trim() || null,
    referredByUid: String(player?.referredByUid || '').trim() || null,
    referredByUsername: String(player?.referredByUsername || '').trim() || null,
    dismissedPaymentDetailsNoticeVersion: Number(
      player?.dismissedPaymentDetailsNoticeVersion || 0
    ),
    coadminPaymentDetailsNoticeVersion: Number(
      player?.coadminPaymentDetailsNoticeVersion || 0
    ),
    referralBonusNotice: String(player?.referralBonusNotice || '').trim() || null,
    referralBonusNoticeAt: String(player?.referralBonusNoticeAt || '').trim() || null,
    automaticBonusEnabled: player?.automaticBonusEnabled === true,
    bonusCooldownEndsAt: String(player?.bonusCooldownEndsAt || '').trim() || null,
    automaticBonusMode:
      mode === 'enabled' || mode === 'cooldown' || mode === 'disabled'
        ? mode
        : 'disabled',
    automaticBonusAvailable: player?.automaticBonusAvailable === true,
    automaticBonusPlayerModeEnabled: player?.automaticBonusPlayerModeEnabled === true,
    canDisableAutomaticBonus: player?.canDisableAutomaticBonus === true,
    automaticBonusFeatureEnabled: player?.automaticBonusFeatureEnabled === true,
    automaticBonusRiskBlocked: player?.automaticBonusRiskBlocked === true,
    canClaimBonusEvent: player?.canClaimBonusEvent !== false,
  };
}

export function attachPlayerProfileSqlPoll(
  onChange: (profile: PlayerProfileSqlSnapshot) => void,
  options?: { intervalMs?: number; initialDelayMs?: number }
) {
  logClientFirestoreSkipped('player_profile_poll', { route: '/api/auth/session/me' });
  const intervalMs = Math.max(4_000, Number(options?.intervalMs || DEFAULT_POLL_INTERVAL_MS));
  const initialDelayMs = Math.max(0, Number(options?.initialDelayMs || 0));

  return subscribeSessionMe(
    'player_profile',
    (payload) => {
      const profile = mapSessionMeToProfile(payload);
      if (profile) {
        onChange(profile);
      }
    },
    {
      intervalMs,
      initialDelayMs,
    }
  );
}

export async function loadPlayerProfileSnapshotOnce(options?: {
  force?: boolean;
  bypassCache?: boolean;
}): Promise<PlayerProfileSqlSnapshot | null> {
  logClientFirestoreSkipped('player_profile_once', { route: '/api/auth/session/me' });
  const payload = await getSessionMeOnce({
    maxAgeMs: options?.force || options?.bypassCache ? 0 : 1_000,
    force: options?.force || options?.bypassCache,
    bypassCache: options?.bypassCache,
  });
  return payload ? mapSessionMeToProfile(payload) : null;
}

export function applyAuthoritativeWalletToProfileCache(input: {
  cash?: number | null;
  coin?: number | null;
}) {
  patchCachedSessionMeBalances(input);
}
