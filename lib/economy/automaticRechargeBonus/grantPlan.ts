/**
 * Automatic Recharge Bonus — recharge-completion grant/shadow planner (Phase 6).
 *
 * Pure. Consumes evaluateArbEligibility + resolveAutomaticRechargeBonus.
 * Does NOT duplicate eligibility, cooldown, tier, or policy rules.
 *
 * FROZEN PIPELINE: this planner + applyArbOnRechargeCompleteInTxn are the only
 * supported path for Automatic Recharge Bonus financial decisions/writes.
 * See grantPipeline.ts.
 */

import {
  evaluateArbEligibility,
  type ArbEligibilityDecision,
} from '@/lib/economy/automaticRechargeBonus/eligibility';
import type { ArbPlayerGateContext } from '@/lib/economy/automaticRechargeBonus/playerPreference';
import {
  resolveAutomaticRechargeBonus,
} from '@/lib/economy/automaticRechargeBonus/resolve';
import type {
  ArbPublishedConfiguration,
  ArbResolveOutput,
} from '@/lib/economy/automaticRechargeBonus/types';

export type ArbEvaluationMode = 'shadow' | 'grant';
export type ArbEvaluationResult =
  | 'would_grant'
  | 'granted'
  | 'skipped'
  | 'blocked';

export type ArbRechargeGrantPlanInput = {
  preference: unknown;
  gates: ArbPlayerGateContext;
  published: ArbPublishedConfiguration | null;
  rechargeAmount: number;
  nowMs: number;
  grantsEnabled: boolean;
  shadowModeEnabled: boolean;
};

export type ArbRechargeGrantPlan =
  | { run: false; reason: 'flags_off' }
  | {
      run: true;
      mode: ArbEvaluationMode;
      writeFinances: boolean;
      evaluationResult: ArbEvaluationResult;
      eligible: boolean;
      bonusCoins: number;
      skipReason: string | null;
      tierId: string | null;
      versionId: string | null;
      versionNumber: number | null;
      eligibility: ArbEligibilityDecision;
      resolve: ArbResolveOutput;
    };

function blockedReceiveCodes(decision: ArbEligibilityDecision) {
  return decision.blockers.receiveAutoBonus.filter(
    (code) =>
      code === 'risk_blocked' ||
      code === 'emergency_disabled' ||
      code === 'global_kill_active' ||
      code === 'player_mode_disabled' ||
      code === 'feature_disabled'
  );
}

/**
 * Plan shadow evaluation and/or real grant for one recharge completion.
 * Financial writes occur only when writeFinances === true.
 */
export function planArbRechargeCompletionGrant(
  input: ArbRechargeGrantPlanInput
): ArbRechargeGrantPlan {
  if (!input.grantsEnabled && !input.shadowModeEnabled) {
    return { run: false, reason: 'flags_off' };
  }

  // Policy pipeline always evaluates as if grants could apply — financial gate is separate.
  const eligibility = evaluateArbEligibility({
    preference: input.preference,
    nowMs: input.nowMs,
    gates: input.gates,
    grantsEnabled: true,
  });

  const resolve = resolveAutomaticRechargeBonus({
    rechargeAmount: input.rechargeAmount,
    configuration: input.published,
  });

  const pipelineEligible =
    eligibility.canReceiveAutoBonus &&
    resolve.eligible &&
    resolve.bonusCoins > 0;

  const skipReason = pipelineEligible
    ? null
    : eligibility.blockers.receiveAutoBonus[0] ||
      resolve.skipReason ||
      'skipped';

  const hardBlocked = blockedReceiveCodes(eligibility).length > 0;

  if (input.grantsEnabled) {
    return {
      run: true,
      mode: 'grant',
      writeFinances: pipelineEligible,
      evaluationResult: pipelineEligible
        ? 'granted'
        : hardBlocked
          ? 'blocked'
          : 'skipped',
      eligible: pipelineEligible,
      bonusCoins: pipelineEligible ? resolve.bonusCoins : 0,
      skipReason,
      tierId: resolve.tier?.id ?? null,
      versionId: resolve.versionId,
      versionNumber: resolve.versionNumber,
      eligibility,
      resolve,
    };
  }

  // Shadow only
  return {
    run: true,
    mode: 'shadow',
    writeFinances: false,
    evaluationResult: pipelineEligible
      ? 'would_grant'
      : hardBlocked
        ? 'blocked'
        : 'skipped',
    eligible: pipelineEligible,
    bonusCoins: resolve.bonusCoins,
    skipReason,
    tierId: resolve.tier?.id ?? null,
    versionId: resolve.versionId,
    versionNumber: resolve.versionNumber,
    eligibility,
    resolve,
  };
}
