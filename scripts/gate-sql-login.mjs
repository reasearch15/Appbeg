import fs from 'fs';

const f = 'features/auth/sqlLogin.ts';
let s = fs.readFileSync(f, 'utf8');
s = s.replace(/console\.info\(/g, 'playerDebugLog(');
s = s.replace(
  "playerDebugLog('[SQL_AUTH_LOGIN] client_failed'",
  "playerRuntimeWarn('[SQL_AUTH_LOGIN] client_failed'"
);
fs.writeFileSync(f, s);
