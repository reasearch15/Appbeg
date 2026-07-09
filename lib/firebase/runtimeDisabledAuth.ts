export type User = {
  uid: string;
  getIdToken: () => Promise<string>;
};

type Unsubscribe = () => void;

function disabledAuthError(operation: string) {
  console.info('[FIREBASE_RUNTIME_DISABLED]', {
    package: 'firebase/auth',
    operation,
    reason: 'postgres_sql_only_runtime',
  });
  return new Error('Firebase Auth runtime is disabled. Use PostgreSQL app sessions.');
}

export function onAuthStateChanged(
  _auth: unknown,
  onNext: (user: User | null) => void
): Unsubscribe {
  queueMicrotask(() => onNext(null));
  return () => {};
}

export async function signOut() {
  return undefined;
}

export async function signInWithCustomToken(): Promise<never> {
  throw disabledAuthError('signInWithCustomToken');
}
