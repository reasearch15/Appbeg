import { collection, onSnapshot, query, where } from 'firebase/firestore';

import { assertClientFirestoreDisabled } from '@/lib/client/clientFirestoreGuard';

import { db } from '@/lib/firebase/client';

export type ReferredPlayer = {
  id: string;
  uid: string;
  username: string;
  status?: string;
  createdAt?: Date | null;
  referralCreatedAt?: Date | null;
  referralBonusCoins?: number;
};

function getTimestampMs(value: unknown) {
  if (!value || typeof value !== 'object') {
    return 0;
  }
  const maybe = value as { toMillis?: () => number; toDate?: () => Date; seconds?: number };
  if (typeof maybe.toMillis === 'function') {
    return maybe.toMillis();
  }
  if (typeof maybe.toDate === 'function') {
    return maybe.toDate().getTime();
  }
  if (typeof maybe.seconds === 'number') {
    return maybe.seconds * 1000;
  }
  return 0;
}

function sortByReferralNewest(items: ReferredPlayer[]) {
  return [...items].sort((left, right) => {
    const leftMs = getTimestampMs(left.referralCreatedAt) || getTimestampMs(left.createdAt);
    const rightMs = getTimestampMs(right.referralCreatedAt) || getTimestampMs(right.createdAt);
    return rightMs - leftMs;
  });
}

export function listenReferredPlayersByReferrer(
  referrerUid: string,
  onChange: (players: ReferredPlayer[]) => void,
  onError?: (error: Error) => void
) {
  if (assertClientFirestoreDisabled('player_referrals_listener', 'onSnapshot', { referrerUid })) {
    onChange([]);
    return () => {};
  }

  const q = query(collection(db, 'users'), where('referredByUid', '==', referrerUid));

  return onSnapshot(
    q,
    (snapshot) => {
      const players = snapshot.docs
        .map((docSnap) => {
          const data = docSnap.data() as {
            uid?: string;
            username?: string;
            role?: string;
            status?: string;
            createdAt?: Date | null;
            referralCreatedAt?: Date | null;
            referralBonusCoins?: number;
          };
          return {
            id: docSnap.id,
            uid: String(data.uid || docSnap.id),
            username: String(data.username || '').trim() || 'Unnamed Player',
            status: String(data.status || '').trim() || 'active',
            createdAt: data.createdAt || null,
            referralCreatedAt: data.referralCreatedAt || null,
            referralBonusCoins: Math.max(0, Number(data.referralBonusCoins || 0)),
            role: String(data.role || '').toLowerCase(),
          };
        })
        .filter((item) => item.role === 'player')
        .map(({ role: _role, ...item }) => item);

      onChange(sortByReferralNewest(players));
    },
    (error) => onError?.(error as Error)
  );
}
