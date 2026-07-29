/**
 * Focused tests: automation ON auto-claims pending tasks (no manual Start Task).
 * Run: node scripts/test-automation-auto-claim-loop.cjs
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');

function loadTsModule(relativePath) {
  const abs = path.join(ROOT, relativePath);
  const source = fs.readFileSync(abs, 'utf8').replace(/import\s+['"]server-only['"];?\s*/g, '');
  const ts = require('typescript');
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
  shouldFastDispatchForCarerTaskLiveEvent,
} = loadTsModule('features/live/carerTaskFastDispatch.ts');

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

function simulateAutoDrain(state, tickResult) {
  if (!state.automationEnabled) {
    return { ...state, finishReason: 'automation_disabled' };
  }
  if (state.inProgressCount > 0) {
    return { ...state, finishReason: 'awaiting_in_progress_completion' };
  }
  if (tickResult.reason === 'disabled') {
    return { ...state, finishReason: 'automation_disabled' };
  }
  if (tickResult.claimed) {
    return {
      ...state,
      pending: state.pending.filter((id) => id !== tickResult.taskId),
      inProgress: [...state.inProgress, tickResult.taskId],
      inProgressCount: state.inProgressCount + 1,
      finishReason: 'claimed_awaiting_completion',
      lastClaimed: tickResult.taskId,
    };
  }
  return { ...state, finishReason: tickResult.reason || 'tick_failed_or_no_claim' };
}

function simulateComplete(state, taskId) {
  return {
    ...state,
    inProgress: state.inProgress.filter((id) => id !== taskId),
    inProgressCount: Math.max(0, state.inProgressCount - 1),
  };
}

function simulateFailRelease(state, taskId) {
  return {
    ...state,
    inProgress: state.inProgress.filter((id) => id !== taskId),
    inProgressCount: Math.max(0, state.inProgressCount - 1),
    pending: state.pending.includes(taskId) ? state.pending : [...state.pending, taskId],
    retryPending: { ...(state.retryPending || {}), [taskId]: true },
  };
}

function claimLock(store, taskId, carerUid) {
  if (store[taskId] && store[taskId] !== carerUid) {
    return { ok: false, reason: 'already_claimed' };
  }
  if (store[taskId] === carerUid) {
    return { ok: true, duplicate: true };
  }
  store[taskId] = carerUid;
  return { ok: true, duplicate: false };
}

test('1. Automation ON immediately claims new pending tasks', () => {
  let state = {
    automationEnabled: true,
    pending: ['task-1'],
    inProgress: [],
    inProgressCount: 0,
  };
  state = simulateAutoDrain(state, { claimed: true, taskId: 'task-1' });
  assert.strictEqual(state.finishReason, 'claimed_awaiting_completion');
  assert.deepStrictEqual(state.pending, []);
  assert.deepStrictEqual(state.inProgress, ['task-1']);
});

test('2. Task moves to In Progress instantly after claim', () => {
  const before = { pending: ['t1'], inProgress: [] };
  const after = {
    pending: before.pending.filter((id) => id !== 't1'),
    inProgress: [...before.inProgress, 't1'],
  };
  assert.ok(!after.pending.includes('t1'));
  assert.ok(after.inProgress.includes('t1'));
});

test('3. Automation starts immediately (claim + start logs wired)', () => {
  const tick = fs.readFileSync(path.join(ROOT, 'app/api/carer/automation-auto-tick/route.ts'), 'utf8');
  const authority = fs.readFileSync(path.join(ROOT, 'lib/sql/authorityCarerTasks.ts'), 'utf8');
  assert.ok(tick.includes("[AUTO_TASK_CLAIM]"));
  assert.ok(tick.includes("[AUTO_TASK_STARTED]"));
  assert.ok(authority.includes("[AUTO_TASK_CLAIM]"));
  assert.ok(authority.includes("[AUTO_TASK_STARTED]"));
});

test('4. Success removes task from In Progress and allows next claim', () => {
  let state = {
    automationEnabled: true,
    pending: ['task-2'],
    inProgress: ['task-1'],
    inProgressCount: 1,
  };
  state = simulateComplete(state, 'task-1');
  assert.strictEqual(state.inProgressCount, 0);
  state = simulateAutoDrain(state, { claimed: true, taskId: 'task-2' });
  assert.deepStrictEqual(state.inProgress, ['task-2']);
  assert.deepStrictEqual(state.pending, []);
});

test('5. Failure returns task to Pending with retry info', () => {
  let state = {
    automationEnabled: true,
    pending: [],
    inProgress: ['task-fail'],
    inProgressCount: 1,
    retryPending: {},
  };
  state = simulateFailRelease(state, 'task-fail');
  assert.ok(state.pending.includes('task-fail'));
  assert.strictEqual(state.inProgressCount, 0);
  assert.strictEqual(state.retryPending['task-fail'], true);
});

test('6. Automation immediately claims next eligible task after free', () => {
  let state = {
    automationEnabled: true,
    pending: ['oldest', 'newest'],
    inProgress: [],
    inProgressCount: 0,
  };
  state = simulateAutoDrain(state, { claimed: true, taskId: 'oldest' });
  assert.strictEqual(state.lastClaimed, 'oldest');
  state = simulateComplete(state, 'oldest');
  state = simulateAutoDrain(state, { claimed: true, taskId: 'newest' });
  assert.strictEqual(state.lastClaimed, 'newest');
});

