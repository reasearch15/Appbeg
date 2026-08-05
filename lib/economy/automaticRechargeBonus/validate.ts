/**
 * Automatic Recharge Bonus — configuration validation (Phase 2).
 * Deterministic machine-readable errors. No I/O.
 */

import {
  ARB_PLATFORM_COOLDOWN_MAX_MINUTES,
  ARB_PLATFORM_COOLDOWN_MIN_MINUTES,
  ARB_PLATFORM_MAX_BONUS_COINS_HARD,
  ARB_PLATFORM_MAX_RECHARGE_AMOUNT_HARD,
  ARB_PLATFORM_MINIMUM_RECHARGE_FLOOR,
} from '@/lib/economy/automaticRechargeBonus/constants';
import {
  activeNormalizedArbTiers,
  arbTierOverlap,
  normalizeArbBusinessPolicy,
  normalizeArbTiers,
} from '@/lib/economy/automaticRechargeBonus/normalize';
import {
  parseArbBusinessPolicy,
  parseArbTiers,
} from '@/lib/economy/automaticRechargeBonus/parse';
import type {
  ArbBusinessPolicy,
  ArbDraftConfiguration,
  ArbTier,
  ArbValidationError,
  ArbValidationResult,
} from '@/lib/economy/automaticRechargeBonus/types';

function err(
  code: ArbValidationError['code'],
  message: string,
  path?: string,
  details?: Record<string, unknown>
): ArbValidationError {
  return { code, message, path, details };
}

function isWholeNumber(value: number) {
  return Number.isFinite(value) && Number.isInteger(value);
}

