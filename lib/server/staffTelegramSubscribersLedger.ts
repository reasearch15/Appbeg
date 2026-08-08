import 'server-only';

const DEFAULT_TIMEOUT_MS = 8000;

export type StaffTelegramSubscriberDto = {
  telegramUserId: string | null;
  telegramUsername: string | null;
  telegramDisplayName: string | null;
  linkedAt: string | null;
  isActive: boolean;
  disabledByCoadmin: boolean;
  subscribedAt: string | null;
  lastDeliveryAt: string | null;
  lastError: string | null;
};

function ledgerBaseUrl() {
  const raw = String(
    process.env.APPBEG_LEDGER_INTERNAL_URL || process.env.APPBEG_LEDGER_URL || ''
  )
    .trim()
    .replace(/\/+$/, '');
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
  return String(
    process.env.APPBEG_LEDGER_VENDOR_INTERNAL_API_KEY ||
      process.env.APPBEG_LEDGER_INTERNAL_API_KEY ||
      ''
  ).trim();
}

export function isStaffTelegramSubscribersLedgerConfigured() {
  return Boolean(ledgerBaseUrl() && ledgerInternalApiKey());
}

async function ledgerFetch(pathname: string, init: RequestInit = {}) {
  const baseUrl = ledgerBaseUrl();
  const apiKey = ledgerInternalApiKey();
  if (!baseUrl || !apiKey) {
    const error = new Error('LEDGER_NOT_CONFIGURED');
    (error as { status?: number }).status = 503;
    throw error;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}${pathname}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
      signal: controller.signal,
    });
    const rawText = await response.text();
    let payload: Record<string, unknown> | null = null;
    try {
      payload = rawText ? (JSON.parse(rawText) as Record<string, unknown>) : null;
    } catch {
      payload = null;
    }
    return { response, payload };
  } finally {
    clearTimeout(timeout);
  }
}

function mapSubscriber(value: unknown): StaffTelegramSubscriberDto | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const telegramUserId = String(row.telegramUserId || '').trim();
  if (!telegramUserId) return null;
  return {
    telegramUserId,
    telegramUsername: String(row.telegramUsername || '').trim() || null,
    telegramDisplayName: String(row.telegramDisplayName || '').trim() || null,
    linkedAt: String(row.linkedAt || '').trim() || null,
    isActive: Boolean(row.isActive),
    disabledByCoadmin: Boolean(row.disabledByCoadmin),
    subscribedAt: String(row.subscribedAt || '').trim() || null,
    lastDeliveryAt: String(row.lastDeliveryAt || '').trim() || null,
    lastError: String(row.lastError || '').trim() || null,
  };
}

export async function listStaffTelegramSubscribersForCoadmin(coadminUid: string) {
  const uid = String(coadminUid || '').trim();
  if (!uid) {
    const error = new Error('coadminUid is required.');
    (error as { status?: number }).status = 400;
    throw error;
  }
  const { response, payload } = await ledgerFetch(
    `/api/internal/support-notification/subscribers?coadminUid=${encodeURIComponent(uid)}`,
    { method: 'GET' }
  );
  if (!response.ok || payload?.ok !== true) {
    const error = new Error('Unable to load Telegram staff right now.');
    (error as { status?: number }).status = response.status === 401 ? 503 : 503;
    throw error;
  }
  const rows = Array.isArray(payload?.subscribers) ? payload.subscribers : [];
  return rows.map((row) => mapSubscriber(row)).filter(Boolean) as StaffTelegramSubscriberDto[];
}

export async function disableStaffTelegramSubscriberForCoadmin(
  coadminUid: string,
  telegramUserId: string
) {
  const uid = String(coadminUid || '').trim();
  const userId = String(telegramUserId || '').trim();
  if (!uid || !userId) {
    const error = new Error('coadminUid and telegramUserId are required.');
    (error as { status?: number }).status = 400;
    throw error;
  }
  const { response, payload } = await ledgerFetch(
    `/api/internal/support-notification/subscribers/${encodeURIComponent(userId)}/disable`,
    {
      method: 'POST',
      body: JSON.stringify({ coadminUid: uid }),
    }
  );
  if (response.status === 404 || payload?.error === 'NOT_FOUND') {
    const error = new Error('Telegram staff member was not found.');
    (error as { status?: number }).status = 404;
    throw error;
  }
  if (!response.ok || payload?.ok !== true) {
    const error = new Error('Unable to disable Telegram staff right now.');
    (error as { status?: number }).status = 503;
    throw error;
  }
  return mapSubscriber(payload?.subscriber);
}

export async function enableStaffTelegramSubscriberForCoadmin(
  coadminUid: string,
  telegramUserId: string
) {
  const uid = String(coadminUid || '').trim();
  const userId = String(telegramUserId || '').trim();
  if (!uid || !userId) {
    const error = new Error('coadminUid and telegramUserId are required.');
    (error as { status?: number }).status = 400;
    throw error;
  }
  const { response, payload } = await ledgerFetch(
    `/api/internal/support-notification/subscribers/${encodeURIComponent(userId)}/enable`,
    {
      method: 'POST',
      body: JSON.stringify({ coadminUid: uid }),
    }
  );
  if (response.status === 404 || payload?.error === 'NOT_FOUND') {
    const error = new Error('Telegram staff member was not found.');
    (error as { status?: number }).status = 404;
    throw error;
  }
  if (!response.ok || payload?.ok !== true) {
    const error = new Error('Unable to enable Telegram staff right now.');
    (error as { status?: number }).status = 503;
    throw error;
  }
  return mapSubscriber(payload?.subscriber);
}
