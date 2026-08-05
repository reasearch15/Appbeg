import 'server-only';

import type { PoolClient } from 'pg';

import {
  assertArbFoundationTables,
} from '@/lib/sql/authorityAutomaticBonusConfig';
import {
  evaluateArbEligibility,
} from '@/lib/economy/automaticRechargeBonus/eligibility';
import { parseArbPlayerPreferenceState } from '@/lib/economy/automaticRechargeBonus/playerPreference';
import { resolveAutomaticRechargeBonus } from '@/lib/economy/automaticRechargeBonus/resolve';
import {
  isArbGlobalKillActive,
  isArbGrantsEnabled,
  isArbPlayerModeEnabled,
} from '@/lib/server/automaticRechargeBonusFlags';
import {
  cleanText,
  getPlayerMirrorPool,
  toIsoString,
} from '@/lib/sql/playerMirrorCommon';
import {
  loadArbPublishedConfigurationInSql,
  loadArbSettingsInSql,
} from '@/lib/sql/authorityAutomaticBonusConfig';
import { reconcileArbGrantByRequestId } from '@/lib/sql/authorityAutomaticBonusReconcile';

/**
 * Automatic Recharge Bonus — Phase 8 reporting (READ-ONLY).
 * Never mutates balances, evaluations, or financial events.
 */

export type ArbReportRange = {
  fromIso: string;
  toIso: string;
};

export type ArbEvaluationListFilters = {
  coadminUid: string;
  fromIso?: string | null;
  toIso?: string | null;
  playerUid?: string | null;
  mode?: 'shadow' | 'grant' | null;
  evaluationResult?: string | null;
  tierId?: string | null;
  configVersionId?: string | null;
  skipReason?: string | null;
  eligible?: boolean | null;
  search?: string | null;
  limit?: number;
  offset?: number;
};

export type ArbEvaluationReportRow = {
  evaluationId: string;
  mode: string;
  evaluationResult: string;
  eligible: boolean;
  bonusCalculated: number;
  rechargeAmount: number;
  tierId: string | null;
  configVersionId: string | null;
  configVersionNumber: number | null;
  skipReason: string | null;
  playerUid: string;
  requestId: string | null;
  evaluatedAt: string | null;
};

export type ArbDashboardStats = {
  range: ArbReportRange;
  playersAutoOn: number;
  playersInCooldown: number;
  autoBonusGrants: number;
  coinsGranted: number;
  promoLockedCoinsGranted: number;
  shadowEvaluations: number;
  skippedEvaluations: number;
  blockedEvaluations: number;
  wouldGrantEvaluations: number;
  grantSuccessRate: number | null;
  mostCommonRechargeTiers: Array<{ tierId: string; count: number; totalBonus: number }>;
  mostCommonRewardTiers: Array<{ tierId: string; count: number; totalBonus: number }>;
  topAutoBonusPlayers: Array<{
    playerUid: string;
    grantCount: number;
    coinsGranted: number;
  }>;
  skipReasonDistribution: Array<{ reason: string; count: number }>;
  evaluationResultDistribution: Array<{ result: string; count: number }>;
};

export type ArbOpsAuditEntry = {
  kind: 'settings_audit' | 'player_toggle' | 'evaluation';
  id: string;
  at: string;
  action: string;
  actorUid: string | null;
  actorRole: string | null;
  playerUid: string | null;
  versionId: string | null;
  detail: Record<string, unknown>;
};

function clampLimit(value: unknown, fallback = 50, max = 500) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(1, n));
}

function clampOffset(value: unknown) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(50_000, n);
}

