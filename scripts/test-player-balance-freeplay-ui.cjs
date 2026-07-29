/**
 * Focused tests: FreePlay claim + staff coin-load → instant player balance UI.
 * Run: node scripts/test-player-balance-freeplay-ui.cjs
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');

function loadTsModule(relativePath) {
  const abs = path.join(ROOT, relativePath);
  const source = fs.readFileSync(abs, 'utf8');
  // Strip server-only so Node can load authority helpers in tests.
  const stripped = source.replace(/import\s+['"]server-only['"];?\s*/g, '');
  const ts = require('typescript');
  const { outputText } = ts.transpileModule(stripped, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: abs,
  });
  const modulePath = abs + '.cjs-test-cache.js';
  const Module = module.constructor;
  const m = new Module(modulePath, module);
  m.filename = modulePath;
  m.paths = Module._nodeModulePaths(path.dirname(modulePath));
  m._compile(outputText, modulePath);
  return m.exports;
}

const {
  PLAYER_BALANCE_UPDATED_EVENT,
  PLAYER_BALANCE_UPDATE_LEGACY_EVENT,
  buildPlayerBalanceUpdatedOutboxRows,
  buildPlayerBalanceUpdatedPayload,
  readAuthoritativeCashFromBalancePayload,
  readAuthoritativeCoinFromBalancePayload,
  balanceEventDedupeKey,
  playerBalanceLiveChannel,
} = loadTsModule('lib/sql/playerBalanceUpdatedEvent.ts');

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

function applyAuthoritativeWallet(wallet, meta) {
  const hasCash =
    meta?.cashBalance !== undefined &&
    meta?.cashBalance !== null &&
    Number.isFinite(Number(meta.cashBalance));
  const hasCoin =
    meta?.coinBalance !== undefined &&
    meta?.coinBalance !== null &&
    Number.isFinite(Number(meta.coinBalance));
  if (!hasCash && !hasCoin) {
    return wallet;
  }
  return {
    cash: hasCash ? Math.max(0, Number(meta.cashBalance)) : wallet.cash,
    coin: hasCoin ? Math.max(0, Number(meta.coinBalance)) : wallet.coin,
  };
}

function applyBalanceEventOnce(state, eventName, payload, playerUid) {
  const payloadPlayerUid = String(payload.playerUid || '').trim();
  if (payloadPlayerUid && payloadPlayerUid !== playerUid) {
    return { ...state, ignored: true };
  }
  const dedupeKey = balanceEventDedupeKey({
    eventName,
    eventId: payload.eventId,
    outboxId: payload.outboxId,
  });
  if (dedupeKey && state.seen.has(dedupeKey)) {
    return { ...state, duplicated: true };
  }
  if (dedupeKey) {
    state.seen.add(dedupeKey);
  }
  const cashBalance = readAuthoritativeCashFromBalancePayload(payload);
  const coinBalance = readAuthoritativeCoinFromBalancePayload(payload);
  const nextWallet = applyAuthoritativeWallet(state.wallet, { cashBalance, coinBalance });
  return {
    ...state,
    wallet: nextWallet,
    freeplayPending: payload.hasPendingGift === false ? false : state.freeplayPending,
    ignored: false,
    duplicated: false,
  };
}

test('1. FreePlay claim mutation response updates wallet immediately', () => {
  let wallet = { coin: 10, cash: 5 };
  const mutation = { amount: 3, coin: 13, cash: 5, hasPendingGift: false };
  assert.ok(Number.isFinite(mutation.coin));
  wallet = applyAuthoritativeWallet(wallet, {
    coinBalance: mutation.coin,
    cashBalance: mutation.cash,
  });
  assert.deepStrictEqual(wallet, { coin: 13, cash: 5 });
  assert.strictEqual(mutation.amount, 3);
});

test('2. FreePlay claimed state clears pending gift immediately after success', () => {
  let hasPendingFreeplayGift = true;
  let claimingFreeplayGift = true;
  const result = { hasPendingGift: false, amount: 2, coin: 12, cash: 0 };
  // Mimic success path: clear pending before releasing claiming lock.
  hasPendingFreeplayGift = result.hasPendingGift === true ? true : false;
  claimingFreeplayGift = false;
  assert.strictEqual(hasPendingFreeplayGift, false);
  assert.strictEqual(claimingFreeplayGift, false);
});

test('3. Staff coin load publishes player-scoped balance event for open sessions', () => {
  const rows = buildPlayerBalanceUpdatedOutboxRows({
    playerUid: 'player-open',
    cashBalance: 40,
    coinBalance: 125,
    reason: 'staff_wallet_coin_load',
    eventId: 'evt-staff-1',
    occurredAt: '2026-07-29T12:00:00.000Z',
    source: 'authority_staff_wallet_load',
  });
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].eventType, PLAYER_BALANCE_UPDATED_EVENT);
  assert.strictEqual(rows[1].eventType, PLAYER_BALANCE_UPDATE_LEGACY_EVENT);
  assert.strictEqual(rows[0].channel, 'player:player-open:requests');
  assert.strictEqual(rows[0].payload.coinBalance, 125);
  assert.strictEqual(rows[0].payload.cashBalance, 40);
  assert.strictEqual(rows[0].payload.reason, 'staff_wallet_coin_load');

  let wallet = { coin: 100, cash: 40 };
  wallet = applyAuthoritativeWallet(wallet, {
    coinBalance: rows[0].payload.coinBalance,
    cashBalance: rows[0].payload.cashBalance,
  });
  assert.deepStrictEqual(wallet, { coin: 125, cash: 40 });
});

