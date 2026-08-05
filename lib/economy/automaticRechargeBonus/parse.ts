/**
 * Automatic Recharge Bonus — parsers / serializers (Phase 2).
 * Deterministic. No I/O.
 */

import {
  ARB_PLATFORM_DEFAULT_COOLDOWN_MINUTES,
  ARB_PLATFORM_DEFAULT_MINIMUM_RECHARGE,
} from '@/lib/economy/automaticRechargeBonus/constants';
import type {
  ArbBusinessPolicy,
  ArbDraftConfiguration,
  ArbOperationalState,
  ArbPublishedConfiguration,
  ArbTier,
  ArbVersionStatus,
} from '@/lib/economy/automaticRechargeBonus/types';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function readNullableNumber(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  return readNumber(value);
}

function readString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  return fallback;
}

function defaultArbBusinessPolicy(): ArbBusinessPolicy {
  return {
    minimumRecharge: ARB_PLATFORM_DEFAULT_MINIMUM_RECHARGE,
    maximumRechargeConsidered: null,
    maximumBonusCap: null,
    cooldownDurationMinutes: ARB_PLATFORM_DEFAULT_COOLDOWN_MINUTES,
  };
}

function defaultArbOperationalState(): ArbOperationalState {
  return {
    featureEnabled: false,
    emergencyDisable: false,
    playerOptInAllowed: true,
  };
}

/**
 * Parse business policy from unknown JSON.
 * Returns null if the value is not a usable object (caller should treat as malformed).
 */
function parseArbBusinessPolicy(value: unknown): ArbBusinessPolicy | null {
  if (!isPlainObject(value)) return null;

  const minimumRecharge =
    readNumber(value.minimumRecharge ?? value.minimum_recharge) ??
    ARB_PLATFORM_DEFAULT_MINIMUM_RECHARGE;
  const maxConsideredRaw = readNullableNumber(
    value.maximumRechargeConsidered ?? value.maximum_recharge_considered
  );
  const maximumRechargeConsidered =
    maxConsideredRaw === undefined ? null : maxConsideredRaw;
  const maxCapRaw = readNullableNumber(
    value.maximumBonusCap ?? value.maximum_bonus_cap
  );
  const maximumBonusCap = maxCapRaw === undefined ? null : maxCapRaw;
  const cooldownDurationMinutes =
    readNumber(value.cooldownDurationMinutes ?? value.cooldown_duration_minutes) ??
    ARB_PLATFORM_DEFAULT_COOLDOWN_MINUTES;

  return {
    minimumRecharge,
    maximumRechargeConsidered,
    maximumBonusCap,
    cooldownDurationMinutes,
  };
}

function serializeArbBusinessPolicy(policy: ArbBusinessPolicy): Record<string, unknown> {
  return {
    minimumRecharge: policy.minimumRecharge,
    maximumRechargeConsidered: policy.maximumRechargeConsidered,
    maximumBonusCap: policy.maximumBonusCap,
    cooldownDurationMinutes: policy.cooldownDurationMinutes,
  };
}

function parseArbTiers(value: unknown): ArbTier[] | null {
  if (!Array.isArray(value)) return null;
  const tiers: ArbTier[] = [];
  for (const item of value) {
    if (!isPlainObject(item)) return null;
    const id = readString(item.id);
    const minAmount = readNumber(item.minAmount ?? item.min_amount);
    const maxRaw = item.maxAmount ?? item.max_amount;
    const maxAmount =
      maxRaw === null || maxRaw === undefined ? null : readNumber(maxRaw);
    const bonusCoins = readNumber(item.bonusCoins ?? item.bonus_coins);
    const labelRaw = item.label;
    const label =
      labelRaw === null || labelRaw === undefined
        ? null
        : readString(labelRaw);
    const active = readBoolean(item.active, true);

    if (!id || minAmount === null || bonusCoins === null) return null;
    if (maxRaw !== null && maxRaw !== undefined && maxAmount === null) return null;

    tiers.push({
      id: id.trim(),
      minAmount,
      maxAmount,
      bonusCoins,
      label: label === null ? null : label.trim() || null,
      active,
    });
  }
  return tiers;
}

function serializeArbTiers(tiers: ArbTier[]): Record<string, unknown>[] {
  return tiers.map((tier) => ({
    id: tier.id,
    minAmount: tier.minAmount,
    maxAmount: tier.maxAmount,
    bonusCoins: tier.bonusCoins,
    label: tier.label,
    active: tier.active,
  }));
}

function parseArbDraftConfiguration(input: {
  policy: unknown;
  tiers: unknown;
}): ArbDraftConfiguration | null {
  const policy = parseArbBusinessPolicy(input.policy);
  const tiers = parseArbTiers(input.tiers);
  if (!policy || !tiers) return null;
  return { policy, tiers };
}

function serializeArbDraftConfiguration(
  draft: ArbDraftConfiguration
): { policy: Record<string, unknown>; tiers: Record<string, unknown>[] } {
  return {
    policy: serializeArbBusinessPolicy(draft.policy),
    tiers: serializeArbTiers(draft.tiers),
  };
}

function parseArbVersionStatus(value: unknown): ArbVersionStatus | null {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'published' || text === 'superseded' || text === 'archived') {
    return text;
  }
  return null;
}

function parseArbPublishedConfiguration(input: {
  versionId: unknown;
  versionNumber: unknown;
  status: unknown;
  coadminUid: unknown;
  publishedAt: unknown;
  publishedByUid?: unknown;
  publishedByRole?: unknown;
  supersedesVersionId?: unknown;
  policy: unknown;
  tiers: unknown;
}): ArbPublishedConfiguration | null {
  const versionId = readString(input.versionId)?.trim() || '';
  const versionNumber = readNumber(input.versionNumber);
  const status = parseArbVersionStatus(input.status);
  const coadminUid = readString(input.coadminUid)?.trim() || '';
  const publishedAt = readString(input.publishedAt)?.trim() || '';
  const policy = parseArbBusinessPolicy(input.policy);
  const tiers = parseArbTiers(input.tiers);
  if (
    !versionId ||
    versionNumber === null ||
    !Number.isInteger(versionNumber) ||
    versionNumber < 1 ||
    !status ||
    !coadminUid ||
    !publishedAt ||
    !policy ||
    !tiers
  ) {
    return null;
  }
  return {
    versionId,
    versionNumber: Math.trunc(versionNumber),
    status,
    coadminUid,
    publishedAt,
    publishedByUid: readString(input.publishedByUid)?.trim() || null,
    publishedByRole: readString(input.publishedByRole)?.trim() || null,
    supersedesVersionId: readString(input.supersedesVersionId)?.trim() || null,
    policy,
    tiers,
  };
}

export {
  defaultArbBusinessPolicy,
  defaultArbOperationalState,
  parseArbBusinessPolicy,
  serializeArbBusinessPolicy,
  parseArbTiers,
  serializeArbTiers,
  parseArbDraftConfiguration,
  serializeArbDraftConfiguration,
  parseArbVersionStatus,
  parseArbPublishedConfiguration,
};
