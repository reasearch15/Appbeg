/**
 * Freeze check: Automatic Recharge Bonus financial writes may only occur via
 * the Phase 6 grant pipeline:
 *   planArbRechargeCompletionGrant (grantPlan.ts)
 *   → applyArbOnRechargeCompleteInTxn (authorityAutomaticBonusGrant.ts)
 *
 * Scans the repo for disallowed writers of type 'automatic_recharge_bonus'.
 *
 * Run: npm run test:arb-grant-freeze
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/** Only this module may insert automatic_recharge_bonus financial events. */
const ALLOWED_FE_WRITER = path.join(
  'lib',
  'sql',
  'authorityAutomaticBonusGrant.ts'
);

/** Paths that may mention the type without writing finances. */
const ALLOWLIST_PATH_FRAGMENTS = [
  path.join('lib', 'sql', 'authorityAutomaticBonusGrant.ts'),
  path.join('lib', 'sql', 'authorityAutomaticBonusReconcile.ts'),
  path.join('lib', 'sql', 'authorityAutomaticBonusHealth.ts'),
  path.join('lib', 'sql', 'authorityAutomaticBonusReport.ts'),
  path.join('lib', 'economy', 'automaticRechargeBonus'),
  path.join('scripts', 'test-authority-arb-grant.cjs'),
  path.join('scripts', 'test-authority-arb-report.cjs'),
  path.join('scripts', 'test-arb-grant-plan.cjs'),
  path.join('scripts', 'test-arb-grant-freeze.cjs'),
  path.join('scripts', 'reconcile-arb-request.cjs'),
  path.join('features', 'automaticRechargeBonus'),
  path.join('components', 'admin'),
  path.join('app', 'api', 'coadmin', 'automatic-recharge-bonus'),
  path.join('app', 'api', 'coadmin', 'players'),
  path.join('docs'),
  path.join('migrations'),
  path.join('canvases'),
  path.join('node_modules'),
  path.join('.next'),
];

const WRITE_PATTERNS = [
  /type\s*[:=]\s*['"]automatic_recharge_bonus['"]/,
  /['"]automatic_recharge_bonus['"]\s*,/,
  /INSERT\s+INTO\s+public\.financial_events_cache[\s\S]{0,400}automatic_recharge_bonus/i,
];

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === 'node_modules' ||
        entry.name === '.next' ||
        entry.name === '.git' ||
        entry.name === 'dist'
      ) {
        continue;
      }
      walk(full, out);
    } else if (/\.(ts|tsx|js|cjs|mjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function isAllowlisted(absPath) {
  const rel = path.relative(ROOT, absPath);
  return ALLOWLIST_PATH_FRAGMENTS.some((frag) => {
    const normalized = frag.split(path.sep).join(path.sep);
    return rel === normalized || rel.startsWith(normalized + path.sep);
  });
}

function looksLikeFinancialWrite(source) {
  // Ignore pure comments mentioning the type.
  const withoutBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const lines = withoutBlockComments.split(/\r?\n/);
  const code = lines
    .filter((line) => !/^\s*\/\//.test(line) && !/^\s*\*/.test(line))
    .join('\n');
  return WRITE_PATTERNS.some((re) => re.test(code));
}

let failed = 0;
const violations = [];

const files = walk(ROOT);
for (const file of files) {
  if (isAllowlisted(file)) continue;
  const source = fs.readFileSync(file, 'utf8');
  if (!source.includes('automatic_recharge_bonus')) continue;
  if (!looksLikeFinancialWrite(source)) continue;
  violations.push(path.relative(ROOT, file));
}

if (violations.length) {
  failed = 1;
  console.error('fail - ARB grant pipeline freeze violated');
  console.error(
    `Only ${ALLOWED_FE_WRITER} may write automatic_recharge_bonus financial events.`
  );
  for (const v of violations) {
    console.error(`  - ${v}`);
  }
} else {
  console.log('ok - ARB financial writes confined to grant pipeline');
  console.log(`sole writer: ${ALLOWED_FE_WRITER}`);
}

process.exitCode = failed;
