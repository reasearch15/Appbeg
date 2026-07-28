import 'server-only';

import {
  buildVendorCashoutCompletedPayload,
  isVendorLinked,
  type StoredCashoutVendorFields,
} from '@/lib/sql/vendorCashoutAttribution';
import { cleanVendorText } from '@/features/vendors/vendorAwareness';

const VENDOR_CASHOUT_COMPLETED_PATH = '/api/internal/vendor-cashout-completed';
const DEFAULT_TIMEOUT_MS = 3000;

function ledgerBaseUrl() {
  const raw = cleanVendorText(
    process.env.APPBEG_LEDGER_INTERNAL_URL || process.env.APPBEG_LEDGER_URL
  ).replace(/\/+$/, '');
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
  return cleanVendorText(
    process.env.APPBEG_LEDGER_VENDOR_INTERNAL_API_KEY || process.env.APPBEG_LEDGER_INTERNAL_API_KEY
  );
}

export type ReportVendorCashoutResult =
  | { ok: true; skipped?: false; status: number; duplicate?: boolean }
  | { ok: true; skipped: true; reason: string }
  | { ok: false; reason: string; status?: number };

/**
 * Notifies AppBegLedger that a vendor-linked cashout completed so Total Out / Net /
 * receivable can recalculate. Idempotent by eventId on the Ledger side.
 * Never trusts client-supplied vendor ids — only server-resolved fields.
 */
export async function reportVendorCashoutCompletedToLedger(input: {
  eventId: string;
  taskId: string;
  playerUid: string;
  coadminUid: string | null;
  amountNpr: number;
  occurredAt: string;
  vendor: StoredCashoutVendorFields;
}): Promise<ReportVendorCashoutResult> {
  if (!isVendorLinked(input.vendor)) {
    console.warn('[VENDOR_CASHOUT_UNASSIGNED]', {
      taskId: cleanVendorText(input.taskId),
      playerUid: cleanVendorText(input.playerUid),
      eventId: cleanVendorText(input.eventId),
      amountNpr: input.amountNpr,
    });
    return { ok: true, skipped: true, reason: 'unassigned_player' };
  }

  const baseUrl = ledgerBaseUrl();
  const apiKey = ledgerInternalApiKey();
  if (!baseUrl || !apiKey) {
    console.warn('[VENDOR_CASHOUT_LEDGER_SKIPPED]', {
      reason: 'ledger_not_configured',
      taskId: cleanVendorText(input.taskId),
      playerUid: cleanVendorText(input.playerUid),
      vendorId: input.vendor.vendorId,
      vendorCode: input.vendor.vendorCode,
    });
    return { ok: true, skipped: true, reason: 'ledger_not_configured' };
  }

  const payload = buildVendorCashoutCompletedPayload(input);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}${VENDOR_CASHOUT_COMPLETED_PATH}`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (response.status === 409) {
      console.info('[VENDOR_CASHOUT_LEDGER_DUPLICATE]', {
        taskId: payload.taskId,
        eventId: payload.eventId,
        vendorId: payload.vendorId,
      });
      return { ok: true, status: 409, duplicate: true };
    }
    if (!response.ok) {
      console.warn('[VENDOR_CASHOUT_LEDGER_FAILED]', {
        status: response.status,
        taskId: payload.taskId,
        eventId: payload.eventId,
        vendorId: payload.vendorId,
      });
      return { ok: false, reason: 'ledger_http_error', status: response.status };
    }
    console.info('[VENDOR_CASHOUT_LEDGER_REPORTED]', {
      taskId: payload.taskId,
      eventId: payload.eventId,
      playerUid: payload.playerUid,
      vendorId: payload.vendorId,
      vendorCode: payload.vendorCode,
      amountNpr: payload.amountNpr,
    });
    return { ok: true, status: response.status };
  } catch (error) {
    console.warn('[VENDOR_CASHOUT_LEDGER_UNAVAILABLE]', {
      taskId: cleanVendorText(input.taskId),
      eventId: cleanVendorText(input.eventId),
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, reason: 'ledger_unavailable' };
  } finally {
    clearTimeout(timeout);
  }
}
