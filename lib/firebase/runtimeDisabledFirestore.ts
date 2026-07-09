type Unsubscribe = () => void;

function disabledFirestoreError(operation: string): never {
  console.info('[FIREBASE_RUNTIME_DISABLED]', {
    package: 'firebase/firestore',
    operation,
    reason: 'postgres_sql_only_runtime',
  });
  throw new Error('Firestore runtime is disabled. Use PostgreSQL APIs.');
}

export class Timestamp {
  readonly seconds: number;
  readonly nanoseconds: number;

  constructor(seconds: number, nanoseconds: number) {
    this.seconds = seconds;
    this.nanoseconds = nanoseconds;
  }

  static now() {
    return Timestamp.fromDate(new Date());
  }

  static fromDate(date: Date) {
    return new Timestamp(Math.floor(date.getTime() / 1000), (date.getTime() % 1000) * 1_000_000);
  }

  toDate() {
    return new Date(this.seconds * 1000 + Math.floor(this.nanoseconds / 1_000_000));
  }

  toMillis() {
    return this.toDate().getTime();
  }
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
