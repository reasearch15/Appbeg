/**
 * Automatic Recharge Bonus — Phase 2 domain engine tests.
 * Run: npm run test:arb-domain
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
    if (id === '@/lib/economy/automaticRechargeBonus') {
      return loadTs('index.ts');
    }
    if (id.startsWith(ALIAS_PREFIX)) {
      const sub = id.slice(ALIAS_PREFIX.length);
      const file = sub.endsWith('.ts') ? sub : `${sub}.ts`;
      return loadTs(file);
    }
    return require(id);
  };

  // Prefer Function runner over Module._compile — Node 24 + TS CJS export
  // preamble can leave some export bindings undefined under _compile.
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

// Load leaves before barrels to keep exports complete.
loadTs('types.ts');
loadTs('constants.ts');
const parse = loadTs('parse.ts');
const normalize = loadTs('normalize.ts');
const validate = loadTs('validate.ts');
const resolve = loadTs('resolve.ts');
const defaults = loadTs('defaults.ts');
const publishPlan = loadTs('publishPlan.ts');

const domain = {
  ...parse,
  ...normalize,
  ...validate,
  ...resolve,
  ...defaults,
  ...publishPlan,
  ...loadTs('constants.ts'),
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

function seqId() {
  let n = 0;
  return () => {
    n += 1;
    return `tier-${n}`;
  };
}

function samplePublished(overrides = {}) {
  const draft = domain.buildDefaultArbDraftConfiguration({
    createId: seqId(),
    minimumRecharge: 10,
    openEndedMin: 50,
  });
  return {
    versionId: 'ver-1',
    versionNumber: 1,
    status: 'published',
    coadminUid: 'coadmin-a',
    publishedAt: '2026-01-01T00:00:00.000Z',
    publishedByUid: 'actor-1',
    publishedByRole: 'coadmin',
    supersedesVersionId: null,
    policy: draft.policy,
    tiers: draft.tiers,
    ...overrides,
  };
}

test('default linear tiers: 10-19→1 … open-ended at 200', () => {
  const tiers = domain.buildDefaultLinearArbTiers({ createId: seqId() });
  assert.strictEqual(tiers[0].minAmount, 10);
  assert.strictEqual(tiers[0].maxAmount, 19);
  assert.strictEqual(tiers[0].bonusCoins, 1);
  const band20 = tiers.find((t) => t.minAmount === 20);
  assert.strictEqual(band20.bonusCoins, 2);
  const open = tiers[tiers.length - 1];
  assert.strictEqual(open.minAmount, 200);
  assert.strictEqual(open.maxAmount, null);
  assert.strictEqual(open.bonusCoins, 20);
});

test('default draft validates cleanly', () => {
  const draft = domain.buildDefaultArbDraftConfiguration({ createId: seqId() });
  const result = domain.validateArbDraftConfiguration(draft, { requireNonEmptyTiers: true });
  assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
});

test('parse policy accepts snake_case aliases', () => {
  const policy = domain.parseArbBusinessPolicy({
    minimum_recharge: 10,
    maximum_recharge_considered: 500,
    maximum_bonus_cap: 50,
    cooldown_duration_minutes: 120,
  });
  assert.deepStrictEqual(policy, {
    minimumRecharge: 10,
    maximumRechargeConsidered: 500,
    maximumBonusCap: 50,
    cooldownDurationMinutes: 120,
  });
});

test('parse policy rejects non-objects', () => {
  assert.strictEqual(domain.parseArbBusinessPolicy(null), null);
  assert.strictEqual(domain.parseArbBusinessPolicy([]), null);
  assert.strictEqual(domain.parseArbBusinessPolicy('x'), null);
});

test('parse tiers rejects malformed entries', () => {
  assert.strictEqual(domain.parseArbTiers('nope'), null);
  assert.strictEqual(domain.parseArbTiers([{ minAmount: 10 }]), null);
  assert.strictEqual(
    domain.parseArbTiers([{ id: 'a', minAmount: 10, maxAmount: 'bad', bonusCoins: 1 }]),
    null
  );
});

test('serialize round-trip for draft', () => {
  const draft = domain.buildDefaultArbDraftConfiguration({ createId: seqId() });
  const serialized = domain.serializeArbDraftConfiguration(draft);
  const parsed = domain.parseArbDraftConfiguration(serialized);
  assert.ok(parsed);
  assert.strictEqual(parsed.policy.minimumRecharge, draft.policy.minimumRecharge);
  assert.strictEqual(parsed.tiers.length, draft.tiers.length);
});

test('rejects overlapping active tiers', () => {
  const result = domain.validateArbTiers([
    { id: 'a', minAmount: 10, maxAmount: 20, bonusCoins: 1, label: null, active: true },
    { id: 'b', minAmount: 20, maxAmount: 30, bonusCoins: 2, label: null, active: true },
  ]);
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'tier_overlap'));
});

test('rejects negative and zero bonus coins', () => {
  const result = domain.validateArbTiers([
    { id: 'a', minAmount: 10, maxAmount: 19, bonusCoins: 0, label: null, active: true },
    { id: 'b', minAmount: 20, maxAmount: null, bonusCoins: -1, label: null, active: true },
  ]);
  assert.ok(result.errors.some((e) => e.code === 'tier_bonus_below_one'));
});

test('rejects negative / invalid recharge amounts in policy', () => {
  const result = domain.validateArbBusinessPolicy({
    minimumRecharge: -5,
    maximumRechargeConsidered: null,
    maximumBonusCap: null,
    cooldownDurationMinutes: 120,
  });
  assert.ok(result.errors.some((e) => e.code === 'minimum_recharge_invalid'));
});

test('rejects minimum below platform floor', () => {
  const result = domain.validateArbBusinessPolicy({
    minimumRecharge: 5,
    maximumRechargeConsidered: null,
    maximumBonusCap: null,
    cooldownDurationMinutes: 120,
  });
  assert.ok(result.errors.some((e) => e.code === 'minimum_recharge_below_platform_floor'));
});

test('rejects duplicate tier ids and duplicate ranges', () => {
  const dupId = domain.validateArbTiers([
    { id: 'same', minAmount: 10, maxAmount: 19, bonusCoins: 1, label: null, active: true },
    { id: 'same', minAmount: 20, maxAmount: 29, bonusCoins: 2, label: null, active: true },
  ]);
  assert.ok(dupId.errors.some((e) => e.code === 'tier_id_duplicate'));

  const dupRange = domain.validateArbTiers([
    { id: 'a', minAmount: 10, maxAmount: 19, bonusCoins: 1, label: null, active: true },
    { id: 'b', minAmount: 10, maxAmount: 19, bonusCoins: 1, label: null, active: true },
  ]);
  assert.ok(dupRange.errors.some((e) => e.code === 'tier_duplicate_range'));
});

test('rejects multiple open-ended tiers and open-ended not highest', () => {
  const multi = domain.validateArbTiers([
    { id: 'a', minAmount: 10, maxAmount: null, bonusCoins: 1, label: null, active: true },
    { id: 'b', minAmount: 50, maxAmount: null, bonusCoins: 5, label: null, active: true },
  ]);
  assert.ok(multi.errors.some((e) => e.code === 'multiple_open_ended_tiers'));

  const notHighest = domain.validateArbTiers([
    { id: 'a', minAmount: 10, maxAmount: null, bonusCoins: 1, label: null, active: true },
    { id: 'b', minAmount: 50, maxAmount: 59, bonusCoins: 5, label: null, active: true },
  ]);
  assert.ok(notHighest.errors.some((e) => e.code === 'open_ended_not_highest'));
});

test('rejects max below min and invalid cooldown / caps', () => {
  const tiers = domain.validateArbTiers([
    { id: 'a', minAmount: 20, maxAmount: 10, bonusCoins: 1, label: null, active: true },
  ]);
  assert.ok(tiers.errors.some((e) => e.code === 'tier_max_below_min'));

  const coolLow = domain.validateArbBusinessPolicy({
    minimumRecharge: 10,
    maximumRechargeConsidered: null,
    maximumBonusCap: null,
    cooldownDurationMinutes: 5,
  });
  assert.ok(coolLow.errors.some((e) => e.code === 'cooldown_below_platform_min'));

  const coolHigh = domain.validateArbBusinessPolicy({
    minimumRecharge: 10,
    maximumRechargeConsidered: null,
    maximumBonusCap: null,
    cooldownDurationMinutes: 10_000,
  });
  assert.ok(coolHigh.errors.some((e) => e.code === 'cooldown_above_platform_max'));

  const cap = domain.validateArbBusinessPolicy({
    minimumRecharge: 10,
    maximumRechargeConsidered: null,
    maximumBonusCap: -1,
    cooldownDurationMinutes: 120,
  });
  assert.ok(cap.errors.some((e) => e.code === 'maximum_bonus_cap_invalid'));
});

test('rejects lowest tier min mismatch vs minimumRecharge', () => {
  const result = domain.validateArbTiers(
    [{ id: 'a', minAmount: 20, maxAmount: null, bonusCoins: 2, label: null, active: true }],
    { minimumRecharge: 10 }
  );
  assert.ok(result.errors.some((e) => e.code === 'lowest_tier_min_mismatch'));
});

test('empty tiers while feature enabled is rejected on publish validation', () => {
  const result = domain.validateArbDraftConfiguration(
    {
      policy: domain.defaultArbBusinessPolicy(),
      tiers: [],
    },
    { featureEnabled: true }
  );
  assert.ok(result.errors.some((e) => e.code === 'empty_tiers_while_feature_enabled'));
});

test('gap warning is emitted but does not fail ok alone', () => {
  const result = domain.validateArbTiers(
    [
      { id: 'a', minAmount: 10, maxAmount: 19, bonusCoins: 1, label: null, active: true },
      { id: 'b', minAmount: 30, maxAmount: null, bonusCoins: 3, label: null, active: true },
    ],
    { minimumRecharge: 10 }
  );
  assert.strictEqual(result.ok, true);
  assert.ok(result.warnings.some((w) => w.code === 'tier_gap'));
});

test('inactive overlapping tiers do not error', () => {
  const result = domain.validateArbTiers([
    { id: 'a', minAmount: 10, maxAmount: 30, bonusCoins: 1, label: null, active: true },
    { id: 'b', minAmount: 20, maxAmount: 25, bonusCoins: 2, label: null, active: false },
  ]);
  assert.strictEqual(result.ok, true);
});

test('resolver: amount 9 skipped, 10 grants 1, 19 grants 1, 20 grants 2', () => {
  const configuration = samplePublished({
    tiers: domain.buildDefaultLinearArbTiers({
      createId: seqId(),
      openEndedMin: 50,
    }),
  });

  const r9 = domain.resolveAutomaticRechargeBonus({ rechargeAmount: 9, configuration });
  assert.strictEqual(r9.eligible, false);
  assert.strictEqual(r9.skipReason, 'below_minimum_recharge');

  const r10 = domain.resolveAutomaticRechargeBonus({ rechargeAmount: 10, configuration });
  assert.strictEqual(r10.eligible, true);
  assert.strictEqual(r10.bonusCoins, 1);

  const r19 = domain.resolveAutomaticRechargeBonus({ rechargeAmount: 19, configuration });
  assert.strictEqual(r19.bonusCoins, 1);

  const r20 = domain.resolveAutomaticRechargeBonus({ rechargeAmount: 20, configuration });
  assert.strictEqual(r20.bonusCoins, 2);
});

test('resolver: open-ended tier and gap skip', () => {
  const configuration = samplePublished({
    tiers: [
      { id: 'a', minAmount: 10, maxAmount: 19, bonusCoins: 1, label: null, active: true },
      { id: 'b', minAmount: 40, maxAmount: null, bonusCoins: 4, label: null, active: true },
    ],
  });
  const gap = domain.resolveAutomaticRechargeBonus({ rechargeAmount: 25, configuration });
  assert.strictEqual(gap.skipReason, 'no_matching_tier');

  const open = domain.resolveAutomaticRechargeBonus({ rechargeAmount: 999, configuration });
  assert.strictEqual(open.eligible, true);
  assert.strictEqual(open.bonusCoins, 4);
});

test('resolver: max considered and cap', () => {
  const configuration = samplePublished({
    policy: {
      minimumRecharge: 10,
      maximumRechargeConsidered: 50,
      maximumBonusCap: 3,
      cooldownDurationMinutes: 120,
    },
    tiers: [
      { id: 'a', minAmount: 10, maxAmount: 100, bonusCoins: 10, label: null, active: true },
    ],
  });

  const above = domain.resolveAutomaticRechargeBonus({ rechargeAmount: 51, configuration });
  assert.strictEqual(above.skipReason, 'above_maximum_recharge_considered');

  const capped = domain.resolveAutomaticRechargeBonus({ rechargeAmount: 40, configuration });
  assert.strictEqual(capped.eligible, true);
  assert.strictEqual(capped.bonusCoins, 3);
  assert.strictEqual(capped.uncappedBonusCoins, 10);
  assert.strictEqual(capped.appliedCap, 3);
});

test('resolver: cap zero skips; invalid amount; null config', () => {
  const configuration = samplePublished({
    policy: {
      minimumRecharge: 10,
      maximumRechargeConsidered: null,
      maximumBonusCap: 0,
      cooldownDurationMinutes: 120,
    },
    tiers: [
      { id: 'a', minAmount: 10, maxAmount: null, bonusCoins: 5, label: null, active: true },
    ],
  });
  const zero = domain.resolveAutomaticRechargeBonus({ rechargeAmount: 10, configuration });
  assert.strictEqual(zero.skipReason, 'bonus_capped_to_zero');

  const invalid = domain.resolveAutomaticRechargeBonus({
    rechargeAmount: 10.5,
    configuration,
  });
  assert.strictEqual(invalid.skipReason, 'invalid_amount');

  const none = domain.resolveAutomaticRechargeBonus({
    rechargeAmount: 10,
    configuration: null,
  });
  assert.strictEqual(none.skipReason, 'no_published_configuration');
});

test('resolver is deterministic across repeated calls', () => {
  const configuration = samplePublished();
  const a = domain.resolveAutomaticRechargeBonus({ rechargeAmount: 25, configuration });
  const b = domain.resolveAutomaticRechargeBonus({ rechargeAmount: 25, configuration });
  assert.deepStrictEqual(a, b);
});

test('resolver ignores inactive tiers', () => {
  const configuration = samplePublished({
    tiers: [
      { id: 'a', minAmount: 10, maxAmount: 19, bonusCoins: 1, label: null, active: false },
      { id: 'b', minAmount: 10, maxAmount: null, bonusCoins: 9, label: null, active: true },
    ],
  });
  const result = domain.resolveAutomaticRechargeBonus({ rechargeAmount: 15, configuration });
  assert.strictEqual(result.bonusCoins, 9);
  assert.strictEqual(result.tier.id, 'b');
});

test('nextArbVersionNumber increments from null/max', () => {
  assert.strictEqual(domain.nextArbVersionNumber(null), 1);
  assert.strictEqual(domain.nextArbVersionNumber(0), 1);
  assert.strictEqual(domain.nextArbVersionNumber(3), 4);
});

test('planArbPublish creates immutable version plan and does not mutate input draft', () => {
  const draft = domain.buildDefaultArbDraftConfiguration({ createId: seqId() });
  const draftCopy = JSON.parse(JSON.stringify(draft));
  const planned = domain.planArbPublish({
    coadminUid: 'c1',
    draft,
    featureEnabled: false,
    currentPublished: null,
    latestVersionNumber: null,
    versionId: 'fixed-uuid',
    publishedAt: '2026-02-01T00:00:00.000Z',
    acceptGapWarnings: true,
  });
  assert.strictEqual(planned.ok, true);
  assert.strictEqual(planned.plan.versionId, 'fixed-uuid');
  assert.strictEqual(planned.plan.versionNumber, 1);
  assert.strictEqual(planned.plan.audit.action, 'tiers_published');
  assert.deepStrictEqual(draft, draftCopy);
});

test('planArbPublish supersedes previous and increments version number', () => {
  const draft = domain.buildDefaultArbDraftConfiguration({ createId: seqId() });
  const current = samplePublished({ versionId: 'old', versionNumber: 2 });
  const planned = domain.planArbPublish({
    coadminUid: 'c1',
    draft,
    featureEnabled: false,
    currentPublished: current,
    latestVersionNumber: 2,
    versionId: 'new',
    publishedAt: '2026-02-02T00:00:00.000Z',
    acceptGapWarnings: true,
  });
  assert.strictEqual(planned.ok, true);
  assert.strictEqual(planned.plan.versionNumber, 3);
  assert.strictEqual(planned.plan.supersedesVersionId, 'old');
  assert.strictEqual(planned.plan.previousVersionIdToSupersede, 'old');
});

test('planArbPublish rejects invalid and unaccepted gaps', () => {
  const bad = domain.planArbPublish({
    coadminUid: 'c1',
    draft: {
      policy: domain.defaultArbBusinessPolicy(),
      tiers: [
        { id: 'a', minAmount: 10, maxAmount: 30, bonusCoins: 1, label: null, active: true },
        { id: 'b', minAmount: 20, maxAmount: null, bonusCoins: 2, label: null, active: true },
      ],
    },
    featureEnabled: false,
    currentPublished: null,
    latestVersionNumber: null,
  });
  assert.strictEqual(bad.ok, false);

  const gapped = domain.planArbPublish({
    coadminUid: 'c1',
    draft: {
      policy: domain.defaultArbBusinessPolicy(),
      tiers: [
        { id: 'a', minAmount: 10, maxAmount: 19, bonusCoins: 1, label: null, active: true },
        { id: 'b', minAmount: 40, maxAmount: null, bonusCoins: 4, label: null, active: true },
      ],
    },
    featureEnabled: false,
    currentPublished: null,
    latestVersionNumber: null,
    acceptGapWarnings: false,
  });
  assert.strictEqual(gapped.ok, false);
  assert.ok(gapped.validation.errors.some((e) => e.code === 'tier_gap'));
});

test('planArbRollback never edits historical payloads; only re-points', () => {
  const v1 = samplePublished({ versionId: 'v1', versionNumber: 1, status: 'superseded' });
  const v2 = samplePublished({ versionId: 'v2', versionNumber: 2, status: 'published' });
  const plan = domain.planArbRollback({
    target: v1,
    currentPublished: v2,
    rolledBackAt: '2026-03-01T00:00:00.000Z',
  });
  assert.strictEqual(plan.targetVersionId, 'v1');
  assert.deepStrictEqual(plan.statusUpdates, [
    { versionId: 'v1', status: 'published' },
    { versionId: 'v2', status: 'superseded' },
  ]);
  assert.strictEqual(plan.audit.action, 'config_rolled_back');
  assert.strictEqual(plan.draftFromTarget.tiers.length, v1.tiers.length);
});

test('normalize sorts tiers and truncates decimals', () => {
  const normalized = domain.normalizeArbTiers([
    { id: 'b', minAmount: 20.9, maxAmount: 29.1, bonusCoins: 2.8, label: ' x ', active: true },
    { id: 'a', minAmount: 10.2, maxAmount: 19.9, bonusCoins: 1.1, label: null, active: true },
  ]);
  assert.strictEqual(normalized[0].id, 'a');
  assert.strictEqual(normalized[0].minAmount, 10);
  assert.strictEqual(normalized[0].maxAmount, 19);
  assert.strictEqual(normalized[0].bonusCoins, 1);
  assert.strictEqual(normalized[1].label, 'x');
});

test('large contiguous tier table validates and resolves every boundary', () => {
  const tiers = [];
  for (let i = 0; i < 100; i += 1) {
    const min = 10 + i * 10;
    tiers.push({
      id: `t-${i}`,
      minAmount: min,
      maxAmount: min + 9,
      bonusCoins: Math.floor(min / 10),
      label: null,
      active: true,
    });
  }
  tiers.push({
    id: 'open',
    minAmount: 1010,
    maxAmount: null,
    bonusCoins: 101,
    label: null,
    active: true,
  });

  const draft = {
    policy: { ...domain.defaultArbBusinessPolicy(), minimumRecharge: 10 },
    tiers,
  };
  const validation = domain.validateArbDraftConfiguration(draft, {
    requireNonEmptyTiers: true,
  });
  assert.strictEqual(validation.ok, true, JSON.stringify(validation.errors));

  const configuration = samplePublished(draft);
  for (const amount of [10, 19, 20, 509, 510, 1009, 1010, 5000]) {
    const result = domain.resolveAutomaticRechargeBonus({ rechargeAmount: amount, configuration });
    assert.strictEqual(result.eligible, true, `amount ${amount}`);
    const expected = amount >= 1010 ? 101 : Math.floor(amount / 10);
    assert.strictEqual(result.bonusCoins, expected, `bonus for ${amount}`);
  }
});

test('randomized valid contiguous tables always validate', () => {
  for (let round = 0; round < 25; round += 1) {
    const bandCount = 3 + (round % 7);
    const tiers = [];
    let min = 10;
    for (let i = 0; i < bandCount; i += 1) {
      const width = 5 + ((round + i) % 11);
      const max = min + width - 1;
      tiers.push({
        id: `r${round}-${i}`,
        minAmount: min,
        maxAmount: max,
        bonusCoins: Math.max(1, Math.floor(min / 10)),
        label: null,
        active: true,
      });
      min = max + 1;
    }
    tiers.push({
      id: `r${round}-open`,
      minAmount: min,
      maxAmount: null,
      bonusCoins: Math.max(1, Math.floor(min / 10)),
      label: null,
      active: true,
    });
    const result = domain.validateArbDraftConfiguration(
      {
        policy: { ...domain.defaultArbBusinessPolicy(), minimumRecharge: 10 },
        tiers,
      },
      { requireNonEmptyTiers: true }
    );
    assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
  }
});

test('preview table returns one result per amount', () => {
  const configuration = samplePublished();
  const rows = domain.previewAutomaticRechargeBonusTable(configuration, [9, 10, 20]);
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[0].skipReason, 'below_minimum_recharge');
  assert.strictEqual(rows[1].bonusCoins, 1);
  assert.strictEqual(rows[2].bonusCoins, 2);
});

test('adjacent inclusive ranges 10-19 and 20-29 do not overlap', () => {
  const result = domain.validateArbTiers([
    { id: 'a', minAmount: 10, maxAmount: 19, bonusCoins: 1, label: null, active: true },
    { id: 'b', minAmount: 20, maxAmount: 29, bonusCoins: 2, label: null, active: true },
  ]);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(
    domain.arbTierOverlap(
      { id: 'a', minAmount: 10, maxAmount: 19, bonusCoins: 1, label: null, active: true },
      { id: 'b', minAmount: 20, maxAmount: 29, bonusCoins: 2, label: null, active: true }
    ),
    false
  );
});

test('maximumRecharge below minimum is rejected', () => {
  const result = domain.validateArbBusinessPolicy({
    minimumRecharge: 50,
    maximumRechargeConsidered: 10,
    maximumBonusCap: null,
    cooldownDurationMinutes: 120,
  });
  assert.ok(result.errors.some((e) => e.code === 'maximum_recharge_below_minimum'));
});

test('empty tiers skip reason on resolver', () => {
  const configuration = samplePublished({ tiers: [] });
  const result = domain.resolveAutomaticRechargeBonus({ rechargeAmount: 10, configuration });
  assert.strictEqual(result.skipReason, 'empty_tiers');
});

console.log(`\n${passed} passed, ${failed} failed`);
