/**
 * Automatic Recharge Bonus — shared domain types (Phase 2).
 * Pure types only. No I/O. No transport. No financial side effects.
 */

export type ArbVersionStatus = 'published' | 'superseded' | 'archived';

export type ArbBusinessPolicy = {
  minimumRecharge: number;
  maximumRechargeConsidered: number | null;
  maximumBonusCap: number | null;
  cooldownDurationMinutes: number;
};

export type ArbTier = {
  id: string;
  minAmount: number;
  /** Inclusive upper bound. null = open-ended. */
  maxAmount: number | null;
  bonusCoins: number;
  label: string | null;
  active: boolean;
};

export type ArbOperationalState = {
  featureEnabled: boolean;
  emergencyDisable: boolean;
  playerOptInAllowed: boolean;
};

export type ArbDraftConfiguration = {
  policy: ArbBusinessPolicy;
  tiers: ArbTier[];
};

export type ArbPublishedConfiguration = {
  versionId: string;
  versionNumber: number;
  status: ArbVersionStatus;
  coadminUid: string;
  publishedAt: string;
  publishedByUid: string | null;
  publishedByRole: string | null;
  supersedesVersionId: string | null;
  policy: ArbBusinessPolicy;
  tiers: ArbTier[];
};

export type ArbSettingsSnapshot = {
  coadminUid: string;
  operational: ArbOperationalState;
  draft: ArbDraftConfiguration;
  publishedVersionId: string | null;
  publishedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

/** Machine-readable validation error codes. */
export type ArbValidationCode =
  | 'policy_not_object'
  | 'tiers_not_array'
  | 'malformed_json'
  | 'minimum_recharge_invalid'
  | 'minimum_recharge_below_platform_floor'
  | 'maximum_recharge_invalid'
  | 'maximum_recharge_below_minimum'
  | 'maximum_bonus_cap_invalid'
  | 'cooldown_invalid'
  | 'cooldown_below_platform_min'
  | 'cooldown_above_platform_max'
  | 'tier_id_missing'
  | 'tier_id_duplicate'
  | 'tier_min_invalid'
  | 'tier_max_invalid'
  | 'tier_max_below_min'
  | 'tier_bonus_invalid'
  | 'tier_bonus_below_one'
  | 'tier_bonus_above_hard_max'
  | 'tier_overlap'
  | 'tier_duplicate_range'
  | 'multiple_open_ended_tiers'
  | 'open_ended_not_highest'
  | 'empty_tiers_while_feature_enabled'
  | 'empty_tiers'
  | 'lowest_tier_min_mismatch'
  | 'tier_amount_above_hard_max'
  | 'tier_gap';

export type ArbValidationError = {
  code: ArbValidationCode;
  message: string;
  path?: string;
  details?: Record<string, unknown>;
};

export type ArbValidationResult = {
  ok: boolean;
  errors: ArbValidationError[];
  warnings: ArbValidationError[];
};

/** Resolver skip reasons (pure config+amount only — no player state). */
export type ArbSkipReason =
  | 'invalid_amount'
  | 'below_minimum_recharge'
  | 'above_maximum_recharge_considered'
  | 'empty_tiers'
  | 'no_matching_tier'
  | 'bonus_capped_to_zero'
  | 'no_published_configuration';

export type ArbResolveInput = {
  rechargeAmount: number;
  configuration: ArbPublishedConfiguration | null;
};

export type ArbResolveOutput = {
  eligible: boolean;
  bonusCoins: number;
  skipReason: ArbSkipReason | null;
  tier: ArbTier | null;
  versionId: string | null;
  versionNumber: number | null;
  rechargeAmount: number;
  uncappedBonusCoins: number | null;
  appliedCap: number | null;
};

export type ArbAuditAction =
  | 'draft_saved'
  | 'tiers_published'
  | 'config_rolled_back'
  | 'operational_updated'
  | 'reset_to_default';

export type ArbSettingsAuditEntry = {
  id: number;
  coadminUid: string;
  actorUid: string | null;
  actorRole: string | null;
  action: string;
  changedAt: string | null;
  oldJson: Record<string, unknown> | null;
  newJson: Record<string, unknown> | null;
  versionId: string | null;
  idempotencyKey: string | null;
};
