'use client';

import { useEffect, useState } from 'react';
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
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (mode !== 'cooldown' || !cooldownEndsAt) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [mode, cooldownEndsAt]);

  if (!playerModeEnabled) {
    return null;
  }

  const cooldownLabel = formatArbCooldownRemaining(cooldownEndsAt, nowMs);
  const toggleChecked = mode === 'enabled';
  const toggleDisabled =
    toggling ||
    riskBlocked ||
    (!toggleChecked && !canEnable) ||
    (toggleChecked && !canDisable);

  let statusLine = 'Off — Bonus Events available when drops appear.';
  if (mode === 'enabled') {
    statusLine =
      'On — bonus coins (promo-locked) apply automatically on eligible recharges. Bonus Events are locked.';
  } else if (mode === 'cooldown') {
    statusLine = cooldownLabel
      ? `Cooldown — Bonus Events unlock in ${cooldownLabel}. Auto grants are off.`
      : 'Cooldown — Bonus Events unlock soon. Auto grants are off.';
  } else if (riskBlocked) {
    statusLine = 'Temporarily unavailable for this account.';
  } else if (!featureEnabled) {
    statusLine = 'Not available from your coadmin right now.';
  }

  return (
    <div className="fire-panel fire-purple rounded-3xl border border-cyan-400/30 bg-gradient-to-br from-[#0d2433]/92 via-[#14091f]/92 to-black/85 p-5 shadow-[0_0_34px_-16px_rgba(34,211,238,0.35)] sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-black uppercase tracking-[0.28em] text-cyan-200/80">
            Automatic Recharge Bonus
          </p>
          <h3 className="mt-2 text-xl font-black text-white sm:text-2xl">
            Auto bonus mode
          </h3>
          <p className="mt-2 text-sm leading-relaxed text-cyan-50/80 sm:text-base">
            {statusLine}
          </p>
        </div>
        <label className="flex shrink-0 cursor-pointer items-center gap-3 rounded-2xl border border-cyan-400/25 bg-black/35 px-3 py-2.5">
          <span className="text-xs font-bold uppercase tracking-wider text-cyan-100/80">
            {toggleChecked ? 'On' : 'Off'}
          </span>
          <input
            type="checkbox"
            className="h-5 w-5 accent-cyan-400"
            checked={toggleChecked}
            disabled={toggleDisabled}
            onChange={(event) => onToggle(event.target.checked)}
            aria-label="Toggle Automatic Recharge Bonus"
          />
        </label>
      </div>

      {!canClaimBonusEvent ? (
        <p className="mt-3 rounded-2xl border border-amber-400/30 bg-amber-500/15 px-3 py-2 text-xs font-semibold text-amber-100 sm:text-sm">
          {mode === 'enabled'
            ? 'Bonus Event claims are locked while Auto is on.'
            : mode === 'cooldown'
              ? 'Bonus Event claims stay locked until cooldown ends.'
              : 'Bonus Event claims are currently locked.'}
        </p>
      ) : null}

      <div className="mt-4 space-y-2 text-sm leading-relaxed text-cyan-50/75">
        <p>
          When Auto is on, eligible completed recharges can earn promo-locked bonus coins
          from your coadmin&apos;s published tiers. You cannot claim Bonus Event drops at
          the same time.
        </p>
        <p>
          Turning Auto off starts a cooldown. During cooldown, Auto grants stop and Bonus
          Events stay locked until the timer ends.
        </p>
      </div>

      {message ? (
        <p className="mt-3 rounded-2xl border border-violet-400/30 bg-violet-500/15 px-3 py-2 text-xs font-semibold text-violet-100">
          {message}
        </p>
      ) : null}
    </div>
  );
}
