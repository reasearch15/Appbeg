-- Automatic Recharge Bonus — Phase 1 foundation (revised before Phase 2)
-- Additive / idempotent. No runtime callers yet.
--
-- Design revisions vs first draft:
--   - Business policy lives ONLY in draft_policy / policy_json (no typed policy columns)
--   - Typed columns are operational state only (feature switches + publish pointer)
--   - Immutable versions keep UUID PK + human version_number per coadmin
--   - Version status: published | superseded | archived
--   - evaluations table reserved for Shadow Mode / future grants (no logic yet)
--
-- Player prefs (automaticBonusEnabled / bonusCooldownEndsAt) stay on
-- players_cache.raw_firestore_data in a later phase.

CREATE TABLE IF NOT EXISTS public.coadmin_automatic_recharge_bonus_settings (
  coadmin_uid TEXT PRIMARY KEY,

  -- Operational switches (live; may change without republishing tiers)
  feature_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  emergency_disable BOOLEAN NOT NULL DEFAULT FALSE,
  player_opt_in_allowed BOOLEAN NOT NULL DEFAULT TRUE,

  -- Single authoritative editable business policy + tiers (no typed policy duplicates)
  -- draft_policy shape:
  --   {
  --     minimumRecharge, maximumRechargeConsidered, maximumBonusCap,
  --     cooldownDurationMinutes
  --   }
  draft_policy JSONB NOT NULL DEFAULT jsonb_build_object(
    'minimumRecharge', 10,
    'maximumRechargeConsidered', NULL,
    'maximumBonusCap', NULL,
    'cooldownDurationMinutes', 120
  ),
  draft_tiers JSONB NOT NULL DEFAULT '[]'::jsonb,

  published_version_id TEXT NULL,
  published_at TIMESTAMPTZ NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source TEXT NOT NULL DEFAULT 'appbeg',
  deleted_at TIMESTAMPTZ NULL,
  raw_json JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT coadmin_arb_settings_draft_tiers_is_array
    CHECK (jsonb_typeof(draft_tiers) = 'array'),
  CONSTRAINT coadmin_arb_settings_draft_policy_is_object
    CHECK (jsonb_typeof(draft_policy) = 'object')
);

CREATE INDEX IF NOT EXISTS coadmin_arb_settings_published_version_idx
  ON public.coadmin_automatic_recharge_bonus_settings (published_version_id)
  WHERE published_version_id IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS public.coadmin_automatic_recharge_bonus_config_versions (
  version_id TEXT PRIMARY KEY,

  coadmin_uid TEXT NOT NULL,
  -- Human-readable per-coadmin sequence (Version 1, Version 2, …). App assigns MAX+1 on publish.
  version_number INTEGER NOT NULL,

  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_by_uid TEXT NULL,
  published_by_role TEXT NULL,

  -- published = was made live; superseded = replaced by a newer publish;
  -- archived = hidden from normal UI but retained for history.
  -- "Current" is defined by settings.published_version_id, not by status alone.
  status TEXT NOT NULL DEFAULT 'published',

  policy_json JSONB NOT NULL,
  tiers_json JSONB NOT NULL,

  supersedes_version_id TEXT NULL,

  source TEXT NOT NULL DEFAULT 'appbeg',
  raw_json JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT coadmin_arb_config_versions_version_number_positive
    CHECK (version_number >= 1),
  CONSTRAINT coadmin_arb_config_versions_status_valid
    CHECK (status IN ('published', 'superseded', 'archived')),
  CONSTRAINT coadmin_arb_config_versions_policy_is_object
    CHECK (jsonb_typeof(policy_json) = 'object'),
  CONSTRAINT coadmin_arb_config_versions_tiers_is_array
    CHECK (jsonb_typeof(tiers_json) = 'array')
);

CREATE UNIQUE INDEX IF NOT EXISTS coadmin_arb_config_versions_coadmin_number_uidx
  ON public.coadmin_automatic_recharge_bonus_config_versions (coadmin_uid, version_number);

CREATE INDEX IF NOT EXISTS coadmin_arb_config_versions_coadmin_published_idx
  ON public.coadmin_automatic_recharge_bonus_config_versions (coadmin_uid, published_at DESC);

