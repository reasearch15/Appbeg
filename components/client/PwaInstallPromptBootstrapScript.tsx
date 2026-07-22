import Script from 'next/script';

function isPlayerDebugLogsEnabledForInlineScript() {
  return (
    process.env.NEXT_PUBLIC_PLAYER_DEBUG_LOGS === '1' ||
    process.env.NEXT_PUBLIC_DEBUG_SQL_RUNTIME === '1'
  );
}

export default function PwaInstallPromptBootstrapScript() {
  const playerDebugLogsEnabled = isPlayerDebugLogsEnabledForInlineScript();

  return (
    <Script
      id="royal-vip-pwa-install-prompt"
      strategy="beforeInteractive"
    >
      {`
        (function () {
          if (window.__royalVipPwaInstallBootstrapAttached) return;
          window.__royalVipPwaInstallBootstrapAttached = true;

          function __royalVipPlayerDebugLog(message, details) {
            if (!${playerDebugLogsEnabled}) return;
            if (details !== undefined) console.info(message, details);
            else console.info(message);
          }

          __royalVipPlayerDebugLog('[PWA] listener attached');

          window.__royalVipPwaInstallSubscribers = window.__royalVipPwaInstallSubscribers || [];
          window.__royalVipNotifyPwaInstallSubscribers = function () {
            window.__royalVipPwaInstallSubscribers.forEach(function (subscriber) {
              try { subscriber(); } catch (error) {}
            });
          };

          window.addEventListener('beforeinstallprompt', function (event) {
            event.preventDefault();
            window.__royalVipDeferredInstallPrompt = event;
            __royalVipPlayerDebugLog('[PWA] beforeinstallprompt fired');
            __royalVipPlayerDebugLog('[PWA] prompt stored');
            window.__royalVipNotifyPwaInstallSubscribers();
          });

          window.addEventListener('appinstalled', function () {
            window.__royalVipPwaInstalled = true;
            window.__royalVipDeferredInstallPrompt = null;
            __royalVipPlayerDebugLog('[PWA] appinstalled');
            window.__royalVipNotifyPwaInstallSubscribers();
          });
        })();
      `}
    </Script>
  );
}
