-- Cashout vendor attribution: persist authoritative vendor snapshot on tasks
-- and financial events so staff display and Ledger Total Out do not depend on
-- ephemeral live enrich alone.

ALTER TABLE public.player_cashout_tasks_cache
  ADD COLUMN IF NOT EXISTS vendor_id BIGINT NULL,
  ADD COLUMN IF NOT EXISTS vendor_code TEXT NULL,
  ADD COLUMN IF NOT EXISTS vendor_name TEXT NULL,
  ADD COLUMN IF NOT EXISTS vendor_status TEXT NULL,
  ADD COLUMN IF NOT EXISTS vendor_linked_staff_uid TEXT NULL,
  ADD COLUMN IF NOT EXISTS vendor_ownership_date TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS vendor_resolved_at TIMESTAMPTZ NULL;

ALTER TABLE public.financial_events_cache
  ADD COLUMN IF NOT EXISTS vendor_id BIGINT NULL,
  ADD COLUMN IF NOT EXISTS vendor_code TEXT NULL,
  ADD COLUMN IF NOT EXISTS vendor_name TEXT NULL;

CREATE INDEX IF NOT EXISTS player_cashout_tasks_cache_vendor_id_idx
  ON public.player_cashout_tasks_cache (vendor_id)
  WHERE deleted_at IS NULL AND vendor_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS player_cashout_tasks_cache_vendor_code_idx
  ON public.player_cashout_tasks_cache (vendor_code)
  WHERE deleted_at IS NULL AND vendor_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS financial_events_cache_vendor_id_idx
  ON public.financial_events_cache (vendor_id)
  WHERE deleted_at IS NULL AND vendor_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS financial_events_cache_vendor_code_idx
  ON public.financial_events_cache (vendor_code)
  WHERE deleted_at IS NULL AND vendor_code IS NOT NULL;
