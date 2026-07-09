'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';

import { DASHBOARD_BY_ROLE, isValidRole, UserRole } from '@/lib/auth/roles';
import { getLocalAppSessionId } from '@/features/auth/appSession';
import { discardStalePlayerSessionIdForRole } from '@/features/auth/playerSession';
import { getCachedSessionUser, getSessionUserOnce } from '@/features/auth/sessionUser';
import { recordDevActiveSession } from '@/features/dev/devUsageEstimates';
import UserPresenceSync from '@/components/presence/UserPresenceSync';
import IdleLogoutSync from '@/components/auth/IdleLogoutSync';
import {
  currentClientPath,
  logProtectedRouteDecision,
} from '@/lib/client/protectedRouteLog';
import {
  logChatLogoutTrigger,
  shouldProtectPlayerChatSession,
} from '@/lib/client/chatLogoutDiagnostics';
import {
  installPlayerSessionStorageWatch,
  isPlayerSessionStale,
} from '@/lib/client/playerStaleSession';
import { markPlayerClientRouteNavigation } from '@/lib/client/playerSessionNavigationGuard';
import { isSqlPlayerRuntimeMode } from '@/lib/client/sqlPlayerRuntimeAuth';
import {
  endLocalPlayerSessionOnBrowserLeave,
  resumePlayerSessionAfterClientContinuation,
  handleDefinitivePlayerSessionFailure,
  getLocalPlayerSessionId,
  isPlayerForcedLogout,
  isPlayerSessionReady,
  isSqlPlayerAppSessionMode,
  listenForPlayerSessionReplacement,
  startPlayerSessionStatusPolling,
  touchPlayerSession,
  seedPlayerSessionVerifyCache,
  ensurePlayerSessionGateReady,
  verifyActivePlayerSession,
} from '@/features/auth/playerSession';

type ProtectedRouteProps = {
  allowedRoles: UserRole[];
  children: React.ReactNode;
};

const SQL_GUARD_ROLES: UserRole[] = ['admin', 'coadmin', 'staff', 'carer'];

function routeSupportsSqlSessionGuard(allowedRoles: UserRole[]) {
  return allowedRoles.some((role) => SQL_GUARD_ROLES.includes(role));
}

function routeIsPlayerOnly(allowedRoles: UserRole[]) {
  return allowedRoles.length === 1 && allowedRoles[0] === 'player';
}

function redirectToLogin(
  router: ReturnType<typeof useRouter>,
  values: {
    file: string;
    function: string;
    reason: string;
    trigger: string;
    uid?: string | null;
    role?: string | null;
  }
) {
  if (shouldProtectPlayerChatSession()) {
    logChatLogoutTrigger({
      file: values.file,
      function: values.function,
      reason: `deferred_${values.reason}`,
      trigger: values.trigger,
      uid: values.uid ?? null,
      role: values.role ?? null,
    });
    return false;
  }

  logChatLogoutTrigger({
    file: values.file,
    function: values.function,
    reason: values.reason,
    trigger: values.trigger,
    uid: values.uid ?? null,
    role: values.role ?? null,
  });
  router.replace('/login');
  return true;
}

function redirectRoleMismatch(
  router: ReturnType<typeof useRouter>,
  sessionUser: { uid: string; role: UserRole },
  allowedRoles: UserRole[],
  reason: string
): 'denied' {
  const redirectTo = DASHBOARD_BY_ROLE[sessionUser.role];
  logProtectedRouteDecision({
    path: currentClientPath(),
    uid: sessionUser.uid,
    role: sessionUser.role,
    allowedRoles,
    decision: 'redirect',
    redirectTo,
    reason,
  });
  router.replace(redirectTo);
  return 'denied';
}