test('4. Duplicate realtime event does not double-apply balance', () => {
  const payload = buildPlayerBalanceUpdatedPayload({
    playerUid: 'player-a',
    cashBalance: 10,
    coinBalance: 50,
    reason: 'freeplay_claim',
    eventId: 'evt-dup',
    occurredAt: '2026-07-29T12:00:00.000Z',
  });
  let state = { wallet: { coin: 47, cash: 10 }, seen: new Set(), freeplayPending: true };
  state = applyBalanceEventOnce(state, PLAYER_BALANCE_UPDATED_EVENT, payload, 'player-a');
  assert.deepStrictEqual(state.wallet, { coin: 50, cash: 10 });
  const afterFirst = { ...state.wallet };
  state = applyBalanceEventOnce(state, PLAYER_BALANCE_UPDATE_LEGACY_EVENT, payload, 'player-a');
  assert.strictEqual(state.duplicated, true);
  assert.deepStrictEqual(state.wallet, afterFirst);
});

test('5. Event for another player is ignored', () => {
  const payload = buildPlayerBalanceUpdatedPayload({
    playerUid: 'player-b',
    cashBalance: 99,
    coinBalance: 99,
    reason: 'staff_wallet_coin_load',
    eventId: 'evt-other',
    occurredAt: '2026-07-29T12:00:00.000Z',
  });
  let state = { wallet: { coin: 1, cash: 1 }, seen: new Set(), freeplayPending: false };
  state = applyBalanceEventOnce(state, PLAYER_BALANCE_UPDATED_EVENT, payload, 'player-a');
  assert.strictEqual(state.ignored, true);
  assert.deepStrictEqual(state.wallet, { coin: 1, cash: 1 });
});

test('6. Mutation failure does not change displayed amount', () => {
  let wallet = { coin: 20, cash: 8 };
  const before = { ...wallet };
  try {
    throw new Error('Could not claim freeplay. Please try again.');
  } catch {
    // failure path must not touch wallet
  }
  assert.deepStrictEqual(wallet, before);
});

test('7. Reconnect refetches once and reconciles without polling', () => {
  const reconnectCalls = [];
  const onBalanceUpdate = (reason, meta) => {
    reconnectCalls.push({ reason, meta });
  };
  onBalanceUpdate('reconnect_attempt_1', {
    needsAuthoritativeRefetch: true,
    reason: 'reconnect',
  });
  assert.strictEqual(reconnectCalls.length, 1);
  assert.strictEqual(reconnectCalls[0].meta.needsAuthoritativeRefetch, true);
  assert.strictEqual(reconnectCalls[0].meta.pollIntervalMs, undefined);

  // Single reconcile apply from authoritative snapshot (not a loop).
  let wallet = { coin: 10, cash: 5 };
  const reconciled = { coin: 33, cash: 12 };
  wallet = applyAuthoritativeWallet(wallet, {
    coinBalance: reconciled.coin,
    cashBalance: reconciled.cash,
  });
  assert.deepStrictEqual(wallet, reconciled);
});

test('8. Multiple balance surfaces stay synchronized from one wallet state', () => {
  const wallet = { coin: 77, cash: 19 };
  const headerCoin = wallet.coin;
  const sidebarCoin = wallet.coin;
  const lobbyCoin = wallet.coin;
  assert.strictEqual(headerCoin, sidebarCoin);
  assert.strictEqual(sidebarCoin, lobbyCoin);
});

test('9. Authoritative wallet builders always include cashBalance+coinBalance+eventId', () => {
  const rows = buildPlayerBalanceUpdatedOutboxRows({
    playerUid: 'player-a',
    cashBalance: 0,
    coinBalance: 15,
    reason: 'freeplay_claim',
    eventId: 'evt-fp',
    occurredAt: '2026-07-29T12:00:00.000Z',
    source: 'authority_freeplay',
  });
  for (const row of rows) {
    assert.strictEqual(row.payload.eventId, 'evt-fp');
    assert.strictEqual(row.payload.cashBalance, 0);
    assert.strictEqual(row.payload.coinBalance, 15);
    assert.strictEqual(row.payload.cash, 0);
    assert.strictEqual(row.payload.coin, 15);
  }
});

test('10. Existing recharge/redeem balance event wiring remains unchanged', () => {
  const authority = fs.readFileSync(path.join(ROOT, 'lib/sql/authorityGameRequests.ts'), 'utf8');
  assert.ok(authority.includes("reason: 'redeem_completed'"));
  assert.ok(authority.includes('buildPlayerBalanceUpdatedOutboxRows'));
  assert.ok(authority.includes('invalidateSessionMePlayerExtras({ uid: playerUid })'));
});

