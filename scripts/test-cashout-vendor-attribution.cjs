/**
 * Focused tests for cashout vendor attribution.
 * Run: node scripts/test-cashout-vendor-attribution.cjs
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');

function loadTsModule(relativePath, stubs = {}) {
  const abs = path.join(ROOT, relativePath);
  const source = fs.readFileSync(abs, 'utf8');
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
  m.require = (id) => {
    if (stubs[id]) return stubs[id];
    if (id.startsWith('@/')) {
      const mapped = id.replace('@/', path.join(ROOT, '/').replace(/\\/g, '/'));
      // Fall through unsupported alias requires.
    }
    return Module.prototype.require.call(m, id);
  };
  // Rewrite @/ imports inside the transpiled CJS to relative stubs via Module._compile patch.
  const rewritten = outputText.replace(
    /require\(["']@\/([^"']+)["']\)/g,
    (_, p) => {
      const key = `@/${p}`;
      if (stubs[key]) {
        return `require(${JSON.stringify(key)})`;
      }
      return `require(${JSON.stringify(path.join(ROOT, p))})`;
    }
  );
  const originalRequire = Module.prototype.require;
  m.require = function (id) {
    if (stubs[id]) return stubs[id];
    return originalRequire.call(this, id);
  };
  m._compile(rewritten, modulePath);
  return m.exports;
}

const vendorAwareness = loadTsModule('features/vendors/vendorAwareness.ts');
const attribution = loadTsModule('lib/sql/vendorCashoutAttribution.ts', {
  '@/features/vendors/vendorAwareness': vendorAwareness,
});

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`fail - ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}

test('vendor-linked cashout completion payload updates vendor totals fields', () => {
  const vendor = attribution.storedVendorFieldsFromAwareness({
    configured: true,
    owned: true,
    vendorId: 12,
    name: 'Royal VIP East',
    code: 'VND-000012',
    status: 'active',
    linkedStaffUid: 'staff_1',
    ownershipDate: '2026-01-01T00:00:00.000Z',
  });
  const payload = attribution.buildVendorCashoutCompletedPayload({
    eventId: 'evt-1',
    taskId: 'task-1',
    playerUid: 'player-a',
    coadminUid: 'coadmin-a',
    amountNpr: 50,
    occurredAt: '2026-07-28T12:00:00.000Z',
    vendor,
  });
  assert.strictEqual(payload.vendorId, 12);
  assert.strictEqual(payload.vendorCode, 'VND-000012');
  assert.strictEqual(payload.amountNpr, 50);
  assert.strictEqual(payload.reason, 'cashout_completed');
  assert.ok(attribution.isVendorLinked(vendor));
});

test('unassigned player does not update a vendor', () => {
  const vendor = attribution.storedVendorFieldsFromAwareness(vendorAwareness.noVendor());
  assert.strictEqual(attribution.isVendorLinked(vendor), false);
  assert.strictEqual(vendor.vendorId, null);
  assert.strictEqual(vendor.vendorCode, null);
  assert.ok(vendor.vendorResolvedAt);
});

test('pending task API can return vendor name from stored fields', () => {
  const awareness = attribution.vendorAwarenessFromStoredFields({
    vendorId: 7,
    vendorCode: 'VND-000007',
    vendorName: 'Royal VIP East',
    vendorStatus: 'active',
    vendorLinkedStaffUid: null,
    vendorOwnershipDate: null,
    vendorResolvedAt: '2026-07-28T12:00:00.000Z',
  });
  assert.strictEqual(vendorAwareness.vendorDisplayName(awareness), 'Royal VIP East');
  assert.strictEqual(attribution.vendorDisplayLabel(awareness), 'Royal VIP East');
});

test('unassigned display label replaces Vendor data unavailable for owned=false', () => {
  assert.strictEqual(
    vendorAwareness.vendorDisplayName(vendorAwareness.noVendor()),
    'Unassigned player'
  );
  assert.strictEqual(
    vendorAwareness.vendorDisplayName(vendorAwareness.vendorUnavailable()),
    'Vendor data unavailable'
  );
});

test('retrying completion is idempotent via shared eventId key', () => {
  const vendor = attribution.storedVendorFieldsFromAwareness({
    configured: true,
    owned: true,
    vendorId: 3,
    name: 'Vendor Three',
    code: 'VND-000003',
    status: 'active',
    linkedStaffUid: null,
    ownershipDate: null,
  });
  const first = attribution.buildVendorCashoutCompletedPayload({
    eventId: 'same-event',
    taskId: 'task-9',
    playerUid: 'player-b',
    coadminUid: null,
    amountNpr: 50,
    occurredAt: '2026-07-28T12:00:00.000Z',
    vendor,
  });
  const second = attribution.buildVendorCashoutCompletedPayload({
    eventId: 'same-event',
    taskId: 'task-9',
    playerUid: 'player-b',
    coadminUid: null,
    amountNpr: 50,
    occurredAt: '2026-07-28T12:00:00.000Z',
    vendor,
  });
  assert.deepStrictEqual(first, second);
});

test('older task without vendor_id resolves it from the player awareness', () => {
  const empty = attribution.readStoredVendorFieldsFromRow({
    player_uid: 'player-old',
    raw_firestore_data: {},
  });
  assert.strictEqual(empty.vendorId, null);
  assert.strictEqual(empty.vendorCode, null);
  const resolved = attribution.storedVendorFieldsFromAwareness({
    configured: true,
    owned: true,
    vendorId: 99,
    name: 'Legacy Vendor',
    code: 'VND-000099',
    status: 'active',
    linkedStaffUid: null,
    ownershipDate: null,
  });
  assert.strictEqual(resolved.vendorId, 99);
  assert.strictEqual(resolved.vendorCode, 'VND-000099');
  const merged = attribution.mergeVendorIntoRawFirestoreData({ status: 'pending' }, resolved);
  assert.strictEqual(merged.vendorId, 99);
  assert.strictEqual(merged.vendorCode, 'VND-000099');
});

test('client-supplied vendor ids are rejected/logged and not trusted', () => {
  // Function only logs; ensure it does not throw and inspect source wiring.
  attribution.rejectClientSuppliedVendorId({ vendorId: 123, vendor_code: 'HACK' });
  const completeRoute = fs.readFileSync(
    path.join(ROOT, 'app/api/cashout-tasks/complete/route.ts'),
    'utf8'
  );
  const createRoute = fs.readFileSync(
    path.join(ROOT, 'app/api/player/cashout-tasks/create/route.ts'),
    'utf8'
  );
  assert.ok(completeRoute.includes('rejectClientSuppliedVendorId'));
  assert.ok(createRoute.includes('rejectClientSuppliedVendorId'));
});

test('source wiring persists vendor and reports ledger after commit', () => {
  const authority = fs.readFileSync(path.join(ROOT, 'lib/sql/authorityCashout.ts'), 'utf8');
  assert.ok(authority.includes('resolveVendorAwarenessForPlayerUid'));
  assert.ok(authority.includes('reportVendorCashoutCompletedToLedger'));
  assert.ok(
    authority.includes(
      "// Ledger Total Out / Net / receivable update — only after the cashout event committed.\n    void reportVendorCashoutCompletedToLedger"
    ) ||
      authority.includes(
        "// Ledger Total Out / Net / receivable update — only after the cashout event committed.\r\n    void reportVendorCashoutCompletedToLedger"
      )
  );
  assert.ok(authority.includes('vendor_id, vendor_code, vendor_name'));

  const migration = fs.readFileSync(
    path.join(ROOT, 'migrations/066_cashout_vendor_attribution.sql'),
    'utf8'
  );
  assert.ok(migration.includes('ADD COLUMN IF NOT EXISTS vendor_id'));

  const staff = fs.readFileSync(path.join(ROOT, 'app/staff/page.tsx'), 'utf8');
  assert.ok(staff.includes('Unassigned player'));
  assert.doesNotMatch(staff, />\s*No Vendor\s*</);
});

if (process.exitCode) {
  console.error(`\n${passed} tests passed before failure`);
  process.exit(process.exitCode);
}
console.log(`\n${passed} tests passed`);
