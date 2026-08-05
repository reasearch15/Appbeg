'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  downloadArbJson,
  loadArbDashboardStats,
  loadArbEvaluationHistory,
  loadArbOpsAudit,
  loadArbPlayerInspect,
  loadArbReconcileReport,
  type ArbDashboardStats,
  type ArbEvaluationReportRow,
  type ArbOpsAuditEntry,
} from '@/features/automaticRechargeBonus/coadminArbReporting';

type ReportTab =
  | 'dashboard'
  | 'grants'
  | 'evaluations'
  | 'shadow'
  | 'ops-audit'
  | 'reconcile'
  | 'inspect';

const PAGE_SIZE = 30;

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
      <p className="text-[10px] font-black uppercase tracking-wider text-neutral-400">
        {label}
      </p>
      <p className="mt-2 text-2xl font-black text-white">{value}</p>
    </div>
  );
}

function RangeControls({
  preset,
  from,
  to,
  onPreset,
  onFrom,
  onTo,
  onRefresh,
  pending,
}: {
  preset: string;
  from: string;
  to: string;
  onPreset: (value: string) => void;
  onFrom: (value: string) => void;
  onTo: (value: string) => void;
  onRefresh: () => void;
  pending: boolean;
}) {
  return (
    <div className="flex flex-wrap items-end gap-2">
      {(['today', '7d', '30d', 'custom'] as const).map((key) => (
        <button
          key={key}
          type="button"
          onClick={() => onPreset(key)}
          className={`rounded-lg px-3 py-1.5 text-xs font-bold uppercase tracking-wide ${
            preset === key
              ? 'bg-cyan-500/30 text-cyan-100'
              : 'bg-white/5 text-neutral-300 hover:bg-white/10'
          }`}
        >
          {key}
        </button>
      ))}
      {preset === 'custom' ? (
        <>
          <label className="text-xs text-neutral-400">
            From
            <input
              type="datetime-local"
              value={from}
              onChange={(e) => onFrom(e.target.value)}
              className="mt-1 block rounded-lg border border-white/10 bg-black/40 px-2 py-1 text-xs text-white"
            />
          </label>
          <label className="text-xs text-neutral-400">
            To
            <input
              type="datetime-local"
              value={to}
              onChange={(e) => onTo(e.target.value)}
              className="mt-1 block rounded-lg border border-white/10 bg-black/40 px-2 py-1 text-xs text-white"
            />
          </label>
        </>
      ) : null}
      <button
        type="button"
        disabled={pending}
        onClick={onRefresh}
        className="rounded-lg bg-emerald-500/25 px-3 py-1.5 text-xs font-bold text-emerald-100 disabled:opacity-50"
      >
        {pending ? 'Loading…' : 'Refresh'}
      </button>
    </div>
  );
}

