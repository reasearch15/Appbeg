import { NextResponse } from 'next/server';

import { requireApiUser } from '@/lib/firebase/apiAuth';
import {
  firestoreFallbackRemovedResponse,
  isCacheSqlAuthoritative,
  logCacheSqlRead,
} from '@/lib/server/cacheSqlRead';
import {
  bonusEventsRequestHeaderFlags,
  logBonusEventsBlocked,
  logBonusEventsListAuth,
  logBonusEventsListSql,
  logPlayerBonusAuth,
  logPlayerBonusListSql,
  logPlayerBonusSessionHeaderCheck,
} from '@/lib/server/bonusEventsAudit';
import {
  readActiveBonusEventsByCoadmin,
  type CachedBonusEvent,
} from '@/lib/sql/bonusEventsCache';
import { readGameLoginsCacheByCoadmin } from '@/lib/sql/gameLoginsCache';
import {
  bonusEventsMemoryCacheKey,
  invalidateBonusEventsMemoryCache,
  readBonusEventsMemoryCache,
  writeBonusEventsMemoryCache,
} from '@/lib/server/bonusEventsMemoryCache';
import { isAuthoritySqlWriteEnabled } from '@/lib/server/authoritySqlWrite';
import { ensureBonusCapacityInSql } from '@/lib/sql/authorityBonus';

export const runtime = 'nodejs';

const ROUTE = '/api/bonus-events/list';

type BonusEvent = {
  id: string;
  bonusName: string;
  gameName: string;
  createdAt?: unknown;
  created_at?: unknown;
  status?: unknown;
  startDate?: unknown;
  start_date?: unknown;
  endDate?: unknown;
  end_date?: unknown;
  [key: string]: unknown;
};

const AUTO_BONUS_NAMES = [
  'Friday Fever',
  'Lucky Streak',
  'High Roller Rush',
  'Hotshot Bonus',
  'Dollar Dash',
  'Jackpot Sprint',
  'Neon Nights Bonus',
  'Power Play Bonus',
  'Golden Ticket Drop',
  'Vegas Vibes',
  'Pocket Payday',
  'Prime Time Bonus',
  'Rocket Reward',
  'Cashwave Bonus',
  'Flash Fortune',
  'Rapid Reward',
  'Double Up Drop',
  'Crown Club Bonus',
  'Big Win Boost',
  'Main Event Bonus',
];
const LEGACY_AUTO_BONUS_NAMES = new Set([
  'freak friday',
  'hello honee',
  'mafia boss',
  'saduleeee',
  'lucky lassi',
  'drama dollar',
  'paisa pani',
  'jhakaas jackpot',
  'bingo bhoot',
  'crazy chiya',
  'pocket rocket',
  'no tension bonus',
  'balle balle',
  'dhamaka drop',
  'laughter loot',
  'chill pill reward',
  'pagal paisa',
  'momo money',
  'fatafat fortune',
  'boss baby bonus',
]);

function toMs(value: unknown) {
  if (!value || typeof value !== 'object') return 0;
  const maybe = value as { toMillis?: () => number; toDate?: () => Date; seconds?: number };
  if (typeof maybe.toMillis === 'function') return maybe.toMillis();
  if (typeof maybe.toDate === 'function') return maybe.toDate().getTime();
  if (typeof maybe.seconds === 'number') return maybe.seconds * 1000;
  return 0;
}

function isActive(docData: BonusEvent) {
  const status = String(docData.status || 'active').toLowerCase();
  if (status !== 'active') return false;
  const now = Date.now();
  const startMs = toMs(docData.startDate || docData.start_date || null);
  const endMs = toMs(docData.endDate || docData.end_date || null);
  if (startMs > 0 && now < startMs) return false;
  if (endMs > 0 && now > endMs) return false;
  return true;
}

function isLegacyAutoBonusName(name: string) {
  const clean = String(name || '').trim().toLowerCase();
  return (
    clean.startsWith('auto bonus') ||
    clean.includes('2026-') ||
    clean.includes('#') ||
    LEGACY_AUTO_BONUS_NAMES.has(clean)
  );
}

function isLegacyAutoGameName(name: string) {
  return String(name || '').trim().toLowerCase().startsWith('auto game');
}

