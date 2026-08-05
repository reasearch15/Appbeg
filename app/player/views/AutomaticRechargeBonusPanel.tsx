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

/**
 * Compact in-banner Auto Bonus control.
 *
 * Primary action is one tap → existing onToggle (API).
 * Modal/overlay for activate was removed. Help "?" is optional info only.
 */
export default function AutomaticRechargeBonusPanel({
  playerModeEnabled,
  mode,
  enabled: _enabled,
  cooldownEndsAt,
  canEnable,
  canDisable,
  featureEnabled,
  riskBlocked,
  toggling,
  onToggle,
  message,
}: AutomaticRechargeBonusPanelProps) {
  const helpTitleId = useId();
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [helpOpen, setHelpOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== 'cooldown' || !cooldownEndsAt) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [mode, cooldownEndsAt]);

  useEffect(() => {
    if (!message) return;
    setToast(message);
    const timer = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(timer);
  }, [message]);

  useEffect(() => {
    if (!helpOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setHelpOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [helpOpen]);

  if (!playerModeEnabled) {
    return null;
  }

  const cooldownLabel = formatArbCooldownRemaining(cooldownEndsAt, nowMs);
  const isOn = mode === 'enabled';
  const isCooldown = mode === 'cooldown';
  const isUnavailable =
    !isOn &&
    !isCooldown &&
    (riskBlocked || !featureEnabled || !canEnable);

  let label = 'ACTIVATE BONUS';
  let className =
    'border-rose-400/80 bg-rose-500 text-white shadow-[0_0_14px_-5px_rgba(244,63,94,0.8)] hover:brightness-110';
  let disabled = toggling;

  if (isOn) {
    label = '✓ BONUS ACTIVE';
    className =
      'border-emerald-300/80 bg-emerald-400 text-black shadow-[0_0_14px_-5px_rgba(52,211,153,0.85)] hover:brightness-105';
    disabled = toggling || !canDisable;
  } else if (isCooldown) {
    label = cooldownLabel ? `COOLDOWN ${cooldownLabel}` : 'COOLDOWN';
    className =
      'border-orange-300/70 bg-orange-500 text-white shadow-[0_0_14px_-5px_rgba(249,115,22,0.75)]';
    disabled = true;
  } else if (isUnavailable) {
    label = 'UNAVAILABLE';
    className =
      'border-neutral-500/50 bg-neutral-600 text-neutral-200 cursor-not-allowed';
    disabled = true;
  }

  const handlePrimaryClick = () => {
    if (disabled || toggling) return;
    if (isOn) {
      onToggle(false);
      return;
    }
    // OFF → immediate activate via existing toggle API (no modal).
    onToggle(true);
  };

  return (
    <div className="relative flex items-center gap-1.5">
      <button
        type="button"
        onClick={handlePrimaryClick}
        disabled={disabled}
        aria-busy={toggling || undefined}
        className={`inline-flex max-w-full items-center justify-center rounded-full border px-3 py-1.5 text-[10px] font-black uppercase tracking-wide transition active:scale-[0.98] disabled:opacity-70 sm:px-3.5 sm:text-[11px] ${className}`}
      >
        <span className="truncate">{toggling ? '…' : label}</span>
      </button>

      <button
        type="button"
        onClick={() => setHelpOpen(true)}
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-amber-200/35 bg-black/35 text-[11px] font-black text-amber-100/85 transition hover:bg-black/50"
        aria-label="About Automatic Bonus"
      >
        ?
      </button>

      {toast ? (
        <div
          role="status"
          className="absolute right-0 top-full z-20 mt-2 max-w-[14rem] rounded-xl border border-amber-400/35 bg-black/90 px-2.5 py-1.5 text-[11px] font-semibold text-amber-50 shadow-lg sm:max-w-[16rem]"
        >
          {toast}
        </div>
      ) : null}

      {helpOpen ? (
        <div
          className="fixed inset-0 z-[80] flex items-end justify-center bg-black/55 p-3 sm:items-center sm:p-6"
          role="presentation"
          onClick={() => setHelpOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={helpTitleId}
            className="w-full max-w-sm rounded-2xl border border-white/15 bg-[#121212] p-4 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-2">
              <h3 id={helpTitleId} className="text-sm font-black text-white">
                Automatic Bonus
              </h3>
              <button
                type="button"
                onClick={() => setHelpOpen(false)}
                className="rounded-full border border-white/15 px-2 py-0.5 text-[10px] font-bold text-white/70"
              >
                Close
              </button>
            </div>
            <div className="mt-3 space-y-2 text-xs leading-relaxed text-white/75">
              <p>
                When active, eligible completed recharges can earn promo-locked
                bonus coins from published reward tiers.
              </p>
              <p>
                Bonus Event claims stay locked while Auto Bonus is on. Turning it
                off starts a cooldown before Bonus Events unlock again.
              </p>
              <p>Tap the button once to turn Automatic Bonus on or off.</p>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
