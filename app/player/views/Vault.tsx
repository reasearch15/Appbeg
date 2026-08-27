'use client';

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, MouseEvent, SetStateAction } from 'react';
import { motion } from 'motion/react';
import type { PlayerGameLogin } from '@/features/games/playerGameLogins';
import { playerDevLog } from '@/lib/client/playerDebugLogs';
import { UNKNOWN_CREATOR_FILTER_KEY } from '../constants';
import { warmPlayerImages } from '../playerAssetPreload';
import { usePlayerRenderPerf } from '../performance';
import {
  getGameBackgroundImage,
  normalizeBackgroundKey,
  normalizeExternalUrl,
} from '../utils';

type CreatorFilterKeys = {
  sortedUids: string[];
  hasMissingCreator: boolean;
};

type VaultProps = {
  coadminFrontendLinkByGameKey: Record<string, string>;
  copyCredentialValue: (
    value: string,
    label: string,
    event: MouseEvent<HTMLElement>
  ) => void | Promise<void>;
  creatorNames: Record<string, string>;
  credentialTaskLoadingKey: string | null;
  gameBackgroundImageByKey: Record<string, string>;
  gameLogins: PlayerGameLogin[];
  loadingList: boolean;
  lowPerformanceMode?: boolean;
  openCredentialResetModal: (
    login: PlayerGameLogin,
    taskType: 'reset_password' | 'recreate_username',
    event?: MouseEvent<HTMLButtonElement>
  ) => void;
  selectedCreatorUid: string | null;
  setSelectedCreatorUid: Dispatch<SetStateAction<string | null>>;
  togglePassword: (loginId: string) => void;
  usernameCarersByGame: Record<string, string[]>;
  usernamesCreatorFilterKeys: CreatorFilterKeys;
  usernamesVisibleLogins: PlayerGameLogin[];
  visiblePasswords: Record<string, boolean>;
};

const MOBILE_CREDENTIAL_INITIAL_LIMIT = 10;
const MOBILE_CREDENTIAL_INCREMENT = 10;
const LOW_PERFORMANCE_CREDENTIAL_INITIAL_LIMIT = 8;
const LOW_PERFORMANCE_CREDENTIAL_INCREMENT = 8;
const EAGER_CREDENTIAL_IMAGE_COUNT = 6;
const PLAYER_RENDER_DEBUG = process.env.NEXT_PUBLIC_PLAYER_RENDER_DEBUG === '1';

type CredentialCardProps = {
  copyCredentialValue: VaultProps['copyCredentialValue'];
  credentialTaskLoadingKey: string | null;
  downloadGameUrl: string;
  gameCardBackgroundImage: string;
  isMobileCard: boolean;
  login: PlayerGameLogin;
  openCredentialResetModal: VaultProps['openCredentialResetModal'];
  togglePassword: VaultProps['togglePassword'];
  visible: boolean;
};

