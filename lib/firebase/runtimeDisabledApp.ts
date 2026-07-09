export function initializeApp(): never {
  throw new Error('Firebase App runtime is disabled. Use PostgreSQL APIs.');
}

export function getApps() {
  return [];
}

export function getApp(): never {
  throw new Error('Firebase App runtime is disabled. Use PostgreSQL APIs.');
}
