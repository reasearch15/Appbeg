import 'server-only';

/**
 * Automatic Recharge Bonus platform flags (Phase 1).
 *
 * Fail closed: every runtime capability is OFF unless explicitly set to "1".
 * Do NOT use resolveServerSqlFlag() — that helper defaults ON in production when unset.
 *
 * ARB_SCHEMA_READY was removed: a soft “ready” flag can lie. Table access is gated by
 * the opt-in flags below; apply migration 068 before enabling any of them. Use
 * `npm run verify:arb-schema` (or assertArbFoundationTables in later phases) to prove DDL.
 *
 * Phase 1 ships flag readers only. No callers in recharge/bonus/balance paths yet.
 */

function envRaw(name: string) {
  return String(process.env[name] || '').trim();
}

/** True only when the env var is explicitly set to "1". */
export function isArbFlagExplicitlyEnabled(name: string) {
  return envRaw(name) === '1';
}

/** Coadmin config APIs/UI. Default OFF. */
export function isArbAdminEnabled() {
  return isArbFlagExplicitlyEnabled('ARB_ADMIN_ENABLED');
}

/**
 * Recharge-completion coin grants. Default OFF.
 * Must stay off until the financial grant phase is verified.
 */
export function isArbGrantsEnabled() {
  return isArbFlagExplicitlyEnabled('ARB_GRANTS_ENABLED');
}

/**
 * Player toggle + Bonus Event mutual-exclusion. Default OFF.
 * Never enable in production without grants also enabled.
 */
export function isArbPlayerModeEnabled() {
  return isArbFlagExplicitlyEnabled('ARB_PLAYER_MODE_ENABLED');
}

/** Reporting / history UIs. Default OFF. */
export function isArbReportingEnabled() {
  return isArbFlagExplicitlyEnabled('ARB_REPORTING_ENABLED');
}

/**
 * Emergency kill: when true, later phases must refuse new Auto ON and grants.
 * Default OFF (kill inactive).
 */
export function isArbGlobalKillActive() {
  return isArbFlagExplicitlyEnabled('ARB_GLOBAL_KILL');
}

/**
 * Shadow Mode (financial phase): resolve/evaluate/audit what WOULD be granted
 * without mutating balances or writing financial events.
 * Default OFF. Independent of ARB_GRANTS_ENABLED.
 */
export function isArbShadowModeEnabled() {
  return isArbFlagExplicitlyEnabled('ARB_SHADOW_MODE_ENABLED');
}

export type AutomaticRechargeBonusFlagStatus = {
  admin_enabled: boolean;
  grants_enabled: boolean;
  player_mode_enabled: boolean;
  reporting_enabled: boolean;
  global_kill_active: boolean;
  shadow_mode_enabled: boolean;
  /** True when player mode is on without grants — unsafe for production. */
  unsafe_player_mode_without_grants: boolean;
};

export function getAutomaticRechargeBonusFlagStatus(): AutomaticRechargeBonusFlagStatus {
  const admin_enabled = isArbAdminEnabled();
  const grants_enabled = isArbGrantsEnabled();
  const player_mode_enabled = isArbPlayerModeEnabled();
  const reporting_enabled = isArbReportingEnabled();
  const global_kill_active = isArbGlobalKillActive();
  const shadow_mode_enabled = isArbShadowModeEnabled();

  return {
    admin_enabled,
    grants_enabled,
    player_mode_enabled,
    reporting_enabled,
    global_kill_active,
    shadow_mode_enabled,
    unsafe_player_mode_without_grants: player_mode_enabled && !grants_enabled,
  };
}

export function logAutomaticRechargeBonusFlags(context = 'runtime') {
  console.info('[ARB_FLAGS]', {
    context,
    ...getAutomaticRechargeBonusFlagStatus(),
  });
}

/** SQL table names created by migrations/068_automatic_recharge_bonus_foundation.sql */
export const ARB_SQL_TABLES = [
  'coadmin_automatic_recharge_bonus_settings',
  'coadmin_automatic_recharge_bonus_config_versions',
  'coadmin_automatic_recharge_bonus_settings_audit',
  'automatic_recharge_bonus_evaluations',
] as const;

export type ArbSqlTable = (typeof ARB_SQL_TABLES)[number];
