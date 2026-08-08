-- Phase 5: Telegram operational claim attribution for player cash-outs.
-- Append-only audit + current snapshot columns on the task cache.
-- AppBeg remains SoT for cash-out status; Telegram user is operational only.

CREATE TABLE IF NOT EXISTS public.cashout_operational_events (
  id BIGSERIAL PRIMARY KEY,
  cashout_task_id TEXT NOT NULL,
  coadmin_uid TEXT NOT NULL,
  event_type TEXT NOT NULL,
  action_source TEXT NOT NULL DEFAULT 'telegram',
  telegram_user_id TEXT,
  telegram_username TEXT,
  telegram_display_name TEXT,
  actor_appbeg_uid TEXT,
  idempotency_key TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS cashout_operational_events_idempotency_unique
  ON public.cashout_operational_events (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS cashout_operational_events_task_occurred_idx
  ON public.cashout_operational_events (cashout_task_id, occurred_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS cashout_operational_events_coadmin_occurred_idx
  ON public.cashout_operational_events (coadmin_uid, occurred_at DESC);

ALTER TABLE public.player_cashout_tasks_cache
  ADD COLUMN IF NOT EXISTS operational_action_source TEXT,
  ADD COLUMN IF NOT EXISTS operational_telegram_user_id TEXT,
  ADD COLUMN IF NOT EXISTS operational_telegram_username TEXT,
  ADD COLUMN IF NOT EXISTS operational_telegram_display_name TEXT,
  ADD COLUMN IF NOT EXISTS operational_telegram_claimed_at TIMESTAMPTZ;
