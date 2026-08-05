-- Repair Automatic Recharge Bonus Phase 1 foundation after the provisional schema.
--
-- Use ONLY if an earlier 068 was already applied (typed policy columns, no
-- version_number/status, no evaluations table) and Phase 2 has not written data.
--
-- Steps:
--   1) node scripts/run-sql-file.cjs migrations/069_automatic_recharge_bonus_phase1_revise.sql
--   2) node scripts/run-sql-file.cjs migrations/068_automatic_recharge_bonus_foundation.sql
--
-- DO NOT run step 1 after real publishes, audits, or evaluations exist in production.

DROP TABLE IF EXISTS public.automatic_recharge_bonus_evaluations CASCADE;
DROP TABLE IF EXISTS public.coadmin_automatic_recharge_bonus_settings_audit CASCADE;
DROP TABLE IF EXISTS public.coadmin_automatic_recharge_bonus_config_versions CASCADE;
DROP TABLE IF EXISTS public.coadmin_automatic_recharge_bonus_settings CASCADE;