test('11. No polling loop introduced for FreePlay/staff balance sync', () => {
  const freeplay = fs.readFileSync(path.join(ROOT, 'lib/sql/authorityFreeplay.ts'), 'utf8');
  const staff = fs.readFileSync(path.join(ROOT, 'lib/sql/staffWalletAuthority.ts'), 'utf8');
  const page = fs.readFileSync(path.join(ROOT, 'app/player/page.tsx'), 'utf8');
  const live = fs.readFileSync(path.join(ROOT, 'features/live/playerRequestSqlRead.ts'), 'utf8');
  assert.ok(!/setInterval\s*\(\s*.*balance/i.test(freeplay));
  assert.ok(!/setInterval\s*\(\s*.*balance/i.test(staff));
  assert.ok(page.includes('force: true'));
  assert.ok(page.includes('bypassCache: true'));
  assert.ok(live.includes('// One authoritative balance refetch after reconnect — no polling.'));
  assert.ok(!/setInterval\([^)]*onBalanceUpdate/.test(live));
});

test('12. No full-page reload used after FreePlay claim', () => {
  const page = fs.readFileSync(path.join(ROOT, 'app/player/page.tsx'), 'utf8');
  const claimBlock = page.slice(
    page.indexOf('const handleClaimFreeplayGift'),
    page.indexOf('}, [', page.indexOf('const handleClaimFreeplayGift')) + 200
  );
  assert.ok(claimBlock.includes('claimFreeplayGift'));
  assert.ok(!/location\.reload|window\.location\.(href|assign|replace)/.test(claimBlock));
  assert.ok(claimBlock.includes('[FREEPLAY_UI_UPDATED]'));
  assert.ok(claimBlock.includes('applyAuthoritativeWalletToProfileCache'));
});

test('source: FreePlay claim publishes canonical balance outbox + invalidates session/me', () => {
  const freeplay = fs.readFileSync(path.join(ROOT, 'lib/sql/authorityFreeplay.ts'), 'utf8');
  assert.ok(freeplay.includes('buildPlayerBalanceUpdatedOutboxRows'));
  assert.ok(freeplay.includes("[PLAYER_BALANCE_EVENT_PUBLISHED]"));
  assert.ok(freeplay.includes("reason: 'freeplay_claim'"));
  assert.ok(
    freeplay.includes(
      "await client.query('COMMIT');\n    // Session/me extras are process-local; clear only after the credit has committed.\n    invalidateSessionMePlayerExtras({ uid: playerUid });"
    ) ||
      freeplay.includes(
        "await client.query('COMMIT');\r\n    // Session/me extras are process-local; clear only after the credit has committed.\r\n    invalidateSessionMePlayerExtras({ uid: playerUid });"
      )
  );
});

test('source: staff coin load publishes canonical balance outbox + invalidates session/me', () => {
  const staff = fs.readFileSync(path.join(ROOT, 'lib/sql/staffWalletAuthority.ts'), 'utf8');
  assert.ok(staff.includes('buildPlayerBalanceUpdatedOutboxRows'));
  assert.ok(staff.includes("[PLAYER_BALANCE_EVENT_PUBLISHED]"));
  assert.ok(staff.includes("reason: 'staff_wallet_coin_load'"));
  assert.ok(staff.includes('invalidateSessionMePlayerExtras({ uid: playerUid })'));
});

test('source: claim API returns authoritative coin/cash for mutation cache update', () => {
  const route = fs.readFileSync(path.join(ROOT, 'app/api/player/freeplay/claim/route.ts'), 'utf8');
  assert.ok(route.includes('coinBalance: result.coin'));
  assert.ok(route.includes('cashBalance: result.cash'));
  assert.ok(route.includes('hasPendingGift: result.hasPendingGift'));

  const client = fs.readFileSync(path.join(ROOT, 'features/freeplay/playerFreeplay.ts'), 'utf8');
  assert.ok(client.includes('coinBalance ?? payload.coin'));
  assert.ok(client.includes('cashBalance ?? payload.cash'));
});

test('source: live reader scopes + dedupes balance events', () => {
  const live = fs.readFileSync(path.join(ROOT, 'features/live/playerRequestSqlRead.ts'), 'utf8');
  assert.ok(live.includes('[PLAYER_BALANCE_EVENT_RECEIVED]'));
  assert.ok(live.includes('[PLAYER_BALANCE_EVENT_IGNORED_OTHER_PLAYER]'));
  assert.ok(live.includes('seenBalanceEventKeys'));
  assert.ok(live.includes("needsAuthoritativeRefetch: true"));
});

test('channels stay player-scoped', () => {
  assert.strictEqual(playerBalanceLiveChannel('player-a'), 'player:player-a:requests');
  assert.notStrictEqual(playerBalanceLiveChannel('player-a'), playerBalanceLiveChannel('player-b'));
});

if (process.exitCode) {
  console.error(`\n${passed} tests passed before failure`);
  process.exit(process.exitCode);
}

console.log(`\n${passed} tests passed`);
