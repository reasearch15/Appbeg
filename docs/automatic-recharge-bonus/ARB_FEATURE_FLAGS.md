# Automatic Recharge Bonus — Feature Flags & Kill Switch

Fail-closed: a flag is ON only when the env var is exactly `1`.

## Matrix

| Flag | Controls | Production note |
|---|---|---|
| `ARB_ADMIN_ENABLED` | Config draft/publish/ops APIs + admin UI shell | Enable first for setup |
| `ARB_REPORTING_ENABLED` | Stats, histories, reconcile UI, System Health | Enable for ops visibility |
| `ARB_SHADOW_MODE_ENABLED` | Evaluation rows without financial writes | Required before first grants |
| `ARB_GRANTS_ENABLED` | Real promo-locked coin grants on recharge complete | Highest risk |
| `ARB_PLAYER_MODE_ENABLED` | Player toggle API + Bonus Event mutual exclusion | Only after grants ready |
| `ARB_GLOBAL_KILL` | Blocks new Auto ON and grant eligibility | Emergency platform stop |

Unsafe combo: `ARB_PLAYER_MODE_ENABLED=1` with `ARB_GRANTS_ENABLED=0` in production  
(`unsafe_player_mode_without_grants` in flag status).

## Coadmin operational switches (DB)

| Field | Effect |
|---|---|
| `feature_enabled` | Feature operable for that coadmin |
| `emergency_disable` | Blocks enable/receive (fail closed) |
| `player_opt_in_allowed` | When false, players cannot turn Auto ON |
| `published_version_id` | Pointer to immutable published config |

## Kill-switch quick card

| Severity | Action |
|---|---|
| Stop money now | `ARB_GRANTS_ENABLED=0` |
| Stop one coadmin | Emergency disable ON |
| Stop platform Auto | `ARB_GLOBAL_KILL=1` |
| Hide player toggle | `ARB_PLAYER_MODE_ENABLED=0` |
| Stop shadow noise | `ARB_SHADOW_MODE_ENABLED=0` |

Confirm with System Health panel after each change.
