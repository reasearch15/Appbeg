# Automatic Recharge Bonus — Known Failures & Recovery

| Scenario | Expected system behaviour | Recovery |
|---|---|---|
| Grants env off | No financial writes; optional shadow evals | Enable grants only after shadow soak |
| Shadow on, grants off | `would_grant` / skipped / blocked rows only | Normal |
| Duplicate completion | Idempotent; no second FE | None if healthy; investigate if second FE exists |
| Eval insert wins, finance fails | Whole completion txn rolls back | Carer retries completion |
| Pre-mutation ARB error | Completion continues without ARB | Check logs; fix config/flags |
| Emergency disable | Receive/enable blocked | Clear emergency when safe |
| Global kill | Platform blocks Auto ON / grants | Clear kill when safe |
| Empty / corrupt published tiers | Grants skip (`no_tier` / resolve skip) | Publish valid config; do not force enable |
| Risk bonus block | Auto + Bonus Events blocked | Wait until `bonusBlockedUntil` or clear via risk process |
| Player mode without grants | Unsafe; UI may show Auto without credits | Turn grants on or player mode off |
| Ledger ≠ FE | Reconcile error | Stop grants; manual finance review |
| Bypass of grant pipeline | Forbidden | CI `test:arb-grant-freeze`; code review |

## Configuration health failures

- Feature enabled without published version → refused by operational update  
- Overlapping draft tiers → publish blocked by validation  
- Rollback → prior version republished pointer; history retained  

## Recovery ladder

1. Flags (grants / kill / shadow)  
2. Coadmin operational switches  
3. Config rollback  
4. Reconcile + manual balance tools  
5. Code rollback (schema stays)
