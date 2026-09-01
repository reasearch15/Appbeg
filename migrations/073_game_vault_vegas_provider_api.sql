-- Game Vault / Vegas Sweeps provider API migration support.
-- This stores API correlation data without removing the existing browser-agent path.

ALTER TABLE public.player_game_logins_cache
  ADD COLUMN IF NOT EXISTS provider_key text,
  ADD COLUMN IF NOT EXISTS provider_external_player_id text,
  ADD COLUMN IF NOT EXISTS provider_account_status text,
  ADD COLUMN IF NOT EXISTS provider_metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_player_game_logins_provider_external_id
  ON public.player_game_logins_cache (provider_key, provider_external_player_id)
  WHERE deleted_at IS NULL AND provider_external_player_id IS NOT NULL;

ALTER TABLE public.player_game_requests_cache
  ADD COLUMN IF NOT EXISTS provider_key text,
  ADD COLUMN IF NOT EXISTS provider_execution_mode text,
  ADD COLUMN IF NOT EXISTS provider_order_id text,
  ADD COLUMN IF NOT EXISTS provider_transaction_id text,
  ADD COLUMN IF NOT EXISTS provider_status text,
  ADD COLUMN IF NOT EXISTS provider_error_code text,
  ADD COLUMN IF NOT EXISTS provider_error_class text,
  ADD COLUMN IF NOT EXISTS provider_metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS idx_player_game_requests_provider_order_id
  ON public.player_game_requests_cache (provider_key, provider_order_id)
  WHERE provider_order_id IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS public.provider_api_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_key text NOT NULL,
  game_name text NOT NULL,
  operation text NOT NULL,
  task_id text,
  request_id text,
  player_uid text,
  coadmin_uid text,
  provider_order_id text,
  provider_transaction_id text,
  request_amount numeric,
  status text NOT NULL DEFAULT 'created',
  error_code text,
  error_class text,
  retryable boolean NOT NULL DEFAULT false,
  money_retry_safe boolean NOT NULL DEFAULT false,
  request_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  response_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_api_transactions_order_id
  ON public.provider_api_transactions (provider_key, provider_order_id)
  WHERE provider_order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_provider_api_transactions_task
  ON public.provider_api_transactions (task_id, operation);

CREATE INDEX IF NOT EXISTS idx_provider_api_transactions_request
  ON public.provider_api_transactions (request_id, operation);
