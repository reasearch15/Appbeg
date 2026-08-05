import 'server-only';

import {
  assertArbFoundationTables,
  loadArbPublishedConfigurationInSql,
  loadArbSettingsInSql,
} from '@/lib/sql/authorityAutomaticBonusConfig';
import {
  getAutomaticRechargeBonusFlagStatus,
} from '@/lib/server/automaticRechargeBonusFlags';
import { cleanText, getPlayerMirrorPool, toIsoString } from '@/lib/sql/playerMirrorCommon';

/**
 * Phase 9 — read-only System Health snapshot.
 * Does not mutate data or alter grant/reporting business logic.
 */

export type ArbSystemHealthSnapshot = {
  generatedAt: string;
  coadminUid: string;
  flags: ReturnType<typeof getAutomaticRechargeBonusFlagStatus>;
  featureStatus: {
    adminEnabled: boolean;
    reportingEnabled: boolean;
    grantsEnabled: boolean;
    shadowModeEnabled: boolean;
    playerModeEnabled: boolean;
    globalKillActive: boolean;
    unsafePlayerModeWithoutGrants: boolean;
  };
  operational: {
    featureEnabled: boolean;
    emergencyDisable: boolean;
    playerOptInAllowed: boolean;
    publishedVersionId: string | null;
  } | null;
  published: {
    versionId: string;
    versionNumber: number;
    status: string;
    publishedAt: string | null;
    tierCount: number;
    activeTier: number;
  } | null;
  lastPublishAt: string | null;
  lastGrantAt: string | null;
  lastShadowEvaluationAt: string | null;
  windowHours: number;
  window: {
    grants: number;
    shadowEvaluations: number;
    skipped: number;
    blocked: number;
    wouldGrant: number;
    evaluationErrorsHint: number;
    duplicateGrantSignals: number;
    feWithoutGrantedEval: number;
    grantedEvalWithoutFe: number;
  };
  grantPipelineFreeze: {
    soleWriterModule: string;
    soleWriterExport: string;
    financialEventType: string;
    verificationCommand: string;
    note: string;
  };
  configurationHealth: {
    hasPublishedConfiguration: boolean;
    featureEnabledWithoutPublish: boolean;
    emergencyDisableActive: boolean;
    ok: boolean;
    notes: string[];
  };
  reconciliationHint: {
    command: string;
    uiPath: string;
  };
};

