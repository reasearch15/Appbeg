'use client';

import { AnimatePresence, motion } from 'motion/react';
import { memo } from 'react';
import type { Dispatch, MouseEvent, SetStateAction } from 'react';
import type { BonusEvent } from '@/features/bonusEvents/bonusEvents';
import type { PlayerView } from '../types';
import { getPlayerBonusEventDescription } from '../utils';
import { MAX_PLAYER_BONUS_EVENTS_DISPLAY } from '@/features/bonusEvents/bonusEvents';
import { usePlayerRenderPerf } from '../performance';

type Props = {
  activatingBonusEventId: string | null;
  activeBonusCarouselIndex: number;
  agents: unknown[];
  bonusStripPaused: boolean;
  bonusVanishedToast: boolean;
  formatWalletAmount: (value: number) => string;
  gameLogins: unknown[];
  handleActivateBonusEvent: (bonusEvent: BonusEvent) => void;
  handleCopyReferralCode: (event: MouseEvent) => void;
  handleOpenFirstUnreadAgent: () => void;
  openCashToCoinTransferModal: () => void;
  openCoinToCashTransferModal: () => void;
  isBlockedPlayer: boolean;
  lowPerformanceMode?: boolean;
  maintenanceBreak: { enabled: boolean };
  playerBonusEvents: BonusEvent[];
  referralCode: string;
  setActiveView: Dispatch<SetStateAction<PlayerView>>;
  setBonusCarouselIndex: Dispatch<SetStateAction<number>>;
  setBonusStripPaused: (paused: boolean) => void;
  setMessage: (message: string) => void;
  setShowLoadCoinPanel: (show: boolean) => void;
  totalUnread: number;
  wallet: { coin: number; cash: number };
  arbCanClaimBonusEvent?: boolean;
  arbMode?: 'enabled' | 'cooldown' | 'disabled';
};

