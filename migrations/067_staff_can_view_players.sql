ALTER TABLE public.players_cache
  ADD COLUMN IF NOT EXISTS can_view_players boolean NOT NULL DEFAULT FALSE;

UPDATE public.players_cache
SET can_view_players = FALSE
WHERE can_view_players IS DISTINCT FROM FALSE
  AND role <> 'staff';

CREATE INDEX IF NOT EXISTS idx_players_cache_staff_can_view_players
  ON public.players_cache (can_view_players)
  WHERE deleted_at IS NULL AND role = 'staff';
