'use client';

import { playerDebugLog } from '@/lib/client/playerDebugLogs';

export async function migrateCredentialsAfterFirebaseLogin(password: string) {
  void password;
  playerDebugLog('[SQL_CREDENTIALS_MIGRATE] skipped', {
    reason: 'firebase_runtime_removed',
  });
  return null;
}
