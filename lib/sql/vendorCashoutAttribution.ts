import {
  cleanVendorText,
  hasVendorAwareness,
  noVendor,
  vendorUnavailable,
  type VendorAwareness,
} from '@/features/vendors/vendorAwareness';

export type StoredCashoutVendorFields = {
  vendorId: number | null;
  vendorCode: string | null;
  vendorName: string | null;
  vendorStatus: string | null;
  vendorLinkedStaffUid: string | null;
  vendorOwnershipDate: string | null;
  vendorResolvedAt: string | null;
};

export function vendorIdOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }
  return Math.trunc(n);
}

export function vendorAwarenessFromStoredFields(
  input: Partial<StoredCashoutVendorFields> | null | undefined
): VendorAwareness | null {
  if (!input) {
    return null;
  }
  const code = cleanVendorText(input.vendorCode);
  const name = cleanVendorText(input.vendorName);
  const vendorId = vendorIdOrNull(input.vendorId);
  if (!code && !name && vendorId == null && !cleanVendorText(input.vendorResolvedAt)) {
    return null;
  }
  if (!code || !name) {
    // Explicitly resolved as unassigned (owned=false snapshot).
    if (cleanVendorText(input.vendorResolvedAt) && !code && !name && vendorId == null) {
      return noVendor();
    }
    return null;
  }
  return {
    configured: true,
    owned: true,
    vendorId,
    name,
    code,
    status: cleanVendorText(input.vendorStatus) || 'active',
    linkedStaffUid: cleanVendorText(input.vendorLinkedStaffUid) || null,
    ownershipDate: cleanVendorText(input.vendorOwnershipDate) || null,
  };
}

export function storedVendorFieldsFromAwareness(
  vendor: VendorAwareness | null | undefined,
  resolvedAt = new Date().toISOString()
): StoredCashoutVendorFields {
  if (!vendor || vendor.configured === false) {
    return {
      vendorId: null,
      vendorCode: null,
      vendorName: null,
      vendorStatus: null,
      vendorLinkedStaffUid: null,
      vendorOwnershipDate: null,
      vendorResolvedAt: null,
    };
  }
  if (!hasVendorAwareness(vendor)) {
    return {
      vendorId: null,
      vendorCode: null,
      vendorName: null,
      vendorStatus: null,
      vendorLinkedStaffUid: null,
      vendorOwnershipDate: null,
      vendorResolvedAt: resolvedAt,
    };
  }
  return {
    vendorId: vendorIdOrNull(vendor.vendorId),
    vendorCode: cleanVendorText(vendor.code) || null,
    vendorName: cleanVendorText(vendor.name) || null,
    vendorStatus: cleanVendorText(vendor.status) || 'active',
    vendorLinkedStaffUid: cleanVendorText(vendor.linkedStaffUid) || null,
    vendorOwnershipDate: cleanVendorText(vendor.ownershipDate) || null,
    vendorResolvedAt: resolvedAt,
  };
}

export function readStoredVendorFieldsFromRow(
  row: Record<string, unknown> | null | undefined
): StoredCashoutVendorFields {
  const raw =
    row?.raw_firestore_data && typeof row.raw_firestore_data === 'object' && !Array.isArray(row.raw_firestore_data)
      ? (row.raw_firestore_data as Record<string, unknown>)
      : {};
  return {
    vendorId: vendorIdOrNull(row?.vendor_id ?? raw.vendorId),
    vendorCode: cleanVendorText(row?.vendor_code ?? raw.vendorCode) || null,
    vendorName: cleanVendorText(row?.vendor_name ?? raw.vendorName) || null,
    vendorStatus: cleanVendorText(row?.vendor_status ?? raw.vendorStatus) || null,
    vendorLinkedStaffUid:
      cleanVendorText(row?.vendor_linked_staff_uid ?? raw.vendorLinkedStaffUid) || null,
    vendorOwnershipDate:
      cleanVendorText(row?.vendor_ownership_date ?? raw.vendorOwnershipDate) || null,
    vendorResolvedAt: cleanVendorText(row?.vendor_resolved_at ?? raw.vendorResolvedAt) || null,
  };
}

export function mergeVendorIntoRawFirestoreData(
  raw: Record<string, unknown>,
  fields: StoredCashoutVendorFields
): Record<string, unknown> {
  return {
    ...raw,
    vendorId: fields.vendorId,
    vendorCode: fields.vendorCode,
    vendorName: fields.vendorName,
    vendorStatus: fields.vendorStatus,
    vendorLinkedStaffUid: fields.vendorLinkedStaffUid,
    vendorOwnershipDate: fields.vendorOwnershipDate,
    vendorResolvedAt: fields.vendorResolvedAt,
  };
}

export function isVendorLinked(fields: StoredCashoutVendorFields | VendorAwareness | null | undefined) {
  if (!fields) return false;
  if ('owned' in fields) {
    return hasVendorAwareness(fields as VendorAwareness);
  }
  return Boolean(cleanVendorText((fields as StoredCashoutVendorFields).vendorCode));
}

export function unassignedPlayerDisplayLabel() {
  return 'Unassigned player';
}

export function vendorDisplayLabel(vendor: VendorAwareness | null | undefined) {
  if (vendor?.configured === false) return 'Vendor data unavailable';
  if (hasVendorAwareness(vendor)) return vendor.name || 'Vendor';
  return unassignedPlayerDisplayLabel();
}

/** Reject any client-supplied vendor_id; only server-resolved values are trusted. */
export function rejectClientSuppliedVendorId(body: Record<string, unknown> | null | undefined) {
  if (!body) return;
  if (
    body.vendorId != null ||
    body.vendor_id != null ||
    body.vendorCode != null ||
    body.vendor_code != null
  ) {
    console.warn('[VENDOR_CASHOUT] ignored_client_supplied_vendor', {
      vendorId: body.vendorId ?? body.vendor_id ?? null,
      vendorCode: body.vendorCode ?? body.vendor_code ?? null,
    });
  }
}

export function buildVendorCashoutCompletedPayload(input: {
  eventId: string;
  taskId: string;
  playerUid: string;
  coadminUid: string | null;
  amountNpr: number;
  occurredAt: string;
  vendor: StoredCashoutVendorFields;
}) {
  return {
    eventId: cleanVendorText(input.eventId),
    taskId: cleanVendorText(input.taskId),
    playerUid: cleanVendorText(input.playerUid),
    coadminUid: cleanVendorText(input.coadminUid) || null,
    amountNpr: Math.max(0, Number(input.amountNpr) || 0),
    occurredAt: cleanVendorText(input.occurredAt),
    vendorId: input.vendor.vendorId,
    vendorCode: input.vendor.vendorCode,
    vendorName: input.vendor.vendorName,
    reason: 'cashout_completed',
  };
}

export { vendorUnavailable, noVendor, hasVendorAwareness };
