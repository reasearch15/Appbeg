'use client';

import { playerDebugLog } from '@/lib/client/playerDebugLogs';
export type LoginUiStep =
  | 'checking_account'
  | 'verifying_password'
  | 'creating_secure_session'
  | 'loading_dashboard';

export const LOGIN_UI_STEP_LABELS: Record<LoginUiStep, string> = {
  checking_account: 'Checking account...',
  verifying_password: 'Verifying password...',
  creating_secure_session: 'Creating secure session...',
  loading_dashboard: 'Loading dashboard...',
};

export const LOGIN_UI_STEP_ORDER: LoginUiStep[] = [
  'checking_account',
  'verifying_password',
  'creating_secure_session',
  'loading_dashboard',
];

const STORAGE_KEY = 'appbeg:loginUiProgress';

export type LoginUiProgressState = {
  active: boolean;
  step: LoginUiStep;
  startedAt: number;
  username: string;
  role: string | null;
  reason: string;
};

type LoginUiProgressListener = () => void;

let memoryState: LoginUiProgressState | null = null;
const listeners = new Set<LoginUiProgressListener>();

function readStoredState(): LoginUiProgressState | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as LoginUiProgressState;
    if (!parsed?.active || !parsed.step || !parsed.startedAt) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeStoredState(state: LoginUiProgressState | null) {
  if (typeof window === 'undefined') {
    return;
  }
  if (!state?.active) {
    window.sessionStorage.removeItem(STORAGE_KEY);
    memoryState = null;
  } else {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    memoryState = state;
  }
  listeners.forEach((listener) => listener());
}

export function subscribeLoginUiProgress(listener: LoginUiProgressListener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getLoginUiProgress(): LoginUiProgressState | null {
  if (memoryState?.active) {
    return memoryState;
  }
  const stored = readStoredState();
  memoryState = stored;
  return stored;
}

export function logLoginUiProgress(values: {
  step: LoginUiStep;
  startedAt: number;
  username: string;
  role?: string | null;
  reason: string;
}) {
  playerDebugLog('[LOGIN_UI_PROGRESS]', {
    step: values.step,
    startedAt: values.startedAt,
    elapsedMs: Date.now() - values.startedAt,
    username: values.username,
    role: values.role ?? null,
    reason: values.reason,
  });
}

export function startLoginUiProgress(username: string, reason = 'login_submit') {
  const startedAt = Date.now();
  const state: LoginUiProgressState = {
    active: true,
    step: 'checking_account',
    startedAt,
    username: String(username || '').trim(),
    role: null,
    reason,
  };
  writeStoredState(state);
  logLoginUiProgress({
    step: 'checking_account',
    startedAt,
    username: state.username,
    reason,
  });
  return startedAt;
}

export function setLoginUiProgressStep(
  step: LoginUiStep,
  values: {
    startedAt: number;
    username: string;
    role?: string | null;
    reason: string;
  }
) {
  const current = getLoginUiProgress();
  const next: LoginUiProgressState = {
    active: true,
    step,
    startedAt: values.startedAt,
    username: values.username,
    role: values.role ?? current?.role ?? null,
    reason: values.reason,
  };
  writeStoredState(next);
  logLoginUiProgress({
    step,
    startedAt: values.startedAt,
    username: values.username,
    role: next.role,
    reason: values.reason,
  });
}

export function completeLoginUiProgress(reason = 'dashboard_mounted') {
  const current = getLoginUiProgress();
  if (current) {
    logLoginUiProgress({
      step: current.step,
      startedAt: current.startedAt,
      username: current.username,
      role: current.role,
      reason,
    });
  }
  writeStoredState(null);
}

export function failLoginUiProgress(reason = 'login_failed') {
  const current = getLoginUiProgress();
  if (current) {
    logLoginUiProgress({
      step: current.step,
      startedAt: current.startedAt,
      username: current.username,
      role: current.role,
      reason,
    });
  }
  writeStoredState(null);
}
