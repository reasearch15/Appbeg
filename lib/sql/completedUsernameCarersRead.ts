import 'server-only';

import { normalizeGameName } from '@/lib/sql/authorityGameRequestHelpers';
import { isPlayerVerboseLogs, SQL_QUERY_SLOW_MS } from '@/lib/server/verboseLogs';
import {
  cleanText,
  getPlayerMirrorPool,
  runMirrorPoolQuery,
} from '@/lib/sql/playerMirrorCommon';

const COMPLETED_USERNAME_TASK_TYPES = [
  'create_game_username',
  'recreate_username',
  'reset_password',
] as const;

const COMPLETED_USERNAME_CARERS_SQL = `
  SELECT
    normalized_game_name,
    game_name,
    completed_by_carer_username,
    assigned_carer_username
  FROM public.carer_tasks_cache
  WHERE deleted_at IS NULL
    AND player_uid = $1
    AND status = 'completed'
    AND type = ANY($2::text[])
`;

export type CompletedUsernameCarersMap = Record<string, string[]>;

function carerDisplayName(row: Record<string, unknown>) {
  return (
    cleanText(row.completed_by_carer_username) ||
    cleanText(row.assigned_carer_username) ||
    'Carer'
  );
}

function resolveNormalizedGame(row: Record<string, unknown>) {
  return (
    normalizeGameName(cleanText(row.normalized_game_name)) ||
    normalizeGameName(cleanText(row.game_name))
  );
}

export function buildCompletedUsernameCarersMap(
  rows: Record<string, unknown>[]
): CompletedUsernameCarersMap {
  const mapping: CompletedUsernameCarersMap = {};

  for (const row of rows) {
    const normalizedGame = resolveNormalizedGame(row);
    if (!normalizedGame) {
      continue;
    }

    const carerName = carerDisplayName(row);
    if (!mapping[normalizedGame]) {
      mapping[normalizedGame] = [];
    }
    if (!mapping[normalizedGame].includes(carerName)) {
      mapping[normalizedGame].push(carerName);
    }
  }

  return mapping;
}

export async function readCompletedUsernameCarersByPlayer(
  playerUid: string
): Promise<CompletedUsernameCarersMap | null> {
  const cleanPlayerUid = cleanText(playerUid);
  const db = getPlayerMirrorPool();
  if (!db || !cleanPlayerUid) {
    return null;
  }

  const startedAt = Date.now();
  try {
    const { rows } = await runMirrorPoolQuery<Record<string, unknown>>(
      db,
      COMPLETED_USERNAME_CARERS_SQL,
      [cleanPlayerUid, COMPLETED_USERNAME_TASK_TYPES],
      { context: 'completed_username_carers_read' }
    );
    const mapping = buildCompletedUsernameCarersMap(rows);
    const durationMs = Date.now() - startedAt;
    if (process.env.NODE_ENV !== 'production' && (isPlayerVerboseLogs() || durationMs >= SQL_QUERY_SLOW_MS)) {
      console.info('[COMPLETED_USERNAME_CARERS_SQL_READ]', {
        playerUid: cleanPlayerUid,
        source: 'sql',
        count: Object.keys(mapping).length,
        firestoreAttempted: false,
        durationMs,
      });
    }
    return mapping;
  } catch (error) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[COMPLETED_USERNAME_CARERS_SQL_READ]', {
        playerUid: cleanPlayerUid,
        source: 'sql',
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
      });
    }
    return null;
  }
}
