-- ============================================================================
-- Launch Deck — Upcoming Quality + Taste Profile Migration
-- Adds:
--   1. Quality + lifecycle columns to upcoming_games_cache
--   2. user_game_taste_profile table (persisted library-derived taste profile)
--
-- Safe to re-run: all statements use IF NOT EXISTS / DO NOTHING guards.
-- ============================================================================

-- ── 1. upcoming_games_cache — new columns ────────────────────────────────────
-- These extend the existing cache without changing read patterns.
-- Server-only writes from sync-upcoming-games.

ALTER TABLE upcoming_games_cache
  -- Richer metadata
  ADD COLUMN IF NOT EXISTS summary                    text,
  ADD COLUMN IF NOT EXISTS tags                       jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS themes                     jsonb DEFAULT '[]'::jsonb,

  -- Derived signals (0..100)
  ADD COLUMN IF NOT EXISTS quality_score              numeric,
  ADD COLUMN IF NOT EXISTS metadata_completeness_score numeric,
  ADD COLUMN IF NOT EXISTS recommendation_base_score  numeric,

  -- Scale classification
  ADD COLUMN IF NOT EXISTS is_indie                   boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_aaa                     boolean DEFAULT false,

  -- Lifecycle
  ADD COLUMN IF NOT EXISTS release_bucket             text,
    -- 'released' | 'imminent' (<=14d) | 'soon' (<=90d) | 'horizon' (<=365d) | 'tba'
  ADD COLUMN IF NOT EXISTS released_at                timestamptz,
  ADD COLUMN IF NOT EXISTS expires_at                 timestamptz;
    -- For released games: released_at + retention (default 21 days). NULL otherwise.

-- Helpful indexes for ranking + dashboard curation
CREATE INDEX IF NOT EXISTS upcoming_games_cache_status_idx
  ON upcoming_games_cache (status);

CREATE INDEX IF NOT EXISTS upcoming_games_cache_quality_idx
  ON upcoming_games_cache (quality_score DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS upcoming_games_cache_recbase_idx
  ON upcoming_games_cache (recommendation_base_score DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS upcoming_games_cache_expires_idx
  ON upcoming_games_cache (expires_at ASC NULLS LAST);


-- ── 2. user_game_taste_profile ───────────────────────────────────────────────
-- Persisted snapshot of the user's taste profile derived from their library.
-- One row per user. Written by the client when the library changes; the client
-- keeps the authoritative runtime copy in memory for fast scoring.

CREATE TABLE IF NOT EXISTS user_game_taste_profile (
  user_id              uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Top entries (normalized 0..1 weights). Stored as ordered jsonb arrays:
  --   [{ "key": "rpg", "weight": 1.0 }, { "key": "action", "weight": 0.75 }]
  top_genres           jsonb       NOT NULL DEFAULT '[]'::jsonb,
  top_franchises       jsonb       NOT NULL DEFAULT '[]'::jsonb,
  top_developers       jsonb       NOT NULL DEFAULT '[]'::jsonb,
  top_publishers       jsonb       NOT NULL DEFAULT '[]'::jsonb,
  top_tags             jsonb       NOT NULL DEFAULT '[]'::jsonb,
  top_themes           jsonb       NOT NULL DEFAULT '[]'::jsonb,

  -- Scale affinities (0..1). Higher = user tends to play that scale.
  indie_affinity       numeric     NOT NULL DEFAULT 0,
  aaa_affinity         numeric     NOT NULL DEFAULT 0,

  -- Category affinities (sports, rpg, action, sim, strategy, horror, etc.)
  -- Stored as { "sports": 0.3, "rpg": 0.9, ... }
  category_affinities  jsonb       NOT NULL DEFAULT '{}'::jsonb,

  -- Signal strength
  total_playtime_minutes int       NOT NULL DEFAULT 0,
  sample_size          int         NOT NULL DEFAULT 0,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE user_game_taste_profile ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own taste profile" ON user_game_taste_profile;
CREATE POLICY "Users manage own taste profile"
  ON user_game_taste_profile FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);


-- ── 3. (Optional) Cleanup — user_preferred_platforms deprecation notice ──────
-- The table is kept for backwards compatibility but is no longer actively used
-- in personalization. It can be dropped in a future migration once confirmed
-- unused:
--
--   DROP TABLE IF EXISTS user_preferred_platforms;
--
-- For now, it remains queryable and writable; the runtime simply ignores it.
