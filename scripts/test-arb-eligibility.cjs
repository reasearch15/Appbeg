/**
 * Automatic Recharge Bonus — authoritative eligibility helper tests.
 * Run: npm run test:arb-eligibility
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

const elig = loadTs('eligibility.ts');
const NOW = Date.parse('2026-06-01T12:00:00.000Z');

const openGates = {
  playerModeEnabled: true,
  globalKillActive: false,
  featureEnabled: true,
  emergencyDisable: false,
  playerOptInAllowed: true,
  riskBlocked: false,
  hasPublishedConfiguration: true,
};

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

test('idle OFF: can claim, cannot receive, can enable', () => {
  const d = elig.evaluateArbEligibility({
    preference: {
      automaticBonusEnabled: false,
      bonusCooldownEndsAt: null,
      updatedAt: null,
    },
    nowMs: NOW,
    gates: openGates,
    grantsEnabled: true,
  });
  assert.strictEqual(d.currentMode, 'disabled');
  assert.strictEqual(d.canEnable, true);
  assert.strictEqual(d.canDisable, false);
  assert.strictEqual(d.canClaimBonusEvent, true);
  assert.strictEqual(d.canReceiveAutoBonus, false);
  assert.ok(d.blockers.receiveAutoBonus.includes('not_enabled'));
  assert.ok(d.blockers.disable.includes('already_disabled'));
});

test('Auto ON: cannot claim, can receive when grants on, can disable', () => {
  const d = elig.evaluateArbEligibility({
    preference: {
      automaticBonusEnabled: true,
      bonusCooldownEndsAt: null,
      updatedAt: null,
    },
    nowMs: NOW,
    gates: openGates,
    grantsEnabled: true,
  });
  assert.strictEqual(d.currentMode, 'enabled');
  assert.strictEqual(d.canClaimBonusEvent, false);
  assert.ok(d.blockers.claimBonusEvent.includes('auto_bonus_enabled'));
  assert.strictEqual(d.canReceiveAutoBonus, true);
  assert.strictEqual(d.canDisable, true);
  assert.strictEqual(d.canEnable, true);
});

test('cooldown: cannot claim, cannot receive', () => {
  const d = elig.evaluateArbEligibility({
    preference: {
      automaticBonusEnabled: false,
      bonusCooldownEndsAt: new Date(NOW + 60_000).toISOString(),
      updatedAt: null,
    },
    nowMs: NOW,
    gates: openGates,
    grantsEnabled: true,
  });
  assert.strictEqual(d.currentMode, 'cooldown');
  assert.strictEqual(d.canClaimBonusEvent, false);
  assert.ok(d.blockers.claimBonusEvent.includes('auto_bonus_cooldown'));
  assert.strictEqual(d.canReceiveAutoBonus, false);
});

test('risk blocks claim and receive', () => {
  const d = elig.evaluateArbEligibility({
    preference: {
      automaticBonusEnabled: true,
      bonusCooldownEndsAt: null,
      updatedAt: null,
    },
    nowMs: NOW,
    gates: { ...openGates, riskBlocked: true },
    grantsEnabled: true,
  });
  assert.strictEqual(d.canClaimBonusEvent, false);
  assert.ok(d.blockers.claimBonusEvent.includes('risk_blocked'));
  assert.strictEqual(d.canReceiveAutoBonus, false);
  assert.ok(d.blockers.receiveAutoBonus.includes('risk_blocked'));
  assert.strictEqual(d.canEnable, false);
});

test('grants_disabled blocks receive even when enabled', () => {
  const d = elig.evaluateArbEligibility({
    preference: {
      automaticBonusEnabled: true,
      bonusCooldownEndsAt: null,
      updatedAt: null,
    },
    nowMs: NOW,
    gates: openGates,
    grantsEnabled: false,
  });
  assert.strictEqual(d.canReceiveAutoBonus, false);
  assert.ok(d.blockers.receiveAutoBonus.includes('grants_disabled'));
  assert.strictEqual(d.canClaimBonusEvent, false);
});

test('assertArbCanClaimBonusEvent throws stable codes', () => {
  const d = elig.evaluateArbEligibility({
    preference: {
      automaticBonusEnabled: true,
      bonusCooldownEndsAt: null,
      updatedAt: null,
    },
    nowMs: NOW,
    gates: openGates,
    grantsEnabled: false,
  });
  let threw = false;
  try {
    elig.assertArbCanClaimBonusEvent(d);
  } catch (error) {
    threw = true;
    assert.strictEqual(error.code, 'auto_bonus_enabled');
    assert.ok(Array.isArray(error.blockers));
  }
  assert.strictEqual(threw, true);
});

test('preference truth locks claims even with operational gates closed', () => {
  const d = elig.evaluateArbEligibility({
    preference: {
      automaticBonusEnabled: false,
      bonusCooldownEndsAt: new Date(NOW + 120_000).toISOString(),
      updatedAt: null,
    },
    nowMs: NOW,
    gates: {
      ...openGates,
      playerModeEnabled: false,
      featureEnabled: false,
    },
    grantsEnabled: false,
  });
  assert.strictEqual(d.canClaimBonusEvent, false);
  assert.ok(d.blockers.claimBonusEvent.includes('auto_bonus_cooldown'));
});

console.log(`\n${passed} passed, ${failed} failed`);
