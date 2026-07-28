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
    URL,
    process,
    fetch: (...args) => global.fetch(...args),
    setTimeout,
    clearTimeout,
    AbortController,
  }, { filename });
  return module.exports;
}

const vendorAwareness = loadTsModule('features/vendors/vendorAwareness.ts');
const vendorOwnershipRead = loadTsModule('lib/sql/vendorOwnershipRead.ts', {
  '@/features/vendors/vendorAwareness': vendorAwareness,
});

function withVendorEnv(fn) {
  const previousUrl = process.env.APPBEG_LEDGER_INTERNAL_URL;
  const previousKey = process.env.APPBEG_LEDGER_INTERNAL_API_KEY;
  const previousTimeout = process.env.APPBEG_LEDGER_VENDOR_TIMEOUT_MS;
  const previousCache = process.env.APPBEG_LEDGER_VENDOR_CACHE_MS;
  process.env.APPBEG_LEDGER_INTERNAL_URL = 'https://ledger.internal';
  process.env.APPBEG_LEDGER_INTERNAL_API_KEY = 'phase6-secret';
  process.env.APPBEG_LEDGER_VENDOR_TIMEOUT_MS = '250';
  process.env.APPBEG_LEDGER_VENDOR_CACHE_MS = '30000';
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      process.env.APPBEG_LEDGER_INTERNAL_URL = previousUrl;
      process.env.APPBEG_LEDGER_INTERNAL_API_KEY = previousKey;
      process.env.APPBEG_LEDGER_VENDOR_TIMEOUT_MS = previousTimeout;
      process.env.APPBEG_LEDGER_VENDOR_CACHE_MS = previousCache;
      delete global.fetch;
    });
}

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
  assert.equal(vendorAwareness.vendorDisplayName(null), 'Unassigned player');
  assert.equal(vendorAwareness.vendorDisplayName({ configured: false, owned: null }), 'Vendor data unavailable');
}

async function testBulkVendorRequestAndMerge() {
  await withVendorEnv(async () => {
    const calls = [];
    global.fetch = async (url, options) => {
      calls.push({ url, options });
      assert.equal(url, 'https://ledger.internal/api/internal/vendor-ownership');
      assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'manual');
      assert.equal(options.headers.Authorization, 'Bearer phase6-secret');
      assert.deepEqual(JSON.parse(options.body), {
        playerUids: ['player_with_vendor', 'player_without_vendor'],
      });
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            configured: true,
            players: {
              player_with_vendor: {
                owned: true,
                vendorName: 'Royal VIP East',
                vendorCode: 'VND-000007',
                vendorStatus: 'active',
                linkedStaffUid: 'staff-reporting',
                ownershipDate: '2026-07-27T12:00:00.000Z',
              },
              player_without_vendor: { owned: false },
            },
          };
        },
      };
    };
    const players = await vendorOwnershipRead.attachVendorAwarenessToPlayers([
      { uid: 'player_with_vendor', username: 'WithVendor' },
      { uid: 'player_without_vendor', username: 'NoVendor' },
      { uid: 'player_with_vendor', username: 'DuplicateWithVendor' },
      { uid: null, username: 'Malformed' },
    ]);
    assert.equal(calls.length, 1);
    assert.equal(players[0].vendor.code, 'VND-000007');
    assert.equal(players[0].vendor.linkedStaffUid, 'staff-reporting');
    assert.equal(players[1].vendor.configured, true);
    assert.equal(players[1].vendor.owned, false);
    assert.equal(players[2].vendor.code, 'VND-000007');
    assert.equal(players[3].vendor.configured, false);
  });
}

async function testDuplicateUidUsesShortCache() {
  await withVendorEnv(async () => {
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        async json() {
          return { configured: true, players: { cached_uid: { owned: false } } };
        },
      };
    };
    await vendorOwnershipRead.attachVendorAwarenessToPlayers([{ uid: 'cached_uid' }]);
    await vendorOwnershipRead.attachVendorAwarenessToPlayers([{ uid: 'cached_uid' }]);
    assert.equal(calls, 1);
  });
}

async function testEmptyUidListAvoidsRequest() {
  await withVendorEnv(async () => {
    global.fetch = async () => {
      throw new Error('empty uid list should not fetch');
    };
    const players = await vendorOwnershipRead.attachVendorAwarenessToPlayers([]);
    assert.deepEqual(players, []);
  });
}

async function testUnavailableWhenNotConfigured() {
  const previousUrl = process.env.APPBEG_LEDGER_INTERNAL_URL;
  const previousKey = process.env.APPBEG_LEDGER_INTERNAL_API_KEY;
  process.env.APPBEG_LEDGER_INTERNAL_URL = '';
  process.env.APPBEG_LEDGER_INTERNAL_API_KEY = '';
  try {
    global.fetch = async () => {
      throw new Error('fetch should not be called without config');
    };
    const players = await vendorOwnershipRead.attachVendorAwarenessToPlayers([{ uid: 'unconfigured_uid' }]);
    assert.equal(players[0].vendor.configured, false);
    assert.equal(players[0].vendor.owned, null);
  } finally {
    process.env.APPBEG_LEDGER_INTERNAL_URL = previousUrl;
    process.env.APPBEG_LEDGER_INTERNAL_API_KEY = previousKey;
    delete global.fetch;
  }
}

async function testLedgerConfiguredFalseIsUnavailable() {
  await withVendorEnv(async () => {
    global.fetch = async () => ({
      ok: true,
      status: 200,
      async json() {
        return { configured: false };
      },
    });
    const players = await vendorOwnershipRead.attachVendorAwarenessToPlayers([{ uid: 'ledger_unavailable_uid' }]);
    assert.equal(players[0].vendor.configured, false);
    assert.equal(players[0].vendor.owned, null);
  });
}

