/**
 * Verify Automatic Recharge Bonus Phase 1 tables exist (revised foundation).
 * Run: DATABASE_URL=... npm run verify:arb-schema
 */
const { Pool } = require('pg');

const EXPECTED_TABLES = [
  'coadmin_automatic_recharge_bonus_settings',
  'coadmin_automatic_recharge_bonus_config_versions',
  'coadmin_automatic_recharge_bonus_settings_audit',
  'automatic_recharge_bonus_evaluations',
];

async function main() {
  const databaseUrl = String(process.env.DATABASE_URL || '').trim();
  if (!databaseUrl) {
    console.error('DATABASE_URL is required.');
    process.exitCode = 1;
    return;
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const result = await pool.query(
      `
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = ANY($1::text[])
        ORDER BY table_name
      `,
      [EXPECTED_TABLES]
    );
    const present = new Set(result.rows.map((row) => row.table_name));
    const missing = EXPECTED_TABLES.filter((name) => !present.has(name));

    console.info('[ARB_SCHEMA_VERIFY]', {
      migration: 'migrations/068_automatic_recharge_bonus_foundation.sql',
      expected: EXPECTED_TABLES,
      present: [...present],
      missing,
      ok: missing.length === 0,
    });

    if (missing.length) {
      console.error(
        'Missing ARB foundation tables. Apply migrations/068_automatic_recharge_bonus_foundation.sql'
      );
      process.exitCode = 1;
      return;
    }

    // Revised shape checks
    const settingsCols = await pool.query(
      `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'coadmin_automatic_recharge_bonus_settings'
      `
    );
    const settingsColSet = new Set(settingsCols.rows.map((row) => row.column_name));
    for (const required of [
      'feature_enabled',
      'emergency_disable',
      'draft_policy',
      'draft_tiers',
      'published_version_id',
    ]) {
      if (!settingsColSet.has(required)) {
        console.error(`settings missing column: ${required}`);
        process.exitCode = 1;
        return;
      }
    }
    for (const removed of [
      'minimum_recharge',
      'maximum_recharge_considered',
      'maximum_bonus_cap',
      'cooldown_duration_minutes',
    ]) {
      if (settingsColSet.has(removed)) {
        console.error(
          `settings still has typed policy column ${removed} — re-apply revised 068 (see migration 069)`
        );
        process.exitCode = 1;
        return;
      }
    }

    const versionCols = await pool.query(
      `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'coadmin_automatic_recharge_bonus_config_versions'
          AND column_name = ANY($1::text[])
      `,
      [['version_id', 'version_number', 'status', 'policy_json', 'tiers_json']]
    );
    const versionColSet = new Set(versionCols.rows.map((row) => row.column_name));
    for (const required of [
      'version_id',
      'version_number',
      'status',
      'policy_json',
      'tiers_json',
    ]) {
      if (!versionColSet.has(required)) {
        console.error(`config_versions missing column: ${required}`);
        process.exitCode = 1;
        return;
      }
    }

    console.log('ARB Phase 1 revised schema OK');
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
