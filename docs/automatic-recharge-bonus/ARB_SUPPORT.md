# Automatic Recharge Bonus — Support Guide

## Player-facing facts

- Auto ON awards promo-locked bonus coins on **eligible completed recharges** (not at create time).
- While Auto ON **or during cooldown**, Bonus Event claims are unavailable.
- Turning Auto OFF starts a cooldown; turning ON again cancels cooldown.
- Bonus stacks with first-recharge deposit boost (separate mechanics).

## Common tickets

| Symptom | Likely cause | Agent action |
|---|---|---|
| “No bonus on recharge” | Below min / Auto OFF / cooldown / no tier / feature off / grants off | Check mode + amount + coadmin feature; do not promise grant |
| “Can’t claim Bonus Event” | Auto ON or cooldown or risk block | Explain lock; show cooldown end if present |
| “Bonus disappeared” | Promo-locked (usable for recharge, not free transfer) | Explain promo-locked |
| “Double bonus” | Rare / bug | Escalate P0; collect request id; do not adjust unilaterally |

## What support must not do

- Manually insert `automatic_recharge_bonus` financial events
- Edit published config JSON in the database
- Clear evaluations to “retry” a grant
- Enable player mode without grants in production

## Escalation data to collect

- Player UID, coadmin UID  
- Recharge `request_id`  
- Approx time + amount  
- Screenshot of Auto mode if available  
- Whether Bonus Event or Auto complaint  

Ops then uses Reporting → Reconcile / Admin inspect / System Health.
