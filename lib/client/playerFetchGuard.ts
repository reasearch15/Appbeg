'use client';

import { playerDebugLog } from '@/lib/client/playerDebugLogs';
import { getCachedSessionUser, getSessionUserOnce } from '@/features/auth/sessionUser';

export function logPlayerFetchBlockedRole(values: {
  route: string;
  uid: string | null;
  role: string | null;
  reason?: string;
}) {
  playerDebugLog('[PLAYER_FETCH_BLOCKED_ROLE]', {
    route: values.route,
    uid: values.uid,
    role: values.role,
    expectedRole: 'player',
    reason: values.reason || 'non_player_role',
  });
}

export async function resolvePlayerRoleForFetch(route: string) {
  const cached = getCachedSessionUser();
  const sessionUser =
    cached?.role === 'player' ? cached : await getSessionUserOnce().catch(() => null);

  if (!sessionUser || sessionUser.role !== 'player') {
    logPlayerFetchBlockedRole({
      route,
      uid: sessionUser?.uid ?? null,
      role: sessionUser?.role ?? null,
    });
    return null;
  }

  return sessionUser;
}
