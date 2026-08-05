import 'server-only';

import {
  evaluateArbEligibility,
} from '@/lib/economy/automaticRechargeBonus/eligibility';
import { parseArbPlayerPreferenceState } from '@/lib/economy/automaticRechargeBonus/playerPreference';
import {
  isArbGlobalKillActive,
  isArbGrantsEnabled,
  isArbPlayerModeEnabled,
} from '@/lib/server/automaticRechargeBonusFlags';
import { isSqlAuthVerboseLogs } from '@/lib/server/verboseLogs';
import {
  cleanText,
  numberOrNull,
  runMirrorClientQuery,
  withPlayerMirrorClient,
} from '@/lib/sql/playerMirrorCommon';

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
  /** Automatic Recharge Bonus preference (Phase 4). */
  automaticBonusEnabled: boolean;
  bonusCooldownEndsAt: string | null;
  automaticBonusMode: 'enabled' | 'cooldown' | 'disabled';
  automaticBonusAvailable: boolean;
  /** Platform flag ARB_PLAYER_MODE_ENABLED (Phase 7 UI gate). */
  automaticBonusPlayerModeEnabled: boolean;
  canDisableAutomaticBonus: boolean;
  /** Coadmin feature_enabled (for player UI messaging). */
  automaticBonusFeatureEnabled: boolean;
  automaticBonusRiskBlocked: boolean;
  /** False when Auto ON or cooldown (or risk) — Phase 5 mutual exclusion. */
  canClaimBonusEvent: boolean;
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

function toIsoFromUnknown(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return null;
}

function mapSessionMePlayerExtrasRow(
  row: Record<string, unknown>,
  options?: { arbJoinAvailable?: boolean }
): SessionMePlayerExtras {
  const raw = row.raw_firestore_data;
  const coadminPaymentDetailsNoticeVersion = Number(
    readRawField(row.coadmin_raw_firestore_data, 'paymentDetailsNoticeVersion') || 0
  );
  const preference = parseArbPlayerPreferenceState(raw);
  const nowMs = Date.now();

  let riskBlocked = false;
  const blockedUntilIso = toIsoFromUnknown(row.bonus_blocked_until);
  if (blockedUntilIso) {
    riskBlocked = Date.parse(blockedUntilIso) > nowMs;
  } else {
    const rawBlocked = readRawField(raw, 'bonusBlockedUntil');
    if (typeof rawBlocked === 'string' && rawBlocked.trim()) {
      riskBlocked = Date.parse(rawBlocked) > nowMs;
    }
  }

  const arbJoinAvailable = options?.arbJoinAvailable !== false;
  const decision = evaluateArbEligibility({
    preference,
    nowMs,
    gates: {
      playerModeEnabled: isArbPlayerModeEnabled(),
      globalKillActive: isArbGlobalKillActive(),
      featureEnabled: arbJoinAvailable ? row.arb_feature_enabled === true : false,
      emergencyDisable: arbJoinAvailable ? row.arb_emergency_disable === true : false,
      playerOptInAllowed: arbJoinAvailable
        ? row.arb_player_opt_in_allowed !== false
        : false,
      riskBlocked,
      hasPublishedConfiguration: arbJoinAvailable
        ? Boolean(cleanText(row.arb_published_version_id))
        : false,
    },
    grantsEnabled: isArbGrantsEnabled(),
  });

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
    automaticBonusEnabled: decision.preference.automaticBonusEnabled,
    bonusCooldownEndsAt: decision.preference.bonusCooldownEndsAt,
    automaticBonusMode: decision.currentMode,
    automaticBonusAvailable: decision.canEnable,
    automaticBonusPlayerModeEnabled: isArbPlayerModeEnabled(),
    canDisableAutomaticBonus: decision.canDisable,
    automaticBonusFeatureEnabled:
      arbJoinAvailable && row.arb_feature_enabled === true,
    automaticBonusRiskBlocked: riskBlocked,
    canClaimBonusEvent: decision.canClaimBonusEvent,
  };
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
        const coadminUid = cleanText(input.coadminUid);

        try {
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
                c.raw_firestore_data AS coadmin_raw_firestore_data,
                arb.feature_enabled AS arb_feature_enabled,
                arb.emergency_disable AS arb_emergency_disable,
                arb.player_opt_in_allowed AS arb_player_opt_in_allowed,
                arb.published_version_id AS arb_published_version_id,
                s.bonus_blocked_until AS bonus_blocked_until
              FROM public.players_cache p
              LEFT JOIN public.players_cache r
                ON r.uid = p.referred_by_uid
               AND r.deleted_at IS NULL
               AND r.role = 'player'
               AND LOWER(COALESCE(r.status, '')) = 'active'
              LEFT JOIN public.players_cache c
                ON c.uid = $2
               AND c.deleted_at IS NULL
              LEFT JOIN public.coadmin_automatic_recharge_bonus_settings arb
                ON arb.coadmin_uid = $2
               AND arb.deleted_at IS NULL
              LEFT JOIN public.user_balance_snapshots_cache s
                ON s.firebase_id = p.uid
               AND s.deleted_at IS NULL
              WHERE p.uid = $1
                AND p.deleted_at IS NULL
              LIMIT 1
            `,
            [uid, coadminUid]
          );
          if (!rows.length) return null;
          return mapSessionMePlayerExtrasRow(rows[0], { arbJoinAvailable: true });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error || '');
          if (!/coadmin_automatic_recharge_bonus_settings|does not exist/i.test(message)) {
            throw error;
          }
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
                c.raw_firestore_data AS coadmin_raw_firestore_data,
                s.bonus_blocked_until AS bonus_blocked_until
              FROM public.players_cache p
              LEFT JOIN public.players_cache r
                ON r.uid = p.referred_by_uid
               AND r.deleted_at IS NULL
               AND r.role = 'player'
               AND LOWER(COALESCE(r.status, '')) = 'active'
              LEFT JOIN public.players_cache c
                ON c.uid = $2
               AND c.deleted_at IS NULL
              LEFT JOIN public.user_balance_snapshots_cache s
                ON s.firebase_id = p.uid
               AND s.deleted_at IS NULL
              WHERE p.uid = $1
                AND p.deleted_at IS NULL
              LIMIT 1
            `,
            [uid, coadminUid]
          );
          if (!rows.length) return null;
          return mapSessionMePlayerExtrasRow(rows[0], { arbJoinAvailable: false });
        }
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

/** Drop cached player extras after an authoritative write commits. */
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