export default function ProtectedRoute({
  allowedRoles,
  children,
}: ProtectedRouteProps) {
  const router = useRouter();
  const pathname = usePathname();
  const pathnameRef = useRef(pathname);
  const [checking, setChecking] = useState(true);
  const [currentRole, setCurrentRole] = useState<UserRole | null>(null);
  const [forcedLogout, setForcedLogout] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function tryPlayerAppSessionGuard(): Promise<'allowed' | 'fallback' | 'denied'> {
      if (!routeIsPlayerOnly(allowedRoles)) {
        return 'fallback';
      }

      if (!getLocalAppSessionId()) {
        console.info('[PROTECTED_ROUTE_AUTH]', {
          source: 'player_app_session',
          ok: false,
          reason: 'missing_app_session_id',
        });
        return 'fallback';
      }

      const gate = await ensurePlayerSessionGateReady({
        source: 'tryPlayerAppSessionGuard',
      });
      if (gate.state === 'loading') {
        const loadingSessionUser =
          getCachedSessionUser()?.role === 'player'
            ? getCachedSessionUser()
            : await getSessionUserOnce().catch(() => null);
        if (loadingSessionUser?.role === 'player') {
          console.info('[PROTECTED_ROUTE_AUTH]', {
            source: 'player_app_session',
            ok: true,
            uid: loadingSessionUser.uid,
            role: 'player',
            reason: gate.reason || 'player_session_gate_loading',
            hasAppSessionId: Boolean(getLocalAppSessionId()),
            hasPlayerSessionId: Boolean(getLocalPlayerSessionId()),
          });
          setCurrentRole('player');
          recordDevActiveSession('player', loadingSessionUser.uid);
          setChecking(false);
          return 'allowed';
        }
        console.info('[PROTECTED_ROUTE_AUTH]', {
          source: 'player_app_session',
          ok: true,
          reason: gate.reason || 'player_session_gate_loading',
          hasAppSessionId: Boolean(getLocalAppSessionId()),
          hasPlayerSessionId: Boolean(getLocalPlayerSessionId()),
        });
      } else if (gate.state === 'failed') {
        console.info('[PROTECTED_ROUTE_AUTH]', {
          source: 'player_app_session',
          ok: false,
          reason: gate.reason,
          hasAppSessionId: Boolean(getLocalAppSessionId()),
          hasPlayerSessionId: Boolean(getLocalPlayerSessionId()),
        });
        return 'fallback';
      }

      const cachedUser = getCachedSessionUser();
      const usedCachedSession = Boolean(cachedUser && cachedUser.role === 'player');
      const sessionUser = usedCachedSession
        ? cachedUser
        : await getSessionUserOnce();
      if (cancelled) {
        return 'denied';
      }

      if (!sessionUser || sessionUser.role !== 'player') {
        console.info('[PROTECTED_ROUTE_AUTH]', {
          source: 'player_app_session',
          ok: false,
          reason: 'missing_or_invalid_session',
        });
        return 'fallback';
      }

      const sessionStatus = await verifyActivePlayerSession();
      if (!sessionStatus.ok) {
        if (sessionStatus.reason === 'session_replaced' && sessionStatus.activeSessionId) {
          console.info('[SESSION_GUARD] old device kicked because session mismatch', {
            uid: sessionUser.uid,
            localSessionId: getLocalPlayerSessionId() || null,
            activeSessionId: sessionStatus.activeSessionId,
          });
        }
        console.info('[PROTECTED_ROUTE_AUTH]', {
          source: 'player_app_session',
          ok: false,
          uid: sessionUser.uid,
          reason: sessionStatus.reason,
        });
        if (
          sessionStatus.reason === 'session_replaced' ||
          sessionStatus.reason === 'session_inactive'
        ) {
          setCurrentRole(null);
          setForcedLogout(true);
          setChecking(false);
          void handleDefinitivePlayerSessionFailure(sessionStatus.reason, {
            pollName: 'protected_route_app_session_guard',
            redirect: (url) => router.replace(url),
          });
          return 'denied';
        }
        console.info('[PROTECTED_ROUTE_AUTH]', {
          source: 'player_app_session',
          ok: true,
          uid: sessionUser.uid,
          role: 'player',
          reason: 'transient_verify_failure_allowed',
        });
        setCurrentRole('player');
        recordDevActiveSession('player', sessionUser.uid);
        setChecking(false);
        return 'allowed';
      }

      seedPlayerSessionVerifyCache(sessionStatus);
      console.info('[PROTECTED_ROUTE_AUTH]', {
        source: usedCachedSession ? 'cached_app_session' : 'player_app_session',
        ok: true,
        uid: sessionUser.uid,
        role: 'player',
      });
      setCurrentRole('player');
      recordDevActiveSession('player', sessionUser.uid);
      setChecking(false);
      return 'allowed';
    }

    async function tryAppSessionGuard(): Promise<'allowed' | 'fallback' | 'denied'> {
      if (!routeSupportsSqlSessionGuard(allowedRoles)) {
        return 'fallback';
      }

      const cachedUser = getCachedSessionUser();
      const usedCachedSession = Boolean(cachedUser && isValidRole(cachedUser.role));
      const sessionUser = usedCachedSession
        ? cachedUser
        : await getSessionUserOnce();
      if (cancelled) {
        return 'denied';
      }

      if (!sessionUser || !isValidRole(sessionUser.role)) {
        console.info('[PROTECTED_ROUTE_AUTH]', {
          source: 'app_session',
          ok: false,
          reason: 'missing_or_invalid_session',
        });
        return 'fallback';
      }

      if (!allowedRoles.includes(sessionUser.role)) {
        console.info('[PROTECTED_ROUTE_AUTH]', {
          source: 'app_session',
          ok: false,
          role: sessionUser.role,
          reason: 'role_not_allowed',
        });
        setCurrentRole(null);
        return redirectRoleMismatch(
          router,
          sessionUser as { uid: string; role: UserRole },
          allowedRoles,
          'role_not_allowed_for_route'
        );
      }

      logProtectedRouteDecision({
        path: currentClientPath(),
        uid: sessionUser.uid,
        role: sessionUser.role,
        allowedRoles,
        decision: 'allow',
        reason: usedCachedSession ? 'cached_app_session' : 'app_session',
      });

      console.info('[PROTECTED_ROUTE_AUTH]', {
        source: usedCachedSession ? 'cached_app_session' : 'app_session',
        ok: true,
        role: sessionUser.role,
        uid: sessionUser.uid,
      });

      setCurrentRole(sessionUser.role);
      if (sessionUser.role !== 'player') {
        discardStalePlayerSessionIdForRole(sessionUser.role, 'protected_route_non_player');
      }
      if (sessionUser.role === 'carer') {
        recordDevActiveSession(sessionUser.role, sessionUser.uid);
      }
      setChecking(false);
      return 'allowed';
    }

    function startFirebaseGuard() {
      const cachedUser = getCachedSessionUser();
      console.info('[PROTECTED_ROUTE_AUTH]', {
        source: 'sql_session_only',
        ok: false,
        reason: 'missing_or_invalid_sql_session',
        cachedRole: cachedUser?.role ?? null,
        path: currentClientPath(),
      });
      setCurrentRole(null);
      setChecking(false);
      redirectToLogin(router, {
        file: 'components/auth/ProtectedRoute.tsx',
        function: 'startFirebaseGuard',
        reason: 'missing_or_invalid_sql_session',
        trigger: 'sql_session_guard',
        uid: cachedUser?.uid ?? null,
        role: cachedUser?.role ?? null,
      });
    }

    void (async () => {
      if (forcedLogout || isPlayerForcedLogout()) {
        setCurrentRole(null);
        setChecking(false);
        return;
      }

      if (getLocalAppSessionId()) {
        const cachedUser = getCachedSessionUser();
        const sessionUser =
          cachedUser && isValidRole(cachedUser.role)
            ? cachedUser
            : await getSessionUserOnce();
        if (cancelled) {
          return;
        }
        if (sessionUser && isValidRole(sessionUser.role)) {
          if (!allowedRoles.includes(sessionUser.role)) {
            setCurrentRole(null);
            setChecking(false);
            redirectRoleMismatch(
              router,
              sessionUser as { uid: string; role: UserRole },
              allowedRoles,
              'sql_session_role_not_allowed_for_route'
            );
            return;
          }
        }
      }

      const playerSqlResult = await tryPlayerAppSessionGuard();
      if (cancelled || playerSqlResult === 'allowed' || playerSqlResult === 'denied') {
        return;
      }

      const sqlResult = await tryAppSessionGuard();
      if (cancelled || sqlResult === 'allowed' || sqlResult === 'denied') {
        return;
      }

      if (routeIsPlayerOnly(allowedRoles) && isSqlPlayerRuntimeMode()) {
        const sessionUser = await getSessionUserOnce().catch(() => null);
        if (cancelled) {
          return;
        }
        if (sessionUser?.role === 'player') {
          console.info('[PROTECTED_ROUTE_AUTH]', {
            source: 'sql_player_runtime',
            ok: true,
            uid: sessionUser.uid,
            role: 'player',
            reason: 'firebase_skipped_sql_runtime',
          });
          setCurrentRole('player');
          recordDevActiveSession('player', sessionUser.uid);
          setChecking(false);
          return;
        }
      }

      startFirebaseGuard();
    })();

    return () => {
      cancelled = true;
    };
  }, [allowedRoles, forcedLogout]);

  useLayoutEffect(() => {
    markPlayerClientRouteNavigation(pathname);
    pathnameRef.current = pathname;
  }, [pathname]);

  useEffect(() => {
    if (currentRole !== 'player') {
      return;
    }

    installPlayerSessionStorageWatch();

    const sqlRuntime = isSqlPlayerRuntimeMode();
    if (!sqlRuntime && !isPlayerSessionReady()) {
      return;
    }

    const sessionId = getLocalPlayerSessionId();
    if (!sessionId && !sqlRuntime) {
      return;
    }

    const currentUser = null;
    let stopSessionListener = () => {};

    const handlePollKick = () => {
      setForcedLogout(true);
      setCurrentRole(null);
      stopSessionListener();
    };

    const stopPolling = startPlayerSessionStatusPolling({
      intervalMs: 15_000,
      redirect: (url) => router.replace(url),
      onReplaced: handlePollKick,
      onInactive: handlePollKick,
    });

    const sqlPlayerAppSession = isSqlPlayerAppSessionMode() || sqlRuntime;

    if (currentUser && !sqlPlayerAppSession) {
      stopSessionListener = listenForPlayerSessionReplacement(currentUser, () => {
        setForcedLogout(true);
        setCurrentRole(null);
        stopSessionListener();
        stopPolling();
        void handleDefinitivePlayerSessionFailure('session_replaced', {
          pollName: 'listenForPlayerSessionReplacement',
          redirect: (url) => router.replace(url),
        });
      });
    }

    void resumePlayerSessionAfterClientContinuation(currentUser).then((resumed) => {
      if (!resumed) {
        void touchPlayerSession(currentUser);
      }
    });
    const heartbeat = window.setInterval(() => {
      if (isPlayerSessionStale()) {
        window.clearInterval(heartbeat);
        return;
      }
      void touchPlayerSession(null);
    }, 45_000);
    const mountedAt = Date.now();
    const markContinuation = (event: Event) => {
      void endLocalPlayerSessionOnBrowserLeave(event, {
        mountedAt,
        route: pathnameRef.current || currentClientPath(),
      });
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        void touchPlayerSession(currentUser);
      }
    };
    window.addEventListener('pagehide', markContinuation);
    window.addEventListener('pageshow', onPageShow);

    return () => {
      stopSessionListener();
      stopPolling();
      window.clearInterval(heartbeat);
      window.removeEventListener('pagehide', markContinuation);
      window.removeEventListener('pageshow', onPageShow);
    };
  }, [currentRole]);

  if (forcedLogout || isPlayerForcedLogout()) {
    console.info('[SESSION_GUARD] protected render blocked');
    return (
      <main className="flex min-h-screen items-center justify-center bg-neutral-950 text-white">
        <p className="text-sm text-neutral-400">Signing out...</p>
      </main>
    );
  }

  if (checking) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-neutral-950 text-white">
        <p className="text-sm text-neutral-400">Checking access...</p>
      </main>
    );
  }

  return (
    <>
      <UserPresenceSync />
      {currentRole !== 'player' && currentRole !== 'carer' ? <IdleLogoutSync /> : null}
      {children}
    </>
  );
}
