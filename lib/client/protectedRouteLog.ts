'use client';

import { playerDebugLog } from '@/lib/client/playerDebugLogs';
import type { UserRole } from '@/lib/auth/roles';

export function logProtectedRouteDecision(values: {
  path: string;
  uid: string | null;
  role: string | null;
  allowedRoles: UserRole[];
  decision: 'allow' | 'redirect' | 'deny' | 'checking';
  redirectTo?: string | null;
  reason: string;
}) {
  playerDebugLog('[PROTECTED_ROUTE_DECISION]', values);
}

export function currentClientPath() {
  if (typeof window === 'undefined') {
    return '';
  }
  return window.location.pathname || '';
}
