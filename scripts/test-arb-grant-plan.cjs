/**
 * Automatic Recharge Bonus — Phase 6 grant/shadow planner tests.
 * Run: npm run test:arb-grant-plan
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

const grantPlan = loadTs('grantPlan.ts');
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

const published = {
  versionId: 'ver-1',
  versionNumber: 1,
  status: 'published',
  coadminUid: 'c1',
  publishedAt: '2026-01-01T00:00:00.000Z',
  publishedByUid: null,
  publishedByRole: null,
  supersedesVersionId: null,
  policy: {
    minimumRecharge: 10,
    maximumRechargeConsidered: null,
    maximumBonusCap: null,
    cooldownDurationMinutes: 120,
  },
  tiers: [
    {
      id: 't10',
      minAmount: 10,
      maxAmount: null,
      bonusCoins: 5,
      label: null,
      active: true,
    },
  ],
};

const enabledPref = {
  automaticBonusEnabled: true,
  bonusCooldownEndsAt: null,
  updatedAt: null,
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

test('flags off → noop', () => {
  const plan = grantPlan.planArbRechargeCompletionGrant({
    preference: enabledPref,
    gates: openGates,
    published,
    rechargeAmount: 20,
    nowMs: NOW,
    grantsEnabled: false,
    shadowModeEnabled: false,
  });
  assert.strictEqual(plan.run, false);
});

test('shadow eligible → would_grant, no finances', () => {
  const plan = grantPlan.planArbRechargeCompletionGrant({
    preference: enabledPref,
    gates: openGates,
    published,
    rechargeAmount: 20,
    nowMs: NOW,
    grantsEnabled: false,
    shadowModeEnabled: true,
  });
  assert.strictEqual(plan.run, true);
  assert.strictEqual(plan.mode, 'shadow');
  assert.strictEqual(plan.writeFinances, false);
  assert.strictEqual(plan.evaluationResult, 'would_grant');
  assert.strictEqual(plan.bonusCoins, 5);
  assert.strictEqual(plan.tierId, 't10');
  assert.strictEqual(plan.versionId, 'ver-1');
});

test('real grant eligible → granted + writeFinances', () => {
  const plan = grantPlan.planArbRechargeCompletionGrant({
    preference: enabledPref,
    gates: openGates,
    published,
    rechargeAmount: 20,
    nowMs: NOW,
    grantsEnabled: true,
    shadowModeEnabled: true,
  });
  assert.strictEqual(plan.mode, 'grant');
  assert.strictEqual(plan.writeFinances, true);
  assert.strictEqual(plan.evaluationResult, 'granted');
  assert.strictEqual(plan.bonusCoins, 5);
});

test('below minimum → skipped, no finances', () => {
  const plan = grantPlan.planArbRechargeCompletionGrant({
    preference: enabledPref,
    gates: openGates,
    published,
    rechargeAmount: 5,
    nowMs: NOW,
    grantsEnabled: true,
    shadowModeEnabled: false,
  });
  assert.strictEqual(plan.writeFinances, false);
  assert.strictEqual(plan.evaluationResult, 'skipped');
  assert.ok(plan.skipReason);
});

test('Auto OFF → not_enabled skip', () => {
  const plan = grantPlan.planArbRechargeCompletionGrant({
    preference: {
      automaticBonusEnabled: false,
      bonusCooldownEndsAt: null,
      updatedAt: null,
    },
    gates: openGates,
    published,
    rechargeAmount: 20,
    nowMs: NOW,
    grantsEnabled: true,
    shadowModeEnabled: false,
  });
  assert.strictEqual(plan.writeFinances, false);
  assert.ok(String(plan.skipReason).includes('not_enabled') || plan.skipReason === 'not_enabled');
});

test('cooldown → not_enabled', () => {
  const plan = grantPlan.planArbRechargeCompletionGrant({
    preference: {
      automaticBonusEnabled: false,
      bonusCooldownEndsAt: new Date(NOW + 60_000).toISOString(),
      updatedAt: null,
    },
    gates: openGates,
    published,
    rechargeAmount: 20,
    nowMs: NOW,
    grantsEnabled: true,
    shadowModeEnabled: true,
  });
  assert.strictEqual(plan.writeFinances, false);
  assert.strictEqual(plan.mode, 'grant');
  assert.notStrictEqual(plan.evaluationResult, 'would_grant');
  assert.notStrictEqual(plan.evaluationResult, 'granted');
});

test('emergency disable → blocked', () => {
  const plan = grantPlan.planArbRechargeCompletionGrant({
    preference: enabledPref,
    gates: { ...openGates, emergencyDisable: true },
    published,
    rechargeAmount: 20,
    nowMs: NOW,
    grantsEnabled: true,
    shadowModeEnabled: false,
  });
  assert.strictEqual(plan.evaluationResult, 'blocked');
  assert.strictEqual(plan.writeFinances, false);
});

test('risk block → blocked', () => {
  const plan = grantPlan.planArbRechargeCompletionGrant({
    preference: enabledPref,
    gates: { ...openGates, riskBlocked: true },
    published,
    rechargeAmount: 20,
    nowMs: NOW,
    grantsEnabled: true,
    shadowModeEnabled: false,
  });
  assert.strictEqual(plan.evaluationResult, 'blocked');
});

test('feature disabled → blocked', () => {
  const plan = grantPlan.planArbRechargeCompletionGrant({
    preference: enabledPref,
    gates: { ...openGates, featureEnabled: false },
    published,
    rechargeAmount: 20,
    nowMs: NOW,
    grantsEnabled: true,
    shadowModeEnabled: false,
  });
  assert.strictEqual(plan.evaluationResult, 'blocked');
});

console.log(`\n${passed} passed, ${failed} failed`);
