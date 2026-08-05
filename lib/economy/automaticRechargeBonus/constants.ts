/**
 * Automatic Recharge Bonus — platform constants (Phase 2).
 */

export const ARB_PLATFORM_MINIMUM_RECHARGE_FLOOR = 10;
export const ARB_PLATFORM_DEFAULT_MINIMUM_RECHARGE = 10;
export const ARB_PLATFORM_DEFAULT_COOLDOWN_MINUTES = 120;
export const ARB_PLATFORM_COOLDOWN_MIN_MINUTES = 30;
export const ARB_PLATFORM_COOLDOWN_MAX_MINUTES = 720;
/** Hard safety ceiling for a single grant (coins). */
export const ARB_PLATFORM_MAX_BONUS_COINS_HARD = 10_000;
/** Hard safety ceiling for recharge amounts considered in tiers. */
export const ARB_PLATFORM_MAX_RECHARGE_AMOUNT_HARD = 1_000_000;
/** Default linear seed ends open-ended at this minAmount. */
export const ARB_DEFAULT_OPEN_ENDED_TIER_MIN = 200;

export const ARB_VERSION_STATUSES = ['published', 'superseded', 'archived'] as const;

export const ARB_SKIP_REASONS = [
  'invalid_amount',
  'below_minimum_recharge',
  'above_maximum_recharge_considered',
  'empty_tiers',
  'no_matching_tier',
  'bonus_capped_to_zero',
  'no_published_configuration',
] as const;
