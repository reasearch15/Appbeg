'use client';

import { playerDebugLog } from '@/lib/client/playerDebugLogs';
import {
  getDoc,
  getDocs,
  onSnapshot,
  type DocumentReference,
  type DocumentSnapshot,
  type Query,
  type QuerySnapshot,
  type Unsubscribe,
} from 'firebase/firestore';

import { isClientSqlReadMode } from '@/lib/client/sqlReadMode';

export type ClientFirestoreQueryMeta = {
  file: string;
  hook: string;
  collection: string;
  where?: unknown;
  orderBy?: unknown;
  route?: string;
};

function resolveClientRoute(explicit?: string) {
  if (explicit) {
    return explicit;
  }
  if (typeof window !== 'undefined') {
    return window.location.pathname || '';
  }
  return '';
}

export function logClientFirestoreQuery(meta: ClientFirestoreQueryMeta) {
  const sqlMode = isClientSqlReadMode();
  playerDebugLog('[CLIENT_FIRESTORE_QUERY]', {
    file: meta.file,
    feature: meta.hook,
    collection: meta.collection,
    operation: 'query',
    where: meta.where ?? null,
    orderBy: meta.orderBy ?? null,
    sqlMode,
    skipped: sqlMode,
    reason: sqlMode ? 'sql_read_mode' : 'firestore_allowed',
    route: resolveClientRoute(meta.route),
  });
}

export function logClientFirestoreQueryError(input: {
  file: string;
  collection: string;
  error: unknown;
}) {
  console.error('[CLIENT_FIRESTORE_QUERY_ERROR]', {
    file: input.file,
    collection: input.collection,
    error: input.error instanceof Error ? input.error.message : String(input.error),
  });
}

export async function clientGetDoc<T>(
  ref: DocumentReference<T>,
  meta: Omit<ClientFirestoreQueryMeta, 'route'>
) {
  logClientFirestoreQuery(meta);
  try {
    return await getDoc(ref);
  } catch (error) {
    logClientFirestoreQueryError({
      file: meta.file,
      collection: meta.collection,
      error,
    });
    throw error;
  }
}

export async function clientGetDocs<T>(
  firestoreQuery: Query<T>,
  meta: Omit<ClientFirestoreQueryMeta, 'route'>
) {
  logClientFirestoreQuery(meta);
  try {
    return await getDocs(firestoreQuery);
  } catch (error) {
    logClientFirestoreQueryError({
      file: meta.file,
      collection: meta.collection,
      error,
    });
    throw error;
  }
}

export function clientOnSnapshot<T>(
  firestoreQuery: Query<T>,
  meta: Omit<ClientFirestoreQueryMeta, 'route'>,
  onNext: (snapshot: QuerySnapshot<T>) => void,
  onError?: (error: Error) => void
): Unsubscribe {
  if (isClientSqlReadMode()) {
    logClientFirestoreQuery(meta);
    return () => {};
  }
  logClientFirestoreQuery(meta);
  return onSnapshot(
    firestoreQuery,
    onNext,
    (error) => {
      logClientFirestoreQueryError({
        file: meta.file,
        collection: meta.collection,
        error,
      });
      onError?.(error as Error);
    }
  );
}

export function clientOnSnapshotDoc<T>(
  ref: DocumentReference<T>,
  meta: Omit<ClientFirestoreQueryMeta, 'route'>,
  onNext: (snapshot: DocumentSnapshot<T>) => void,
  onError?: (error: Error) => void
): Unsubscribe {
  if (isClientSqlReadMode()) {
    logClientFirestoreQuery(meta);
    return () => {};
  }
  logClientFirestoreQuery(meta);
  return onSnapshot(
    ref,
    onNext,
    (error) => {
      logClientFirestoreQueryError({
        file: meta.file,
        collection: meta.collection,
        error,
      });
      onError?.(error as Error);
    }
  );
}
