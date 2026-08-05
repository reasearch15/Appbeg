/**
 * Automatic Recharge Bonus — default seed configuration (Phase 2).
 * Linear $10 bands → floor(amount/10) coins, open-ended at $200+.
 */

import { randomUUID } from 'crypto';

import {
  ARB_DEFAULT_OPEN_ENDED_TIER_MIN,
  ARB_PLATFORM_DEFAULT_COOLDOWN_MINUTES,
  ARB_PLATFORM_DEFAULT_MINIMUM_RECHARGE,
} from '@/lib/economy/automaticRechargeBonus/constants';
import { defaultArbBusinessPolicy } from '@/lib/economy/automaticRechargeBonus/parse';
import type {
  ArbDraftConfiguration,
  ArbTier,
} from '@/lib/economy/automaticRechargeBonus/types';

export type BuildDefaultLinearTiersOptions = {
  /** Inclusive start of first band (default 10). */
  minimumRecharge?: number;
  /** First minAmount of the open-ended final tier (default 200). */
  openEndedMin?: number;
  /** Optional id factory for deterministic tests. */
  createId?: () => string;
};

/**
 * Build contiguous $10 bands:
 * 10–19 → 1, 20–29 → 2, … then open-ended at openEndedMin → floor(openEndedMin/10).
 */
export function buildDefaultLinearArbTiers(
  options: BuildDefaultLinearTiersOptions = {}
): ArbTier[] {
  const minimumRecharge = Math.trunc(
    options.minimumRecharge ?? ARB_PLATFORM_DEFAULT_MINIMUM_RECHARGE
  );
  const openEndedMin = Math.trunc(
    options.openEndedMin ?? ARB_DEFAULT_OPEN_ENDED_TIER_MIN
  );
  const createId = options.createId ?? (() => randomUUID());

  if (minimumRecharge < 1 || openEndedMin < minimumRecharge) {
    throw new Error('Invalid default linear tier bounds.');
  }

  const tiers: ArbTier[] = [];
  for (let min = minimumRecharge; min < openEndedMin; min += 10) {
    const max = min + 9;
    const bonusCoins = Math.floor(min / 10);
    tiers.push({
      id: createId(),
      minAmount: min,
      maxAmount: max,
      bonusCoins: Math.max(1, bonusCoins),
      label: `$${min}–${max}`,
      active: true,
    });
  }

  tiers.push({
    id: createId(),
    minAmount: openEndedMin,
    maxAmount: null,
    bonusCoins: Math.max(1, Math.floor(openEndedMin / 10)),
    label: `$${openEndedMin}+`,
    active: true,
  });

  return tiers;
}

export function buildDefaultArbDraftConfiguration(
  options: BuildDefaultLinearTiersOptions = {}
): ArbDraftConfiguration {
  return {
    policy: {
      ...defaultArbBusinessPolicy(),
      minimumRecharge:
        options.minimumRecharge ?? ARB_PLATFORM_DEFAULT_MINIMUM_RECHARGE,
      cooldownDurationMinutes: ARB_PLATFORM_DEFAULT_COOLDOWN_MINUTES,
    },
    tiers: buildDefaultLinearArbTiers(options),
  };
}
