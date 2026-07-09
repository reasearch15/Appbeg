'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

import { revokeAppSessionOnLogout } from '@/features/auth/appSession';

type LogoutButtonProps = {
  /** Classes for the trigger control (default: full-width sidebar style). */
  className?: string;
  label?: string;
};

const defaultClassName =
  'w-full rounded-2xl border border-rose-500/40 bg-rose-950/40 py-3.5 text-sm font-bold text-rose-100 transition hover:bg-rose-500/15';

/**
 * Sign out of Firebase and redirect to `/login`. Use on any authenticated panel.
 */
export default function LogoutButton({
  className = defaultClassName,
  label = 'Log out',
}: LogoutButtonProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  async function confirmLogout() {
    setLoading(true);
    try {
      await revokeAppSessionOnLogout();
      setOpen(false);
      router.replace('/login');
    } catch {
      setLoading(false);
    }
  }

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={className}>
        {label}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 px-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="global-logout-title"
          onClick={() => {
            if (!loading) {
              setOpen(false);
            }
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-2xl border border-white/10 bg-neutral-900 p-6 text-white shadow-2xl"
          >
            <h2 id="global-logout-title" className="text-lg font-bold">
              Sign out?
            </h2>
            <p className="mt-2 text-sm text-neutral-400">
              You will need to sign in again to use this account.
            </p>
            <div className="mt-5 flex gap-3">
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={loading}
                className="flex-1 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-bold text-white hover:bg-white/10 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void confirmLogout()}
                disabled={loading}
                className="flex-1 rounded-xl bg-rose-500 px-4 py-3 text-sm font-bold text-white hover:bg-rose-400 disabled:opacity-50"
              >
                {loading ? 'Signing out…' : 'Sign out'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
