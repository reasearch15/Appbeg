# Automatic Recharge Bonus — Monitoring & Alerts

Read-only observability. Prefer Reporting dashboard + System Health + SQL samples below.

## Signals to watch

| Signal | Where | Concern |
|---|---|---|
| Grant rate | Reporting dashboard / evaluations `granted` | Spike vs recharge volume |
| Skip rate | Skip reason distribution | Sudden surge of one reason |
| Duplicate grants | Reconcile + unique index errors in logs | Second FE for same `request_id` |
| Ledger mismatches | Reconcile UI / `reconcile:arb-request` | FE vs ledger vs eval amount |
| Evaluation failures | Logs `[ARB_GRANT_APPLY_FAILED]`; blocked/skipped spikes | Plumbing or gate issues |
| Configuration changes | Settings audit / ops-audit | Unexpected publish/rollback |
| Emergency disables | Operational audit + health | Confirm intentional |
| Rollback events | Audit action `config_rolled_back` | Confirm intentional |

## Suggested alert definitions

Thresholds are starting points — tune per traffic.

1. **Grant rate spike** — grants / completed recharges in 15m > 3× 7d baseline for a coadmin  
2. **Skip burst** — single `skip_reason` > 50% of evaluations in 15m with volume > N  
3. **Duplicate grant attempt** — log/metric on unique index `arb_evaluations_grant_request_uidx` or reconcile `multiple_financial_events`  
4. **Ledger mismatch** — any reconcile `ok=false` with error severity in sampled requests  
5. **Eval apply errors** — `[ARB_GRANT_APPLY_FAILED]` count > 0 sustained 5m  
6. **Emergency disable flipped** — audit `operational_updated` with `emergencyDisable` true outside change window  
7. **Unsafe flags** — `player_mode_enabled && !grants_enabled` in production  

## Sample SQL (ops)

```sql
-- Grants last 24h by coadmin
SELECT coadmin_uid, COUNT(*) AS grants, SUM(bonus_calculated) AS coins
FROM automatic_recharge_bonus_evaluations
WHERE mode = 'grant' AND evaluation_result = 'granted'
  AND evaluated_at > now() - interval '24 hours'
GROUP BY 1;

-- Skip reasons last 24h
SELECT skip_reason, COUNT(*)
FROM automatic_recharge_bonus_evaluations
WHERE evaluation_result IN ('skipped','blocked')
  AND evaluated_at > now() - interval '24 hours'
GROUP BY 1 ORDER BY 2 DESC;

-- FEs without matching granted eval (should be 0)
SELECT fe.firebase_id, fe.request_id, fe.amount_npr
FROM financial_events_cache fe
LEFT JOIN automatic_recharge_bonus_evaluations e
  ON e.request_id = fe.request_id
 AND e.mode = 'grant' AND e.evaluation_result = 'granted'
WHERE fe.type = 'automatic_recharge_bonus' AND fe.deleted_at IS NULL
  AND e.evaluation_id IS NULL
LIMIT 50;
```

## CLI

```bash
DATABASE_URL=... npm run reconcile:arb-request -- <requestId>
npm run test:arb-grant-freeze
```