function getMobileLowEndMode() {
  if (typeof window === 'undefined') {
    return false;
  }
  return (
    window.matchMedia('(max-width: 767px)').matches ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

const CredentialCard = memo(function CredentialCard({
  copyCredentialValue,
  credentialTaskLoadingKey,
  downloadGameUrl,
  gameCardBackgroundImage,
  isMobileCard,
  login,
  openCredentialResetModal,
  togglePassword,
  visible,
}: CredentialCardProps) {
  const isResetLoading = credentialTaskLoadingKey === `reset_password:${login.id}`;
  const cardClassName =
    'player-game-card-image vault-credential-card fire-panel fire-orange group relative overflow-hidden rounded-[1.7rem] border border-amber-300/25 bg-gradient-to-br from-[#3a140b]/88 via-[#5d2411]/78 to-[#261018]/92 p-3 shadow-[0_18px_40px_-18px_rgba(56,11,4,0.9)] backdrop-blur-xl transition-all sm:p-3.5 sm:hover:border-amber-300/45 sm:hover:shadow-[0_0_30px_-10px_rgba(251,191,36,0.38)] lg:flex lg:h-full lg:flex-col lg:rounded-3xl';
  const cardStyle = gameCardBackgroundImage
    ? {
        backgroundImage: `linear-gradient(180deg, rgba(0, 0, 0, 0.24) 0%, rgba(0, 0, 0, 0.54) 100%), url("${gameCardBackgroundImage}")`,
        backgroundSize: '100% 100%',
        backgroundPosition: 'center',
        backgroundRepeat: 'no-repeat',
        filter: 'brightness(1.14) saturate(1.1)',
      }
    : undefined;
  const cardContent = (
    <>
      <div className="mb-1.5 flex items-start justify-between gap-3 border-b border-amber-200/10 pb-1.5 lg:mb-3 lg:pb-3">
        <div className="min-w-0">
          <p className="text-[0.68rem] font-black uppercase tracking-[0.24em] text-amber-100/50">
            Game
          </p>
          <h3 className="mt-0.5 truncate bg-gradient-to-r from-amber-50 via-yellow-100 to-orange-200 bg-clip-text text-[1.18rem] font-black leading-tight text-transparent">
            {login.gameName}
          </h3>
          {downloadGameUrl ? (
            <a
              href={downloadGameUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-1.5 inline-flex min-h-[34px] items-center rounded-xl border border-red-200/80 bg-red-600 px-3 py-1 text-xs font-black uppercase tracking-[0.12em] text-white shadow-[0_0_22px_-6px_rgba(248,113,113,0.95),0_0_38px_-14px_rgba(220,38,38,0.98)] transition hover:bg-red-700 hover:text-white hover:shadow-[0_0_28px_-4px_rgba(252,165,165,1),0_0_46px_-12px_rgba(220,38,38,1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300/70 lg:min-h-[30px] lg:px-2.5"
            >
              Download Game
            </a>
          ) : null}
        </div>
        <span className="shrink-0 rounded-full border border-emerald-300/25 bg-emerald-400/12 px-2 py-0.5 text-[0.62rem] font-black uppercase tracking-[0.1em] text-emerald-100/85">
          Active
        </span>
      </div>

      <div className="vault-credential-card__body space-y-1.5 lg:flex lg:flex-1 lg:flex-col lg:space-y-2">
        <div className="vault-credential-field rounded-2xl border border-white/10 bg-white/[0.05] px-2 py-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
          <div className="flex items-center justify-between gap-2">
            <p className="whitespace-nowrap text-[0.66rem] font-black uppercase leading-tight tracking-[0.14em] text-amber-100/58">
              Username
            </p>
            <button
              type="button"
              onClick={(clickEvent) =>
                void copyCredentialValue(String(login.gameUsername || ''), 'Username', clickEvent)
              }
              className="min-h-[28px] rounded-xl border border-amber-300/35 bg-amber-400/10 px-2.5 py-0.5 text-[0.68rem] font-black leading-tight text-amber-50 transition hover:bg-amber-400/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/60"
            >
              Copy
            </button>
          </div>
          <p className="mt-0.5 truncate rounded-xl border border-black/10 bg-black/30 px-2 py-0.5 font-mono text-[0.86rem] font-bold leading-tight tracking-[0.05em] text-white shadow-inner">
            {login.gameUsername || '-'}
          </p>
        </div>

        <div className="vault-credential-field rounded-2xl border border-white/10 bg-white/[0.05] px-2 py-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
          <div className="flex items-center justify-between gap-2">
            <p className="whitespace-nowrap text-[0.66rem] font-black uppercase leading-tight tracking-[0.14em] text-amber-100/58">
              Password
            </p>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={(clickEvent) =>
                  void copyCredentialValue(
                    visible ? String(login.gamePassword || '') : '',
                    'Password',
                    clickEvent
                  )
                }
                disabled={!visible}
                className="min-h-[28px] rounded-xl border border-violet-300/35 bg-violet-400/10 px-2.5 py-0.5 text-[0.68rem] font-black leading-tight text-violet-50 transition hover:bg-violet-400/20 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300/60"
              >
                Copy
              </button>
              <button
                type="button"
                onClick={() => togglePassword(login.id)}
                className="min-h-[28px] rounded-xl border border-amber-200/30 bg-amber-400 px-2.5 py-0.5 text-xs font-black leading-tight text-black transition hover:bg-amber-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-200/80"
                aria-label={visible ? 'Hide password' : 'Show password'}
              >
                {visible ? 'Hide' : 'Show'}
              </button>
            </div>
          </div>
          <p className="mt-0.5 truncate rounded-xl border border-black/10 bg-black/30 px-2 py-0.5 font-mono text-[0.86rem] font-bold leading-tight tracking-[0.12em] text-white shadow-inner">
            {visible ? login.gamePassword : '****************'}
          </p>
        </div>

        <div className="border-t border-amber-200/10 pt-1 lg:mt-auto">
          <button
            type="button"
            onClick={(event) => openCredentialResetModal(login, 'reset_password', event)}
            disabled={isResetLoading}
            className="min-h-[42px] w-full rounded-2xl border border-fuchsia-200/15 bg-gradient-to-r from-fuchsia-600 to-violet-600 px-3 py-1.5 text-sm font-black leading-tight text-white shadow-[0_10px_24px_-16px_rgba(217,70,239,0.95)] transition-all hover:from-fuchsia-500 hover:to-violet-500 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fuchsia-300/60 lg:shadow-none lg:hover:shadow-[0_8px_20px_-16px_rgba(217,70,239,0.7)]"
          >
            {isResetLoading ? <i className="fas fa-spinner fa-spin"></i> : <>Reset password</>}
          </button>
        </div>
      </div>
    </>
  );

  if (isMobileCard) {
    return (
      <div className={cardClassName} style={cardStyle}>
        {cardContent}
      </div>
    );
  }

  return (
    <motion.div layout className={cardClassName} style={cardStyle}>
      {cardContent}
    </motion.div>
  );
}, areCredentialCardPropsEqual);

function areCredentialCardPropsEqual(
  previous: CredentialCardProps,
  next: CredentialCardProps
) {
  const previousLogin = previous.login;
  const nextLogin = next.login;
  const previousLoading = previous.credentialTaskLoadingKey === `reset_password:${previousLogin.id}`;
  const nextLoading = next.credentialTaskLoadingKey === `reset_password:${nextLogin.id}`;

  return (
    previous.isMobileCard === next.isMobileCard &&
    previous.visible === next.visible &&
    previousLoading === nextLoading &&
    previous.downloadGameUrl === next.downloadGameUrl &&
    previous.gameCardBackgroundImage === next.gameCardBackgroundImage &&
    previousLogin.id === nextLogin.id &&
    previousLogin.gameName === nextLogin.gameName &&
    previousLogin.gameUsername === nextLogin.gameUsername &&
    previousLogin.gamePassword === nextLogin.gamePassword &&
    previousLogin.frontendUrl === nextLogin.frontendUrl &&
    previousLogin.siteUrl === nextLogin.siteUrl
  );
}

function Vault(props: VaultProps) {
  const {
    coadminFrontendLinkByGameKey,
    copyCredentialValue,
    creatorNames,
    credentialTaskLoadingKey,
    gameBackgroundImageByKey,
    gameLogins,
    loadingList,
    lowPerformanceMode = false,
    openCredentialResetModal,
    selectedCreatorUid,
    setSelectedCreatorUid,
    togglePassword,
    usernamesCreatorFilterKeys,
    usernamesVisibleLogins,
    visiblePasswords,
  } = props;

  const renderDebugCountRef = useRef(0);
  const [mobileLowEndMode, setMobileLowEndMode] = useState(getMobileLowEndMode);
  const credentialInitialLimit = lowPerformanceMode
    ? LOW_PERFORMANCE_CREDENTIAL_INITIAL_LIMIT
    : MOBILE_CREDENTIAL_INITIAL_LIMIT;
  const credentialIncrement = lowPerformanceMode
    ? LOW_PERFORMANCE_CREDENTIAL_INCREMENT
    : MOBILE_CREDENTIAL_INCREMENT;
  const shouldPageCredentials = mobileLowEndMode || lowPerformanceMode;
  const credentialResetKey = `${credentialInitialLimit}:${selectedCreatorUid ?? ''}:${shouldPageCredentials ? 'page' : 'all'}:${usernamesVisibleLogins.length}`;
  const [credentialPageState, setCredentialPageState] = useState(() => ({
    resetKey: credentialResetKey,
    count: credentialInitialLimit,
  }));
  const visibleCredentialCount =
    credentialPageState.resetKey === credentialResetKey
      ? credentialPageState.count
      : credentialInitialLimit;

  useEffect(() => {
    if (!PLAYER_RENDER_DEBUG) {
      return;
    }
    renderDebugCountRef.current += 1;
    playerDevLog('[PLAYER_RENDER_DEBUG]', {
      component: 'Vault',
      count: renderDebugCountRef.current,
      lowPerformanceMode,
      credentialCount: usernamesVisibleLogins.length,
      visibleCredentialCount,
      atMs: Date.now(),
    });
  });

  usePlayerRenderPerf('Vault', () => ({
    credentialCount: usernamesVisibleLogins.length,
    visibleCredentialCount,
    lowPerformanceMode,
  }));

  useEffect(() => {
    const mobileQuery = window.matchMedia('(max-width: 767px)');
    const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updateMode = () => {
      const nextMode = mobileQuery.matches || reducedMotionQuery.matches;
      setMobileLowEndMode((current) => (current === nextMode ? current : nextMode));
    };

    updateMode();
    mobileQuery.addEventListener('change', updateMode);
    reducedMotionQuery.addEventListener('change', updateMode);
    return () => {
      mobileQuery.removeEventListener('change', updateMode);
      reducedMotionQuery.removeEventListener('change', updateMode);
    };
  }, []);

  const visibleCredentials = useMemo(
    () =>
      shouldPageCredentials
        ? usernamesVisibleLogins.slice(0, visibleCredentialCount)
        : usernamesVisibleLogins,
    [shouldPageCredentials, usernamesVisibleLogins, visibleCredentialCount]
  );
  const hasMoreCredentials =
    shouldPageCredentials && visibleCredentialCount < usernamesVisibleLogins.length;

  useEffect(() => {
    if (loadingList || visibleCredentials.length === 0) {
      return;
    }
    const firstVisibleImages = visibleCredentials
      .slice(0, EAGER_CREDENTIAL_IMAGE_COUNT)
      .map((login: PlayerGameLogin) =>
        getGameBackgroundImage(gameBackgroundImageByKey, login.gameName)
      );
    warmPlayerImages(firstVisibleImages, {
      priority: 'high',
      reason: 'vault_first_visible',
    });
  }, [gameBackgroundImageByKey, loadingList, visibleCredentials]);

  return (
    <div className="player-vault-page space-y-5 sm:space-y-6">
      <div className="player-vault-header fire-panel fire-orange fire-hero rounded-3xl border border-amber-400/35 bg-gradient-to-br from-amber-500/15 via-fuchsia-900/20 to-black/50 p-5 shadow-lg sm:p-6">
        <p className="text-xs font-black uppercase tracking-[0.35em] text-amber-200/90 sm:text-sm">
          VIP vault
        </p>
        <h2 className="mt-2 text-3xl font-black text-white sm:text-4xl">Credentials</h2>
        <p className="mt-2 text-sm text-amber-100/60">Your Usernames and Password</p>
      </div>

      {loadingList ? (
        <div className="flex justify-center py-12">
          <i className="fas fa-spinner fa-spin text-3xl text-amber-500"></i>
        </div>
      ) : gameLogins.length === 0 ? (
        <div className="rounded-xl border border-amber-500/20 bg-black/40 p-8 text-center text-amber-100/50">
          <i className="fas fa-key text-4xl mb-3 opacity-50"></i>
          <p>No usernames assigned yet.</p>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {usernamesCreatorFilterKeys.sortedUids.map((uid: string) => (
              <button
                key={uid}
                type="button"
                onClick={() =>
                  setSelectedCreatorUid((prev: string | null) => (prev === uid ? null : uid))
                }
                className={`rounded-xl border px-4 py-2 text-left text-sm font-bold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/60 ${
                  selectedCreatorUid === uid
                    ? 'border-amber-400 bg-amber-500/25 text-amber-100 shadow-lg shadow-amber-500/10'
                    : 'border-amber-500/25 bg-black/40 text-amber-100/80 hover:border-amber-500/50 hover:bg-amber-500/10'
                }`}
              >
                {creatorNames[uid] || 'Unknown Creator'}
              </button>
            ))}
            {usernamesCreatorFilterKeys.hasMissingCreator && (
              <button
                key={UNKNOWN_CREATOR_FILTER_KEY}
                type="button"
                onClick={() =>
                  setSelectedCreatorUid((prev: string | null) =>
                    prev === UNKNOWN_CREATOR_FILTER_KEY ? null : UNKNOWN_CREATOR_FILTER_KEY
                  )
                }
                className={`rounded-xl border px-4 py-2 text-left text-sm font-bold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/60 ${
                  selectedCreatorUid === UNKNOWN_CREATOR_FILTER_KEY
                    ? 'border-amber-400 bg-amber-500/25 text-amber-100 shadow-lg shadow-amber-500/10'
                    : 'border-amber-500/25 bg-black/40 text-amber-100/80 hover:border-amber-500/50 hover:bg-amber-500/10'
                }`}
              >
                Unknown Creator
              </button>
            )}
          </div>

          {usernamesVisibleLogins.length === 0 ? (
            <div className="rounded-xl border border-amber-500/20 bg-black/40 p-8 text-center text-amber-100/50">
              <p>No credentials match this filter.</p>
            </div>
          ) : (
            <>
              <div className="player-vault-grid grid grid-cols-1 gap-3 sm:grid-cols-2 lg:gap-5">
                {visibleCredentials.map((login: PlayerGameLogin) => {
                  const fallbackFrontendUrl =
                    coadminFrontendLinkByGameKey[
                      normalizeBackgroundKey(String(login.gameName || ''))
                    ] || '';
                  const downloadGameUrl = normalizeExternalUrl(
                    login.frontendUrl || fallbackFrontendUrl || login.siteUrl
                  );
                  const gameCardBackgroundImage = getGameBackgroundImage(
                    gameBackgroundImageByKey,
                    login.gameName
                  );

                  return (
                    <CredentialCard
                      key={login.id}
                      copyCredentialValue={copyCredentialValue}
                      credentialTaskLoadingKey={credentialTaskLoadingKey}
                      downloadGameUrl={downloadGameUrl}
                      gameCardBackgroundImage={gameCardBackgroundImage}
                      isMobileCard={shouldPageCredentials}
                      login={login}
                      openCredentialResetModal={openCredentialResetModal}
                      togglePassword={togglePassword}
                      visible={Boolean(visiblePasswords[login.id])}
                    />
                  );
                })}
              </div>
              {hasMoreCredentials ? (
                <button
                  type="button"
                  onClick={() =>
                    setCredentialPageState((current) => {
                      const currentCount =
                        current.resetKey === credentialResetKey
                          ? current.count
                          : credentialInitialLimit;
                      return {
                        resetKey: credentialResetKey,
                        count: Math.min(
                          usernamesVisibleLogins.length,
                          currentCount + credentialIncrement
                        ),
                      };
                    })
                  }
                  className="mt-3 min-h-[44px] w-full rounded-2xl border border-amber-400/35 bg-black/45 px-4 py-3 text-sm font-black text-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/60"
                >
                  Show more credentials ({usernamesVisibleLogins.length - visibleCredentialCount} more)
                </button>
              ) : null}
            </>
          )}
        </>
      )}
    </div>
  );
}

export default memo(Vault);