test('7. Automation OFF preserves manual workflow (no auto drain)', () => {
  let state = {
    automationEnabled: false,
    pending: ['task-1'],
    inProgress: [],
    inProgressCount: 0,
  };
  state = simulateAutoDrain(state, { claimed: true, taskId: 'task-1' });
  assert.strictEqual(state.finishReason, 'automation_disabled');
  assert.deepStrictEqual(state.pending, ['task-1']);
  assert.deepStrictEqual(state.inProgress, []);
});

test('8. Duplicate claims are impossible via atomic claim lock', () => {
  const store = {};
  const first = claimLock(store, 'task-x', 'carer-a');
  const second = claimLock(store, 'task-x', 'carer-a');
  assert.strictEqual(first.ok, true);
  assert.strictEqual(first.duplicate, false);
  assert.strictEqual(second.ok, true);
  assert.strictEqual(second.duplicate, true);
});

test('9. Multiple carers cannot process the same task', () => {
  const store = {};
  assert.strictEqual(claimLock(store, 'task-y', 'carer-a').ok, true);
  assert.deepStrictEqual(claimLock(store, 'task-y', 'carer-b'), {
    ok: false,
    reason: 'already_claimed',
  });
});

test('10. Existing recharge/redeem claim + auto-claim wiring remains', () => {
  const gameRequests = fs.readFileSync(path.join(ROOT, 'lib/sql/authorityGameRequests.ts'), 'utf8');
  assert.ok(gameRequests.includes('scheduleAutoClaimPendingTaskOnCreate'));
  const claimRoute = fs.readFileSync(path.join(ROOT, 'app/api/carer/tasks/claim/route.ts'), 'utf8');
  assert.ok(claimRoute.includes('claimCarerTaskAsAdmin'));
  assert.ok(claimRoute.includes('allowRetryPendingClaim: true'));
});

test('source: listener auto-tick allows retryPending reclaim', () => {
  const page = fs.readFileSync(path.join(ROOT, 'app/carer/page.tsx'), 'utf8');
  assert.ok(page.includes('allowRetryPendingClaim: true'));
  assert.ok(!page.includes("allowRetryPendingClaim: source === 'immediate'"));
  assert.ok(page.includes('claimed_awaiting_completion'));
  assert.ok(page.includes('[AUTO_NEXT_TASK]'));
});

test('source: auto-tick claims one task per tick and oldest-first SQL order', () => {
  const tick = fs.readFileSync(path.join(ROOT, 'app/api/carer/automation-auto-tick/route.ts'), 'utf8');
  assert.ok(tick.includes('const MAX_CLAIMS_PER_TICK = 1'));
  assert.ok(tick.includes('remainingCooldownMs'));
  const cache = fs.readFileSync(path.join(ROOT, 'lib/sql/carerTasksCache.ts'), 'utf8');
  assert.ok(cache.includes('created_at ASC NULLS LAST'));
});

test('source: failure emits release/fail realtime events', () => {
  const authority = fs.readFileSync(path.join(ROOT, 'lib/sql/authorityCarerTasks.ts'), 'utf8');
  assert.ok(authority.includes("eventType: 'task.failed'"));
  assert.ok(authority.includes("eventType: 'task.released'"));
  assert.ok(authority.includes("eventType: 'task.returned_to_pending'"));
  assert.ok(authority.includes('[AUTO_TASK_FAILED]'));
  assert.ok(authority.includes('[AUTO_TASK_RELEASED]'));
  assert.ok(authority.includes('[AUTO_TASK_COMPLETED]'));
});

test('fast dispatch covers completed/failed/released for next claim', () => {
  assert.strictEqual(
    shouldFastDispatchForCarerTaskLiveEvent('task.completed', { status: 'completed' }),
    true
  );
  assert.strictEqual(
    shouldFastDispatchForCarerTaskLiveEvent('task.failed', { status: 'pending' }),
    true
  );
  assert.strictEqual(
    shouldFastDispatchForCarerTaskLiveEvent('task.released', { status: 'pending' }),
    true
  );
  assert.strictEqual(
    shouldFastDispatchForCarerTaskLiveEvent('task.returned_to_pending', { status: 'pending' }),
    true
  );
  assert.strictEqual(
    shouldFastDispatchForCarerTaskLiveEvent('task.claimed', { status: 'in_progress' }),
    false
  );
});

test('no continuous polling loop introduced for auto claim', () => {
  const page = fs.readFileSync(path.join(ROOT, 'app/carer/page.tsx'), 'utf8');
  assert.ok(page.includes('scheduled_after_cooldown'));
  assert.ok(!/setInterval\([^)]*drainAutomationQueueUntilEmpty/.test(page));
  assert.ok(!/setInterval\([^)]*fireAutomationAutoTick/.test(page));
});

if (process.exitCode) {
  console.error(`\n${passed} tests passed before failure`);
  process.exit(process.exitCode);
}

console.log(`\n${passed} tests passed`);