export function resolveArbReportRange(input: {
  preset?: string | null;
  from?: string | null;
  to?: string | null;
  nowMs?: number;
}): ArbReportRange {
  const nowMs = input.nowMs ?? Date.now();
  const toIso = cleanText(input.to) || new Date(nowMs).toISOString();
  const toMs = Date.parse(toIso);
  const endMs = Number.isFinite(toMs) ? toMs : nowMs;
  const preset = cleanText(input.preset).toLowerCase() || '7d';

  if (cleanText(input.from)) {
    return {
      fromIso: cleanText(input.from),
      toIso: new Date(endMs).toISOString(),
    };
  }

  let fromMs = endMs - 7 * 24 * 60 * 60 * 1000;
  if (preset === 'today') {
    const d = new Date(endMs);
    d.setHours(0, 0, 0, 0);
    fromMs = d.getTime();
  } else if (preset === '30d') {
    fromMs = endMs - 30 * 24 * 60 * 60 * 1000;
  } else if (preset === '7d') {
    fromMs = endMs - 7 * 24 * 60 * 60 * 1000;
  }

  return {
    fromIso: new Date(fromMs).toISOString(),
    toIso: new Date(endMs).toISOString(),
  };
}

function mapEvaluationRow(row: Record<string, unknown>): ArbEvaluationReportRow {
  return {
    evaluationId: cleanText(row.evaluation_id),
    mode: cleanText(row.mode),
    evaluationResult: cleanText(row.evaluation_result),
    eligible: row.eligible === true,
    bonusCalculated: Number(row.bonus_calculated || 0),
    rechargeAmount: Number(row.recharge_amount || 0),
    tierId: cleanText(row.tier_id) || null,
    configVersionId: cleanText(row.config_version_id) || null,
    configVersionNumber:
      row.config_version_number == null ? null : Number(row.config_version_number),
    skipReason: cleanText(row.skip_reason) || null,
    playerUid: cleanText(row.player_uid),
    requestId: cleanText(row.request_id) || null,
    evaluatedAt: toIsoString(row.evaluated_at),
  };
}

function buildEvaluationWhere(filters: ArbEvaluationListFilters) {
  const params: unknown[] = [];
  const where: string[] = [];

  params.push(cleanText(filters.coadminUid));
  where.push(`coadmin_uid = $${params.length}`);

  if (cleanText(filters.fromIso)) {
    params.push(cleanText(filters.fromIso));
    where.push(`evaluated_at >= $${params.length}::timestamptz`);
  }
  if (cleanText(filters.toIso)) {
    params.push(cleanText(filters.toIso));
    where.push(`evaluated_at <= $${params.length}::timestamptz`);
  }
  if (cleanText(filters.playerUid)) {
    params.push(cleanText(filters.playerUid));
    where.push(`player_uid = $${params.length}`);
  }
  if (filters.mode === 'shadow' || filters.mode === 'grant') {
    params.push(filters.mode);
    where.push(`mode = $${params.length}`);
  }
  if (cleanText(filters.evaluationResult)) {
    params.push(cleanText(filters.evaluationResult));
    where.push(`evaluation_result = $${params.length}`);
  }
  if (cleanText(filters.tierId)) {
    params.push(cleanText(filters.tierId));
    where.push(`tier_id = $${params.length}`);
  }
  if (cleanText(filters.configVersionId)) {
    params.push(cleanText(filters.configVersionId));
    where.push(`config_version_id = $${params.length}`);
  }
  if (cleanText(filters.skipReason)) {
    params.push(`%${cleanText(filters.skipReason)}%`);
    where.push(`skip_reason ILIKE $${params.length}`);
  }
  if (filters.eligible === true || filters.eligible === false) {
    params.push(filters.eligible);
    where.push(`eligible = $${params.length}`);
  }
  if (cleanText(filters.search)) {
    const q = `%${cleanText(filters.search)}%`;
    params.push(q, q, q);
    where.push(
      `(player_uid ILIKE $${params.length - 2} OR request_id ILIKE $${params.length - 1} OR evaluation_id ILIKE $${params.length})`
    );
  }

  return { whereSql: where.join(' AND '), params };
}

