import 'server-only';

import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';

import {
  planArbPublish,
  planArbRollback,
} from '@/lib/economy/automaticRechargeBonus/publishPlan';
import {
  buildDefaultArbDraftConfiguration,
  defaultArbOperationalState,
  normalizeArbBusinessPolicy,
  normalizeArbTiers,
  parseArbBusinessPolicy,
  parseArbDraftConfiguration,
  parseArbPublishedConfiguration,
  parseArbTiers,
  serializeArbDraftConfiguration,
  type ArbDraftConfiguration,
  type ArbOperationalState,
  type ArbPublishedConfiguration,
  type ArbSettingsAuditEntry,
  type ArbSettingsSnapshot,
  type ArbValidationResult,
} from '@/lib/economy/automaticRechargeBonus';
import {
  claimAuthorityOperation,
  logAuthPayloadPreTxnRemoved,
  readAuthorityOperationPayloadWithClient,
} from '@/lib/sql/authorityLedger';
import { ARB_SQL_TABLES } from '@/lib/server/automaticRechargeBonusFlags';
import { cleanText, getPlayerMirrorPool, toIsoString } from '@/lib/sql/playerMirrorCommon';

function readJsonField(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value;
}

export async function assertArbFoundationTables(client: PoolClient) {
  const result = await client.query<{ table_name: string }>(
    `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])
    `,
    [ARB_SQL_TABLES]
  );
  const present = new Set(result.rows.map((row) => row.table_name));
  const missing = ARB_SQL_TABLES.filter((name) => !present.has(name));
  if (missing.length) {
    throw new Error(
      `ARB foundation tables missing (${missing.join(', ')}). Apply migrations/068_automatic_recharge_bonus_foundation.sql`
    );
  }
}

