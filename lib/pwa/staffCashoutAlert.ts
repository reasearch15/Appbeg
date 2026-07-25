'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getCachedSessionUser } from '@/features/auth/sessionUser';
import { getStaffAppSessionApiHeaders } from '@/lib/client/staffApiHeaders';

const SW_URL = '/sw.js';
const ENABLED_STORAGE_KEY = 'appbeg.staffCashoutAlertsEnabled';
const CHANNEL_NAME = 'appbeg-cashout-alert';

type NotificationPermissionState = NotificationPermission | 'unsupported';

type CashoutAlertVerifyConfig = {
  url: string;
  headers: Record<string, string>;
};

let registrationPromise: Promise<ServiceWorkerRegistration | null> | null = null;
let lastSyncedKey = '';
let lastPendingIds: string[] = [];
let lastVerifyConfig: CashoutAlertVerifyConfig | null = null;
let syncInFlight: Promise<void> | null = null;

function cleanIds(ids: string[]) {
  return [...new Set(ids.map((id) => String(id || '').trim()).filter(Boolean))].sort();
}

function idsKey(ids: string[]) {
  return cleanIds(ids).join(',');
}

function readEnabledFlag() {
  if (typeof window === 'undefined') {
    return false;
  }
  try {
    return window.localStorage.getItem(ENABLED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeEnabledFlag(enabled: boolean) {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    if (enabled) {
      window.localStorage.setItem(ENABLED_STORAGE_KEY, '1');
    } else {
      window.localStorage.removeItem(ENABLED_STORAGE_KEY);
    }
  } catch {
    // Ignore storage failures (private mode, etc.).
  }
}

export function getStaffCashoutAlertPermission(): NotificationPermissionState {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'unsupported';
  }
  return window.Notification.permission;
}

export function logStaffCashoutAlertPermission(source: string) {
  const permission = getStaffCashoutAlertPermission();
  const enabled = readEnabledFlag();
  console.info('[CASHOUT_ALERT] notification_permission', {
    source,
    permission,
    enabled,
    serviceWorker: typeof navigator !== 'undefined' && 'serviceWorker' in navigator,
  });
  return { permission, enabled };
}

export async function registerStaffCashoutAlertServiceWorker() {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    console.info('[CASHOUT_ALERT] notification_permission', {
      source: 'register',
      permission: 'unsupported',
      enabled: readEnabledFlag(),
      serviceWorker: false,
    });
    return null;
  }

  if (!registrationPromise) {
    registrationPromise = navigator.serviceWorker
      .register(SW_URL, { scope: '/' })
      .then(async (registration) => {
        await navigator.serviceWorker.ready;
        console.info('[CASHOUT_ALERT] service_worker_ready', {
          scope: registration.scope,
          active: Boolean(registration.active),
        });
        return registration;
      })
      .catch((error) => {
        registrationPromise = null;
        console.warn('[CASHOUT_ALERT] service_worker_register_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      });
  }

  return registrationPromise;
}

function postToServiceWorker(message: Record<string, unknown>) {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return false;
  }

  const controller = navigator.serviceWorker.controller;
  if (controller) {
    controller.postMessage(message);
    return true;
  }

  void navigator.serviceWorker.ready.then((registration) => {
    registration.active?.postMessage(message);
  });
  return true;
}

function broadcastLocal(message: Record<string, unknown>) {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') {
    return;
  }
  try {
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channel.postMessage(message);
    channel.close();
  } catch {
    // BroadcastChannel unavailable.
  }
}

async function buildVerifyConfig(): Promise<CashoutAlertVerifyConfig | null> {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const sessionUser = getCachedSessionUser();
    const role = String(sessionUser?.role || '').toLowerCase();
    const coadminUid = String(sessionUser?.coadminUid || '').trim();
    const headers = await getStaffAppSessionApiHeaders(false);

    let scope = 'staff';
    let uid = coadminUid;
    if (role === 'coadmin') {
      scope = 'coadmin';
      uid = String(sessionUser?.uid || coadminUid).trim();
    } else if (role === 'admin') {
      scope = 'all';
      uid = 'all';
    }

    if (scope !== 'all' && !uid) {
      return lastVerifyConfig;
    }

    const params = new URLSearchParams({
      scope,
      list: 'pending',
      limit: '50',
    });
    if (scope !== 'all') {
      params.set('uid', uid);
    }

    const config = {
      url: `${window.location.origin}/api/player-cashout-tasks/cache?${params.toString()}`,
      headers,
    };
    lastVerifyConfig = config;
    return config;
  } catch (error) {
    console.warn('[CASHOUT_ALERT] verify_config_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return lastVerifyConfig;
  }
}

/**
 * Sync unclaimed pending cash-out IDs to the service worker.
 * Lists come from SSE/poll; the SW also re-verifies against the pending API.
 */
export function syncStaffCashoutAlertPending(
  pendingTaskIds: string[],
  reason = 'pending_change'
) {
  const ids = cleanIds(pendingTaskIds);
  lastPendingIds = ids;
  const key = idsKey(ids);

  if (!readEnabledFlag() || getStaffCashoutAlertPermission() !== 'granted') {
    if (lastSyncedKey !== '') {
      lastSyncedKey = '';
      postToServiceWorker({ type: 'CASHOUT_ALERT_STOP', reason: 'alerts_disabled' });
    }
    return;
  }

  if (key === lastSyncedKey) {
    return;
  }
  lastSyncedKey = key;

  const run = async () => {
    // Drop stale work if a newer sync already replaced the target set.
    if (idsKey(lastPendingIds) !== key) {
      return;
    }

    const verify = ids.length > 0 ? await buildVerifyConfig() : null;
    const message = {
      type: 'CASHOUT_ALERT_SYNC' as const,
      pendingTaskIds: ids,
      reason,
      verify: ids.length > 0 ? verify || lastVerifyConfig : null,
    };
    postToServiceWorker(message);
    broadcastLocal(message);

    if (ids.length === 0) {
      console.info('[CASHOUT_ALERT] sync_empty', { reason });
    } else {
      console.info('[CASHOUT_ALERT] sync_pending', {
        reason,
        pendingCount: ids.length,
        pendingTaskIds: ids,
      });
    }
  };

  syncInFlight = (syncInFlight || Promise.resolve()).then(run, run);
  void syncInFlight;
}

export function stopStaffCashoutAlert(reason = 'manual_stop') {
  lastSyncedKey = '';
  lastPendingIds = [];
  lastVerifyConfig = null;
  postToServiceWorker({ type: 'CASHOUT_ALERT_STOP', reason });
  broadcastLocal({ type: 'CASHOUT_ALERT_STOP', reason });
  console.info('[CASHOUT_ALERT] stopped', { reason, source: 'client' });
}

export function logStaffCashoutAlertClaimReceived(taskId: string) {
  console.info('[CASHOUT_ALERT] claim_received', { taskId: String(taskId || '').trim() });
}

export async function enableStaffCashoutAlerts() {
  logStaffCashoutAlertPermission('enable_click');

  if (typeof window === 'undefined' || !('Notification' in window)) {
    writeEnabledFlag(false);
    logStaffCashoutAlertPermission('enable_unsupported');
    throw new Error('Notifications are not supported in this browser.');
  }

  if (!('serviceWorker' in navigator)) {
    writeEnabledFlag(false);
    logStaffCashoutAlertPermission('enable_no_service_worker');
    throw new Error('Service workers are required for persistent cash-out alerts.');
  }

  const registration = await registerStaffCashoutAlertServiceWorker();
  if (!registration) {
    writeEnabledFlag(false);
    throw new Error('Could not register the cash-out alert service worker.');
  }

  let permission = window.Notification.permission;
  if (permission === 'default') {
    permission = await window.Notification.requestPermission();
  }

  logStaffCashoutAlertPermission('enable_after_request');

  if (permission !== 'granted') {
    writeEnabledFlag(false);
    stopStaffCashoutAlert('permission_denied');
    throw new Error(
      permission === 'denied'
        ? 'Notification permission denied. Enable it in browser settings to hear cash-out alerts.'
        : 'Notification permission was not granted.'
    );
  }

  writeEnabledFlag(true);
  lastSyncedKey = '';
  syncStaffCashoutAlertPending(lastPendingIds, 'alerts_enabled');
  return permission;
}

export function useStaffCashoutAlerts(pendingTaskIds: string[]) {
  const [enabled, setEnabled] = useState(false);
  const [permission, setPermission] = useState<NotificationPermissionState>('default');
  const [busy, setBusy] = useState(false);
  const pendingKey = useMemo(() => idsKey(pendingTaskIds), [pendingTaskIds]);
  const pendingIdsRef = useRef(pendingTaskIds);
  pendingIdsRef.current = pendingTaskIds;

  useEffect(() => {
    const initial = logStaffCashoutAlertPermission('hydrate');
    setEnabled(initial.enabled);
    setPermission(initial.permission);

    if (!initial.enabled || initial.permission !== 'granted') {
      return;
    }

    let cancelled = false;
    void registerStaffCashoutAlertServiceWorker().then(() => {
      if (!cancelled) {
        lastSyncedKey = '';
        syncStaffCashoutAlertPending(pendingIdsRef.current, 'hydrate_register');
      }
    });

    const onControllerChange = () => {
      lastSyncedKey = '';
      syncStaffCashoutAlertPending(pendingIdsRef.current, 'controllerchange');
    };
    navigator.serviceWorker?.addEventListener('controllerchange', onControllerChange);

    let channel: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(CHANNEL_NAME);
      channel.onmessage = (event) => {
        const data = event.data || {};
        if (data.type === 'CASHOUT_ALERT_SYNC' || data.type === 'CASHOUT_ALERT_STOP') {
          lastSyncedKey =
            data.type === 'CASHOUT_ALERT_STOP'
              ? ''
              : idsKey(Array.isArray(data.pendingTaskIds) ? data.pendingTaskIds : []);
        }
      };
    }

    return () => {
      cancelled = true;
      navigator.serviceWorker?.removeEventListener('controllerchange', onControllerChange);
      channel?.close();
    };
  }, []);

  useEffect(() => {
    syncStaffCashoutAlertPending(pendingTaskIds, 'pending_change');
  }, [pendingKey, pendingTaskIds, enabled, permission]);

  useEffect(() => {
    if (!enabled || permission !== 'granted' || pendingTaskIds.length === 0) {
      return;
    }

    const intervalId = window.setInterval(() => {
      lastSyncedKey = '';
      syncStaffCashoutAlertPending(pendingIdsRef.current, 'verify_refresh');
    }, 60_000);

    return () => window.clearInterval(intervalId);
  }, [enabled, permission, pendingKey, pendingTaskIds.length]);

  const enableAlerts = useCallback(async () => {
    setBusy(true);
    try {
      const nextPermission = await enableStaffCashoutAlerts();
      setPermission(nextPermission);
      setEnabled(true);
      lastSyncedKey = '';
      syncStaffCashoutAlertPending(pendingIdsRef.current, 'enable_success');
      return nextPermission;
    } finally {
      setBusy(false);
      setPermission(getStaffCashoutAlertPermission());
      setEnabled(readEnabledFlag() && getStaffCashoutAlertPermission() === 'granted');
    }
  }, []);

  return {
    enabled: enabled && permission === 'granted',
    permission,
    busy,
    enableAlerts,
    unsupported: permission === 'unsupported',
  };
}
