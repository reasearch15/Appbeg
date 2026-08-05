'use client';

import { useEffect, useId, useState } from 'react';
import {
  formatArbCooldownRemaining,
  type ArbPlayerMode,
} from '@/features/automaticRechargeBonus/playerArbPreference';

export type AutomaticRechargeBonusPanelProps = {
  playerModeEnabled: boolean;
  mode: ArbPlayerMode;
  enabled: boolean;
  cooldownEndsAt: string | null;
  canEnable: boolean;
  canDisable: boolean;
  canClaimBonusEvent: boolean;
  featureEnabled: boolean;
  riskBlocked: boolean;
  toggling: boolean;
  onToggle: (enabled: boolean) => void;
  message?: string | null;
};

/** Compact illustrative sample of the platform default linear tier pattern. */
const TIER_SAMPLES: { recharge: string; bonus: string }[] = [
  { recharge: '$10–19', bonus: '1 coin' },
  { recharge: '$20–29', bonus: '2 coins' },
  { recharge: '$50–59', bonus: '5 coins' },
  { recharge: '$100–109', bonus: '10 coins' },
  { recharge: '$200+', bonus: '20 coins' },
];

export default function AutomaticRechargeBonusPanel({
  playerModeEnabled,
  mode,
  enabled,
  cooldownEndsAt,
  canEnable,
  canDisable,
  canClaimBonusEvent,
  featureEnabled,
  riskBlocked,
  toggling,
  onToggle,
  message,
}: AutomaticRechargeBonusPanelProps) {
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (mode !== 'cooldown' || !cooldownEndsAt) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [mode, cooldownEndsAt]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!playerModeEnabled) {
    return null;
  }

  const cooldownLabel = formatArbCooldownRemaining(cooldownEndsAt, nowMs);
  const isOn = mode === 'enabled';
  const isCooldown = mode === 'cooldown';
  const toggleDisabled =
    toggling ||
    riskBlocked ||
    (isOn && !canDisable) ||
    (!isOn && !isCooldown && !canEnable);

  let statusLine = 'Off — Bonus Events available when drops appear.';
  if (isOn) {
    statusLine =
      'On — eligible recharges can earn promo-locked bonus coins. Bonus Events are locked.';
  } else if (isCooldown) {
    statusLine = cooldownLabel
      ? `Cooldown — Bonus Events unlock in ${cooldownLabel}. Auto grants are off.`
      : 'Cooldown — Bonus Events unlock soon. Auto grants are off.';
  } else if (riskBlocked) {
    statusLine = 'Temporarily unavailable for this account.';
  } else if (!featureEnabled) {
    statusLine = 'Not available from your coadmin right now.';
  }

  const chipLabel = isOn
    ? 'Bonus Active ✓'
    : isCooldown
      ? cooldownLabel
        ? `Cooldown ${cooldownLabel}`
        : 'Cooldown'
      : 'Activate Bonus';

  const chipClass = isOn
    ? 'border-emerald-300/70 bg-emerald-400 text-black shadow-[0_0_18px_-6px_rgba(52,211,153,0.75)]'
    : isCooldown
      ? 'border-orange-300/60 bg-orange-500 text-white shadow-[0_0_16px_-6px_rgba(249,115,22,0.7)]'
      : 'border-emerald-300/55 bg-emerald-500 text-black shadow-[0_0_16px_-6px_rgba(16,185,129,0.65)] hover:brightness-110';

  const primaryActionLabel = isOn
    ? toggling
      ? 'Turning off…'
      : 'Turn Auto Bonus off'
    : isCooldown
      ? 'Cooldown active'
      : toggling
        ? 'Turning on…'
        : 'Turn Auto Bonus on';

  const handlePrimaryAction = () => {
    if (toggleDisabled) return;
    if (isOn) {
      onToggle(false);
      return;
    }
    if (!isCooldown) {
      onToggle(true);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`inline-flex max-w-full items-center justify-center rounded-full border px-3 py-1.5 text-[11px] font-black uppercase tracking-wide transition active:scale-[0.98] sm:px-3.5 sm:text-xs ${chipClass}`}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span className="truncate">{chipLabel}</span>
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-[80] flex items-end justify-center bg-black/70 p-3 sm:items-center sm:p-6"
          role="presentation"
          onClick={() => setOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="max-h-[min(88vh,36rem)] w-full max-w-md overflow-y-auto rounded-3xl border border-emerald-400/30 bg-gradient-to-br from-[#0d1f18] via-[#101010] to-black p-4 shadow-2xl sm:p-5"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.22em] text-emerald-200/80">
                  Automatic Recharge Bonus
                </p>
                <h3 id={titleId} className="mt-1 text-lg font-black text-white">
                  Auto Bonus
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-full border border-white/15 bg-white/5 px-2.5 py-1 text-xs font-bold text-white/80"
              >
                Close
              </button>
            </div>

            <p className="mt-3 rounded-2xl border border-white/10 bg-black/35 px-3 py-2 text-xs font-semibold text-emerald-50/90">
              Status: {statusLine}
            </p>

            <div className="mt-4 space-y-2 text-sm leading-relaxed text-emerald-50/80">
              <p>
                When Auto Bonus is on, eligible completed recharges can earn
                promo-locked bonus coins from your coadmin&apos;s published tiers.
              </p>
              <p>
                Bonus Event claims stay locked while Auto is on. Turning Auto off
                starts a cooldown — grants stop, and Bonus Events stay locked until
                the timer ends.
              </p>
            </div>

            <div className="mt-4 overflow-hidden rounded-2xl border border-white/10">
              <div className="bg-emerald-500/15 px-3 py-2 text-[10px] font-black uppercase tracking-wider text-emerald-100/90">
                Reward tiers (typical pattern)
              </div>
              <table className="w-full text-left text-xs text-emerald-50/90 sm:text-sm">
                <thead className="bg-black/40 text-[10px] uppercase tracking-wider text-emerald-200/70">
                  <tr>
                    <th className="px-3 py-2 font-bold">Recharge</th>
                    <th className="px-3 py-2 font-bold">Bonus</th>
                  </tr>
                </thead>
                <tbody>
                  {TIER_SAMPLES.map((row) => (
                    <tr key={row.recharge} className="border-t border-white/5">
                      <td className="px-3 py-1.5 font-semibold">{row.recharge}</td>
                      <td className="px-3 py-1.5">{row.bonus}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="border-t border-white/5 bg-black/30 px-3 py-2 text-[10px] leading-snug text-emerald-100/55">
                Exact tiers come from your coadmin&apos;s published configuration.
              </p>
            </div>

            {!canClaimBonusEvent ? (
              <p className="mt-3 rounded-2xl border border-amber-400/30 bg-amber-500/15 px-3 py-2 text-xs font-semibold text-amber-100">
                {isOn
                  ? 'Bonus Event claims are locked while Auto is on.'
                  : isCooldown
                    ? 'Bonus Event claims stay locked until cooldown ends.'
                    : 'Bonus Event claims are currently locked.'}
              </p>
            ) : null}

            {message ? (
              <p className="mt-3 rounded-2xl border border-violet-400/30 bg-violet-500/15 px-3 py-2 text-xs font-semibold text-violet-100">
                {message}
              </p>
            ) : null}

            <button
              type="button"
              disabled={toggleDisabled || isCooldown}
              onClick={handlePrimaryAction}
              className={`mt-4 flex min-h-[44px] w-full items-center justify-center rounded-2xl px-4 py-2.5 text-sm font-black transition active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50 ${
                isOn
                  ? 'border border-rose-300/40 bg-rose-500/90 text-white'
                  : isCooldown
                    ? 'border border-orange-300/40 bg-orange-500/80 text-white'
                    : 'bg-emerald-400 text-black shadow-[0_0_20px_-6px_rgba(52,211,153,0.7)]'
              }`}
            >
              {primaryActionLabel}
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}
