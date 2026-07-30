import 'server-only';

import {
  cleanText,
  getPlayerMirrorPool,
} from '@/lib/sql/playerMirrorCommon';

export type StaffPlayerPrivilegeUpdateResult = {
  staffUid: string;
  username: string;
  coadminUid: string | null;
  previousCanViewPlayers: boolean;
  canViewPlayers: boolean;
  changed: boolean;
  timestamp: string;
};

export async function setStaffPlayerPrivilegeInSql(input: {
  staffUid: string;
  canViewPlayers: boolean;
  actorUid: string;
  actorRole: string;
  scopeUid?: string | null;
  isAdmin: boolean;
}): Promise<StaffPlayerPrivilegeUpdateResult | null> {
  const staffUid = cleanText(input.staffUid);
  const actorUid = cleanText(input.actorUid);
  const actorRole = cleanText(input.actorRole).toLowerCase();
  const scopeUid = cleanText(input.scopeUid) || null;
  const canViewPlayers = Boolean(input.canViewPlayers);

  if (!staffUid || !actorUid || !actorRole) {
    throw new Error('staffUid, actorUid, and actorRole are required.');
  }
  if (actorRole === 'staff') {
    throw new Error('Staff cannot update player privilege.');
  }
  if (!input.isAdmin && !scopeUid) {
    throw new Error('Your account is not linked to a coadmin scope.');
  }

  const db = getPlayerMirrorPool();
  if (!db) {
    throw new Error('Postgres is unavailable.');
  }

  const nowIso = new Date().toISOString();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query<Record<string, unknown>>(
      `
        SELECT uid, username, role, coadmin_uid, created_by, can_view_players
        FROM public.players_cache
        WHERE uid = $1::text
          AND deleted_at IS NULL
        FOR UPDATE
      `,
      [staffUid]
    );

    const row = existing.rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return null;
    }

    if (cleanText(row.role).toLowerCase() !== 'staff') {
      throw new Error('Target must be a staff account.');
    }

    const staffScopeUid = cleanText(row.coadmin_uid) || cleanText(row.created_by) || null;
    if (!input.isAdmin && staffScopeUid !== scopeUid) {
      await client.query('ROLLBACK');
      return null;
    }

    const previousCanViewPlayers = Boolean(row.can_view_players);
    const changed = previousCanViewPlayers !== canViewPlayers;
    if (changed) {
      await client.query(
        `
          UPDATE public.players_cache
          SET
            can_view_players = $2::boolean,
            updated_at = $3::timestamptz,
            raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb) || jsonb_build_object(
              'canViewPlayers', $2::boolean,
              'playerPrivilegeUpdatedAt', $3::text,
              'playerPrivilegeUpdatedByUid', $4::text,
              'playerPrivilegeUpdatedByRole', $5::text,
              'playerPrivilegePreviousValue', $6::boolean
            )
          WHERE uid = $1::text
            AND role = 'staff'
            AND deleted_at IS NULL
        `,
        [staffUid, canViewPlayers, nowIso, actorUid, actorRole, previousCanViewPlayers]
      );
    }

    await client.query('COMMIT');
    return {
      staffUid,
      username: cleanText(row.username),
      coadminUid: staffScopeUid,
      previousCanViewPlayers,
      canViewPlayers,
      changed,
      timestamp: nowIso,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