export async function loadArbSystemHealthInSql(input: {
  coadminUid: string;
  windowHours?: number;
}): Promise<ArbSystemHealthSnapshot> {
  const coadminUid = cleanText(input.coadminUid);
  if (!coadminUid) throw new Error('coadminUid is required.');
  const windowHours = Math.min(
    168,
    Math.max(1, Math.trunc(Number(input.windowHours) || 24))
  );
  const db = getPlayerMirrorPool();
  if (!db) throw new Error('SQL authority unavailable.');

  const flags = getAutomaticRechargeBonusFlagStatus();
  const settings = await loadArbSettingsInSql({ coadminUid });
  const published = await loadArbPublishedConfigurationInSql({ coadminUid });

  const client = await db.connect();
  try {
    await assertArbFoundationTables(client);

    const lastPublish = await client.query(
      `
        SELECT changed_at
        FROM public.coadmin_automatic_recharge_bonus_settings_audit
        WHERE coadmin_uid = $1 AND action = 'tiers_published'
        ORDER BY changed_at DESC
        LIMIT 1
      `,
      [coadminUid]
    );

    const lastGrant = await client.query(
      `
        SELECT evaluated_at
        FROM public.automatic_recharge_bonus_evaluations
        WHERE coadmin_uid = $1
          AND mode = 'grant'
          AND evaluation_result = 'granted'
        ORDER BY evaluated_at DESC
        LIMIT 1
      `,
      [coadminUid]
    );

    const lastShadow = await client.query(
      `
        SELECT evaluated_at
        FROM public.automatic_recharge_bonus_evaluations
        WHERE coadmin_uid = $1 AND mode = 'shadow'
        ORDER BY evaluated_at DESC
        LIMIT 1
      `,
      [coadminUid]
    );

    const windowAgg = await client.query(
      `
        SELECT
          COUNT(*) FILTER (
            WHERE mode = 'grant' AND evaluation_result = 'granted'
          )::int AS grants,
          COUNT(*) FILTER (WHERE mode = 'shadow')::int AS shadow_evals,
          COUNT(*) FILTER (WHERE evaluation_result = 'skipped')::int AS skipped,
          COUNT(*) FILTER (WHERE evaluation_result = 'blocked')::int AS blocked,
          COUNT(*) FILTER (WHERE evaluation_result = 'would_grant')::int AS would_grant,
          COUNT(*) FILTER (
            WHERE skip_reason ILIKE '%evaluation_error%'
               OR COALESCE(raw_json->>'skipReason','') ILIKE '%evaluation_error%'
          )::int AS eval_errors
        FROM public.automatic_recharge_bonus_evaluations
        WHERE coadmin_uid = $1
          AND evaluated_at >= now() - make_interval(hours => $2::int)
      `,
      [coadminUid, windowHours]
    );

    // Duplicate signal: more than one grant-mode evaluation for same request (should be 0).
    const dupEvals = await client.query(
      `
        SELECT COUNT(*)::int AS n
        FROM (
          SELECT request_id
          FROM public.automatic_recharge_bonus_evaluations
          WHERE coadmin_uid = $1
            AND mode = 'grant'
            AND request_id IS NOT NULL
            AND evaluated_at >= now() - make_interval(hours => $2::int)
          GROUP BY request_id
          HAVING COUNT(*) > 1
        ) d
      `,
      [coadminUid, windowHours]
    );

    const feWithoutEval = await client.query(
      `
        SELECT COUNT(*)::int AS n
        FROM public.financial_events_cache fe
        WHERE fe.coadmin_uid = $1
          AND fe.type = 'automatic_recharge_bonus'
          AND fe.deleted_at IS NULL
          AND fe.created_at >= now() - make_interval(hours => $2::int)
          AND NOT EXISTS (
            SELECT 1
            FROM public.automatic_recharge_bonus_evaluations e
            WHERE e.request_id = fe.request_id
              AND e.mode = 'grant'
              AND e.evaluation_result = 'granted'
          )
      `,
      [coadminUid, windowHours]
    );

    const grantedWithoutFe = await client.query(
      `
        SELECT COUNT(*)::int AS n
        FROM public.automatic_recharge_bonus_evaluations e
        WHERE e.coadmin_uid = $1
          AND e.mode = 'grant'
          AND e.evaluation_result = 'granted'
          AND e.evaluated_at >= now() - make_interval(hours => $2::int)
          AND NOT EXISTS (
            SELECT 1
            FROM public.financial_events_cache fe
            WHERE fe.request_id = e.request_id
              AND fe.type = 'automatic_recharge_bonus'
              AND fe.deleted_at IS NULL
          )
      `,
      [coadminUid, windowHours]
    );

    const notes: string[] = [];
    const featureEnabled = settings?.operational.featureEnabled === true;
    const emergencyDisable = settings?.operational.emergencyDisable === true;
    const hasPublished = Boolean(published?.versionId);
    if (featureEnabled && !hasPublished) {
      notes.push('Feature enabled without published configuration.');
    }
    if (emergencyDisable) {
      notes.push('Emergency disable is active for this coadmin.');
    }
    if (flags.unsafe_player_mode_without_grants) {
      notes.push('Unsafe: player mode enabled without grants.');
    }
    if (flags.global_kill_active) {
      notes.push('Global kill is active.');
    }
    if (Number(dupEvals.rows[0]?.n || 0) > 0) {
      notes.push('Duplicate grant-mode evaluations detected in window.');
    }
    if (Number(feWithoutEval.rows[0]?.n || 0) > 0) {
      notes.push('Financial events without granted evaluation in window.');
    }
    if (Number(grantedWithoutFe.rows[0]?.n || 0) > 0) {
      notes.push('Granted evaluations without financial event in window.');
    }

    const structuralBad =
      (featureEnabled && !hasPublished) ||
      flags.unsafe_player_mode_without_grants ||
      Number(dupEvals.rows[0]?.n || 0) > 0 ||
      Number(feWithoutEval.rows[0]?.n || 0) > 0 ||
      Number(grantedWithoutFe.rows[0]?.n || 0) > 0;

    return {
      generatedAt: new Date().toISOString(),
      coadminUid,
      flags,
      featureStatus: {
        adminEnabled: flags.admin_enabled,
        reportingEnabled: flags.reporting_enabled,
        grantsEnabled: flags.grants_enabled,
        shadowModeEnabled: flags.shadow_mode_enabled,
        playerModeEnabled: flags.player_mode_enabled,
        globalKillActive: flags.global_kill_active,
        unsafePlayerModeWithoutGrants: flags.unsafe_player_mode_without_grants,
      },
      operational: settings
        ? {
            featureEnabled,
            emergencyDisable,
            playerOptInAllowed: settings.operational.playerOptInAllowed !== false,
            publishedVersionId: settings.publishedVersionId,
          }
        : null,
      published: published
        ? {
            versionId: published.versionId,
            versionNumber: published.versionNumber,
            status: published.status,
            publishedAt: published.publishedAt,
            tierCount: published.tiers.length,
            activeTier: published.tiers.filter((t) => t.active).length,
          }
        : null,
      lastPublishAt: toIsoString(lastPublish.rows[0]?.changed_at) || null,
      lastGrantAt: toIsoString(lastGrant.rows[0]?.evaluated_at) || null,
      lastShadowEvaluationAt: toIsoString(lastShadow.rows[0]?.evaluated_at) || null,
      windowHours,
      window: {
        grants: Number(windowAgg.rows[0]?.grants || 0),
        shadowEvaluations: Number(windowAgg.rows[0]?.shadow_evals || 0),
        skipped: Number(windowAgg.rows[0]?.skipped || 0),
        blocked: Number(windowAgg.rows[0]?.blocked || 0),
        wouldGrant: Number(windowAgg.rows[0]?.would_grant || 0),
        evaluationErrorsHint: Number(windowAgg.rows[0]?.eval_errors || 0),
        duplicateGrantSignals: Number(dupEvals.rows[0]?.n || 0),
        feWithoutGrantedEval: Number(feWithoutEval.rows[0]?.n || 0),
        grantedEvalWithoutFe: Number(grantedWithoutFe.rows[0]?.n || 0),
      },
      grantPipelineFreeze: {
        soleWriterModule: 'lib/sql/authorityAutomaticBonusGrant.ts',
        soleWriterExport: 'applyArbOnRechargeCompleteInTxn',
        financialEventType: 'automatic_recharge_bonus',
        verificationCommand: 'npm run test:arb-grant-freeze',
        note: 'Financial writes must only flow through the frozen grant pipeline.',
      },
      configurationHealth: {
        hasPublishedConfiguration: hasPublished,
        featureEnabledWithoutPublish: featureEnabled && !hasPublished,
        emergencyDisableActive: emergencyDisable,
        ok: !structuralBad,
        notes,
      },
      reconciliationHint: {
        command: 'DATABASE_URL=... npm run reconcile:arb-request -- <requestId>',
        uiPath: 'Coadmin → Automatic Recharge Bonus → Reporting → Reconcile',
      },
    };
  } finally {
    client.release();
  }
}
