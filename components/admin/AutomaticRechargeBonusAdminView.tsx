'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';

import {
  loadArbAdminOverview,
  loadArbAuditEntries,
  publishArbDraft,
  resetArbDraftToDefaults,
  rollbackArbConfig,
  saveArbDraft,
  updateArbOperational,
  type ArbAdminApiError,
  type ArbAdminOverview,
} from '@/features/automaticRechargeBonus/coadminArbAdmin';
import { AutomaticRechargeBonusReportingPanel } from '@/components/admin/AutomaticRechargeBonusReportingPanel';
import { AutomaticRechargeBonusHealthPanel } from '@/components/admin/AutomaticRechargeBonusHealthPanel';
import { getCachedSessionUser } from '@/features/auth/sessionUser';
import { previewAutomaticRechargeBonusTable } from '@/lib/economy/automaticRechargeBonus/resolve';
import { validateArbDraftConfiguration } from '@/lib/economy/automaticRechargeBonus/validate';
import type {
  ArbDraftConfiguration,
  ArbPublishedConfiguration,
  ArbSettingsAuditEntry,
  ArbTier,
  ArbValidationError,
  ArbValidationResult,
} from '@/lib/economy/automaticRechargeBonus/types';

type TabId =
  | 'draft'
  | 'preview'
  | 'versions'
  | 'audit'
  | 'operational'
  | 'reporting';

const PREVIEW_AMOUNTS = [9, 10, 19, 20, 39, 40, 59, 60, 199, 200, 500];

