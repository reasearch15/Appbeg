-- Phase 6: Telegram operational completion attribution (claim vs complete distinguished).

ALTER TABLE public.player_cashout_tasks_cache
  ADD COLUMN IF NOT EXISTS operational_completion_source TEXT,
  ADD COLUMN IF NOT EXISTS operational_completion_telegram_user_id TEXT,
  ADD COLUMN IF NOT EXISTS operational_completion_telegram_username TEXT,
  ADD COLUMN IF NOT EXISTS operational_completion_telegram_display_name TEXT,
  ADD COLUMN IF NOT EXISTS operational_telegram_completed_at TIMESTAMPTZ;
