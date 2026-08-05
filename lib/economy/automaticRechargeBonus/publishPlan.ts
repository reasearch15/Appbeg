/**
 * Automatic Recharge Bonus — pure publish / rollback planning (Phase 2).
 * No DB writes. Callers apply the plan inside an atomic SQL transaction.
 */

import { randomUUID } from 'crypto';

import {
  normalizeArbBusinessPolicy,
  normalizeArbTiers,
  nextArbVersionNumber,
} from '@/lib/economy/automaticRechargeBonus/normalize';
import {
  serializeArbBusinessPolicy,
  serializeArbDraftConfiguration,
  serializeArbTiers,
} from '@/lib/economy/automaticRechargeBonus/parse';
import { validateArbDraftConfiguration } from '@/lib/economy/automaticRechargeBonus/validate';
import type {
  ArbDraftConfiguration,
  ArbPublishedConfiguration,
  ArbValidationResult,
  ArbVersionStatus,
} from '@/lib/economy/automaticRechargeBonus/types';

export type ArbPublishPlanInput = {
  coadminUid: string;
  draft: ArbDraftConfiguration;
  featureEnabled: boolean;
  currentPublished: ArbPublishedConfiguration | null;
  latestVersionNumber: number | null;
  actorUid?: string | null;
  actorRole?: string | null;
  /** Fixed clock for deterministic tests. */
  publishedAt?: string;
  /** Fixed UUID for deterministic tests. */
  versionId?: string;
  acceptGapWarnings?: boolean;
};

export type ArbPublishPlan = {
  versionId: string;
  versionNumber: number;
  publishedAt: string;
  policyJson: Record<string, unknown>;
  tiersJson: Record<string, unknown>[];
  supersedesVersionId: string | null;
  previousVersionIdToSupersede: string | null;
  status: 'published';
  normalizedDraft: ArbDraftConfiguration;
  validation: ArbValidationResult;
  audit: {
    action: 'tiers_published';
    oldJson: Record<string, unknown> | null;
    newJson: Record<string, unknown>;
  };
};

export type ArbPublishPlanResult =
  | { ok: true; plan: ArbPublishPlan }
  | { ok: false; validation: ArbValidationResult };

export function planArbPublish(input: ArbPublishPlanInput): ArbPublishPlanResult {
  const validation = validateArbDraftConfiguration(input.draft, {
    featureEnabled: input.featureEnabled,
    requireNonEmptyTiers: true,
  });

  const hasGapWarnings = validation.warnings.some((w) => w.code === 'tier_gap');
  if (!validation.ok) {
    return { ok: false, validation };
  }
  if (hasGapWarnings && !input.acceptGapWarnings) {
    return {
      ok: false,
      validation: {
        ok: false,
        errors: [
          ...validation.errors,
          {
            code: 'tier_gap',
            message:
              'Configuration has tier gaps. Pass acceptGapWarnings to publish anyway.',
            path: 'tiers',
          },
        ],
        warnings: validation.warnings,
      },
    };
  }

  const normalizedDraft: ArbDraftConfiguration = {
    policy: normalizeArbBusinessPolicy(input.draft.policy),
    tiers: normalizeArbTiers(input.draft.tiers),
  };

  const versionId = (input.versionId || randomUUID()).trim();
  const versionNumber = nextArbVersionNumber(input.latestVersionNumber);
  const publishedAt = input.publishedAt || new Date().toISOString();
  const supersedesVersionId = input.currentPublished?.versionId ?? null;

  const newJson = {
    ...serializeArbDraftConfiguration(normalizedDraft),
    versionId,
    versionNumber,
    supersedesVersionId,
    publishedAt,
    publishedByUid: input.actorUid ?? null,
    publishedByRole: input.actorRole ?? null,
  };

  const oldJson = input.currentPublished
    ? {
        versionId: input.currentPublished.versionId,
        versionNumber: input.currentPublished.versionNumber,
        status: input.currentPublished.status,
        policy: serializeArbBusinessPolicy(input.currentPublished.policy),
        tiers: serializeArbTiers(input.currentPublished.tiers),
      }
    : null;

  return {
    ok: true,
    plan: {
      versionId,
      versionNumber,
      publishedAt,
      policyJson: serializeArbBusinessPolicy(normalizedDraft.policy),
      tiersJson: serializeArbTiers(normalizedDraft.tiers),
      supersedesVersionId,
      previousVersionIdToSupersede: supersedesVersionId,
      status: 'published',
      normalizedDraft,
      validation,
      audit: {
        action: 'tiers_published',
        oldJson,
        newJson,
      },
    },
  };
}

export type ArbRollbackPlanInput = {
  target: ArbPublishedConfiguration;
  currentPublished: ArbPublishedConfiguration | null;
  actorUid?: string | null;
  actorRole?: string | null;
  rolledBackAt?: string;
};

export type ArbRollbackPlan = {
  targetVersionId: string;
  targetVersionNumber: number;
  previousCurrentVersionId: string | null;
  /** Status updates: target → published; previous current → superseded (if different). */
  statusUpdates: Array<{ versionId: string; status: ArbVersionStatus }>;
  /** Optional: load target snapshot into draft for continued editing. */
  draftFromTarget: ArbDraftConfiguration;
  rolledBackAt: string;
  audit: {
    action: 'config_rolled_back';
    oldJson: Record<string, unknown> | null;
    newJson: Record<string, unknown>;
  };
};

/**
 * Rollback never mutates historical policy/tiers JSON.
 * It re-points "current" to an existing immutable version and updates statuses.
 */
export function planArbRollback(input: ArbRollbackPlanInput): ArbRollbackPlan {
  const rolledBackAt = input.rolledBackAt || new Date().toISOString();
  const previousCurrentVersionId = input.currentPublished?.versionId ?? null;
  const statusUpdates: Array<{ versionId: string; status: ArbVersionStatus }> = [
    { versionId: input.target.versionId, status: 'published' },
  ];

  if (
    previousCurrentVersionId &&
    previousCurrentVersionId !== input.target.versionId
  ) {
    statusUpdates.push({
      versionId: previousCurrentVersionId,
      status: 'superseded',
    });
  }

  return {
    targetVersionId: input.target.versionId,
    targetVersionNumber: input.target.versionNumber,
    previousCurrentVersionId,
    statusUpdates,
    draftFromTarget: {
      policy: normalizeArbBusinessPolicy(input.target.policy),
      tiers: normalizeArbTiers(input.target.tiers),
    },
    rolledBackAt,
    audit: {
      action: 'config_rolled_back',
      oldJson: input.currentPublished
        ? {
            versionId: input.currentPublished.versionId,
            versionNumber: input.currentPublished.versionNumber,
          }
        : null,
      newJson: {
        versionId: input.target.versionId,
        versionNumber: input.target.versionNumber,
        rolledBackAt,
        publishedByUid: input.actorUid ?? null,
        publishedByRole: input.actorRole ?? null,
      },
    },
  };
}
