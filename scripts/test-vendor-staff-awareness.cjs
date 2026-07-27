const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');

function loadTsModule(relativePath, mocks = {}) {
  const filename = path.join(root, relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filename,
  }).outputText;
  const module = { exports: {} };
  const sandboxRequire = (specifier) => {
    if (Object.prototype.hasOwnProperty.call(mocks, specifier)) {
      return mocks[specifier];
    }
    if (specifier === 'server-only') {
      return {};
    }
    return require(specifier);
  };
  vm.runInNewContext(output, {
    require: sandboxRequire,
    module,
    exports: module.exports,
    console,
    Date,
    Map,
    Number,
    Object,
    Set,
    String,
  }, { filename });
  return module.exports;
}

const vendorAwareness = loadTsModule('features/vendors/vendorAwareness.ts');
const vendorOwnershipRead = loadTsModule('lib/sql/vendorOwnershipRead.ts', {
  '@/features/vendors/vendorAwareness': vendorAwareness,
  '@/lib/sql/playerMirrorCommon': {
    getPlayerMirrorPool: () => null,
    runMirrorClientQuery: async (client, sql, params) => client.query(sql, params),
    runMirrorPoolQuery: async (pool, sql, params) => pool.query(sql, params),
    toIsoString: (value) => {
      if (!value) return null;
      const date = value instanceof Date ? value : new Date(value);
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    },
  },
});

function testVendorNormalization() {
  const vendor = vendorAwareness.normalizeVendorAwareness({
    configured: true,
    owned: true,
    vendorId: '12',
    name: 'Royal VIP East',
    code: 'VND-000012',
    status: 'suspended',
    linkedStaffUid: 'staff_123',
    ownershipDate: '2026-07-27T00:00:00.000Z',
  });
  assert.equal(vendorAwareness.hasVendorAwareness(vendor), true);
  assert.equal(vendor.configured, true);
  assert.equal(vendor.owned, true);
  assert.equal(vendor.vendorId, 12);
  assert.equal(vendor.name, 'Royal VIP East');
  assert.equal(vendor.code, 'VND-000012');
  assert.equal(vendor.status, 'suspended');
  assert.equal(vendor.linkedStaffUid, 'staff_123');
  assert.equal(vendorAwareness.vendorDisplayName(vendor), 'Royal VIP East');
  assert.equal(vendorAwareness.normalizeVendorAwareness({ configured: false }).owned, null);
  assert.equal(vendorAwareness.normalizeVendorAwareness({ configured: true, owned: false }).owned, false);
  assert.equal(vendorAwareness.normalizeVendorAwareness(null), null);
  assert.equal(vendorAwareness.normalizeVendorAwareness({ name: 'Missing code' }), null);
  assert.equal(vendorAwareness.vendorDisplayName(null), 'No Vendor');
  assert.equal(vendorAwareness.vendorDisplayName({ configured: false, owned: null }), 'Vendor data unavailable');
}

function testVendorOwnershipRowMapping() {
  const vendor = vendorOwnershipRead.mapVendorOwnershipRow({
    vendor_id: 99,
    vendor_name: 'Suspended Vendor',
    vendor_code: 'VND-000099',
    vendor_status: 'suspended',
    linked_staff_uid: null,
    linked_at: new Date('2026-07-27T12:00:00.000Z'),
  });
  assert.equal(vendor.vendorId, 99);
  assert.equal(vendor.configured, true);
  assert.equal(vendor.owned, true);
  assert.equal(vendor.status, 'suspended');
  assert.equal(vendor.linkedStaffUid, null);
  assert.equal(vendor.ownershipDate, '2026-07-27T12:00:00.000Z');
  assert.equal(vendorOwnershipRead.mapVendorOwnershipRow({ vendor_name: 'No code' }), null);
}