export async function listArbEvaluationsForReportInSql(
  filters: ArbEvaluationListFilters
): Promise<{ rows: ArbEvaluationReportRow[]; total: number }> {
  const coadminUid = cleanText(filters.coadminUid);
  if (!coadminUid) return { rows: [], total: 0 };
  const limit = clampLimit(filters.limit, 50, 500);
  const offset = clampOffset(filters.offset);
  const db = getPlayerMirrorPool();
  if (!db) throw new Error('SQL authority unavailable.');

  const { whereSql, params } = buildEvaluationWhere(filters);
  const countResult = await db.query(
    `SELECT COUNT(*)::int AS n FROM public.automatic_recharge_bonus_evaluations WHERE ${whereSql}`,
    params
  );
  const total = Number(countResult.rows[0]?.n || 0);

  const listParams = [...params, limit, offset];
  const result = await db.query(
    `
      SELECT
        evaluation_id, mode, evaluation_result, eligible, bonus_calculated,
        recharge_amount, tier_id, config_version_id, config_version_number,
        skip_reason, player_uid, request_id, evaluated_at
      FROM public.automatic_recharge_bonus_evaluations
      WHERE ${whereSql}
      ORDER BY evaluated_at DESC, id DESC
      LIMIT $${listParams.length - 1} OFFSET $${listParams.length}
    `,
    listParams
  );

  return {
    rows: result.rows.map((row) => mapEvaluationRow(row as Record<string, unknown>)),
    total,
  };
}

