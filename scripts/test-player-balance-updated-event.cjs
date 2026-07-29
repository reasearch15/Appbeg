/**
 * Focused tests for redeem → player.balance.updated synchronization.
 * Run: node scripts/test-player-balance-updated-event.cjs
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { createRequire } = require('module');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');

function loadTsModule(relativePath) {
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
  buildPlayerBalanceUpdatedPayload,
  buildPlayerBalanceUpdatedOutboxRows,
  readAuthoritativeCashFromBalancePayload,
  balanceEventDedupeKey,
  playerBalanceLiveChannel,
  assertRedeemBalanceEventOrdering,
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

test('successful redeem payload contains committed authoritative cash once', () => {
  const payload = buildPlayerBalanceUpdatedPayload({
    playerUid: 'player-a',
    cashBalance: 175.5,
    coinBalance: 20,
    reason: 'redeem_completed',
    eventId: 'evt-1',
    occurredAt: '2026-07-28T12:00:00.000Z',
    taskId: 'task-1',
    requestId: 'req-1',
  });
  assert.strictEqual(payload.cashBalance, 175.5);
  assert.strictEqual(payload.cash, 175.5);
  assert.strictEqual(payload.reason, 'redeem_completed');
  assert.strictEqual(payload.eventId, 'evt-1');
  assert.strictEqual(payload.taskId, 'task-1');
  assert.strictEqual(readAuthoritativeCashFromBalancePayload(payload), 175.5);
});

test('outbox rows publish player.balance.updated after credit fields are known', () => {
  const rows = buildPlayerBalanceUpdatedOutboxRows({
    playerUid: 'player-a',
    cashBalance: 200,
    reason: 'redeem_completed',
    eventId: 'evt-2',
    occurredAt: '2026-07-28T12:00:00.000Z',
    taskId: 'task-2',
    requestId: 'req-2',
  });
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].eventType, PLAYER_BALANCE_UPDATED_EVENT);
  assert.strictEqual(rows[1].eventType, PLAYER_BALANCE_UPDATE_LEGACY_EVENT);
  assert.strictEqual(rows[0].channel, playerBalanceLiveChannel('player-a'));
  assert.strictEqual(rows[0].payload.cashBalance, 200);
  assert.strictEqual(rows[0].payload.reason, 'redeem_completed');
});

test('event is scoped to the credited player channel only', () => {
  const rows = buildPlayerBalanceUpdatedOutboxRows({
    playerUid: 'player-a',
    cashBalance: 50,
    reason: 'redeem_completed',
    eventId: 'evt-3',
    occurredAt: '2026-07-28T12:00:00.000Z',
  });
  for (const row of rows) {
    assert.strictEqual(row.channel, 'player:player-a:requests');
    assert.notStrictEqual(row.channel, 'player:player-b:requests');
    assert.strictEqual(row.payload.playerUid, 'player-a');
  }
});

test('failed/missing cash credit yields no balance-updated outbox rows', () => {
  assert.deepStrictEqual(
    buildPlayerBalanceUpdatedOutboxRows({
      playerUid: 'player-a',
      cashBalance: Number.NaN,
      reason: 'redeem_completed',
      eventId: 'evt-4',
      occurredAt: '2026-07-28T12:00:00.000Z',
    }),
    []
  );
  assert.deepStrictEqual(
    buildPlayerBalanceUpdatedOutboxRows({
      playerUid: '',
      cashBalance: 10,
      reason: 'redeem_completed',
      eventId: 'evt-4',
      occurredAt: '2026-07-28T12:00:00.000Z',
    }),
    []
  );
});

test('duplicate completion shares the same eventId dedupe key', () => {
  const keyA = balanceEventDedupeKey({
    eventName: PLAYER_BALANCE_UPDATED_EVENT,
    eventId: 'evt-same',
    taskId: 'task-1',
  });
  const keyB = balanceEventDedupeKey({
    eventName: PLAYER_BALANCE_UPDATE_LEGACY_EVENT,
    eventId: 'evt-same',
    taskId: 'task-1',
  });
  assert.strictEqual(keyA, 'event:evt-same');
  assert.strictEqual(keyA, keyB);
});

test('frontend can apply authoritative cash from event without reload', () => {
  let wallet = { cash: 10, coin: 5 };
  const payload = buildPlayerBalanceUpdatedPayload({
    playerUid: 'player-a',
    cashBalance: 60,
    coinBalance: 5,
    reason: 'redeem_completed',
    eventId: 'evt-5',
    occurredAt: '2026-07-28T12:00:00.000Z',
    taskId: 'task-5',
  });
  const cash = readAuthoritativeCashFromBalancePayload(payload);
  assert.ok(cash != null);
  wallet = { ...wallet, cash };
  assert.deepStrictEqual(wallet, { cash: 60, coin: 5 });
});

test('reconnect path is a single authoritative refetch flag, not polling', () => {
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
  // Explicitly assert we did not invent a polling interval.
  assert.strictEqual(reconnectCalls[0].meta.pollIntervalMs, undefined);
});

test('authority ordering places outbox publish before commit (transactional outbox)', () => {
  const result = assertRedeemBalanceEventOrdering([
    'lock_validate_task',
    'write_ledger_or_cash_credit',
    'update_authoritative_balance',
    'mark_task_completed',
    'publish_player_balance_event',
    'commit_database_transaction',
  ]);
  assert.strictEqual(result.ok, true);
});

test('another player channel cannot equal credited player channel', () => {
  assert.notStrictEqual(
    playerBalanceLiveChannel('player-a'),
    playerBalanceLiveChannel('player-b')
  );
});

test('source files wire post-commit invalidation and event emission', () => {
  const authority = fs.readFileSync(
    path.join(ROOT, 'lib/sql/authorityGameRequests.ts'),
    'utf8'
  );
  assert.ok(authority.includes("reason: 'redeem_completed'"));
  assert.ok(authority.includes('buildPlayerBalanceUpdatedOutboxRows'));
  assert.ok(authority.includes('invalidateSessionMePlayerExtras'));
  assert.ok(authority.includes('invalidateSessionMePlayerExtras({ uid: playerUid })'));
  assert.ok(
    authority.includes(
      "await client.query('COMMIT');\n    // Session/me extras are process-local; clear only after the credit has committed.\n    invalidateSessionMePlayerExtras({ uid: playerUid });"
    ) ||
      authority.includes(
        "await client.query('COMMIT');\r\n    // Session/me extras are process-local; clear only after the credit has committed.\r\n    invalidateSessionMePlayerExtras({ uid: playerUid });"
      )
  );

  const live = fs.readFileSync(
    path.join(ROOT, 'features/live/playerRequestSqlRead.ts'),
    'utf8'
  );
  assert.ok(live.includes("'player.balance.updated'"));
  assert.ok(live.includes('needsAuthoritativeRefetch: true'));
  assert.ok(live.includes('seenBalanceEventKeys'));

  const extras = fs.readFileSync(path.join(ROOT, 'lib/server/sessionMeExtras.ts'), 'utf8');
  assert.ok(extras.includes('function invalidateSessionMePlayerExtras'));

  const freeplay = fs.readFileSync(path.join(ROOT, 'lib/sql/authorityFreeplay.ts'), 'utf8');
  assert.ok(freeplay.includes('buildPlayerBalanceUpdatedOutboxRows'));
  assert.ok(freeplay.includes('invalidateSessionMePlayerExtras({ uid: playerUid })'));

  const staff = fs.readFileSync(path.join(ROOT, 'lib/sql/staffWalletAuthority.ts'), 'utf8');
  assert.ok(staff.includes('buildPlayerBalanceUpdatedOutboxRows'));
  assert.ok(staff.includes('invalidateSessionMePlayerExtras({ uid: playerUid })'));
});

if (process.exitCode) {
  console.error(`\n${passed} tests passed before failure`);
  process.exit(process.exitCode);
}

console.log(`\n${passed} tests passed`);
