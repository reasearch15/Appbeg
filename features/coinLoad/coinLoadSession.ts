import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  increment,
  onSnapshot,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from 'firebase/firestore';

import { assertClientFirestoreDisabled } from '@/lib/client/clientFirestoreGuard';
import {
  logClientFirebaseRuntimeRemoved,
  logSqlClientMigration,
} from '@/lib/client/sqlClientMigration';
import { getPlayerApiHeaders } from '@/features/auth/playerSession';
import { getSqlApiReadHeaders } from '@/lib/client/sqlApiHeaders';
import { isClientSqlReadMode, logClientFirestoreSkipped } from '@/lib/client/sqlReadMode';
import { auth, db } from '@/lib/firebase/client';
import { uploadImageToCloudinary } from '@/lib/cloudinary/uploadImage';
import { logPaymentReferencePhotoAudit } from '@/lib/paymentReferencePhotoAudit';

/**
 * Firestore: collection `coinLoadSessions` (legacy). SQL: `coin_load_sessions_cache`.
 */
const SESSIONS = 'coinLoadSessions';
export const COIN_LOAD_SESSION_MS = 10 * 60 * 1000;
const DURATION_MS = COIN_LOAD_SESSION_MS;

export type CoinLoadSession = {
  id: string;
  playerUid: string;
  coadminUid: string;
  paymentPhotoUrl: string;
  createdAt: Date;
  expiresAt: Date;
};

export type PaymentDetailPhoto = {
  id?: string;
  imageUrl: string;
  imagePublicId: string;
  label?: string | null;
};

type PaymentReferencePhotoApiRow = {
  id: string;
  imageUrl: string;
  imagePublicId?: string;
  label?: string | null;
};

function mapPaymentReferencePhotoRow(row: PaymentReferencePhotoApiRow): PaymentDetailPhoto {
  return {
    id: row.id,
    imageUrl: String(row.imageUrl || '').trim(),
    imagePublicId: String(row.imagePublicId || '').trim(),
    label: row.label ?? null,
  };
}

async function fetchPaymentReferencePhotosFromSqlApi(
  coadminUid: string
): Promise<PaymentDetailPhoto[]> {
  const response = await fetch(
    `/api/coadmin/payment-reference-photos?coadminUid=${encodeURIComponent(coadminUid)}`,
    {
      method: 'GET',
      headers: await getSqlApiReadHeaders(false),
      cache: 'no-store',
    }
  );
  const payload = (await response.json().catch(() => ({}))) as {
    photos?: PaymentReferencePhotoApiRow[];
    error?: string;
  };
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to load payment reference photos.');
  }
  return (payload.photos || [])
    .map((row) => mapPaymentReferencePhotoRow(row))
    .filter((photo) => photo.imageUrl);
}

async function postPaymentReferencePhotoToSqlApi(
  coadminUid: string,
  photo: PaymentDetailPhoto
): Promise<PaymentDetailPhoto> {
  const response = await fetch('/api/coadmin/payment-reference-photos', {
    method: 'POST',
    headers: await getSqlApiReadHeaders(true),
    body: JSON.stringify({
      coadminUid,
      imageUrl: photo.imageUrl,
      cloudinaryPublicId: photo.imagePublicId || undefined,
      label: photo.label || undefined,
    }),
    cache: 'no-store',
  });
  const payload = (await response.json().catch(() => ({}))) as {
    photo?: PaymentReferencePhotoApiRow;
    error?: string;
  };
  if (!response.ok || !payload.photo) {
    throw new Error(payload.error || 'Failed to save payment reference photo.');
  }
  return mapPaymentReferencePhotoRow(payload.photo);
}

async function deletePaymentReferencePhotoFromSqlApi(
  coadminUid: string,
  photoId: string
): Promise<void> {
  const response = await fetch('/api/coadmin/payment-reference-photos', {
    method: 'DELETE',
    headers: await getSqlApiReadHeaders(true),
    body: JSON.stringify({ coadminUid, photoId }),
    cache: 'no-store',
  });
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to delete payment reference photo.');
  }
}

