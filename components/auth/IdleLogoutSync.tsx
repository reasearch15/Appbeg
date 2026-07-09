'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { getLocalAppSessionId, revokeAppSessionOnLogout } from '@/features/auth/appSession';

/** No pointer/keyboard/scroll activity for this long → sign out. */
const IDLE_LOGOUT_MS = 5 * 60 * 1000;
/** Polling in case `setTimeout` is throttled in a background tab. */
const CHECK_EVERY_MS = 15_000;
/** Throttle how often we update “last seen activity” (high-frequency events like scroll). */
const ACTIVITY_THROTTLE_MS = 1_000;
/** Throttle for mouse move so reading with tiny movements still counts as “here”. */
const MOUSEMOVE_THROTTLE_MS = 8_000;

const ACTIVITY_WINDOW_EVENTS: (keyof WindowEventMap)[] = [
  'pointerdown',
  'keydown',
  'click',
  'touchstart',
  'wheel',
  'scroll',
];

/**
 * Periodically signs the user out and sends them to `/login` if there has been
 * no interaction for {@link IDLE_LOGOUT_MS}. Mount once in the protected shell
 * (e.g. with {@link ProtectedRoute}).
 */
export default function IdleLogoutSync() {
  const router = useRouter();
  const lastActivityAt = useRef(Date.now());
  const signingOut = useRef(false);
  const lastThrottle = useRef(0);
  const lastMousemoveAt = useRef(0);

  useEffect(() => {
    const markActivity = () => {
      const now = Date.now();
      if (now - lastThrottle.current < ACTIVITY_THROTTLE_MS) {
        return;
      }
      lastThrottle.current = now;
      lastActivityAt.current = now;
    };

    const markMouse = () => {
      const now = Date.now();
      if (now - lastMousemoveAt.current < MOUSEMOVE_THROTTLE_MS) {
        return;
      }
      lastMousemoveAt.current = now;
      lastActivityAt.current = now;
    };

    for (const ev of ACTIVITY_WINDOW_EVENTS) {
      window.addEventListener(ev, markActivity, { passive: true });
    }
    document.addEventListener('scroll', markActivity, { passive: true });
    window.addEventListener('mousemove', markMouse, { passive: true, capture: true });

    const id = window.setInterval(async () => {
      if (signingOut.current) {
        return;
      }
      if (!getLocalAppSessionId()) {
        return;
      }
      if (Date.now() - lastActivityAt.current < IDLE_LOGOUT_MS) {
        return;
      }
      signingOut.current = true;
      try {
        await revokeAppSessionOnLogout('idle_timeout');
      } catch {
        // still navigate to login; session cleanup is best effort
      }
      router.replace('/login');
    }, CHECK_EVERY_MS);

    return () => {
      for (const ev of ACTIVITY_WINDOW_EVENTS) {
        window.removeEventListener(ev, markActivity);
      }
      document.removeEventListener('scroll', markActivity);
      window.removeEventListener('mousemove', markMouse, true);
      window.clearInterval(id);
    };
  }, [router]);

  return null;
}
