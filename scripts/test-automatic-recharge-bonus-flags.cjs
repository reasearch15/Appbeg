/**
 * Unit tests for Automatic Recharge Bonus platform flags (Phase 1).
 * Run: npm run test:arb-flags
 *
 * Fail-closed: financial flags stay OFF unless explicitly "1".
 * ARB_SCHEMA_READY must not exist / must not default open.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');

function loadFlagsModule() {
  const abs = path.join(ROOT, 'lib/server/automaticRechargeBonusFlags.ts');
  const source = fs
    .readFileSync(abs, 'utf8')
    .replace(/import\s+['"]server-only['"];?\s*/g, '');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: abs,
  });
  const Module = module.constructor;
  const modulePath = abs + '.cjs-test-cache.js';
  const m = new Module(modulePath, module);
  m.filename = modulePath;
  m.paths = Module._nodeModulePaths(path.dirname(modulePath));
  m._compile(outputText, modulePath);
  return m.exports;
}

const FLAG_KEYS = [
  'ARB_SCHEMA_READY',
  'ARB_ADMIN_ENABLED',
  'ARB_GRANTS_ENABLED',
  'ARB_PLAYER_MODE_ENABLED',
  'ARB_REPORTING_ENABLED',
  'ARB_GLOBAL_KILL',
  'ARB_SHADOW_MODE_ENABLED',
];

const saved = {};
for (const key of FLAG_KEYS) {
  saved[key] = process.env[key];
  delete process.env[key];
}

let passed = 0;
function test(name, fn) {
  try {
    for (const key of FLAG_KEYS) {
      delete process.env[key];
    }
    const mod = loadFlagsModule();
    fn(mod);
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`fail - ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}

test('ARB_SCHEMA_READY helper is removed (fail closed — no soft ready flag)', (mod) => {
  assert.strictEqual(typeof mod.isArbSchemaReady, 'undefined');
  assert.strictEqual('schema_ready' in mod.getAutomaticRechargeBonusFlagStatus(), false);
});

test('defaults: all runtime flags are OFF when unset', (mod) => {
  const status = mod.getAutomaticRechargeBonusFlagStatus();
  assert.strictEqual(status.admin_enabled, false);
  assert.strictEqual(status.grants_enabled, false);
  assert.strictEqual(status.player_mode_enabled, false);
  assert.strictEqual(status.reporting_enabled, false);
  assert.strictEqual(status.global_kill_active, false);
  assert.strictEqual(status.shadow_mode_enabled, false);
  assert.strictEqual(status.unsafe_player_mode_without_grants, false);
});

test('explicit 1 enables each opt-in flag', () => {
  process.env.ARB_ADMIN_ENABLED = '1';
  process.env.ARB_GRANTS_ENABLED = '1';
  process.env.ARB_PLAYER_MODE_ENABLED = '1';
  process.env.ARB_REPORTING_ENABLED = '1';
  process.env.ARB_GLOBAL_KILL = '1';
  process.env.ARB_SHADOW_MODE_ENABLED = '1';
  const fresh = loadFlagsModule();
  const status = fresh.getAutomaticRechargeBonusFlagStatus();
  assert.strictEqual(status.admin_enabled, true);
  assert.strictEqual(status.grants_enabled, true);
  assert.strictEqual(status.player_mode_enabled, true);
  assert.strictEqual(status.reporting_enabled, true);
  assert.strictEqual(status.global_kill_active, true);
  assert.strictEqual(status.shadow_mode_enabled, true);
  assert.strictEqual(status.unsafe_player_mode_without_grants, false);
});

test('explicit 0 and non-1 values do not enable flags', () => {
  process.env.ARB_ADMIN_ENABLED = '0';
  process.env.ARB_GRANTS_ENABLED = 'true';
  process.env.ARB_PLAYER_MODE_ENABLED = 'yes';
  const fresh = loadFlagsModule();
  assert.strictEqual(fresh.isArbAdminEnabled(), false);
  assert.strictEqual(fresh.isArbGrantsEnabled(), false);
  assert.strictEqual(fresh.isArbPlayerModeEnabled(), false);
});

test('unsafe_player_mode_without_grants detects player mode without grants', () => {
  process.env.ARB_PLAYER_MODE_ENABLED = '1';
  delete process.env.ARB_GRANTS_ENABLED;
  const fresh = loadFlagsModule();
  const status = fresh.getAutomaticRechargeBonusFlagStatus();
  assert.strictEqual(status.unsafe_player_mode_without_grants, true);
});

test('ARB_SQL_TABLES includes evaluations foundation table', (mod) => {
  assert.deepStrictEqual([...mod.ARB_SQL_TABLES], [
    'coadmin_automatic_recharge_bonus_settings',
    'coadmin_automatic_recharge_bonus_config_versions',
    'coadmin_automatic_recharge_bonus_settings_audit',
    'automatic_recharge_bonus_evaluations',
  ]);
});

for (const key of FLAG_KEYS) {
  if (saved[key] === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = saved[key];
  }
}

if (!process.exitCode) {
  console.log(`\n${passed} tests passed`);
}
