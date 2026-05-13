-- ============================================================================
-- RLS hardening for user_game_taste_profile
--
-- This migration is defensive — it ensures RLS is enabled and correct even if
-- the initial migration had issues or was partially applied. Safe to re-run.
-- ============================================================================

-- 1. Ensure the table exists (no-op if already created)
CREATE TABLE IF NOT EXISTS user_game_taste_profile (
  user_id              uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  top_genres           jsonb       NOT NULL DEFAULT '[]'::jsonb,
  top_franchises       jsonb       NOT NULL DEFAULT '[]'::jsonb,
  top_developers       jsonb       NOT NULL DEFAULT '[]'::jsonb,
  top_publishers       jsonb       NOT NULL DEFAULT '[]'::jsonb,
  top_tags             jsonb       NOT NULL DEFAULT '[]'::jsonb,
  top_themes           jsonb       NOT NULL DEFAULT '[]'::jsonb,
  indie_affinity       numeric     NOT NULL DEFAULT 0,
  aaa_affinity         numeric     NOT NULL DEFAULT 0,
  category_affinities  jsonb       NOT NULL DEFAULT '{}'::jsonb,
  total_playtime_minutes int       NOT NULL DEFAULT 0,
  sample_size          int         NOT NULL DEFAULT 0,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- 2. Force RLS ON — this is the critical security fix.
ALTER TABLE user_game_taste_profile ENABLE ROW LEVEL SECURITY;

-- 3. Force RLS even for the table owner (superuser bypass disabled for this table).
ALTER TABLE user_game_taste_profile FORCE ROW LEVEL SECURITY;

-- 4. Drop any old / permissive policies and re-create strict per-user policies.
DROP POLICY IF EXISTS "Users manage own taste profile" ON user_game_taste_profile;
DROP POLICY IF EXISTS "Users select own taste profile" ON user_game_taste_profile;
DROP POLICY IF EXISTS "Users insert own taste profile" ON user_game_taste_profile;
DROP POLICY IF EXISTS "Users update own taste profile" ON user_game_taste_profile;
DROP POLICY IF EXISTS "Users delete own taste profile" ON user_game_taste_profile;

-- SELECT — users can only read their own row
CREATE POLICY "Users select own taste profile"
  ON user_game_taste_profile
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- INSERT — users can only create a row for themselves
CREATE POLICY "Users insert own taste profile"
  ON user_game_taste_profile
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

-- UPDATE — users can only update their own row
CREATE POLICY "Users update own taste profile"
  ON user_game_taste_profile
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- DELETE — users can only delete their own row
CREATE POLICY "Users delete own taste profile"
  ON user_game_taste_profile
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- Note: Service-role connections (SUPABASE_SERVICE_ROLE_KEY) bypass RLS by
-- default in Supabase, so server-side writes continue to work normally.
