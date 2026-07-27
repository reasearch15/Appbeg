export type VendorAwareness = {
  configured: boolean;
  owned: boolean | null;
  vendorId: number | null;
  name: string | null;
  code: string | null;
  status: string | null;
  linkedStaffUid: string | null;
  ownershipDate: string | null;
};

export type VendorAwarePlayer = {
  uid?: string | null;
  playerUid?: string | null;
  vendor?: VendorAwareness | null;
};

export function cleanVendorText(value: unknown) {
  return String(value || '').trim();
}

export function hasVendorAwareness(value: unknown): value is VendorAwareness {
  const vendor = value as VendorAwareness | null | undefined;
  return Boolean(vendor?.configured === true && vendor.owned === true && cleanVendorText(vendor.code) && cleanVendorText(vendor.name));
}

export function vendorUnavailable(): VendorAwareness {
  return {
    configured: false,
    owned: null,
    vendorId: null,
    name: null,
    code: null,
    status: null,
    linkedStaffUid: null,
    ownershipDate: null,
  };
}

export function noVendor(): VendorAwareness {
  return {
    configured: true,
    owned: false,
    vendorId: null,
    name: null,
    code: null,
    status: null,
    linkedStaffUid: null,
    ownershipDate: null,
  };
}

export function normalizeVendorAwareness(value: unknown): VendorAwareness | null {
  const raw = value as Partial<VendorAwareness> | null | undefined;
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  if (raw.configured === false || raw.owned === null) {
    return vendorUnavailable();
  }
  if (raw.owned === false) {
    return noVendor();
  }
  const vendorCode = cleanVendorText(raw.code);
  const vendorName = cleanVendorText(raw.name);
  if (!vendorCode || !vendorName) {
    return null;
  }
  return {
    configured: true,
    owned: true,
    vendorId: Number.isFinite(Number(raw.vendorId)) ? Number(raw.vendorId) : null,
    name: vendorName,
    code: vendorCode,
    status: cleanVendorText(raw.status) || 'active',
    linkedStaffUid: cleanVendorText(raw.linkedStaffUid) || null,
    ownershipDate: cleanVendorText(raw.ownershipDate) || null,
  };
}

export function vendorDisplayName(vendor: VendorAwareness | null | undefined) {
  if (vendor?.configured === false) return 'Vendor data unavailable';
  return hasVendorAwareness(vendor) ? vendor.name || 'Vendor' : 'No Vendor';
}
