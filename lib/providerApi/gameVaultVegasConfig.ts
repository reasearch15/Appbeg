import 'server-only';

import { normalizeGameName } from '@/lib/sql/authorityGameRequestHelpers';
import { cleanText } from '@/lib/sql/playerMirrorCommon';

export type ProviderApiGameKey = 'game_vault' | 'vegas_sweeps';
export type ProviderApiExecutionMode = 'browser' | 'api' | 'shadow' | 'disabled';
export type ProviderApiTimestampUnit = 'seconds' | 'milliseconds';

export type ProviderApiConfig = {
  gameKey: ProviderApiGameKey;
  label: string;
  baseUrl: string;
  agentId: string;
  secretKey: string;
  timestampUnit: ProviderApiTimestampUnit;
  executionMode: ProviderApiExecutionMode;
  mutationsEnabled: boolean;
  orderIdIdempotencyVerified: boolean;
};

const GAME_LABELS: Record<ProviderApiGameKey, string> = {
  game_vault: 'Game Vault',
  vegas_sweeps: 'Vegas Sweeps',
};

const ENV_PREFIXES: Record<ProviderApiGameKey, string> = {
  game_vault: 'GAME_VAULT',
  vegas_sweeps: 'VEGAS_SWEEPS',
};

export function resolveProviderApiGameKey(gameName: unknown): ProviderApiGameKey | null {
  const normalized = normalizeGameName(cleanText(gameName));
  if (normalized === 'game_vault' || normalized === 'gamevault') return 'game_vault';
  if (normalized === 'vegas_sweeps' || normalized === 'vegassweeps') return 'vegas_sweeps';
  return null;
}

function readEnv(prefix: string, suffix: string) {
  return cleanText(process.env[`${prefix}_${suffix}`]);
}

function normalizeExecutionMode(value: string): ProviderApiExecutionMode {
  const normalized = value.toLowerCase();
  if (normalized === 'api' || normalized === 'shadow' || normalized === 'disabled') return normalized;
  return 'browser';
}

function normalizeTimestampUnit(value: string): ProviderApiTimestampUnit {
  return value.toLowerCase() === 'milliseconds' ? 'milliseconds' : 'seconds';
}

function isTruthyEnv(value: string) {
  return value === '1' || value.toLowerCase() === 'true' || value.toLowerCase() === 'yes';
}

export function getProviderApiConfig(gameKey: ProviderApiGameKey): ProviderApiConfig {
  const prefix = ENV_PREFIXES[gameKey];
  return {
    gameKey,
    label: GAME_LABELS[gameKey],
    baseUrl: readEnv(prefix, 'API_BASE_URL').replace(/\/+$/, ''),
    agentId: readEnv(prefix, 'API_AGENT_ID'),
    secretKey: readEnv(prefix, 'API_SECRET_KEY'),
    timestampUnit: normalizeTimestampUnit(readEnv(prefix, 'API_TIMESTAMP_UNIT')),
    executionMode: normalizeExecutionMode(readEnv(prefix, 'EXECUTION_MODE')),
    mutationsEnabled: isTruthyEnv(readEnv(prefix, 'API_MUTATIONS_ENABLED')),
    orderIdIdempotencyVerified: isTruthyEnv(readEnv(prefix, 'API_ORDER_ID_IDEMPOTENCY_VERIFIED')),
  };
}

export function assertProviderApiConfigured(config: ProviderApiConfig) {
  const missing = [
    ['baseUrl', config.baseUrl],
    ['agentId', config.agentId],
    ['secretKey', config.secretKey],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length) {
    throw new Error(`${config.label} API is not configured: missing ${missing.join(', ')}.`);
  }
}

export function providerApiMutationAllowed(config: ProviderApiConfig) {
  return (
    config.executionMode === 'api' &&
    config.mutationsEnabled &&
    config.orderIdIdempotencyVerified
  );
}
