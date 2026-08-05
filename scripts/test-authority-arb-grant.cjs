/**
 * PostgreSQL integration tests — ARB Phase 6 recharge-completion grants.
 *
 * Covers: eligible grant, below minimum, Auto OFF, cooldown, emergency disable,
 * risk block, duplicate completion, retry completion, rollback, Shadow Mode,
 * real grant, feature disabled.
 *
 * Requires:
 *   DATABASE_URL=... (or POSTGRES_URL)
 *   TEST_PLAYER_UID=...  (existing player in players_cache)
 *
 * Optional:
 *   TEST_COADMIN_UID=... (defaults from player coadmin_uid / created_by)
 *   ARB_TEST_KEEP_ROWS=1 to retain test rows
 *
 * Run:
 *   ARB_PLAYER_MODE_ENABLED=1 DATABASE_URL=... TEST_PLAYER_UID=... npm run test:arb-grant
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
const KEEP_ROWS = String(process.env.ARB_TEST_KEEP_ROWS || '').trim() === '1';

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
process.env.ARB_PLAYER_MODE_ENABLED = '1';
process.env.ARB_GLOBAL_KILL = process.env.ARB_GLOBAL_KILL || '0';

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
    // Prefer explicit files over directories (existsSync is true for both).
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

const configAuthority = Module._load(
  path.join(ROOT, 'lib/sql/authorityAutomaticBonusConfig.ts'),
  module,
  false
);
const grantAuthority = Module._load(
  path.join(ROOT, 'lib/sql/authorityAutomaticBonusGrant.ts'),
  module,
  false
);

let passed = 0;
let failed = 0;
let TEST_COADMIN_UID = String(process.env.TEST_COADMIN_UID || '').trim();
/** Request ids / FE ids created during this run for cleanup. */
const createdRequestIds = [];
const createdFeIds = [];
const createdEvalIds = [];

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

function setFlags({ grants = false, shadow = false, playerMode = true, kill = false } = {}) {
  process.env.ARB_GRANTS_ENABLED = grants ? '1' : '0';
  process.env.ARB_SHADOW_MODE_ENABLED = shadow ? '1' : '0';
  process.env.ARB_PLAYER_MODE_ENABLED = playerMode ? '1' : '0';
  process.env.ARB_GLOBAL_KILL = kill ? '1' : '0';
}

async function loadPlayer(pool) {
  const result = await pool.query(
    `
      SELECT uid, username, coin, cash, promo_locked_coins, coadmin_uid, created_by,
             raw_firestore_data
      FROM public.players_cache
      WHERE uid = $1 AND deleted_at IS NULL
    `,
    [TEST_PLAYER_UID]
  );
  if (!result.rows.length) throw new Error('TEST_PLAYER_UID not found');
  return result.rows[0];
}

async function setPlayerPreference(pool, { enabled, cooldownEndsAt = null }) {
  await pool.query(
    `
      UPDATE public.players_cache
      SET raw_firestore_data =
        jsonb_set(
          jsonb_set(
            COALESCE(raw_firestore_data, '{}'::jsonb),
            '{automaticBonusEnabled}',
            to_jsonb($2::boolean),
            true
          ),
          '{bonusCooldownEndsAt}',
          CASE WHEN $3::text IS NULL THEN 'null'::jsonb ELSE to_jsonb($3::text) END,
          true
        ),
        updated_at = now()
      WHERE uid = $1
    `,
    [TEST_PLAYER_UID, enabled, cooldownEndsAt]
  );
}

async function setBonusBlockedUntil(pool, untilIso) {
  await pool.query(
    `
      UPDATE public.user_balance_snapshots_cache
      SET bonus_blocked_until = $2::timestamptz
      WHERE firebase_id = $1 AND deleted_at IS NULL
    `,
    [TEST_PLAYER_UID, untilIso]
  );
  // Also stamp raw for grant reader fallback
  await pool.query(
    `
      UPDATE public.players_cache
      SET raw_firestore_data =
        CASE WHEN $2::text IS NULL THEN
          COALESCE(raw_firestore_data, '{}'::jsonb) - 'bonusBlockedUntil'
        ELSE
          jsonb_set(
            COALESCE(raw_firestore_data, '{}'::jsonb),
            '{bonusBlockedUntil}',
            to_jsonb($2::text),
            true
          )
        END
      WHERE uid = $1
    `,
    [TEST_PLAYER_UID, untilIso]
  );
}

