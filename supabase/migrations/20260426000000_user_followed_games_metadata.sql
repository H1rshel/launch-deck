-- Add metadata column to user_followed_games so game details are always
-- recoverable even when a game isn't present in upcoming_games_cache.
-- This is especially important for games followed from Discover tabs, which
-- are fetched live from IGDB and may not yet be in upcoming_games_cache.

ALTER TABLE user_followed_games
  ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT NULL;
