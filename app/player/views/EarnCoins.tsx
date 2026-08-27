'use client';

import { AnimatePresence, motion } from 'motion/react';
import { memo } from 'react';

import type { ReferralRewardGroup } from '@/features/referrals/playerReferralRewards';
import { getPublicDisplayName } from '@/lib/player/publicDisplayName';
import { usePlayerRenderPerf } from '../performance';

type Props = {
  claimingFreeplayGift: boolean;
  claimingReferredPlayerUid: string | null;
  freeplayClaimSuccessMessage: string;
  handleClaimFreeplayGift: () => void | Promise<void>;
  handleClaimReferralReward: (referredPlayerUid: string) => void | Promise<void>;
  hasPendingFreeplayGift: boolean;
  lowPerformanceMode?: boolean;
  referralRewardGroups: ReferralRewardGroup[];
  referralRewardsLoading: boolean;
  referredByPlayerName: string;
};

function EarnCoins(props: Props) {
  const {
    claimingFreeplayGift,
    claimingReferredPlayerUid,
    freeplayClaimSuccessMessage,
    handleClaimFreeplayGift,
    handleClaimReferralReward,
    hasPendingFreeplayGift,
    referralRewardGroups,
    referralRewardsLoading,
    referredByPlayerName,
  } = props;

  usePlayerRenderPerf('EarnCoins', () => ({
    hasPendingFreeplayGift,
    referralRewardGroupCount: referralRewardGroups.length,
    referralRewardsLoading,
    claimingFreeplayGift,
  }));

  return (

              <div className="space-y-5 sm:space-y-6 lg:space-y-4">
                <div className="fire-panel fire-orange rounded-3xl border border-amber-400/35 bg-gradient-to-br from-amber-500/20 via-orange-900/20 to-black/60 p-5 shadow-[0_0_42px_-16px_rgba(251,191,36,0.65)] sm:p-6 lg:p-4">
                  <p className="text-xs font-black uppercase tracking-[0.3em] text-amber-200/90">
                    Permanent bonus event
                  </p>
                  <h3 className="mt-2 text-2xl font-black text-white sm:text-3xl">
                    Earn from your referrals!
                  </h3>
                  <p className="mt-3 text-sm text-amber-100/85 sm:text-base lg:hidden">
                    🎁 $15 free play when your friend signs up
                    <br />
                    💰 $5 bonus after their first deposit
                    <br />
                    📈 Earn percentage-based income every time your referred players recharge and play
                    <br />
                    <br />
                    All earnings are added to your Earn section in real-time.
                    <br />
                    <br />
                    Bonus terms apply
                  </p>
                  <p className="mt-3 hidden max-w-2xl text-sm text-amber-100/70 lg:block">
                    All earnings are added to your Earn section in real-time. Bonus terms apply.
                  </p>

                  <div className="mt-5 hidden grid-cols-3 gap-4 lg:grid">
                    <div className="player-surface rounded-2xl p-4">
                      <p className="text-2xl font-black tabular-nums text-white">$15</p>
                      <p className="mt-1 text-xs font-bold text-amber-100/60">Free play</p>
                      <p className="mt-0.5 text-[0.7rem] text-amber-100/40">When your friend signs up</p>
                    </div>
                    <div className="player-surface rounded-2xl p-4">
                      <p className="text-2xl font-black tabular-nums text-white">$5</p>
                      <p className="mt-1 text-xs font-bold text-amber-100/60">Bonus</p>
                      <p className="mt-0.5 text-[0.7rem] text-amber-100/40">After their first deposit</p>
                    </div>
                    <div className="player-surface rounded-2xl p-4">
                      <p className="text-2xl font-black tabular-nums text-white">%</p>
                      <p className="mt-1 text-xs font-bold text-amber-100/60">Ongoing income</p>
                      <p className="mt-0.5 text-[0.7rem] text-amber-100/40">
                        Every time they recharge and play
                      </p>
                    </div>
                  </div>
                </div>

                <AnimatePresence initial={false} mode="wait">
                  {hasPendingFreeplayGift ? (
                    <motion.button
                      key="freeplay-gift"
                      type="button"
                      onClick={() => void handleClaimFreeplayGift()}
                      disabled={claimingFreeplayGift}
                      initial={{ opacity: 0, scale: 0.96 }}
                      animate={
                        claimingFreeplayGift
                          ? { opacity: 1, scale: 1.1, filter: 'blur(0px)' }
                          : { opacity: 1, scale: 1, filter: 'blur(0px)' }
                      }
                      exit={{ opacity: 0, scale: 1.16, filter: 'blur(7px)' }}
                      transition={{
                        duration: claimingFreeplayGift ? 0.45 : 0.35,
                        delay: claimingFreeplayGift ? 0.25 : 0,
                        ease: [0.22, 1, 0.36, 1],
                      }}
                      style={{ willChange: 'transform, opacity, filter' }}
                      className="fire-panel fire-orange group relative w-full overflow-hidden rounded-3xl border border-yellow-200/80 bg-gradient-to-br from-fuchsia-700/60 via-amber-400/45 to-orange-700/50 p-5 text-left shadow-[0_0_58px_-12px_rgba(250,204,21,0.95)] disabled:cursor-wait sm:p-6"
                      aria-label="Open your FreePlay gift"
                    >
                      <motion.span
                        className="pointer-events-none absolute -right-9 -top-10 h-36 w-36 rounded-full bg-yellow-200/30 blur-3xl"
                        animate={{
                          opacity: claimingFreeplayGift ? [0.42, 0.9, 0.42] : [0.25, 0.5, 0.25],
                          scale: claimingFreeplayGift ? [1, 1.35, 1] : [1, 1.12, 1],
                        }}
                        transition={{ duration: claimingFreeplayGift ? 0.7 : 2.2, repeat: Infinity }}
                      />
                      <div className="relative flex items-center gap-4 sm:gap-5">
                        <motion.span
                          animate={
                            claimingFreeplayGift
                              ? { scale: [1, 1.18, 1.12], y: [0, -3, 0] }
                              : { scale: [1, 1.06, 1], y: [0, -4, 0] }
                          }
                          transition={{
                            duration: claimingFreeplayGift ? 0.45 : 1.7,
                            delay: claimingFreeplayGift ? 0.25 : 0,
                            ease: 'easeInOut',
                            repeat: claimingFreeplayGift ? 0 : Infinity,
                          }}
                          style={{ willChange: 'transform' }}
                          className="relative flex h-20 w-20 shrink-0 items-center justify-center rounded-3xl border border-yellow-100/70 bg-gradient-to-br from-yellow-100/30 via-amber-300/20 to-fuchsia-500/20 text-5xl text-yellow-100 shadow-[0_0_32px_rgba(253,224,71,0.7),inset_0_1px_18px_rgba(255,255,255,0.3)] sm:h-24 sm:w-24 sm:text-6xl"
                        >
                          <span className="absolute inset-2 rounded-2xl bg-yellow-300/20 blur-xl" />
                          <motion.span
                            animate={
                              claimingFreeplayGift
                                ? {
                                    x: [0, -2, 2, -2, 2, 0],
                                    rotate: [0, -2, 2, -2, 2, 0],
                                  }
                                : { x: 0, rotate: 0 }
                            }
                            transition={{
                              duration: claimingFreeplayGift ? 0.25 : 0,
                              ease: 'easeInOut',
                            }}
                            style={{ willChange: 'transform' }}
                            className="relative flex h-16 w-16 items-center justify-center sm:h-20 sm:w-20"
                          >
                            <img
                              src="/assets/player/freeplay-gift-box.webp"
                              alt="FreePlay gift box"
                              loading="lazy"
                              className="h-full w-full object-contain drop-shadow-[0_0_18px_rgba(253,224,71,0.95)]"
                            />
                          </motion.span>
                          <motion.i
                            className="fas fa-star absolute -right-2 -top-2 text-base text-yellow-100"
                            aria-hidden="true"
                            animate={{ opacity: [0.2, 1, 0.2], scale: [0.75, 1.2, 0.75] }}
                            transition={{ duration: 1.25, repeat: Infinity }}
                          />
                          <motion.i
                            className="fas fa-star absolute -bottom-1 -left-2 text-xs text-amber-100"
                            aria-hidden="true"
                            animate={{ opacity: [1, 0.2, 1], scale: [1.1, 0.7, 1.1] }}
                            transition={{ duration: 1.4, repeat: Infinity }}
                          />
                        </motion.span>
                        <div>
                          <p className="text-xs font-black uppercase tracking-[0.3em] text-yellow-100">
                            Mystery Drop
                          </p>
                          <h3 className="mt-1 text-xl font-black text-white sm:text-2xl">
                            FreePlay Gift Box
                          </h3>
                          <p className="mt-1 text-sm font-semibold text-yellow-50/95">
                            {claimingFreeplayGift
                              ? 'Revealing your reward...'
                              : 'Tap to open your premium bonus'}
                          </p>
                        </div>
                      </div>
                    </motion.button>
                  ) : freeplayClaimSuccessMessage ? (
                    <motion.div
                      key="freeplay-success"
                      initial={{ opacity: 0, scale: 0.84 }}
                      animate={{ opacity: 1, scale: [0.84, 1.06, 1] }}
                      exit={{ opacity: 0, scale: 0.96 }}
                      transition={{ duration: 0.3, ease: [0.2, 0.9, 0.25, 1.2] }}
                      style={{ willChange: 'transform, opacity' }}
                      className="fire-panel fire-orange relative overflow-hidden rounded-3xl border border-yellow-200/75 bg-gradient-to-br from-yellow-300/35 via-amber-500/30 to-fuchsia-900/45 p-6 text-center shadow-[0_0_52px_-10px_rgba(250,204,21,0.9)] sm:p-7"
                    >
                      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_20%,rgba(254,240,138,0.35),transparent_52%)]" />
                      <motion.i
                        className="fas fa-coins relative text-4xl text-yellow-200 drop-shadow-[0_0_16px_rgba(253,224,71,1)]"
                        aria-hidden="true"
                        animate={{ scale: [1, 1.14, 1], rotate: [0, -3, 0, 3, 0] }}
                        transition={{ duration: 0.75 }}
                      />
                      <p className="relative mt-3 text-xl font-black text-yellow-50 sm:text-2xl">
                        {freeplayClaimSuccessMessage}
                      </p>
                      <p className="relative mt-1 text-xs font-bold uppercase tracking-[0.28em] text-amber-100/85">
                        Bonus Unlocked
                      </p>
                    </motion.div>
                  ) : null}
                </AnimatePresence>

                <div className="fire-panel fire-orange fire-hero rounded-3xl border border-amber-400/35 bg-gradient-to-br from-amber-500/15 via-emerald-900/20 to-black/50 p-5 shadow-lg sm:p-6 lg:p-4">
                  <p className="text-xs font-black uppercase tracking-[0.35em] text-amber-200/90 sm:text-sm">
                    🪙 Earn coins
                  </p>
                  <h2 className="mt-2 text-3xl font-black text-white sm:text-4xl">
                    Referral players
                  </h2>
                  <p className="mt-2 text-sm text-amber-100/60">
                    Players who joined using your referral code are listed below.
                  </p>
                  {referredByPlayerName ? (
                    <p className="mt-2 text-xs text-emerald-200/80">
                      You were referred by:{' '}
                      <span className="font-bold text-emerald-300">
                        {getPublicDisplayName(referredByPlayerName)}
                      </span>
                    </p>
                  ) : null}
                </div>

                {referralRewardsLoading ? (
                  <div className="flex justify-center py-12">
                    <i className="fas fa-spinner fa-spin text-3xl text-amber-500"></i>
                  </div>
                ) : referralRewardGroups.length === 0 ? (
                  <div className="rounded-2xl border border-amber-500/20 bg-black/40 p-8 text-center text-amber-100/50">
                    <i className="fas fa-user-plus text-4xl opacity-50"></i>
                    <p className="mt-3">No referral players yet.</p>
                    <p className="mt-1 text-xs text-amber-100/40">
                      Share your referral code from the Lobby card to invite players.
                    </p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-4 lg:grid-cols-[repeat(auto-fill,minmax(17rem,1fr))] lg:gap-[0.85rem]">
                    {referralRewardGroups.map((group: ReferralRewardGroup) => (
                      <div
                        key={group.referredPlayerUid}
                        className="player-referral-card fire-panel fire-orange rounded-2xl border border-amber-400/25 bg-gradient-to-br from-black/60 to-emerald-950/20 p-4 lg:flex lg:h-full lg:flex-col lg:rounded-3xl lg:p-3"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <h3 className="mt-1 text-xl font-black text-white">
                              {group.referredPlayerName
                                ? getPublicDisplayName(group.referredPlayerName)
                                : 'Unnamed Player'}
                            </h3>
                            <p className="mt-1 text-sm text-amber-100/70">
                              Claimable:{' '}
                              <span className="font-black text-emerald-300">
                                {Math.max(0, Number(group.pendingRewardCoins || 0)).toFixed(2)} points
                              </span>
                            </p>
                          </div>
                        </div>

                        <div className="mt-3 flex items-center justify-end gap-3 lg:mt-auto">
                          {group.hasClaimableReward ? (
                            <button
                              type="button"
                              onClick={() =>
                                void handleClaimReferralReward(group.referredPlayerUid)
                              }
                              disabled={claimingReferredPlayerUid === group.referredPlayerUid}
                              className="rounded-xl border border-red-400/60 bg-red-500/20 px-3 py-2 text-sm font-black text-red-100 hover:bg-red-500/30 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300/60"
                              title="Claim accumulated reward"
                            >
                              {claimingReferredPlayerUid === group.referredPlayerUid
                                ? '...'
                                : '🎁'}
                            </button>
                          ) : (
                            <span className="text-xs text-amber-100/55">No rewards available.</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
  );
}

export default memo(EarnCoins);