export async function summarizeArbDashboardInSql(input: {
  coadminUid: string;
  fromIso: string;
  toIso: string;
  nowMs?: number;
}): Promise<ArbDashboardStats> {
  const coadminUid = cleanText(input.coadminUid);
  if (!coadminUid) {
    throw new Error('coadminUid is required.');
  }
  const fromIso = cleanText(input.fromIso);
  const toIso = cleanText(input.toIso);
  const nowMs = input.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const db = getPlayerMirrorPool();
  if (!db) throw new Error('SQL authority unavailable.');

  const client = await db.connect();
  try {
    await assertArbFoundationTables(client);

    const preferenceCounts = await client.query(
      `
        SELECT
          COUNT(*) FILTER (
            WHERE COALESCE((raw_firestore_data->>'automaticBonusEnabled')::boolean, false) = true
          )::int AS auto_on,
          COUNT(*) FILTER (
            WHERE COALESCE((raw_firestore_data->>'automaticBonusEnabled')::boolean, false) = false
              AND NULLIF(raw_firestore_data->>'bonusCooldownEndsAt', '') IS NOT NULL
              AND (raw_firestore_data->>'bonusCooldownEndsAt')::timestamptz > $2::timestamptz
          )::int AS in_cooldown
        FROM public.players_cache
        WHERE deleted_at IS NULL
          AND (
            coadmin_uid = $1
            OR (NULLIF(coadmin_uid, '') IS NULL AND created_by = $1)
          )
      `,
      [coadminUid, nowIso]
    );

    const evalAgg = await client.query(
      `
        SELECT
          COUNT(*) FILTER (
            WHERE mode = 'grant' AND evaluation_result = 'granted'
          )::int AS grants,
          COALESCE(SUM(bonus_calculated) FILTER (
            WHERE mode = 'grant' AND evaluation_result = 'granted'
          ), 0)::numeric AS coins_granted,
          COUNT(*) FILTER (WHERE mode = 'shadow')::int AS shadow_evals,
          COUNT(*) FILTER (
            WHERE evaluation_result = 'skipped'
          )::int AS skipped,
          COUNT(*) FILTER (
            WHERE evaluation_result = 'blocked'
          )::int AS blocked,
          COUNT(*) FILTER (
            WHERE evaluation_result = 'would_grant'
          )::int AS would_grant,
          COUNT(*) FILTER (
            WHERE mode = 'grant'
          )::int AS grant_mode_total
        FROM public.automatic_recharge_bonus_evaluations
        WHERE coadmin_uid = $1
          AND evaluated_at >= $2::timestamptz
          AND evaluated_at <= $3::timestamptz
      `,
      [coadminUid, fromIso, toIso]
    );

    const tierAgg = await client.query(
      `
        SELECT
          COALESCE(NULLIF(tier_id, ''), '(none)') AS tier_id,
          COUNT(*)::int AS count,
          COALESCE(SUM(bonus_calculated), 0)::numeric AS total_bonus
        FROM public.automatic_recharge_bonus_evaluations
        WHERE coadmin_uid = $1
          AND evaluated_at >= $2::timestamptz
          AND evaluated_at <= $3::timestamptz
          AND mode = 'grant'
          AND evaluation_result = 'granted'
        GROUP BY 1
        ORDER BY count DESC, total_bonus DESC
        LIMIT 10
      `,
      [coadminUid, fromIso, toIso]
    );

    const topPlayers = await client.query(
      `
        SELECT
          player_uid,
          COUNT(*)::int AS grant_count,
          COALESCE(SUM(bonus_calculated), 0)::numeric AS coins_granted
        FROM public.automatic_recharge_bonus_evaluations
        WHERE coadmin_uid = $1
          AND evaluated_at >= $2::timestamptz
          AND evaluated_at <= $3::timestamptz
          AND mode = 'grant'
          AND evaluation_result = 'granted'
        GROUP BY player_uid
        ORDER BY coins_granted DESC, grant_count DESC
        LIMIT 10
      `,
      [coadminUid, fromIso, toIso]
    );

    const skipDist = await client.query(
      `
        SELECT
          COALESCE(NULLIF(skip_reason, ''), '(none)') AS reason,
          COUNT(*)::int AS count
        FROM public.automatic_recharge_bonus_evaluations
        WHERE coadmin_uid = $1
          AND evaluated_at >= $2::timestamptz
          AND evaluated_at <= $3::timestamptz
          AND evaluation_result IN ('skipped', 'blocked')
        GROUP BY 1
        ORDER BY count DESC
        LIMIT 20
      `,
      [coadminUid, fromIso, toIso]
    );

    const resultDist = await client.query(
      `
        SELECT
          evaluation_result AS result,
          COUNT(*)::int AS count
        FROM public.automatic_recharge_bonus_evaluations
        WHERE coadmin_uid = $1
          AND evaluated_at >= $2::timestamptz
          AND evaluated_at <= $3::timestamptz
        GROUP BY 1
        ORDER BY count DESC
      `,
      [coadminUid, fromIso, toIso]
    );

    const grants = Number(evalAgg.rows[0]?.grants || 0);
    const grantModeTotal = Number(evalAgg.rows[0]?.grant_mode_total || 0);
    const coinsGranted = Number(evalAgg.rows[0]?.coins_granted || 0);

    return {
      range: { fromIso, toIso },
      playersAutoOn: Number(preferenceCounts.rows[0]?.auto_on || 0),
      playersInCooldown: Number(preferenceCounts.rows[0]?.in_cooldown || 0),
      autoBonusGrants: grants,
      coinsGranted,
      promoLockedCoinsGranted: coinsGranted,
      shadowEvaluations: Number(evalAgg.rows[0]?.shadow_evals || 0),
      skippedEvaluations: Number(evalAgg.rows[0]?.skipped || 0),
      blockedEvaluations: Number(evalAgg.rows[0]?.blocked || 0),
      wouldGrantEvaluations: Number(evalAgg.rows[0]?.would_grant || 0),
      grantSuccessRate:
        grantModeTotal > 0 ? Math.round((grants / grantModeTotal) * 10000) / 100 : null,
      mostCommonRechargeTiers: tierAgg.rows.map((row: Record<string, unknown>) => ({
        tierId: cleanText(row.tier_id) || '(none)',
        count: Number(row.count || 0),
        totalBonus: Number(row.total_bonus || 0),
      })),
      mostCommonRewardTiers: tierAgg.rows.map((row: Record<string, unknown>) => ({
        tierId: cleanText(row.tier_id) || '(none)',
        count: Number(row.count || 0),
        totalBonus: Number(row.total_bonus || 0),
      })),
      topAutoBonusPlayers: topPlayers.rows.map((row: Record<string, unknown>) => ({
        playerUid: cleanText(row.player_uid),
        grantCount: Number(row.grant_count || 0),
        coinsGranted: Number(row.coins_granted || 0),
      })),
      skipReasonDistribution: skipDist.rows.map((row: Record<string, unknown>) => ({
        reason: cleanText(row.reason) || '(none)',
        count: Number(row.count || 0),
      })),
      evaluationResultDistribution: resultDist.rows.map((row: Record<string, unknown>) => ({
        result: cleanText(row.result),
        count: Number(row.count || 0),
      })),
    };
  } finally {
    client.release();
  }
}