function Lobby(props: Props) {
  const {
    activatingBonusEventId,
    activeBonusCarouselIndex,
    agents,
    bonusStripPaused,
    bonusVanishedToast,
    formatWalletAmount,
    gameLogins,
    handleActivateBonusEvent,
    handleCopyReferralCode,
    handleOpenFirstUnreadAgent,
    openCashToCoinTransferModal,
    openCoinToCashTransferModal,
    isBlockedPlayer,
    maintenanceBreak,
    playerBonusEvents,
    referralCode,
    setActiveView,
    setBonusCarouselIndex,
    setBonusStripPaused,
    setMessage,
    setShowLoadCoinPanel,
    totalUnread,
    wallet,
    arbCanClaimBonusEvent = true,
    arbMode = 'disabled',
  } = props;

  usePlayerRenderPerf('Lobby', () => ({
    agentCount: agents.length,
    gameLoginCount: gameLogins.length,
    bonusEventCount: playerBonusEvents.length,
    totalUnread,
  }));

  return (

              <div className="space-y-3 sm:space-y-4">
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.45 }}
                  className="player-dashboard-hero fire-panel fire-orange fire-hero relative z-0 flex h-auto min-h-0 w-full max-w-full flex-col items-center overflow-hidden rounded-2xl border border-amber-400/35 bg-gradient-to-br from-amber-500/20 via-rose-600/10 to-purple-900/35 text-center shadow-[0_0_50px_-12px_rgba(234,179,8,0.45)]"
                >
                  <div className="pointer-events-none absolute bottom-0 left-1/4 h-32 w-32 rounded-full bg-red-500/12 blur-3xl sm:h-40 sm:w-40 sm:bg-red-500/15" />
                  <div className="pointer-events-none absolute right-8 top-4 h-20 w-20 rounded-full bg-amber-400/12 blur-2xl sm:right-10 sm:top-10 sm:h-32 sm:w-32 sm:bg-amber-400/20" />

                  <div className="player-dashboard-hero__content relative flex w-full min-w-0 flex-col items-center justify-center self-center pt-0">
                    <div className="player-dashboard-hero__intro min-w-0 w-full max-w-xl text-center">
                      <p className="flex items-center justify-center gap-1.5 text-sm font-black uppercase tracking-[0.26em] text-amber-200/90 sm:text-base">
                        <span className="text-base">👑</span> VIP welcome
                      </p>
                      <h2 className="mt-1 text-[clamp(2rem,4vw,3.35rem)] font-black leading-[0.92] bg-gradient-to-r from-white via-amber-100 to-amber-300 bg-clip-text text-transparent">
                        Jackpot floor is open
                      </h2>
                      <p className="mt-1.5 max-w-xl text-[0.95rem] leading-snug text-amber-100/80 sm:mx-auto sm:text-[1.05rem]">
                        💎 Luxury tables, 🔥 live agents, 🪙 instant balance — tap Play to hit the
                        reels and send recharge or redeem requests.
                      </p>
                    </div>

                    <div className="player-dashboard-hero__main flex w-full min-w-0 flex-col items-center gap-2">
                      <div className="mx-auto grid w-full max-w-lg grid-cols-2 items-stretch gap-2">
                        <div className="fire-panel fire-orange flex min-h-[6.75rem] flex-col items-center justify-center gap-1 rounded-2xl border border-amber-300/60 bg-black/35 px-3 py-3 text-center backdrop-blur-md shadow-[0_0_20px_-8px_rgba(251,191,36,0.55)] sm:min-h-[7.25rem]">
                          <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-amber-200/40 bg-amber-200/15 text-xl">
                            🪙
                          </span>
                          <p className="text-xs font-black uppercase tracking-wider text-amber-100/90 sm:text-sm">
                            Coin
                          </p>
                          <p className="text-xl font-black tabular-nums text-white sm:text-[1.65rem]">
                            {formatWalletAmount(wallet.coin)}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={openCoinToCashTransferModal}
                          disabled={maintenanceBreak.enabled}
                          className="fire-panel fire-green flex min-h-[6.75rem] cursor-pointer flex-col items-center justify-center gap-1 rounded-2xl border border-emerald-300/60 bg-black/35 px-3 py-3 text-center shadow-[0_0_20px_-8px_rgba(74,222,128,0.55)] transition hover:border-emerald-200/80 hover:brightness-110 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60 sm:min-h-[7.25rem]"
                          aria-label={`Transfer coin to cash. Current cash balance ${formatWalletAmount(wallet.cash)}`}
                        >
                          <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-emerald-200/40 bg-emerald-200/15 text-xl">
                            💵
                          </span>
                          <p className="text-xs font-black uppercase tracking-wider text-emerald-100/90 sm:text-sm">
                            Cash
                          </p>
                          <p className="text-xl font-black tabular-nums text-white sm:text-[1.65rem]">
                            {formatWalletAmount(wallet.cash)}
                          </p>
                        </button>
                      </div>
                      <div className="fire-panel fire-orange mx-auto flex w-full max-w-lg flex-wrap items-center justify-center gap-2 rounded-2xl border border-cyan-400/30 bg-black/35 px-3 py-2">
                        <p className="text-xs font-black uppercase tracking-wide text-cyan-200/85 sm:text-sm">
                          Your Referral Code:{' '}
                          <span className="text-sm text-white sm:text-base">{referralCode || 'Not available'}</span>
                        </p>
                        <button
                          type="button"
                          onClick={(e) => void handleCopyReferralCode(e)}
                          disabled={!referralCode}
                          className="fire-button fire-orange rounded-xl bg-cyan-400 px-3 py-1.5 text-xs font-black text-black hover:bg-cyan-300 disabled:opacity-50 sm:text-sm"
                        >
                          Copy Referral Code
                        </button>
                      </div>
                      <div className="mx-auto w-full max-w-lg">
                        <button
                          type="button"
                          onClick={() => {
                            setShowLoadCoinPanel(true);
                            setMessage('');
                          }}
                          disabled={isBlockedPlayer || maintenanceBreak.enabled}
                          className="fire-button fire-purple h-11 w-full rounded-2xl border border-violet-400/50 bg-violet-500/20 py-2 text-sm font-black text-violet-50 transition hover:bg-violet-500/30 disabled:cursor-not-allowed disabled:opacity-60 sm:h-12 sm:text-base"
                        >
                          ⬇ Load coin — Telegram bot
                        </button>
                      </div>
                    </div>

                    <div className="player-dashboard-hero__cta mx-auto flex w-full min-h-0 min-w-0 max-w-lg flex-col items-center justify-center gap-2">
                      <button
                        type="button"
                        onClick={() => setActiveView('play')}
                        disabled={maintenanceBreak.enabled}
                        className="fire-button fire-orange relative h-12 w-full min-w-0 overflow-hidden rounded-2xl border border-red-200/70 bg-gradient-to-r from-red-500 via-red-400 to-rose-500 px-6 py-2 text-lg font-black text-white shadow-[0_0_30px_6px_rgba(239,68,68,0.45)] shadow-red-900/40 transition-all hover:scale-[1.02] hover:brightness-110 hover:shadow-[0_0_42px_8px_rgba(239,68,68,0.55)] sm:h-12 sm:text-xl"
                      >
                        <span className="relative z-10 flex items-center justify-center gap-2">
                          🎰 Play now
                          <i className="fas fa-arrow-right text-base"></i>
                        </span>
                      </button>

                      {totalUnread > 0 ? (
                        <button
                          type="button"
                          onClick={handleOpenFirstUnreadAgent}
                          className="fire-button fire-orange flex h-11 w-full min-w-0 items-center justify-center gap-2 rounded-2xl border border-rose-400/40 bg-rose-500/20 px-4 py-2 text-sm font-black text-rose-100 shadow-lg transition-all hover:bg-rose-500/30 sm:text-base"
                        >
                          💬 Unread messages ({totalUnread})
                        </button>
                      ) : null}
                    </div>
                  </div>
                </motion.div>

                <div className="fire-panel fire-orange rounded-2xl border border-rose-500/35 bg-gradient-to-br from-rose-950/50 to-black/50 p-4 shadow-lg backdrop-blur-md sm:p-5">
                  <p className="flex items-center gap-2 text-xl font-black uppercase tracking-wide text-rose-200/95">
                    <span className="text-lg">⚠️</span> Redeem accuracy
                  </p>
                  <p className="mt-2 text-base leading-relaxed text-rose-100/90 sm:text-[1.05rem]">
                    If a redeem looks too big or wrong, you risk penalties or account block. Only
                    submit truthful amounts.
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  {[
                    { icon: '🎮', label: 'Games', value: gameLogins.length, tone: 'amber' },
                    { icon: '🎧', label: 'Agents', value: agents.length, tone: 'purple' },
                    {
                      icon: '✉️',
                      label: 'Unread',
                      value: totalUnread,
                      tone: totalUnread > 0 ? 'alert' : 'muted',
                    },
                  ].map((card, index) => (
                    <motion.div
                      key={card.label}
                      initial={{ opacity: 0, y: 12 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: index * 0.05 }}
                      className={`fire-panel fire-orange rounded-2xl border p-4 text-center shadow-lg backdrop-blur-md transition-all active:scale-[0.98] sm:p-5 ${
                        card.tone === 'alert'
                          ? 'border-rose-400/40 bg-rose-500/15'
                          : 'border-white/10 bg-black/40 hover:border-amber-400/30'
                      }`}
                    >
                      <span className="text-2xl sm:text-3xl" aria-hidden>
                        {card.icon}
                      </span>
                      <p className="mt-1 text-[10px] font-bold uppercase tracking-wider text-amber-100/50">
                        {card.label}
                      </p>
                      <p className="mt-1 text-2xl font-black tabular-nums text-white sm:text-3xl">
                        {card.value}
                      </p>
                    </motion.div>
                  ))}
                </div>

                {false ? (
                <div
                  className="group/bonus relative overflow-hidden rounded-3xl border border-violet-400/35 bg-gradient-to-br from-violet-950/60 via-black/50 to-fuchsia-950/25 p-4 shadow-[0_0_40px_-12px_rgba(139,92,246,0.35)] backdrop-blur-xl sm:p-6"
                  onPointerEnter={() => setBonusStripPaused(true)}
                  onPointerLeave={() => setBonusStripPaused(false)}
                >
                  <div
                    className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full bg-fuchsia-500/20 blur-3xl"
                    aria-hidden
                  />
                  <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="flex items-center gap-2 text-lg font-black text-violet-100 sm:text-xl">
                          <span className="text-2xl" aria-hidden>
                            🎁
                          </span>
                          Bonus drops
                        </h3>
                        {playerBonusEvents.length > 0 ? (
                          <span className="rounded-full border border-violet-400/35 bg-violet-500/20 px-2.5 py-0.5 text-[10px] font-black uppercase tracking-widest text-fuchsia-100">
                            Queue · {playerBonusEvents.length} active
                          </span>
                        ) : null}
                        {bonusStripPaused && playerBonusEvents.length > 1 ? (
                          <span className="text-[10px] font-bold uppercase tracking-wider text-amber-200/80">
                            Paused
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-1 max-w-xl text-[11px] font-medium text-violet-200/60 sm:text-xs">
                        New rewards from your staff &amp; coadmin queue here (up to{' '}
                        {MAX_PLAYER_BONUS_EVENTS_DISPLAY}, newest first). The carousel rotates
                        &mdash; hover to pause. First tap wins; then it vanishes for everyone, with
                        a soft fade.
                      </p>
                    </div>
                    {playerBonusEvents.length > 1 ? (
                      <div className="flex gap-2">
                        <button
                          type="button"
                          aria-label="Previous bonus"
                          onClick={() =>
                            setBonusCarouselIndex((i: number) =>
                              i <= 0 ? playerBonusEvents.length - 1 : i - 1
                            )
                          }
                          className="rounded-xl border border-violet-400/40 bg-violet-500/20 px-3 py-2 text-sm font-bold text-violet-50 shadow-inner transition hover:bg-violet-500/30"
                        >
                          ‹
                        </button>
                        <button
                          type="button"
                          aria-label="Next bonus"
                          onClick={() =>
                            setBonusCarouselIndex((i: number) =>
                              i >= playerBonusEvents.length - 1 ? 0 : i + 1
                            )
                          }
                          className="rounded-xl border border-violet-400/40 bg-violet-500/20 px-3 py-2 text-sm font-bold text-violet-50 shadow-inner transition hover:bg-violet-500/30"
                        >
                          ›
                        </button>
                      </div>
                    ) : null}
                  </div>

                  <AnimatePresence>
                    {bonusVanishedToast ? (
                      <motion.div
                        key="vanish"
                        initial={{ opacity: 0, y: -6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -8 }}
                        transition={{ duration: 0.35 }}
                        className="mb-3 flex items-center gap-2 rounded-2xl border border-amber-400/30 bg-gradient-to-r from-amber-500/20 to-rose-500/15 px-3 py-2.5 text-xs font-semibold text-amber-100 shadow-lg shadow-amber-900/20"
                      >
                        <span className="text-lg" aria-hidden>
                          ✨
                        </span>
                        <span>
                          A bonus you were eyeing was just claimed — it&apos;s gone in a snap. Next
                          drop loading…
                        </span>
                      </motion.div>
                    ) : null}
                  </AnimatePresence>

                  {playerBonusEvents.length > 1 ? (
                    <div className="mb-3 flex flex-wrap items-center gap-1.5">
                      {playerBonusEvents.map((e: BonusEvent, i: number) => (
                        <button
                          key={e.id}
                          type="button"
                          onClick={() => setBonusCarouselIndex(i)}
                          className={`max-w-[140px] truncate rounded-lg border px-2 py-1 text-left text-[10px] font-bold transition ${
                            i === activeBonusCarouselIndex
                              ? 'border-fuchsia-400/60 bg-fuchsia-500/25 text-fuchsia-50 shadow-[0_0_12px_rgba(217,70,239,0.35)]'
                              : 'border-violet-500/25 bg-black/30 text-violet-200/80 hover:border-violet-400/50'
                          }`}
                          title={e.bonusName}
                        >
                          {e.bonusName}
                        </button>
                      ))}
                    </div>
                  ) : null}

                  {playerBonusEvents.length > 1 ? (
                    <div
                      className="mb-4 flex items-center justify-center gap-1.5"
                      aria-hidden
                    >
                      {playerBonusEvents.map((e: BonusEvent, i: number) => (
                        <button
                          key={`dot-${e.id}`}
                          type="button"
                          onClick={() => setBonusCarouselIndex(i)}
                          aria-label={`Show bonus ${i + 1}`}
                          className={`h-2 rounded-full transition-all ${
                            i === activeBonusCarouselIndex
                              ? 'w-6 bg-gradient-to-r from-fuchsia-400 to-violet-400'
                              : 'w-2 bg-violet-600/50 hover:bg-violet-400/70'
                          }`}
                        />
                      ))}
                    </div>
                  ) : null}

                  {playerBonusEvents.length === 0 ? (
                    <div className="py-6 text-center">
                      <p className="text-sm text-violet-200/50">
                        No bonus events right now. When staff or coadmin post one, it &apos;ll
                        appear here with a glow.
                      </p>
                    </div>
                  ) : (
                    <div className="relative min-h-[12rem]">
                      <AnimatePresence initial={false} mode="wait">
                        <motion.div
                          key={playerBonusEvents[activeBonusCarouselIndex]?.id || 'bonus'}
                          initial={{ opacity: 0, y: 14, filter: 'blur(10px)' }}
                          animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                          exit={{ opacity: 0, y: -12, filter: 'blur(8px)' }}
                          transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
                          className="rounded-2xl border border-fuchsia-400/20 bg-gradient-to-b from-violet-950/40 to-black/50 p-4 shadow-inner sm:p-5"
                        >
                          {(() => {
                            const event = playerBonusEvents[activeBonusCarouselIndex];
                            if (!event) {
                              return null;
                            }
                            const eventDescription = getPlayerBonusEventDescription(
                              event.description
                            );
                            return (
                              <>
                                <p className="text-xs font-bold uppercase tracking-[0.2em] text-fuchsia-200/80">
                                  Featured drop
                                </p>
                                <p className="mt-1 text-xl font-black text-white sm:text-2xl">
                                  {event.bonusName}
                                </p>
                                <p className="mt-2 text-sm text-violet-100/85">
                                  🎯 {event.gameName} ·{' '}
                                  <span className="font-semibold text-fuchsia-100">
                                    ${Math.round(event.amountNpr || 0).toLocaleString('en-US')} USD
                                  </span>
                                </p>
                                {eventDescription ? (
                                  <p className="mt-2 line-clamp-3 text-sm leading-relaxed text-violet-100/80">
                                    {eventDescription}
                                  </p>
                                ) : null}
                                <p className="mt-2 text-xs text-violet-200/60">
                                  +{event.bonusPercentage}% boost · from{' '}
                                  {event.createdByRole === 'staff'
                                    ? 'Staff Team'
                                    : 'Coadmin Team'}
                                </p>
                                <button
                                  type="button"
                                  onClick={() => void handleActivateBonusEvent(event)}
                                  disabled={
                                    activatingBonusEventId === event.id ||
                                    maintenanceBreak.enabled ||
                                    !arbCanClaimBonusEvent
                                  }
                                  className="mt-4 flex min-h-[50px] w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-fuchsia-500 via-violet-500 to-fuchsia-600 py-3 text-sm font-black text-white shadow-lg shadow-fuchsia-500/25 transition hover:brightness-110 active:scale-[0.99] disabled:opacity-60"
                                >
                                  {activatingBonusEventId === event.id ? (
                                    <>
                                      <i className="fas fa-circle-notch fa-spin" aria-hidden />
                                      Locking in…
                                    </>
                                  ) : !arbCanClaimBonusEvent ? (
                                    <>
                                      {arbMode === 'cooldown'
                                        ? 'Locked (Bonus cooldown)'
                                        : arbMode === 'enabled'
                                          ? 'Locked (Auto Bonus on)'
                                          : 'Locked'}
                                    </>
                                  ) : (
                                    <>🎰 Claim this drop</>
                                  )}
                                </button>
                              </>
                            );
                          })()}
                        </motion.div>
                      </AnimatePresence>
                    </div>
                  )}
                </div>
                ) : null}

              </div>
  );
}

export default memo(Lobby);
