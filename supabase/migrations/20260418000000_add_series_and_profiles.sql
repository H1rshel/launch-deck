-- ============================================================================
-- Launch Deck — Series Support & Enhanced Taste Profile
-- Adds:
--   1. series_name to upcoming_games_cache
--   2. top_series to user_game_taste_profile
-- ============================================================================

ALTER TABLE upcoming_games_cache
  ADD COLUMN IF NOT EXISTS series_name text;

ALTER TABLE user_game_taste_profile
  ADD COLUMN IF NOT EXISTS top_series jsonb NOT NULL DEFAULT '[]'::jsonb;