export async function listArbOpsAuditInSql(input: {
  coadminUid: string;
  fromIso?: string | null;
  toIso?: string | null;
  playerUid?: string | null;
  action?: string | null;
  search?: string | null;
  limit?: number;
  offset?: number;
}): Promise<{ rows: ArbOpsAuditEntry[]; total: number }> {
  const coadminUid = cleanText(input.coadminUid);
  if (!coadminUid) return { rows: [], total: 0 };
  const limit = clampLimit(input.limit, 80, 500);
  const offset = clampOffset(input.offset);
  const db = getPlayerMirrorPool();
  if (!db) throw new Error('SQL authority unavailable.');

  const fromIso = cleanText(input.fromIso);
  const toIso = cleanText(input.toIso);
  const playerUid = cleanText(input.playerUid);
  const action = cleanText(input.action);
  const search = cleanText(input.search);

  const settingsParams: unknown[] = [coadminUid];
  const settingsWhere = [`coadmin_uid = $1`];
  if (fromIso) {
    settingsParams.push(fromIso);
    settingsWhere.push(`changed_at >= $${settingsParams.length}::timestamptz`);
  }
  if (toIso) {
    settingsParams.push(toIso);
    settingsWhere.push(`changed_at <= $${settingsParams.length}::timestamptz`);
  }
  if (action) {
    settingsParams.push(`%${action}%`);
    settingsWhere.push(`action ILIKE $${settingsParams.length}`);
  }
  if (search) {
    settingsParams.push(`%${search}%`);
    settingsWhere.push(
      `(action ILIKE $${settingsParams.length} OR COALESCE(actor_uid,'') ILIKE $${settingsParams.length} OR COALESCE(version_id,'') ILIKE $${settingsParams.length})`
    );
  }

  const toggleParams: unknown[] = [coadminUid];
  const toggleWhere = [
    `operation_type = 'arb_player_toggle'`,
    `payload->>'coadminUid' = $1`,
  ];
  if (fromIso) {
    toggleParams.push(fromIso);
    toggleWhere.push(`created_at >= $${toggleParams.length}::timestamptz`);
  }
  if (toIso) {
    toggleParams.push(toIso);
    toggleWhere.push(`created_at <= $${toggleParams.length}::timestamptz`);
  }
  if (playerUid) {
    toggleParams.push(playerUid);
    toggleWhere.push(`user_uid = $${toggleParams.length}`);
  }
  if (action) {
    toggleParams.push(`%${action}%`);
    toggleWhere.push(
      `(payload->>'transition' ILIKE $${toggleParams.length} OR payload->>'action' ILIKE $${toggleParams.length})`
    );
  }
  if (search) {
    toggleParams.push(`%${search}%`);
    toggleWhere.push(
      `(COALESCE(user_uid,'') ILIKE $${toggleParams.length} OR COALESCE(actor_uid,'') ILIKE $${toggleParams.length})`
    );
  }

  const evalParams: unknown[] = [coadminUid];
  const evalWhere = [`coadmin_uid = $1`];
  if (fromIso) {
    evalParams.push(fromIso);
    evalWhere.push(`evaluated_at >= $${evalParams.length}::timestamptz`);
  }
  if (toIso) {
    evalParams.push(toIso);
    evalWhere.push(`evaluated_at <= $${evalParams.length}::timestamptz`);
  }
  if (playerUid) {
    evalParams.push(playerUid);
    evalWhere.push(`player_uid = $${evalParams.length}`);
  }
  if (action) {
    evalParams.push(`%${action}%`);
    evalWhere.push(
      `(mode ILIKE $${evalParams.length} OR evaluation_result ILIKE $${evalParams.length})`
    );
  }
  if (search) {
    evalParams.push(`%${search}%`);
    evalWhere.push(
      `(player_uid ILIKE $${evalParams.length} OR COALESCE(request_id,'') ILIKE $${evalParams.length} OR evaluation_id ILIKE $${evalParams.length})`
    );
  }

  // Fetch a window from each source then merge (reporting read path).
  const fetchLimit = Math.min(500, offset + limit);
  const [settings, toggles, evals] = await Promise.all([
    db.query(
      `
        SELECT id, action, actor_uid, actor_role, changed_at, version_id, old_json, new_json
        FROM public.coadmin_automatic_recharge_bonus_settings_audit
        WHERE ${settingsWhere.join(' AND ')}
        ORDER BY changed_at DESC, id DESC
        LIMIT ${fetchLimit}
      `,
      settingsParams
    ),
    db.query(
      `
        SELECT operation_key, user_uid, actor_uid, actor_role, created_at, payload
        FROM public.authority_operations
        WHERE ${toggleWhere.join(' AND ')}
        ORDER BY created_at DESC
        LIMIT ${fetchLimit}
      `,
      toggleParams
    ),
    db.query(
      `
        SELECT evaluation_id, mode, evaluation_result, player_uid, request_id,
               bonus_calculated, skip_reason, evaluated_at, config_version_id
        FROM public.automatic_recharge_bonus_evaluations
        WHERE ${evalWhere.join(' AND ')}
        ORDER BY evaluated_at DESC, id DESC
        LIMIT ${fetchLimit}
      `,
      evalParams
    ),
  ]);

  const merged: ArbOpsAuditEntry[] = [];

  for (const row of settings.rows as Record<string, unknown>[]) {
    merged.push({
      kind: 'settings_audit',
      id: `settings:${row.id}`,
      at: toIsoString(row.changed_at) || '',
      action: cleanText(row.action),
      actorUid: cleanText(row.actor_uid) || null,
      actorRole: cleanText(row.actor_role) || null,
      playerUid: null,
      versionId: cleanText(row.version_id) || null,
      detail: {
        oldJson: row.old_json || null,
        newJson: row.new_json || null,
      },
    });
  }

  for (const row of toggles.rows as Record<string, unknown>[]) {
    const payload =
      row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
        ? (row.payload as Record<string, unknown>)
        : {};
    const transition = cleanText(payload.transition);
    const startedCooldown = payload.startedCooldown === true;
    const cancelledCooldown = payload.cancelledCooldown === true;
    let actionLabel = 'player_toggle';
    if (transition === 'off_to_on') actionLabel = 'player_enable';
    else if (transition === 'on_to_off') actionLabel = 'player_disable';
    if (startedCooldown) actionLabel = 'cooldown_started';
    if (cancelledCooldown) actionLabel = 'cooldown_cancelled';

    merged.push({
      kind: 'player_toggle',
      id: `toggle:${cleanText(row.operation_key)}`,
      at: toIsoString(row.created_at) || '',
      action: actionLabel,
      actorUid: cleanText(row.actor_uid) || null,
      actorRole: cleanText(row.actor_role) || null,
      playerUid: cleanText(row.user_uid) || null,
      versionId: null,
      detail: {
        transition: transition || null,
        startedCooldown,
        cancelledCooldown,
        requestedEnabled: payload.requestedEnabled,
      },
    });
  }

  for (const row of evals.rows as Record<string, unknown>[]) {
    const mode = cleanText(row.mode);
    const result = cleanText(row.evaluation_result);
    let actionLabel = `evaluation_${result}`;
    if (mode === 'shadow') actionLabel = `shadow_${result}`;
    if (mode === 'grant' && result === 'granted') actionLabel = 'real_grant';

    merged.push({
      kind: 'evaluation',
      id: `eval:${cleanText(row.evaluation_id)}`,
      at: toIsoString(row.evaluated_at) || '',
      action: actionLabel,
      actorUid: null,
      actorRole: null,
      playerUid: cleanText(row.player_uid) || null,
      versionId: cleanText(row.config_version_id) || null,
      detail: {
        mode,
        evaluationResult: result,
        requestId: cleanText(row.request_id) || null,
        bonusCalculated: Number(row.bonus_calculated || 0),
        skipReason: cleanText(row.skip_reason) || null,
      },
    });
  }

  merged.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const total = merged.length;
  const rows = merged.slice(offset, offset + limit);
  return { rows, total };
}

