/**
 * PostgreSQL integration tests for ARB config authority (Phase 3).
 *
 * Requires:
 *   DATABASE_URL=... (or POSTGRES_URL)
 *   Optional: TEST_COADMIN_UID (default: arb-phase3-test-coadmin)
 *
 * Run:
 *   DATABASE_URL=... npm run test:arb-authority
 *
 * Uses the real Phase 2 SQL authority module via on-the-fly TypeScript transpile.
 * Cleans up rows for the test coadmin when ARB_TEST_KEEP_ROWS is not set to 1.
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
const TEST_COADMIN_UID = String(
  process.env.TEST_COADMIN_UID || 'arb-phase3-test-coadmin'
).trim();
const KEEP_ROWS = String(process.env.ARB_TEST_KEEP_ROWS || '').trim() === '1';

if (!databaseUrl) {
  console.error('DATABASE_URL (or POSTGRES_URL) is required for test:arb-authority.');
  process.exitCode = 1;
  process.exit();
}

process.env.DATABASE_URL = databaseUrl;

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
      jsx: ts.JsxEmit.ReactJSX,
    },
    fileName: absPath,
  }).outputText;
}

function resolveAlias(id) {
  if (id === 'server-only') return id;
  if (id.startsWith('@/')) {
    const rel = id.slice(2);
    const base = path.join(ROOT, rel);
    if (fs.existsSync(base)) return base;
    if (fs.existsSync(`${base}.ts`)) return `${base}.ts`;
    if (fs.existsSync(`${base}.tsx`)) return `${base}.tsx`;
    if (fs.existsSync(path.join(base, 'index.ts'))) {
      return path.join(base, 'index.ts');
    }
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
  if (request === 'server-only') {
    return {};
  }
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

const authorityPath = path.join(ROOT, 'lib/sql/authorityAutomaticBonusConfig.ts');
const authority = Module._load(authorityPath, module, false);

let passed = 0;
let failed = 0;

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

async function cleanup(pool) {
  if (KEEP_ROWS) return;
  await pool.query(
    `DELETE FROM public.coadmin_automatic_recharge_bonus_settings_audit WHERE coadmin_uid = $1`,
    [TEST_COADMIN_UID]
  );
  await pool.query(
    `DELETE FROM public.coadmin_automatic_recharge_bonus_config_versions WHERE coadmin_uid = $1`,
    [TEST_COADMIN_UID]
  );
  await pool.query(
    `DELETE FROM public.coadmin_automatic_recharge_bonus_settings WHERE coadmin_uid = $1`,
    [TEST_COADMIN_UID]
  );
  await pool.query(
    `DELETE FROM public.authority_operations WHERE user_uid = $1 AND operation_type = 'arb_config'`,
    [TEST_COADMIN_UID]
  );
}

async function main() {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: databaseUrl });

  const client = await pool.connect();
  try {
    await authority.assertArbFoundationTables(client);
  } finally {
    client.release();
  }

  await cleanup(pool);

  const actor = {
    actorUid: 'arb-phase3-actor',
    actorRole: 'coadmin',
  };

  let version1Id = '';
  let version2Id = '';

  await test('ensure settings creates default draft', async () => {
    const settings = await authority.ensureArbSettingsInSql({
      coadminUid: TEST_COADMIN_UID,
    });
    assert.strictEqual(settings.coadminUid, TEST_COADMIN_UID);
    assert.strictEqual(settings.operational.featureEnabled, false);
    assert.ok(settings.draft.tiers.length > 0);
    assert.strictEqual(settings.publishedVersionId, null);

    const row = await pool.query(
      `SELECT * FROM public.coadmin_automatic_recharge_bonus_settings WHERE coadmin_uid = $1`,
      [TEST_COADMIN_UID]
    );
    assert.strictEqual(row.rowCount, 1);
  });

  await test('modify draft persists policy and tiers', async () => {
    const draft = {
      policy: {
        minimumRecharge: 10,
        maximumRechargeConsidered: 500,
        maximumBonusCap: 25,
        cooldownDurationMinutes: 120,
      },
      tiers: [
        {
          id: 'a',
          minAmount: 10,
          maxAmount: 19,
          bonusCoins: 1,
          label: 'ten',
          active: true,
        },
        {
          id: 'b',
          minAmount: 20,
          maxAmount: null,
          bonusCoins: 2,
          label: 'open',
          active: true,
        },
      ],
    };
    const result = await authority.saveArbDraftInSql({
      coadminUid: TEST_COADMIN_UID,
      draft,
      ...actor,
      idempotencyKey: `itest-draft-1:${randomUUID()}`,
    });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.validation.ok, true);
    assert.strictEqual(result.settings.draft.policy.maximumBonusCap, 25);
    assert.strictEqual(result.settings.draft.tiers.length, 2);

    const row = await pool.query(
      `SELECT draft_policy, draft_tiers FROM public.coadmin_automatic_recharge_bonus_settings WHERE coadmin_uid = $1`,
      [TEST_COADMIN_UID]
    );
    assert.strictEqual(Number(row.rows[0].draft_policy.maximumBonusCap), 25);
    assert.strictEqual(row.rows[0].draft_tiers.length, 2);

    const audit = await pool.query(
      `SELECT action FROM public.coadmin_automatic_recharge_bonus_settings_audit WHERE coadmin_uid = $1 ORDER BY id DESC LIMIT 1`,
      [TEST_COADMIN_UID]
    );
    assert.strictEqual(audit.rows[0].action, 'draft_saved');
  });

  await test('validation failure rejects overlapping draft', async () => {
    let threw = false;
    try {
      await authority.saveArbDraftInSql({
        coadminUid: TEST_COADMIN_UID,
        draft: {
          policy: {
            minimumRecharge: 10,
            maximumRechargeConsidered: null,
            maximumBonusCap: null,
            cooldownDurationMinutes: 120,
          },
          tiers: [
            {
              id: 'x',
              minAmount: 10,
              maxAmount: 30,
              bonusCoins: 1,
              label: null,
              active: true,
            },
            {
              id: 'y',
              minAmount: 20,
              maxAmount: null,
              bonusCoins: 2,
              label: null,
              active: true,
            },
          ],
        },
        ...actor,
        requireValid: true,
        idempotencyKey: `itest-draft-bad:${randomUUID()}`,
      });
    } catch (error) {
      threw = true;
      assert.ok(error.validation);
      assert.ok(error.validation.errors.some((e) => e.code === 'tier_overlap'));
    }
    assert.strictEqual(threw, true);
  });

  await test('successful publish creates immutable version 1', async () => {
    // Ensure valid draft is current
    await authority.saveArbDraftInSql({
      coadminUid: TEST_COADMIN_UID,
      draft: {
        policy: {
          minimumRecharge: 10,
          maximumRechargeConsidered: null,
          maximumBonusCap: null,
          cooldownDurationMinutes: 120,
        },
        tiers: [
          {
            id: 'a',
            minAmount: 10,
            maxAmount: 19,
            bonusCoins: 1,
            label: null,
            active: true,
          },
          {
            id: 'b',
            minAmount: 20,
            maxAmount: null,
            bonusCoins: 2,
            label: null,
            active: true,
          },
        ],
      },
      ...actor,
      idempotencyKey: `itest-draft-prepublish:${randomUUID()}`,
    });

    const published = await authority.publishArbDraftInSql({
      coadminUid: TEST_COADMIN_UID,
      ...actor,
      acceptGapWarnings: true,
      idempotencyKey: `itest-publish-1:${randomUUID()}`,
    });
    assert.strictEqual(published.version.versionNumber, 1);
    assert.strictEqual(published.version.status, 'published');
    version1Id = published.version.versionId;

    const versions = await pool.query(
      `SELECT version_id, version_number, status, policy_json, tiers_json FROM public.coadmin_automatic_recharge_bonus_config_versions WHERE coadmin_uid = $1`,
      [TEST_COADMIN_UID]
    );
    assert.strictEqual(versions.rowCount, 1);
    assert.strictEqual(Number(versions.rows[0].version_number), 1);

    const settings = await pool.query(
      `SELECT published_version_id FROM public.coadmin_automatic_recharge_bonus_settings WHERE coadmin_uid = $1`,
      [TEST_COADMIN_UID]
    );
    assert.strictEqual(settings.rows[0].published_version_id, version1Id);

    const audit = await pool.query(
      `SELECT action, version_id FROM public.coadmin_automatic_recharge_bonus_settings_audit WHERE coadmin_uid = $1 AND action = 'tiers_published'`,
      [TEST_COADMIN_UID]
    );
    assert.ok(audit.rowCount >= 1);
  });

  await test('second publish increments version number and supersedes', async () => {
    await authority.saveArbDraftInSql({
      coadminUid: TEST_COADMIN_UID,
      draft: {
        policy: {
          minimumRecharge: 10,
          maximumRechargeConsidered: null,
          maximumBonusCap: 9,
          cooldownDurationMinutes: 120,
        },
        tiers: [
          {
            id: 'a',
            minAmount: 10,
            maxAmount: null,
            bonusCoins: 3,
            label: null,
            active: true,
          },
        ],
      },
      ...actor,
      idempotencyKey: `itest-draft-2:${randomUUID()}`,
    });

    const published = await authority.publishArbDraftInSql({
      coadminUid: TEST_COADMIN_UID,
      ...actor,
      acceptGapWarnings: true,
      idempotencyKey: `itest-publish-2:${randomUUID()}`,
    });
    assert.strictEqual(published.version.versionNumber, 2);
    version2Id = published.version.versionId;

    const v1 = await pool.query(
      `SELECT status, policy_json FROM public.coadmin_automatic_recharge_bonus_config_versions WHERE version_id = $1`,
      [version1Id]
    );
    assert.strictEqual(v1.rows[0].status, 'superseded');
    // Historical JSON never edited — v1 was published with maximumBonusCap null
    assert.strictEqual(v1.rows[0].policy_json.maximumBonusCap ?? null, null);

    const v2 = await pool.query(
      `SELECT status, version_number FROM public.coadmin_automatic_recharge_bonus_config_versions WHERE version_id = $1`,
      [version2Id]
    );
    assert.strictEqual(v2.rows[0].status, 'published');
    assert.strictEqual(Number(v2.rows[0].version_number), 2);
  });

  await test('rollback re-points without mutating historical JSON', async () => {
    const beforeV1 = await pool.query(
      `SELECT policy_json, tiers_json FROM public.coadmin_automatic_recharge_bonus_config_versions WHERE version_id = $1`,
      [version1Id]
    );
    const policyBefore = JSON.stringify(beforeV1.rows[0].policy_json);
    const tiersBefore = JSON.stringify(beforeV1.rows[0].tiers_json);

    const rolled = await authority.rollbackArbConfigInSql({
      coadminUid: TEST_COADMIN_UID,
      targetVersionId: version1Id,
      ...actor,
      loadDraftFromTarget: true,
      idempotencyKey: `itest-rollback-1:${randomUUID()}`,
    });
    assert.strictEqual(rolled.version.versionId, version1Id);
    assert.strictEqual(rolled.settings.publishedVersionId, version1Id);

    const afterV1 = await pool.query(
      `SELECT status, policy_json, tiers_json FROM public.coadmin_automatic_recharge_bonus_config_versions WHERE version_id = $1`,
      [version1Id]
    );
    assert.strictEqual(afterV1.rows[0].status, 'published');
    assert.strictEqual(JSON.stringify(afterV1.rows[0].policy_json), policyBefore);
    assert.strictEqual(JSON.stringify(afterV1.rows[0].tiers_json), tiersBefore);

    const afterV2 = await pool.query(
      `SELECT status FROM public.coadmin_automatic_recharge_bonus_config_versions WHERE version_id = $1`,
      [version2Id]
    );
    assert.strictEqual(afterV2.rows[0].status, 'superseded');

    const audit = await pool.query(
      `SELECT action FROM public.coadmin_automatic_recharge_bonus_settings_audit WHERE coadmin_uid = $1 AND action = 'config_rolled_back'`,
      [TEST_COADMIN_UID]
    );
    assert.ok(audit.rowCount >= 1);
  });

  await test('reset draft to defaults', async () => {
    const result = await authority.resetArbDraftToDefaultInSql({
      coadminUid: TEST_COADMIN_UID,
      ...actor,
      idempotencyKey: `itest-reset:${randomUUID()}`,
    });
    assert.strictEqual(result.success, true);
    assert.ok(result.settings.draft.tiers.length > 2);
    assert.strictEqual(result.settings.draft.policy.minimumRecharge, 10);

    const audit = await pool.query(
      `SELECT action FROM public.coadmin_automatic_recharge_bonus_settings_audit WHERE coadmin_uid = $1 AND action = 'reset_to_default'`,
      [TEST_COADMIN_UID]
    );
    assert.ok(audit.rowCount >= 1);
  });

  await test('operational state updates persist', async () => {
    // Feature enable should work now that a published version exists
    const settings = await authority.updateArbOperationalStateInSql({
      coadminUid: TEST_COADMIN_UID,
      operational: {
        featureEnabled: true,
        emergencyDisable: true,
        playerOptInAllowed: false,
      },
      ...actor,
      idempotencyKey: `itest-ops:${randomUUID()}`,
    });
    assert.strictEqual(settings.operational.featureEnabled, true);
    assert.strictEqual(settings.operational.emergencyDisable, true);
    assert.strictEqual(settings.operational.playerOptInAllowed, false);

    const row = await pool.query(
      `SELECT feature_enabled, emergency_disable, player_opt_in_allowed FROM public.coadmin_automatic_recharge_bonus_settings WHERE coadmin_uid = $1`,
      [TEST_COADMIN_UID]
    );
    assert.strictEqual(row.rows[0].feature_enabled, true);
    assert.strictEqual(row.rows[0].emergency_disable, true);
    assert.strictEqual(row.rows[0].player_opt_in_allowed, false);

    const audit = await pool.query(
      `SELECT action FROM public.coadmin_automatic_recharge_bonus_settings_audit WHERE coadmin_uid = $1 AND action = 'operational_updated'`,
      [TEST_COADMIN_UID]
    );
    assert.ok(audit.rowCount >= 1);
  });

  await test('audit list returns persisted rows', async () => {
    const entries = await authority.listArbSettingsAuditInSql({
      coadminUid: TEST_COADMIN_UID,
      limit: 50,
    });
    assert.ok(entries.length >= 4);
    const actions = new Set(entries.map((e) => e.action));
    assert.ok(actions.has('draft_saved'));
    assert.ok(actions.has('tiers_published'));
    assert.ok(actions.has('config_rolled_back'));
    assert.ok(actions.has('operational_updated'));
  });

  await cleanup(pool);
  await pool.end();

  console.log(`\n${passed} passed, ${failed} failed`);
  Module._resolveFilename = originalResolveFilename;
  Module._load = originalLoad;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
