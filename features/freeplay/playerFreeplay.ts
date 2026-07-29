import { getPlayerApiHeaders } from '@/features/auth/playerSession';

export async function fetchPendingFreeplayGift() {
  const headers = await getPlayerApiHeaders(false, {
    route: '/api/player/freeplay/pending',
  });
  const response = await fetch('/api/player/freeplay/pending', {
    method: 'GET',
    credentials: 'include',
    headers,
    cache: 'no-store',
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    hasPendingGift?: boolean;
    giftId?: string | null;
  };
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to load FreePlay gift.');
  }
  return {
    hasPendingGift: Boolean(payload.hasPendingGift),
    giftId: String(payload.giftId || '').trim(),
  };
}

export async function claimFreeplayGift(giftId: string) {
  console.info('[FREEPLAY_CLAIM_API_REQUEST]', {
    route: '/api/player/freeplay/claim',
    giftId,
    credentials: 'include',
  });
  const headers = await getPlayerApiHeaders(true, {
    route: '/api/player/freeplay/claim',
  });
  const response = await fetch('/api/player/freeplay/claim', {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify({ giftId }),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    amount?: number;
    message?: string;
    authority?: string;
    coin?: number;
    cash?: number;
    coinBalance?: number;
    cashBalance?: number;
    claimedAt?: string | null;
    eventId?: string | null;
    hasPendingGift?: boolean;
    alreadyClaimed?: boolean;
    duplicate?: boolean;
  };
  console.info('[FREEPLAY_CLAIM_API_RESPONSE]', {
    ok: response.ok,
    status: response.status,
    authority: payload.authority || null,
    body: payload,
  });
  if (!response.ok) {
    const errorMessage =
      payload.error ||
      (response.status === 401
        ? 'Session expired. Please log in again.'
        : 'Could not claim freeplay. Please try again.');
    console.info('[FREEPLAY_CLAIM_API_ERROR]', {
      giftId,
      status: response.status,
      error: errorMessage,
    });
    throw new Error(errorMessage);
  }
  const coinRaw = payload.coinBalance ?? payload.coin;
  const cashRaw = payload.cashBalance ?? payload.cash;
  return {
    amount: Number(payload.amount || 0),
    message: String(payload.message || 'Freeplay claimed successfully.'),
    coin: Number.isFinite(Number(coinRaw)) ? Math.max(0, Number(coinRaw)) : null,
    cash: Number.isFinite(Number(cashRaw)) ? Math.max(0, Number(cashRaw)) : null,
    claimedAt: payload.claimedAt ? String(payload.claimedAt) : null,
    eventId: payload.eventId ? String(payload.eventId) : null,
    hasPendingGift: payload.hasPendingGift === true,
    alreadyClaimed: payload.alreadyClaimed === true,
    duplicate: payload.duplicate === true,
  };
}
