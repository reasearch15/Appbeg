'use client';

import { memo, useEffect, useState } from 'react';
import { playerDebugLog } from '@/lib/client/playerDebugLogs';
import { AnimatePresence, motion } from 'motion/react';
import { getPlayerBonusEventDescription } from '../utils';
import { usePlayerRenderPerf } from '../performance';
import {
  type ArbPlayerMode,
} from '@/features/automaticRechargeBonus/playerArbPreference';

type Props = Record<string, any>;

function formatBonusEventCooldownClock(
  endsAt: string | null | undefined,
  nowMs: number
): string | null {
  if (!endsAt) return null;
  const endMs = Date.parse(endsAt);
  if (!Number.isFinite(endMs) || endMs <= nowMs) return null;
  const totalSec = Math.max(0, Math.ceil((endMs - nowMs) / 1000));
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  return [
    String(hours).padStart(2, '0'),
    String(minutes).padStart(2, '0'),
    String(seconds).padStart(2, '0'),
  ].join(':');
}

function Bonus(props: Props) {
  const {
    activatingBonusEventId,
    activeBonusCarouselIndex,
    bonusEventsSessionLoading,
    bonusSwipeStartXRef,
    bonusVanishedToast,
    handleActivateBonusEvent,
    maintenanceBreak,
    playerBonusEvents,
    setBonusCarouselIndex,
    setBonusStripPaused,
    showBonusPanelHint,
    arbPlayerModeEnabled = false,
    arbMode = 'disabled' as ArbPlayerMode,
    arbCooldownEndsAt = null,
    arbCanClaimBonusEvent = true,
  } = props;

  const bonusEventsLockedByAuto = arbMode === 'enabled';
  const bonusEventsInCooldown = arbMode === 'cooldown';
  const bonusEventsAvailable =
    arbCanClaimBonusEvent && !bonusEventsLockedByAuto && !bonusEventsInCooldown;
  const claimDisabled =
    !arbCanClaimBonusEvent ||
    bonusEventsLockedByAuto ||
    bonusEventsInCooldown ||
    maintenanceBreak.enabled;
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!arbPlayerModeEnabled || !bonusEventsInCooldown || !arbCooldownEndsAt) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [arbPlayerModeEnabled, bonusEventsInCooldown, arbCooldownEndsAt]);

  const cooldownLabel = formatBonusEventCooldownClock(arbCooldownEndsAt, nowMs);

  let claimLockBanner: string | null = null;
  if (maintenanceBreak.enabled) {
    claimLockBanner = null;
  } else if (bonusEventsLockedByAuto) {
    claimLockBanner = 'Bonus Events Locked — Automatic Bonus is on.';
  } else if (bonusEventsInCooldown) {
    claimLockBanner = cooldownLabel
      ? `Bonus Event Cooldown — unlocks in ${cooldownLabel}`
      : 'Bonus Event Cooldown — unlocks soon.';
  } else if (!arbCanClaimBonusEvent) {
    claimLockBanner = 'Bonus Events are currently unavailable.';
  }

  usePlayerRenderPerf('Bonus', () => ({
    bonusEventCount: playerBonusEvents.length,
    activeBonusCarouselIndex,
    bonusEventsSessionLoading,
    showBonusPanelHint,
  }));

  useEffect(() => {
    if (bonusEventsSessionLoading) {
      playerDebugLog('[PLAYER_BONUS_SESSION_LOADING]');
      return;
    }
    if (playerBonusEvents.length === 0) {
      playerDebugLog('[BONUS_RENDER_EMPTY]', { playerBonusEventsLength: playerBonusEvents.length });
      playerDebugLog('[PLAYER_BONUS_EMPTY_ACTIVE_EVENTS]');
      return;
    }
    playerDebugLog('[BONUS_RENDER_WITH_EVENTS]', {
      playerBonusEventsLength: playerBonusEvents.length,
      firstEventId: playerBonusEvents[0]?.id || null,
    });
  }, [bonusEventsSessionLoading, playerBonusEvents]);

  return (

              <div className="relative space-y-5 sm:space-y-6">
                <div className="pointer-events-none absolute inset-x-0 top-0 z-30 flex flex-col gap-2 px-2 pt-2 sm:px-4 sm:pt-3">
                <AnimatePresence>
                  {showBonusPanelHint ? (
                    <motion.div
                      key="bonus-panel-open-hint"
                      initial={{ opacity: 0, y: -8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -10 }}
                      transition={{ duration: 0.3 }}
                      className="rounded-2xl border border-violet-400/35 bg-violet-500/25 px-3 py-2 text-xs font-semibold text-violet-100 shadow-lg shadow-violet-900/20 backdrop-blur-xl"
                    >
                      Scroll to learn about bonus events.
                    </motion.div>
                  ) : null}
                </AnimatePresence>
                <AnimatePresence>
                  {bonusVanishedToast ? (
                    <motion.div
                      key="bonus-events-vanish"
                      initial={{ opacity: 0, y: -8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -10 }}
                      transition={{ duration: 0.35 }}
                      className="flex items-center gap-2 rounded-2xl border border-amber-400/30 bg-gradient-to-r from-amber-500/25 to-rose-500/20 px-3 py-2.5 text-xs font-semibold text-amber-100 shadow-lg shadow-amber-900/20 backdrop-blur-xl"
                    >
                      <span className="text-lg" aria-hidden>
                        ✨
                      </span>
                      <span>
                        A bonus was just claimed and vanished. Keep watching for the next drop.
                      </span>
                    </motion.div>
                  ) : null}
                </AnimatePresence>
                </div>
                {arbPlayerModeEnabled ? (
                  <div className="rounded-3xl border border-violet-400/25 bg-gradient-to-br from-violet-950/50 via-[#14091f]/80 to-black/80 p-4 sm:p-5">
                    <p className="text-xs font-black uppercase tracking-[0.28em] text-violet-200/80">
                      Bonus Events
                    </p>
                    {bonusEventsLockedByAuto ? (
                      <div className="mt-3 space-y-2 text-sm leading-relaxed text-violet-50/85 sm:text-base">
                        <p className="font-semibold text-white">Bonus Events Locked</p>
                        <p>
                          Automatic Bonus is on. Bonus Event claims are locked.
                          Cooldown is ignored while Automatic Bonus stays on.
                        </p>
                      </div>
                    ) : bonusEventsInCooldown ? (
                      <div className="mt-3 space-y-2 text-sm leading-relaxed text-violet-50/85 sm:text-base">
                        <p className="font-semibold text-white">Bonus Event Cooldown</p>
                        <p>
                          Automatic Bonus is off. Bonus Events unlock when this
                          cooldown ends (a new full cooldown starts every time
                          you turn Automatic Bonus off):
                          {cooldownLabel ? (
                            <span className="mt-1 block font-mono text-lg font-black text-amber-100">
                              {cooldownLabel}
                            </span>
                          ) : (
                            <span className="mt-1 block text-amber-100/90">soon</span>
                          )}
                        </p>
                      </div>
                    ) : bonusEventsAvailable ? (
                      <div className="mt-3 space-y-2 text-sm leading-relaxed text-violet-50/85 sm:text-base">
                        <p className="font-semibold text-white">Bonus Events Available</p>
                        <p>Claim a drop below when one appears.</p>
                      </div>
                    ) : (
                      <div className="mt-3 space-y-2 text-sm leading-relaxed text-violet-50/85 sm:text-base">
                        <p className="font-semibold text-white">Bonus Events</p>
                        <p>Claims are temporarily unavailable.</p>
                      </div>
                    )}
                  </div>
                ) : null}
                <div
                  className="player-bonus-drops-panel fire-panel fire-purple group/bonus relative flex min-h-[min(19rem,44svh)] flex-col items-center justify-center rounded-3xl border border-violet-400/35 bg-gradient-to-br from-violet-950/70 via-black/55 to-fuchsia-950/30 px-4 py-8 shadow-[0_0_40px_-12px_rgba(139,92,246,0.35)] backdrop-blur-xl sm:min-h-[min(21rem,40svh)] sm:px-8 sm:py-10"
                  onPointerEnter={() => setBonusStripPaused(true)}
                  onPointerLeave={() => setBonusStripPaused(false)}
                >
                  {claimLockBanner ? (
                    <div className="absolute inset-x-4 top-4 z-20 rounded-2xl border border-amber-400/35 bg-amber-500/20 px-3 py-2 text-center text-xs font-semibold text-amber-50 sm:inset-x-8">
                      {claimLockBanner}
                    </div>
                  ) : null}
                  <div
                    className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full bg-fuchsia-500/20 blur-3xl"
                    aria-hidden
                  />
                  {playerBonusEvents.length === 0 ? (
                    <div className="mx-auto flex w-full max-w-md flex-col items-center justify-center rounded-3xl border border-dashed border-violet-400/25 bg-black/25 px-5 py-12 text-center">
                      <p className="text-4xl" aria-hidden>
                        🎁
                      </p>
                      <p className="mt-4 text-base font-bold text-violet-100">
                        {bonusEventsSessionLoading
                          ? 'Loading secure session...'
                          : 'No bonus events right now. Check back soon.'}
                      </p>
                    </div>
                  ) : (
                    <div className="relative z-10 flex w-full min-w-0 max-w-2xl flex-col items-center justify-center lg:max-w-4xl">
                      <AnimatePresence initial={false} mode="wait">
                        <motion.div
                          key={playerBonusEvents[activeBonusCarouselIndex]?.id || 'bonus-events-card'}
                          initial={{ opacity: 0, y: 14, filter: 'blur(10px)' }}
                          animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                          exit={{ opacity: 0, y: -12, filter: 'blur(8px)' }}
                          transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
                          className="mx-auto w-full rounded-3xl border border-fuchsia-400/25 bg-gradient-to-br from-white/[0.08] via-violet-950/45 to-black/70 p-5 text-center shadow-[0_0_36px_-12px_rgba(244,114,182,0.45)] sm:p-6"
                          onTouchStart={(event) => {
                            bonusSwipeStartXRef.current = event.touches[0]?.clientX ?? null;
                          }}
                          onTouchEnd={(event) => {
                            const startX = bonusSwipeStartXRef.current;
                            const endX = event.changedTouches[0]?.clientX ?? null;
                            bonusSwipeStartXRef.current = null;
                            if (
                              startX == null ||
                              endX == null ||
                              playerBonusEvents.length <= 1
                            ) {
                              return;
                            }
                            const deltaX = endX - startX;
                            if (Math.abs(deltaX) < 40) {
                              return;
                            }
                            event.stopPropagation();
                            if (deltaX < 0) {
                              setBonusCarouselIndex((i: number) =>
                                i >= playerBonusEvents.length - 1 ? 0 : i + 1
                              );
                            } else {
                              setBonusCarouselIndex((i: number) =>
                                i <= 0 ? playerBonusEvents.length - 1 : i - 1
                              );
                            }
                          }}
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
                                <p className="text-xs font-bold uppercase tracking-[0.24em] text-fuchsia-200/85">
                                  Limited drop
                                </p>
                                <h3 className="mt-2 text-2xl font-black text-white sm:text-3xl">
                                  {event.bonusName}
                                </h3>
                                {eventDescription ? (
                                  <p className="mt-2 text-sm text-violet-100/80 sm:text-base">
                                    {eventDescription}
                                  </p>
                                ) : null}

                                <div className="mx-auto mt-5 grid w-full max-w-xl grid-cols-2 gap-3 text-sm sm:grid-cols-3 sm:max-w-2xl">
                                  <div className="rounded-2xl border border-white/10 bg-black/30 p-3 text-center">
                                    <p className="text-[10px] font-black uppercase tracking-wider text-violet-200/55">
                                      Game Name
                                    </p>
                                    <p className="mt-1 font-bold text-white">{event.gameName}</p>
                                  </div>
                                  <div className="rounded-2xl border border-white/10 bg-black/30 p-3 text-center">
                                    <p className="text-[10px] font-black uppercase tracking-wider text-violet-200/55">
                                      Bonus Name
                                    </p>
                                    <p className="mt-1 font-bold text-white">{event.bonusName}</p>
                                  </div>
                                  <div className="rounded-2xl border border-white/10 bg-black/30 p-3 text-center">
                                    <p className="text-[10px] font-black uppercase tracking-wider text-violet-200/55">
                                      You Pay
                                    </p>
                                    <p className="mt-1 font-bold text-white">
                                      ${Math.round(event.amountNpr || 0).toLocaleString('en-US')}
                                    </p>
                                  </div>
                                  <div className="rounded-2xl border border-white/10 bg-black/30 p-3 text-center">
                                    <p className="text-[10px] font-black uppercase tracking-wider text-violet-200/55">
                                      You Get
                                    </p>
                                    <p className="mt-1 font-bold text-white">
                                      $
                                      {(
                                        Number(event.amountNpr || 0) +
                                        Math.max(
                                          1,
                                          Math.round(
                                            (Number(event.amountNpr || 0) *
                                              Number(event.bonusPercentage || 0)) /
                                              100
                                          )
                                        )
                                      ).toLocaleString('en-US')}
                                    </p>
                                  </div>
                                  <div className="rounded-2xl border border-fuchsia-400/25 bg-fuchsia-500/10 p-3 text-center">
                                    <p className="text-[10px] font-black uppercase tracking-wider text-fuchsia-200/70">
                                      Status
                                    </p>
                                    <p className="mt-1 font-bold text-fuchsia-50">
                                      {claimDisabled ? 'Locked' : 'Available now'}
                                    </p>
                                  </div>
                                </div>

                                <button
                                  type="button"
                                  onClick={() => void handleActivateBonusEvent(event)}
                                  disabled={
                                    activatingBonusEventId === event.id || claimDisabled
                                  }
                                  className="fire-button fire-purple mt-5 flex min-h-[52px] w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-fuchsia-500 via-violet-500 to-amber-400 py-3 text-sm font-black text-white shadow-lg shadow-fuchsia-500/25 transition hover:brightness-110 active:scale-[0.99] disabled:opacity-60"
                                >
                                  {activatingBonusEventId === event.id ? (
                                    <>
                                      <i className="fas fa-circle-notch fa-spin" aria-hidden />
                                      Opening drop...
                                    </>
                                  ) : claimDisabled ? (
                                    <>Locked</>
                                  ) : (
                                    <>Claim / Open Bonus</>
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

                <div className="fire-panel fire-purple rounded-3xl border border-violet-400/25 bg-gradient-to-br from-[#21102f]/90 via-[#14091f]/92 to-black/85 p-5 shadow-[0_0_34px_-16px_rgba(168,85,247,0.55)] sm:p-6">
                  <p className="text-xs font-black uppercase tracking-[0.28em] text-fuchsia-200/80">
                    Bonus Event Guide
                  </p>
                  <h3 className="mt-2 text-2xl font-black text-white sm:text-[1.8rem]">
                    How bonus events work
                  </h3>
                  <div className="mt-4 max-w-[48rem] space-y-3 text-sm leading-relaxed text-violet-100/82 sm:text-base">
                    <p>
                      Bonus events are limited drops. When a bonus appears, you can open it and
                      try to claim it before another player does.
                    </p>
                    <p>
                      Each event shows the game, bonus amount, and what you get from the bonus, so you can
                      quickly see what you are getting before you claim.
                    </p>
                    <p>
                      When you claim a bonus event, that drop is locked in and removed from the
                      live list. If someone else claims it first, it disappears and you need to
                      wait for the next bonus event.
                    </p>
                    <p>
                      Automatic Bonus on the Play page is a separate preference.
                      While it is on — or during the Bonus Event cooldown after
                      you turn it off — Bonus Event claims stay locked.
                    </p>
                  </div>
                </div>
              </div>
  );
}

export default memo(Bonus);
