/**
 * Automatic Recharge Bonus — authoritative eligibility helper.
 *
 * Single source of truth for all ARB state decisions. Future phases MUST consume
 * this helper rather than re-implementing eligibility rules.
 *
 * Pure / deterministic. No I/O. No financial side effects.
 */

import {
  evaluateArbPlayerEnableGates,
  parseArbPlayerPreferenceState,
  resolveArbPlayerBonusMode,
  type ArbPlayerBonusMode,
  type ArbPlayerGateContext,
  type ArbPlayerPreferenceState,
  type ArbPlayerToggleErrorCode,
} from '@/lib/economy/automaticRechargeBonus/playerPreference';

/** All machine-readable blocker codes used across ARB capabilities. */
export type ArbEligibilityBlockerCode =
  | ArbPlayerToggleErrorCode
  | 'auto_bonus_enabled'
  | 'auto_bonus_cooldown'
  | 'grants_disabled'
  | 'not_enabled'
  | 'already_disabled';

export type ArbEligibilityInput = {
  preference: ArbPlayerPreferenceState | unknown;
  /** Epoch ms — inject for tests. */
  nowMs: number;
  /** Platform + coadmin + risk gates (same shape as Phase 4 enable gates). */
  gates: ArbPlayerGateContext;
  /**
   * When false, canReceiveAutoBonus is always blocked with grants_disabled.
   * Claim mutual-exclusion still follows preference mode (enabled/cooldown).
   */
  grantsEnabled: boolean;
};

export type ArbEligibilityCapabilityBlockers = {
  enable: ArbEligibilityBlockerCode[];
  disable: ArbEligibilityBlockerCode[];
  claimBonusEvent: ArbEligibilityBlockerCode[];
  receiveAutoBonus: ArbEligibilityBlockerCode[];
};

export type ArbEligibilityDecision = {
  preference: ArbPlayerPreferenceState;
  currentMode: ArbPlayerBonusMode;
  canEnable: boolean;
  canDisable: boolean;
  canClaimBonusEvent: boolean;
  canReceiveAutoBonus: boolean;
  /** Per-capability blockers (authoritative). */
  blockers: ArbEligibilityCapabilityBlockers;
  /**
   * Flat union of all blockers across capabilities — useful for logging.
   * Prefer capability-specific lists for API responses.
   */
  allBlockers: ArbEligibilityBlockerCode[];
};

function uniqueCodes(codes: ArbEligibilityBlockerCode[]) {
  return [...new Set(codes)];
}

/**
 * Evaluate every Automatic Recharge Bonus eligibility decision from one input.
 */
export function evaluateArbEligibility(
  input: ArbEligibilityInput
): ArbEligibilityDecision {
  const preference =
    input.preference &&
    typeof input.preference === 'object' &&
    'automaticBonusEnabled' in (input.preference as object)
      ? (input.preference as ArbPlayerPreferenceState)
      : parseArbPlayerPreferenceState(input.preference);

  const currentMode = resolveArbPlayerBonusMode(preference, input.nowMs);
  const enableEval = evaluateArbPlayerEnableGates(input.gates);

  const enableBlockers: ArbEligibilityBlockerCode[] = [...enableEval.blockers];
  const canEnable = enableEval.available;

  const disableBlockers: ArbEligibilityBlockerCode[] = [];
  if (!preference.automaticBonusEnabled) {
    disableBlockers.push('already_disabled');
  }
  if (!input.gates.playerModeEnabled) {
    disableBlockers.push('player_mode_disabled');
  }
  const canDisable =
    preference.automaticBonusEnabled === true && input.gates.playerModeEnabled;

  const claimBlockers: ArbEligibilityBlockerCode[] = [];
  // Mutual exclusivity: Auto ON or active cooldown blocks Bonus Event claims.
  // Preference truth wins even if player-mode flag is later turned off.
  if (currentMode === 'enabled') {
    claimBlockers.push('auto_bonus_enabled');
  } else if (currentMode === 'cooldown') {
    claimBlockers.push('auto_bonus_cooldown');
  }
  if (input.gates.riskBlocked) {
    claimBlockers.push('risk_blocked');
  }
  const canClaimBonusEvent = claimBlockers.length === 0;

  const receiveBlockers: ArbEligibilityBlockerCode[] = [];
  if (!input.grantsEnabled) {
    receiveBlockers.push('grants_disabled');
  }
  if (currentMode !== 'enabled') {
    receiveBlockers.push('not_enabled');
  }
  // Grants also require the same operational safety gates as enable
  // (except player_opt_in — already opted in if enabled).
  if (!input.gates.playerModeEnabled) {
    receiveBlockers.push('player_mode_disabled');
  }
  if (input.gates.globalKillActive) {
    receiveBlockers.push('global_kill_active');
  }
  if (!input.gates.featureEnabled) {
    receiveBlockers.push('feature_disabled');
  }
  if (input.gates.emergencyDisable) {
    receiveBlockers.push('emergency_disabled');
  }
  if (input.gates.riskBlocked) {
    receiveBlockers.push('risk_blocked');
  }
  if (!input.gates.hasPublishedConfiguration) {
    receiveBlockers.push('no_published_configuration');
  }
  const canReceiveAutoBonus = receiveBlockers.length === 0;

  const blockers: ArbEligibilityCapabilityBlockers = {
    enable: uniqueCodes(enableBlockers),
    disable: uniqueCodes(disableBlockers),
    claimBonusEvent: uniqueCodes(claimBlockers),
    receiveAutoBonus: uniqueCodes(receiveBlockers),
  };

  return {
    preference,
    currentMode,
    canEnable,
    canDisable,
    canClaimBonusEvent,
    canReceiveAutoBonus,
    blockers,
    allBlockers: uniqueCodes([
      ...blockers.enable,
      ...blockers.disable,
      ...blockers.claimBonusEvent,
      ...blockers.receiveAutoBonus,
    ]),
  };
}

/** Stable human messages for claim-gate API responses. */
export function arbClaimBonusEventBlockMessage(
  code: ArbEligibilityBlockerCode
): string {
  switch (code) {
    case 'auto_bonus_enabled':
      return 'Bonus Events are locked while Automatic Recharge Bonus is enabled.';
    case 'auto_bonus_cooldown':
      return 'Bonus Events are locked during the Automatic Recharge Bonus cooldown.';
    case 'risk_blocked':
      return 'Bonus play is temporarily blocked for this account.';
    default:
      return 'Bonus Events are currently unavailable.';
  }
}

/**
 * Convenience assert for Bonus Event initiate paths.
 * Throws Error with `.code` and `.blockers` when claim is not allowed.
 */
export function assertArbCanClaimBonusEvent(
  decision: ArbEligibilityDecision
): void {
  if (decision.canClaimBonusEvent) return;
  const code = decision.blockers.claimBonusEvent[0] || 'invalid_request';
  const error = new Error(arbClaimBonusEventBlockMessage(code)) as Error & {
    code: ArbEligibilityBlockerCode;
    blockers: ArbEligibilityBlockerCode[];
  };
  error.code = code;
  error.blockers = decision.blockers.claimBonusEvent;
  throw error;
}