async function testAttachVendorAwarenessBulk() {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/to_regclass/.test(sql)) {
        return {
          rows: [{ vendor_players_table: 'vendor_players', vendors_table: 'vendors' }],
        };
      }
      assert.equal(
        JSON.stringify(params[0]),
        JSON.stringify(['player_with_vendor', 'player_without_vendor'])
      );
      return {
        rows: [{
          appbeg_player_uid: 'player_with_vendor',
          linked_at: '2026-07-27T12:00:00.000Z',
          vendor_id: 7,
          vendor_name: 'Royal VIP East',
          vendor_code: 'VND-000007',
          vendor_status: 'active',
          linked_staff_uid: 'staff-reporting',
        }],
      };
    },
  };
  const players = await vendorOwnershipRead.attachVendorAwarenessToPlayers([
    { uid: 'player_with_vendor', username: 'WithVendor' },
    { uid: 'player_without_vendor', username: 'NoVendor' },
    { uid: 'player_with_vendor', username: 'DuplicateWithVendor' },
    { uid: null, username: 'Malformed' },
  ], { client, authoritativeSource: true });
  assert.equal(calls.length, 2);
  assert.equal(players[0].vendor.code, 'VND-000007');
  assert.equal(players[0].vendor.linkedStaffUid, 'staff-reporting');
  assert.equal(players[1].vendor.configured, true);
  assert.equal(players[1].vendor.owned, false);
  assert.equal(players[2].vendor.code, 'VND-000007');
  assert.equal(players[3].vendor.configured, false);
}

async function testEmptyUidListDoesNotQuery() {
  const client = {
    async query() {
      throw new Error('empty uid list should not query');
    },
  };
  const players = await vendorOwnershipRead.attachVendorAwarenessToPlayers([], {
    client,
    authoritativeSource: true,
  });
  assert.deepEqual(players, []);
}

async function testMissingVendorSchemaIsUnavailable() {
  const client = {
    async query(sql) {
      if (/to_regclass/.test(sql)) {
        return { rows: [{ vendor_players_table: null, vendors_table: null }] };
      }
      throw new Error('ownership query should not run when tables are absent');
    },
  };
  const players = await vendorOwnershipRead.attachVendorAwarenessToPlayers([
    { uid: 'player_without_tables' },
  ], { client, authoritativeSource: true });
  assert.equal(players[0].vendor.configured, false);
  assert.equal(players[0].vendor.owned, null);
}

async function testUnapprovedAppBegSourceIsUnavailable() {
  const client = {
    async query() {
      throw new Error('AppBeg database must not be queried for Vendor ownership without an authoritative source');
    },
  };
  const players = await vendorOwnershipRead.attachVendorAwarenessToPlayers([
    { uid: 'player_with_vendor' },
  ], { client });
  assert.equal(players[0].vendor.configured, false);
  assert.equal(players[0].vendor.owned, null);
}

async function testQueryFailureIsUnavailable() {
  const client = {
    async query(sql) {
      if (/to_regclass/.test(sql)) {
        return {
          rows: [{ vendor_players_table: 'vendor_players', vendors_table: 'vendors' }],
        };
      }
      throw new Error('connection failed');
    },
  };
  const players = await vendorOwnershipRead.attachVendorAwarenessToPlayers([
    { uid: 'player_with_vendor' },
  ], { client, authoritativeSource: true });
  assert.equal(players[0].vendor.configured, false);
  assert.equal(players[0].vendor.owned, null);
}

function testUiWiringIsReadOnly() {
  const staffPage = fs.readFileSync(path.join(root, 'app/staff/page.tsx'), 'utf8');
  const carerPage = fs.readFileSync(path.join(root, 'app/carer/page.tsx'), 'utf8');
  assert.match(staffPage, /Reporting Only/);
  assert.match(staffPage, /Vendor data unavailable/);
  assert.match(staffPage, /renderVendorTaskBadge\(task\.vendor\)/);
  assert.match(staffPage, /renderVendorDetailSection\(user\.vendor\)/);
  assert.match(carerPage, /renderVendorTaskBadge\(task\.vendor\)/);
  assert.doesNotMatch(staffPage, /createVendor|updateVendor|deleteVendor|settlement/i);
}

function testNoVendorWritesOrMigrations() {
  const ownershipSource = fs.readFileSync(path.join(root, 'lib/sql/vendorOwnershipRead.ts'), 'utf8');
  assert.doesNotMatch(ownershipSource, /\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bCREATE\b|\bALTER\b|\bDROP\b/i);
  const migrationDir = path.join(root, 'migrations');
  const vendorMigrations = fs.readdirSync(migrationDir).filter((name) => /vendor/i.test(name));
  assert.deepEqual(vendorMigrations, []);
}

(async () => {
  testVendorNormalization();
  testVendorOwnershipRowMapping();
  await testAttachVendorAwarenessBulk();
  await testEmptyUidListDoesNotQuery();
  await testMissingVendorSchemaIsUnavailable();
  await testUnapprovedAppBegSourceIsUnavailable();
  await testQueryFailureIsUnavailable();
  testUiWiringIsReadOnly();
  testNoVendorWritesOrMigrations();
  console.log('Vendor staff awareness tests passed.');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
