'use client';

import { getSqlApiReadHeaders } from '@/lib/client/sqlApiHeaders';
import type {
  ArbDraftConfiguration,
  ArbOperationalState,
  ArbPublishedConfiguration,
  ArbSettingsAuditEntry,
  ArbSettingsSnapshot,
  ArbValidationResult,
} from '@/lib/economy/automaticRechargeBonus/types';

export type ArbAdminOverview = {
  settings: ArbSettingsSnapshot;
  published: ArbPublishedConfiguration | null;
  versions: ArbPublishedConfiguration[];
  flags: {
    admin_enabled: boolean;
    grants_enabled: boolean;
    player_mode_enabled: boolean;
    reporting_enabled: boolean;
    global_kill_active: boolean;
    shadow_mode_enabled: boolean;
    unsafe_player_mode_without_grants: boolean;
  };
};

export type ArbAdminApiError = Error & {
  status?: number;
  validation?: ArbValidationResult;
};

async function readJson(response: Response) {
  return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

function makeError(payload: Record<string, unknown>, fallback: string, status: number) {
  const error = new Error(
    typeof payload.error === 'string' ? payload.error : fallback
  ) as ArbAdminApiError;
  error.status = status;
  if (
    payload.validation &&
    typeof payload.validation === 'object' &&
    Array.isArray((payload.validation as ArbValidationResult).errors)
  ) {
    error.validation = payload.validation as ArbValidationResult;
  }
  return error;
}

function newIdempotencyKey(prefix: string) {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}:${crypto.randomUUID()}`;
  }
  return `${prefix}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
}