export async function inspectArbPlayerInSql(input: {
  coadminUid: string;
  playerUid: string;
  sampleRechargeAmount?: number | null;
  nowMs?: number;
}) {
  const coadminUid = cleanText(input.coadminUid);
  const playerUid = cleanText(input.playerUid);
  if (!coadminUid || !playerUid) {
    throw new Error('coadminUid and playerUid are required.');
  }
  const nowMs = input.nowMs ?? Date.now();
  const db = getPlayerMirrorPool();
  if (!db) throw new Error('SQL authority unavailable.');

  const playerResult = await db.query(
    `
      SELECT
        p.uid,
        p.username,
        p.coadmin_uid,
        p.created_by,
        p.raw_firestore_data,
        (
          SELECT s.bonus_blocked_until
          FROM public.user_balance_snapshots_cache s
          WHERE s.firebase_id = p.uid AND s.deleted_at IS NULL
          LIMIT 1
        ) AS bonus_blocked_until
      FROM public.players_cache p
      WHERE p.uid = $1 AND p.deleted_at IS NULL
      LIMIT 1
    `,
    [playerUid]
  );
  if (!playerResult.rows.length) {
    throw new Error('Player not found.');
  }
  const player = playerResult.rows[0] as Record<string, unknown>;
  const playerCoadmin =
    cleanText(player.coadmin_uid) || cleanText(player.created_by) || '';
  if (playerCoadmin !== coadminUid) {
    throw new Error('Player is outside coadmin scope.');
  }

  const settings = await loadArbSettingsInSql({ coadminUid });
  const published = await loadArbPublishedConfigurationInSql({ coadminUid });
  const preference = parseArbPlayerPreferenceState(player.raw_firestore_data);
  const blockedUntil = toIsoString(player.bonus_blocked_until);
  const riskBlocked = blockedUntil ? Date.parse(blockedUntil) > nowMs : false;

  const eligibility = evaluateArbEligibility({
    preference,
    nowMs,
    grantsEnabled: isArbGrantsEnabled(),
    gates: {
      playerModeEnabled: isArbPlayerModeEnabled(),
      globalKillActive: isArbGlobalKillActive(),
      featureEnabled: settings?.operational.featureEnabled === true,
      emergencyDisable: settings?.operational.emergencyDisable === true,
      playerOptInAllowed: settings
        ? settings.operational.playerOptInAllowed !== false
        : false,
      riskBlocked,
      hasPublishedConfiguration: Boolean(published?.versionId),
    },
  });

  const sampleAmount =
    input.sampleRechargeAmount != null && Number.isFinite(Number(input.sampleRechargeAmount))
      ? Math.max(0, Number(input.sampleRechargeAmount))
      : 50;
  const resolve = resolveAutomaticRechargeBonus({
    rechargeAmount: sampleAmount,
    configuration: published,
  });

  const lastEval = await db.query(
    `
      SELECT evaluation_id, mode, evaluation_result, bonus_calculated, skip_reason,
             tier_id, config_version_id, request_id, evaluated_at, recharge_amount
      FROM public.automatic_recharge_bonus_evaluations
      WHERE player_uid = $1 AND coadmin_uid = $2
      ORDER BY evaluated_at DESC, id DESC
      LIMIT 1
    `,
    [playerUid, coadminUid]
  );
  const lastGrant = await db.query(
    `
      SELECT evaluation_id, bonus_calculated, tier_id, config_version_id,
             request_id, evaluated_at, recharge_amount
      FROM public.automatic_recharge_bonus_evaluations
      WHERE player_uid = $1 AND coadmin_uid = $2
        AND mode = 'grant' AND evaluation_result = 'granted'
      ORDER BY evaluated_at DESC, id DESC
      LIMIT 1
    `,
    [playerUid, coadminUid]
  );

  return {
    playerUid,
    username: cleanText(player.username) || null,
    coadminUid,
    currentMode: eligibility.currentMode,
    preference,
    eligibility: {
      canEnable: eligibility.canEnable,
      canDisable: eligibility.canDisable,
      canClaimBonusEvent: eligibility.canClaimBonusEvent,
      canReceiveAutoBonus: eligibility.canReceiveAutoBonus,
      blockers: eligibility.blockers,
    },
    sampleRechargeAmount: sampleAmount,
    calculatedBonus: resolve.bonusCoins,
    currentTier: resolve.tier,
    resolveSkipReason: resolve.skipReason,
    configurationVersion: published
      ? {
          versionId: published.versionId,
          versionNumber: published.versionNumber,
          status: published.status,
        }
      : null,
    operational: settings?.operational || null,
    lastEvaluation: lastEval.rows[0]
      ? mapEvaluationRow(lastEval.rows[0] as Record<string, unknown>)
      : null,
    lastGrant: lastGrant.rows[0]
      ? mapEvaluationRow({
          ...(lastGrant.rows[0] as Record<string, unknown>),
          mode: 'grant',
          evaluation_result: 'granted',
          eligible: true,
          player_uid: playerUid,
        })
      : null,
    readOnly: true as const,
  };
}

