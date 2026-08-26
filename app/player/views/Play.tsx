'use client';

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import type { PlayerGameLogin } from '@/features/games/playerGameLogins';
import { playerDevLog } from '@/lib/client/playerDebugLogs';
import { warmPlayerImages } from '../playerAssetPreload';
import { usePlayerRenderPerf } from '../performance';
import { getGameBackgroundImage } from '../utils';
import AutomaticRechargeBonusPanel from './AutomaticRechargeBonusPanel';
import type { ArbPlayerMode } from '@/features/automaticRechargeBonus/playerArbPreference';

type Props = Record<string, any>;

const MOBILE_CARD_INITIAL_LIMIT = 12;
const MOBILE_CARD_INCREMENT = 12;
const LOW_PERFORMANCE_CARD_INITIAL_LIMIT = 8;
const LOW_PERFORMANCE_CARD_INCREMENT = 8;
const PLAYER_RENDER_DEBUG = process.env.NEXT_PUBLIC_PLAYER_RENDER_DEBUG === '1';

function getMobileLowEndMode() {
  if (typeof window === 'undefined') {
    return false;
  }
  return (
    window.matchMedia('(max-width: 767px)').matches ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function Play(props: Props) {
  const {
    copyCredentialValue,
    gameBackgroundImageByKey,
    gameLogins,
    loadingList,
    lowPerformanceMode = false,
    onCardsRendered,
    onShellRendered,
    openActiveTableSplash,
    selectedGameName,
    setSelectedGameName,
    arbPlayerModeEnabled = false,
    arbMode = 'disabled' as ArbPlayerMode,
    arbEnabled = false,
    arbCooldownEndsAt = null,
    arbCanEnable = false,
    arbCanDisable = false,
    arbCanClaimBonusEvent = true,
    arbFeatureEnabled = false,
    arbRiskBlocked = false,
    arbToggling = false,
    onArbToggle,
    arbPanelMessage = null,
  } = props;

  const renderDebugCountRef = useRef(0);
  const [mobileLowEndMode, setMobileLowEndMode] = useState(getMobileLowEndMode);
  const cardInitialLimit = lowPerformanceMode
    ? LOW_PERFORMANCE_CARD_INITIAL_LIMIT
    : MOBILE_CARD_INITIAL_LIMIT;
  const cardIncrement = lowPerformanceMode
    ? LOW_PERFORMANCE_CARD_INCREMENT
    : MOBILE_CARD_INCREMENT;
  const shouldPageCards = mobileLowEndMode || lowPerformanceMode;
  const [visibleCardCount, setVisibleCardCount] = useState(cardInitialLimit);

  if (PLAYER_RENDER_DEBUG) {
    renderDebugCountRef.current += 1;
    playerDevLog('[PLAYER_RENDER_DEBUG]', {
      component: 'Play',
      count: renderDebugCountRef.current,
      lowPerformanceMode,
      gameLoginCount: gameLogins.length,
      visibleCardCount,
      atMs: Date.now(),
    });
  }

  usePlayerRenderPerf('Play', () => ({
    gameLoginCount: gameLogins.length,
    visibleCardCount,
    lowPerformanceMode,
  }));

  useEffect(() => {
    const mobileQuery = window.matchMedia('(max-width: 767px)');
    const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updateMode = () => {
      setMobileLowEndMode(mobileQuery.matches || reducedMotionQuery.matches);
    };

    updateMode();
    mobileQuery.addEventListener('change', updateMode);
    reducedMotionQuery.addEventListener('change', updateMode);
    return () => {
      mobileQuery.removeEventListener('change', updateMode);
      reducedMotionQuery.removeEventListener('change', updateMode);
    };
  }, []);

  useEffect(() => {
    setVisibleCardCount(cardInitialLimit);
  }, [cardInitialLimit, gameLogins.length, shouldPageCards]);

  useEffect(() => {
    onShellRendered?.();
  }, [onShellRendered]);

  useEffect(() => {
    if (loadingList) {
      return;
    }
    onCardsRendered?.({
      count: gameLogins.length,
      state: gameLogins.length > 0 ? 'cards' : 'empty',
    });
  }, [gameLogins.length, loadingList, onCardsRendered]);

  const visibleGameLogins = useMemo(
    () =>
      shouldPageCards
        ? gameLogins.slice(0, visibleCardCount)
        : gameLogins,
    [gameLogins, shouldPageCards, visibleCardCount]
  );
  const hasMoreGameLogins =
    shouldPageCards && visibleCardCount < gameLogins.length;

  useEffect(() => {
    if (loadingList || visibleGameLogins.length === 0) {
      return;
    }
    const firstVisibleImages = visibleGameLogins
      .slice(0, 6)
      .map((game: PlayerGameLogin) =>
        getGameBackgroundImage(gameBackgroundImageByKey, game.gameName)
      );
    warmPlayerImages(firstVisibleImages, {
      priority: 'high',
      reason: 'play_first_visible',
    });
  }, [gameBackgroundImageByKey, loadingList, visibleGameLogins]);

  return (

              <div className="space-y-5 sm:space-y-6">
                <div className="fire-panel fire-orange fire-hero relative overflow-hidden rounded-3xl border border-amber-400/30 bg-gradient-to-r from-amber-500/20 via-rose-600/15 to-purple-900/30 p-4 shadow-lg sm:p-5">
                  <div className="pointer-events-none absolute right-4 top-4 text-4xl opacity-20">
                    🎲
                  </div>
                  <p className="text-xs font-black uppercase tracking-[0.35em] text-amber-200/90 sm:text-sm">
                    🎰 High-limit floor
                  </p>
                  <h2 className="mt-2 text-2xl font-black text-white sm:text-3xl">Pick your table</h2>
                  <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
                    <p className="min-w-0 flex-1 text-sm text-amber-100/60">
                      Tap a table to open the play screen, enter your amount in USD, then recharge ⬇️ or
                      redeem ⬆️.
                    </p>
                    {typeof onArbToggle === 'function' ? (
                      <div className="flex shrink-0 justify-start sm:justify-end">
                        <AutomaticRechargeBonusPanel
                          playerModeEnabled={arbPlayerModeEnabled}
                          mode={arbMode}
                          enabled={arbEnabled}
                          cooldownEndsAt={arbCooldownEndsAt}
                          canEnable={arbCanEnable}
                          canDisable={arbCanDisable}
                          canClaimBonusEvent={arbCanClaimBonusEvent}
                          featureEnabled={arbFeatureEnabled}
                          riskBlocked={arbRiskBlocked}
                          toggling={arbToggling}
                          onToggle={onArbToggle}
                          message={arbPanelMessage}
                        />
                      </div>
                    ) : null}
                  </div>
                </div>

                {loadingList ? (
                  <div className="grid grid-cols-2 gap-2 sm:items-start xl:grid-cols-3 xl:gap-3" aria-busy="true">
                    {Array.from({ length: 4 }).map((_, index) => (
                      <div
                        key={index}
                        className="fire-panel fire-orange min-h-[156px] rounded-2xl border border-white/10 bg-black/45 p-3 shadow-xl"
                      >
                        <div className="mx-auto h-5 w-24 rounded bg-amber-200/15" />
                        <div className="mt-4 rounded-xl border border-white/10 bg-black/35 px-2 py-2">
                          <div className="h-3 w-24 rounded bg-amber-100/15" />
                          <div className="mt-2 h-4 w-full rounded bg-white/10" />
                          <div className="mt-3 h-3 w-24 rounded bg-amber-100/15" />
                          <div className="mt-2 h-4 w-3/4 rounded bg-white/10" />
                        </div>
                        <div className="mt-3 h-9 rounded-xl bg-orange-400/20" />
                      </div>
                    ))}
                  </div>
                ) : gameLogins.length === 0 ? (
                  <div className="rounded-3xl border border-amber-500/25 bg-black/50 p-10 text-center text-amber-100/55">
                    <span className="text-5xl">🐉</span>
                    <p className="mt-3 font-bold">No tables assigned yet.</p>
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-2 gap-2 sm:items-start xl:grid-cols-3 xl:gap-3">
                      {visibleGameLogins.map((game: PlayerGameLogin, index: number) => {
                        const resolvedUsername = (game.gameUsername || '').trim();
                        const hasUsername = Boolean(resolvedUsername);
                        const isSelected = selectedGameName === game.gameName;
                        const gameCardBackgroundImage = getGameBackgroundImage(
                          gameBackgroundImageByKey,
                          game.gameName
                        );
                        return (
                          <motion.div
                            key={game.id}
                            initial={shouldPageCards ? false : { opacity: 0, y: 16 }}
                            animate={shouldPageCards ? undefined : { opacity: 1, y: 0 }}
                            transition={shouldPageCards ? undefined : { delay: index * 0.05 }}
                            onClick={() => {
                              setSelectedGameName(game.gameName);
                              openActiveTableSplash();
                            }}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                setSelectedGameName(game.gameName);
                                openActiveTableSplash();
                              }
                            }}
                            role="button"
                            tabIndex={0}
                            aria-pressed={isSelected}
                            className={`player-play-game-card player-game-card-image fire-panel fire-orange group relative w-full self-start overflow-hidden rounded-2xl border p-2 text-left shadow-xl transition-all active:scale-[0.98] hover:scale-[1.01] hover:shadow-[0_0_26px_-8px_rgba(251,191,36,0.5)] ${
                              isSelected
                                ? 'border-amber-400/60 bg-gradient-to-br from-amber-500/25 to-purple-900/40 shadow-[0_0_32px_-8px_rgba(234,179,8,0.55)]'
                                : 'border-white/10 bg-black/45 hover:border-amber-400/35'
                            }`}
                          >
                            {gameCardBackgroundImage ? (
                              <div
                                className="player-play-game-card__art"
                                style={{
                                  backgroundImage: `linear-gradient(180deg, rgba(0, 0, 0, 0.2) 0%, rgba(0, 0, 0, 0.42) 100%), url("${gameCardBackgroundImage}")`,
                                }}
                                aria-hidden
                              />
                            ) : null}
                            <div className="pointer-events-none absolute -right-6 -top-6 h-24 w-24 rounded-full bg-amber-400/15 blur-2xl" />
                            <div className="player-play-game-card__body">
                              <div className="relative flex items-start justify-center gap-2 rounded-xl border border-white/10 bg-gradient-to-b from-black/65 via-black/50 to-black/35 px-2 py-1 shadow-[0_2px_12px_rgba(0,0,0,0.35)]">
                                <div className="min-w-0 flex-1 text-center">
                                  <h3 className="truncate bg-gradient-to-r from-amber-100 via-yellow-200 to-orange-300 bg-clip-text text-lg font-black text-transparent drop-shadow-[0_0_12px_rgba(251,191,36,0.45)]">
                                    {game.gameName}
                                  </h3>
                                </div>
                              </div>
                              {hasUsername && (
                                <div className="relative mt-1 rounded-xl border border-white/15 bg-black/60 px-2 py-1 shadow-[0_2px_12px_rgba(0,0,0,0.35)]">
                                  <div className="flex items-center justify-between gap-1">
                                    <p className="whitespace-nowrap text-[9px] font-bold uppercase leading-tight tracking-[0.16em] text-amber-100/80">
                                      Game username
                                    </p>
                                    <button
                                      type="button"
                                      onClick={(event) => {
                                        event.preventDefault();
                                        event.stopPropagation();
                                        void copyCredentialValue(resolvedUsername, 'Username', event);
                                      }}
                                      className="shrink-0 rounded-lg border border-amber-300/35 bg-amber-400/10 px-2 py-0.5 text-[9px] font-black leading-tight text-amber-50 transition hover:bg-amber-400/20"
                                    >
                                      Copy
                                    </button>
                                  </div>
                                  <p className="truncate font-mono text-xs font-bold leading-tight text-white">
                                    {resolvedUsername}
                                  </p>
                                </div>
                              )}
                              <span
                                className={`relative mt-2 flex min-h-[38px] w-full items-center justify-center rounded-xl px-2 text-sm font-black transition-all duration-300 group-hover:tracking-wide ${
                                  isSelected
                                    ? 'bg-gradient-to-r from-amber-300 via-yellow-300 to-orange-300 text-black shadow-[0_0_22px_-2px_rgba(251,191,36,0.7)]'
                                    : 'border border-orange-200/80 bg-orange-500 text-white shadow-[0_0_18px_-6px_rgba(249,115,22,0.75)] group-hover:bg-orange-600 group-hover:shadow-[0_0_26px_-4px_rgba(249,115,22,0.95)]'
                                }`}
                              >
                                {isSelected ? '🔥 Selected' : 'Tap to open'}
                              </span>
                            </div>
                          </motion.div>
                        );
                      })}
                    </div>
                    {hasMoreGameLogins ? (
                      <button
                        type="button"
                        onClick={() =>
                          setVisibleCardCount((count) =>
                            Math.min(gameLogins.length, count + cardIncrement)
                          )
                        }
                        className="mt-3 min-h-[44px] w-full rounded-2xl border border-amber-400/35 bg-black/45 px-4 py-3 text-sm font-black text-amber-100"
                      >
                        Show more tables ({gameLogins.length - visibleCardCount} more)
                      </button>
                    ) : null}
                  </>
                )}
              </div>
  );
}

export default memo(Play);
