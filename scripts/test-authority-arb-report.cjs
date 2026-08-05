/**
 * PostgreSQL integration tests — ARB Phase 8 reporting (read-only).
 *
 * Requires:
 *   DATABASE_URL=...
 *   TEST_PLAYER_UID=...
 *   ARB_REPORTING_ENABLED=1 (set by this script)
 *
 * Run:
 *   DATABASE_URL=... TEST_PLAYER_UID=... npm run test:arb-report
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const ts = require('typescript');
const { randomUUID } = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const databaseUrl = String(
  process.env.DATABASE_URL || process.env.POSTGRES_URL || ''
).trim();
const TEST_PLAYER_UID = String(process.env.TEST_PLAYER_UID || '').trim();

if (!databaseUrl) {
  console.error('DATABASE_URL (or POSTGRES_URL) is required.');
  process.exitCode = 1;
  process.exit();
}
if (!TEST_PLAYER_UID) {
  console.error('TEST_PLAYER_UID is required.');
  process.exitCode = 1;
  process.exit();
}

process.env.DATABASE_URL = databaseUrl;
process.env.ARB_REPORTING_ENABLED = '1';
process.env.ARB_PLAYER_MODE_ENABLED = process.env.ARB_PLAYER_MODE_ENABLED || '1';

const loaded = new Map();
const originalResolveFilename = Module._resolveFilename;
const originalLoad = Module._load;

function compileTs(absPath) {
  const source = fs.readFileSync(absPath, 'utf8');
  const stripped = source.replace(/^import\s+['"]server-only['"];?\s*$/gm, '');
  return ts.transpileModule(stripped, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: absPath,
  }).outputText;
}

function resolveAlias(id) {
  if (id === 'server-only') return id;
  if (id.startsWith('@/')) {
    const rel = id.slice(2);
    const base = path.join(ROOT, rel);
    if (fs.existsSync(`${base}.ts`) && fs.statSync(`${base}.ts`).isFile()) {
      return `${base}.ts`;
    }
    if (fs.existsSync(`${base}.tsx`) && fs.statSync(`${base}.tsx`).isFile()) {
      return `${base}.tsx`;
    }
    if (fs.existsSync(path.join(base, 'index.ts'))) {
      return path.join(base, 'index.ts');
    }
    if (fs.existsSync(base) && fs.statSync(base).isFile()) return base;
  }
  return null;
}

Module._resolveFilename = function patchedResolve(request, parent, isMain, options) {
  if (request === 'server-only') return 'server-only';
  const aliased = resolveAlias(request);
  if (aliased) return aliased;
  return originalResolveFilename.call(this, request, parent, isMain, options);
};

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'server-only') return {};
  const aliased = resolveAlias(request);
  const target = aliased || request;
  if (typeof target === 'string' && (target.endsWith('.ts') || target.endsWith('.tsx'))) {
    if (loaded.has(target)) return loaded.get(target).exports;
    const compiled = compileTs(target);
    const moduleObj = new Module(target, parent);
    moduleObj.filename = target;
    moduleObj.paths = Module._nodeModulePaths(path.dirname(target));
    loaded.set(target, moduleObj);
    moduleObj._compile(compiled, target);
    return moduleObj.exports;
  }
  return originalLoad.call(this, request, parent, isMain);
};

const reportAuthority = Module._load(
  path.join(ROOT, 'lib/sql/authorityAutomaticBonusReport.ts'),
  module,
  false
);
const configAuthority = Module._load(
  path.join(ROOT, 'lib/sql/authorityAutomaticBonusConfig.ts'),
  module,
  false
);

let passed = 0;
let failed = 0;
let TEST_COADMIN_UID = String(process.env.TEST_COADMIN_UID || '').trim();
const createdEvalIds = [];
const createdRequestIds = [];

function test(name, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => {
      passed += 1;
      console.log(`ok - ${name}`);
    })
    .catch((error) => {
      failed += 1;
      console.error(`fail - ${name}`);
      console.error(error);
      process.exitCode = 1;
    });
}

async function seedEvaluation(pool, input) {
  const evaluationId = randomUUID();
  const requestId = input.requestId || `arb-report-itest-${randomUUID()}`;
  createdEvalIds.push(evaluationId);
  createdRequestIds.push(requestId);
  await pool.query(
    `
      INSERT INTO public.automatic_recharge_bonus_evaluations (
        evaluation_id, mode, coadmin_uid, player_uid, request_id,
        recharge_amount, config_version_id, config_version_number, tier_id,
        bonus_calculated, eligible, skip_reason, evaluation_result,
        evaluated_at, created_at, source, raw_json
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9,
        $10, $11, $12, $13,
        $14::timestamptz, $14::timestamptz, 'appbeg', '{}'::jsonb
      )
    `,
    [
      evaluationId,
      input.mode,
      TEST_COADMIN_UID,
      TEST_PLAYER_UID,
      requestId,
      input.rechargeAmount ?? 50,
      input.configVersionId || null,
      input.configVersionNumber ?? 1,
      input.tierId || 'report-t10',
      input.bonusCalculated ?? 7,
      input.eligible !== false,
      input.skipReason || null,
      input.evaluationResult,
      input.evaluatedAt || new Date().toISOString(),
    ]
  );
  return { evaluationId, requestId };
}

async function cleanup(pool) {
  if (createdRequestIds.length) {
    await pool.query(
      `DELETE FROM public.automatic_recharge_bonus_evaluations WHERE request_id = ANY($1::text[])`,
      [createdRequestIds]
    );
  }
}

async function main() {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: databaseUrl });

  const client = await pool.connect();
  try {
    await configAuthority.assertArbFoundationTables(client);
  } finally {
    client.release();
  }

  const player = await pool.query(
    `SELECT coadmin_uid, created_by FROM public.players_cache WHERE uid = $1 AND deleted_at IS NULL`,
    [TEST_PLAYER_UID]
  );
  if (!player.rows.length) throw new Error('TEST_PLAYER_UID not found');
  TEST_COADMIN_UID =
    TEST_COADMIN_UID ||
    String(player.rows[0].coadmin_uid || player.rows[0].created_by || '').trim();
  if (!TEST_COADMIN_UID) throw new Error('Could not resolve TEST_COADMIN_UID');

  await configAuthority.ensureArbSettingsInSql({ coadminUid: TEST_COADMIN_UID });

  const now = Date.now();
  await seedEvaluation(pool, {
    mode: 'grant',
    evaluationResult: 'granted',
    bonusCalculated: 7,
    tierId: 'report-t10',
    evaluatedAt: new Date(now - 60_000).toISOString(),
  });
  await seedEvaluation(pool, {
    mode: 'shadow',
    evaluationResult: 'would_grant',
    bonusCalculated: 7,
    evaluatedAt: new Date(now - 120_000).toISOString(),
  });
  await seedEvaluation(pool, {
    mode: 'grant',
    evaluationResult: 'skipped',
    bonusCalculated: 0,
    eligible: false,
    skipReason: 'not_enabled',
    evaluatedAt: new Date(now - 180_000).toISOString(),
  });

  // Large dataset seed for pagination
  for (let i = 0; i < 35; i += 1) {
    await seedEvaluation(pool, {
      mode: 'grant',
      evaluationResult: i % 5 === 0 ? 'blocked' : 'skipped',
      bonusCalculated: 0,
      eligible: false,
      skipReason: i % 2 === 0 ? 'below_minimum' : 'not_enabled',
      evaluatedAt: new Date(now - (i + 3) * 60_000).toISOString(),
    });
  }

  const range = reportAuthority.resolveArbReportRange({ preset: '7d' });

  await test('dashboard queries return KPIs', async () => {
    const stats = await reportAuthority.summarizeArbDashboardInSql({
      coadminUid: TEST_COADMIN_UID,
      fromIso: range.fromIso,
      toIso: range.toIso,
    });
    assert.ok(stats.autoBonusGrants >= 1);
    assert.ok(stats.shadowEvaluations >= 1);
    assert.ok(stats.skippedEvaluations >= 1);
    assert.ok(Array.isArray(stats.skipReasonDistribution));
    assert.ok(Array.isArray(stats.topAutoBonusPlayers));
    assert.ok(stats.coinsGranted >= 7);
    assert.strictEqual(stats.promoLockedCoinsGranted, stats.coinsGranted);
  });

  await test('grant history filter', async () => {
    const result = await reportAuthority.listArbEvaluationsForReportInSql({
      coadminUid: TEST_COADMIN_UID,
      fromIso: range.fromIso,
      toIso: range.toIso,
      mode: 'grant',
      evaluationResult: 'granted',
      limit: 20,
      offset: 0,
    });
    assert.ok(result.total >= 1);
    assert.ok(result.rows.every((r) => r.mode === 'grant' && r.evaluationResult === 'granted'));
  });

  await test('shadow history filter', async () => {
    const result = await reportAuthority.listArbEvaluationsForReportInSql({
      coadminUid: TEST_COADMIN_UID,
      fromIso: range.fromIso,
      toIso: range.toIso,
      mode: 'shadow',
      limit: 20,
    });
    assert.ok(result.total >= 1);
    assert.ok(result.rows.every((r) => r.mode === 'shadow'));
  });

  await test('player history filter', async () => {
    const result = await reportAuthority.listArbEvaluationsForReportInSql({
      coadminUid: TEST_COADMIN_UID,
      playerUid: TEST_PLAYER_UID,
      limit: 50,
    });
    assert.ok(result.total >= 3);
    assert.ok(result.rows.every((r) => r.playerUid === TEST_PLAYER_UID));
  });

  await test('version / tier / skip filtering', async () => {
    const byTier = await reportAuthority.listArbEvaluationsForReportInSql({
      coadminUid: TEST_COADMIN_UID,
      tierId: 'report-t10',
      limit: 20,
    });
    assert.ok(byTier.total >= 1);
    const bySkip = await reportAuthority.listArbEvaluationsForReportInSql({
      coadminUid: TEST_COADMIN_UID,
      skipReason: 'not_enabled',
      limit: 50,
    });
    assert.ok(bySkip.total >= 1);
  });

  await test('pagination on large datasets', async () => {
    const page1 = await reportAuthority.listArbEvaluationsForReportInSql({
      coadminUid: TEST_COADMIN_UID,
      fromIso: range.fromIso,
      toIso: range.toIso,
      limit: 10,
      offset: 0,
    });
    const page2 = await reportAuthority.listArbEvaluationsForReportInSql({
      coadminUid: TEST_COADMIN_UID,
      fromIso: range.fromIso,
      toIso: range.toIso,
      limit: 10,
      offset: 10,
    });
    assert.ok(page1.total >= 35);
    assert.strictEqual(page1.rows.length, 10);
    assert.strictEqual(page2.rows.length, 10);
    assert.notStrictEqual(page1.rows[0].evaluationId, page2.rows[0].evaluationId);
  });

  await test('ops audit queries merge sources', async () => {
    const audit = await reportAuthority.listArbOpsAuditInSql({
      coadminUid: TEST_COADMIN_UID,
      fromIso: range.fromIso,
      toIso: range.toIso,
      limit: 40,
      offset: 0,
    });
    assert.ok(audit.total >= 1);
    assert.ok(audit.rows.some((r) => r.kind === 'evaluation'));
  });

  await test('version history list still works', async () => {
    const versions = await configAuthority.listArbConfigVersionsInSql({
      coadminUid: TEST_COADMIN_UID,
      limit: 20,
    });
    assert.ok(Array.isArray(versions));
  });

  await test('reconciliation query by request id', async () => {
    const seeded = await seedEvaluation(pool, {
      mode: 'grant',
      evaluationResult: 'skipped',
      bonusCalculated: 0,
      eligible: false,
      skipReason: 'not_enabled',
    });
    const report = await reportAuthority.reconcileArbRequestForReportInSql({
      coadminUid: TEST_COADMIN_UID,
      requestId: seeded.requestId,
    });
    assert.strictEqual(report.requestId, seeded.requestId);
    assert.ok(Array.isArray(report.evaluations));
    assert.ok(report.evaluations.length >= 1);
  });

  await test('player inspect is read-only shape', async () => {
    const inspection = await reportAuthority.inspectArbPlayerInSql({
      coadminUid: TEST_COADMIN_UID,
      playerUid: TEST_PLAYER_UID,
      sampleRechargeAmount: 50,
    });
    assert.strictEqual(inspection.readOnly, true);
    assert.ok(inspection.currentMode);
    assert.ok(inspection.eligibility);
    assert.ok('calculatedBonus' in inspection);
  });

  const healthAuthority = Module._load(
    path.join(ROOT, 'lib/sql/authorityAutomaticBonusHealth.ts'),
    module,
    false
  );

  await test('system health snapshot is read-only', async () => {
    const health = await healthAuthority.loadArbSystemHealthInSql({
      coadminUid: TEST_COADMIN_UID,
      windowHours: 24,
    });
    assert.strictEqual(health.coadminUid, TEST_COADMIN_UID);
    assert.ok(health.featureStatus);
    assert.ok(health.grantPipelineFreeze.soleWriterExport);
    assert.ok(health.configurationHealth);
    assert.ok(typeof health.window.grants === 'number');
  });

  await cleanup(pool);
  await pool.end();
  console.log(`\n${passed} passed, ${failed} failed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
