'use client';

import type { Auth } from 'firebase/auth';
import type { Firestore } from 'firebase/firestore';
import type { FirebaseStorage } from 'firebase/storage';

import { INTERNAL_SQL_FIRESTORE_BLOCKED_MESSAGE } from '@/lib/client/sqlFirestoreError';

function firebaseRuntimeDisabledError(feature: string) {
  console.info('[FIREBASE_RUNTIME_DISABLED]', {
    feature,
    reason: 'postgres_sql_only_runtime',
  });
  return new Error(INTERNAL_SQL_FIRESTORE_BLOCKED_MESSAGE);
}

function disabledProxy<T extends object>(feature: string): T {
  return new Proxy({} as T, {
    get() {
      throw firebaseRuntimeDisabledError(feature);
    },
    set() {
      throw firebaseRuntimeDisabledError(feature);
    },
  });
}

export const app = null;
export const auth = { currentUser: null } as Auth;
export const storage = disabledProxy<FirebaseStorage>('firebase_storage');

export function getClientFirestore(context = 'firebase-client'): Firestore {
  throw firebaseRuntimeDisabledError(`firebase_firestore:${context}`);
}

export function getClientDb(context = 'firebase-client'): Firestore {
  return getClientFirestore(context);
}

export const db = disabledProxy<Firestore>('firebase_firestore_db');
