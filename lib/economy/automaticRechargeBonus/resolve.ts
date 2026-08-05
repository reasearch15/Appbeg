/**
 * Automatic Recharge Bonus — pure reward resolver (Phase 2).
 *
 * Deterministic: same inputs → same output.
 * No DB, time, session, or player-state dependencies.
 * Player-mode / risk / emergency gates belong in later grant phases.
 */

import { activeNormalizedArbTiers } from '@/lib/economy/automaticRechargeBonus/normalize';
import type {
  ArbResolveInput,
  ArbResolveOutput,
  ArbTier,
} from '@/lib/economy/automaticRechargeBonus/types';

function isWholeNonNegative(value: number) {
  return Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function findMatchingTier(amount: number, tiers: ArbTier[]): ArbTier | null {
  for (const tier of tiers) {
    const max = tier.maxAmount === null ? Number.POSITIVE_INFINITY : tier.maxAmount;
    if (amount >= tier.minAmount && amount <= max) {
      return tier;
    }
  }
  return null;
}

export function resolveAutomaticRechargeBonus(
  input: ArbResolveInput
): ArbResolveOutput {
  const amount = Number(input.rechargeAmount);
  const configuration = input.configuration;

  const base = {
    eligible: false,
    bonusCoins: 0,
    tier: null as ArbTier | null,
    versionId: configuration?.versionId ?? null,
    versionNumber: configuration?.versionNumber ?? null,
    rechargeAmount: Number.isFinite(amount) ? amount : Number.NaN,
    uncappedBonusCoins: null as number | null,
    appliedCap: null as number | null,
  };

  if (!configuration) {
    return { ...base, skipReason: 'no_published_configuration' };
  }

  if (!isWholeNonNegative(amount)) {
    return {
      ...base,
      versionId: configuration.versionId,
      versionNumber: configuration.versionNumber,
      skipReason: 'invalid_amount',
    };
  }

  const wholeAmount = Math.trunc(amount);
  const policy = configuration.policy;

  if (wholeAmount < policy.minimumRecharge) {
    return {
      ...base,
      rechargeAmount: wholeAmount,
      versionId: configuration.versionId,
      versionNumber: configuration.versionNumber,
      skipReason: 'below_minimum_recharge',
    };
  }

  if (
    policy.maximumRechargeConsidered !== null &&
    wholeAmount > policy.maximumRechargeConsidered
  ) {
    return {
      ...base,
      rechargeAmount: wholeAmount,
      versionId: configuration.versionId,
      versionNumber: configuration.versionNumber,
      skipReason: 'above_maximum_recharge_considered',
    };
  }

  const activeTiers = activeNormalizedArbTiers(configuration.tiers);
  if (activeTiers.length === 0) {
    return {
      ...base,
      rechargeAmount: wholeAmount,
      versionId: configuration.versionId,
      versionNumber: configuration.versionNumber,
      skipReason: 'empty_tiers',
    };
  }

  const tier = findMatchingTier(wholeAmount, activeTiers);
  if (!tier) {
    return {
      ...base,
      rechargeAmount: wholeAmount,
      versionId: configuration.versionId,
      versionNumber: configuration.versionNumber,
      skipReason: 'no_matching_tier',
    };
  }

  const uncapped = Math.trunc(tier.bonusCoins);
  const cap = policy.maximumBonusCap;
  const appliedCap = cap === null ? null : Math.trunc(cap);
  const bonusCoins =
    appliedCap === null ? uncapped : Math.min(uncapped, Math.max(0, appliedCap));

  if (bonusCoins <= 0) {
    return {
      eligible: false,
      bonusCoins: 0,
      skipReason: 'bonus_capped_to_zero',
      tier,
      versionId: configuration.versionId,
      versionNumber: configuration.versionNumber,
      rechargeAmount: wholeAmount,
      uncappedBonusCoins: uncapped,
      appliedCap,
    };
  }

  return {
    eligible: true,
    bonusCoins,
    skipReason: null,
    tier,
    versionId: configuration.versionId,
    versionNumber: configuration.versionNumber,
    rechargeAmount: wholeAmount,
    uncappedBonusCoins: uncapped,
    appliedCap,
  };
}

/** Preview helper: resolve many sample amounts against one published config. */
export function previewAutomaticRechargeBonusTable(
  configuration: ArbResolveInput['configuration'],
  amounts: number[]
): ArbResolveOutput[] {
  return amounts.map((rechargeAmount) =>
    resolveAutomaticRechargeBonus({ rechargeAmount, configuration })
  );
}