function emptyTier(): ArbTier {
  return {
    id:
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `tier-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    minAmount: 10,
    maxAmount: 19,
    bonusCoins: 1,
    label: null,
    active: true,
  };
}

function cloneDraft(draft: ArbDraftConfiguration): ArbDraftConfiguration {
  return JSON.parse(JSON.stringify(draft)) as ArbDraftConfiguration;
}

function ValidationList({
  title,
  items,
  tone,
}: {
  title: string;
  items: ArbValidationError[];
  tone: 'error' | 'warning';
}) {
  if (!items.length) return null;
  const color =
    tone === 'error' ? 'border-rose-500/40 text-rose-200' : 'border-amber-500/40 text-amber-200';
  return (
    <div className={`mt-3 rounded-xl border bg-black/30 p-3 ${color}`}>
      <p className="text-xs font-semibold uppercase tracking-wide">{title}</p>
      <ul className="mt-2 space-y-1 text-sm">
        {items.map((item, index) => (
          <li key={`${item.code}-${item.path || ''}-${index}`}>
            <span className="font-mono text-xs opacity-80">{item.code}</span>
            {item.path ? (
              <span className="ml-2 font-mono text-xs opacity-60">{item.path}</span>
            ) : null}
            <div>{item.message}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TierEditor({
  tiers,
  onChange,
}: {
  tiers: ArbTier[];
  onChange: (tiers: ArbTier[]) => void;
}) {
  return (
    <div className="mt-4 space-y-3">
      {tiers.map((tier, index) => (
        <div
          key={tier.id || `idx-${index}`}
          className="grid gap-2 rounded-xl border border-white/10 bg-black/25 p-3 md:grid-cols-6"
        >
          <label className="block text-xs text-neutral-400 md:col-span-2">
            Tier id
            <input
              value={tier.id}
              onChange={(event) => {
                const next = [...tiers];
                next[index] = { ...tier, id: event.target.value };
                onChange(next);
              }}
              className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-sm text-white"
            />
          </label>
          <label className="block text-xs text-neutral-400">
            Min
            <input
              type="number"
              value={tier.minAmount}
              onChange={(event) => {
                const next = [...tiers];
                next[index] = { ...tier, minAmount: Number(event.target.value) };
                onChange(next);
              }}
              className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-sm text-white"
            />
          </label>
          <label className="block text-xs text-neutral-400">
            Max (blank = ∞)
            <input
              type="number"
              value={tier.maxAmount ?? ''}
              onChange={(event) => {
                const raw = event.target.value.trim();
                const next = [...tiers];
                next[index] = {
                  ...tier,
                  maxAmount: raw === '' ? null : Number(raw),
                };
                onChange(next);
              }}
              className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-sm text-white"
            />
          </label>
          <label className="block text-xs text-neutral-400">
            Bonus coins
            <input
              type="number"
              value={tier.bonusCoins}
              onChange={(event) => {
                const next = [...tiers];
                next[index] = { ...tier, bonusCoins: Number(event.target.value) };
                onChange(next);
              }}
              className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-sm text-white"
            />
          </label>
          <div className="flex items-end gap-2">
            <label className="flex items-center gap-2 text-xs text-neutral-300">
              <input
                type="checkbox"
                checked={tier.active}
                onChange={(event) => {
                  const next = [...tiers];
                  next[index] = { ...tier, active: event.target.checked };
                  onChange(next);
                }}
              />
              Active
            </label>
            <button
              type="button"
              onClick={() => onChange(tiers.filter((_, i) => i !== index))}
              className="rounded-lg bg-white/10 px-2 py-1.5 text-xs text-neutral-200 hover:bg-white/15"
            >
              Remove
            </button>
          </div>
          <label className="block text-xs text-neutral-400 md:col-span-6">
            Label
            <input
              value={tier.label || ''}
              onChange={(event) => {
                const next = [...tiers];
                next[index] = {
                  ...tier,
                  label: event.target.value.trim() ? event.target.value : null,
                };
                onChange(next);
              }}
              className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-sm text-white"
            />
          </label>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...tiers, emptyTier()])}
        className="rounded-lg bg-cyan-500/20 px-3 py-2 text-sm font-semibold text-cyan-200 hover:bg-cyan-500/30"
      >
        Add tier
      </button>
    </div>
  );
}

function VersionCompare({
  left,
  right,
}: {
  left: ArbPublishedConfiguration | null;
  right: ArbPublishedConfiguration | null;
}) {
  if (!left || !right) {
    return (
      <p className="mt-3 text-sm text-neutral-400">
        Select two versions to compare policy and tiers.
      </p>
    );
  }
  return (
    <div className="mt-3 grid gap-3 md:grid-cols-2">
      {[left, right].map((version) => (
        <div
          key={version.versionId}
          className="rounded-xl border border-white/10 bg-black/25 p-3 text-sm"
        >
          <p className="font-semibold text-cyan-200">
            v{version.versionNumber} · {version.status}
          </p>
          <p className="mt-1 font-mono text-xs text-neutral-500">{version.versionId}</p>
          <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap text-xs text-neutral-300">
            {JSON.stringify(
              { policy: version.policy, tiers: version.tiers },
              null,
              2
            )}
          </pre>
        </div>
      ))}
    </div>
  );
}

export function AutomaticRechargeBonusAdminView() {
  const [overview, setOverview] = useState<ArbAdminOverview | null>(null);
  const [draft, setDraft] = useState<ArbDraftConfiguration | null>(null);
  const [audit, setAudit] = useState<ArbSettingsAuditEntry[]>([]);
  const [tab, setTab] = useState<TabId>('draft');
  const [message, setMessage] = useState<string | null>(null);
  const [serverValidation, setServerValidation] = useState<ArbValidationResult | null>(
    null
  );
  const [acceptGapWarnings, setAcceptGapWarnings] = useState(false);
  const [compareLeftId, setCompareLeftId] = useState('');
  const [compareRightId, setCompareRightId] = useState('');
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const liveValidation = useMemo(() => {
    if (!draft) return null;
    return validateArbDraftConfiguration(draft, {
      featureEnabled: overview?.settings.operational.featureEnabled === true,
      requireNonEmptyTiers: false,
    });
  }, [draft, overview?.settings.operational.featureEnabled]);

  const previewRows = useMemo(() => {
    if (!draft) return [];
    const configuration: ArbPublishedConfiguration = {
      versionId: 'draft-preview',
      versionNumber: 0,
      status: 'published',
      coadminUid: overview?.settings.coadminUid || 'preview',
      publishedAt: new Date(0).toISOString(),
      publishedByUid: null,
      publishedByRole: null,
      supersedesVersionId: null,
      policy: draft.policy,
      tiers: draft.tiers,
    };
    return previewAutomaticRechargeBonusTable(configuration, PREVIEW_AMOUNTS);
  }, [draft, overview?.settings.coadminUid]);

  const selectedVersion =
    overview?.versions.find((version) => version.versionId === selectedVersionId) ||
    null;
  const compareLeft =
    overview?.versions.find((version) => version.versionId === compareLeftId) || null;
  const compareRight =
    overview?.versions.find((version) => version.versionId === compareRightId) || null;

  async function refreshAll() {
    const next = await loadArbAdminOverview();
    setOverview(next);
    setDraft(cloneDraft(next.settings.draft));
    setServerValidation(null);
    setLoadError(null);
    if (next.published?.versionId) {
      setSelectedVersionId(next.published.versionId);
      setCompareLeftId(next.published.versionId);
    }
    if (next.versions[1]?.versionId) {
      setCompareRightId(next.versions[1].versionId);
    }
    const entries = await loadArbAuditEntries({ limit: 40 });
    setAudit(entries);
  }

  useEffect(() => {
    startTransition(() => {
      void refreshAll().catch((error: unknown) => {
        const messageText =
          error instanceof Error
            ? error.message
            : 'Failed to load Automatic Recharge Bonus administration.';
        setLoadError(messageText);
      });
    });
  }, []);

  useEffect(() => {
    if (!overview) return;
    if (
      overview.flags.reporting_enabled &&
      !overview.flags.admin_enabled &&
      tab !== 'reporting'
    ) {
      setTab('reporting');
    }
  }, [overview, tab]);

  function applySettingsFromServer(settings: ArbAdminOverview['settings']) {
    setOverview((current) =>
      current
        ? {
            ...current,
            settings,
          }
        : current
    );
    setDraft(cloneDraft(settings.draft));
  }

  function handleApiError(error: unknown, fallback: string) {
    const apiError = error as ArbAdminApiError;
    setMessage(apiError?.message || fallback);
    if (apiError?.validation) {
      setServerValidation(apiError.validation);
    }
  }

  function run(action: () => Promise<void>) {
    startTransition(() => {
      void action().catch((error: unknown) => {
        handleApiError(error, 'Request failed.');
      });
    });
  }

  if (loadError) {
    return (
      <div className="rounded-2xl border border-rose-500/30 bg-black/30 p-5">
        <h2 className="text-2xl font-bold">Automatic Recharge Bonus</h2>
        <p className="mt-3 text-sm text-rose-200">{loadError}</p>
        <p className="mt-2 text-xs text-neutral-400">
          Administration requires ARB_ADMIN_ENABLED=1 and migration 068.
        </p>
      </div>
    );
  }

  if (!overview || !draft) {
    return (
      <div className="rounded-2xl border border-white/10 bg-black/30 p-5">
        <h2 className="text-2xl font-bold">Automatic Recharge Bonus</h2>
        <p className="mt-3 text-sm text-neutral-400">Loading configuration…</p>
      </div>
    );
  }

  const tabs: { id: TabId; label: string }[] = [
    { id: 'draft', label: 'Draft & tiers' },
    { id: 'preview', label: 'Preview' },
    { id: 'versions', label: 'Versions' },
    { id: 'audit', label: 'Audit' },
    { id: 'operational', label: 'Operational' },
  ];
  if (overview.flags.reporting_enabled) {
    tabs.push({ id: 'reporting', label: 'Reporting' });
  }

  const sessionRole = getCachedSessionUser()?.role || null;
  const isAdmin = sessionRole === 'admin';

  return (
    <div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold">Automatic Recharge Bonus</h2>
          <p className="mt-2 max-w-2xl text-sm text-neutral-400">
            Coadmin configuration only. Publishing creates an immutable version. Player
            grants and Bonus Event behaviour are not controlled here yet.
          </p>
        </div>
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            run(async () => {
              await refreshAll();
              setMessage('Refreshed.');
            })
          }
          className="rounded-lg bg-white/10 px-4 py-2 text-sm font-semibold text-neutral-100 hover:bg-white/15 disabled:opacity-50"
        >
          Refresh
        </button>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-white/10 bg-black/25 p-3 text-sm">
          <p className="text-xs uppercase text-neutral-500">Published</p>
          <p className="mt-1 font-semibold text-cyan-200">
            {overview.published
              ? `v${overview.published.versionNumber}`
              : 'None'}
          </p>
        </div>
        <div className="rounded-xl border border-white/10 bg-black/25 p-3 text-sm">
          <p className="text-xs uppercase text-neutral-500">Feature</p>
          <p className="mt-1 font-semibold">
            {overview.settings.operational.featureEnabled ? 'Enabled' : 'Disabled'}
            {overview.settings.operational.emergencyDisable ? ' · Emergency off' : ''}
          </p>
        </div>
        <div className="rounded-xl border border-white/10 bg-black/25 p-3 text-sm">
          <p className="text-xs uppercase text-neutral-500">Player opt-in allowed</p>
          <p className="mt-1 font-semibold">
            {overview.settings.operational.playerOptInAllowed ? 'Yes' : 'No'}
          </p>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
            className={`rounded-lg px-3 py-2 text-sm font-semibold ${
              tab === item.id
                ? 'bg-cyan-500 text-black'
                : 'bg-white/10 text-neutral-200 hover:bg-white/15'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {message ? (
        <p className="mt-4 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-3 py-2 text-sm text-cyan-100">
          {message}
        </p>
      ) : null}

      {serverValidation ? (
        <>
          <ValidationList
            title="Server validation errors"
            items={serverValidation.errors}
            tone="error"
          />
          <ValidationList
            title="Server validation warnings"
            items={serverValidation.warnings}
            tone="warning"
          />
        </>
      ) : null}

      {tab === 'draft' && (
        <div className="mt-6 rounded-2xl border border-white/10 bg-black/30 p-5">
          <h3 className="text-lg font-semibold">Business policy</h3>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <label className="block text-xs text-neutral-400">
              Minimum recharge
              <input
                type="number"
                value={draft.policy.minimumRecharge}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    policy: {
                      ...draft.policy,
                      minimumRecharge: Number(event.target.value),
                    },
                  })
                }
                className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white"
              />
            </label>
            <label className="block text-xs text-neutral-400">
              Maximum recharge considered (blank = none)
              <input
                type="number"
                value={draft.policy.maximumRechargeConsidered ?? ''}
                onChange={(event) => {
                  const raw = event.target.value.trim();
                  setDraft({
                    ...draft,
                    policy: {
                      ...draft.policy,
                      maximumRechargeConsidered: raw === '' ? null : Number(raw),
                    },
                  });
                }}
                className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white"
              />
            </label>
            <label className="block text-xs text-neutral-400">
              Maximum bonus cap (blank = none)
              <input
                type="number"
                value={draft.policy.maximumBonusCap ?? ''}
                onChange={(event) => {
                  const raw = event.target.value.trim();
                  setDraft({
                    ...draft,
                    policy: {
                      ...draft.policy,
                      maximumBonusCap: raw === '' ? null : Number(raw),
                    },
                  });
                }}
                className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white"
              />
            </label>
            <label className="block text-xs text-neutral-400">
              Cooldown minutes after disable
              <input
                type="number"
                value={draft.policy.cooldownDurationMinutes}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    policy: {
                      ...draft.policy,
                      cooldownDurationMinutes: Number(event.target.value),
                    },
                  })
                }
                className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white"
              />
            </label>
          </div>

          <h3 className="mt-6 text-lg font-semibold">Reward tiers</h3>
          <TierEditor
            tiers={draft.tiers}
            onChange={(tiers) => setDraft({ ...draft, tiers })}
          />

          {liveValidation ? (
            <>
              <ValidationList
                title="Live validation errors"
                items={liveValidation.errors}
                tone="error"
              />
              <ValidationList
                title="Live validation warnings"
                items={liveValidation.warnings}
                tone="warning"
              />
            </>
          ) : null}

          <div className="mt-5 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                run(async () => {
                  const result = await saveArbDraft({ draft });
                  applySettingsFromServer(result.settings);
                  setServerValidation(result.validation);
                  setMessage(
                    result.duplicate ? 'Draft save was idempotent.' : 'Draft saved.'
                  );
                  await refreshAll();
                })
              }
              className="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-bold text-black hover:bg-cyan-400 disabled:opacity-50"
            >
              Save draft
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                run(async () => {
                  const result = await publishArbDraft({ acceptGapWarnings });
                  setMessage(
                    result.duplicate
                      ? `Publish idempotent — still v${result.version.versionNumber}.`
                      : `Published v${result.version.versionNumber}.`
                  );
                  setServerValidation(null);
                  await refreshAll();
                })
              }
              className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-bold text-black hover:bg-emerald-400 disabled:opacity-50"
            >
              Publish
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                run(async () => {
                  const confirmed = window.confirm(
                    'Reset draft to default linear tiers? Published versions are unchanged.'
                  );
                  if (!confirmed) return;
                  const result = await resetArbDraftToDefaults();
                  applySettingsFromServer(result.settings);
                  setServerValidation(result.validation);
                  setMessage('Draft reset to defaults.');
                  await refreshAll();
                })
              }
              className="rounded-lg bg-white/10 px-4 py-2 text-sm font-semibold text-neutral-100 hover:bg-white/15 disabled:opacity-50"
            >
              Reset draft to defaults
            </button>
            <label className="ml-2 flex items-center gap-2 text-sm text-neutral-300">
              <input
                type="checkbox"
                checked={acceptGapWarnings}
                onChange={(event) => setAcceptGapWarnings(event.target.checked)}
              />
              Accept tier gaps on publish
            </label>
          </div>
        </div>
      )}

      {tab === 'preview' && (
        <div className="mt-6 overflow-x-auto rounded-2xl border border-white/10 bg-black/30 p-5">
          <h3 className="text-lg font-semibold">Draft resolver preview</h3>
          <p className="mt-1 text-sm text-neutral-400">
            Uses the Phase 2 pure resolver against the current draft (not published).
          </p>
          <table className="mt-4 w-full min-w-[520px] text-left text-sm">
            <thead className="text-xs uppercase text-neutral-500">
              <tr>
                <th className="py-2">Amount</th>
                <th>Eligible</th>
                <th>Bonus</th>
                <th>Skip reason</th>
                <th>Tier</th>
              </tr>
            </thead>
            <tbody>
              {previewRows.map((row) => (
                <tr key={row.rechargeAmount} className="border-t border-white/10">
                  <td className="py-2 font-mono">${row.rechargeAmount}</td>
                  <td>{row.eligible ? 'yes' : 'no'}</td>
                  <td className="font-mono">{row.bonusCoins}</td>
                  <td className="font-mono text-xs text-neutral-400">
                    {row.skipReason || '—'}
                  </td>
                  <td className="font-mono text-xs text-neutral-400">
                    {row.tier?.id || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'versions' && (
        <div className="mt-6 rounded-2xl border border-white/10 bg-black/30 p-5">
          <h3 className="text-lg font-semibold">Version history</h3>
          <div className="mt-4 space-y-2">
            {overview.versions.length === 0 ? (
              <p className="text-sm text-neutral-400">No published versions yet.</p>
            ) : (
              overview.versions.map((version) => (
                <div
                  key={version.versionId}
                  className={`flex flex-col gap-2 rounded-xl border p-3 sm:flex-row sm:items-center sm:justify-between ${
                    version.versionId === overview.published?.versionId
                      ? 'border-cyan-500/40 bg-cyan-500/10'
                      : 'border-white/10 bg-black/25'
                  }`}
                >
                  <button
                    type="button"
                    className="text-left"
                    onClick={() => setSelectedVersionId(version.versionId)}
                  >
                    <p className="font-semibold">
                      v{version.versionNumber} · {version.status}
                    </p>
                    <p className="font-mono text-xs text-neutral-500">
                      {version.versionId}
                    </p>
                    <p className="text-xs text-neutral-400">{version.publishedAt}</p>
                  </button>
                  <button
                    type="button"
                    disabled={
                      pending ||
                      version.versionId === overview.published?.versionId
                    }
                    onClick={() =>
                      run(async () => {
                        const confirmed = window.confirm(
                          `Roll back to v${version.versionNumber}? Historical JSON is never edited.`
                        );
                        if (!confirmed) return;
                        const result = await rollbackArbConfig({
                          targetVersionId: version.versionId,
                        });
                        setMessage(
                          `Rolled back to v${result.version.versionNumber}.`
                        );
                        await refreshAll();
                      })
                    }
                    className="rounded-lg bg-amber-500/20 px-3 py-2 text-sm font-semibold text-amber-100 hover:bg-amber-500/30 disabled:opacity-40"
                  >
                    Roll back
                  </button>
                </div>
              ))
            )}
          </div>

          {selectedVersion ? (
            <div className="mt-5 rounded-xl border border-white/10 bg-black/25 p-3">
              <h4 className="font-semibold">
                Selected v{selectedVersion.versionNumber}
              </h4>
              <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap text-xs text-neutral-300">
                {JSON.stringify(
                  {
                    policy: selectedVersion.policy,
                    tiers: selectedVersion.tiers,
                  },
                  null,
                  2
                )}
              </pre>
            </div>
          ) : null}

          <h4 className="mt-6 font-semibold">Compare versions</h4>
          <div className="mt-2 flex flex-wrap gap-3">
            <label className="text-xs text-neutral-400">
              Left
              <select
                value={compareLeftId}
                onChange={(event) => setCompareLeftId(event.target.value)}
                className="mt-1 block rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-sm text-white"
              >
                <option value="">—</option>
                {overview.versions.map((version) => (
                  <option key={`l-${version.versionId}`} value={version.versionId}>
                    v{version.versionNumber}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-neutral-400">
              Right
              <select
                value={compareRightId}
                onChange={(event) => setCompareRightId(event.target.value)}
                className="mt-1 block rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-sm text-white"
              >
                <option value="">—</option>
                {overview.versions.map((version) => (
                  <option key={`r-${version.versionId}`} value={version.versionId}>
                    v{version.versionNumber}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <VersionCompare left={compareLeft} right={compareRight} />
        </div>
      )}

      {tab === 'audit' && (
        <div className="mt-6 rounded-2xl border border-white/10 bg-black/30 p-5">
          <h3 className="text-lg font-semibold">Configuration audit</h3>
          {audit.length === 0 ? (
            <p className="mt-3 text-sm text-neutral-400">No audit rows yet.</p>
          ) : (
            <div className="mt-4 space-y-2">
              {audit.map((entry) => (
                <details
                  key={entry.id}
                  className="rounded-xl border border-white/10 bg-black/25 p-3 text-sm"
                >
                  <summary className="cursor-pointer font-semibold">
                    {entry.action} · {entry.changedAt || '—'}
                  </summary>
                  <p className="mt-2 font-mono text-xs text-neutral-500">
                    actor={entry.actorUid || '—'} role={entry.actorRole || '—'} version=
                    {entry.versionId || '—'}
                  </p>
                  <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-xs text-neutral-300">
                    {JSON.stringify(
                      { oldJson: entry.oldJson, newJson: entry.newJson },
                      null,
                      2
                    )}
                  </pre>
                </details>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'operational' && (
        <div className="mt-6 rounded-2xl border border-white/10 bg-black/30 p-5">
          <h3 className="text-lg font-semibold">Operational settings</h3>
          <p className="mt-2 text-sm text-neutral-400">
            These flags do not grant coins or change player preference APIs in Phase 3.
            Feature enable requires a published configuration.
          </p>
          <div className="mt-4 space-y-3">
            {(
              [
                ['featureEnabled', 'Feature enabled'],
                ['emergencyDisable', 'Emergency disable'],
                ['playerOptInAllowed', 'Player opt-in allowed'],
              ] as const
            ).map(([key, label]) => (
              <label
                key={key}
                className="flex items-center justify-between rounded-xl border border-white/10 bg-black/25 px-3 py-3 text-sm"
              >
                <span>{label}</span>
                <input
                  type="checkbox"
                  checked={overview.settings.operational[key]}
                  disabled={pending}
                  onChange={(event) =>
                    run(async () => {
                      const result = await updateArbOperational({
                        operational: { [key]: event.target.checked },
                      });
                      applySettingsFromServer(result.settings);
                      setMessage(`${label} updated.`);
                      await refreshAll();
                    })
                  }
                />
              </label>
            ))}
          </div>
          <div className="mt-4 rounded-xl border border-white/10 bg-black/25 p-3 text-xs text-neutral-400">
            <p>Platform flags (read-only):</p>
            <pre className="mt-2 overflow-auto">
              {JSON.stringify(overview.flags, null, 2)}
            </pre>
          </div>
        </div>
      )}

      {tab === 'reporting' && overview.flags.reporting_enabled ? (
        <div className="mt-5 space-y-4 rounded-2xl border border-fuchsia-400/20 bg-black/25 p-4">
          <div>
            <h3 className="text-lg font-bold text-white">Reporting & operations</h3>
            <p className="mt-1 text-sm text-neutral-400">
              Read-only KPIs, histories, audit, reconciliation, and system health. No
              financial writes. Ops docs: docs/automatic-recharge-bonus/
            </p>
          </div>
          <AutomaticRechargeBonusHealthPanel
            coadminUid={overview.settings.coadminUid}
          />
          <AutomaticRechargeBonusReportingPanel
            isAdmin={isAdmin}
            coadminUid={overview.settings.coadminUid}
          />
        </div>
      ) : null}
    </div>
  );
}