export async function reconcileArbRequestForReportInSql(input: {
  coadminUid: string;
  requestId: string;
}) {
  const coadminUid = cleanText(input.coadminUid);
  const requestId = cleanText(input.requestId);
  if (!coadminUid || !requestId) {
    throw new Error('coadminUid and requestId are required.');
  }

  const report = await reconcileArbGrantByRequestId(requestId);

  // Scope check: evaluation or request must belong to this coadmin when present.
  const ownedEval = report.evaluations.some(() => true);
  if (ownedEval) {
    const db = getPlayerMirrorPool();
    if (!db) throw new Error('SQL authority unavailable.');
    const scope = await db.query(
      `
        SELECT 1
        FROM public.automatic_recharge_bonus_evaluations
        WHERE request_id = $1 AND coadmin_uid = $2
        LIMIT 1
      `,
      [requestId, coadminUid]
    );
    const requestScope = await db.query(
      `
        SELECT 1
        FROM public.player_game_requests_cache
        WHERE firebase_id = $1 AND coadmin_uid = $2
        LIMIT 1
      `,
      [requestId, coadminUid]
    );
    if (!scope.rows.length && !requestScope.rows.length && report.request.found) {
      throw new Error('Request is outside coadmin scope.');
    }
  }

  return report;
}

/** Used by integration tests — optional client injection. */
export async function assertArbReportTables(client: PoolClient) {
  await assertArbFoundationTables(client);
}
