import fs from 'fs';

const files = ['app/player/page.tsx', 'app/player/chat/page.tsx'];

const gatedPrefixes = [
  '[PLAYER_CHAT_READ]',
  '[PWA_BACK]',
  '[PLAYER_BASE_DATA_CLIENT]',
  '[PLAYER_SESSION_ME_REFETCH_DONE]',
];

for (const file of files) {
  let s = fs.readFileSync(file, 'utf8');
  if (file.includes('chat/page') && !s.includes("from '@/lib/client/playerDebugLogs'")) {
    s = s.replace(
      /^('use client';\r?\n)/,
      "$1import { playerDebugLog } from '@/lib/client/playerDebugLogs';\n"
    );
  }
  s = s.replace(/console\.info\(/g, (match, offset) => {
    const slice = s.slice(offset, offset + 400);
    if (gatedPrefixes.some((p) => slice.includes(p))) {
      return 'playerDebugLog(';
    }
    return match;
  });
  fs.writeFileSync(file, s);
  console.log('patched', file);
}