async function countArbFe(pool, requestId) {
  const r = await pool.query(
    `
      SELECT COUNT(*)::int AS n, COALESCE(SUM(amount_npr), 0)::numeric AS total
      FROM public.financial_events_cache
      WHERE request_id = $1 AND type = 'automatic_recharge_bonus' AND deleted_at IS NULL
    `,
    [requestId]
  );
  return { n: r.rows[0].n, total: Number(r.rows[0].total) };
}

async function countEvals(pool, requestId, mode = null) {
  const r = await pool.query(
    mode
      ? `SELECT COUNT(*)::int AS n FROM public.automatic_recharge_bonus_evaluations
         WHERE request_id = $1 AND mode = $2`
      : `SELECT COUNT(*)::int AS n FROM public.automatic_recharge_bonus_evaluations
         WHERE request_id = $1`,
    mode ? [requestId, mode] : [requestId]
  );
  return r.rows[0].n;
}

async function latestEval(pool, requestId) {
  const r = await pool.query(
    `
      SELECT *
      FROM public.automatic_recharge_bonus_evaluations
      WHERE request_id = $1
      ORDER BY evaluated_at DESC
      LIMIT 1
    `,
    [requestId]
  );
  return r.rows[0] || null;
}

async function applyInTxn(pool, overrides = {}) {
  const player = await loadPlayer(pool);
  const requestId = overrides.requestId || `arb-grant-itest-${randomUUID()}`;
  createdRequestIds.push(requestId);
  const nowIso = new Date().toISOString();
  const client = await pool.connect();
  let result;
  try {
    await client.query('BEGIN');
    const playerLocked = await client.query(
      `
        SELECT uid, username, coin, cash, promo_locked_coins, coadmin_uid, created_by,
               raw_firestore_data,
               (
                 SELECT s.bonus_blocked_until
                 FROM public.user_balance_snapshots_cache s
                 WHERE s.firebase_id = p.uid AND s.deleted_at IS NULL
                 LIMIT 1
               ) AS bonus_blocked_until
        FROM public.players_cache p
        WHERE p.uid = $1 AND p.deleted_at IS NULL
        FOR UPDATE
      `,
      [TEST_PLAYER_UID]
    );
    const playerRow = playerLocked.rows[0];
    const requestRow = {
      raw_firestore_data: overrides.requestRaw || {},
    };
    result = await grantAuthority.applyArbOnRechargeCompleteInTxn(client, {
      playerUid: TEST_PLAYER_UID,
      playerRow,
      requestId,
      requestRow,
      rechargeAmount: overrides.rechargeAmount ?? 50,
      requestCoadminUid: TEST_COADMIN_UID,
      taskId: overrides.taskId || `arb-task-${randomUUID()}`,
      actorUid: 'arb-grant-itest-actor',
      actorRole: 'carer',
      nowIso,
      nowMs: overrides.nowMs ?? Date.now(),
    });
    if (result.evaluationId) createdEvalIds.push(result.evaluationId);
    if (result.financialEventId) createdFeIds.push(result.financialEventId);
    if (overrides.rollback) {
      await client.query('ROLLBACK');
    } else {
      await client.query('COMMIT');
    }
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      /* ignore */
    }
    throw error;
  } finally {
    client.release();
  }
  return { result, requestId, playerBefore: player };
}

async function setupPublishedConfig(pool) {
  const actor = {
    actorUid: 'arb-grant-itest-actor',
    actorRole: 'coadmin',
  };
  await configAuthority.ensureArbSettingsInSql({
    coadminUid: TEST_COADMIN_UID,
  });
  await configAuthority.saveArbDraftInSql({
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
          id: 'grant-t10',
          minAmount: 10,
          maxAmount: null,
          bonusCoins: 7,
          label: 'itest',
          active: true,
        },
      ],
    },
    ...actor,
    idempotencyKey: `arb-grant-itest-draft:${randomUUID()}`,
  });
  const published = await configAuthority.publishArbDraftInSql({
    coadminUid: TEST_COADMIN_UID,
    ...actor,
    acceptGapWarnings: true,
    idempotencyKey: `arb-grant-itest-publish:${randomUUID()}`,
  });
  await configAuthority.updateArbOperationalStateInSql({
    coadminUid: TEST_COADMIN_UID,
    operational: {
      featureEnabled: true,
      emergencyDisable: false,
      playerOptInAllowed: true,
    },
    ...actor,
    idempotencyKey: `arb-grant-itest-ops:${randomUUID()}`,
  });
  return published.version;
}

