import { getFirebaseApiHeaders } from '@/lib/firebase/apiClient';

export type GiveFreeplayGiftInput = {
  targetPlayerUid?: string;
  reason?: string;
  idempotencyKey?: string;
};

export async function giveFreeplayGift(input?: GiveFreeplayGiftInput) {
  const targetPlayerUid = String(input?.targetPlayerUid || '').trim();
  const body = targetPlayerUid
    ? {
        targetPlayerUid,
        reason: String(input?.reason || 'manual_specific_player').trim(),
        idempotencyKey: String(input?.idempotencyKey || '').trim(),
      }
    : {};

  if (targetPlayerUid) {
    console.info('[FREEPLAY_GIVE_API_REQUEST]', {
      route: '/api/coadmin/freeplay/give',
      targetPlayerUid,
      reason: (body as { reason?: string }).reason || 'manual_specific_player',
    });
  }

  const response = await fetch('/api/coadmin/freeplay/give', {
    method: 'POST',
    headers: await getFirebaseApiHeaders(true),
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    playerUsername?: string;
    playerUid?: string;
    staffWalletBalanceCoin?: number | null;
    duplicate?: boolean;
  };
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to give FreePlay gift.');
  }
  return {
    playerUsername: String(payload.playerUsername || 'Player'),
    playerUid: String(payload.playerUid || targetPlayerUid || '').trim(),
    staffWalletBalanceCoin:
      payload.staffWalletBalanceCoin == null ? null : Number(payload.staffWalletBalanceCoin),
    duplicate: Boolean(payload.duplicate),
  };
}
