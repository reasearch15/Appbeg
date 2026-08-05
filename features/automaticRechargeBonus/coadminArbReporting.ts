'use client';

import { getSqlApiReadHeaders } from '@/lib/client/sqlApiHeaders';
import type { ArbAdminApiError } from '@/features/automaticRechargeBonus/coadminArbAdmin';

export type ArbDashboardStats = {
  range: { fromIso: string; toIso: string };
  playersAutoOn: number;
  playersInCooldown: number;
  autoBonusGrants: number;
  coinsGranted: number;
  promoLockedCoinsGranted: number;
  shadowEvaluations: number;
  skippedEvaluations: number;
  blockedEvaluations: number;
  wouldGrantEvaluations: number;
  grantSuccessRate: number | null;
  mostCommonRechargeTiers: Array<{ tierId: string; count: number; totalBonus: number }>;
  mostCommonRewardTiers: Array<{ tierId: string; count: number; totalBonus: number }>;
  topAutoBonusPlayers: Array<{
    playerUid: string;
    grantCount: number;
    coinsGranted: number;
  }>;
  skipReasonDistribution: Array<{ reason: string; count: number }>;
  evaluationResultDistribution: Array<{ result: string; count: number }>;
};

export type ArbEvaluationReportRow = {
  evaluationId: string;
  mode: string;
  evaluationResult: string;
  eligible: boolean;
  bonusCalculated: number;
  rechargeAmount: number;
  tierId: string | null;
  configVersionId: string | null;
  configVersionNumber: number | null;
  skipReason: string | null;
  playerUid: string;
  requestId: string | null;
  evaluatedAt: string | null;
};

export type ArbOpsAuditEntry = {
  kind: 'settings_audit' | 'player_toggle' | 'evaluation';
  id: string;
  at: string;
  action: string;
  actorUid: string | null;
  actorRole: string | null;
  playerUid: string | null;
  versionId: string | null;
  detail: Record<string, unknown>;
};

async function readJson(response: Response) {
  return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

function makeError(payload: Record<string, unknown>, fallback: string, status: number) {
  const error = new Error(
    typeof payload.error === 'string' ? payload.error : fallback
  ) as ArbAdminApiError;
  error.status = status;
  return error;
}

function buildQuery(params: Record<string, string | number | null | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === '') continue;
    search.set(key, String(value));
  }
  const q = search.toString();
  return q ? `?${q}` : '';
}

export async function loadArbDashboardStats(input?: {
  coadminUid?: string;
  preset?: string;
  from?: string;
  to?: string;
}) {
  const query = buildQuery({
    coadminUid: input?.coadminUid,
    preset: input?.preset,
    from: input?.from,
    to: input?.to,
  });
  const response = await fetch(`/api/coadmin/automatic-recharge-bonus/stats${query}`, {
    method: 'GET',
    headers: await getSqlApiReadHeaders(false),
    cache: 'no-store',
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throw makeError(payload, 'Failed to load ARB dashboard stats.', response.status);
  }
  return payload.stats as ArbDashboardStats;
}

export async function loadArbEvaluationHistory(input?: {
  coadminUid?: string;
  preset?: string;
  from?: string;
  to?: string;
  playerUid?: string;
  mode?: 'shadow' | 'grant' | '';
  evaluationResult?: string;
  tierId?: string;
  configVersionId?: string;
  skipReason?: string;
  search?: string;
  limit?: number;
  offset?: number;
}) {
  const query = buildQuery({
    coadminUid: input?.coadminUid,
    preset: input?.preset,
    from: input?.from,
    to: input?.to,
    playerUid: input?.playerUid,
    mode: input?.mode,
    evaluationResult: input?.evaluationResult,
    tierId: input?.tierId,
    configVersionId: input?.configVersionId,
    skipReason: input?.skipReason,
    search: input?.search,
    limit: input?.limit,
    offset: input?.offset,
  });
  const response = await fetch(
    `/api/coadmin/automatic-recharge-bonus/evaluations${query}`,
    {
      method: 'GET',
      headers: await getSqlApiReadHeaders(false),
      cache: 'no-store',
    }
  );
  const payload = await readJson(response);
  if (!response.ok) {
    throw makeError(payload, 'Failed to load ARB evaluations.', response.status);
  }
  return {
    rows: (payload.rows as ArbEvaluationReportRow[]) || [],
    total: Number(payload.total || 0),
    range: payload.range as { fromIso: string; toIso: string },
  };
}

export async function loadArbOpsAudit(input?: {
  coadminUid?: string;
  preset?: string;
  from?: string;
  to?: string;
  playerUid?: string;
  action?: string;
  search?: string;
  limit?: number;
  offset?: number;
}) {
  const query = buildQuery({
    coadminUid: input?.coadminUid,
    preset: input?.preset,
    from: input?.from,
    to: input?.to,
    playerUid: input?.playerUid,
    action: input?.action,
    search: input?.search,
    limit: input?.limit,
    offset: input?.offset,
  });
  const response = await fetch(
    `/api/coadmin/automatic-recharge-bonus/ops-audit${query}`,
    {
      method: 'GET',
      headers: await getSqlApiReadHeaders(false),
      cache: 'no-store',
    }
  );
  const payload = await readJson(response);
  if (!response.ok) {
    throw makeError(payload, 'Failed to load ARB ops audit.', response.status);
  }
  return {
    rows: (payload.rows as ArbOpsAuditEntry[]) || [],
    total: Number(payload.total || 0),
    range: payload.range as { fromIso: string; toIso: string },
  };
}

export async function loadArbReconcileReport(input: {
  requestId: string;
  coadminUid?: string;
}) {
  const query = buildQuery({
    requestId: input.requestId,
    coadminUid: input.coadminUid,
  });
  const response = await fetch(
    `/api/coadmin/automatic-recharge-bonus/reconcile${query}`,
    {
      method: 'GET',
      headers: await getSqlApiReadHeaders(false),
      cache: 'no-store',
    }
  );
  const payload = await readJson(response);
  if (!response.ok) {
    throw makeError(payload, 'Failed to reconcile ARB request.', response.status);
  }
  return payload.report as Record<string, unknown>;
}

export async function loadArbPlayerInspect(input: {
  playerUid: string;
  coadminUid?: string;
  sampleRechargeAmount?: number;
}) {
  const query = buildQuery({
    playerUid: input.playerUid,
    coadminUid: input.coadminUid,
    sampleRechargeAmount: input.sampleRechargeAmount,
  });
  const response = await fetch(
    `/api/coadmin/automatic-recharge-bonus/player-inspect${query}`,
    {
      method: 'GET',
      headers: await getSqlApiReadHeaders(false),
      cache: 'no-store',
    }
  );
  const payload = await readJson(response);
  if (!response.ok) {
    throw makeError(payload, 'Failed to inspect ARB player.', response.status);
  }
  return payload.inspection as Record<string, unknown>;
}

/** Minimal JSON download (no CSV exporter exists in repo). */
export function downloadArbJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