function mapSettingsRow(row: Record<string, unknown>): ArbSettingsSnapshot {
  const policyRaw = readJsonField(row.draft_policy);
  const tiersRaw = readJsonField(row.draft_tiers);
  const policy = parseArbBusinessPolicy(policyRaw) || normalizeArbBusinessPolicy(
    buildDefaultArbDraftConfiguration({ createId: () => 'legacy-repair' }).policy
  );
  const tiers = parseArbTiers(tiersRaw) || [];

  return {
    coadminUid: cleanText(row.coadmin_uid),
    operational: {
      featureEnabled: row.feature_enabled === true,
      emergencyDisable: row.emergency_disable === true,
      playerOptInAllowed: row.player_opt_in_allowed !== false,
    },
    draft: {
      policy,
      tiers: normalizeArbTiers(tiers),
    },
    publishedVersionId: cleanText(row.published_version_id) || null,
    publishedAt: toIsoString(row.published_at),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function mapVersionRow(row: Record<string, unknown>): ArbPublishedConfiguration | null {
  return parseArbPublishedConfiguration({
    versionId: row.version_id,
    versionNumber: row.version_number,
    status: row.status,
    coadminUid: row.coadmin_uid,
    publishedAt: toIsoString(row.published_at) || row.published_at,
    publishedByUid: row.published_by_uid,
    publishedByRole: row.published_by_role,
    supersedesVersionId: row.supersedes_version_id,
    policy: readJsonField(row.policy_json),
    tiers: readJsonField(row.tiers_json),
  });
}

async function insertAuditInTxn(
  client: PoolClient,
  input: {
    coadminUid: string;
    actorUid?: string | null;
    actorRole?: string | null;
    action: string;
    oldJson: Record<string, unknown> | null;
    newJson: Record<string, unknown> | null;
    versionId?: string | null;
    idempotencyKey?: string | null;
  }
) {
  await client.query(
    `
      INSERT INTO public.coadmin_automatic_recharge_bonus_settings_audit (
        coadmin_uid,
        actor_uid,
        actor_role,
        action,
        old_json,
        new_json,
        version_id,
        idempotency_key,
        source,
        raw_json
      )
      VALUES (
        $1, NULLIF($2, ''), NULLIF($3, ''), $4,
        $5::jsonb, $6::jsonb, NULLIF($7, ''), NULLIF($8, ''),
        'appbeg', '{}'::jsonb
      )
      ON CONFLICT (coadmin_uid, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
    `,
    [
      input.coadminUid,
      cleanText(input.actorUid),
      cleanText(input.actorRole),
      input.action,
      JSON.stringify(input.oldJson ?? null),
      JSON.stringify(input.newJson ?? null),
      cleanText(input.versionId),
      cleanText(input.idempotencyKey),
    ]
  );
}

/**
 * Ensure a settings row exists for the coadmin (default draft, feature off).
 */
export async function ensureArbSettingsInSql(input: {
  coadminUid: string;
}): Promise<ArbSettingsSnapshot> {
  const coadminUid = cleanText(input.coadminUid);
  if (!coadminUid) throw new Error('coadminUid is required.');

  const db = getPlayerMirrorPool();
  if (!db) throw new Error('SQL authority unavailable.');

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await assertArbFoundationTables(client);

    const existing = await client.query(
      `
        SELECT *
        FROM public.coadmin_automatic_recharge_bonus_settings
        WHERE coadmin_uid = $1 AND deleted_at IS NULL
        FOR UPDATE
      `,
      [coadminUid]
    );

    if (existing.rows.length) {
      await client.query('COMMIT');
      return mapSettingsRow(existing.rows[0] as Record<string, unknown>);
    }

    const draft = buildDefaultArbDraftConfiguration();
    const serialized = serializeArbDraftConfiguration(draft);
    const operational = defaultArbOperationalState();
    const nowIso = new Date().toISOString();

    await client.query(
      `
        INSERT INTO public.coadmin_automatic_recharge_bonus_settings (
          coadmin_uid,
          feature_enabled,
          emergency_disable,
          player_opt_in_allowed,
          draft_policy,
          draft_tiers,
          created_at,
          updated_at,
          source,
          raw_json
        )
        VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::timestamptz, $7::timestamptz, 'appbeg', '{}'::jsonb)
        ON CONFLICT (coadmin_uid) DO NOTHING
      `,
      [
        coadminUid,
        operational.featureEnabled,
        operational.emergencyDisable,
        operational.playerOptInAllowed,
        JSON.stringify(serialized.policy),
        JSON.stringify(serialized.tiers),
        nowIso,
      ]
    );

    const created = await client.query(
      `
        SELECT *
        FROM public.coadmin_automatic_recharge_bonus_settings
        WHERE coadmin_uid = $1 AND deleted_at IS NULL
      `,
      [coadminUid]
    );
    await client.query('COMMIT');
    if (!created.rows.length) {
      throw new Error('Failed to ensure ARB settings row.');
    }
    return mapSettingsRow(created.rows[0] as Record<string, unknown>);
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function loadArbSettingsInSql(input: {
  coadminUid: string;
}): Promise<ArbSettingsSnapshot | null> {
  const coadminUid = cleanText(input.coadminUid);
  if (!coadminUid) return null;
  const db = getPlayerMirrorPool();
  if (!db) throw new Error('SQL authority unavailable.');

  const result = await db.query(
    `
      SELECT *
      FROM public.coadmin_automatic_recharge_bonus_settings
      WHERE coadmin_uid = $1 AND deleted_at IS NULL
    `,
    [coadminUid]
  );
  if (!result.rows.length) return null;
  return mapSettingsRow(result.rows[0] as Record<string, unknown>);
}

export async function loadArbSettingsWithClient(
  client: PoolClient,
  coadminUidInput: string
): Promise<ArbSettingsSnapshot | null> {
  const coadminUid = cleanText(coadminUidInput);
  if (!coadminUid) return null;
  const result = await client.query(
    `
      SELECT *
      FROM public.coadmin_automatic_recharge_bonus_settings
      WHERE coadmin_uid = $1 AND deleted_at IS NULL
    `,
    [coadminUid]
  );
  if (!result.rows.length) return null;
  return mapSettingsRow(result.rows[0] as Record<string, unknown>);
}

export async function loadArbPublishedConfigurationInSql(input: {
  coadminUid: string;
  versionId?: string | null;
}): Promise<ArbPublishedConfiguration | null> {
  const coadminUid = cleanText(input.coadminUid);
  if (!coadminUid) return null;
  const db = getPlayerMirrorPool();
  if (!db) throw new Error('SQL authority unavailable.');

  if (input.versionId) {
    const byId = await db.query(
      `
        SELECT *
        FROM public.coadmin_automatic_recharge_bonus_config_versions
        WHERE version_id = $1 AND coadmin_uid = $2
      `,
      [cleanText(input.versionId), coadminUid]
    );
    if (!byId.rows.length) return null;
    return mapVersionRow(byId.rows[0] as Record<string, unknown>);
  }

  const settings = await loadArbSettingsInSql({ coadminUid });
  if (!settings?.publishedVersionId) return null;
  return loadArbPublishedConfigurationInSql({
    coadminUid,
    versionId: settings.publishedVersionId,
  });
}

export async function loadArbPublishedConfigurationWithClient(
  client: PoolClient,
  input: { coadminUid: string; versionId?: string | null }
): Promise<ArbPublishedConfiguration | null> {
  const coadminUid = cleanText(input.coadminUid);
  if (!coadminUid) return null;

  if (input.versionId) {
    const byId = await client.query(
      `
        SELECT *
        FROM public.coadmin_automatic_recharge_bonus_config_versions
        WHERE version_id = $1 AND coadmin_uid = $2
      `,
      [cleanText(input.versionId), coadminUid]
    );
    if (!byId.rows.length) return null;
    return mapVersionRow(byId.rows[0] as Record<string, unknown>);
  }

  const settings = await loadArbSettingsWithClient(client, coadminUid);
  if (!settings?.publishedVersionId) return null;
  return loadArbPublishedConfigurationWithClient(client, {
    coadminUid,
    versionId: settings.publishedVersionId,
  });
}

export async function listArbConfigVersionsInSql(input: {
  coadminUid: string;
  limit?: number;
}): Promise<ArbPublishedConfiguration[]> {
  const coadminUid = cleanText(input.coadminUid);
  if (!coadminUid) return [];
  const limit = Math.min(200, Math.max(1, Math.trunc(Number(input.limit) || 50)));
  const db = getPlayerMirrorPool();
  if (!db) throw new Error('SQL authority unavailable.');

  const result = await db.query(
    `
      SELECT *
      FROM public.coadmin_automatic_recharge_bonus_config_versions
      WHERE coadmin_uid = $1
      ORDER BY version_number DESC
      LIMIT $2
    `,
    [coadminUid, limit]
  );

  return result.rows
    .map((row) => mapVersionRow(row as Record<string, unknown>))
    .filter((row): row is ArbPublishedConfiguration => Boolean(row));
}

export type SaveArbDraftResult = {
  success: true;
  duplicate?: boolean;
  settings: ArbSettingsSnapshot;
  validation: ArbValidationResult;
};

export async function saveArbDraftInSql(input: {
  coadminUid: string;
  draft: ArbDraftConfiguration;
  actorUid?: string | null;
  actorRole?: string | null;
  idempotencyKey?: string | null;
  /** When false, invalid drafts are still rejected. */
  requireValid?: boolean;
  /** Audit action label. Defaults to draft_saved. */
  auditAction?: 'draft_saved' | 'reset_to_default';
}): Promise<SaveArbDraftResult> {
  const coadminUid = cleanText(input.coadminUid);
  if (!coadminUid) throw new Error('coadminUid is required.');

  const draft = parseArbDraftConfiguration(input.draft) || input.draft;
  const normalized: ArbDraftConfiguration = {
    policy: normalizeArbBusinessPolicy(draft.policy),
    tiers: normalizeArbTiers(draft.tiers),
  };

  // Soft validation for draft saves — structural parse already required.
  const { validateArbDraftConfiguration } = await import(
    '@/lib/economy/automaticRechargeBonus/validate'
  );
  const validation = validateArbDraftConfiguration(normalized, {
    requireNonEmptyTiers: false,
  });
  if (input.requireValid !== false && !validation.ok) {
    const error = new Error('ARB draft failed validation.');
    (error as Error & { validation?: ArbValidationResult }).validation = validation;
    throw error;
  }

  const idempotencyKey =
    cleanText(input.idempotencyKey) || `draft:${randomUUID()}`;
  const operationKey = `arb_config:${coadminUid}:save_draft:${idempotencyKey}`;

  logAuthPayloadPreTxnRemoved('arb_save_draft');
  const db = getPlayerMirrorPool();
  if (!db) throw new Error('SQL authority unavailable.');

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await assertArbFoundationTables(client);

    const claim = await claimAuthorityOperation(client, {
      operationKey,
      operationType: 'arb_config',
      userUid: coadminUid,
      sourceId: coadminUid,
      actorUid: cleanText(input.actorUid) || coadminUid,
      actorRole: cleanText(input.actorRole) || 'coadmin',
      payload: {},
    });

    if (!claim.claimed) {
      const payload = await readAuthorityOperationPayloadWithClient(client, operationKey, {
        flowName: 'arb_save_draft',
      });
      await client.query('ROLLBACK');
      if (payload?.settings) {
        return {
          success: true,
          duplicate: true,
          settings: payload.settings as ArbSettingsSnapshot,
          validation,
        };
      }
      throw new Error('Duplicate ARB draft save in progress.');
    }

    await ensureSettingsRowLocked(client, coadminUid);
    const before = await client.query(
      `
        SELECT *
        FROM public.coadmin_automatic_recharge_bonus_settings
        WHERE coadmin_uid = $1 AND deleted_at IS NULL
        FOR UPDATE
      `,
      [coadminUid]
    );
    const beforeSnap = mapSettingsRow(before.rows[0] as Record<string, unknown>);
    const serialized = serializeArbDraftConfiguration(normalized);
    const nowIso = new Date().toISOString();

    await client.query(
      `
        UPDATE public.coadmin_automatic_recharge_bonus_settings
        SET draft_policy = $2::jsonb,
            draft_tiers = $3::jsonb,
            updated_at = $4::timestamptz
        WHERE coadmin_uid = $1 AND deleted_at IS NULL
      `,
      [coadminUid, JSON.stringify(serialized.policy), JSON.stringify(serialized.tiers), nowIso]
    );

    await insertAuditInTxn(client, {
      coadminUid,
      actorUid: input.actorUid,
      actorRole: input.actorRole,
      action: input.auditAction || 'draft_saved',
      oldJson: serializeArbDraftConfiguration(beforeSnap.draft),
      newJson: serialized,
      idempotencyKey,
    });

    const after = await client.query(
      `
        SELECT *
        FROM public.coadmin_automatic_recharge_bonus_settings
        WHERE coadmin_uid = $1 AND deleted_at IS NULL
      `,
      [coadminUid]
    );
    const settings = mapSettingsRow(after.rows[0] as Record<string, unknown>);

    await client.query(
      `UPDATE public.authority_operations SET payload = $2::jsonb WHERE operation_key = $1`,
      [operationKey, JSON.stringify({ settings })]
    );
    await client.query('COMMIT');
    return { success: true, settings, validation };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore
    }
    throw error;
  } finally {
    client.release();
  }
}

async function ensureSettingsRowLocked(client: PoolClient, coadminUid: string) {
  const existing = await client.query(
    `
      SELECT coadmin_uid
      FROM public.coadmin_automatic_recharge_bonus_settings
      WHERE coadmin_uid = $1 AND deleted_at IS NULL
      FOR UPDATE
    `,
    [coadminUid]
  );
  if (existing.rows.length) return;

  const draft = buildDefaultArbDraftConfiguration();
  const serialized = serializeArbDraftConfiguration(draft);
  const operational = defaultArbOperationalState();
  const nowIso = new Date().toISOString();
  await client.query(
    `
      INSERT INTO public.coadmin_automatic_recharge_bonus_settings (
        coadmin_uid, feature_enabled, emergency_disable, player_opt_in_allowed,
        draft_policy, draft_tiers, created_at, updated_at, source, raw_json
      )
      VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::timestamptz,$7::timestamptz,'appbeg','{}'::jsonb)
      ON CONFLICT (coadmin_uid) DO NOTHING
    `,
    [
      coadminUid,
      operational.featureEnabled,
      operational.emergencyDisable,
      operational.playerOptInAllowed,
      JSON.stringify(serialized.policy),
      JSON.stringify(serialized.tiers),
      nowIso,
    ]
  );
}

export type PublishArbDraftResult = {
  success: true;
  duplicate?: boolean;
  version: ArbPublishedConfiguration;
  settings: ArbSettingsSnapshot;
};

export async function publishArbDraftInSql(input: {
  coadminUid: string;
  actorUid?: string | null;
  actorRole?: string | null;
  idempotencyKey?: string | null;
  acceptGapWarnings?: boolean;
  /** Optional override; defaults to current settings draft. */
  draft?: ArbDraftConfiguration;
}): Promise<PublishArbDraftResult> {
  const coadminUid = cleanText(input.coadminUid);
  if (!coadminUid) throw new Error('coadminUid is required.');

  const idempotencyKey =
    cleanText(input.idempotencyKey) || `publish:${randomUUID()}`;
  const operationKey = `arb_config:${coadminUid}:publish:${idempotencyKey}`;

  logAuthPayloadPreTxnRemoved('arb_publish');
  const db = getPlayerMirrorPool();
  if (!db) throw new Error('SQL authority unavailable.');

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await assertArbFoundationTables(client);

    const claim = await claimAuthorityOperation(client, {
      operationKey,
      operationType: 'arb_config',
      userUid: coadminUid,
      sourceId: coadminUid,
      actorUid: cleanText(input.actorUid) || coadminUid,
      actorRole: cleanText(input.actorRole) || 'coadmin',
      payload: {},
    });

    if (!claim.claimed) {
      const payload = await readAuthorityOperationPayloadWithClient(client, operationKey, {
        flowName: 'arb_publish',
      });
      await client.query('ROLLBACK');
      if (payload?.version && payload?.settings) {
        return {
          success: true,
          duplicate: true,
          version: payload.version as ArbPublishedConfiguration,
          settings: payload.settings as ArbSettingsSnapshot,
        };
      }
      throw new Error('Duplicate ARB publish in progress.');
    }

    await ensureSettingsRowLocked(client, coadminUid);
    const settingsResult = await client.query(
      `
        SELECT *
        FROM public.coadmin_automatic_recharge_bonus_settings
        WHERE coadmin_uid = $1 AND deleted_at IS NULL
        FOR UPDATE
      `,
      [coadminUid]
    );
    const settingsBefore = mapSettingsRow(
      settingsResult.rows[0] as Record<string, unknown>
    );
    const draft = input.draft || settingsBefore.draft;

    let currentPublished: ArbPublishedConfiguration | null = null;
    if (settingsBefore.publishedVersionId) {
      const currentResult = await client.query(
        `
          SELECT *
          FROM public.coadmin_automatic_recharge_bonus_config_versions
          WHERE version_id = $1 AND coadmin_uid = $2
          FOR UPDATE
        `,
        [settingsBefore.publishedVersionId, coadminUid]
      );
      if (currentResult.rows.length) {
        currentPublished = mapVersionRow(
          currentResult.rows[0] as Record<string, unknown>
        );
      }
    }

    const latestResult = await client.query<{ max: string | null }>(
      `
        SELECT MAX(version_number)::text AS max
        FROM public.coadmin_automatic_recharge_bonus_config_versions
        WHERE coadmin_uid = $1
      `,
      [coadminUid]
    );
    const latestVersionNumber = latestResult.rows[0]?.max
      ? Number(latestResult.rows[0].max)
      : null;

    const planned = planArbPublish({
      coadminUid,
      draft,
      featureEnabled: settingsBefore.operational.featureEnabled,
      currentPublished,
      latestVersionNumber,
      actorUid: input.actorUid,
      actorRole: input.actorRole,
      acceptGapWarnings: input.acceptGapWarnings,
    });

    if (!planned.ok) {
      throw Object.assign(new Error('ARB publish validation failed.'), {
        validation: planned.validation,
      });
    }

    const { plan } = planned;

    if (plan.previousVersionIdToSupersede) {
      await client.query(
        `
          UPDATE public.coadmin_automatic_recharge_bonus_config_versions
          SET status = 'superseded'
          WHERE version_id = $1 AND coadmin_uid = $2
        `,
        [plan.previousVersionIdToSupersede, coadminUid]
      );
    }

    await client.query(
      `
        INSERT INTO public.coadmin_automatic_recharge_bonus_config_versions (
          version_id,
          coadmin_uid,
          version_number,
          published_at,
          published_by_uid,
          published_by_role,
          status,
          policy_json,
          tiers_json,
          supersedes_version_id,
          source,
          raw_json
        )
        VALUES (
          $1, $2, $3, $4::timestamptz, NULLIF($5, ''), NULLIF($6, ''),
          'published', $7::jsonb, $8::jsonb, NULLIF($9, ''), 'appbeg', '{}'::jsonb
        )
      `,
      [
        plan.versionId,
        coadminUid,
        plan.versionNumber,
        plan.publishedAt,
        cleanText(input.actorUid),
        cleanText(input.actorRole),
        JSON.stringify(plan.policyJson),
        JSON.stringify(plan.tiersJson),
        cleanText(plan.supersedesVersionId),
      ]
    );

    const draftSerialized = serializeArbDraftConfiguration(plan.normalizedDraft);
    await client.query(
      `
        UPDATE public.coadmin_automatic_recharge_bonus_settings
        SET draft_policy = $2::jsonb,
            draft_tiers = $3::jsonb,
            published_version_id = $4,
            published_at = $5::timestamptz,
            updated_at = $5::timestamptz
        WHERE coadmin_uid = $1 AND deleted_at IS NULL
      `,
      [
        coadminUid,
        JSON.stringify(draftSerialized.policy),
        JSON.stringify(draftSerialized.tiers),
        plan.versionId,
        plan.publishedAt,
      ]
    );

    await insertAuditInTxn(client, {
      coadminUid,
      actorUid: input.actorUid,
      actorRole: input.actorRole,
      action: plan.audit.action,
      oldJson: plan.audit.oldJson,
      newJson: plan.audit.newJson,
      versionId: plan.versionId,
      idempotencyKey,
    });

    const version: ArbPublishedConfiguration = {
      versionId: plan.versionId,
      versionNumber: plan.versionNumber,
      status: 'published',
      coadminUid,
      publishedAt: plan.publishedAt,
      publishedByUid: cleanText(input.actorUid) || null,
      publishedByRole: cleanText(input.actorRole) || null,
      supersedesVersionId: plan.supersedesVersionId,
      policy: plan.normalizedDraft.policy,
      tiers: plan.normalizedDraft.tiers,
    };

    const afterSettings = await client.query(
      `
        SELECT *
        FROM public.coadmin_automatic_recharge_bonus_settings
        WHERE coadmin_uid = $1 AND deleted_at IS NULL
      `,
      [coadminUid]
    );
    const settings = mapSettingsRow(afterSettings.rows[0] as Record<string, unknown>);

    await client.query(
      `UPDATE public.authority_operations SET payload = $2::jsonb WHERE operation_key = $1`,
      [operationKey, JSON.stringify({ version, settings })]
    );
    await client.query('COMMIT');
    return { success: true, version, settings };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore
    }
    throw error;
  } finally {
    client.release();
  }
}

