# Automatic Recharge Bonus — Deployment & Pilot

## Deployment order (canonical)

1. **Migration** — apply `068_automatic_recharge_bonus_foundation.sql`  
   (`node scripts/run-sql-file.cjs migrations/068_automatic_recharge_bonus_foundation.sql`)
2. **Deploy** — ship app build with Phases 1–8; all `ARB_*` remain off
3. **Schema verify** — `DATABASE_URL=... npm run verify:arb-schema`
4. **Admin** — `ARB_ADMIN_ENABLED=1`
5. **Reporting** — `ARB_REPORTING_ENABLED=1` (ops dashboards / health)
6. **Configuration publish** — pilot coadmin publishes tiers/policy; leave `feature_enabled` false until ready
7. **Feature on (coadmin)** — `feature_enabled=true` (still no grants without env)
8. **Shadow** — `ARB_SHADOW_MODE_ENABLED=1`; soak; sample reconcile
9. **Grants** — `ARB_GRANTS_ENABLED=1` for pilot environment only
10. **Player mode** — `ARB_PLAYER_MODE_ENABLED=1`
11. **Expand** — next coadmins one at a time

## Pre-deploy gates

```bash
npm run test:arb-flags
npm run test:arb-domain
npm run test:arb-golden
npm run test:arb-eligibility
npm run test:arb-grant-plan
npm run test:arb-grant-freeze
# with DB:
DATABASE_URL=... npm run verify:arb-schema
DATABASE_URL=... npm run test:arb-authority
DATABASE_URL=... TEST_PLAYER_UID=... npm run test:arb-grant
DATABASE_URL=... TEST_PLAYER_UID=... npm run test:arb-report
```

## Success criteria (pilot)

- Shadow `would_grant` rows appear for eligible recharges with **zero** `automatic_recharge_bonus` FEs while grants off
- After grants on: FE + ledger + promo-locked balance move atomically with completion
- Duplicate completion never double-credits (unique grant evaluation + request stamp)
- Bonus Event claims blocked under Auto ON / cooldown
- No sustained ledger mismatches in reconcile samples

## Expansion criteria

- Pilot soak without P0 financial incidents
- Skip-reason distribution understood (not dominated by unexpected blockers)
- Support queue macros validated
- On-call comfortable with kill switches
