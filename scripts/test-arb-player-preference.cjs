/**
 * Automatic Recharge Bonus — Phase 4 player preference state machine tests.
 * Run: npm run test:arb-preference
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const DOMAIN_DIR = path.join(ROOT, 'lib/economy/automaticRechargeBonus');
const ALIAS_PREFIX = '@/lib/economy/automaticRechargeBonus/';

const loaded = new Map();

function loadTs(fileName) {
  const abs = path.join(DOMAIN_DIR, fileName);
  if (loaded.has(abs)) return loaded.get(abs);
  const source = fs.readFileSync(abs, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: abs,
  });
  const moduleObj = { exports: {} };
  const localRequire = (id) => {
    if (id === 'crypto') return require('crypto');
    if (id.startsWith(ALIAS_PREFIX)) {
      const sub = id.slice(ALIAS_PREFIX.length);
      return loadTs(sub.endsWith('.ts') ? sub : `${sub}.ts`);
    }
    return require(id);
  };
  const run = new Function(
    'exports',
    'require',
    'module',
    '__filename',
    '__dirname',
    outputText
  );
  run(moduleObj.exports, localRequire, moduleObj, abs, DOMAIN_DIR);
  loaded.set(abs, moduleObj.exports);
  return moduleObj.exports;
}

const pref = loadTs('playerPreference.ts');
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`fail - ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}

const NOW = Date.parse('2026-06-01T12:00:00.000Z');

test('default preference is disabled with no cooldown', () => {
  const state = pref.defaultArbPlayerPreferenceState();
  assert.strictEqual(state.automaticBonusEnabled, false);
  assert.strictEqual(state.bonusCooldownEndsAt, null);
  assert.strictEqual(pref.resolveArbPlayerBonusMode(state, NOW), 'disabled');
});

test('parse clears cooldown while enabled (invariant)', () => {
  const state = pref.parseArbPlayerPreferenceState({
    automaticBonusEnabled: true,
    bonusCooldownEndsAt: '2026-06-01T14:00:00.000Z',
  });
  assert.strictEqual(state.automaticBonusEnabled, true);
  assert.strictEqual(state.bonusCooldownEndsAt, null);
});

test('ON → OFF starts cooldown', () => {
  const planned = pref.planArbPlayerPreferenceToggle({
    current: {
      automaticBonusEnabled: true,
      bonusCooldownEndsAt: null,
      updatedAt: null,
    },
    requestedEnabled: false,
    nowMs: NOW,
    cooldownDurationMinutes: 120,
  });
  assert.strictEqual(planned.changed, true);
  assert.strictEqual(planned.transition, 'on_to_off');
  assert.strictEqual(planned.startedCooldown, true);
  assert.strictEqual(planned.next.automaticBonusEnabled, false);
  assert.strictEqual(
    planned.next.bonusCooldownEndsAt,
    new Date(NOW + 120 * 60_000).toISOString()
  );
  assert.strictEqual(
    pref.resolveArbPlayerBonusMode(planned.next, NOW),
    'cooldown'
  );
});

test('OFF → ON cancels cooldown', () => {
  const planned = pref.planArbPlayerPreferenceToggle({
    current: {
      automaticBonusEnabled: false,
      bonusCooldownEndsAt: new Date(NOW + 60_000).toISOString(),
      updatedAt: null,
    },
    requestedEnabled: true,
    nowMs: NOW,
    cooldownDurationMinutes: 120,
  });
  assert.strictEqual(planned.changed, true);
  assert.strictEqual(planned.transition, 'off_to_on');
  assert.strictEqual(planned.cancelledCooldown, true);
  assert.strictEqual(planned.next.automaticBonusEnabled, true);
  assert.strictEqual(planned.next.bonusCooldownEndsAt, null);
  assert.strictEqual(pref.resolveArbPlayerBonusMode(planned.next, NOW), 'enabled');
});

test('duplicate enable / disable are no-ops', () => {
  const on = pref.planArbPlayerPreferenceToggle({
    current: {
      automaticBonusEnabled: true,
      bonusCooldownEndsAt: null,
      updatedAt: null,
    },
    requestedEnabled: true,
    nowMs: NOW,
    cooldownDurationMinutes: 120,
  });
  assert.strictEqual(on.changed, false);

  const off = pref.planArbPlayerPreferenceToggle({
    current: {
      automaticBonusEnabled: false,
      bonusCooldownEndsAt: new Date(NOW + 60_000).toISOString(),
      updatedAt: null,
    },
    requestedEnabled: false,
    nowMs: NOW,
    cooldownDurationMinutes: 120,
  });
  assert.strictEqual(off.changed, false);
  assert.ok(off.next.bonusCooldownEndsAt);
});

test('repeated toggles alternate cooldown start/cancel', () => {
  let state = {
    automaticBonusEnabled: false,
    bonusCooldownEndsAt: null,
    updatedAt: null,
  };
  const enable = pref.planArbPlayerPreferenceToggle({
    current: state,
    requestedEnabled: true,
    nowMs: NOW,
    cooldownDurationMinutes: 30,
  });
  state = enable.next;
  const disable = pref.planArbPlayerPreferenceToggle({
    current: state,
    requestedEnabled: false,
    nowMs: NOW + 1000,
    cooldownDurationMinutes: 30,
  });
  assert.strictEqual(disable.startedCooldown, true);
  state = disable.next;
  const enableAgain = pref.planArbPlayerPreferenceToggle({
    current: state,
    requestedEnabled: true,
    nowMs: NOW + 2000,
    cooldownDurationMinutes: 30,
  });
  assert.strictEqual(enableAgain.cancelledCooldown, true);
  assert.strictEqual(enableAgain.next.bonusCooldownEndsAt, null);
  const disableAgain = pref.planArbPlayerPreferenceToggle({
    current: enableAgain.next,
    requestedEnabled: false,
    nowMs: NOW + 3000,
    cooldownDurationMinutes: 30,
  });
  assert.strictEqual(disableAgain.startedCooldown, true);
  assert.notStrictEqual(
    disableAgain.next.bonusCooldownEndsAt,
    disable.next.bonusCooldownEndsAt
  );
});

test('cooldown never present while enabled after serialize', () => {
  const patch = pref.serializeArbPlayerPreferenceRawPatch({
    automaticBonusEnabled: true,
    bonusCooldownEndsAt: '2026-06-01T14:00:00.000Z',
    updatedAt: '2026-06-01T12:00:00.000Z',
  });
  assert.strictEqual(patch.automaticBonusEnabled, true);
  assert.strictEqual(patch.bonusCooldownEndsAt, null);
});

test('enable gates reject each blocker', () => {
  const base = {
    playerModeEnabled: true,
    globalKillActive: false,
    featureEnabled: true,
    emergencyDisable: false,
    playerOptInAllowed: true,
    riskBlocked: false,
    hasPublishedConfiguration: true,
  };
  assert.strictEqual(pref.evaluateArbPlayerEnableGates(base).available, true);

  const cases = [
    ['playerModeEnabled', false, 'player_mode_disabled'],
    ['globalKillActive', true, 'global_kill_active'],
    ['featureEnabled', false, 'feature_disabled'],
    ['emergencyDisable', true, 'emergency_disabled'],
    ['playerOptInAllowed', false, 'player_opt_in_disabled'],
    ['riskBlocked', true, 'risk_blocked'],
    ['hasPublishedConfiguration', false, 'no_published_configuration'],
  ];
  for (const [key, value, code] of cases) {
    const result = pref.evaluateArbPlayerEnableGates({ ...base, [key]: value });
    assert.strictEqual(result.available, false, code);
    assert.ok(result.blockers.includes(code), code);
  }
});

test('expired cooldown resolves to disabled mode', () => {
  const state = {
    automaticBonusEnabled: false,
    bonusCooldownEndsAt: new Date(NOW - 1000).toISOString(),
    updatedAt: null,
  };
  assert.strictEqual(pref.resolveArbPlayerBonusMode(state, NOW), 'disabled');
});

test('resolveCooldownDurationMinutes falls back to platform default', () => {
  assert.strictEqual(pref.resolveCooldownDurationMinutes(null), 120);
  assert.strictEqual(pref.resolveCooldownDurationMinutes(0), 120);
  assert.strictEqual(pref.resolveCooldownDurationMinutes(45), 45);
});

console.log(`\n${passed} passed, ${failed} failed`);
