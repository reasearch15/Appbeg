# Automatic Recharge Bonus — Operational Playbooks

## P0 — Suspected double grant

1. Kill grants: `ARB_GRANTS_ENABLED=0`
2. Collect `request_id`(s) from player complaint or FE list
3. Reporting → Reconcile (or CLI) for each id
4. If duplicate FE/ledger confirmed: freeze further grants; open clawback ticket (manual)
5. Preserve evaluation + FE rows for audit — do not delete
6. Root-cause: concurrency, stamp missing, or bypass of freeze pipeline (run `test:arb-grant-freeze`)

## P1 — Grants stopped unexpectedly

1. System Health: check `ARB_GRANTS_ENABLED`, global kill, coadmin emergency/feature
2. Check last operational audit / publish
3. Check `[ARB_GRANT_APPLY_FAILED]` logs
4. Restore only after config + flag state understood

## P1 — Shadow shows would_grant but no real grants after enable

1. Confirm `ARB_GRANTS_ENABLED=1`
2. Confirm player Auto ON at completion time
3. Confirm published version + tier covers amount (`base_amount`)
4. Inspect evaluation `skip_reason` / `evaluation_result`
5. Admin inspect panel for the player (read-only)

## P2 — Bonus Events blocked for players who think Auto is off

1. Check mode: enabled vs **cooldown** (Bonus Events stay locked during cooldown)
2. Check `bonusCooldownEndsAt`
3. Risk `bonusBlockedUntil`
4. Explain mutual exclusivity from Support guide

## P2 — Config publish / rollback mistake

1. Rollback to prior published version via admin Versions tab
2. Audit confirms `config_rolled_back`
3. If bad grants already issued under wrong tiers: stop grants; reconcile; manual clawback policy

## Recovery principles

- Prefer flag kill over schema changes
- Prefer config rollback over editing published JSON in place (published rows are immutable)
- Never invent a second grant writer
- Always reconcile before adjusting balances
