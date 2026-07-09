import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import type { Auth } from 'firebase-admin/auth';
import type { Firestore } from 'firebase-admin/firestore';

import { createGuardedFirestore } from '@/lib/firebase/firestoreRuntimeGuard';

function requireServiceAccountBase64() {
  const base64 = String(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || '').trim();
  if (!base64) {
    throw new Error('Missing FIREBASE_SERVICE_ACCOUNT_BASE64');
  }
  return base64;
}

function getFirebaseAdminApp() {
  const existing = getApps()[0];
  if (existing) {
    return existing;
  }

  const serviceAccount = JSON.parse(
    Buffer.from(requireServiceAccountBase64(), 'base64').toString('utf8')
  );

  return initializeApp({
    credential: cert(serviceAccount),
  });
}

let authInstance: Auth | null = null;
let dbInstance: Firestore | null = null;

export function getAdminAuth() {
  if (!authInstance) {
    authInstance = getAuth(getFirebaseAdminApp());
  }
  return authInstance;
}

export function getAdminDb() {
  if (!dbInstance) {
    dbInstance = createGuardedFirestore(getFirestore(getFirebaseAdminApp()));
  }
  return dbInstance;
}

function lazyProxy<T extends object>(factory: () => T): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      const instance = factory();
      const value = Reflect.get(instance, prop, instance);
      return typeof value === 'function' ? value.bind(instance) : value;
    },
    set(_target, prop, value) {
      const instance = factory();
      return Reflect.set(instance, prop, value, instance);
    },
    has(_target, prop) {
      return prop in factory();
    },
  });
}

export const adminAuth = lazyProxy<Auth>(getAdminAuth);
export const adminDb = lazyProxy<Firestore>(getAdminDb);
