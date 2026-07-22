'use client';

import { getLocalAppSessionId } from '@/features/auth/appSession';
import { playerDebugLog } from '@/lib/client/playerDebugLogs';
import {
  isClientSqlReadMode as isSqlReadModeFromFlags,
  isPublicSqlPlayerLoginEnabled,
} from '@/lib/client/sqlPublicFlags';

export function isClientSqlReadMode() {
  return isSqlReadModeFromFlags() || Boolean(getLocalAppSessionId());
}

export function logClientFirestoreSkipped(feature: string, extra?: Record<string, unknown>) {
  playerDebugLog('[CLIENT_FIRESTORE_SKIPPED]', {
    client_firestore_skipped: true,
    reason: 'sql_read_mode',
    feature,
    ...extra,
  });
}

export function logClientFirestoreRuntimeAudit(path?: string) {
  const sqlMode = isClientSqlReadMode();
  const resolvedPath =
    path ??
    (typeof window !== 'undefined' ? window.location.pathname || '' : '');
  playerDebugLog('[CLIENT_FIRESTORE_RUNTIME_AUDIT]', {
    path: resolvedPath,
    sqlMode,
    firestoreListenersAllowed: !sqlMode,
    firebaseAuthAllowed: isPublicSqlPlayerLoginEnabled() || !sqlMode,
    reason: sqlMode ? 'sql_read_mode_blocks_client_firestore' : 'legacy_firestore_allowed',
  });
}
