'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { getSqlApiReadHeaders } from '@/lib/client/sqlApiHeaders';

type ArbSystemHealth = {
  generatedAt: string;
  coadminUid: string;
  featureStatus: Record<string, boolean>;
  operational: {
    featureEnabled: boolean;
    emergencyDisable: boolean;
    playerOptInAllowed: boolean;
    publishedVersionId: string | null;
  } | null;
  published: {
    versionId: string;
    versionNumber: number;
    status: string;
    publishedAt: string | null;
    tierCount: number;
    activeTier: number;
  } | null;
  lastPublishAt: string | null;
  lastGrantAt: string | null;
  lastShadowEvaluationAt: string | null;
  windowHours: number;
  window: Record<string, number>;
  grantPipelineFreeze: Record<string, string>;
  configurationHealth: {
    ok: boolean;
    notes: string[];
    hasPublishedConfiguration: boolean;
    featureEnabledWithoutPublish: boolean;
    emergencyDisableActive: boolean;
  };
  reconciliationHint: { command: string; uiPath: string };
};

function Pill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-black uppercase tracking-wide ${
        ok ? 'bg-emerald-500/20 text-emerald-200' : 'bg-rose-500/20 text-rose-200'
      }`}
    >
      {label}
    </span>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-white/5 py-2 text-sm">
      <span className="text-neutral-400">{label}</span>
      <span className="text-right text-neutral-100">{value}</span>
    </div>
  );
}

export function AutomaticRechargeBonusHealthPanel({
  coadminUid,
}: {
  coadminUid?: string;
}) {
  const [health, setHealth] = useState<ArbSystemHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [windowHours, setWindowHours] = useState(24);

  const load = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (coadminUid) params.set('coadminUid', coadminUid);
      params.set('windowHours', String(windowHours));
      const response = await fetch(
        `/api/coadmin/automatic-recharge-bonus/health?${params.toString()}`,
        {
          method: 'GET',
          headers: await getSqlApiReadHeaders(false),
          cache: 'no-store',
        }
      );
      const payload = (await response.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      if (!response.ok) {
        throw new Error(
          typeof payload.error === 'string'
            ? payload.error
            : 'Failed to load system health.'
        );
      }
      setHealth(payload.health as ArbSystemHealth);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load system health.');
    } finally {
      setPending(false);
    }
  }, [coadminUid, windowHours]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="mt-4 space-y-4 rounded-2xl border border-cyan-400/25 bg-black/30 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-lg font-bold text-white">System Health</h3>
          <p className="text-xs text-neutral-400">
            Read-only operational snapshot · docs/automatic-recharge-bonus/
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={windowHours}
            onChange={(e) => setWindowHours(Number(e.target.value))}
            className="rounded-lg border border-white/10 bg-black/40 px-2 py-1 text-xs text-white"
          >
            <option value={24}>Last 24h</option>
            <option value={72}>Last 72h</option>
            <option value={168}>Last 7d</option>
          </select>
          <button
            type="button"
            disabled={pending}
            onClick={() => void load()}
            className="rounded-lg bg-cyan-500/25 px-3 py-1.5 text-xs font-bold text-cyan-100 disabled:opacity-50"
          >
            {pending ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error ? (
        <p className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-100">
          {error}
        </p>
      ) : null}

      {health ? (
        <>
          <div className="flex flex-wrap gap-2">
            <Pill
              ok={health.configurationHealth.ok}
              label={
                health.configurationHealth.ok ? 'Config healthy' : 'Config attention'
              }
            />
            <Pill
              ok={!health.featureStatus.globalKillActive}
              label={
                health.featureStatus.globalKillActive ? 'Global kill ON' : 'Kill inactive'
              }
            />
            <Pill
              ok={health.featureStatus.grantsEnabled}
              label={
                health.featureStatus.grantsEnabled ? 'Grants ON' : 'Grants OFF'
              }
            />
            <Pill
              ok={health.featureStatus.shadowModeEnabled}
              label={
                health.featureStatus.shadowModeEnabled ? 'Shadow ON' : 'Shadow OFF'
              }
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-xl border border-white/10 bg-black/25 p-3">
              <p className="text-[10px] font-black uppercase tracking-wide text-neutral-500">
                Feature status
              </p>
              <Row
                label="Admin"
                value={String(health.featureStatus.adminEnabled)}
              />
              <Row
                label="Reporting"
                value={String(health.featureStatus.reportingEnabled)}
              />
              <Row
                label="Player mode"
                value={String(health.featureStatus.playerModeEnabled)}
              />
              <Row
                label="Unsafe player/grants"
                value={String(health.featureStatus.unsafePlayerModeWithoutGrants)}
              />
            </div>

            <div className="rounded-xl border border-white/10 bg-black/25 p-3">
              <p className="text-[10px] font-black uppercase tracking-wide text-neutral-500">
                Operational state
              </p>
              <Row
                label="Feature enabled"
                value={String(health.operational?.featureEnabled ?? false)}
              />
              <Row
                label="Emergency disable"
                value={String(health.operational?.emergencyDisable ?? false)}
              />
              <Row
                label="Player opt-in"
                value={String(health.operational?.playerOptInAllowed ?? false)}
              />
              <Row
                label="Published version"
                value={
                  health.published
                    ? `v${health.published.versionNumber} (${health.published.activeTier}/${health.published.tierCount} active tiers)`
                    : 'None'
                }
              />
            </div>

            <div className="rounded-xl border border-white/10 bg-black/25 p-3">
              <p className="text-[10px] font-black uppercase tracking-wide text-neutral-500">
                Activity (last {health.windowHours}h)
              </p>
              <Row label="Grants" value={health.window.grants} />
              <Row label="Shadow evals" value={health.window.shadowEvaluations} />
              <Row label="Skipped" value={health.window.skipped} />
              <Row label="Blocked" value={health.window.blocked} />
              <Row label="Would grant" value={health.window.wouldGrant} />
              <Row
                label="Duplicate grant signals"
                value={health.window.duplicateGrantSignals}
              />
              <Row
                label="FE without granted eval"
                value={health.window.feWithoutGrantedEval}
              />
              <Row
                label="Granted eval without FE"
                value={health.window.grantedEvalWithoutFe}
              />
              <Row
                label="Eval error hints"
                value={health.window.evaluationErrorsHint}
              />
            </div>

            <div className="rounded-xl border border-white/10 bg-black/25 p-3">
              <p className="text-[10px] font-black uppercase tracking-wide text-neutral-500">
                Timestamps & freeze
              </p>
              <Row
                label="Last publish"
                value={
                  health.lastPublishAt
                    ? new Date(health.lastPublishAt).toLocaleString()
                    : '—'
                }
              />
              <Row
                label="Last grant"
                value={
                  health.lastGrantAt
                    ? new Date(health.lastGrantAt).toLocaleString()
                    : '—'
                }
              />
              <Row
                label="Last shadow"
                value={
                  health.lastShadowEvaluationAt
                    ? new Date(health.lastShadowEvaluationAt).toLocaleString()
                    : '—'
                }
              />
              <Row
                label="Grant freeze"
                value={
                  <span className="font-mono text-xs">
                    {health.grantPipelineFreeze.soleWriterExport}
                  </span>
                }
              />
              <Row
                label="Verify"
                value={
                  <span className="font-mono text-xs">
                    {health.grantPipelineFreeze.verificationCommand}
                  </span>
                }
              />
            </div>
          </div>

          {health.configurationHealth.notes.length ? (
            <ul className="list-disc space-y-1 pl-5 text-sm text-amber-100">
              {health.configurationHealth.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-emerald-200/90">No configuration warnings.</p>
          )}

          <p className="text-xs text-neutral-500">
            Reconcile: {health.reconciliationHint.uiPath} ·{' '}
            <span className="font-mono">{health.reconciliationHint.command}</span>
          </p>
          <p className="text-[10px] text-neutral-600">
            Generated {new Date(health.generatedAt).toLocaleString()} · read-only
          </p>
        </>
      ) : null}
    </div>
  );
}
