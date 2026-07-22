'use client';

import { playerDebugLog } from '@/lib/client/playerDebugLogs';
export type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

type PwaInstallSnapshot = {
  deferredPrompt: BeforeInstallPromptEvent | null;
  isInstalled: boolean;
};

declare global {
  interface Window {
    __royalVipDeferredInstallPrompt?: BeforeInstallPromptEvent | null;
    __royalVipNotifyPwaInstallSubscribers?: () => void;
    __royalVipPwaInstalled?: boolean;
    __royalVipPwaInstallBootstrapAttached?: boolean;
    __royalVipPwaInstallModuleListenerAttached?: boolean;
    __royalVipPwaInstallSubscribers?: Array<() => void>;
  }
}

const subscribers = new Set<() => void>();

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let isInstalled = false;

function pwaLog(message: string, data?: Record<string, unknown>) {
  playerDebugLog(`[PWA] ${message}`, data || {});
}

function syncFromWindow() {
  if (typeof window === 'undefined') {
    return;
  }

  deferredPrompt = window.__royalVipDeferredInstallPrompt || null;
  isInstalled = window.__royalVipPwaInstalled === true || isStandaloneMode();
}

function notifySubscribers() {
  syncFromWindow();
  subscribers.forEach((subscriber) => subscriber());
}

export function isStandaloneMode(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  if (window.matchMedia('(display-mode: standalone)').matches) {
    return true;
  }

  return Boolean(
    (window.navigator as Navigator & { standalone?: boolean }).standalone
  );
}

export function getPwaInstallSnapshot(): PwaInstallSnapshot {
  syncFromWindow();
  return {
    deferredPrompt,
    isInstalled,
  };
}

export function subscribeToPwaInstallPrompt(listener: () => void) {
  syncFromWindow();
  subscribers.add(listener);
  if (typeof window !== 'undefined') {
    window.__royalVipPwaInstallSubscribers =
      window.__royalVipPwaInstallSubscribers || [];
    window.__royalVipPwaInstallSubscribers.push(listener);
  }
  return () => {
    subscribers.delete(listener);
    if (typeof window !== 'undefined' && window.__royalVipPwaInstallSubscribers) {
      window.__royalVipPwaInstallSubscribers =
        window.__royalVipPwaInstallSubscribers.filter(
          (subscriber) => subscriber !== listener
        );
    }
  };
}

export function clearDeferredInstallPrompt(reason: string) {
  deferredPrompt = null;
  if (typeof window !== 'undefined') {
    window.__royalVipDeferredInstallPrompt = null;
  }
  pwaLog('prompt cleared', { reason });
  notifySubscribers();
}

export function markPwaInstalled(reason: string) {
  isInstalled = true;
  if (typeof window !== 'undefined') {
    window.__royalVipPwaInstalled = true;
  }
  clearDeferredInstallPrompt(reason);
  notifySubscribers();
}

export function attachGlobalPwaInstallPromptListener() {
  if (typeof window === 'undefined') {
    return;
  }

  syncFromWindow();

  if (window.__royalVipPwaInstallBootstrapAttached) {
    return;
  }

  if (window.__royalVipPwaInstallModuleListenerAttached) {
    return;
  }

  window.__royalVipPwaInstallModuleListenerAttached = true;
  pwaLog('listener attached');

  if (isStandaloneMode()) {
    markPwaInstalled('standalone_detected');
    return;
  }

  const handleBeforeInstallPrompt = (event: Event) => {
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    window.__royalVipDeferredInstallPrompt = deferredPrompt;
    pwaLog('beforeinstallprompt fired');
    pwaLog('prompt stored');
    notifySubscribers();
  };

  const handleAppInstalled = () => {
    pwaLog('appinstalled');
    markPwaInstalled('appinstalled');
  };

  window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
  window.addEventListener('appinstalled', handleAppInstalled);
}