async function cleanup(pool, baseline) {
  if (KEEP_ROWS) return;
  if (createdRequestIds.length) {
    await pool.query(
      `DELETE FROM public.automatic_recharge_bonus_evaluations WHERE request_id = ANY($1::text[])`,
      [createdRequestIds]
    );
    await pool.query(
      `DELETE FROM public.financial_events_cache WHERE request_id = ANY($1::text[]) AND type = 'automatic_recharge_bonus'`,
      [createdRequestIds]
    );
    await pool.query(
      `DELETE FROM public.user_balance_events WHERE source_id = ANY($1::text[])`,
      [createdFeIds.length ? createdFeIds : ['__none__']]
    );
  }
  if (baseline) {
    await pool.query(
      `
        UPDATE public.players_cache
        SET coin = $2,
            promo_locked_coins = $3,
            raw_firestore_data = $4::jsonb,
            updated_at = now()
        WHERE uid = $1
      `,
      [
        TEST_PLAYER_UID,
        baseline.coin,
        baseline.promo_locked_coins,
        JSON.stringify(baseline.raw_firestore_data || {}),
      ]
    );
  }
  await setBonusBlockedUntil(pool, null);
  // Leave published config history, but keep feature fail-closed after tests.
  await pool.query(
    `
      UPDATE public.coadmin_automatic_recharge_bonus_settings
      SET feature_enabled = false,
          emergency_disable = false,
          updated_at = now()
      WHERE coadmin_uid = $1
    `,
    [TEST_COADMIN_UID]
  );
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

  const baseline = await loadPlayer(pool);
  TEST_COADMIN_UID =
    TEST_COADMIN_UID ||
    String(baseline.coadmin_uid || baseline.created_by || '').trim();
  if (!TEST_COADMIN_UID) {
    console.error('Could not resolve TEST_COADMIN_UID from player.');
    process.exitCode = 1;
    await pool.end();
    return;
  }

  const publishedVersion = await setupPublishedConfig(pool);
  await setPlayerPreference(pool, { enabled: true, cooldownEndsAt: null });
  await setBonusBlockedUntil(pool, null);

  // --- feature / flags off ---
  await test('feature flags off → noop (no eval, no FE)', async () => {
    setFlags({ grants: false, shadow: false });
    const { result, requestId } = await applyInTxn(pool, { rechargeAmount: 50 });
    assert.strictEqual(result.ran, false);
    assert.strictEqual(await countEvals(pool, requestId), 0);
    assert.strictEqual((await countArbFe(pool, requestId)).n, 0);
  });

  // --- Shadow Mode eligible ---
  await test('Shadow Mode eligible → would_grant, no finances', async () => {
    setFlags({ grants: false, shadow: true });
    const before = await loadPlayer(pool);
    const { result, requestId } = await applyInTxn(pool, { rechargeAmount: 50 });
    assert.strictEqual(result.ran, true);
    assert.strictEqual(result.mode, 'shadow');
    assert.strictEqual(result.writeFinances, false);
    assert.strictEqual(result.evaluationResult, 'would_grant');
    assert.strictEqual(result.bonusCoins, 0);
    const after = await loadPlayer(pool);
    assert.strictEqual(Number(after.coin), Number(before.coin));
    assert.strictEqual(
      Number(after.promo_locked_coins || 0),
      Number(before.promo_locked_coins || 0)
    );
    assert.strictEqual((await countArbFe(pool, requestId)).n, 0);
    const ev = await latestEval(pool, requestId);
    assert.ok(ev);
    assert.strictEqual(ev.mode, 'shadow');
    assert.strictEqual(ev.evaluation_result, 'would_grant');
    assert.strictEqual(Number(ev.bonus_calculated), 7);
    assert.strictEqual(ev.config_version_id, publishedVersion.versionId);
    assert.strictEqual(ev.tier_id, 'grant-t10');
  });

  // --- Real grant eligible ---
  await test('real grant eligible → coins + FE + ledger + eval', async () => {
    setFlags({ grants: true, shadow: true });
    const before = await loadPlayer(pool);
    const { result, requestId } = await applyInTxn(pool, { rechargeAmount: 50 });
    assert.strictEqual(result.ran, true);
    assert.strictEqual(result.mode, 'grant');
    assert.strictEqual(result.writeFinances, true);
    assert.strictEqual(result.evaluationResult, 'granted');
    assert.strictEqual(result.bonusCoins, 7);
    assert.strictEqual(result.requestRawPatch.automaticRechargeBonusApplied, true);
    const after = await loadPlayer(pool);
    assert.strictEqual(Number(after.coin), Number(before.coin) + 7);
    assert.strictEqual(
      Number(after.promo_locked_coins || 0),
      Number(before.promo_locked_coins || 0) + 7
    );
    const fe = await countArbFe(pool, requestId);
    assert.strictEqual(fe.n, 1);
    assert.strictEqual(fe.total, 7);
    const ev = await latestEval(pool, requestId);
    assert.strictEqual(ev.mode, 'grant');
    assert.strictEqual(ev.evaluation_result, 'granted');
    assert.strictEqual(ev.tier_id, 'grant-t10');
    assert.strictEqual(ev.config_version_id, publishedVersion.versionId);
    const ledger = await pool.query(
      `
        SELECT COUNT(*)::int AS n
        FROM public.user_balance_events
        WHERE source_id = $1
          AND event_type IN (
            'automatic_recharge_bonus_coin_credit',
            'automatic_recharge_bonus_promo_locked_credit'
          )
      `,
      [result.financialEventId]
    );
    assert.strictEqual(ledger.rows[0].n, 2);
  });

  // --- Duplicate completion ---
  await test('duplicate completion → no second financial write', async () => {
    setFlags({ grants: true, shadow: false });
    const requestId = `arb-grant-itest-dup-${randomUUID()}`;
    const first = await applyInTxn(pool, { requestId, rechargeAmount: 50 });
    assert.strictEqual(first.result.writeFinances, true);
    const coinAfterFirst = Number((await loadPlayer(pool)).coin);
    const second = await applyInTxn(pool, { requestId, rechargeAmount: 50 });
    assert.strictEqual(second.result.duplicate, true);
    assert.strictEqual(second.result.writeFinances, false);
    assert.strictEqual(Number((await loadPlayer(pool)).coin), coinAfterFirst);
    assert.strictEqual((await countArbFe(pool, requestId)).n, 1);
    assert.strictEqual(await countEvals(pool, requestId, 'grant'), 1);
  });

  // --- Retry via request raw stamp ---
  await test('retry with applied stamp → duplicate, no FE', async () => {
    setFlags({ grants: true, shadow: false });
    const before = await loadPlayer(pool);
    const { result, requestId } = await applyInTxn(pool, {
      rechargeAmount: 50,
      requestRaw: { automaticRechargeBonusApplied: true },
    });
    assert.strictEqual(result.duplicate, true);
    assert.strictEqual((await countArbFe(pool, requestId)).n, 0);
    assert.strictEqual(Number((await loadPlayer(pool)).coin), Number(before.coin));
  });

  // --- Below minimum ---
  await test('below minimum → skipped, no finances', async () => {
    setFlags({ grants: true, shadow: false });
    await setPlayerPreference(pool, { enabled: true });
    const before = await loadPlayer(pool);
    const { result, requestId } = await applyInTxn(pool, { rechargeAmount: 5 });
    assert.strictEqual(result.writeFinances, false);
    assert.strictEqual(result.evaluationResult, 'skipped');
    assert.strictEqual(Number((await loadPlayer(pool)).coin), Number(before.coin));
    assert.strictEqual((await countArbFe(pool, requestId)).n, 0);
    const ev = await latestEval(pool, requestId);
    assert.strictEqual(ev.evaluation_result, 'skipped');
  });

  // --- Auto OFF ---
  await test('Auto OFF → skipped not_enabled, no finances', async () => {
    setFlags({ grants: true, shadow: false });
    await setPlayerPreference(pool, { enabled: false, cooldownEndsAt: null });
    const before = await loadPlayer(pool);
    const { result, requestId } = await applyInTxn(pool, { rechargeAmount: 50 });
    assert.strictEqual(result.writeFinances, false);
    assert.ok(
      result.skipReason === 'not_enabled' ||
        String(result.skipReason || '').includes('not_enabled')
    );
    assert.strictEqual(Number((await loadPlayer(pool)).coin), Number(before.coin));
    assert.strictEqual((await countArbFe(pool, requestId)).n, 0);
    await setPlayerPreference(pool, { enabled: true });
  });

  // --- Cooldown ---
  await test('cooldown → skipped, no finances', async () => {
    setFlags({ grants: true, shadow: true });
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await setPlayerPreference(pool, { enabled: false, cooldownEndsAt: future });
    const before = await loadPlayer(pool);
    const { result, requestId } = await applyInTxn(pool, { rechargeAmount: 50 });
    assert.strictEqual(result.writeFinances, false);
    assert.notStrictEqual(result.evaluationResult, 'granted');
    assert.notStrictEqual(result.evaluationResult, 'would_grant');
    assert.strictEqual(Number((await loadPlayer(pool)).coin), Number(before.coin));
    assert.strictEqual((await countArbFe(pool, requestId)).n, 0);
    await setPlayerPreference(pool, { enabled: true, cooldownEndsAt: null });
  });

  // --- Emergency disable ---
  await test('emergency disable → blocked, no finances', async () => {
    setFlags({ grants: true, shadow: false });
    await setPlayerPreference(pool, { enabled: true });
    await configAuthority.updateArbOperationalStateInSql({
      coadminUid: TEST_COADMIN_UID,
      operational: { emergencyDisable: true },
      actorUid: 'arb-grant-itest-actor',
      actorRole: 'coadmin',
      idempotencyKey: `arb-grant-itest-emerg:${randomUUID()}`,
    });
    const before = await loadPlayer(pool);
    const { result, requestId } = await applyInTxn(pool, { rechargeAmount: 50 });
    assert.strictEqual(result.writeFinances, false);
    assert.strictEqual(result.evaluationResult, 'blocked');
    assert.strictEqual(Number((await loadPlayer(pool)).coin), Number(before.coin));
    assert.strictEqual((await countArbFe(pool, requestId)).n, 0);
    await configAuthority.updateArbOperationalStateInSql({
      coadminUid: TEST_COADMIN_UID,
      operational: { emergencyDisable: false },
      actorUid: 'arb-grant-itest-actor',
      actorRole: 'coadmin',
      idempotencyKey: `arb-grant-itest-emerg-off:${randomUUID()}`,
    });
  });

  // --- Risk block ---
  await test('risk block → blocked, no finances', async () => {
    setFlags({ grants: true, shadow: false });
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await setBonusBlockedUntil(pool, future);
    const before = await loadPlayer(pool);
    const { result, requestId } = await applyInTxn(pool, { rechargeAmount: 50 });
    assert.strictEqual(result.writeFinances, false);
    assert.strictEqual(result.evaluationResult, 'blocked');
    assert.strictEqual(Number((await loadPlayer(pool)).coin), Number(before.coin));
    assert.strictEqual((await countArbFe(pool, requestId)).n, 0);
    await setBonusBlockedUntil(pool, null);
  });

  // --- Feature disabled ---
  await test('feature disabled → blocked, no finances', async () => {
    setFlags({ grants: true, shadow: false });
    await configAuthority.updateArbOperationalStateInSql({
      coadminUid: TEST_COADMIN_UID,
      operational: { featureEnabled: false },
      actorUid: 'arb-grant-itest-actor',
      actorRole: 'coadmin',
      idempotencyKey: `arb-grant-itest-feat-off:${randomUUID()}`,
    });
    const before = await loadPlayer(pool);
    const { result, requestId } = await applyInTxn(pool, { rechargeAmount: 50 });
    assert.strictEqual(result.writeFinances, false);
    assert.strictEqual(result.evaluationResult, 'blocked');
    assert.strictEqual(Number((await loadPlayer(pool)).coin), Number(before.coin));
    assert.strictEqual((await countArbFe(pool, requestId)).n, 0);
    await configAuthority.updateArbOperationalStateInSql({
      coadminUid: TEST_COADMIN_UID,
      operational: { featureEnabled: true },
      actorUid: 'arb-grant-itest-actor',
      actorRole: 'coadmin',
      idempotencyKey: `arb-grant-itest-feat-on:${randomUUID()}`,
    });
  });

  // --- Rollback transaction ---
  await test('rollback transaction → no persistent grant side effects', async () => {
    setFlags({ grants: true, shadow: false });
    await setPlayerPreference(pool, { enabled: true });
    const before = await loadPlayer(pool);
    const { result, requestId } = await applyInTxn(pool, {
      rechargeAmount: 50,
      rollback: true,
    });
    assert.strictEqual(result.writeFinances, true);
    const after = await loadPlayer(pool);
    assert.strictEqual(Number(after.coin), Number(before.coin));
    assert.strictEqual(
      Number(after.promo_locked_coins || 0),
      Number(before.promo_locked_coins || 0)
    );
    assert.strictEqual((await countArbFe(pool, requestId)).n, 0);
    assert.strictEqual(await countEvals(pool, requestId), 0);
  });

  await cleanup(pool, baseline);
  await pool.end();

  console.log(`\n${passed} passed, ${failed} failed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
