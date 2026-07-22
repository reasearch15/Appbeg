import fs from 'fs';

const f = 'components/auth/ProtectedRoute.tsx';
let s = fs.readFileSync(f, 'utf8');
if (!s.includes("playerDebugLogs")) {
  s = s.replace(
    /^('use client';\r?\n\r?\n)/,
    "$1import { playerDebugLog, playerRuntimeWarn } from '@/lib/client/playerDebugLogs';\n"
  );
}
s = s.replace(
  /console\.info\('\[SESSION_GUARD\] old device kicked because session mismatch'/g,
  "playerRuntimeWarn('[SESSION_GUARD] old device kicked because session mismatch'"
);
s = s.replace(
  "console.info('[SESSION_GUARD] protected render blocked')",
  "playerDebugLog('[SESSION_GUARD] protected render blocked')"
);
// Failures: ok: false in nearby lines — use heuristic replace PROTECTED_ROUTE_AUTH console.info with playerDebugLog first
s = s.replace(/console\.info\('\[PROTECTED_ROUTE_AUTH\]'/g, "playerDebugLog('[PROTECTED_ROUTE_AUTH]'");
// Then fix failure lines back to warn where ok: false
const lines = s.split('\n');
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes("playerDebugLog('[PROTECTED_ROUTE_AUTH]'")) {
    const window = lines.slice(i, i + 8).join('\n');
    if (window.includes('ok: false')) {
      lines[i] = lines[i].replace('playerDebugLog', 'playerRuntimeWarn');
    }
  }
}
fs.writeFileSync(f, lines.join('\n'));
console.log('gated ProtectedRoute');