function toIsoFromLocal(value: string) {
  if (!value) return '';
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

function Pagination({
  page,
  total,
  pageSize,
  onPage,
}: {
  page: number;
  total: number;
  pageSize: number;
  onPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-1">
      {Array.from({ length: Math.min(pages, 12) }, (_, i) => i + 1).map((n) => (
        <button
          key={n}
          type="button"
          onClick={() => onPage(n)}
          className={`rounded-md px-2 py-1 text-xs font-bold ${
            page === n ? 'bg-emerald-500/30 text-emerald-100' : 'bg-white/5 text-neutral-300'
          }`}
        >
          {n}
        </button>
      ))}
      <span className="ml-2 self-center text-xs text-neutral-500">
        {total} rows
      </span>
    </div>
  );
}

export function AutomaticRechargeBonusReportingPanel({
  isAdmin = false,
  coadminUid,
}: {
  isAdmin?: boolean;
  coadminUid?: string;
}) {
  const [tab, setTab] = useState<ReportTab>('dashboard');
  const [preset, setPreset] = useState('7d');
  const [fromLocal, setFromLocal] = useState('');
  const [toLocal, setToLocal] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [stats, setStats] = useState<ArbDashboardStats | null>(null);
  const [evalRows, setEvalRows] = useState<ArbEvaluationReportRow[]>([]);
  const [evalTotal, setEvalTotal] = useState(0);
  const [evalPage, setEvalPage] = useState(1);
  const [playerFilter, setPlayerFilter] = useState('');
  const [resultFilter, setResultFilter] = useState('');
  const [tierFilter, setTierFilter] = useState('');
  const [versionFilter, setVersionFilter] = useState('');
  const [skipFilter, setSkipFilter] = useState('');
  const [search, setSearch] = useState('');

  const [auditRows, setAuditRows] = useState<ArbOpsAuditEntry[]>([]);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditPage, setAuditPage] = useState(1);
  const [auditAction, setAuditAction] = useState('');

  const [reconcileId, setReconcileId] = useState('');
  const [reconcileReport, setReconcileReport] = useState<Record<string, unknown> | null>(
    null
  );

  const [inspectUid, setInspectUid] = useState('');
  const [inspectSample, setInspectSample] = useState('50');
  const [inspection, setInspection] = useState<Record<string, unknown> | null>(null);

  const rangeArgs = useMemo(() => {
    if (preset === 'custom') {
      return {
        preset: 'custom',
        from: toIsoFromLocal(fromLocal) || undefined,
        to: toIsoFromLocal(toLocal) || undefined,
      };
    }
    return { preset };
  }, [preset, fromLocal, toLocal]);

  const loadDashboard = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      const next = await loadArbDashboardStats({
        coadminUid,
        ...rangeArgs,
      });
      setStats(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load dashboard.');
    } finally {
      setPending(false);
    }
  }, [coadminUid, rangeArgs]);

  const loadEvaluations = useCallback(
    async (mode: 'grant' | 'shadow' | '' | undefined) => {
      setPending(true);
      setError(null);
      try {
        const page = evalPage;
        const next = await loadArbEvaluationHistory({
          coadminUid,
          ...rangeArgs,
          playerUid: playerFilter || undefined,
          mode: mode || undefined,
          evaluationResult: resultFilter || undefined,
          tierId: tierFilter || undefined,
          configVersionId: versionFilter || undefined,
          skipReason: skipFilter || undefined,
          search: search || undefined,
          limit: PAGE_SIZE,
          offset: (page - 1) * PAGE_SIZE,
        });
        setEvalRows(next.rows);
        setEvalTotal(next.total);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load evaluations.');
      } finally {
        setPending(false);
      }
    },
    [
      coadminUid,
      rangeArgs,
      playerFilter,
      resultFilter,
      tierFilter,
      versionFilter,
      skipFilter,
      search,
      evalPage,
    ]
  );

  const loadAudit = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      const next = await loadArbOpsAudit({
        coadminUid,
        ...rangeArgs,
        playerUid: playerFilter || undefined,
        action: auditAction || undefined,
        search: search || undefined,
        limit: PAGE_SIZE,
        offset: (auditPage - 1) * PAGE_SIZE,
      });
      setAuditRows(next.rows);
      setAuditTotal(next.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load ops audit.');
    } finally {
      setPending(false);
    }
  }, [coadminUid, rangeArgs, playerFilter, auditAction, search, auditPage]);

  useEffect(() => {
    if (tab === 'dashboard') void loadDashboard();
    if (tab === 'grants') void loadEvaluations('grant');
    if (tab === 'evaluations') void loadEvaluations('');
    if (tab === 'shadow') void loadEvaluations('shadow');
    if (tab === 'ops-audit') void loadAudit();
  }, [tab, loadDashboard, loadEvaluations, loadAudit]);

  const tabs: Array<{ id: ReportTab; label: string; adminOnly?: boolean }> = [
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'grants', label: 'Grants' },
    { id: 'evaluations', label: 'Evaluations' },
    { id: 'shadow', label: 'Shadow' },
    { id: 'ops-audit', label: 'Audit' },
    { id: 'reconcile', label: 'Reconcile' },
    { id: 'inspect', label: 'Admin inspect', adminOnly: true },
  ];

  return (
    <div className="mt-4 space-y-4">
      <div className="flex flex-wrap gap-2">
        {tabs
          .filter((t) => !t.adminOnly || isAdmin)
          .map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`rounded-xl px-3 py-1.5 text-xs font-black uppercase tracking-wide ${
                tab === t.id
                  ? 'bg-fuchsia-500/30 text-fuchsia-100'
                  : 'bg-white/5 text-neutral-300 hover:bg-white/10'
              }`}
            >
              {t.label}
            </button>
          ))}
      </div>

      {tab !== 'reconcile' && tab !== 'inspect' ? (
        <RangeControls
          preset={preset}
          from={fromLocal}
          to={toLocal}
          onPreset={setPreset}
          onFrom={setFromLocal}
          onTo={setToLocal}
          onRefresh={() => {
            if (tab === 'dashboard') void loadDashboard();
            if (tab === 'grants') void loadEvaluations('grant');
            if (tab === 'evaluations') void loadEvaluations('');
            if (tab === 'shadow') void loadEvaluations('shadow');
            if (tab === 'ops-audit') void loadAudit();
          }}
          pending={pending}
        />
      ) : null}

      {error ? (
        <p className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-100">
          {error}
        </p>
      ) : null}

      {tab === 'dashboard' && stats ? (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Players Auto ON" value={stats.playersAutoOn} />
            <StatCard label="Players in cooldown" value={stats.playersInCooldown} />
            <StatCard label="Auto Bonus grants" value={stats.autoBonusGrants} />
            <StatCard label="Coins granted" value={stats.coinsGranted} />
            <StatCard
              label="Promo-locked granted"
              value={stats.promoLockedCoinsGranted}
            />
            <StatCard label="Shadow evaluations" value={stats.shadowEvaluations} />
            <StatCard label="Skipped" value={stats.skippedEvaluations} />
            <StatCard
              label="Grant success %"
              value={
                stats.grantSuccessRate == null ? '—' : `${stats.grantSuccessRate}%`
              }
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-2xl border border-white/10 bg-black/30 p-4">
              <p className="text-xs font-black uppercase tracking-wide text-neutral-400">
                Most common reward tiers
              </p>
              <ul className="mt-2 space-y-1 text-sm text-neutral-200">
                {stats.mostCommonRewardTiers.map((row) => (
                  <li key={row.tierId} className="flex justify-between gap-2">
                    <span className="font-mono text-xs">{row.tierId}</span>
                    <span>
                      {row.count} · {row.totalBonus} coins
                    </span>
                  </li>
                ))}
                {!stats.mostCommonRewardTiers.length ? (
                  <li className="text-neutral-500">No grants in range.</li>
                ) : null}
              </ul>
            </div>
            <div className="rounded-2xl border border-white/10 bg-black/30 p-4">
              <p className="text-xs font-black uppercase tracking-wide text-neutral-400">
                Top Auto Bonus players
              </p>
              <ul className="mt-2 space-y-1 text-sm text-neutral-200">
                {stats.topAutoBonusPlayers.map((row) => (
                  <li key={row.playerUid} className="flex justify-between gap-2">
                    <span className="truncate font-mono text-xs">{row.playerUid}</span>
                    <span>
                      {row.grantCount} · {row.coinsGranted}
                    </span>
                  </li>
                ))}
                {!stats.topAutoBonusPlayers.length ? (
                  <li className="text-neutral-500">No grants in range.</li>
                ) : null}
              </ul>
            </div>
            <div className="rounded-2xl border border-white/10 bg-black/30 p-4">
              <p className="text-xs font-black uppercase tracking-wide text-neutral-400">
                Skip / block reasons
              </p>
              <ul className="mt-2 space-y-1 text-sm text-neutral-200">
                {stats.skipReasonDistribution.map((row) => (
                  <li key={row.reason} className="flex justify-between gap-2">
                    <span className="truncate">{row.reason}</span>
                    <span>{row.count}</span>
                  </li>
                ))}
                {!stats.skipReasonDistribution.length ? (
                  <li className="text-neutral-500">No skips in range.</li>
                ) : null}
              </ul>
            </div>
            <div className="rounded-2xl border border-white/10 bg-black/30 p-4">
              <p className="text-xs font-black uppercase tracking-wide text-neutral-400">
                Evaluation results
              </p>
              <ul className="mt-2 space-y-1 text-sm text-neutral-200">
                {stats.evaluationResultDistribution.map((row) => (
                  <li key={row.result} className="flex justify-between gap-2">
                    <span>{row.result}</span>
                    <span>{row.count}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <button
            type="button"
            className="rounded-lg bg-white/10 px-3 py-1.5 text-xs font-bold text-neutral-200"
            onClick={() =>
              downloadArbJson(`arb-dashboard-${Date.now()}.json`, stats)
            }
          >
            Export JSON
          </button>
        </div>
      ) : null}

      {(tab === 'grants' || tab === 'evaluations' || tab === 'shadow') && (
        <div className="space-y-3">
          <div className="grid gap-2 md:grid-cols-3 lg:grid-cols-6">
            <input
              placeholder="Player UID"
              value={playerFilter}
              onChange={(e) => setPlayerFilter(e.target.value)}
              className="rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-white"
            />
            <input
              placeholder="Result"
              value={resultFilter}
              onChange={(e) => setResultFilter(e.target.value)}
              className="rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-white"
            />
            <input
              placeholder="Tier id"
              value={tierFilter}
              onChange={(e) => setTierFilter(e.target.value)}
              className="rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-white"
            />
            <input
              placeholder="Config version id"
              value={versionFilter}
              onChange={(e) => setVersionFilter(e.target.value)}
              className="rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-white"
            />
            <input
              placeholder="Skip / blocker"
              value={skipFilter}
              onChange={(e) => setSkipFilter(e.target.value)}
              className="rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-white"
            />
            <input
              placeholder="Search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-white"
            />
          </div>
          <button
            type="button"
            className="rounded-lg bg-cyan-500/20 px-3 py-1.5 text-xs font-bold text-cyan-100"
            onClick={() => {
              setEvalPage(1);
              void loadEvaluations(
                tab === 'grants' ? 'grant' : tab === 'shadow' ? 'shadow' : ''
              );
            }}
          >
            Apply filters
          </button>
          <div className="overflow-x-auto rounded-2xl border border-white/10">
            <table className="min-w-full text-left text-xs text-neutral-200">
              <thead className="bg-white/5 text-[10px] uppercase tracking-wide text-neutral-400">
                <tr>
                  <th className="px-3 py-2">When</th>
                  <th className="px-3 py-2">Player</th>
                  <th className="px-3 py-2">Mode</th>
                  <th className="px-3 py-2">Result</th>
                  <th className="px-3 py-2">Bonus</th>
                  <th className="px-3 py-2">Tier</th>
                  <th className="px-3 py-2">Version</th>
                  <th className="px-3 py-2">Request</th>
                  <th className="px-3 py-2">Reason</th>
                </tr>
              </thead>
              <tbody>
                {evalRows.map((row) => (
                  <tr key={row.evaluationId} className="border-t border-white/5">
                    <td className="px-3 py-2 whitespace-nowrap">
                      {row.evaluatedAt
                        ? new Date(row.evaluatedAt).toLocaleString()
                        : '—'}
                    </td>
                    <td className="px-3 py-2 font-mono">{row.playerUid}</td>
                    <td className="px-3 py-2">{row.mode}</td>
                    <td className="px-3 py-2">{row.evaluationResult}</td>
                    <td className="px-3 py-2">{row.bonusCalculated}</td>
                    <td className="px-3 py-2 font-mono">{row.tierId || '—'}</td>
                    <td className="px-3 py-2 font-mono">
                      {row.configVersionNumber != null
                        ? row.configVersionNumber
                        : row.configVersionId || '—'}
                    </td>
                    <td className="px-3 py-2 font-mono">{row.requestId || '—'}</td>
                    <td className="px-3 py-2">{row.skipReason || '—'}</td>
                  </tr>
                ))}
                {!evalRows.length ? (
                  <tr>
                    <td className="px-3 py-4 text-neutral-500" colSpan={9}>
                      No rows.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          <Pagination
            page={evalPage}
            total={evalTotal}
            pageSize={PAGE_SIZE}
            onPage={(p) => setEvalPage(p)}
          />
          <button
            type="button"
            className="rounded-lg bg-white/10 px-3 py-1.5 text-xs font-bold text-neutral-200"
            onClick={() =>
              downloadArbJson(`arb-${tab}-${Date.now()}.json`, {
                rows: evalRows,
                total: evalTotal,
              })
            }
          >
            Export page JSON
          </button>
        </div>
      )}

      {tab === 'ops-audit' && (
        <div className="space-y-3">
          <div className="grid gap-2 md:grid-cols-3">
            <input
              placeholder="Player UID"
              value={playerFilter}
              onChange={(e) => setPlayerFilter(e.target.value)}
              className="rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-white"
            />
            <input
              placeholder="Action (publish, player_enable…)"
              value={auditAction}
              onChange={(e) => setAuditAction(e.target.value)}
              className="rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-white"
            />
            <input
              placeholder="Search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-white"
            />
          </div>
          <button
            type="button"
            className="rounded-lg bg-cyan-500/20 px-3 py-1.5 text-xs font-bold text-cyan-100"
            onClick={() => {
              setAuditPage(1);
              void loadAudit();
            }}
          >
            Apply filters
          </button>
          <div className="space-y-2">
            {auditRows.map((row) => (
              <details
                key={row.id}
                className="rounded-xl border border-white/10 bg-black/30 p-3"
              >
                <summary className="cursor-pointer text-sm text-neutral-100">
                  <span className="font-mono text-xs text-neutral-500">{row.kind}</span>{' '}
                  <span className="font-semibold">{row.action}</span>{' '}
                  <span className="text-xs text-neutral-400">
                    {row.at ? new Date(row.at).toLocaleString() : ''}
                  </span>
                </summary>
                <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-xs text-neutral-300">
                  {JSON.stringify(row, null, 2)}
                </pre>
              </details>
            ))}
            {!auditRows.length ? (
              <p className="text-sm text-neutral-500">No audit rows.</p>
            ) : null}
          </div>
          <Pagination
            page={auditPage}
            total={auditTotal}
            pageSize={PAGE_SIZE}
            onPage={setAuditPage}
          />
        </div>
      )}

      {tab === 'reconcile' && (
        <div className="space-y-3 rounded-2xl border border-white/10 bg-black/30 p-4">
          <p className="text-sm text-neutral-300">
            Enter a recharge request id to verify request ↔ evaluation ↔ financial event
            ↔ ledger ↔ balance delta (read-only).
          </p>
          <div className="flex flex-wrap gap-2">
            <input
              value={reconcileId}
              onChange={(e) => setReconcileId(e.target.value)}
              placeholder="Request ID"
              className="min-w-[16rem] flex-1 rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white"
            />
            <button
              type="button"
              disabled={pending || !reconcileId.trim()}
              className="rounded-lg bg-emerald-500/25 px-4 py-2 text-sm font-bold text-emerald-100 disabled:opacity-50"
              onClick={() => {
                void (async () => {
                  setPending(true);
                  setError(null);
                  try {
                    const report = await loadArbReconcileReport({
                      requestId: reconcileId.trim(),
                      coadminUid,
                    });
                    setReconcileReport(report);
                  } catch (err) {
                    setError(
                      err instanceof Error ? err.message : 'Reconcile failed.'
                    );
                  } finally {
                    setPending(false);
                  }
                })();
              }}
            >
              Reconcile
            </button>
          </div>
          {reconcileReport ? (
            <>
              <p
                className={`text-sm font-bold ${
                  reconcileReport.ok ? 'text-emerald-300' : 'text-rose-300'
                }`}
              >
                {reconcileReport.ok ? 'OK — no error-severity issues' : 'Issues found'}
              </p>
              <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap rounded-xl border border-white/10 bg-black/50 p-3 text-xs text-neutral-200">
                {JSON.stringify(reconcileReport, null, 2)}
              </pre>
              <button
                type="button"
                className="rounded-lg bg-white/10 px-3 py-1.5 text-xs font-bold text-neutral-200"
                onClick={() =>
                  downloadArbJson(
                    `arb-reconcile-${reconcileId.trim()}.json`,
                    reconcileReport
                  )
                }
              >
                Export JSON
              </button>
            </>
          ) : null}
        </div>
      )}

      {tab === 'inspect' && isAdmin ? (
        <div className="space-y-3 rounded-2xl border border-amber-400/20 bg-black/30 p-4">
          <p className="text-xs font-black uppercase tracking-wide text-amber-200/80">
            Administrator-only · read-only
          </p>
          <div className="flex flex-wrap gap-2">
            <input
              value={inspectUid}
              onChange={(e) => setInspectUid(e.target.value)}
              placeholder="Player UID"
              className="min-w-[16rem] flex-1 rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white"
            />
            <input
              value={inspectSample}
              onChange={(e) => setInspectSample(e.target.value)}
              placeholder="Sample recharge"
              className="w-32 rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white"
            />
            <button
              type="button"
              disabled={pending || !inspectUid.trim()}
              className="rounded-lg bg-amber-500/25 px-4 py-2 text-sm font-bold text-amber-100 disabled:opacity-50"
              onClick={() => {
                void (async () => {
                  setPending(true);
                  setError(null);
                  try {
                    const next = await loadArbPlayerInspect({
                      playerUid: inspectUid.trim(),
                      coadminUid,
                      sampleRechargeAmount: Number(inspectSample) || 50,
                    });
                    setInspection(next);
                  } catch (err) {
                    setError(
                      err instanceof Error ? err.message : 'Inspect failed.'
                    );
                  } finally {
                    setPending(false);
                  }
                })();
              }}
            >
              Inspect
            </button>
          </div>
          {inspection ? (
            <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap rounded-xl border border-white/10 bg-black/50 p-3 text-xs text-neutral-200">
              {JSON.stringify(inspection, null, 2)}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
