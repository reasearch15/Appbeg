'use client';

import { playerDebugLog } from '@/lib/client/playerDebugLogs';
import { isClientSqlReadMode, logClientFirestoreSkipped } from '@/lib/client/sqlReadMode';
import { isPublicSqlPlayerLoginEnabled } from '@/lib/client/sqlPublicFlags';

export type ClientFirestoreGuardMeta = {
  file: string;
  feature: string;
  collection: string;
  operation: 'onSnapshot' | 'getDoc' | 'getDocs' | 'query' | 'write';
};

export function isClientFirestoreHardBlocked() {
  return isClientSqlReadMode();
}

export function isFirebaseAuthAllowedForClient() {
  return isPublicSqlPlayerLoginEnabled() || !isClientSqlReadMode();
}

/**
 * Hard SQL-mode gate. Returns true when Firestore SDK must not be invoked.
 */
export function assertClientFirestoreDisabled(
  feature: string,
  operation: ClientFirestoreGuardMeta['operation'],
  extra?: Record<string, unknown>
) {
  if (!isClientFirestoreHardBlocked()) {
    return false;
  }

  playerDebugLog('[CLIENT_FIRESTORE_BLOCKED]', {
    feature,
    operation,
    sqlMode: true,
    ...extra,
  });
  logClientFirestoreSkipped(feature, { operation, blocked: true, ...extra });
  return true;
}

export function logClientFirestoreQuery(
  meta: ClientFirestoreGuardMeta & {
    sqlMode?: boolean;
    skipped?: boolean;
    reason?: string;
  }
) {
  const sqlMode = meta.sqlMode ?? isClientSqlReadMode();
  const skipped = meta.skipped ?? sqlMode;
  playerDebugLog('[CLIENT_FIRESTORE_QUERY]', {
    file: meta.file,
    feature: meta.feature,
    collection: meta.collection,
    operation: meta.operation,
    sqlMode,
    skipped,
    reason: meta.reason ?? (skipped ? 'sql_read_mode' : 'firestore_allowed'),
  });
}

export function shouldSkipClientFirestore(meta: ClientFirestoreGuardMeta) {
  if (!assertClientFirestoreDisabled(meta.feature, meta.operation, {
    file: meta.file,
    collection: meta.collection,
  })) {
    logClientFirestoreQuery({
      ...meta,
      sqlMode: false,
      skipped: false,
      reason: 'firestore_allowed',
    });
    return false;
  }

  logClientFirestoreQuery({
    ...meta,
    sqlMode: true,
    skipped: true,
    reason: 'sql_read_mode',
  });
  return true;
}

export function noopFirestoreUnsubscribe() {
  return () => {};
}
