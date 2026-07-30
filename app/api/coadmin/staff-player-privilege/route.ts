import { NextResponse } from 'next/server';

import { apiError, requireApiUser, scopedCoadminUid } from '@/lib/firebase/apiAuth';
import {
  authoritySqlWriteEnvLogFields,
  logAuthoritySqlWrite,
} from '@/lib/server/authoritySqlWrite';
import { setStaffPlayerPrivilegeInSql } from '@/lib/sql/staffPlayerPrivilege';

export const runtime = 'nodejs';

const ROUTE = '/api/coadmin/staff-player-privilege';

function statusForError(message: string) {
  if (/staff cannot|forbidden|not linked/i.test(message)) return 403;
  if (/target must/i.test(message)) return 403;
  if (/postgres|database|unavailable/i.test(message)) return 503;
  if (/required/i.test(message)) return 400;
  return 500;
}

export async function POST(request: Request) {
  try {
    const auth = await requireApiUser(request, ['admin', 'coadmin']);
    if ('response' in auth) {
      return auth.response;
    }

    const body = (await request.json().catch(() => ({}))) as {
      staffUid?: unknown;
      canViewPlayers?: unknown;
    };
    const staffUid = String(body.staffUid || '').trim();
    if (!staffUid) {
      return apiError('staffUid is required.', 400);
    }
    if (typeof body.canViewPlayers !== 'boolean') {
      return apiError('canViewPlayers must be boolean.', 400);
    }

    const result = await setStaffPlayerPrivilegeInSql({
      staffUid,
      canViewPlayers: body.canViewPlayers,
      actorUid: auth.user.uid,
      actorRole: auth.user.role,
      scopeUid: scopedCoadminUid(auth.user),
      isAdmin: auth.user.role === 'admin',
    });

    if (!result) {
      return apiError('Staff member not found.', 404);
    }

    if (result.changed) {
      logAuthoritySqlWrite(ROUTE, {
        ...authoritySqlWriteEnvLogFields(),
        eventType: 'staff_player_privilege_update',
        targetStaffId: result.staffUid,
        targetUsername: result.username,
        actorId: auth.user.uid,
        actorRole: auth.user.role,
        previousValue: result.previousCanViewPlayers,
        newValue: result.canViewPlayers,
        timestamp: result.timestamp,
      });
    }

    return NextResponse.json({
      ok: true,
      staffUid: result.staffUid,
      username: result.username,
      canViewPlayers: result.canViewPlayers,
      previousCanViewPlayers: result.previousCanViewPlayers,
      changed: result.changed,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to update player privilege.';
    return NextResponse.json({ error: message }, { status: statusForError(message) });
  }
}
