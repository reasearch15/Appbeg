/**
 * Automatic Recharge Bonus — tier / policy normalization (Phase 2).
 * Deterministic. No I/O.
 */

import type { ArbBusinessPolicy, ArbTier } from '@/lib/economy/automaticRechargeBonus/types';

function toWholeNumber(value: number) {
  return Math.trunc(value);
}

/**
 * Normalize tiers for storage/publish:
 * - trim ids/labels
 * - truncate amounts/coins to integers
 * - sort by minAmount ascending, then maxAmount (nulls last), then id
 * Does not remove inactive tiers (validation decides).
 */
export function normalizeArbTiers(tiers: ArbTier[]): ArbTier[] {
  const normalized = tiers.map((tier) => ({
    id: String(tier.id || '').trim(),
    minAmount: toWholeNumber(Number(tier.minAmount)),
    maxAmount:
      tier.maxAmount === null || tier.maxAmount === undefined
        ? null
        : toWholeNumber(Number(tier.maxAmount)),
    bonusCoins: toWholeNumber(Number(tier.bonusCoins)),
    label:
      tier.label === null || tier.label === undefined
        ? null
        : String(tier.label).trim() || null,
    active: tier.active !== false,
  }));

  normalized.sort((a, b) => {
    if (a.minAmount !== b.minAmount) return a.minAmount - b.minAmount;
    const aMax = a.maxAmount === null ? Number.POSITIVE_INFINITY : a.maxAmount;
    const bMax = b.maxAmount === null ? Number.POSITIVE_INFINITY : b.maxAmount;
    if (aMax !== bMax) return aMax - bMax;
    return a.id.localeCompare(b.id);
  });

  return normalized;
}

export function normalizeArbBusinessPolicy(policy: ArbBusinessPolicy): ArbBusinessPolicy {
  return {
    minimumRecharge: toWholeNumber(Number(policy.minimumRecharge)),
    maximumRechargeConsidered:
      policy.maximumRechargeConsidered === null ||
      policy.maximumRechargeConsidered === undefined
        ? null
        : toWholeNumber(Number(policy.maximumRechargeConsidered)),
    maximumBonusCap:
      policy.maximumBonusCap === null || policy.maximumBonusCap === undefined
        ? null
        : toWholeNumber(Number(policy.maximumBonusCap)),
    cooldownDurationMinutes: toWholeNumber(Number(policy.cooldownDurationMinutes)),
  };
}

/** Active tiers only, still normalized/sorted. */
export function activeNormalizedArbTiers(tiers: ArbTier[]): ArbTier[] {
  return normalizeArbTiers(tiers).filter((tier) => tier.active);
}

/**
 * Inclusive integer range overlap check.
 * Open-ended max (null) extends to +Infinity.
 */
export function arbTierOverlap(a: ArbTier, b: ArbTier): boolean {
  const aMax = a.maxAmount === null ? Number.POSITIVE_INFINITY : a.maxAmount;
  const bMax = b.maxAmount === null ? Number.POSITIVE_INFINITY : b.maxAmount;
  return a.minAmount <= bMax && b.minAmount <= aMax;
}

export function nextArbVersionNumber(latestVersionNumber: number | null | undefined) {
  const latest = Number(latestVersionNumber);
  if (!Number.isFinite(latest) || latest < 1) return 1;
  return Math.trunc(latest) + 1;
}
