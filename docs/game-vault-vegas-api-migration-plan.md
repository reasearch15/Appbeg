# Game Vault / Vegas Sweeps API Migration Plan

## Current Architecture

- Player recharge and redeem requests are SQL-authoritative in `lib/sql/authorityGameRequests.ts`.
- Request creation writes `player_game_requests_cache`, linked `carer_tasks_cache`, `financial_events_cache`, ledger events, live outbox rows, and schedules auto-claim.
- `app/api/carer/automation-auto-tick/route.ts` claims eligible tasks and creates `automation_jobs_cache` rows for the Python Carer Agent.
- `carer-agent/agent/job_runner.py` dispatches Game Vault and Vegas Sweeps tasks to Playwright modules.
- Game Vault and Vegas Sweeps currently share Game Vault-family browser flows for create username, reset password, recharge, and redeem.

## Browser Behavior That Must Be Preserved

- Recharge and redeem have different financial side effects in SQL; redeem credits player cash only after provider-side withdrawal is confirmed.
- Game Vault Midnight Party blocks are terminal recharge failures with refund semantics.
- Fake redeem is detected when the provider-side game balance is lower than the requested redeem amount.
- Player-in-game failures are not generic retries; recharge is dismissed/refunded, while redeem can require waiting for player exit depending on existing handling.
- Browser reset-password and create-username completion update `player_game_logins_cache` and send live player messages.
- Browser money-task completion currently rewards a human handler through `completeRechargeRedeemTaskInSql`; API completion must not accidentally award handler cashbox credit.

## Provider API Surface

The documented API uses `POST multipart/form-data` with:

- `agent_id`
- `timestamp`
- `sign = MD5(agent_id:timestamp:secret_key).ToUpperCase()`

Endpoints modeled in code:

- `/api/external/addUser`
- `/api/external/recharge`
- `/api/external/withdraw`
- `/api/external/userBalance`
- `/api/external/agentBalance`
- `/api/external/getUserID`
- `/api/external/external/getLowDepositUsers`
- `/api/external/resetPassword`
- `/api/external/playerOffline`

The `getLowDepositUsers` path contains a suspicious double `external` segment from the provided docs and must be verified live before use.

## Implementation Added

- `lib/providerApi/gameVaultVegasConfig.ts`: provider detection, feature flags, and API credential loading.
- `lib/providerApi/gameVaultVegasClient.ts`: signed multipart client with redacted responses.
- `lib/providerApi/gameVaultVegasErrors.ts`: provider code classification into existing operational concepts.
- `app/api/internal/provider-api/verify/route.ts`: secret-protected read-only live verification endpoint.
- `migrations/073_game_vault_vegas_provider_api.sql`: correlation columns and a provider transaction audit table.

## Feature Flags

Default mode remains browser automation. API money mutations require all of:

- `{GAME}_EXECUTION_MODE=api`
- `{GAME}_API_MUTATIONS_ENABLED=1`
- `{GAME}_API_ORDER_ID_IDEMPOTENCY_VERIFIED=1`

This intentionally prevents unknown-state duplicate recharge/withdraw behavior until `order_id` idempotency is proven against the live provider.

## Recommended Cutover Phases

1. Apply migration `073_game_vault_vegas_provider_api.sql`.
2. Configure credentials in server-only env vars for Game Vault and/or Vegas Sweeps.
3. Run the read-only verification route for `agentBalance`, `getUserID`, and `userBalance`.
4. Live-test `order_id` duplicate behavior in a provider sandbox or with a tiny controlled amount.
5. Add API-specific SQL completion for recharge/redeem that mirrors `completeRechargeRedeemTaskInSql` minus handler reward.
6. Wire auto-tick to divert only Game Vault/Vegas API-mode tasks before Carer Agent job creation.
7. Enable `shadow` mode for balance reads and audit-only calls.
8. Enable `api` mode for create/reset first, then recharge, then redeem.
9. Keep browser automation as fallback per game and operation until production evidence is clean.

## Open Live-Verification Items

- Whether success code is always `0`.
- Whether timestamp must be seconds or milliseconds.
- Exact field names for username, password, amount, and order id on each mutation endpoint.
- Whether recharge/withdraw `order_id` is truly idempotent and returns the original result on duplicate.
- Whether withdraw code `16` means a final manual-review state or later asynchronous completion.
- Whether `playerOffline` can replace browser polling for player-in-game redeem handling.
