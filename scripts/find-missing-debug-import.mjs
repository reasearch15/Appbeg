import fs from 'fs';
import { execSync } from 'child_process';

const files = execSync('git ls-files', { encoding: 'utf8' })
  .trim()
  .split(/\r?\n/)
  .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));

const issues = [];
for (const f of files) {
  const s = fs.readFileSync(f, 'utf8');
  if (!s.includes('playerDebugLog') && !s.includes('playerStartupDebugLog')) continue;
  if (f.includes('playerDebugLogs.ts')) continue;

  const hasImport =
    /import\s*\{[^}]*player(Debug|Startup)DebugLog/.test(s) ||
    /import\s+player(Debug|Startup)DebugLog/.test(s);

  const uses =
    /\bplayerDebugLog\s*\(/.test(s) || /\bplayerStartupDebugLog\s*\(/.test(s);

  if (uses && !hasImport) {
    issues.push(`${f}: missing import`);
  }

  // Inline script / template misuse (not module calls)
  const inline = s.match(/`[^`]*\bplayerDebugLog\s*\(/);
  if (inline) {
    issues.push(`${f}: playerDebugLog inside template string`);
  }
}

console.log(issues.join('\n') || '(none)');
