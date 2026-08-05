# PostgreSQL migrations

AppBeg uses SQL as the runtime authority when `AUTHORITY_SQL_WRITE=1` and SQL read flags are enabled. Apply pending migrations before deploying.

## Player signup-code repair (VPS / production)

If the coadmin dashboard reports that `coadmin_player_signup_codes` does not exist, deploy the current code and run this idempotent repair against the same production `DATABASE_URL`:

```bash
node scripts/run-sql-file.cjs migrations/061_repair_coadmin_player_signup_codes.sql
```

Or with `psql`:

```bash
psql "$DATABASE_URL" -f migrations/061_repair_coadmin_player_signup_codes.sql
```

Verify it on the VPS:

```bash
psql "$DATABASE_URL" -c "SELECT to_regclass('public.coadmin_player_signup_codes') AS signup_code_table;"
```

The expected value is `coadmin_player_signup_codes`. Once present, opening the coadmin dashboard creates that coadmin's first code; **Copy** reads it and **Generate New Code** replaces it while recording only hashes in the audit table.

## Required production order (034–038)

When `AUTHORITY_SQL_WRITE=1`, production startup requires **all** authority tables below. Apply migrations in this exact order on the **same `DATABASE_URL` Vercel uses**:

```bash
psql "$DATABASE_URL" -f migrations/034_authority_operations.sql
psql "$DATABASE_URL" -f migrations/035_freeplay_gifts_cache.sql
psql "$DATABASE_URL" -f migrations/036_coadmin_maintenance_cache.sql
psql "$DATABASE_URL" -f migrations/037_impersonation_logs_cache.sql
psql "$DATABASE_URL" -f migrations/038_runtime_missing_cache_tables.sql
```

PowerShell example:

```powershell
$env:DATABASE_URL = "postgresql://USER:PASSWORD@HOST:5432/DATABASE"
psql $env:DATABASE_URL -f migrations/034_authority_operations.sql
psql $env:DATABASE_URL -f migrations/035_freeplay_gifts_cache.sql
psql $env:DATABASE_URL -f migrations/036_coadmin_maintenance_cache.sql
psql $env:DATABASE_URL -f migrations/037_impersonation_logs_cache.sql
psql $env:DATABASE_URL -f migrations/038_runtime_missing_cache_tables.sql
```

| Migration | Creates / requires |
|-----------|-------------------|
| `034_authority_operations.sql` | `authority_operations` (idempotency ledger for all SQL authority writes) |
| `035_freeplay_gifts_cache.sql` | `freeplay_gifts_cache` |
| `036_coadmin_maintenance_cache.sql` | `coadmin_maintenance_cache` |
| `037_impersonation_logs_cache.sql` | `impersonation_logs_cache` |
| `038_runtime_missing_cache_tables.sql` | `bonus_events_cache`, `conversations_cache`, `user_presence_cache` |

Earlier migrations (`001`–`033`) must also be applied on a fresh database (players cache, carer tasks, balance events, etc.). See **Full migration set** below.

## Authority schema audit

With `AUTHORITY_SQL_WRITE=1`, startup checks these tables:

- `authority_operations`
- `user_balance_events`
- `financial_events_cache`
- `user_balance_snapshots_cache`
- `players_cache`
- `player_game_requests_cache`
- `carer_tasks_cache`
- `automation_jobs_cache`
- `player_cashout_tasks_cache`
- `transfer_requests_cache`
- `referral_reward_claims_cache`
- `player_coin_rewards_cache`
- `freeplay_pending_gifts_cache`
- `freeplay_gifts_cache`
- `coadmin_maintenance_cache`
- `impersonation_logs_cache`
- `bonus_events_cache`
- `conversations_cache`
- `user_presence_cache`

If any are missing in **production**, startup fails with:

`SQL authority schema incomplete. Run migrations 034-038 on this DATABASE_URL.`

Verify before deploy:

```bash
DATABASE_URL=... npm run audit:authority-schema
```

Compare `database_url_hash` in the audit output with Vercel `[AUTHORITY_SCHEMA_AUDIT]` logs to confirm the same database.

## Migration 038 — runtime cache tables

Creates the three cache tables required by live routes (fixes `42P01 relation does not exist`):

| Table | Routes |
|---|---|
| `bonus_events_cache` | `/api/bonus-events/list` |
| `conversations_cache` | `/api/chat/unread-counts` |
| `user_presence_cache` | `/api/presence/batch`, `/api/presence/heartbeat` |

All statements use `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` — safe to re-run.

Optional chat message bodies (separate from unread counts):

```bash
psql "$DATABASE_URL" -f migrations/033_chat_messages_cache.sql
```

## Backfill from Firestore

After applying migration 038, populate cache tables from existing Firestore data:

```bash
node scripts/backfill-bonus-events-cache.cjs --only-missing
node scripts/backfill-user-presence-cache.cjs --only-missing
node scripts/backfill-conversations-cache.cjs --only-missing --include-messages
```

Or run all backfills:

```bash
npm run backfill:cache-tables
```

Flags: `--dry-run`, `--only-missing`, `--limit=N`

## Full migration set

If bootstrapping a fresh database, apply all files in `migrations/` in numeric order (`001` through latest).

## Migration 068 — Automatic Recharge Bonus foundation (Phase 1, revised)

Additive schema only. **No runtime behavior** until later roadmap phases enable ARB flags.

```bash
psql "$DATABASE_URL" -f migrations/068_automatic_recharge_bonus_foundation.sql
```

Or:

```bash
node scripts/run-sql-file.cjs migrations/068_automatic_recharge_bonus_foundation.sql
```