async function testStatusFailuresAreUnavailable() {
  for (const status of [401, 403, 404, 429, 500]) {
    await withVendorEnv(async () => {
      global.fetch = async () => ({
        ok: false,
        status,
        async json() {
          throw new Error('json should not be read for non-ok responses');
        },
      });
      const players = await vendorOwnershipRead.attachVendorAwarenessToPlayers([{ uid: `status_${status}` }]);
      assert.equal(players[0].vendor.configured, false);
      assert.equal(players[0].vendor.owned, null);
    });
  }
}

async function testNonJsonResponseIsUnavailable() {
  await withVendorEnv(async () => {
    global.fetch = async () => ({
      ok: true,
      status: 200,
      async json() {
        throw new Error('invalid json');
      },
    });
    const players = await vendorOwnershipRead.attachVendorAwarenessToPlayers([{ uid: 'non_json_uid' }]);
    assert.equal(players[0].vendor.configured, false);
    assert.equal(players[0].vendor.owned, null);
  });
}

async function testTimeoutOrNetworkFailureIsUnavailable() {
  await withVendorEnv(async () => {
    global.fetch = async () => {
      throw new Error('network timeout');
    };
    const players = await vendorOwnershipRead.attachVendorAwarenessToPlayers([{ uid: 'timeout_uid' }]);
    assert.equal(players[0].vendor.configured, false);
    assert.equal(players[0].vendor.owned, null);
  });
}

async function testCacheExpiresAndRefreshes() {
  await withVendorEnv(async () => {
    process.env.APPBEG_LEDGER_VENDOR_CACHE_MS = '1';
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            configured: true,
            players: {
              expiring_uid: {
                owned: true,
                vendorName: `Vendor ${calls}`,
                vendorCode: 'VND-000001',
                vendorStatus: 'active',
                linkedStaffUid: null,
                ownershipDate: null,
              },
            },
          };
        },
      };
    };
    const first = await vendorOwnershipRead.attachVendorAwarenessToPlayers([{ uid: 'expiring_uid' }]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await vendorOwnershipRead.attachVendorAwarenessToPlayers([{ uid: 'expiring_uid' }]);
    assert.equal(calls, 2);
    assert.equal(first[0].vendor.name, 'Vendor 1');
    assert.equal(second[0].vendor.name, 'Vendor 2');
  });
}

async function testCacheKeyIsolatedByLedgerUrl() {
  await withVendorEnv(async () => {
    let calls = 0;
    global.fetch = async (url) => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            configured: true,
            players: {
              isolated_uid: {
                owned: true,
                vendorName: String(url).includes('ledger-one') ? 'Ledger One' : 'Ledger Two',
                vendorCode: 'VND-000002',
                vendorStatus: 'active',
                linkedStaffUid: null,
                ownershipDate: null,
              },
            },
          };
        },
      };
    };
    process.env.APPBEG_LEDGER_INTERNAL_URL = 'https://ledger-one.internal';
    const first = await vendorOwnershipRead.attachVendorAwarenessToPlayers([{ uid: 'isolated_uid' }]);
    process.env.APPBEG_LEDGER_INTERNAL_URL = 'https://ledger-two.internal';
    const second = await vendorOwnershipRead.attachVendorAwarenessToPlayers([{ uid: 'isolated_uid' }]);
    assert.equal(calls, 2);
    assert.equal(first[0].vendor.name, 'Ledger One');
    assert.equal(second[0].vendor.name, 'Ledger Two');
  });
}

async function testCacheGrowthIsBounded() {
  await withVendorEnv(async () => {
    let calls = 0;
    global.fetch = async (_url, options) => {
      calls += 1;
      const { playerUids } = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            configured: true,
            players: Object.fromEntries(playerUids.map((uid) => [uid, { owned: false }])),
          };
        },
      };
    };
    for (let index = 0; index < 1005; index += 1) {
      await vendorOwnershipRead.attachVendorAwarenessToPlayers([{ uid: `bounded_${index}` }]);
    }
    await vendorOwnershipRead.attachVendorAwarenessToPlayers([{ uid: 'bounded_0' }]);
    assert.equal(calls, 1006);
  });
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

function testNoVendorOwnershipSqlWrites() {
  const ownershipSource = fs.readFileSync(path.join(root, 'lib/sql/vendorOwnershipRead.ts'), 'utf8');
  assert.doesNotMatch(ownershipSource, /\bINSERT\b|\bUPDATE\b|\bCREATE\b|\bALTER\b|\bDROP\b/i);
  assert.doesNotMatch(ownershipSource, /from ['"]pg['"]|playerMirrorCommon|pool\.query|client\.query|SELECT\s/i);
  const migrationDir = path.join(root, 'migrations');
  const vendorMigrations = fs.readdirSync(migrationDir).filter((name) => /vendor/i.test(name));
  assert.deepEqual(vendorMigrations, ['066_cashout_vendor_attribution.sql']);
}

(async () => {
  testVendorNormalization();
  await testBulkVendorRequestAndMerge();
  await testDuplicateUidUsesShortCache();
  await testEmptyUidListAvoidsRequest();
  await testUnavailableWhenNotConfigured();
  await testLedgerConfiguredFalseIsUnavailable();
  await testStatusFailuresAreUnavailable();
  await testNonJsonResponseIsUnavailable();
  await testTimeoutOrNetworkFailureIsUnavailable();
  await testCacheExpiresAndRefreshes();
  await testCacheKeyIsolatedByLedgerUrl();
  await testCacheGrowthIsBounded();
  testUiWiringIsReadOnly();
  testNoVendorOwnershipSqlWrites();
  console.log('Vendor staff awareness tests passed.');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