export async function loadArbAdminOverview(coadminUid?: string) {
  const query = coadminUid ? `?coadminUid=${encodeURIComponent(coadminUid)}` : '';
  const response = await fetch(`/api/coadmin/automatic-recharge-bonus${query}`, {
    method: 'GET',
    headers: await getSqlApiReadHeaders(false),
    cache: 'no-store',
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throw makeError(payload, 'Failed to load Automatic Recharge Bonus settings.', response.status);
  }
  return {
    settings: payload.settings as ArbSettingsSnapshot,
    published: (payload.published as ArbPublishedConfiguration | null) || null,
    versions: (payload.versions as ArbPublishedConfiguration[]) || [],
    flags: payload.flags as ArbAdminOverview['flags'],
  } satisfies ArbAdminOverview;
}

export async function saveArbDraft(input: {
  draft: ArbDraftConfiguration;
  coadminUid?: string;
  requireValid?: boolean;
  idempotencyKey?: string;
}) {
  const idempotencyKey = input.idempotencyKey || newIdempotencyKey('draft');
  const response = await fetch('/api/coadmin/automatic-recharge-bonus/draft', {
    method: 'PUT',
    headers: {
      ...(await getSqlApiReadHeaders(true)),
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({
      draft: input.draft,
      coadminUid: input.coadminUid,
      requireValid: input.requireValid !== false,
      idempotencyKey,
    }),
    cache: 'no-store',
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throw makeError(payload, 'Failed to save draft.', response.status);
  }
  return {
    settings: payload.settings as ArbSettingsSnapshot,
    validation: payload.validation as ArbValidationResult,
    duplicate: Boolean(payload.duplicate),
  };
}

export async function resetArbDraftToDefaults(input?: {
  coadminUid?: string;
  idempotencyKey?: string;
}) {
  const idempotencyKey = input?.idempotencyKey || newIdempotencyKey('reset');
  const response = await fetch('/api/coadmin/automatic-recharge-bonus/draft', {
    method: 'POST',
    headers: {
      ...(await getSqlApiReadHeaders(true)),
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({
      action: 'reset_defaults',
      coadminUid: input?.coadminUid,
      idempotencyKey,
    }),
    cache: 'no-store',
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throw makeError(payload, 'Failed to reset draft.', response.status);
  }
  return {
    settings: payload.settings as ArbSettingsSnapshot,
    validation: payload.validation as ArbValidationResult,
    duplicate: Boolean(payload.duplicate),
  };
}

export async function publishArbDraft(input?: {
  coadminUid?: string;
  acceptGapWarnings?: boolean;
  idempotencyKey?: string;
}) {
  const idempotencyKey = input?.idempotencyKey || newIdempotencyKey('publish');
  const response = await fetch('/api/coadmin/automatic-recharge-bonus/publish', {
    method: 'POST',
    headers: {
      ...(await getSqlApiReadHeaders(true)),
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({
      coadminUid: input?.coadminUid,
      acceptGapWarnings: input?.acceptGapWarnings === true,
      idempotencyKey,
    }),
    cache: 'no-store',
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throw makeError(payload, 'Failed to publish configuration.', response.status);
  }
  return {
    version: payload.version as ArbPublishedConfiguration,
    settings: payload.settings as ArbSettingsSnapshot,
    duplicate: Boolean(payload.duplicate),
  };
}

export async function rollbackArbConfig(input: {
  targetVersionId: string;
  coadminUid?: string;
  loadDraftFromTarget?: boolean;
  idempotencyKey?: string;
}) {
  const idempotencyKey =
    input.idempotencyKey || newIdempotencyKey(`rollback:${input.targetVersionId}`);
  const response = await fetch('/api/coadmin/automatic-recharge-bonus/rollback', {
    method: 'POST',
    headers: {
      ...(await getSqlApiReadHeaders(true)),
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({
      targetVersionId: input.targetVersionId,
      coadminUid: input.coadminUid,
      loadDraftFromTarget: input.loadDraftFromTarget !== false,
      idempotencyKey,
    }),
    cache: 'no-store',
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throw makeError(payload, 'Failed to roll back configuration.', response.status);
  }
  return {
    version: payload.version as ArbPublishedConfiguration,
    settings: payload.settings as ArbSettingsSnapshot,
    duplicate: Boolean(payload.duplicate),
  };
}

export async function updateArbOperational(input: {
  operational: Partial<ArbOperationalState>;
  coadminUid?: string;
  idempotencyKey?: string;
}) {
  const idempotencyKey = input.idempotencyKey || newIdempotencyKey('operational');
  const response = await fetch('/api/coadmin/automatic-recharge-bonus/operational', {
    method: 'PATCH',
    headers: {
      ...(await getSqlApiReadHeaders(true)),
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({
      operational: input.operational,
      coadminUid: input.coadminUid,
      idempotencyKey,
    }),
    cache: 'no-store',
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throw makeError(payload, 'Failed to update operational settings.', response.status);
  }
  return {
    settings: payload.settings as ArbSettingsSnapshot,
  };
}

export async function loadArbAuditEntries(input?: {
  coadminUid?: string;
  limit?: number;
}) {
  const params = new URLSearchParams();
  if (input?.coadminUid) params.set('coadminUid', input.coadminUid);
  if (input?.limit) params.set('limit', String(input.limit));
  const query = params.toString() ? `?${params.toString()}` : '';
  const response = await fetch(`/api/coadmin/automatic-recharge-bonus/audit${query}`, {
    method: 'GET',
    headers: await getSqlApiReadHeaders(false),
    cache: 'no-store',
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throw makeError(payload, 'Failed to load audit history.', response.status);
  }
  return (payload.entries as ArbSettingsAuditEntry[]) || [];
}

export async function loadArbVersion(input: {
  versionId: string;
  coadminUid?: string;
}) {
  const params = new URLSearchParams({ versionId: input.versionId });
  if (input.coadminUid) params.set('coadminUid', input.coadminUid);
  const response = await fetch(
    `/api/coadmin/automatic-recharge-bonus/versions?${params.toString()}`,
    {
      method: 'GET',
      headers: await getSqlApiReadHeaders(false),
      cache: 'no-store',
    }
  );
  const payload = await readJson(response);
  if (!response.ok) {
    throw makeError(payload, 'Failed to load version.', response.status);
  }
  return payload.version as ArbPublishedConfiguration;
}
