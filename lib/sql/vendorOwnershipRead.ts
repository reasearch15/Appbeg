import 'server-only';

import {
  cleanVendorText,
  noVendor,
  type VendorAwareness,
  type VendorAwarePlayer,
  vendorUnavailable,
} from '@/features/vendors/vendorAwareness';

const VENDOR_OWNERSHIP_PATH = '/api/internal/vendor-ownership';
const DEFAULT_VENDOR_OWNERSHIP_TIMEOUT_MS = 2000;
const DEFAULT_VENDOR_OWNERSHIP_CACHE_MS = 30 * 1000;
const MAX_VENDOR_OWNERSHIP_CACHE_MS = 30 * 1000;
const MAX_VENDOR_OWNERSHIP_CACHE_ENTRIES = 1000;

type VendorOwnershipApiPlayer = {
  owned?: boolean;
  vendorName?: unknown;
  vendorCode?: unknown;
  vendorStatus?: unknown;
  linkedStaffUid?: unknown;
  ownershipDate?: unknown;
};

type VendorOwnershipApiResponse = {
  configured?: boolean;
  players?: Record<string, VendorOwnershipApiPlayer>;
};

type CacheEntry = {
  expiresAt: number;
  vendor: VendorAwareness;
};

const ownershipCache = new Map<string, CacheEntry>();

function uniquePlayerUids(playerUids: unknown[]) {
  return [...new Set(playerUids.map((uid) => cleanVendorText(uid)).filter(Boolean))];
}

function ledgerBaseUrl() {
  const raw = cleanVendorText(process.env.APPBEG_LEDGER_INTERNAL_URL || process.env.APPBEG_LEDGER_URL).replace(/\/+$/, '');
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (!['https:', 'http:'].includes(url.protocol)) return '';
    if (url.username || url.password || url.search || url.hash) return '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function ledgerInternalApiKey() {
  return cleanVendorText(process.env.APPBEG_LEDGER_VENDOR_INTERNAL_API_KEY || process.env.APPBEG_LEDGER_INTERNAL_API_KEY);
}

function vendorRequestTimeoutMs() {
  const configured = Number(process.env.APPBEG_LEDGER_VENDOR_TIMEOUT_MS);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_VENDOR_OWNERSHIP_TIMEOUT_MS;
  return Math.min(Math.max(configured, 250), 10_000);
}

function vendorCacheMs() {
  const configured = Number(process.env.APPBEG_LEDGER_VENDOR_CACHE_MS);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_VENDOR_OWNERSHIP_CACHE_MS;
  return Math.min(configured, MAX_VENDOR_OWNERSHIP_CACHE_MS);
}

function unavailableMap(uids: string[]) {
  return new Map(uids.map((uid) => [uid, vendorUnavailable()]));
}

function mergeUnavailable(
  current: Map<string, VendorAwareness>,
  missingUids: string[]
) {
  const merged = new Map(current);
  for (const uid of missingUids) {
    merged.set(uid, vendorUnavailable());
  }
  return merged;
}

function cacheContext(baseUrl: string) {
  return `${baseUrl}\u001e${VENDOR_OWNERSHIP_PATH}`;
}

function cacheKeyForUid(context: string, uid: string) {
  return `${context}\u001f${uid}`;
}

function pruneExpiredCache(now = Date.now()) {
  for (const [key, entry] of ownershipCache) {
    if (entry.expiresAt <= now) {
      ownershipCache.delete(key);
    }
  }
}

function enforceCacheLimit() {
  while (ownershipCache.size > MAX_VENDOR_OWNERSHIP_CACHE_ENTRIES) {
    const oldestKey = ownershipCache.keys().next().value;
    if (!oldestKey) break;
    ownershipCache.delete(oldestKey);
  }
}

function mapVendorOwnershipApiValue(value: VendorOwnershipApiPlayer | undefined): VendorAwareness {
  if (!value || value.owned === false) {
    return noVendor();
  }
  const vendorCode = cleanVendorText(value.vendorCode);
  const vendorName = cleanVendorText(value.vendorName);
  if (!vendorCode || !vendorName) {
    return vendorUnavailable();
  }
  return {
    configured: true,
    owned: true,
    vendorId: null,
    name: vendorName,
    code: vendorCode,
    status: cleanVendorText(value.vendorStatus) || 'active',
    linkedStaffUid: cleanVendorText(value.linkedStaffUid) || null,
    ownershipDate: cleanVendorText(value.ownershipDate) || null,
  };
}

export async function readVendorAwarenessByPlayerUids(
  playerUids: unknown[],
  _options: Record<string, unknown> = {}
): Promise<Map<string, VendorAwareness>> {
  const uids = uniquePlayerUids(playerUids);
  if (!uids.length) {
    return new Map();
  }

  const baseUrl = ledgerBaseUrl();
  const apiKey = ledgerInternalApiKey();
  if (!baseUrl || !apiKey) {
    return unavailableMap(uids);
  }

  const now = Date.now();
  const context = cacheContext(baseUrl);
  pruneExpiredCache(now);
  const vendorsByPlayerUid = new Map<string, VendorAwareness>();
  const missingUids: string[] = [];
  for (const uid of uids) {
    const cached = ownershipCache.get(cacheKeyForUid(context, uid));
    if (cached && cached.expiresAt > now) {
      vendorsByPlayerUid.set(uid, cached.vendor);
    } else {
      missingUids.push(uid);
    }
  }
  if (!missingUids.length) {
    return vendorsByPlayerUid;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), vendorRequestTimeoutMs());
  try {
    const response = await fetch(`${baseUrl}${VENDOR_OWNERSHIP_PATH}`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ playerUids: missingUids }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const authFailure = response.status === 401 || response.status === 403;
      console.warn('[VENDOR_AWARENESS] ledger ownership request failed', {
        status: response.status,
        authFailure,
      });
      return mergeUnavailable(vendorsByPlayerUid, missingUids);
    }
    const payload = await response.json() as VendorOwnershipApiResponse;
    if (payload.configured === false) {
      return mergeUnavailable(vendorsByPlayerUid, missingUids);
    }
    for (const uid of missingUids) {
      const vendor = mapVendorOwnershipApiValue(payload.players?.[uid]);
      vendorsByPlayerUid.set(uid, vendor);
      ownershipCache.set(cacheKeyForUid(context, uid), {
        expiresAt: Date.now() + vendorCacheMs(),
        vendor,
      });
    }
    enforceCacheLimit();
    return new Map(vendorsByPlayerUid);
  } catch (error) {
    console.warn('[VENDOR_AWARENESS] ledger ownership request unavailable', {
      error: error instanceof Error ? error.message : String(error),
    });
    return mergeUnavailable(vendorsByPlayerUid, missingUids);
  } finally {
    clearTimeout(timeout);
  }
}

export async function attachVendorAwarenessToPlayers<T extends VendorAwarePlayer>(
  players: T[],
  options: Record<string, unknown> = {}
): Promise<T[]> {
  const vendorsByPlayerUid = await readVendorAwarenessByPlayerUids(
    players.map((player) => player.uid || player.playerUid),
    options
  );
  return players.map((player) => {
    const playerUid = cleanVendorText(player.uid || player.playerUid);
    return {
      ...player,
      vendor: playerUid ? (vendorsByPlayerUid.get(playerUid) || noVendor()) : vendorUnavailable(),
    };
  });
}
