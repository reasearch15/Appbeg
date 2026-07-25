/* AppBeg staff cash-out alert service worker.
 * Keeps a single repeating Android notification while any unclaimed
 * player cash-out IDs are synced from an authenticated staff client.
 * Periodically re-checks the pending list API so claim/cancel on any
 * device can stop the alert even if the page is backgrounded.
 */
const ALERT_TAG = 'appbeg-unclaimed-cashout';
const REPEAT_MS = 4000;
const VERIFY_EVERY_TICKS = 2;

/** @type {Set<string>} */
let pendingIds = new Set();
/** @type {ReturnType<typeof setInterval> | null} */
let repeatTimer = null;
let alerting = false;
let tickCount = 0;
/** @type {{ url: string, headers: Record<string, string> } | null} */
let verifyConfig = null;

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  const type = String(data.type || '');

  if (type === 'CASHOUT_ALERT_SYNC') {
    const ids = Array.isArray(data.pendingTaskIds)
      ? data.pendingTaskIds.map((id) => String(id || '').trim()).filter(Boolean)
      : [];
    if (data.verify && typeof data.verify.url === 'string') {
      verifyConfig = {
        url: String(data.verify.url),
        headers:
          data.verify.headers && typeof data.verify.headers === 'object'
            ? Object.fromEntries(
                Object.entries(data.verify.headers).map(([key, value]) => [
                  String(key),
                  String(value ?? ''),
                ])
              )
            : {},
      };
    }
    syncPending(ids, String(data.reason || 'client_sync'));
    return;
  }

  if (type === 'CASHOUT_ALERT_STOP') {
    verifyConfig = null;
    syncPending([], String(data.reason || 'client_stop'));
    return;
  }

  if (type === 'CASHOUT_ALERT_PING') {
    event.source?.postMessage?.({
      type: 'CASHOUT_ALERT_STATE',
      alerting,
      pendingCount: pendingIds.size,
      pendingTaskIds: [...pendingIds],
    });
  }
});

self.addEventListener('notificationclick', (event) => {
  // Viewing / opening must not stop the alert loop.
  event.notification.close();
  event.waitUntil(focusOrOpenStaffClient());
});

self.addEventListener('notificationclose', () => {
  // Ignore user dismiss; interval will re-show while unclaimed remain.
});

/**
 * @param {string[]} ids
 * @param {string} reason
 */
function syncPending(ids, reason) {
  const unique = [...new Set(ids)];
  const prevKey = [...pendingIds].sort().join(',');
  const nextKey = [...unique].sort().join(',');
  pendingIds = new Set(unique);

  if (pendingIds.size === 0) {
    stopAlert(reason || 'no_unclaimed');
    return;
  }

  if (!alerting) {
    startAlert(reason || 'unclaimed_present');
    return;
  }

  if (prevKey !== nextKey) {
    console.info('[CASHOUT_ALERT] pending_updated', {
      reason,
      pendingCount: pendingIds.size,
    });
    void showAlertNotification();
  }
}

/**
 * @param {string} reason
 */
function startAlert(reason) {
  if (alerting) {
    console.info('[CASHOUT_ALERT] start_skipped_duplicate', {
      reason,
      pendingCount: pendingIds.size,
    });
    return;
  }

  alerting = true;
  tickCount = 0;
  console.info('[CASHOUT_ALERT] started', {
    reason,
    pendingCount: pendingIds.size,
    pendingTaskIds: [...pendingIds],
  });
  void showAlertNotification();
  repeatTimer = setInterval(() => {
    void onAlertTick();
  }, REPEAT_MS);
}

/**
 * @param {string} reason
 */
function stopAlert(reason) {
  const wasAlerting = alerting || Boolean(repeatTimer);
  alerting = false;
  pendingIds = new Set();
  tickCount = 0;

  if (repeatTimer) {
    clearInterval(repeatTimer);
    repeatTimer = null;
  }

  if (wasAlerting) {
    console.info('[CASHOUT_ALERT] stopped', { reason });
  }

  void self.registration.getNotifications({ tag: ALERT_TAG }).then((notifications) => {
    for (const notification of notifications) {
      notification.close();
    }
  });
}

async function onAlertTick() {
  if (!alerting) {
    return;
  }

  tickCount += 1;
  if (tickCount % VERIFY_EVERY_TICKS === 0) {
    const verifiedIds = await verifyUnclaimedFromBackend();
    if (verifiedIds) {
      if (verifiedIds.length === 0) {
        verifyConfig = null;
        stopAlert('backend_no_unclaimed');
        return;
      }
      syncPending(verifiedIds, 'backend_verify');
      if (!alerting) {
        return;
      }
    }
  }

  await showAlertNotification();
}

async function verifyUnclaimedFromBackend() {
  if (!verifyConfig?.url) {
    return null;
  }

  try {
    const response = await fetch(verifyConfig.url, {
      method: 'GET',
      headers: verifyConfig.headers,
      cache: 'no-store',
      credentials: 'same-origin',
    });
    if (!response.ok) {
      console.warn('[CASHOUT_ALERT] backend_verify_failed', { status: response.status });
      return null;
    }

    const payload = (await response.json().catch(() => ({}))) || {};
    const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
    const unclaimed = tasks
      .filter((task) => {
        const status = String(task?.status || '').toLowerCase();
        const handler = String(task?.assignedHandlerUid || '').trim();
        return status === 'pending' && !handler;
      })
      .map((task) => String(task?.id || '').trim())
      .filter(Boolean);

    console.info('[CASHOUT_ALERT] backend_verify', {
      pendingCount: unclaimed.length,
    });
    return unclaimed;
  } catch (error) {
    console.warn('[CASHOUT_ALERT] backend_verify_error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function showAlertNotification() {
  if (!alerting || pendingIds.size === 0) {
    return;
  }

  const count = pendingIds.size;
  const body =
    count === 1
      ? 'A player cash-out is waiting to be claimed.'
      : `${count} player cash-outs are waiting to be claimed.`;

  try {
    // Close-then-show forces Android to replay notification sound.
    const existing = await self.registration.getNotifications({ tag: ALERT_TAG });
    for (const notification of existing) {
      notification.close();
    }

    await self.registration.showNotification('Unclaimed cash-out request', {
      body,
      tag: ALERT_TAG,
      renotify: true,
      requireInteraction: true,
      silent: false,
      vibrate: [200, 100, 200, 100, 200],
      data: {
        type: 'cashout_alert',
        pendingCount: count,
        pendingTaskIds: [...pendingIds],
      },
    });
  } catch (error) {
    console.warn('[CASHOUT_ALERT] show_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function focusOrOpenStaffClient() {
  const clientsList = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  });

  for (const client of clientsList) {
    const url = String(client.url || '');
    if (url.includes('/staff') || url.includes('/coadmin')) {
      if ('focus' in client) {
        await client.focus();
      }
      return;
    }
  }

  if (self.clients.openWindow) {
    await self.clients.openWindow('/staff');
  }
}
