'use client';

import { playerDebugLog } from '@/lib/client/playerDebugLogs';
import { getCachedSessionUser, getSessionUserOnce } from '@/features/auth/sessionUser';
import { getLocalAppSessionId } from '@/features/auth/appSession';
import { getLocalPlayerSessionId, getPlayerApiHeaders } from '@/features/auth/playerSession';
import { getStaffAppSessionApiHeaders } from '@/lib/client/staffApiHeaders';
import { getFirebaseApiHeaders } from '@/lib/firebase/apiClient';

async function resolveClientRole() {
  const cached = getCachedSessionUser();
  if (cached?.role) {
    return String(cached.role).toLowerCase();
  }
  const sessionUser = await getSessionUserOnce().catch(() => null);
  return String(sessionUser?.role || '').toLowerCase();
}

const STAFF_ROLES = new Set(['carer', 'staff', 'coadmin', 'admin']);

function isStaffRole(role: string) {
  return STAFF_ROLES.has(role);
}

function isPlayerRoute() {
  if (typeof window === 'undefined') {
    return false;
  }
  const pathname = window.location.pathname || '';
  return pathname === '/player' || pathname.startsWith('/player/');
}

/**
 * SQL read API headers: player routes use player session; staff/coadmin use app session only.
 */
export async function getSqlApiReadHeaders(contentType = false) {
  const role = await resolveClientRole();
  const playerRoute = isPlayerRoute();
  if (!playerRoute) {
    playerDebugLog('[PLAYER_SESSION_STATUS] skippedNonPlayerRoute', {
      pathname: typeof window === 'undefined' ? null : window.location.pathname || null,
      role: role || null,
      hasPlayerSessionId: Boolean(getLocalPlayerSessionId()),
    });
  }
  if (role === 'player' && playerRoute) {
    return getPlayerApiHeaders(contentType);
  }
  if (role === 'player' && !playerRoute) {
    playerDebugLog('[PLAYER_SESSION_STATUS] skippedNonPlayerRoute', {
      pathname: typeof window === 'undefined' ? null : window.location.pathname || null,
      role,
      hasPlayerSessionId: Boolean(getLocalPlayerSessionId()),
    });
  }
  if (role && isStaffRole(role)) {
    playerDebugLog('[PLAYER_SESSION_STATUS] skippedNonPlayerRole', {
      role,
      hasPlayerSessionId: Boolean(getLocalPlayerSessionId()),
    });
    return getStaffAppSessionApiHeaders(contentType);
  }
  const appSessionId = getLocalAppSessionId();
  const playerSessionId = getLocalPlayerSessionId();
  if (appSessionId && !playerSessionId) {
    return getStaffAppSessionApiHeaders(contentType);
  }
  if (appSessionId && playerSessionId) {
    const sessionUser = await getSessionUserOnce().catch(() => null);
    const resolvedRole = String(sessionUser?.role || '').toLowerCase();
    if (resolvedRole === 'player' && playerRoute) {
      return getPlayerApiHeaders(contentType);
    }
    if (resolvedRole === 'player' && !playerRoute) {
      playerDebugLog('[PLAYER_SESSION_STATUS] skippedNonPlayerRoute', {
        pathname: typeof window === 'undefined' ? null : window.location.pathname || null,
        role: resolvedRole,
        hasPlayerSessionId: Boolean(playerSessionId),
      });
      return getStaffAppSessionApiHeaders(contentType);
    }
    if (resolvedRole && isStaffRole(resolvedRole)) {
      playerDebugLog('[PLAYER_SESSION_STATUS] skippedNonPlayerRole', {
        role: resolvedRole,
        hasPlayerSessionId: Boolean(playerSessionId),
      });
      return getStaffAppSessionApiHeaders(contentType);
    }
    return getStaffAppSessionApiHeaders(contentType);
  }
  if (playerSessionId && playerRoute) {
    return getPlayerApiHeaders(contentType);
  }
  if (playerSessionId && !playerRoute) {
    playerDebugLog('[PLAYER_SESSION_STATUS] skippedNonPlayerRoute', {
      pathname: typeof window === 'undefined' ? null : window.location.pathname || null,
      role: role || null,
      hasPlayerSessionId: true,
    });
  }
  return getFirebaseApiHeaders(contentType);
}
