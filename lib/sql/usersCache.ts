import 'server-only';

import type { PoolClient } from 'pg';

import {
  cleanText,
  getPlayerMirrorPool,
  numberOrNull,
  runMirrorClientQuery,
  runMirrorPoolQuery,
  toIsoString,
} from '@/lib/sql/playerMirrorCommon';

export type DirectoryRole = 'admin' | 'staff' | 'carer' | 'coadmin' | 'player';

export type CachedDirectoryUser = {
  id: string;
  uid: string;
  username: string;
  email: string;
  role: DirectoryRole;
  status: 'active' | 'disabled';
  createdBy: string | null;
  coadminUid?: string | null;
  cashBoxNpr?: number;
  canViewPlayers?: boolean;
  paymentQrUrl?: string | null;
  paymentQrPublicId?: string | null;
  paymentDetails?: string | null;
  paymentDetailPhotoUrls?: string[] | null;
  paymentDetailPhotos?: Array<{
    imageUrl: string;
    imagePublicId: string;
  }> | null;
  coin?: number;
  cash?: number;
  totalRechargeAmount?: number;
  totalRedeemAmount?: number;
  totalRechargeCount?: number;
  totalRedeemCount?: number;
  createdAt?: string | null;
};

export type ReadUsersCacheByRoleOptions = {
  role: DirectoryRole;
  coadminUid?: string | null;
  status?: 'active' | 'disabled' | null;
  /** When false, exclude disabled/inactive rows. Default true unless status=active. */
  includeDisabled?: boolean;
};

function parseRawFirestoreData(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  if (typeof value === 'object') {
    return value as Record<string, unknown>;
  }
  return {};
}

function rawString(raw: Record<string, unknown>, key: string) {
  const value = raw[key];
  return value == null ? null : String(value);
}

function rawNumber(raw: Record<string, unknown>, key: string) {
  const value = raw[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function rawStringArray(raw: Record<string, unknown>, key: string) {
  const value = raw[key];
  if (!Array.isArray(value)) return undefined;
  return value.map((entry) => String(entry));
}

function rawPaymentPhotos(raw: Record<string, unknown>) {
  const value = raw.paymentDetailPhotos;
  if (!Array.isArray(value)) return undefined;
  const photos = value
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const photo = entry as Record<string, unknown>;
      const imageUrl = cleanText(photo.imageUrl);
      const imagePublicId = cleanText(photo.imagePublicId);
      if (!imageUrl || !imagePublicId) return null;
      return { imageUrl, imagePublicId };
    })
    .filter((entry): entry is { imageUrl: string; imagePublicId: string } => Boolean(entry));
  return photos.length > 0 ? photos : undefined;
}

function resolveCoadminUid(
  row: Record<string, unknown>,
  requestedCoadminUid: string | null
): string | null | undefined {
  const stored = cleanText(row.coadmin_uid) || null;
  if (stored) return stored;
  const createdBy = cleanText(row.created_by) || null;
  if (requestedCoadminUid && createdBy === requestedCoadminUid) {
    return requestedCoadminUid;
  }
  return createdBy || undefined;
}

function mapCachedDirectoryUserRow(
  row: Record<string, unknown>,
  requestedCoadminUid: string | null
): CachedDirectoryUser | null {
  const uid = cleanText(row.uid);
  const role = cleanText(row.role) as DirectoryRole;
  if (!uid || !role) {
    return null;
  }

  const raw = parseRawFirestoreData(row.raw_firestore_data);
  const status = (cleanText(row.status) || cleanText(raw.status) || 'active') as
    | 'active'
    | 'disabled';

  return {
    id: uid,
    uid,
    username: cleanText(row.username) || cleanText(raw.username),
    email: cleanText(row.email) || cleanText(raw.email),
    role,
    status,
    createdBy: cleanText(row.created_by) || cleanText(raw.createdBy) || null,
    coadminUid: resolveCoadminUid(row, requestedCoadminUid),
    cashBoxNpr: rawNumber(raw, 'cashBoxNpr'),
    canViewPlayers: role === 'staff' ? Boolean(row.can_view_players) : false,
    paymentQrUrl: rawString(raw, 'paymentQrUrl'),
    paymentQrPublicId: rawString(raw, 'paymentQrPublicId'),
    paymentDetails: rawString(raw, 'paymentDetails'),
    paymentDetailPhotoUrls: rawStringArray(raw, 'paymentDetailPhotoUrls') ?? null,
    paymentDetailPhotos: rawPaymentPhotos(raw) ?? null,
    coin: numberOrNull(row.coin) ?? rawNumber(raw, 'coin'),
    cash: numberOrNull(row.cash) ?? rawNumber(raw, 'cash'),
    totalRechargeAmount: rawNumber(raw, 'totalRechargeAmount'),
    totalRedeemAmount: rawNumber(raw, 'totalRedeemAmount'),
    totalRechargeCount: rawNumber(raw, 'totalRechargeCount'),
    totalRedeemCount: rawNumber(raw, 'totalRedeemCount'),
    createdAt: toIsoString(row.created_at) || toIsoString(raw.createdAt),
  };
}

