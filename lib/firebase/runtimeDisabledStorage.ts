export function getStorage(): never {
  throw new Error('Firebase Storage runtime is disabled. Use PostgreSQL-backed upload APIs.');
}
