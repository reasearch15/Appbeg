'use client';

import { useEffect, useId, useState } from 'react';
import type { ArbPlayerMode } from '@/features/automaticRechargeBonus/playerArbPreference';

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
 * Play-page Auto Bonus preference toggle.
 * Exactly two states: ACTIVATE BONUS (off) / BONUS ACTIVE (on).
 * Cooldown is a Bonus Events concern — never shown or enforced here.
 */
export default function AutomaticRechargeBonusPanel({
  playerModeEnabled,
  mode,
  enabled,
  toggling,
  onToggle,
  message,
}: AutomaticRechargeBonusPanelProps) {
  const helpTitleId = useId();
  const [helpOpen, setHelpOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

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

  // Preference only. Cooldown never affects this button — Bonus Events own that.
  const isOn = enabled === true || mode === 'enabled';

  const label = isOn ? '✓ BONUS ACTIVE' : 'ACTIVATE BONUS';
  const className = isOn
    ? 'border-emerald-300/80 bg-emerald-400 text-black shadow-[0_0_14px_-5px_rgba(52,211,153,0.85)] hover:brightness-105'
    : 'border-rose-400/80 bg-rose-500 text-white shadow-[0_0_14px_-5px_rgba(244,63,94,0.8)] hover:brightness-110';

  const handlePrimaryClick = () => {
    if (toggling) return;
    onToggle(!isOn);
  };

  return (
    <>
      <div className="relative flex items-center">
        <button
          type="button"
          onClick={handlePrimaryClick}
          disabled={toggling}
          aria-busy={toggling || undefined}
          className={`inline-flex max-w-full items-center justify-center rounded-full border px-3 py-1.5 text-[10px] font-black uppercase tracking-wide transition active:scale-[0.98] disabled:opacity-70 sm:px-3.5 sm:text-[11px] ${className}`}
        >
          <span className="truncate">{toggling ? '…' : label}</span>
        </button>

        {toast ? (
          <div
            role="status"
            className="absolute right-0 top-full z-20 mt-2 max-w-[14rem] rounded-xl border border-amber-400/35 bg-black/90 px-2.5 py-1.5 text-[11px] font-semibold text-amber-50 shadow-lg sm:max-w-[16rem]"
          >
            {toast}
          </div>
        ) : null}
      </div>

      <button
        type="button"
        onClick={() => setHelpOpen(true)}
        className="fixed right-3 top-[calc(0.75rem+env(safe-area-inset-top))] z-[300] inline-flex h-9 w-9 items-center justify-center rounded-full border border-amber-300/50 bg-black/80 text-sm font-black text-amber-100 shadow-[0_0_20px_-6px_rgba(251,191,36,0.75)] backdrop-blur-md transition hover:border-amber-200/70 hover:bg-black/90 md:right-4 md:top-4"
        aria-label="About Automatic Bonus"
      >
        ?
      </button>

      {helpOpen ? (
        <div
          className="fixed inset-0 z-[310] flex items-end justify-center bg-black/55 p-3 sm:items-center sm:p-6"
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
                Turning Auto Bonus on locks Bonus Event claims. Turning it off
                may start a Bonus Event cooldown — that countdown is shown on
                the Bonus page, not here.
              </p>
              <p>Tap once to turn Automatic Bonus on or off at any time.</p>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
