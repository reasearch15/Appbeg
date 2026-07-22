'use client';

import { playerDebugLog } from '@/lib/client/playerDebugLogs';
import { onAuthStateChanged } from 'firebase/auth';
import Image from 'next/image';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';

import { auth } from '@/lib/firebase/client';
import {
  attachGlobalPwaInstallPromptListener,
  clearDeferredInstallPrompt,
  getPwaInstallSnapshot,
  isStandaloneMode,
  markPwaInstalled,
  subscribeToPwaInstallPrompt,
  type BeforeInstallPromptEvent,
} from '@/lib/pwa/installPromptStore';

type PromptStatus = {
  deferredPrompt: BeforeInstallPromptEvent | null;
  isInstalled: boolean;
};

function isIosOrIpadOs() {
  if (typeof window === 'undefined') {
    return false;
  }

  const userAgent = window.navigator.userAgent.toLowerCase();
  const platform = window.navigator.platform?.toLowerCase() || '';
  const hasTouch = window.navigator.maxTouchPoints > 1;

  return (
    /iphone|ipad|ipod/.test(userAgent) ||
    (platform === 'macintel' && hasTouch)
  );
}

export default function InstallPageClient() {
  const [promptStatus, setPromptStatus] = useState<PromptStatus>({
    deferredPrompt: null,
    isInstalled: false,
  });
  const [isAppleMobile, setIsAppleMobile] = useState(false);
  const [message, setMessage] = useState('');
  const [promptBusy, setPromptBusy] = useState(false);
  const [continueHref, setContinueHref] = useState('/login');
  const autoPromptAttemptedRef = useRef(false);

  useEffect(() => {
    attachGlobalPwaInstallPromptListener();
    setIsAppleMobile(isIosOrIpadOs());
    setPromptStatus(getPwaInstallSnapshot());

    if (isStandaloneMode()) {
      markPwaInstalled('install_page_standalone_detected');
    }

    const unsubscribePrompt = subscribeToPwaInstallPrompt(() => {
      setPromptStatus(getPwaInstallSnapshot());
    });

    const unsubscribeAuth = onAuthStateChanged(auth, (user) => {
      setContinueHref(user ? '/player' : '/login');
    });

    return () => {
      unsubscribePrompt();
      unsubscribeAuth();
    };
  }, []);

  const runInstallPrompt = useCallback(async () => {
    const snapshot = getPwaInstallSnapshot();
    setPromptStatus(snapshot);

    if (snapshot.isInstalled || isStandaloneMode()) {
      markPwaInstalled('install_page_already_installed');
      setMessage('Royal VIP is already installed.');
      return;
    }

    if (isIosOrIpadOs()) {
      setMessage('');
      return;
    }

    if (!snapshot.deferredPrompt) {
      setMessage(
        'Install prompt is getting ready. Tap Install App again in a few seconds.'
      );
      return;
    }

    try {
      setPromptBusy(true);
      setMessage('');
      playerDebugLog('[PWA] install clicked', { source: 'install_page' });
      await snapshot.deferredPrompt.prompt();
      playerDebugLog('[PWA] prompt called', { source: 'install_page' });
      const choice = await snapshot.deferredPrompt.userChoice;

      if (choice.outcome === 'accepted') {
        markPwaInstalled('install_page_prompt_accepted');
        setMessage('Royal VIP is already installed.');
      } else {
        clearDeferredInstallPrompt('install_page_prompt_dismissed');
        setMessage('You can continue in browser.');
      }
    } catch (error) {
      playerDebugLog('[PWA] prompt blocked', {
        source: 'install_page',
        error: error instanceof Error ? error.message : String(error),
      });
      setMessage(
        'Install prompt is getting ready. Tap Install App again in a few seconds.'
      );
    } finally {
      setPromptBusy(false);
    }
  }, []);

  useEffect(() => {
    if (
      autoPromptAttemptedRef.current ||
      isAppleMobile ||
      promptStatus.isInstalled ||
      !promptStatus.deferredPrompt
    ) {
      return;
    }

    autoPromptAttemptedRef.current = true;
    void runInstallPrompt();
  }, [isAppleMobile, promptStatus, runInstallPrompt]);

  const isInstalled = promptStatus.isInstalled;

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,rgba(251,191,36,0.24),transparent_30%),linear-gradient(145deg,#10111f_0%,#30215f_42%,#9f1239_100%)] px-5 py-8 text-white">
      <div className="mx-auto flex min-h-[calc(100vh-4rem)] w-full max-w-md flex-col items-center justify-center gap-7">
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="grid size-24 place-items-center rounded-lg border border-white/20 bg-white/10 shadow-2xl shadow-black/25 backdrop-blur">
            <Image
              src="/icons/icon-192.png"
              alt="Royal VIP"
              width={72}
              height={72}
              priority
              className="rounded-md"
            />
          </div>

          <div className="space-y-2">
            <h1 className="text-3xl font-bold tracking-normal">
              {isInstalled ? 'Royal VIP is already installed' : 'Install Royal VIP'}
            </h1>
            {!isInstalled ? (
              <p className="text-base leading-6 text-white/78">
                Add Royal VIP to your phone for faster access.
              </p>
            ) : null}
          </div>
        </div>

        {isAppleMobile && !isInstalled ? (
          <section className="w-full rounded-lg border border-white/15 bg-black/20 p-5 shadow-xl shadow-black/20 backdrop-blur">
            <ol className="space-y-3 text-sm font-medium text-white/88">
              <li>1. Tap Share</li>
              <li>2. Tap Add to Home Screen</li>
              <li>3. Tap Add</li>
            </ol>
          </section>
        ) : null}

        <div className="flex w-full flex-col gap-3">
          {isInstalled ? (
            <Link
              href={continueHref}
              className="flex h-12 items-center justify-center rounded-lg bg-amber-300 px-5 text-base font-bold text-slate-950 shadow-lg shadow-amber-950/25 transition active:scale-[0.99]"
            >
              Open Royal VIP
            </Link>
          ) : (
            <button
              type="button"
              onClick={() => void runInstallPrompt()}
              disabled={promptBusy}
              className="h-12 rounded-lg bg-amber-300 px-5 text-base font-bold text-slate-950 shadow-lg shadow-amber-950/25 transition active:scale-[0.99] disabled:cursor-wait disabled:opacity-70"
            >
              {promptBusy ? 'Preparing...' : 'Install App'}
            </button>
          )}

          {!isInstalled ? (
            <Link
              href={continueHref}
              className="flex h-12 items-center justify-center rounded-lg border border-white/20 bg-white/10 px-5 text-base font-semibold text-white transition active:scale-[0.99]"
            >
              Continue in Browser
            </Link>
          ) : null}
        </div>

        {message ? (
          <p className="min-h-6 text-center text-sm font-medium text-white/82">
            {message}
          </p>
        ) : (
          <p className="min-h-6" aria-hidden="true" />
        )}
      </div>
    </main>
  );
}