CREATE INDEX IF NOT EXISTS coadmin_arb_config_versions_coadmin_status_idx
  ON public.coadmin_automatic_recharge_bonus_config_versions (coadmin_uid, status);

CREATE INDEX IF NOT EXISTS coadmin_arb_config_versions_supersedes_idx
  ON public.coadmin_automatic_recharge_bonus_config_versions (supersedes_version_id)
  WHERE supersedes_version_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.coadmin_automatic_recharge_bonus_settings_audit (
  id BIGSERIAL PRIMARY KEY,

  coadmin_uid TEXT NOT NULL,
  actor_uid TEXT NULL,
  actor_role TEXT NULL,
  action TEXT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  old_json JSONB NULL,
  new_json JSONB NULL,
  version_id TEXT NULL,
  idempotency_key TEXT NULL,

  source TEXT NOT NULL DEFAULT 'appbeg',
  raw_json JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS coadmin_arb_settings_audit_coadmin_changed_idx
  ON public.coadmin_automatic_recharge_bonus_settings_audit (coadmin_uid, changed_at DESC);

CREATE INDEX IF NOT EXISTS coadmin_arb_settings_audit_action_changed_idx
  ON public.coadmin_automatic_recharge_bonus_settings_audit (action, changed_at DESC);

CREATE INDEX IF NOT EXISTS coadmin_arb_settings_audit_version_idx
  ON public.coadmin_automatic_recharge_bonus_settings_audit (version_id)
  WHERE version_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS coadmin_arb_settings_audit_idempotency_uidx
  ON public.coadmin_automatic_recharge_bonus_settings_audit (coadmin_uid, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Reserved for Shadow Mode (and later real grants). No writers in Phase 1.
-- Shadow rows must never imply a balance credit; mode distinguishes shadow vs grant.
CREATE TABLE IF NOT EXISTS public.automatic_recharge_bonus_evaluations (
  id BIGSERIAL PRIMARY KEY,

  evaluation_id TEXT NOT NULL,
  mode TEXT NOT NULL,

  coadmin_uid TEXT NOT NULL,
  player_uid TEXT NOT NULL,
  request_id TEXT NULL,

  recharge_amount NUMERIC NOT NULL,
  config_version_id TEXT NULL,
  -- Human version number copied at evaluation time for support readability
  config_version_number INTEGER NULL,
  tier_id TEXT NULL,

  bonus_calculated NUMERIC NOT NULL DEFAULT 0,
  eligible BOOLEAN NOT NULL DEFAULT FALSE,
  skip_reason TEXT NULL,
  evaluation_result TEXT NOT NULL DEFAULT 'skipped',

  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  source TEXT NOT NULL DEFAULT 'appbeg',
  raw_json JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT arb_evaluations_evaluation_id_unique UNIQUE (evaluation_id),
  CONSTRAINT arb_evaluations_mode_valid
    CHECK (mode IN ('shadow', 'grant')),
  CONSTRAINT arb_evaluations_result_valid
    CHECK (evaluation_result IN ('would_grant', 'granted', 'skipped', 'blocked')),
  CONSTRAINT arb_evaluations_recharge_amount_non_negative
    CHECK (recharge_amount >= 0),
  CONSTRAINT arb_evaluations_bonus_non_negative
    CHECK (bonus_calculated >= 0)
);

CREATE INDEX IF NOT EXISTS arb_evaluations_player_evaluated_idx
  ON public.automatic_recharge_bonus_evaluations (player_uid, evaluated_at DESC);

CREATE INDEX IF NOT EXISTS arb_evaluations_coadmin_evaluated_idx
  ON public.automatic_recharge_bonus_evaluations (coadmin_uid, evaluated_at DESC);

CREATE INDEX IF NOT EXISTS arb_evaluations_request_idx
  ON public.automatic_recharge_bonus_evaluations (request_id)
  WHERE request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS arb_evaluations_version_idx
  ON public.automatic_recharge_bonus_evaluations (config_version_id)
  WHERE config_version_id IS NOT NULL;

-- At most one grant evaluation per request (shadow may retry; grants must be unique).
CREATE UNIQUE INDEX IF NOT EXISTS arb_evaluations_grant_request_uidx
  ON public.automatic_recharge_bonus_evaluations (request_id)
  WHERE mode = 'grant' AND request_id IS NOT NULL;
