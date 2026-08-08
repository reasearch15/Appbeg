-- Staff Telegram Integration Codes (Phase 1).
-- Parallel to player signup codes; do not overload coadmin_player_signup_codes.

CREATE TABLE IF NOT EXISTS public.coadmin_staff_telegram_integration_codes (
  coadmin_uid TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_at TIMESTAMPTZ NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS coadmin_staff_telegram_integration_codes_code_unique
  ON public.coadmin_staff_telegram_integration_codes (upper(code));

CREATE INDEX IF NOT EXISTS coadmin_staff_telegram_integration_codes_updated_at_idx
  ON public.coadmin_staff_telegram_integration_codes (updated_at DESC);

CREATE TABLE IF NOT EXISTS public.coadmin_staff_telegram_integration_code_audit (
  id BIGSERIAL PRIMARY KEY,
  coadmin_uid TEXT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  old_code_hash TEXT NULL,
  new_code_hash TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS coadmin_staff_telegram_integration_code_audit_coadmin_changed_idx
  ON public.coadmin_staff_telegram_integration_code_audit (coadmin_uid, changed_at DESC);
