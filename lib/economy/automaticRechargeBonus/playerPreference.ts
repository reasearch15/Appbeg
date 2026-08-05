/**
 * Automatic Recharge Bonus — player preference state machine (Phase 4).
 * Pure. Deterministic. No I/O. No financial side effects.
 *
 * Rules:
 * - Cooldown NEVER runs while Auto Bonus is enabled.
 * - Cooldown ONLY begins after an ON → OFF transition.
 * - OFF → ON cancels any active cooldown.
 */

import { ARB_PLATFORM_DEFAULT_COOLDOWN_MINUTES } from '@/lib/economy/automaticRechargeBonus/constants';

export type ArbPlayerBonusMode = 'enabled' | 'cooldown' | 'disabled';

export type ArbPlayerPreferenceState = {
  automaticBonusEnabled: boolean;
  /** ISO timestamp; null when no cooldown. Must be null while enabled. */
  bonusCooldownEndsAt: string | null;
  updatedAt: string | null;
};

export type ArbPlayerToggleErrorCode =
  | 'player_mode_disabled'
  | 'global_kill_active'
  | 'feature_disabled'
  | 'emergency_disabled'
  | 'player_opt_in_disabled'
  | 'risk_blocked'
  | 'no_published_configuration'
  | 'invalid_request'
  | 'player_not_found';

export type ArbPlayerGateContext = {
  playerModeEnabled: boolean;
  globalKillActive: boolean;
  featureEnabled: boolean;
  emergencyDisable: boolean;
  playerOptInAllowed: boolean;
  riskBlocked: boolean;
  hasPublishedConfiguration: boolean;
};

export type ArbPlayerAvailability = {
  available: boolean;
  blockers: ArbPlayerToggleErrorCode[];
};

export function defaultArbPlayerPreferenceState(): ArbPlayerPreferenceState {
  return {
    automaticBonusEnabled: false,
    bonusCooldownEndsAt: null,
    updatedAt: null,
  };
}

export function parseArbPlayerPreferenceState(
  raw: unknown
): ArbPlayerPreferenceState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return defaultArbPlayerPreferenceState();
  }
  const record = raw as Record<string, unknown>;
  const enabled = record.automaticBonusEnabled === true;
  const cooldownRaw = record.bonusCooldownEndsAt;
  let bonusCooldownEndsAt: string | null = null;
  if (typeof cooldownRaw === 'string' && cooldownRaw.trim()) {
    const ms = Date.parse(cooldownRaw);
    if (Number.isFinite(ms)) {
      bonusCooldownEndsAt = new Date(ms).toISOString();
    }
  }
  // Invariant: cooldown never runs while enabled.
  if (enabled) {
    bonusCooldownEndsAt = null;
  }
  const updatedAt =
    typeof record.automaticBonusUpdatedAt === 'string' &&
    record.automaticBonusUpdatedAt.trim()
      ? record.automaticBonusUpdatedAt
      : null;
  return {
    automaticBonusEnabled: enabled,
    bonusCooldownEndsAt,
    updatedAt,
  };
}

export function resolveArbPlayerBonusMode(
  state: ArbPlayerPreferenceState,
  nowMs: number
): ArbPlayerBonusMode {
  if (state.automaticBonusEnabled) return 'enabled';
  if (state.bonusCooldownEndsAt) {
    const ends = Date.parse(state.bonusCooldownEndsAt);
    if (Number.isFinite(ends) && ends > nowMs) return 'cooldown';
  }
  return 'disabled';
}

export function evaluateArbPlayerEnableGates(
  gates: ArbPlayerGateContext
): ArbPlayerAvailability {
  const blockers: ArbPlayerToggleErrorCode[] = [];
  if (!gates.playerModeEnabled) blockers.push('player_mode_disabled');
  if (gates.globalKillActive) blockers.push('global_kill_active');
  if (!gates.featureEnabled) blockers.push('feature_disabled');
  if (gates.emergencyDisable) blockers.push('emergency_disabled');
  if (!gates.playerOptInAllowed) blockers.push('player_opt_in_disabled');
  if (gates.riskBlocked) blockers.push('risk_blocked');
  if (!gates.hasPublishedConfiguration) blockers.push('no_published_configuration');
  return { available: blockers.length === 0, blockers };
}

export type ArbPlayerTogglePlanInput = {
  current: ArbPlayerPreferenceState;
  requestedEnabled: boolean;
  /** Epoch ms — inject for tests. */
  nowMs: number;
  cooldownDurationMinutes: number;
};

export type ArbPlayerTogglePlan =
  | {
      changed: false;
      reason: 'already_in_requested_state';
      next: ArbPlayerPreferenceState;
      transition: null;
    }
  | {
      changed: true;
      transition: 'on_to_off' | 'off_to_on';
      next: ArbPlayerPreferenceState;
      startedCooldown: boolean;
      cancelledCooldown: boolean;
    };

/**
 * Pure preference transition planner.
 * Does not apply operational gates — callers reject enable before calling this
 * when gates fail. Disable is always planned when currently enabled.
 */
export function planArbPlayerPreferenceToggle(
  input: ArbPlayerTogglePlanInput
): ArbPlayerTogglePlan {
  const currentEnabled = input.current.automaticBonusEnabled === true;
  const requested = input.requestedEnabled === true;
  const nowIso = new Date(input.nowMs).toISOString();

  if (currentEnabled === requested) {
    // Keep invariant even on no-op: enabled ⇒ no cooldown.
    const next: ArbPlayerPreferenceState = {
      automaticBonusEnabled: currentEnabled,
      bonusCooldownEndsAt: currentEnabled ? null : input.current.bonusCooldownEndsAt,
      updatedAt: input.current.updatedAt,
    };
    return {
      changed: false,
      reason: 'already_in_requested_state',
      next,
      transition: null,
    };
  }

  const minutes = Number(input.cooldownDurationMinutes);
  const cooldownMinutes =
    Number.isFinite(minutes) && minutes > 0
      ? Math.trunc(minutes)
      : ARB_PLATFORM_DEFAULT_COOLDOWN_MINUTES;

  if (currentEnabled && !requested) {
    // ON → OFF: start cooldown.
    const endsAt = new Date(
      input.nowMs + cooldownMinutes * 60_000
    ).toISOString();
    return {
      changed: true,
      transition: 'on_to_off',
      startedCooldown: true,
      cancelledCooldown: false,
      next: {
        automaticBonusEnabled: false,
        bonusCooldownEndsAt: endsAt,
        updatedAt: nowIso,
      },
    };
  }

  // OFF → ON: cancel cooldown.
  return {
    changed: true,
    transition: 'off_to_on',
    startedCooldown: false,
    cancelledCooldown: Boolean(input.current.bonusCooldownEndsAt),
    next: {
      automaticBonusEnabled: true,
      bonusCooldownEndsAt: null,
      updatedAt: nowIso,
    },
  };
}

export function serializeArbPlayerPreferenceRawPatch(
  state: ArbPlayerPreferenceState
): Record<string, unknown> {
  return {
    automaticBonusEnabled: state.automaticBonusEnabled === true,
    bonusCooldownEndsAt: state.automaticBonusEnabled
      ? null
      : state.bonusCooldownEndsAt,
    automaticBonusUpdatedAt: state.updatedAt,
  };
}

export function resolveCooldownDurationMinutes(
  publishedCooldownMinutes: number | null | undefined
) {
  const value = Number(publishedCooldownMinutes);
  if (Number.isFinite(value) && value > 0) return Math.trunc(value);
  return ARB_PLATFORM_DEFAULT_COOLDOWN_MINUTES;
}