async function syncCoadminPaymentDetailPhotosSql(
  coadminUid: string,
  desired: PaymentDetailPhoto[]
): Promise<PaymentDetailPhoto[]> {
  const current = await fetchPaymentReferencePhotosFromSqlApi(coadminUid);
  const desiredUrlSet = new Set(desired.map((photo) => photo.imageUrl));
  const currentByUrl = new Map(current.map((photo) => [photo.imageUrl, photo]));

  for (const existing of current) {
    if (!desiredUrlSet.has(existing.imageUrl) && existing.id) {
      await deletePaymentReferencePhotoFromSqlApi(coadminUid, existing.id);
    }
  }

  const next: PaymentDetailPhoto[] = [];
  for (const photo of desired) {
    const existing = currentByUrl.get(photo.imageUrl);
    if (existing) {
      next.push(existing);
      continue;
    }
    const saved = await postPaymentReferencePhotoToSqlApi(coadminUid, photo);
    next.push(saved);
  }
  return next;
}

function randomItem<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}

function isoToTimestamp(iso: string) {
  const ms = Date.parse(iso);
  return new Date(Number.isFinite(ms) ? ms : Date.now());
}

function mapSqlSession(row: {
  id: string;
  playerUid: string;
  coadminUid: string;
  paymentPhotoUrl: string;
  createdAt: string;
  expiresAt: string;
}): CoinLoadSession {
  return {
    id: row.id,
    playerUid: row.playerUid,
    coadminUid: row.coadminUid,
    paymentPhotoUrl: row.paymentPhotoUrl,
    createdAt: isoToTimestamp(row.createdAt),
    expiresAt: isoToTimestamp(row.expiresAt),
  };
}

export async function uploadCoadminPaymentDetailPhoto(
  coadminUid: string,
  file: File
): Promise<PaymentDetailPhoto> {
  const current = auth.currentUser;
  if (!current || current.uid !== coadminUid) {
    throw new Error('Not authorized to upload for this account.');
  }
  if (!file.type.startsWith('image/')) {
    throw new Error('Only image files are allowed.');
  }
  const maxSizeMb = 5;
  if (file.size > maxSizeMb * 1024 * 1024) {
    throw new Error(`Image must be smaller than ${maxSizeMb}MB.`);
  }
  const uploaded = await uploadImageToCloudinary(file);
  logPaymentReferencePhotoAudit({
    routeOrPage: 'features/coinLoad/coinLoadSession.uploadCoadminPaymentDetailPhoto',
    role: 'coadmin',
    coadminUid,
    source: 'cloudinary_direct_upload',
    cloudinaryUsed: true,
    tableOrCollection: 'users (pending metadata save)',
    photoCount: 1,
    samplePhotoIds: [uploaded.publicId].filter(Boolean),
    sampleUrlsPresent: Boolean(uploaded.url),
    reason: 'cloudinary_upload_complete_metadata_not_saved_yet',
  });
  return {
    imageUrl: uploaded.url,
    imagePublicId: uploaded.publicId,
  };
}

