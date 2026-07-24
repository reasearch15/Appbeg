import fs from 'fs';

const files = [
  'lib/client/playerAuthHealth.ts',
  'lib/client/sqlPlayerRuntimeAuth.ts',
  'lib/client/playerPageSessionGate.ts',
  'lib/client/protectedRouteLog.ts',
  'lib/client/sqlApiHeaders.ts',
  'lib/client/playerPollGuard.ts',
  'lib/client/sqlClientMigration.ts',
  'lib/client/clientFirestoreGuard.ts',
  'lib/client/clientFirestoreQuery.ts',
  'lib/client/sqlFirestoreError.ts',
  'lib/client/loginUiProgress.ts',
  'lib/client/loginRoleRedirect.ts',
  'lib/client/playerFetchGuard.ts',
  'lib/client/playerThemeAudioGuard.ts',
  'lib/client/carerPageRequestAudit.ts',
  'lib/client/sqlLogoutCleanup.ts',
  'features/player/playerBaseData.ts',
  'lib/pwa/installPromptStore.ts',
  'app/player/hooks/usePwaInstall.ts',
  'app/install/InstallPageClient.tsx',
];

const importLine =
  "import { playerDebugLog } from '@/lib/client/playerDebugLogs';\n";

for (const file of files) {
  let s = fs.readFileSync(file, 'utf8');
  if (!s.includes("from '@/lib/client/playerDebugLogs'")) {
    const useClient = s.startsWith("'use client'") || s.startsWith('"use client"');
    if (useClient) {
      s = s.replace(/^('use client';\r?\n\r?\n)/, `$1${importLine}`);
    } else {
      s = `${importLine}${s}`;
    }
  }
  s = s.replace(/console\.info\(/g, 'playerDebugLog(');
  fs.writeFileSync(file, s);
  console.log('gated', file);
}
