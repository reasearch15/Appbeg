import 'server-only';

import type { Pool, PoolClient } from 'pg';

import {
  cleanVendorText,
  noVendor,
  type VendorAwareness,
  type VendorAwarePlayer,
  vendorUnavailable,
} from '@/features/vendors/vendorAwareness';
import {
  getPlayerMirrorPool,
  runMirrorClientQuery,
  runMirrorPoolQuery,
  toIsoString,
} from '@/lib/sql/playerMirrorCommon';

type QueryTarget = {
  client?: PoolClient | null;
  pool?: Pool | null;
  authoritativeSource?: boolean;
};

function uniquePlayerUids(playerUids: unknown[]) {
  return [...new Set(playerUids.map((uid) => cleanVendorText(uid)).filter(Boolean))];
}

export function mapVendorOwnershipRow(row: Record<string, unknown>): VendorAwareness | null {
  const vendorCode = cleanVendorText(row.vendor_code);
  const vendorName = cleanVendorText(row.vendor_name);
  if (!vendorCode || !vendorName) {
    return null;
  }
  return {
    configured: true,
    owned: true,
    vendorId: Number.isFinite(Number(row.vendor_id)) ? Number(row.vendor_id) : null,
    name: vendorName,
    code: vendorCode,
    status: cleanVendorText(row.vendor_status) || 'active',
    linkedStaffUid: cleanVendorText(row.linked_staff_uid) || null,
    ownershipDate: toIsoString(row.linked_at),
  };
}

async function queryRows<T extends Record<string, unknown>>(
  sql: string,
  params: unknown[],
  target: QueryTarget
): Promise<T[]> {
  if (target.client) {
    const { rows } = await runMirrorClientQuery<T>(target.client, sql, params);
    return rows;
  }
  const pool = target.pool || getPlayerMirrorPool();
  if (!pool) {
    return [];
  }
  const { rows } = await runMirrorPoolQuery<T>(pool, sql, params, {
    context: 'vendor_ownership_read',
  });
  return rows;
}

async function vendorTablesExist(target: QueryTarget) {
  if (!target.authoritativeSource) {
    return false;
  }
  try {
    const rows = await queryRows<{
      vendor_players_table: string | null;
      vendors_table: string | null;
    }>(
      `
        SELECT
          to_regclass('public.vendor_players')::text AS vendor_players_table,
          to_regclass('public.vendors')::text AS vendors_table
      `,
      [],
      target
    );
    return Boolean(rows[0]?.vendor_players_table && rows[0]?.vendors_table);
  } catch (error) {
    console.warn('[VENDOR_AWARENESS] table check failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function readVendorAwarenessByPlayerUids(
  playerUids: unknown[],
  target: QueryTarget = {}
): Promise<Map<string, VendorAwareness>> {
  const uids = uniquePlayerUids(playerUids);
  if (!uids.length) {
    return new Map();
  }
  if (!(await vendorTablesExist(target))) {
    return new Map(uids.map((uid) => [uid, vendorUnavailable()]));
  }

  try {
    const rows = await queryRows<Record<string, unknown>>(
      `
        SELECT DISTINCT ON (vp.appbeg_player_uid)
          vp.appbeg_player_uid,
          vp.linked_at,
          v.id AS vendor_id,
          v.name AS vendor_name,
          v.vendor_code,
          v.status AS vendor_status,
          v.linked_staff_uid
        FROM public.vendor_players vp
        JOIN public.vendors v ON v.id = vp.vendor_id
        WHERE vp.appbeg_player_uid = ANY($1::text[])
        ORDER BY vp.appbeg_player_uid, vp.linked_at DESC NULLS LAST, vp.id DESC
      `,
      [uids],
      target
    );

    const vendorsByPlayerUid = new Map<string, VendorAwareness>();
    for (const row of rows) {
      const uid = cleanVendorText(row.appbeg_player_uid);
      const vendor = mapVendorOwnershipRow(row);
      if (uid && vendor) {
        vendorsByPlayerUid.set(uid, vendor);
      }
    }
    for (const uid of uids) {
      if (!vendorsByPlayerUid.has(uid)) {
        vendorsByPlayerUid.set(uid, noVendor());
      }
    }
    return vendorsByPlayerUid;
  } catch (error) {
    console.warn('[VENDOR_AWARENESS] ownership read failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return new Map(uids.map((uid) => [uid, vendorUnavailable()]));
  }
}

export async function attachVendorAwarenessToPlayers<T extends VendorAwarePlayer>(
  players: T[],
  target: QueryTarget = {}
): Promise<T[]> {
  const vendorsByPlayerUid = await readVendorAwarenessByPlayerUids(
    players.map((player) => player.uid || player.playerUid),
    target
  );
  return players.map((player) => {
    const playerUid = cleanVendorText(player.uid || player.playerUid);
    return {
      ...player,
      vendor: playerUid ? (vendorsByPlayerUid.get(playerUid) || noVendor()) : vendorUnavailable(),
    };
  });
}