export async function setCoadminPaymentDetailPhotos(
  coadminUid: string,
  photos: PaymentDetailPhoto[]
): Promise<void> {
  if (isClientSqlReadMode()) {
    const current = auth.currentUser;
    if (!current || current.uid !== coadminUid) {
      throw new Error('Not authorized.');
    }
    const synced = await syncCoadminPaymentDetailPhotosSql(coadminUid, photos);
    logPaymentReferencePhotoAudit({
      routeOrPage: 'features/coinLoad/coinLoadSession.setCoadminPaymentDetailPhotos',
      role: 'coadmin',
      coadminUid,
      source: 'payment_reference_photos_cache',
      cloudinaryUsed: synced.some((photo) => Boolean(photo.imagePublicId || photo.imageUrl)),
      tableOrCollection: 'payment_reference_photos_cache',
      photoCount: synced.length,
      samplePhotoIds: synced.map((photo) => photo.imagePublicId || photo.id || '').filter(Boolean).slice(0, 3),
      sampleUrlsPresent: synced.some((photo) => Boolean(photo.imageUrl)),
      reason: 'sql_sync_ok',
    });
    return;
  }
  const current = auth.currentUser;
  if (!current || current.uid !== coadminUid) {
    throw new Error('Not authorized.');
  }
  await updateDoc(doc(db, 'users', coadminUid), {
    paymentDetailPhotos: photos,
    paymentDetailPhotoUrls: photos.map((p) => p.imageUrl),
    paymentDetailsNoticeVersion: increment(1),
    paymentDetailsUpdatedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  logPaymentReferencePhotoAudit({
    routeOrPage: 'features/coinLoad/coinLoadSession.setCoadminPaymentDetailPhotos',
    role: 'coadmin',
    coadminUid,
    source: 'firestore_users_doc',
    cloudinaryUsed: true,
    tableOrCollection: 'users',
    photoCount: photos.length,
    samplePhotoIds: photos.map((photo) => photo.imagePublicId).filter(Boolean).slice(0, 3),
    sampleUrlsPresent: photos.some((photo) => Boolean(photo.imageUrl)),
    reason: 'metadata_saved_firestore_only',
  });
}

export async function getCoadminPaymentDetailPhotos(
  coadminUid: string
): Promise<PaymentDetailPhoto[]> {
  if (isClientSqlReadMode()) {
    const photos = await fetchPaymentReferencePhotosFromSqlApi(coadminUid);
    logPaymentReferencePhotoAudit({
      routeOrPage: 'app/coadmin/page payment-details',
      role: 'coadmin',
      coadminUid,
      source: 'payment_reference_photos_cache',
      cloudinaryUsed: photos.some((photo) => Boolean(photo.imagePublicId || photo.imageUrl)),
      tableOrCollection: 'payment_reference_photos_cache',
      photoCount: photos.length,
      samplePhotoIds: photos.map((photo) => photo.imagePublicId || photo.id || '').filter(Boolean).slice(0, 3),
      sampleUrlsPresent: photos.some((photo) => Boolean(photo.imageUrl)),
      reason: photos.length > 0 ? 'sql_list_ok' : 'sql_list_empty',
    });
    return photos;
  }
  const snap = await getDoc(doc(db, 'users', coadminUid));
  if (!snap.exists()) {
    return [];
  }
  const data = snap.data() as {
    paymentDetailPhotos?: Array<{ imageUrl?: string; imagePublicId?: string }>;
    paymentDetailPhotoUrls?: string[];
  };
  if (Array.isArray(data.paymentDetailPhotos)) {
    const photos = data.paymentDetailPhotos
      .map((p) => ({
        imageUrl: String(p?.imageUrl || '').trim(),
        imagePublicId: String(p?.imagePublicId || '').trim(),
      }))
      .filter((p) => p.imageUrl);
    if (photos.length > 0) {
      logPaymentReferencePhotoAudit({
        routeOrPage: 'app/coadmin/page payment-details',
        role: 'coadmin',
        coadminUid,
        source: 'firestore_users_doc',
        cloudinaryUsed: true,
        tableOrCollection: 'users',
        photoCount: photos.length,
        samplePhotoIds: photos.map((photo) => photo.imagePublicId).filter(Boolean).slice(0, 3),
        sampleUrlsPresent: true,
        reason: 'listed_from_paymentDetailPhotos',
      });
      return photos;
    }
  }
  const legacyUrls = Array.isArray(data.paymentDetailPhotoUrls)
    ? data.paymentDetailPhotoUrls
        .filter((u) => typeof u === 'string' && u.length > 0)
        .map((u) => ({ imageUrl: u, imagePublicId: '' }))
    : [];
  logPaymentReferencePhotoAudit({
    routeOrPage: 'app/coadmin/page payment-details',
    role: 'coadmin',
    coadminUid,
    source: 'firestore_users_doc',
    cloudinaryUsed: legacyUrls.length > 0,
    tableOrCollection: 'users',
    photoCount: legacyUrls.length,
    samplePhotoIds: [],
    sampleUrlsPresent: legacyUrls.length > 0,
    reason:
      legacyUrls.length > 0
        ? 'listed_from_paymentDetailPhotoUrls_legacy'
        : 'no_photos_in_firestore_users_doc',
  });
  return legacyUrls;
}

async function clearPlayerCoinLoadDocs(playerUid: string): Promise<void> {
  const q = query(
    collection(db, SESSIONS),
    where('playerUid', '==', playerUid)
  );
  const snap = await getDocs(q);
  await Promise.all(snap.docs.map((d) => deleteDoc(d.ref)));
}

export async function createCoinLoadSession(coadminUid: string): Promise<CoinLoadSession> {
  if (isClientSqlReadMode()) {
    logClientFirebaseRuntimeRemoved({
      feature: 'coin_load_create',
      file: 'features/coinLoad/coinLoadSession.ts',
      operation: 'addDoc',
      replacement: 'POST /api/player/coin-load-sessions',
    });
    const response = await fetch('/api/player/coin-load-sessions', {
      method: 'POST',
      headers: await getPlayerApiHeaders(true, { route: '/api/player/coin-load-sessions' }),
      body: JSON.stringify({ coadminUid }),
      cache: 'no-store',
    });
    const payload = (await response.json().catch(() => ({}))) as {
      session?: {
        id: string;
        playerUid: string;
        coadminUid: string;
        paymentPhotoUrl: string;
        createdAt: string;
        expiresAt: string;
      };
      error?: string;
    };
    if (!response.ok || !payload.session) {
      throw new Error(payload.error || 'Failed to create coin load session.');
    }
    logSqlClientMigration({
      feature: 'coin_load_create',
      oldFirebaseOperation: 'addDoc',
      newSqlRoute: '/api/player/coin-load-sessions',
      result: 'ok',
      fallbackUsed: false,
    });
    return mapSqlSession(payload.session);
  }

  const current = auth.currentUser;
  if (!current) {
    throw new Error('Not authenticated.');
  }
  const playerUid = current.uid;
  if (!coadminUid) {
    throw new Error('No co-admin is linked to your account.');
  }
  const photos = await getCoadminPaymentDetailPhotos(coadminUid);
  if (photos.length === 0) {
    throw new Error(
      'No payment reference images yet. Your co-admin needs to upload photos in their panel (Payment details).'
    );
  }
  const paymentPhotoUrl = randomItem(photos).imageUrl;
  const now = Date.now();
  const expiresAt = new Date(now + DURATION_MS);

  await clearPlayerCoinLoadDocs(playerUid);

  const refDoc = await addDoc(collection(db, SESSIONS), {
    playerUid,
    coadminUid,
    paymentPhotoUrl,
    createdAt: serverTimestamp(),
    expiresAt,
  });

  return {
    id: refDoc.id,
    playerUid,
    coadminUid,
    paymentPhotoUrl,
    createdAt: new Date(now),
    expiresAt,
  };
}

export async function deleteCoinLoadSession(sessionId: string): Promise<void> {
  if (isClientSqlReadMode()) {
    await fetch('/api/player/coin-load-sessions', {
      method: 'DELETE',
      headers: await getPlayerApiHeaders(true, { route: '/api/player/coin-load-sessions' }),
      body: JSON.stringify({ sessionId }),
      cache: 'no-store',
    });
    return;
  }

  const current = auth.currentUser;
  if (!current) {
    return;
  }
  const sessionRef = doc(db, SESSIONS, sessionId);
  const snap = await getDoc(sessionRef);
  if (!snap.exists()) {
    return;
  }
  const data = snap.data() as { playerUid?: string };
  if (data.playerUid !== current.uid) {
    throw new Error('Not allowed to remove this session.');
  }
  await deleteDoc(sessionRef);
}

export function listenCoinLoadSession(
  sessionId: string,
  onNext: (session: CoinLoadSession | null) => void,
  onError?: (e: Error) => void
) {
  if (isClientSqlReadMode()) {
    logClientFirestoreSkipped('coin_load_session_listener', { sessionId });
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled) {
        return;
      }
      try {
        const response = await fetch(
          `/api/player/coin-load-sessions?sessionId=${encodeURIComponent(sessionId)}`,
          {
            method: 'GET',
            headers: await getPlayerApiHeaders(false, { route: '/api/player/coin-load-sessions' }),
            cache: 'no-store',
          }
        );
        const payload = (await response.json().catch(() => ({}))) as {
          session?: {
            id: string;
            playerUid: string;
            coadminUid: string;
            paymentPhotoUrl: string;
            createdAt: string;
            expiresAt: string;
          } | null;
        };
        if (!cancelled) {
          onNext(payload.session ? mapSqlSession(payload.session) : null);
        }
      } catch (error) {
        if (!cancelled) {
          onError?.(error instanceof Error ? error : new Error(String(error)));
        }
      } finally {
        if (!cancelled) {
          timer = setTimeout(() => {
            void tick();
          }, 4_000);
        }
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer != null) {
        clearTimeout(timer);
        timer = null;
      }
    };
  }

  if (assertClientFirestoreDisabled('coin_load_session_listener', 'onSnapshot', { sessionId })) {
    onNext(null);
    return () => {};
  }

  return onSnapshot(
    doc(db, SESSIONS, sessionId),
    (snap) => {
      if (!snap.exists()) {
        onNext(null);
        return;
      }
      const d = snap.data();
      onNext({
        id: snap.id,
        playerUid: d.playerUid as string,
        coadminUid: d.coadminUid as string,
        paymentPhotoUrl: d.paymentPhotoUrl as string,
        createdAt: d.createdAt instanceof Date ? d.createdAt : new Date(),
        expiresAt: d.expiresAt instanceof Date ? d.expiresAt : new Date(),
      });
    },
    (err) => onError?.(err as Error)
  );
}

export function getSessionExpiresAtMs(session: CoinLoadSession): number {
  return session.expiresAt instanceof Date ? session.expiresAt.getTime() : 0;
}
