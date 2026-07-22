import 'server-only';

function envFlag(name: string) {
  return process.env[name] === '1';
}

function envTruthy(name: string) {
  const value = String(process.env[name] || '')
    .trim()
    .toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

export function isLoadTestMode() {
  return envFlag('LOAD_TEST_MODE');
}

export function logLevel() {
  const value = String(process.env.LOG_LEVEL || 'info').toLowerCase();
  if (value === 'debug' || value === 'info' || value === 'warn' || value === 'error') {
    return value;
  }
  return 'info';
}

export function isDebugLogLevel() {
  return logLevel() === 'debug';
}

export function isVerboseAllowed(flagName: string) {
  if (isLoadTestMode()) {
    return false;
  }
  return isDebugLogLevel() || envFlag(flagName);
}

/** Central production-safe debug flag for noisy diagnostic polling logs. */
export function isAppDebugLoggingEnabled() {
  if (isLoadTestMode()) {
    return false;
  }
  return isDebugLogLevel() || envTruthy('APP_DEBUG_LOGS');
}

export function debugLog(message: string, details?: Record<string, unknown>) {
  if (!isAppDebugLoggingEnabled()) {
    return;
  }
  if (details === undefined) {
    console.info(message);
    return;
  }
  console.info(message, details);
}

export function isSqlAuthVerboseLogs() {
  return isVerboseAllowed('SQL_AUTH_VERBOSE_LOGS');
}

export function isSqlCacheVerboseLogs() {
  return isVerboseAllowed('SQL_CACHE_VERBOSE_LOGS');
}

export function isLiveVerboseLogs() {
  return isVerboseAllowed('LIVE_VERBOSE_LOGS');
}

export function isPlayerVerboseLogs() {
  return isVerboseAllowed('PLAYER_VERBOSE_LOGS');
}

export function isChatVerboseLogs() {
  return isVerboseAllowed('CHAT_VERBOSE_LOGS');
}

export function isBonusVerboseLogs() {
  return isVerboseAllowed('BONUS_VERBOSE_LOGS');
}

export function isPresenceVerboseLogs() {
  return isVerboseAllowed('PRESENCE_VERBOSE_LOGS');
}

export function resolveLogThresholdMs(name: string, fallback: number) {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.trunc(parsed);
}

export const AUTH_SLOW_MS = resolveLogThresholdMs('AUTH_SLOW_MS', 500);
export const SQL_QUERY_SLOW_MS = resolveLogThresholdMs('SQL_QUERY_SLOW_MS', 500);
export const API_ROUTE_SLOW_MS = resolveLogThresholdMs('API_ROUTE_SLOW_MS', 1_000);
export const POOL_ACQUIRE_SLOW_MS = resolveLogThresholdMs('POOL_ACQUIRE_SLOW_MS', 250);
export const SNAPSHOT_SLOW_MS = resolveLogThresholdMs('SNAPSHOT_SLOW_MS', 1_000);