| Table | Purpose |
|---|---|
| `coadmin_automatic_recharge_bonus_settings` | Operational switches + draft JSON (single policy source) + published pointer |
| `coadmin_automatic_recharge_bonus_config_versions` | Immutable snapshots (`version_id` UUID + `version_number` + `status`) |
| `coadmin_automatic_recharge_bonus_settings_audit` | Append-only config/ops audit |
| `automatic_recharge_bonus_evaluations` | Reserved for Shadow Mode / later grants (no writers in Phase 1) |

**Policy:** business knobs (`minimumRecharge`, caps, cooldown) live only in `draft_policy` / `policy_json` — not duplicated as typed columns. Typed columns are operational (`feature_enabled`, `emergency_disable`, `player_opt_in_allowed`, publish pointer).

If a **provisional** 068 was already applied, reset then recreate (only before Phase 2 data exists):

```bash
node scripts/run-sql-file.cjs migrations/069_automatic_recharge_bonus_phase1_revise.sql
node scripts/run-sql-file.cjs migrations/068_automatic_recharge_bonus_foundation.sql
```

These tables are **not** part of `REQUIRED_AUTHORITY_SQL_TABLES` yet. Apply 068 before enabling any `ARB_*` runtime flags.

### ARB platform flags (opt-in; fail closed / default OFF)

| Env | Default | Meaning |
|---|---|---|
| `ARB_ADMIN_ENABLED` | off | Coadmin config APIs/UI |
| `ARB_GRANTS_ENABLED` | off | Coin grants on recharge complete |
| `ARB_PLAYER_MODE_ENABLED` | off | Player toggle + Bonus Event lock |
| `ARB_REPORTING_ENABLED` | off | Stats/history UIs |
| `ARB_GLOBAL_KILL` | off | Emergency: block grants / new Auto ON |
| `ARB_SHADOW_MODE_ENABLED` | off | Evaluate/audit without crediting (later phase) |

`ARB_SCHEMA_READY` was **removed**. Soft “schema ready” defaults are unsafe; prove DDL with `verify:arb-schema` before enabling flags.

Never enable `ARB_PLAYER_MODE_ENABLED` in production without `ARB_GRANTS_ENABLED`.

Verify flags:

```bash
npm run test:arb-flags
npm run test:arb-domain
npm run test:arb-golden
npm run test:arb-preference
```

Optional DB presence check (requires `DATABASE_URL`):

```bash
DATABASE_URL=... npm run verify:arb-schema
```

Phase 3 coadmin admin SQL authority integration (requires `DATABASE_URL` + migration 068):

```bash
DATABASE_URL=... npm run test:arb-authority
```

Phase 4 player preference authority integration (requires `DATABASE_URL`, `TEST_PLAYER_UID`, migration 068):

```bash
ARB_PLAYER_MODE_ENABLED=1 DATABASE_URL=... TEST_PLAYER_UID=... npm run test:arb-preference-authority
```

Enable coadmin ARB admin UI/APIs with `ARB_ADMIN_ENABLED=1` (still does not grant coins or change player runtime).

Player preference API (`POST/GET /api/player/automatic-recharge-bonus`) requires `ARB_PLAYER_MODE_ENABLED=1`. Preferences persist on `players_cache.raw_firestore_data` (`automaticBonusEnabled`, `bonusCooldownEndsAt`). This does **not** grant coins (Phase 6).

Phase 5 Bonus Event mutual exclusion uses `evaluateArbEligibility` / `assertArbCanClaimBonusEvent` inside `initiateBonusPlayInSql` and the Firestore initiate-play fallback. Claims are blocked while Auto is ON or cooldown is active (and when risk-blocked). Session extras expose `canClaimBonusEvent`.

```bash
npm run test:arb-eligibility
npm run test:arb-grant-plan
npm run test:arb-grant-freeze
```

**Frozen grant pipeline:** the only supported ARB financial write path is
`planArbRechargeCompletionGrant` → `applyArbOnRechargeCompleteInTxn`
(`lib/economy/automaticRechargeBonus/grantPipeline.ts`). Future features must not bypass it.

Phase 6 request reconciliation:

```bash
DATABASE_URL=... npm run reconcile:arb-request -- <requestId>
```

Phase 8 reporting (read-only; requires `ARB_REPORTING_ENABLED=1`):

```bash
DATABASE_URL=... TEST_PLAYER_UID=... npm run test:arb-report
```

Coadmin ARB UI **Reporting** tab: dashboard KPIs, grants/evaluations/shadow histories, ops audit, request reconciliation, admin player inspect, **System Health**. Player history adds an **Auto Bonus** tab. No financial behaviour changes.

### Phase 9 — Production rollout & documentation

Operational only. Canonical runbook:

- [`docs/automatic-recharge-bonus/README.md`](./automatic-recharge-bonus/README.md)

Includes deployment order, flag/kill-switch guide, monitoring alerts, playbooks, support guide, and System Health (`GET /api/coadmin/automatic-recharge-bonus/health`).

**No business-logic changes** in Phase 9 (eligibility, resolver, grants, ledger untouched).

## Verify deployment

```bash
DATABASE_URL=... npm run audit:authority-schema
DATABASE_URL=... npm run audit:sql-schema
npm run audit:firestore
npx tsc --noEmit
```

Expected:

- `[AUTHORITY_SCHEMA_AUDIT] missing_tables=[] all_required_tables_present=true`
- Firestore audit: `routes_still_ungated_writes: 0`

There is no Firestore fallback when SQL authority mode is enabled.