export type RollbackArbConfigResult = {
  success: true;
  duplicate?: boolean;
  version: ArbPublishedConfiguration;
  settings: ArbSettingsSnapshot;
};

export async function rollbackArbConfigInSql(input: {
  coadminUid: string;
  targetVersionId: string;
  actorUid?: string | null;
  actorRole?: string | null;
  idempotencyKey?: string | null;
  /** When true, also replace draft with the target snapshot. */
  loadDraftFromTarget?: boolean;
}): Promise<RollbackArbConfigResult> {
  const coadminUid = cleanText(input.coadminUid);
  const targetVersionId = cleanText(input.targetVersionId);
  if (!coadminUid || !targetVersionId) {
    throw new Error('coadminUid and targetVersionId are required.');
  }

  const idempotencyKey =
    cleanText(input.idempotencyKey) || `rollback:${targetVersionId}`;
  const operationKey = `arb_config:${coadminUid}:rollback:${idempotencyKey}`;

  logAuthPayloadPreTxnRemoved('arb_rollback');
  const db = getPlayerMirrorPool();
  if (!db) throw new Error('SQL authority unavailable.');

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await assertArbFoundationTables(client);

    const claim = await claimAuthorityOperation(client, {
      operationKey,
      operationType: 'arb_config',
      userUid: coadminUid,
      sourceId: targetVersionId,
      actorUid: cleanText(input.actorUid) || coadminUid,
      actorRole: cleanText(input.actorRole) || 'coadmin',
      payload: {},
    });

    if (!claim.claimed) {
      const payload = await readAuthorityOperationPayloadWithClient(client, operationKey, {
        flowName: 'arb_rollback',
      });
      await client.query('ROLLBACK');
      if (payload?.version && payload?.settings) {
        return {
          success: true,
          duplicate: true,
          version: payload.version as ArbPublishedConfiguration,
          settings: payload.settings as ArbSettingsSnapshot,
        };
      }
      throw new Error('Duplicate ARB rollback in progress.');
    }

    await ensureSettingsRowLocked(client, coadminUid);
    const settingsResult = await client.query(
      `
        SELECT *
        FROM public.coadmin_automatic_recharge_bonus_settings
        WHERE coadmin_uid = $1 AND deleted_at IS NULL
        FOR UPDATE
      `,
      [coadminUid]
    );
    const settingsBefore = mapSettingsRow(
      settingsResult.rows[0] as Record<string, unknown>
    );

    const targetResult = await client.query(
      `
        SELECT *
        FROM public.coadmin_automatic_recharge_bonus_config_versions
        WHERE version_id = $1 AND coadmin_uid = $2
        FOR UPDATE
      `,
      [targetVersionId, coadminUid]
    );
    if (!targetResult.rows.length) {
      throw new Error('Target ARB configuration version not found.');
    }
    const target = mapVersionRow(targetResult.rows[0] as Record<string, unknown>);
    if (!target) throw new Error('Target ARB configuration version is malformed.');

    let currentPublished: ArbPublishedConfiguration | null = null;
    if (settingsBefore.publishedVersionId) {
      const currentResult = await client.query(
        `
          SELECT *
          FROM public.coadmin_automatic_recharge_bonus_config_versions
          WHERE version_id = $1 AND coadmin_uid = $2
          FOR UPDATE
        `,
        [settingsBefore.publishedVersionId, coadminUid]
      );
      if (currentResult.rows.length) {
        currentPublished = mapVersionRow(
          currentResult.rows[0] as Record<string, unknown>
        );
      }
    }

    const plan = planArbRollback({
      target,
      currentPublished,
      actorUid: input.actorUid,
      actorRole: input.actorRole,
    });

    for (const update of plan.statusUpdates) {
      await client.query(
        `
          UPDATE public.coadmin_automatic_recharge_bonus_config_versions
          SET status = $2
          WHERE version_id = $1 AND coadmin_uid = $3
        `,
        [update.versionId, update.status, coadminUid]
      );
    }

    const draftSerialized = serializeArbDraftConfiguration(
      input.loadDraftFromTarget === false
        ? settingsBefore.draft
        : plan.draftFromTarget
    );

    await client.query(
      `
        UPDATE public.coadmin_automatic_recharge_bonus_settings
        SET published_version_id = $2,
            published_at = $3::timestamptz,
            draft_policy = $4::jsonb,
            draft_tiers = $5::jsonb,
            updated_at = $3::timestamptz
        WHERE coadmin_uid = $1 AND deleted_at IS NULL
      `,
      [
        coadminUid,
        plan.targetVersionId,
        plan.rolledBackAt,
        JSON.stringify(draftSerialized.policy),
        JSON.stringify(draftSerialized.tiers),
      ]
    );

    // Never mutate historical policy_json / tiers_json on any version row.
    await insertAuditInTxn(client, {
      coadminUid,
      actorUid: input.actorUid,
      actorRole: input.actorRole,
      action: plan.audit.action,
      oldJson: plan.audit.oldJson,
      newJson: plan.audit.newJson,
      versionId: plan.targetVersionId,
      idempotencyKey,
    });

    const versionRow = await client.query(
      `
        SELECT *
        FROM public.coadmin_automatic_recharge_bonus_config_versions
        WHERE version_id = $1
      `,
      [plan.targetVersionId]
    );
    const version = mapVersionRow(versionRow.rows[0] as Record<string, unknown>);
    if (!version) throw new Error('Rollback target became unreadable.');

    const afterSettings = await client.query(
      `
        SELECT *
        FROM public.coadmin_automatic_recharge_bonus_settings
        WHERE coadmin_uid = $1 AND deleted_at IS NULL
      `,
      [coadminUid]
    );
    const settings = mapSettingsRow(afterSettings.rows[0] as Record<string, unknown>);

    await client.query(
      `UPDATE public.authority_operations SET payload = $2::jsonb WHERE operation_key = $1`,
      [operationKey, JSON.stringify({ version, settings })]
    );
    await client.query('COMMIT');
    return { success: true, version, settings };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function updateArbOperationalStateInSql(input: {
  coadminUid: string;
  operational: Partial<ArbOperationalState>;
  actorUid?: string | null;
  actorRole?: string | null;
  idempotencyKey?: string | null;
}): Promise<ArbSettingsSnapshot> {
  const coadminUid = cleanText(input.coadminUid);
  if (!coadminUid) throw new Error('coadminUid is required.');

  const idempotencyKey =
    cleanText(input.idempotencyKey) || `operational:${randomUUID()}`;
  const operationKey = `arb_config:${coadminUid}:operational:${idempotencyKey}`;

  logAuthPayloadPreTxnRemoved('arb_operational');
  const db = getPlayerMirrorPool();
  if (!db) throw new Error('SQL authority unavailable.');

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await assertArbFoundationTables(client);

    const claim = await claimAuthorityOperation(client, {
      operationKey,
      operationType: 'arb_config',
      userUid: coadminUid,
      sourceId: coadminUid,
      actorUid: cleanText(input.actorUid) || coadminUid,
      actorRole: cleanText(input.actorRole) || 'coadmin',
      payload: {},
    });

    if (!claim.claimed) {
      const payload = await readAuthorityOperationPayloadWithClient(client, operationKey, {
        flowName: 'arb_operational',
      });
      await client.query('ROLLBACK');
      if (payload?.settings) {
        return payload.settings as ArbSettingsSnapshot;
      }
      throw new Error('Duplicate ARB operational update in progress.');
    }

    await ensureSettingsRowLocked(client, coadminUid);
    const beforeResult = await client.query(
      `
        SELECT *
        FROM public.coadmin_automatic_recharge_bonus_settings
        WHERE coadmin_uid = $1 AND deleted_at IS NULL
        FOR UPDATE
      `,
      [coadminUid]
    );
    const before = mapSettingsRow(beforeResult.rows[0] as Record<string, unknown>);
    const next: ArbOperationalState = {
      featureEnabled:
        input.operational.featureEnabled ?? before.operational.featureEnabled,
      emergencyDisable:
        input.operational.emergencyDisable ?? before.operational.emergencyDisable,
      playerOptInAllowed:
        input.operational.playerOptInAllowed ?? before.operational.playerOptInAllowed,
    };

    // Refuse enabling feature without a published configuration.
    if (next.featureEnabled && !before.publishedVersionId) {
      throw new Error(
        'Cannot enable Automatic Recharge Bonus without a published configuration.'
      );
    }

    if (next.featureEnabled && before.publishedVersionId) {
      const published = await client.query(
        `
          SELECT tiers_json
          FROM public.coadmin_automatic_recharge_bonus_config_versions
          WHERE version_id = $1 AND coadmin_uid = $2
        `,
        [before.publishedVersionId, coadminUid]
      );
      if (!published.rows.length) {
        throw new Error(
          'Cannot enable Automatic Recharge Bonus: published configuration is missing.'
        );
      }
      const tiers = parseArbTiers(readJsonField(published.rows[0].tiers_json)) || [];
      const { activeNormalizedArbTiers } = await import(
        '@/lib/economy/automaticRechargeBonus/normalize'
      );
      if (activeNormalizedArbTiers(tiers).length === 0) {
        throw new Error(
          'Cannot enable Automatic Recharge Bonus: published configuration has no active tiers.'
        );
      }
    }

    const nowIso = new Date().toISOString();
    await client.query(
      `
        UPDATE public.coadmin_automatic_recharge_bonus_settings
        SET feature_enabled = $2,
            emergency_disable = $3,
            player_opt_in_allowed = $4,
            updated_at = $5::timestamptz
        WHERE coadmin_uid = $1 AND deleted_at IS NULL
      `,
      [
        coadminUid,
        next.featureEnabled,
        next.emergencyDisable,
        next.playerOptInAllowed,
        nowIso,
      ]
    );

    await insertAuditInTxn(client, {
      coadminUid,
      actorUid: input.actorUid,
      actorRole: input.actorRole,
      action: 'operational_updated',
      oldJson: { ...before.operational },
      newJson: { ...next },
      idempotencyKey,
    });

    const after = await client.query(
      `
        SELECT *
        FROM public.coadmin_automatic_recharge_bonus_settings
        WHERE coadmin_uid = $1 AND deleted_at IS NULL
      `,
      [coadminUid]
    );
    const settings = mapSettingsRow(after.rows[0] as Record<string, unknown>);
    await client.query(
      `UPDATE public.authority_operations SET payload = $2::jsonb WHERE operation_key = $1`,
      [operationKey, JSON.stringify({ settings })]
    );
    await client.query('COMMIT');
    return settings;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function resetArbDraftToDefaultInSql(input: {
  coadminUid: string;
  actorUid?: string | null;
  actorRole?: string | null;
  idempotencyKey?: string | null;
}): Promise<SaveArbDraftResult> {
  return saveArbDraftInSql({
    ...input,
    draft: buildDefaultArbDraftConfiguration(),
    requireValid: true,
    auditAction: 'reset_to_default',
    idempotencyKey:
      cleanText(input.idempotencyKey) || `reset-default:${randomUUID()}`,
  });
}

export type { ArbSettingsAuditEntry };

function mapAuditRow(row: Record<string, unknown>): ArbSettingsAuditEntry {
  const oldJson = readJsonField(row.old_json);
  const newJson = readJsonField(row.new_json);
  return {
    id: Math.trunc(Number(row.id) || 0),
    coadminUid: cleanText(row.coadmin_uid),
    actorUid: cleanText(row.actor_uid) || null,
    actorRole: cleanText(row.actor_role) || null,
    action: cleanText(row.action),
    changedAt: toIsoString(row.changed_at),
    oldJson:
      oldJson && typeof oldJson === 'object' && !Array.isArray(oldJson)
        ? (oldJson as Record<string, unknown>)
        : null,
    newJson:
      newJson && typeof newJson === 'object' && !Array.isArray(newJson)
        ? (newJson as Record<string, unknown>)
        : null,
    versionId: cleanText(row.version_id) || null,
    idempotencyKey: cleanText(row.idempotency_key) || null,
  };
}

export async function listArbSettingsAuditInSql(input: {
  coadminUid: string;
  limit?: number;
}): Promise<ArbSettingsAuditEntry[]> {
  const coadminUid = cleanText(input.coadminUid);
  if (!coadminUid) return [];
  const limit = Math.min(200, Math.max(1, Math.trunc(Number(input.limit) || 50)));
  const db = getPlayerMirrorPool();
  if (!db) throw new Error('SQL authority unavailable.');

  const result = await db.query(
    `
      SELECT *
      FROM public.coadmin_automatic_recharge_bonus_settings_audit
      WHERE coadmin_uid = $1
      ORDER BY changed_at DESC, id DESC
      LIMIT $2
    `,
    [coadminUid, limit]
  );

  return result.rows.map((row) => mapAuditRow(row as Record<string, unknown>));
}
