'use client';

import { playerDebugLog } from '@/lib/client/playerDebugLogs';
import { isClientSqlReadMode } from '@/lib/client/sqlReadMode';

export function logSqlClientMigration(values: {
  feature: string;
  oldFirebaseOperation: string;
  newSqlRoute: string;
  result: 'ok' | 'skipped' | 'error';
  fallbackUsed?: boolean;
  error?: string;
}) {
  playerDebugLog('[SQL_CLIENT_MIGRATION]', {
    feature: values.feature,
    oldFirebaseOperation: values.oldFirebaseOperation,
    newSqlRoute: values.newSqlRoute,
    sqlMode: isClientSqlReadMode(),
    result: values.result,
    fallbackUsed: values.fallbackUsed ?? false,
    ...(values.error ? { error: values.error } : {}),
  });
}

export function logClientFirebaseRuntimeRemoved(values: {
  feature: string;
  file: string;
  operation: string;
  replacement: string;
}) {
  playerDebugLog('[CLIENT_FIREBASE_RUNTIME_REMOVED]', values);
}

export function isSqlClientMigrationMode() {
  return isClientSqlReadMode();
}
