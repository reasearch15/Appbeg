'use client';

import { getPlayerApiHeaders } from '@/features/auth/playerSession';

export type ArbPlayerMode = 'enabled' | 'cooldown' | 'disabled';

export type ArbPlayerPreferenceClientSnapshot = {
  playerUid: string;
  coadminUid: string;
  preference: {
    automaticBonusEnabled: boolean;
    bonusCooldownEndsAt: string | null;
    updatedAt: string | null;
  };
  mode: ArbPlayerMode;
  availability: {
    available: boolean;
    blockers: string[];
  };
  eligibility: {
    canEnable: boolean;
    canDisable: boolean;
    canClaimBonusEvent: boolean;
    canReceiveAutoBonus: boolean;
    currentMode: ArbPlayerMode;
    blockers: {
      enable: string[];
      disable: string[];
      claimBonusEvent: string[];
      receiveAutoBonus: string[];
    };
  };
  cooldownDurationMinutes: number;
  gates: {
    playerModeEnabled: boolean;
    globalKillActive: boolean;
    featureEnabled: boolean;
    emergencyDisable: boolean;
    playerOptInAllowed: boolean;
    riskBlocked: boolean;
    hasPublishedConfiguration: boolean;
    riskBlockedUntil: string | null;
  };
};

export class ArbPlayerPreferenceClientError extends Error {
  code: string;
  blockers: string[];
  status: number;

  constructor(message: string, code: string, blockers: string[], status: number) {
    super(message);
    this.name = 'ArbPlayerPreferenceClientError';
    this.code = code;
    this.blockers = blockers;
    this.status = status;
  }
}

function newIdempotencyKey() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `arb-pref-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function fetchArbPlayerPreference(): Promise<
  ArbPlayerPreferenceClientSnapshot & { playerModeEnabled: boolean }
> {
  const headers = await getPlayerApiHeaders(false, {
    route: '/api/player/automatic-recharge-bonus',
  });
  const response = await fetch('/api/player/automatic-recharge-bonus', {
    method: 'GET',
    credentials: 'include',
    headers,
    cache: 'no-store',
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new ArbPlayerPreferenceClientError(
      String(payload.error || 'Failed to load Automatic Recharge Bonus preference.'),
      String(payload.code || 'request_failed'),
      Array.isArray(payload.blockers) ? (payload.blockers as string[]) : [],
      response.status
    );
  }
  return {
    ...(payload as unknown as ArbPlayerPreferenceClientSnapshot),
    playerModeEnabled: payload.playerModeEnabled === true,
  };
}

export async function setArbPlayerPreference(enabled: boolean): Promise<{
  duplicate: boolean;
  changed: boolean;
  transition: 'on_to_off' | 'off_to_on' | null;
  startedCooldown: boolean;
  cancelledCooldown: boolean;
  snapshot: ArbPlayerPreferenceClientSnapshot;
}> {
  const headers = await getPlayerApiHeaders(true, {
    route: '/api/player/automatic-recharge-bonus',
  });
  const idempotencyKey = newIdempotencyKey();
  headers['Idempotency-Key'] = idempotencyKey;
  const response = await fetch('/api/player/automatic-recharge-bonus', {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify({ enabled, idempotencyKey }),
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new ArbPlayerPreferenceClientError(
      String(payload.error || 'Failed to update Automatic Recharge Bonus preference.'),
      String(payload.code || 'request_failed'),
      Array.isArray(payload.blockers) ? (payload.blockers as string[]) : [],
      response.status
    );
  }
  return {
    duplicate: payload.duplicate === true,
    changed: payload.changed === true,
    transition:
      payload.transition === 'on_to_off' || payload.transition === 'off_to_on'
        ? payload.transition
        : null,
    startedCooldown: payload.startedCooldown === true,
    cancelledCooldown: payload.cancelledCooldown === true,
    snapshot: payload as unknown as ArbPlayerPreferenceClientSnapshot,
  };
}

export function formatArbCooldownRemaining(
  endsAt: string | null | undefined,
  nowMs: number = Date.now()
): string | null {
  if (!endsAt) return null;
  const endMs = Date.parse(endsAt);
  if (!Number.isFinite(endMs) || endMs <= nowMs) return null;
  const totalSec = Math.max(0, Math.ceil((endMs - nowMs) / 1000));
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

export function arbClaimLockReasonFromMode(
  mode: ArbPlayerMode | null | undefined,
  canClaim: boolean
): string | null {
  if (canClaim) return null;
  if (mode === 'enabled') {
    return 'Bonus Events are locked while Automatic Recharge Bonus is on.';
  }
  if (mode === 'cooldown') {
    return 'Bonus Events are locked during the Automatic Recharge Bonus cooldown.';
  }
  return 'Bonus Events are currently unavailable.';
}