function sortCachedDirectoryUsers(users: CachedDirectoryUser[]) {
  return users.sort((left, right) => {
    const leftTime = left.createdAt ? new Date(left.createdAt).getTime() : 0;
    const rightTime = right.createdAt ? new Date(right.createdAt).getTime() : 0;
    return rightTime - leftTime;
  });
}

function mapCachedDirectoryUserRows(
  rows: Record<string, unknown>[],
  requestedCoadminUid: string | null
) {
  return sortCachedDirectoryUsers(
    rows
      .map((row) => mapCachedDirectoryUserRow(row, requestedCoadminUid))
      .filter((user): user is CachedDirectoryUser => Boolean(user))
  );
}

function buildUsersCacheSql(options: ReadUsersCacheByRoleOptions) {
  const params: unknown[] = [options.role];
  const clauses = [
    'deleted_at IS NULL',
    'role = $1',
  ];

  if (options.coadminUid) {
    params.push(options.coadminUid);
    clauses.push(`(coadmin_uid = $${params.length} OR created_by = $${params.length})`);
  }

  if (options.status) {
    params.push(options.status);
    clauses.push(`COALESCE(status, 'active') = $${params.length}`);
  } else if (options.includeDisabled === false) {
    clauses.push(`COALESCE(status, 'active') <> 'disabled'`);
  }

  const sql = `
    SELECT
      uid,
      username,
      email,
      role,
      status,
      created_by,
      coadmin_uid,
      coin,
      cash,
      can_view_players,
      created_at,
      updated_at,
      mirrored_at,
      raw_firestore_data
    FROM public.players_cache
    WHERE ${clauses.join('\n      AND ')}
    ORDER BY COALESCE(updated_at, created_at, mirrored_at) DESC
  `;

  return { sql, params };
}

export async function readUsersCacheByRoleWithClient(
  client: PoolClient,
  options: ReadUsersCacheByRoleOptions
): Promise<CachedDirectoryUser[]> {
  const cleanCoadminUid = cleanText(options.coadminUid);
  const { sql, params } = buildUsersCacheSql({
    ...options,
    coadminUid: cleanCoadminUid || null,
  });
  const { rows } = await runMirrorClientQuery<Record<string, unknown>>(client, sql, params);
  return mapCachedDirectoryUserRows(rows, cleanCoadminUid || null);
}

export async function readUsersCacheByRole(
  options: ReadUsersCacheByRoleOptions
): Promise<CachedDirectoryUser[] | null> {
  const db = getPlayerMirrorPool();
  if (!db) {
    return null;
  }

  const cleanCoadminUid = cleanText(options.coadminUid);
  const { sql, params } = buildUsersCacheSql({
    ...options,
    coadminUid: cleanCoadminUid || null,
  });

  try {
    const { rows } = await runMirrorPoolQuery<Record<string, unknown>>(db, sql, params);
    return mapCachedDirectoryUserRows(rows, cleanCoadminUid || null);
  } catch (error) {
    console.warn('[USERS_CACHE] postgres read failed', {
      role: options.role,
      coadminUid: cleanCoadminUid || null,
      error,
    });
    return null;
  }
}
