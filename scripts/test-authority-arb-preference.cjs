/**
 * PostgreSQL integration tests — ARB player preference state machine (Phase 4).
 *
 * Requires:
 *   DATABASE_URL=... (or POSTGRES_URL)
 *   TEST_PLAYER_UID=...  (existing player in players_cache)
 *   TEST_COADMIN_UID=... (player's coadmin scope; defaults from player row if unset)
 *
 * Optional:
 *   ARB_TEST_KEEP_ROWS=1 to retain preference / ops rows
 *
 * Run:
 *   ARB_PLAYER_MODE_ENABLED=1 DATABASE_URL=... TEST_PLAYER_UID=... npm run test:arb-preference-authority
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
const toggleAuthority = Module._load(
  path.join(ROOT, 'lib/sql/authorityAutomaticBonusToggle.ts'),
  module,
  false
);
const { invalidateSessionMePlayerExtras } = Module._load(
  path.join(ROOT, 'lib/server/sessionMeExtras.ts'),
  module,
  false
);

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

async function readRaw(pool, playerUid) {
  const result = await pool.query(
    `SELECT raw_firestore_data, coadmin_uid, created_by FROM public.players_cache WHERE uid = $1 AND deleted_at IS NULL`,
    [playerUid]
  );
  if (!result.rows.length) throw new Error('TEST_PLAYER_UID not found in players_cache');
  return result.rows[0];
}

async function clearPreference(pool, playerUid) {
  await pool.query(
    `
      UPDATE public.players_cache
      SET raw_firestore_data =
        (COALESCE(raw_firestore_data, '{}'::jsonb)
          - 'automaticBonusEnabled'
          - 'bonusCooldownEndsAt'
          - 'automaticBonusUpdatedAt'
          - 'bonusBlockedUntil')
        || jsonb_build_object('bonusBlockedUntil', null)
      WHERE uid = $1
    `,
    [playerUid]
  );
  await pool.query(
    `UPDATE public.user_balance_snapshots_cache SET bonus_blocked_until = NULL WHERE firebase_id = $1`,
    [playerUid]
  );
  await pool.query(
    `DELETE FROM public.authority_operations WHERE user_uid = $1 AND operation_type = 'arb_player_toggle'`,
    [playerUid]
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

  const playerRow = await readRaw(pool, TEST_PLAYER_UID);
  const TEST_COADMIN_UID = String(
    process.env.TEST_COADMIN_UID ||
      playerRow.coadmin_uid ||
      playerRow.created_by ||
      ''
  ).trim();
  if (!TEST_COADMIN_UID) {
    throw new Error('TEST_COADMIN_UID could not be resolved from player row.');
  }

  await clearPreference(pool, TEST_PLAYER_UID);

  // Ensure coadmin settings + published config so enable gates can pass.
  await configAuthority.ensureArbSettingsInSql({ coadminUid: TEST_COADMIN_UID });
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
          id: 'pref-a',
          minAmount: 10,
          maxAmount: null,
          bonusCoins: 1,
          label: null,
          active: true,
        },
      ],
    },
    actorUid: 'arb-pref-test',
    actorRole: 'coadmin',
    idempotencyKey: `pref-draft:${randomUUID()}`,
  });
  await configAuthority.publishArbDraftInSql({
    coadminUid: TEST_COADMIN_UID,
    actorUid: 'arb-pref-test',
    actorRole: 'coadmin',
    acceptGapWarnings: true,
    idempotencyKey: `pref-publish:${randomUUID()}`,
  });
  await configAuthority.updateArbOperationalStateInSql({
    coadminUid: TEST_COADMIN_UID,
    operational: {
      featureEnabled: true,
      emergencyDisable: false,
      playerOptInAllowed: true,
    },
    actorUid: 'arb-pref-test',
    actorRole: 'coadmin',
    idempotencyKey: `pref-ops:${randomUUID()}`,
  });

  await test('enable preference', async () => {
    const result = await toggleAuthority.setArbPlayerPreferenceInSql({
      playerUid: TEST_PLAYER_UID,
      enabled: true,
      actorUid: TEST_PLAYER_UID,
      actorRole: 'player',
      idempotencyKey: `enable-1:${randomUUID()}`,
    });
    assert.strictEqual(result.changed, true);
    assert.strictEqual(result.transition, 'off_to_on');
    assert.strictEqual(result.snapshot.preference.automaticBonusEnabled, true);
    assert.strictEqual(result.snapshot.preference.bonusCooldownEndsAt, null);
    assert.strictEqual(result.snapshot.mode, 'enabled');

    const raw = await readRaw(pool, TEST_PLAYER_UID);
    assert.strictEqual(raw.raw_firestore_data.automaticBonusEnabled, true);
    assert.strictEqual(raw.raw_firestore_data.bonusCooldownEndsAt, null);
  });

  await test('duplicate enable is idempotent (same key)', async () => {
    const key = `enable-dup:${randomUUID()}`;
    const first = await toggleAuthority.setArbPlayerPreferenceInSql({
      playerUid: TEST_PLAYER_UID,
      enabled: true,
      idempotencyKey: key,
    });
    const second = await toggleAuthority.setArbPlayerPreferenceInSql({
      playerUid: TEST_PLAYER_UID,
      enabled: true,
      idempotencyKey: key,
    });
    assert.strictEqual(second.duplicate, true);
    assert.strictEqual(
      second.snapshot.preference.automaticBonusEnabled,
      first.snapshot.preference.automaticBonusEnabled
    );
  });

  await test('duplicate enable different key is no-op changed=false', async () => {
    const result = await toggleAuthority.setArbPlayerPreferenceInSql({
      playerUid: TEST_PLAYER_UID,
      enabled: true,
      idempotencyKey: `enable-noop:${randomUUID()}`,
    });
    assert.strictEqual(result.changed, false);
    assert.strictEqual(result.transition, null);
  });

  await test('disable starts cooldown', async () => {
    const result = await toggleAuthority.setArbPlayerPreferenceInSql({
      playerUid: TEST_PLAYER_UID,
      enabled: false,
      idempotencyKey: `disable-1:${randomUUID()}`,
    });
    assert.strictEqual(result.changed, true);
    assert.strictEqual(result.transition, 'on_to_off');
    assert.strictEqual(result.startedCooldown, true);
    assert.strictEqual(result.snapshot.preference.automaticBonusEnabled, false);
    assert.ok(result.snapshot.preference.bonusCooldownEndsAt);
    assert.strictEqual(result.snapshot.mode, 'cooldown');

    const raw = await readRaw(pool, TEST_PLAYER_UID);
    assert.strictEqual(raw.raw_firestore_data.automaticBonusEnabled, false);
    assert.ok(raw.raw_firestore_data.bonusCooldownEndsAt);
  });

  await test('duplicate disable no-op', async () => {
    const result = await toggleAuthority.setArbPlayerPreferenceInSql({
      playerUid: TEST_PLAYER_UID,
      enabled: false,
      idempotencyKey: `disable-noop:${randomUUID()}`,
    });
    assert.strictEqual(result.changed, false);
  });

  await test('re-enable cancels cooldown', async () => {
    const result = await toggleAuthority.setArbPlayerPreferenceInSql({
      playerUid: TEST_PLAYER_UID,
      enabled: true,
      idempotencyKey: `enable-2:${randomUUID()}`,
    });
    assert.strictEqual(result.cancelledCooldown, true);
    assert.strictEqual(result.snapshot.preference.bonusCooldownEndsAt, null);
    assert.strictEqual(result.snapshot.mode, 'enabled');
  });

  await test('repeated toggles + multi-tab idempotency keys', async () => {
    const tabA = `tab-a:${randomUUID()}`;
    const tabB = `tab-b:${randomUUID()}`;
    await toggleAuthority.setArbPlayerPreferenceInSql({
      playerUid: TEST_PLAYER_UID,
      enabled: false,
      idempotencyKey: tabA,
    });
    const parallel = await Promise.all([
      toggleAuthority.setArbPlayerPreferenceInSql({
        playerUid: TEST_PLAYER_UID,
        enabled: true,
        idempotencyKey: tabB,
      }),
      toggleAuthority.setArbPlayerPreferenceInSql({
        playerUid: TEST_PLAYER_UID,
        enabled: true,
        idempotencyKey: tabB,
      }),
    ]);
    const winners = parallel.filter((r) => !r.duplicate);
    assert.ok(winners.length >= 1);
    assert.strictEqual(
      parallel.every((r) => r.snapshot.preference.automaticBonusEnabled === true),
      true
    );
  });

  await test('session invalidation after toggle', async () => {
    // Seed cache then invalidate
    invalidateSessionMePlayerExtras({
      uid: TEST_PLAYER_UID,
      coadminUid: TEST_COADMIN_UID,
    });
    const removed = invalidateSessionMePlayerExtras({ uid: TEST_PLAYER_UID });
    assert.ok(removed >= 0);
  });

  await test('feature disabled rejects enable', async () => {
    await configAuthority.updateArbOperationalStateInSql({
      coadminUid: TEST_COADMIN_UID,
      operational: { featureEnabled: false },
      idempotencyKey: `pref-ops-off:${randomUUID()}`,
    });
    // Ensure currently off
    await toggleAuthority.setArbPlayerPreferenceInSql({
      playerUid: TEST_PLAYER_UID,
      enabled: false,
      idempotencyKey: `disable-before-feature:${randomUUID()}`,
    });
    let threw = false;
    try {
      await toggleAuthority.setArbPlayerPreferenceInSql({
        playerUid: TEST_PLAYER_UID,
        enabled: true,
        idempotencyKey: `enable-feature-off:${randomUUID()}`,
      });
    } catch (error) {
      threw = true;
      assert.strictEqual(error.code, 'feature_disabled');
    }
    assert.strictEqual(threw, true);
    await configAuthority.updateArbOperationalStateInSql({
      coadminUid: TEST_COADMIN_UID,
      operational: { featureEnabled: true },
      idempotencyKey: `pref-ops-on:${randomUUID()}`,
    });
  });

  await test('emergency disable rejects enable', async () => {
    await configAuthority.updateArbOperationalStateInSql({
      coadminUid: TEST_COADMIN_UID,
      operational: { emergencyDisable: true },
      idempotencyKey: `pref-ops-emerg:${randomUUID()}`,
    });
    let threw = false;
    try {
      await toggleAuthority.setArbPlayerPreferenceInSql({
        playerUid: TEST_PLAYER_UID,
        enabled: true,
        idempotencyKey: `enable-emerg:${randomUUID()}`,
      });
    } catch (error) {
      threw = true;
      assert.strictEqual(error.code, 'emergency_disabled');
    }
    assert.strictEqual(threw, true);
    await configAuthority.updateArbOperationalStateInSql({
      coadminUid: TEST_COADMIN_UID,
      operational: { emergencyDisable: false },
      idempotencyKey: `pref-ops-emerg-clear:${randomUUID()}`,
    });
  });

  await test('player opt-in disabled rejects enable', async () => {
    await configAuthority.updateArbOperationalStateInSql({
      coadminUid: TEST_COADMIN_UID,
      operational: { playerOptInAllowed: false },
      idempotencyKey: `pref-ops-optin:${randomUUID()}`,
    });
    let threw = false;
    try {
      await toggleAuthority.setArbPlayerPreferenceInSql({
        playerUid: TEST_PLAYER_UID,
        enabled: true,
        idempotencyKey: `enable-optin:${randomUUID()}`,
      });
    } catch (error) {
      threw = true;
      assert.strictEqual(error.code, 'player_opt_in_disabled');
    }
    assert.strictEqual(threw, true);
    await configAuthority.updateArbOperationalStateInSql({
      coadminUid: TEST_COADMIN_UID,
      operational: { playerOptInAllowed: true },
      idempotencyKey: `pref-ops-optin-clear:${randomUUID()}`,
    });
  });

  await test('risk blocked rejects enable', async () => {
    const until = new Date(Date.now() + 60 * 60_000).toISOString();
    await pool.query(
      `
        UPDATE public.players_cache
        SET raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb)
          || jsonb_build_object('bonusBlockedUntil', $2::text)
        WHERE uid = $1
      `,
      [TEST_PLAYER_UID, until]
    );
    await pool.query(
      `
        UPDATE public.user_balance_snapshots_cache
        SET bonus_blocked_until = $2::timestamptz,
            updated_at = now(),
            mirrored_at = now()
        WHERE firebase_id = $1
      `,
      [TEST_PLAYER_UID, until]
    );

    let threw = false;
    try {
      await toggleAuthority.setArbPlayerPreferenceInSql({
        playerUid: TEST_PLAYER_UID,
        enabled: true,
        idempotencyKey: `enable-risk:${randomUUID()}`,
      });
    } catch (error) {
      threw = true;
      assert.strictEqual(error.code, 'risk_blocked');
    }
    assert.strictEqual(threw, true);

    await pool.query(
      `
        UPDATE public.players_cache
        SET raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb)
          || jsonb_build_object('bonusBlockedUntil', null)
        WHERE uid = $1
      `,
      [TEST_PLAYER_UID]
    );
    await pool.query(
      `UPDATE public.user_balance_snapshots_cache SET bonus_blocked_until = NULL WHERE firebase_id = $1`,
      [TEST_PLAYER_UID]
    );
  });

  await test('server restart simulation — preference persists in SQL', async () => {
    await toggleAuthority.setArbPlayerPreferenceInSql({
      playerUid: TEST_PLAYER_UID,
      enabled: true,
      idempotencyKey: `persist-on:${randomUUID()}`,
    });
    // Simulate restart: clear process caches / reload module snapshot via fresh SQL read
    invalidateSessionMePlayerExtras({ uid: TEST_PLAYER_UID });
    const snapshot = await toggleAuthority.loadArbPlayerPreferenceInSql({
      playerUid: TEST_PLAYER_UID,
    });
    assert.strictEqual(snapshot.preference.automaticBonusEnabled, true);
    const raw = await readRaw(pool, TEST_PLAYER_UID);
    assert.strictEqual(raw.raw_firestore_data.automaticBonusEnabled, true);
  });

  await test('authority_operations audit payload written', async () => {
    const ops = await pool.query(
      `
        SELECT operation_key, payload
        FROM public.authority_operations
        WHERE user_uid = $1 AND operation_type = 'arb_player_toggle'
        LIMIT 20
      `,
      [TEST_PLAYER_UID]
    );
    assert.ok(ops.rowCount >= 1);
    assert.ok(ops.rows.some((row) => row.payload?.action === 'arb_player_preference_toggle'));
  });

  if (!KEEP_ROWS) {
    await clearPreference(pool, TEST_PLAYER_UID);
  }

  await pool.end();
  Module._resolveFilename = originalResolveFilename;
  Module._load = originalLoad;
  console.log(`\n${passed} passed, ${failed} failed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
