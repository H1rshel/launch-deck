-- ============================================================================
-- Launch Deck — Big Releases Metadata
-- Adds:
--   1. is_big_release (boolean)
--   2. popularity_tier (text)
--   3. big_release_score (int)
-- ============================================================================

ALTER TABLE upcoming_games_cache
  ADD COLUMN IF NOT EXISTS is_big_release boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS popularity_tier text,
  ADD COLUMN IF NOT EXISTS big_release_score integer DEFAULT 0;
