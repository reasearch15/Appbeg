import 'server-only';

import {
  cleanText,
  numberOrNull,
  runMirrorClientQuery,
  withPlayerMirrorClient,
} from '@/lib/sql/playerMirrorCommon';
import { isSqlAuthVerboseLogs } from '@/lib/server/verboseLogs';

export type SessionMePlayerExtras = {
  coin: number;
  cash: number;
  referralCode: string | null;
  referredByUid: string | null;
  referredByUsername: string | null;
  dismissedPaymentDetailsNoticeVersion: number;
  referralBonusNotice: string | null;
  referralBonusNoticeAt: string | null;
  coadminPaymentDetailsNoticeVersion: number;
};

type SessionMePlayerExtrasCacheEntry = {
  cachedAt: number;
  expiresAt: number;
  value: SessionMePlayerExtras;
};

const SESSION_ME_EXTRAS_CACHE_TTL_MS = (() => {
  const fromEnv = Number(process.env.SESSION_ME_EXTRAS_CACHE_TTL_MS || 30_000);
  if (!Number.isFinite(fromEnv)) {
    return 30_000;
  }
  return Math.min(60_000, Math.max(5_000, Math.trunc(fromEnv)));
})();

const globalSessionMeExtras = globalThis as typeof globalThis & {
  __appbegSessionMePlayerExtrasCache?: Map<string, SessionMePlayerExtrasCacheEntry>;
};

function sessionMePlayerExtrasCache() {
  if (!globalSessionMeExtras.__appbegSessionMePlayerExtrasCache) {
    globalSessionMeExtras.__appbegSessionMePlayerExtrasCache = new Map();
  }
  return globalSessionMeExtras.__appbegSessionMePlayerExtrasCache;
}

function sessionMePlayerExtrasCacheKey(input: { uid: string; coadminUid: string | null }) {
  return `${cleanText(input.uid)}:${cleanText(input.coadminUid)}`;
}

function readRawField(raw: unknown, field: string) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  return (raw as Record<string, unknown>)[field];
}

export async function readSessionMePlayerExtras(input: {
  uid: string;
  coadminUid: string | null;
}): Promise<SessionMePlayerExtras | null> {
  const uid = cleanText(input.uid);
  if (!uid) {
    return null;
  }

  const cacheKey = sessionMePlayerExtrasCacheKey({ uid, coadminUid: input.coadminUid });
  const cached = sessionMePlayerExtrasCache().get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    if (isSqlAuthVerboseLogs()) {
      console.info('[SESSION_ME_EXTRAS_CACHE_HIT]', {
        uid,
        coadminUid: cleanText(input.coadminUid) || null,
        ageMs: Date.now() - cached.cachedAt,
        ttlMs: SESSION_ME_EXTRAS_CACHE_TTL_MS,
      });
      console.info('[SESSION_ME_EXTRAS_SKIPPED_RECENT_AUTH]', {
        uid,
        reason: 'recent_session_me_extras_cache',
      });
    }
    return cached.value;
  }

  if (cached) {
    sessionMePlayerExtrasCache().delete(cacheKey);
  }
  if (isSqlAuthVerboseLogs()) {
    console.info('[SESSION_ME_EXTRAS_CACHE_MISS]', {
      uid,
      coadminUid: cleanText(input.coadminUid) || null,
      reason: cached ? 'expired' : 'empty',
      ttlMs: SESSION_ME_EXTRAS_CACHE_TTL_MS,
    });
  }

  try {
    const { result } = await withPlayerMirrorClient(
      { route: '/api/auth/session/me', context: 'session_me_extras' },
      async (client, trackQuery) => {
        trackQuery();
        const { rows } = await runMirrorClientQuery<Record<string, unknown>>(
          client,
          `
            SELECT
              p.coin,
              p.cash,
              p.referral_code,
              p.referred_by_uid,
              p.raw_firestore_data,
              r.username AS referred_by_username,
              c.raw_firestore_data AS coadmin_raw_firestore_data
            FROM public.players_cache p
            LEFT JOIN public.players_cache r
              ON r.uid = p.referred_by_uid
             AND r.deleted_at IS NULL
             AND r.role = 'player'
             AND LOWER(COALESCE(r.status, '')) = 'active'
            LEFT JOIN public.players_cache c
              ON c.uid = $2
             AND c.deleted_at IS NULL
            WHERE p.uid = $1
              AND p.deleted_at IS NULL
            LIMIT 1
          `,
          [uid, cleanText(input.coadminUid)]
        );

        if (!rows.length) {
          return null;
        }

        const row = rows[0];
        const raw = row.raw_firestore_data;
        const coadminPaymentDetailsNoticeVersion = Number(
          readRawField(row.coadmin_raw_firestore_data, 'paymentDetailsNoticeVersion') || 0
        );

        return {
          coin: Number(row.coin ?? readRawField(raw, 'coin') ?? 0),
          cash: Number(row.cash ?? readRawField(raw, 'cash') ?? 0),
          referralCode:
            cleanText(row.referral_code) || cleanText(readRawField(raw, 'referralCode')) || null,
          referredByUid:
            cleanText(row.referred_by_uid) || cleanText(readRawField(raw, 'referredByUid')) || null,
          referredByUsername:
            cleanText(row.referred_by_username) ||
            cleanText(readRawField(raw, 'referredByUsername')) ||
            null,
          dismissedPaymentDetailsNoticeVersion: Number(
            readRawField(raw, 'dismissedPaymentDetailsNoticeVersion') || 0
          ),
          referralBonusNotice: cleanText(readRawField(raw, 'referralBonusNotice')) || null,
          referralBonusNoticeAt: cleanText(readRawField(raw, 'referralBonusNoticeAt')) || null,
          coadminPaymentDetailsNoticeVersion,
        };
      }
    );

    if (result) {
      const now = Date.now();
      sessionMePlayerExtrasCache().set(cacheKey, {
        cachedAt: now,
        expiresAt: now + SESSION_ME_EXTRAS_CACHE_TTL_MS,
        value: result,
      });
    }

    return result;
  } catch (error) {
    console.warn('[SESSION_ME_EXTRAS] read failed', {
      uid,
      error,
    });
    return null;
  }
}

export function numberFromSessionExtras(value: number | null | undefined) {
  return numberOrNull(value) ?? 0;
}

/** Drop cached coin/cash extras after an authoritative balance write commits. */
export function invalidateSessionMePlayerExtras(input: {
  uid: string;
  coadminUid?: string | null;
}) {
  const uid = cleanText(input.uid);
  if (!uid) {
    return 0;
  }
  const cache = sessionMePlayerExtrasCache();
  const coadminUid = input.coadminUid === undefined ? null : cleanText(input.coadminUid);
  if (input.coadminUid !== undefined) {
    const key = sessionMePlayerExtrasCacheKey({ uid, coadminUid });
    const deleted = cache.delete(key);
    if (deleted) {
      console.info('[SESSION_ME_EXTRAS_CACHE_INVALIDATED]', {
        uid,
        coadminUid: coadminUid || null,
        mode: 'exact',
      });
    }
    return deleted ? 1 : 0;
  }

  let removed = 0;
  for (const key of cache.keys()) {
    if (key === uid || key.startsWith(`${uid}:`)) {
      cache.delete(key);
      removed += 1;
    }
  }
  if (removed > 0) {
    console.info('[SESSION_ME_EXTRAS_CACHE_INVALIDATED]', {
      uid,
      mode: 'uid_prefix',
      removed,
    });
  }
  return removed;
}
