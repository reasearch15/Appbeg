/**
 * Immutable resolver golden fixtures (Phase 3).
 * Run: npm run test:arb-golden
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const DOMAIN_DIR = path.join(ROOT, 'lib/economy/automaticRechargeBonus');
const FIXTURE = path.join(DOMAIN_DIR, 'fixtures/resolverGolden.json');
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

const resolve = loadTs('resolve.ts');
const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

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

test('fixture file is present and versioned', () => {
  assert.strictEqual(fixture.fixtureVersion, 1);
  assert.ok(Array.isArray(fixture.cases));
  assert.ok(fixture.cases.length >= 5);
});

for (const testCase of fixture.cases) {
  test(`golden:${testCase.id}`, () => {
    for (const expectation of testCase.expectations) {
      const result = resolve.resolveAutomaticRechargeBonus({
        rechargeAmount: expectation.rechargeAmount,
        configuration: testCase.configuration,
      });
      assert.strictEqual(
        result.eligible,
        expectation.eligible,
        `${testCase.id} amount=${expectation.rechargeAmount} eligible`
      );
      assert.strictEqual(
        result.bonusCoins,
        expectation.bonusCoins,
        `${testCase.id} amount=${expectation.rechargeAmount} bonusCoins`
      );
      assert.strictEqual(
        result.skipReason,
        expectation.skipReason,
        `${testCase.id} amount=${expectation.rechargeAmount} skipReason`
      );
      assert.strictEqual(
        result.tier?.id ?? null,
        expectation.tierId,
        `${testCase.id} amount=${expectation.rechargeAmount} tierId`
      );
      if (Object.prototype.hasOwnProperty.call(expectation, 'uncappedBonusCoins')) {
        assert.strictEqual(
          result.uncappedBonusCoins,
          expectation.uncappedBonusCoins,
          `${testCase.id} uncappedBonusCoins`
        );
      }
      if (Object.prototype.hasOwnProperty.call(expectation, 'appliedCap')) {
        assert.strictEqual(
          result.appliedCap,
          expectation.appliedCap,
          `${testCase.id} appliedCap`
        );
      }
    }
  });
}

test('linear case covers required boundary amounts', () => {
  const linear = fixture.cases.find((c) => c.id === 'linear_default_bands');
  assert.ok(linear);
  const amounts = new Set(linear.expectations.map((e) => e.rechargeAmount));
  for (const amount of fixture.amountsAlwaysCovered) {
    assert.ok(amounts.has(amount), `missing amount ${amount}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