function hashText(input: string) {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function resolveVisibleCoadminUid(values: {
  role: string;
  requestedCoadminUid: string;
  derivedCoadminUid: string;
}) {
  if (values.role === 'admin') {
    return values.requestedCoadminUid || values.derivedCoadminUid;
  }
  if (values.role === 'player') {
    return values.derivedCoadminUid || values.requestedCoadminUid;
  }
  return values.derivedCoadminUid;
}

function decorateLegacyBonusEvents(events: CachedBonusEvent[], gameNames: string[]): BonusEvent[] {
  return events
    .map((event): BonusEvent => {
      const currentBonusName = String(event.bonusName || '');
      const currentGameName = String(event.gameName || '');
      const funnyName =
        AUTO_BONUS_NAMES[hashText(`${event.id}:bonus`) % AUTO_BONUS_NAMES.length];
      const randomGameFromList =
        gameNames.length > 0
          ? gameNames[hashText(`${event.id}:game`) % gameNames.length]
          : currentGameName || 'Bonus Table';

      return {
        ...event,
        bonusName: isLegacyAutoBonusName(currentBonusName) ? funnyName : currentBonusName,
        gameName: isLegacyAutoGameName(currentGameName) ? randomGameFromList : currentGameName,
        createdAt: event.createdAt ?? null,
        created_at: event.created_at ?? null,
      };
    })
    .filter((event) => isActive(event))
    .sort((a, b) => toMs(b.createdAt || b.created_at) - toMs(a.createdAt || a.created_at));
}

async function loadGameNames(coadminUid: string, sqlReadMode: boolean) {
  const cached = await readGameLoginsCacheByCoadmin(coadminUid);
  if (cached) {
    return Array.from(
      new Set(cached.map((entry) => String(entry.gameName || '').trim()).filter(Boolean))
    );
  }
  throw new Error(
    `sql_required:game_logins_cache:${sqlReadMode ? 'cache_miss' : 'sql_mode_disabled'}`
  );
}

async function loadBonusEvents(coadminUid: string, sqlReadMode: boolean) {
  const cached = await readActiveBonusEventsByCoadmin(coadminUid, {
    includeInactive: false,
    maxResults: 100,
    route: ROUTE,
  });
  if (cached !== null) {
    return cached;
  }
  throw new Error(
    `sql_required:bonus_events_cache:${sqlReadMode ? 'cache_miss' : 'sql_mode_disabled'}`
  );
}

export async function GET(request: Request) {
  try {
    const startedAt = Date.now();
    const url = new URL(request.url);
    const requestedCoadminUid = String(url.searchParams.get('coadminUid') || '').trim();
    const includeInactive =
      url.searchParams.get('includeInactive') === '1' ||
      url.searchParams.get('includeInactive') === 'true';
    const skipTimeWindowFilter =
      url.searchParams.get('skipTimeWindowFilter') === '1' ||
      url.searchParams.get('skipTimeWindowFilter') === 'true';
    const auth = await requireApiUser(request, ['admin', 'coadmin', 'staff', 'carer', 'player']);
    if ('response' in auth) {
      const headerFlags = bonusEventsRequestHeaderFlags(request);
      logPlayerBonusSessionHeaderCheck(request, {
        route: ROUTE,
        method: 'GET',
        auth_path: auth.timing?.auth_path || null,
        reason: headerFlags.has_app_session_header && !headerFlags.has_player_session_header
          ? 'missing_player_session_header'
          : 'auth_failed',
      });
      logBonusEventsBlocked({
        route: ROUTE,
        reason: 'auth_failed',
        requiredAuth: 'admin|coadmin|staff|carer|player',
        receivedAuth: auth.timing?.auth_path || null,
        hasAppSessionId: headerFlags.has_app_session_header,
        hasPlayerSessionId: headerFlags.has_player_session_header,
      });
      return auth.response;
    }

    const derivedCoadminUid =
      auth.user.role === 'coadmin'
        ? auth.user.uid
        : String(auth.user.coadminUid || auth.user.createdBy || '').trim();
    const coadminUid = resolveVisibleCoadminUid({
      role: auth.user.role,
      requestedCoadminUid,
      derivedCoadminUid,
    });

    logBonusEventsListAuth(request, {
      route: ROUTE,
      uid: auth.user.uid,
      role: auth.user.role,
      coadminUid: coadminUid || '',
      auth_path: auth.authPath,
      source: 'postgres',
    });

    if (auth.user.role === 'player') {
      logPlayerBonusAuth(request, {
        route: ROUTE,
        playerUid: auth.user.uid,
        auth_path: auth.authPath,
        session_source: auth.timing?.session_source || null,
        reason: 'player_bonus_list',
      });
    }

    if (!coadminUid) {
      logBonusEventsListSql({
        route: ROUTE,
        coadminUid: '',
        count: 0,
        activeCount: 0,
        sql_ms: Date.now() - startedAt,
        firestore_fallback: false,
        reason: 'missing_coadmin_scope',
      });
      return NextResponse.json({ events: [], source: 'postgres', firestore_fallback: false });
    }

    const memoryCacheKey = bonusEventsMemoryCacheKey({
      coadminUid,
      includeInactive,
      skipTimeWindowFilter,
    });
    const canAutoRefillEmptySqlBonusEvents =
      !includeInactive &&
      isAuthoritySqlWriteEnabled() &&
      (auth.user.role === 'player' || auth.user.role === 'coadmin');
    const memoryCached = readBonusEventsMemoryCache<BonusEvent>(memoryCacheKey);
    if (memoryCached) {
      if (
        canAutoRefillEmptySqlBonusEvents &&
        memoryCached.events.length === 0 &&
        memoryCached.filterReason !== 'no_rows_for_coadmin' &&
        !String(memoryCached.filterReason || '').startsWith('ensure_')
      ) {
        console.info('[bonusEvents] list:empty-memory-cache-bypass-for-ensure', {
          coadminUid,
          filterReason: memoryCached.filterReason,
        });
      } else {
        return NextResponse.json({
          events: memoryCached.events,
          source: 'postgres',
          firestore_fallback: false,
          cache: 'memory',
          filterReason: memoryCached.filterReason,
        });
      }
    }

    async function readDecoratedEvents() {
      const sqlReadMode = isCacheSqlAuthoritative();
      const sqlStartedAt = Date.now();
      const [gameNames, rawEvents] = await Promise.all([
        loadGameNames(coadminUid, sqlReadMode),
        loadBonusEvents(coadminUid, sqlReadMode),
      ]);
      return {
        events: decorateLegacyBonusEvents(rawEvents, gameNames),
        rawEvents,
        sql_ms: Date.now() - sqlStartedAt,
        sqlReadMode,
      };
    }

    let sqlReadMode = isCacheSqlAuthoritative();
    let sql_ms = 0;
    let rawEvents: CachedBonusEvent[] = [];
    let events: BonusEvent[] = [];
    let ensureReason: string | null = null;
    try {
      const read = await readDecoratedEvents();
      sqlReadMode = read.sqlReadMode;
      sql_ms = read.sql_ms;
      rawEvents = read.rawEvents;
      events = read.events;

      if (canAutoRefillEmptySqlBonusEvents && events.length === 0) {
        const ensure = await ensureBonusCapacityInSql({
          coadminUid,
          callerUid: auth.user.role === 'coadmin' ? auth.user.uid : coadminUid,
          callerUsername: auth.user.role === 'coadmin' ? auth.user.username || 'Coadmin' : 'Coadmin',
          activeCountHint: 0,
        });
        ensureReason = ensure.skipped ? `ensure_skipped_${ensure.skipped}` : 'ensure_attempted';
        if (ensure.autoCreatedCount > 0) {
          invalidateBonusEventsMemoryCache(coadminUid);
          const refreshed = await readDecoratedEvents();
          sqlReadMode = refreshed.sqlReadMode;
          sql_ms += refreshed.sql_ms;
          rawEvents = refreshed.rawEvents;
          events = refreshed.events;
          ensureReason = 'ensure_created';
        }
      }
    } catch (error) {
      if (canAutoRefillEmptySqlBonusEvents) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[bonusEvents] list:ensure-or-read-failed', {
          coadminUid,
          message,
        });
        return NextResponse.json(
          {
            error: message || 'Failed to load bonus events.',
            source: 'postgres',
            firestore_fallback: false,
            filterReason: 'ensure_or_read_failed',
          },
          { status: 500 }
        );
      }
      return firestoreFallbackRemovedResponse(ROUTE, {
        coadminUid,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    logBonusEventsListSql({
      route: ROUTE,
      coadminUid,
      count: rawEvents.length,
      activeCount: events.length,
      sql_ms,
      firestore_fallback: false,
      reason: ensureReason || (sqlReadMode ? 'bonus_events_cache_read' : 'legacy_firestore_branch'),
    });

    if (auth.user.role === 'player') {
      logPlayerBonusListSql({
        route: ROUTE,
        playerUid: auth.user.uid,
        playerCoadminUid: derivedCoadminUid,
        queriedCoadminUid: coadminUid,
        totalRowsForCoadmin: rawEvents.length,
        returnedCount: events.length,
        reason:
          ensureReason ||
          (events.length > 0
            ? 'bonus_events_cache_read_active'
            : rawEvents.length > 0
              ? 'active_filter_empty'
              : coadminUid
                ? 'no_rows_for_coadmin'
                : 'missing_coadmin_scope'),
      });
    }

    if (sqlReadMode) {
      logCacheSqlRead(ROUTE, {
        coadminUid,
        count: events.length,
        durationMs: Date.now() - startedAt,
      });
    }

    const filterReason =
      ensureReason ||
      (events.length > 0
        ? 'active'
        : rawEvents.length > 0
          ? 'active_filter_empty'
          : coadminUid
            ? 'no_rows_for_coadmin'
            : 'missing_coadmin_scope');
    writeBonusEventsMemoryCache(memoryCacheKey, {
      events,
      rawCount: rawEvents.length,
      activeCount: events.length,
      filterReason,
    });

    return NextResponse.json({
      events,
      source: 'postgres',
      firestore_fallback: false,
      filterReason,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load bonus events.';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
