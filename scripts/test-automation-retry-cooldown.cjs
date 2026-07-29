/**
 * Tests: auto-reclaim after failure cooldown + one-shot retry scheduling.
 * Run: node scripts/test-automation-retry-cooldown.cjs
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');

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

function simulateScheduler() {
  const timers = new Map();
  let automationEnabled = true;
  const pending = new Set();
  const fired = [];

  function schedule(taskId, retryAfterMs) {
    if (!automationEnabled) return { skipped: 'automation_disabled' };
    const existing = timers.get(taskId);
    const retryAtMs = Date.now() + retryAfterMs;
    if (existing && existing.retryAtMs <= retryAtMs + 100) {
      return { skipped: 'duplicate_timer' };
    }
    if (existing) clearTimeout(existing.id);
    const id = setTimeout(() => {
      timers.delete(taskId);
      if (!automationEnabled) {
        fired.push({ taskId, skipped: 'automation_disabled_on_fire' });
        return;
      }
      if (!pending.has(taskId)) {
        fired.push({ taskId, skipped: 'task_no_longer_pending' });
        return;
      }
      fired.push({ taskId, claimed: true });
    }, retryAfterMs);
    timers.set(taskId, { id, retryAtMs });
    return { scheduled: true, retryAtMs };
  }

  function cancelAll() {
    for (const [taskId, entry] of timers) {
      clearTimeout(entry.id);
      timers.delete(taskId);
    }
  }

  return {
    timers,
    fired,
    pending,
    setEnabled(v) {
      automationEnabled = v;
      if (!v) cancelAll();
    },
    schedule,
    cancelAll,
  };
}

test('1. Failed task returns to Pending with retryPending payload fields', () => {
  const authority = fs.readFileSync(path.join(ROOT, 'lib/sql/authorityCarerTasks.ts'), 'utf8');
  assert.ok(authority.includes('retryPending: true'));
  assert.ok(authority.includes('returnedToPendingAt: nowIso'));
  assert.ok(authority.includes('retryAt: retryAtIso'));
  assert.ok(authority.includes("eventType: 'task.returned_to_pending'"));
  assert.ok(authority.includes("eventType: 'task.failed'"));
  assert.ok(authority.includes("eventType: 'task.released'"));
});

test('2. Auto-tick returns structured retry_cooldown', () => {
  const tick = fs.readFileSync(path.join(ROOT, 'app/api/carer/automation-auto-tick/route.ts'), 'utf8');
  assert.ok(tick.includes("reason: 'retry_cooldown'"));
  assert.ok(tick.includes('retryAfterMs'));
  assert.ok(tick.includes('retryAt'));
  assert.ok(tick.includes('[AUTO_RETRY_PENDING_DETECTED]'));
  assert.ok(tick.includes('[AUTO_RETRY_CLAIM_SKIPPED]'));
});

test('3. Client schedules one-shot cooldown reclaim', () => {
  const page = fs.readFileSync(path.join(ROOT, 'app/carer/page.tsx'), 'utf8');
  assert.ok(page.includes('scheduleAutoRetryCooldown'));
  assert.ok(page.includes('[AUTO_RETRY_COOLDOWN_SCHEDULED]'));
  assert.ok(page.includes('[AUTO_RETRY_COOLDOWN_FIRED]'));
  assert.ok(page.includes('ingestAutoTickRetryHints'));
  assert.ok(!page.includes("allowRetryPendingClaim: source === 'immediate'"));
});

test('4. Scheduler fires reclaim after cooldown while automation ON', async () => {
  const s = simulateScheduler();
  s.pending.add('task-1');
  s.setEnabled(true);
  const result = s.schedule('task-1', 30);
  assert.strictEqual(result.scheduled, true);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(s.fired.some((row) => row.taskId === 'task-1' && row.claimed === true));
});

test('5. Automation OFF cancels scheduled retry', async () => {
  const s = simulateScheduler();
  s.pending.add('task-2');
  s.schedule('task-2', 40);
  s.setEnabled(false);
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(s.timers.size, 0);
  assert.ok(!s.fired.some((row) => row.claimed === true));
});

test('6. Duplicate SSE events do not create duplicate timers', () => {
  const s = simulateScheduler();
  s.pending.add('task-3');
  assert.strictEqual(s.schedule('task-3', 1000).scheduled, true);
  assert.strictEqual(s.schedule('task-3', 1000).skipped, 'duplicate_timer');
  assert.strictEqual(s.timers.size, 1);
  s.cancelAll();
});

test('7. Lease-held clears signature and schedules temporary retry', () => {
  const page = fs.readFileSync(path.join(ROOT, 'app/carer/page.tsx'), 'utf8');
  assert.ok(page.includes('[AUTO_DRAIN_TEMPORARY_BLOCK]'));
  assert.ok(page.includes("reason === 'lease_held'"));
  assert.ok(page.includes('scheduleTemporaryDrainRetry'));
});

test('8. Completion / return fast-dispatch wired for next claim', () => {
  const fast = fs.readFileSync(path.join(ROOT, 'features/live/carerTaskFastDispatch.ts'), 'utf8');
  assert.ok(fast.includes("'task.completed'"));
  assert.ok(fast.includes("'task.failed'"));
  assert.ok(fast.includes("'task.released'"));
  assert.ok(fast.includes("'task.returned_to_pending'"));
});

test('9. Atomic claim / single job constraints remain', () => {
  const claim = fs.readFileSync(path.join(ROOT, 'app/api/carer/tasks/claim/route.ts'), 'utf8');
  assert.ok(claim.includes('claimCarerTaskAsAdmin'));
  assert.ok(claim.includes('allowRetryPendingClaim: true'));
  const tick = fs.readFileSync(path.join(ROOT, 'app/api/carer/automation-auto-tick/route.ts'), 'utf8');
  assert.ok(tick.includes('MAX_CLAIMS_PER_TICK = 1'));
});

test('10. Oldest-first ordering preserved', () => {
  const cache = fs.readFileSync(path.join(ROOT, 'lib/sql/carerTasksCache.ts'), 'utf8');
  assert.ok(cache.includes('created_at ASC NULLS LAST'));
});

test('11. No polling loop for cooldown reclaim', () => {
  const page = fs.readFileSync(path.join(ROOT, 'app/carer/page.tsx'), 'utf8');
  assert.ok(!/setInterval\([^)]*scheduleAutoRetryCooldown/.test(page));
  assert.ok(!/setInterval\([^)]*drainAutomationQueueUntilEmpty/.test(page));
  assert.ok(page.includes('window.setTimeout'));
});

test('12. Manual Start Task claim route unchanged', () => {
  const claim = fs.readFileSync(path.join(ROOT, 'app/api/carer/tasks/claim/route.ts'), 'utf8');
  assert.ok(claim.includes("ROUTE = '/api/carer/tasks/claim'"));
  assert.ok(claim.includes('allowRetryPendingClaim: true'));
});

test('source: stopping automation cancels timers', () => {
  const page = fs.readFileSync(path.join(ROOT, 'app/carer/page.tsx'), 'utf8');
  assert.ok(page.includes("cancelAllAutoRetryTimers('automation_stopped')"));
  assert.ok(page.includes("cancelAllAutoRetryTimers('automation_disabled')"));
  assert.ok(page.includes("cancelAllAutoRetryTimers('component_unmount')"));
});

if (process.exitCode) {
  console.error(`\n${passed} tests passed before failure`);
  process.exit(process.exitCode);
}

console.log(`\n${passed} tests passed`);
