# Automatic Recharge Bonus — Production Operations Runbook

**Phase 9.** Operational documentation only.  
Does **not** change eligibility, resolver, grant pipeline, player balances, financial events, ledger, or reporting calculations.

---

## 1. Feature summary

Players may enable **Automatic Recharge Bonus** (Auto). While Auto is ON (or during cooldown after turning OFF), **Bonus Event claims are blocked**. Eligible completed recharges may receive **promo-locked** bonus coins from the coadmin’s **published** tier configuration.

Financial writes occur **only** via:

`planArbRechargeCompletionGrant` → `applyArbOnRechargeCompleteInTxn`  
(see `lib/economy/automaticRechargeBonus/grantPipeline.ts`)

---

## 2. Exact rollout order

```
1. Migration 068 (foundation tables)
2. Deploy application build (all phases 1–8 code)
3. Verify schema + flags default OFF
4. Enable ARB_ADMIN_ENABLED (+ optionally ARB_REPORTING_ENABLED)
5. Coadmin: draft → validate → publish configuration
6. Coadmin: feature_enabled = true (still no player grants without flags)
7. Pilot coadmin scope only
8. Enable ARB_SHADOW_MODE_ENABLED — verify evaluations with no balance changes
9. Enable ARB_GRANTS_ENABLED for pilot
10. Enable ARB_PLAYER_MODE_ENABLED (never without grants in production)
11. Expand to additional coadmins
12. Continuous monitoring + health panel
```

Never reverse steps 9 and 10 in production (player UI before grants).

---

## 3. Feature flag guide

| Env var | Default | Safe meaning |
|---|---|---|
| `ARB_ADMIN_ENABLED` | off | Coadmin config APIs/UI |
| `ARB_REPORTING_ENABLED` | off | Reporting, reconcile UI, health |
| `ARB_SHADOW_MODE_ENABLED` | off | Evaluate/audit without crediting |
| `ARB_GRANTS_ENABLED` | off | Real coin + promo-locked grants |
| `ARB_PLAYER_MODE_ENABLED` | off | Player toggle + Bonus Event lock |
| `ARB_GLOBAL_KILL` | off | Emergency: block new Auto ON + grants |

Rules:

- All flags fail **closed** (`=== "1"` only).
- Never enable `ARB_PLAYER_MODE_ENABLED` in production without `ARB_GRANTS_ENABLED`.
- Shadow may run with grants off; grants imply the same planner path as shadow.
- Coadmin `emergency_disable` / `feature_enabled` are **per-coadmin** operational switches (DB), not env flags.

Verify:

```bash
npm run test:arb-flags
DATABASE_URL=... npm run verify:arb-schema
```

---

## 4. Kill-switch procedures

### Immediate stop of new grants (platform)

1. Set `ARB_GRANTS_ENABLED=0` and redeploy/restart as required by your host.
2. Optionally set `ARB_SHADOW_MODE_ENABLED=0` to stop evaluation writes.
3. Optionally set `ARB_GLOBAL_KILL=1` to also refuse new Auto ON.

### Per-coadmin stop

1. Coadmin ARB → Operational → **Emergency disable** ON, and/or **Feature enabled** OFF.
2. Confirm via System Health / Reporting dashboard.

### Stop player-facing toggle

1. Set `ARB_PLAYER_MODE_ENABLED=0`.
2. Existing Auto ON preferences remain in DB but APIs reject toggles; grant path still respects eligibility gates.

### Order of preference under incident

1. `ARB_GRANTS_ENABLED=0` (stops money movement)  
2. Coadmin emergency disable (scoped)  
3. `ARB_GLOBAL_KILL=1` (hard platform gate)  
4. `ARB_PLAYER_MODE_ENABLED=0` (hide/reject toggle)

---

## 5. Rollback procedures

### Flag rollback (preferred)

Turn off grants → shadow → player mode → reporting → admin as needed. No data migration reverse required.

### Code rollback

Revert deploy to previous build. Schema 068 is additive and may remain. Do **not** drop evaluation/audit tables if any production grants exist.

### Config rollback

Use coadmin **Versions → Rollback** to a prior published version (immutable history preserved).

### Financial clawback

**Manual only.** There is no automated clawback. Use existing balance adjustment / support tools with dual control. Reconcile request IDs first (`reconcile:arb-request` or Reporting → Reconcile).

---

## 6. Deployment checklist

- [ ] `migrations/068_automatic_recharge_bonus_foundation.sql` applied
- [ ] `npm run verify:arb-schema` OK
- [ ] All `ARB_*` unset or `0` at first boot after deploy
- [ ] `npx tsc --noEmit` / CI green
- [ ] `npm run test:arb-grant-freeze` green (sole financial writer)
- [ ] Coadmin can open ARB admin when `ARB_ADMIN_ENABLED=1`
- [ ] Reporting/Health when `ARB_REPORTING_ENABLED=1`
- [ ] Pilot publish has non-empty valid tiers + policy
- [ ] Shadow soak completed before grants
- [ ] On-call briefed on kill switches

---

## 7. Pilot rollout checklist

- [ ] Single pilot coadmin selected
- [ ] Published config reviewed by a second person
- [ ] Shadow ON for ≥ agreed soak window (e.g. 24–72h)
- [ ] Sample reconciliations on completed recharges (eligible + skip cases)
- [ ] No ledger mismatches / duplicate FEs
- [ ] Grants ON for pilot only
- [ ] Player mode ON after grants verified
- [ ] Support macros ready (see Support doc)
- [ ] Expansion plan for next coadmins documented

---

## 8. Production verification checklist

After enabling grants for a coadmin:

- [ ] System Health shows expected flags + published version
- [ ] Eligible recharge → FE `automatic_recharge_bonus` + ledger coin + promoLocked
- [ ] Ineligible (below min / Auto OFF / cooldown / emergency / risk) → no FE
- [ ] Duplicate completion → no second grant
- [ ] Shadow-only environment → evaluations without balance change
- [ ] Bonus Event claim blocked while Auto ON / cooldown
- [ ] Reporting dashboard KPIs move for the pilot window
- [ ] Grant freeze test still passes in CI

---

## 9. Configuration validation checklist

Before Feature Enabled / Publish:

- [ ] Tiers non-overlapping, sorted, active tiers cover intended amounts
- [ ] `minimumRecharge` matches product (≥ 10 unless explicitly changed)
- [ ] Cooldown minutes intentional
- [ ] Caps (max considered / max bonus) understood
- [ ] Preview table samples match expected bonuses
- [ ] No empty published config while feature enabled
- [ ] Audit entry created on publish / operational change

---

## Related docs

- [Feature flags & kill switch](./ARB_FEATURE_FLAGS.md)
- [Monitoring & alerts](./ARB_MONITORING.md)
- [Operational playbooks](./ARB_PLAYBOOKS.md)
- [Support guide](./ARB_SUPPORT.md)
- [System health](./ARB_SYSTEM_HEALTH.md)
- [Deployment & pilot](./ARB_DEPLOYMENT.md)
