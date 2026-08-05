/**
 * CLI: reconcile Automatic Recharge Bonus artifacts for one request id.
 *
 * Usage:
 *   DATABASE_URL=... node scripts/reconcile-arb-request.cjs <requestId>
 *
 * Exit codes:
 *   0 — ok (no error-severity issues)
 *   1 — reconciliation errors or missing args
 *   2 — runtime failure
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const requestId = String(process.argv[2] || process.env.ARB_REQUEST_ID || '').trim();
const databaseUrl = String(
  process.env.DATABASE_URL || process.env.POSTGRES_URL || ''
).trim();

if (!databaseUrl) {
  console.error('DATABASE_URL (or POSTGRES_URL) is required.');
  process.exit(1);
}
if (!requestId) {
  console.error('Usage: node scripts/reconcile-arb-request.cjs <requestId>');
  process.exit(1);
}

process.env.DATABASE_URL = databaseUrl;

const loaded = new Map();
const originalResolveFilename = Module._resolveFilename;
const originalLoad = Module._load;

function compileTs(absPath) {
  const source = fs.readFileSync(absPath, 'utf8');
  const stripped = source.replace(/^import\s+['"]server-only['"];?\s*$/gm, '');
  return ts.transpileModule(stripped, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: absPath,
  }).outputText;
}

function resolveAlias(id) {
  if (id === 'server-only') return id;
  if (id.startsWith('@/')) {
    const rel = id.slice(2);
    const base = path.join(ROOT, rel);
    if (fs.existsSync(`${base}.ts`) && fs.statSync(`${base}.ts`).isFile()) {
      return `${base}.ts`;
    }
    if (fs.existsSync(`${base}.tsx`) && fs.statSync(`${base}.tsx`).isFile()) {
      return `${base}.tsx`;
    }
    if (fs.existsSync(path.join(base, 'index.ts'))) {
      return path.join(base, 'index.ts');
    }
    if (fs.existsSync(base) && fs.statSync(base).isFile()) return base;
  }
  return null;
}

Module._resolveFilename = function patchedResolve(request, parent, isMain, options) {
  if (request === 'server-only') return 'server-only';
  const aliased = resolveAlias(request);
  if (aliased) return aliased;
  return originalResolveFilename.call(this, request, parent, isMain, options);
};

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'server-only') return {};
  const aliased = resolveAlias(request);
  const target = aliased || request;
  if (typeof target === 'string' && (target.endsWith('.ts') || target.endsWith('.tsx'))) {
    if (loaded.has(target)) return loaded.get(target).exports;
    const compiled = compileTs(target);
    const moduleObj = new Module(target, parent);
    moduleObj.filename = target;
    moduleObj.paths = Module._nodeModulePaths(path.dirname(target));
    loaded.set(target, moduleObj);
    moduleObj._compile(compiled, target);
    return moduleObj.exports;
  }
  return originalLoad.call(this, request, parent, isMain);
};

async function main() {
  const reconcile = Module._load(
    path.join(ROOT, 'lib/sql/authorityAutomaticBonusReconcile.ts'),
    module,
    false
  );
  const report = await reconcile.reconcileArbGrantByRequestId(requestId);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