export function validateArbBusinessPolicy(
  policyInput: ArbBusinessPolicy | unknown
): ArbValidationResult {
  const errors: ArbValidationError[] = [];
  const warnings: ArbValidationError[] = [];

  const parsed =
    policyInput && typeof policyInput === 'object' && 'minimumRecharge' in (policyInput as object)
      ? normalizeArbBusinessPolicy(policyInput as ArbBusinessPolicy)
      : parseArbBusinessPolicy(policyInput);

  if (!parsed) {
    return {
      ok: false,
      errors: [err('policy_not_object', 'Business policy must be a JSON object.', 'policy')],
      warnings,
    };
  }

  const policy = normalizeArbBusinessPolicy(parsed);

  if (!isWholeNumber(policy.minimumRecharge) || policy.minimumRecharge <= 0) {
    errors.push(
      err(
        'minimum_recharge_invalid',
        'minimumRecharge must be a positive whole number.',
        'policy.minimumRecharge',
        { value: policy.minimumRecharge }
      )
    );
  } else if (policy.minimumRecharge < ARB_PLATFORM_MINIMUM_RECHARGE_FLOOR) {
    errors.push(
      err(
        'minimum_recharge_below_platform_floor',
        `minimumRecharge must be >= ${ARB_PLATFORM_MINIMUM_RECHARGE_FLOOR}.`,
        'policy.minimumRecharge',
        {
          value: policy.minimumRecharge,
          floor: ARB_PLATFORM_MINIMUM_RECHARGE_FLOOR,
        }
      )
    );
  }

  if (policy.maximumRechargeConsidered !== null) {
    if (
      !isWholeNumber(policy.maximumRechargeConsidered) ||
      policy.maximumRechargeConsidered <= 0
    ) {
      errors.push(
        err(
          'maximum_recharge_invalid',
          'maximumRechargeConsidered must be null or a positive whole number.',
          'policy.maximumRechargeConsidered',
          { value: policy.maximumRechargeConsidered }
        )
      );
    } else if (
      isWholeNumber(policy.minimumRecharge) &&
      policy.maximumRechargeConsidered < policy.minimumRecharge
    ) {
      errors.push(
        err(
          'maximum_recharge_below_minimum',
          'maximumRechargeConsidered must be >= minimumRecharge.',
          'policy.maximumRechargeConsidered',
          {
            maximumRechargeConsidered: policy.maximumRechargeConsidered,
            minimumRecharge: policy.minimumRecharge,
          }
        )
      );
    } else if (policy.maximumRechargeConsidered > ARB_PLATFORM_MAX_RECHARGE_AMOUNT_HARD) {
      errors.push(
        err(
          'tier_amount_above_hard_max',
          `maximumRechargeConsidered exceeds hard max ${ARB_PLATFORM_MAX_RECHARGE_AMOUNT_HARD}.`,
          'policy.maximumRechargeConsidered',
          { value: policy.maximumRechargeConsidered }
        )
      );
    }
  }

  if (policy.maximumBonusCap !== null) {
    if (!isWholeNumber(policy.maximumBonusCap) || policy.maximumBonusCap < 0) {
      errors.push(
        err(
          'maximum_bonus_cap_invalid',
          'maximumBonusCap must be null or a whole number >= 0.',
          'policy.maximumBonusCap',
          { value: policy.maximumBonusCap }
        )
      );
    } else if (policy.maximumBonusCap > ARB_PLATFORM_MAX_BONUS_COINS_HARD) {
      errors.push(
        err(
          'tier_bonus_above_hard_max',
          `maximumBonusCap exceeds hard max ${ARB_PLATFORM_MAX_BONUS_COINS_HARD}.`,
          'policy.maximumBonusCap',
          { value: policy.maximumBonusCap }
        )
      );
    }
  }

  if (!isWholeNumber(policy.cooldownDurationMinutes) || policy.cooldownDurationMinutes <= 0) {
    errors.push(
      err(
        'cooldown_invalid',
        'cooldownDurationMinutes must be a positive whole number.',
        'policy.cooldownDurationMinutes',
        { value: policy.cooldownDurationMinutes }
      )
    );
  } else if (policy.cooldownDurationMinutes < ARB_PLATFORM_COOLDOWN_MIN_MINUTES) {
    errors.push(
      err(
        'cooldown_below_platform_min',
        `cooldownDurationMinutes must be >= ${ARB_PLATFORM_COOLDOWN_MIN_MINUTES}.`,
        'policy.cooldownDurationMinutes',
        {
          value: policy.cooldownDurationMinutes,
          min: ARB_PLATFORM_COOLDOWN_MIN_MINUTES,
        }
      )
    );
  } else if (policy.cooldownDurationMinutes > ARB_PLATFORM_COOLDOWN_MAX_MINUTES) {
    errors.push(
      err(
        'cooldown_above_platform_max',
        `cooldownDurationMinutes must be <= ${ARB_PLATFORM_COOLDOWN_MAX_MINUTES}.`,
        'policy.cooldownDurationMinutes',
        {
          value: policy.cooldownDurationMinutes,
          max: ARB_PLATFORM_COOLDOWN_MAX_MINUTES,
        }
      )
    );
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function validateArbTiers(
  tiersInput: ArbTier[] | unknown,
  options?: { minimumRecharge?: number }
): ArbValidationResult {
  const errors: ArbValidationError[] = [];
  const warnings: ArbValidationError[] = [];

  const parsed = Array.isArray(tiersInput)
    ? (tiersInput as ArbTier[])
    : parseArbTiers(tiersInput);

  if (!parsed) {
    return {
      ok: false,
      errors: [err('tiers_not_array', 'Tiers must be a JSON array of objects.', 'tiers')],
      warnings,
    };
  }

  const tiers = normalizeArbTiers(parsed);
  const ids = new Set<string>();
  const rangeKeys = new Set<string>();
  const openEnded: ArbTier[] = [];

  for (let index = 0; index < tiers.length; index += 1) {
    const tier = tiers[index];
    const path = `tiers[${index}]`;

    if (!tier.id) {
      errors.push(err('tier_id_missing', 'Each tier requires a non-empty id.', `${path}.id`));
    } else if (ids.has(tier.id)) {
      errors.push(
        err('tier_id_duplicate', `Duplicate tier id "${tier.id}".`, `${path}.id`, {
          id: tier.id,
        })
      );
    } else {
      ids.add(tier.id);
    }

    if (!isWholeNumber(tier.minAmount) || tier.minAmount <= 0) {
      errors.push(
        err(
          'tier_min_invalid',
          'tier.minAmount must be a positive whole number.',
          `${path}.minAmount`,
          { value: tier.minAmount }
        )
      );
    } else if (tier.minAmount > ARB_PLATFORM_MAX_RECHARGE_AMOUNT_HARD) {
      errors.push(
        err(
          'tier_amount_above_hard_max',
          `tier.minAmount exceeds hard max ${ARB_PLATFORM_MAX_RECHARGE_AMOUNT_HARD}.`,
          `${path}.minAmount`,
          { value: tier.minAmount }
        )
      );
    }

    if (tier.maxAmount !== null) {
      if (!isWholeNumber(tier.maxAmount) || tier.maxAmount <= 0) {
        errors.push(
          err(
            'tier_max_invalid',
            'tier.maxAmount must be null or a positive whole number.',
            `${path}.maxAmount`,
            { value: tier.maxAmount }
          )
        );
      } else if (
        isWholeNumber(tier.minAmount) &&
        tier.maxAmount < tier.minAmount
      ) {
        errors.push(
          err(
            'tier_max_below_min',
            'tier.maxAmount must be >= minAmount.',
            `${path}.maxAmount`,
            { minAmount: tier.minAmount, maxAmount: tier.maxAmount }
          )
        );
      } else if (tier.maxAmount > ARB_PLATFORM_MAX_RECHARGE_AMOUNT_HARD) {
        errors.push(
          err(
            'tier_amount_above_hard_max',
            `tier.maxAmount exceeds hard max ${ARB_PLATFORM_MAX_RECHARGE_AMOUNT_HARD}.`,
            `${path}.maxAmount`,
            { value: tier.maxAmount }
          )
        );
      }
    } else {
      openEnded.push(tier);
    }

    if (!isWholeNumber(tier.bonusCoins)) {
      errors.push(
        err(
          'tier_bonus_invalid',
          'tier.bonusCoins must be a whole number.',
          `${path}.bonusCoins`,
          { value: tier.bonusCoins }
        )
      );
    } else if (tier.bonusCoins < 1) {
      errors.push(
        err(
          'tier_bonus_below_one',
          'tier.bonusCoins must be >= 1.',
          `${path}.bonusCoins`,
          { value: tier.bonusCoins }
        )
      );
    } else if (tier.bonusCoins > ARB_PLATFORM_MAX_BONUS_COINS_HARD) {
      errors.push(
        err(
          'tier_bonus_above_hard_max',
          `tier.bonusCoins exceeds hard max ${ARB_PLATFORM_MAX_BONUS_COINS_HARD}.`,
          `${path}.bonusCoins`,
          { value: tier.bonusCoins }
        )
      );
    }

    const rangeKey = `${tier.minAmount}:${tier.maxAmount === null ? 'inf' : tier.maxAmount}:${tier.bonusCoins}`;
    if (rangeKeys.has(rangeKey)) {
      errors.push(
        err(
          'tier_duplicate_range',
          'Duplicate tier range/bonus combination.',
          path,
          { minAmount: tier.minAmount, maxAmount: tier.maxAmount, bonusCoins: tier.bonusCoins }
        )
      );
    } else {
      rangeKeys.add(rangeKey);
    }
  }

  if (openEnded.length > 1) {
    errors.push(
      err(
        'multiple_open_ended_tiers',
        'At most one open-ended tier (maxAmount = null) is allowed.',
        'tiers',
        { count: openEnded.length, ids: openEnded.map((t) => t.id) }
      )
    );
  } else if (openEnded.length === 1) {
    const open = openEnded[0];
    const highestMin = Math.max(...tiers.map((t) => t.minAmount));
    if (open.minAmount !== highestMin) {
      errors.push(
        err(
          'open_ended_not_highest',
          'The open-ended tier must have the highest minAmount.',
          'tiers',
          { openEndedId: open.id, openEndedMin: open.minAmount, highestMin }
        )
      );
    }
  }

  const active = activeNormalizedArbTiers(tiers);
  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      if (arbTierOverlap(active[i], active[j])) {
        errors.push(
          err(
            'tier_overlap',
            `Active tiers overlap: ${active[i].id} and ${active[j].id}.`,
            'tiers',
            { leftId: active[i].id, rightId: active[j].id }
          )
        );
      }
    }
  }

  const minimumRecharge = options?.minimumRecharge;
  if (
    typeof minimumRecharge === 'number' &&
    isWholeNumber(minimumRecharge) &&
    active.length > 0
  ) {
    const lowestMin = Math.min(...active.map((t) => t.minAmount));
    if (lowestMin !== minimumRecharge) {
      errors.push(
        err(
          'lowest_tier_min_mismatch',
          `Lowest active tier minAmount (${lowestMin}) must equal minimumRecharge (${minimumRecharge}).`,
          'tiers',
          { lowestMin, minimumRecharge }
        )
      );
    }
  }

  // Gap warning: between contiguous active finite coverage starting at minimumRecharge
  if (active.length > 0 && typeof minimumRecharge === 'number') {
    const sorted = [...active].sort((a, b) => a.minAmount - b.minAmount);
    for (let i = 0; i < sorted.length - 1; i += 1) {
      const current = sorted[i];
      const next = sorted[i + 1];
      if (current.maxAmount === null) continue;
      if (next.minAmount > current.maxAmount + 1) {
        warnings.push(
          err(
            'tier_gap',
            `Gap between ${current.maxAmount} and ${next.minAmount} — amounts in the gap grant 0.`,
            'tiers',
            {
              gapFrom: current.maxAmount + 1,
              gapTo: next.minAmount - 1,
            }
          )
        );
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

export type ValidateArbDraftOptions = {
  featureEnabled?: boolean;
  /** When true, empty tiers are always an error (publish path). */
  requireNonEmptyTiers?: boolean;
};

export function validateArbDraftConfiguration(
  draft: ArbDraftConfiguration | { policy: unknown; tiers: unknown },
  options: ValidateArbDraftOptions = {}
): ArbValidationResult {
  const errors: ArbValidationError[] = [];
  const warnings: ArbValidationError[] = [];

  let policy: ArbBusinessPolicy | null = null;
  let tiers: ArbTier[] | null = null;

  if (
    draft &&
    typeof draft === 'object' &&
    'policy' in draft &&
    'tiers' in draft &&
    Array.isArray((draft as ArbDraftConfiguration).tiers) &&
    typeof (draft as ArbDraftConfiguration).policy === 'object'
  ) {
    const asDraft = draft as ArbDraftConfiguration;
    policy = asDraft.policy;
    tiers = asDraft.tiers;
  } else {
    const raw = draft as { policy: unknown; tiers: unknown };
    if (raw.policy !== undefined && typeof raw.policy !== 'object') {
      errors.push(err('policy_not_object', 'Business policy must be a JSON object.', 'policy'));
    }
    if (raw.tiers !== undefined && !Array.isArray(raw.tiers)) {
      errors.push(err('tiers_not_array', 'Tiers must be a JSON array.', 'tiers'));
    }
    if (errors.length) {
      return { ok: false, errors, warnings };
    }
    policy = parseArbBusinessPolicy(raw.policy);
    tiers = parseArbTiers(raw.tiers);
    if (!policy) {
      errors.push(err('malformed_json', 'Unable to parse business policy JSON.', 'policy'));
    }
    if (!tiers) {
      errors.push(err('malformed_json', 'Unable to parse tiers JSON.', 'tiers'));
    }
  }

  if (!policy || !tiers) {
    return { ok: false, errors, warnings };
  }

  const policyResult = validateArbBusinessPolicy(policy);
  errors.push(...policyResult.errors);
  warnings.push(...policyResult.warnings);

  const normalizedPolicy = normalizeArbBusinessPolicy(policy);
  const tiersResult = validateArbTiers(tiers, {
    minimumRecharge: normalizedPolicy.minimumRecharge,
  });
  warnings.push(...tiersResult.warnings);
  errors.push(...tiersResult.errors);

  const active = activeNormalizedArbTiers(tiers);
  const requireNonEmpty =
    options.requireNonEmptyTiers === true || options.featureEnabled === true;

  if (requireNonEmpty && active.length === 0) {
    errors.push(
      err(
        options.featureEnabled
          ? 'empty_tiers_while_feature_enabled'
          : 'empty_tiers',
        options.featureEnabled
          ? 'Cannot publish an empty active tier table while the feature is enabled.'
          : 'At least one active tier is required.',
        'tiers'
      )
    );
  }

  return { ok: errors.length === 0, errors, warnings };
}
