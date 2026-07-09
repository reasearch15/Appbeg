type Unsubscribe = () => void;

function disabledFirestoreError(operation: string): never {
  console.info('[FIREBASE_RUNTIME_DISABLED]', {
    package: 'firebase/firestore',
    operation,
    reason: 'postgres_sql_only_runtime',
  });
  throw new Error('Firestore runtime is disabled. Use PostgreSQL APIs.');
}

export function collection(...args: unknown[]) {
  return { type: 'collection', args };
}

export function doc(...args: unknown[]) {
  return { type: 'document', args };
}

export function query(...args: unknown[]) {
  return { type: 'query', args };
}

export function where(...args: unknown[]) {
  return { type: 'where', args };
}

export function orderBy(...args: unknown[]) {
  return { type: 'orderBy', args };
}

export function limit(...args: unknown[]) {
  return { type: 'limit', args };
}

export function startAfter(...args: unknown[]) {
  return { type: 'startAfter', args };
}

export function documentId() {
  return { type: 'documentId' };
}

export function serverTimestamp() {
  return new Date();
}

export function increment(value: number) {
  return { __op: 'increment', value };
}

export function arrayUnion(...values: unknown[]) {
  return { __op: 'arrayUnion', values };
}

export function arrayRemove(...values: unknown[]) {
  return { __op: 'arrayRemove', values };
}

export async function addDoc(): Promise<never> {
  return disabledFirestoreError('addDoc');
}

export async function deleteDoc(): Promise<never> {
  return disabledFirestoreError('deleteDoc');
}

export async function getDoc(): Promise<never> {
  return disabledFirestoreError('getDoc');
}

export async function getDocFromServer(): Promise<never> {
  return disabledFirestoreError('getDocFromServer');
}

export async function getDocs(): Promise<never> {
  return disabledFirestoreError('getDocs');
}

export async function getDocsFromServer(): Promise<never> {
  return disabledFirestoreError('getDocsFromServer');
}

export async function setDoc(): Promise<never> {
  return disabledFirestoreError('setDoc');
}

export async function updateDoc(): Promise<never> {
  return disabledFirestoreError('updateDoc');
}

export function onSnapshot(): Unsubscribe {
  disabledFirestoreError('onSnapshot');
}

export async function runTransaction(): Promise<never> {
  return disabledFirestoreError('runTransaction');
}

export function writeBatch() {
  disabledFirestoreError('writeBatch');
}
