'use client';

export async function migrateCredentialsAfterFirebaseLogin(password: string) {
  void password;
  console.info('[SQL_CREDENTIALS_MIGRATE] skipped', {
    reason: 'firebase_runtime_removed',
  });
  return null;
}
