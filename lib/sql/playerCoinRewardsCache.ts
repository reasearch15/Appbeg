import 'server-only';

import type { DocumentSnapshot } from 'firebase-admin/firestore';

import { adminDb } from '@/lib/firebase/admin';
import {
  cleanText,
  getPlayerMirrorPool,
  normalizeJson,
  numberOrNull,
  toIsoString,
} from '@/lib/sql/playerMirrorCommon';

export type PlayerCoinRewardCacheInput = {
  firebaseId: string;
  rawFirestoreData?: Record<string, unknown>;
  source?: string;
} & Record<string, unknown>;

function logPlayerCacheInfo(message: string, details?: unknown) {
  if (process.env.NODE_ENV === 'production') {
    return;
  }
  if (details === undefined) {
    console.info(message);
    return;
  }
  console.info(message, details);
}

function toCacheInput(firebaseId: string, data: Record<string, unknown>, source: string) {
  return {
    firebaseId,
    ...data,
    rawFirestoreData: data,
    source,
  } satisfies PlayerCoinRewardCacheInput;
}

export async function upsertPlayerCoinRewardCache(input: PlayerCoinRewardCacheInput) {
  const db = getPlayerMirrorPool();
  const firebaseId = cleanText(input.firebaseId);
  if (!db || !firebaseId) return false;

  try {
    await db.query(
      `
        INSERT INTO public.player_coin_rewards_cache (
          firebase_id, from_uid, from_username, to_uid, to_username,
          coadmin_uid, amount_coins, fee_coins, received_coins, fee_percent,
          created_at, source, mirrored_at, deleted_at, raw_firestore_data
        )
        VALUES (
          $1, NULLIF($2, ''), NULLIF($3, ''), NULLIF($4, ''), NULLIF($5, ''),
          NULLIF($6, ''), $7, $8, $9, $10,
          $11::timestamptz, $12, now(), NULL, $13::jsonb
        )
        ON CONFLICT (firebase_id) DO UPDATE SET
          from_uid = EXCLUDED.from_uid,
          from_username = EXCLUDED.from_username,
          to_uid = EXCLUDED.to_uid,
          to_username = EXCLUDED.to_username,
          coadmin_uid = EXCLUDED.coadmin_uid,
          amount_coins = EXCLUDED.amount_coins,
          fee_coins = EXCLUDED.fee_coins,
          received_coins = EXCLUDED.received_coins,
          fee_percent = EXCLUDED.fee_percent,
          created_at = COALESCE(public.player_coin_rewards_cache.created_at, EXCLUDED.created_at),
          source = EXCLUDED.source,
          mirrored_at = now(),
          deleted_at = NULL,
          raw_firestore_data = EXCLUDED.raw_firestore_data
      `,
      [
        firebaseId,
        cleanText(input.fromUid || input.senderUid),
        cleanText(input.fromUsername || input.senderUsername),
        cleanText(input.toUid || input.targetUid),
        cleanText(input.toUsername || input.targetUsername),
        cleanText(input.coadminUid || input.createdBy),
        numberOrNull(input.amountCoins),
        numberOrNull(input.feeCoins),
        numberOrNull(input.receivedCoins || input.recipientCoins),
        numberOrNull(input.feePercent),
        toIsoString(input.createdAt),
        cleanText(input.source) || 'firestore',
        JSON.stringify(normalizeJson(input.rawFirestoreData || {}) || {}),
      ]
    );
    logPlayerCacheInfo('[PLAYER_COIN_REWARDS_CACHE] mirror upsert ok', { firebaseId });
    return true;
  } catch (error) {
    console.error('[PLAYER_COIN_REWARDS_CACHE] mirror failed', { firebaseId, error });
    return false;
  }
}

export async function mirrorPlayerCoinRewardSnapshot(snap: DocumentSnapshot, source = 'appbeg') {
  if (!snap.exists) return false;
  return upsertPlayerCoinRewardCache(
    toCacheInput(snap.id, (snap.data() || {}) as Record<string, unknown>, source)
  );
}

export async function mirrorPlayerCoinRewardById(firebaseId: string, source = 'appbeg') {
  const cleanId = cleanText(firebaseId);
  if (!cleanId) return false;
  try {
    return mirrorPlayerCoinRewardSnapshot(
      await adminDb.collection('playerCoinRewards').doc(cleanId).get(),
      source
    );
  } catch (error) {
    console.error('[PLAYER_COIN_REWARDS_CACHE] mirror failed', { firebaseId: cleanId, error });
    return false;
  }
}

export async function tombstonePlayerCoinRewardCache(firebaseId: string, source = 'appbeg') {
  const db = getPlayerMirrorPool();
  const cleanId = cleanText(firebaseId);
  if (!db || !cleanId) return false;
  try {
    await db.query(
      `
        INSERT INTO public.player_coin_rewards_cache (
          firebase_id, source, mirrored_at, deleted_at, raw_firestore_data
        )
        VALUES ($1, $2, now(), now(), '{}'::jsonb)
        ON CONFLICT (firebase_id) DO UPDATE SET
          source = EXCLUDED.source,
          mirrored_at = now(),
          deleted_at = now()
      `,
      [cleanId, source]
    );
    logPlayerCacheInfo('[PLAYER_COIN_REWARDS_CACHE] tombstone ok', { firebaseId: cleanId });
    return true;
  } catch (error) {
    console.error('[PLAYER_COIN_REWARDS_CACHE] mirror failed', { firebaseId: cleanId, error });
    return false;
  }
}

export async function getPlayerCoinRewardCacheById(firebaseId: string) {
  const db = getPlayerMirrorPool();
  const cleanId = cleanText(firebaseId);
  if (!db || !cleanId) return null;
  try {
    const result = await db.query(
      'SELECT * FROM public.player_coin_rewards_cache WHERE firebase_id = $1 LIMIT 1',
      [cleanId]
    );
    return result.rows[0] || null;
  } catch (error) {
    console.error('[PLAYER_COIN_REWARDS_CACHE] mirror failed', { firebaseId: cleanId, error });
    return null;
  }
}
