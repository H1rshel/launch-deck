-- ============================================================================
-- Launch Deck — Full Schema Migration
-- Run this in the Supabase SQL editor (Project > SQL Editor > New Query)
-- or via `supabase db push` if you have the CLI wired up locally.
--
-- Safe to re-run: all statements use IF NOT EXISTS / DO NOTHING guards.
-- ============================================================================

-- ── 1. upcoming_games_cache ──────────────────────────────────────────────────
-- Populated server-side by the sync-upcoming-games Edge Function.
-- Clients read-only via anon key; writes only through the Edge Function
-- (which uses SUPABASE_SERVICE_ROLE_KEY).

CREATE TABLE IF NOT EXISTS upcoming_games_cache (
  id                    uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  source                text        NOT NULL,           -- 'igdb'
  source_game_id        text        NOT NULL,           -- IGDB game id as string
  name                  text,
  slug                  text,
  cover_url             text,
  banner_url            text,
  release_date          date,
  release_date_precision text        DEFAULT 'day',     -- 'day' | 'month' | 'year'
  status                text        DEFAULT 'upcoming', -- 'upcoming' | 'released'
  platforms             jsonb,
  genres                jsonb,
  developer_names       jsonb,
  publisher_names       jsonb,
  franchise_name        text,
  hype_score            int,
  popularity_score      numeric,
  last_synced_at        timestamptz DEFAULT now()
);

-- The upsert in sync-upcoming-games requires this unique constraint.
-- CREATE UNIQUE INDEX … is idempotent-safe; ALTER TABLE ADD CONSTRAINT is not,
-- so we use DO $$ EXCEPTION pattern.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'upcoming_games_cache_source_source_game_id_key'
  ) THEN
    ALTER TABLE upcoming_games_cache
      ADD CONSTRAINT upcoming_games_cache_source_source_game_id_key
      UNIQUE (source, source_game_id);
  END IF;
END $$;

-- Index for fast date-ordered lookups used by useUpcomingGames
CREATE INDEX IF NOT EXISTS upcoming_games_cache_release_date_idx
  ON upcoming_games_cache (release_date ASC);

-- RLS: public read, no client writes
ALTER TABLE upcoming_games_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read upcoming_games_cache" ON upcoming_games_cache;
CREATE POLICY "Public read upcoming_games_cache"
  ON upcoming_games_cache FOR SELECT
  USING (true);


-- ── 2. user_followed_games ───────────────────────────────────────────────────
-- Per-user "wishlist" / follow list. Composite key: (user_id, source, source_game_id).

CREATE TABLE IF NOT EXISTS user_followed_games (
  id              uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id         uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source          text        NOT NULL,           -- 'igdb'
  source_game_id  text        NOT NULL,           -- matches upcoming_games_cache.source_game_id
  created_at      timestamptz DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'user_followed_games_user_id_source_source_game_id_key'
  ) THEN
    ALTER TABLE user_followed_games
      ADD CONSTRAINT user_followed_games_user_id_source_source_game_id_key
      UNIQUE (user_id, source, source_game_id);
  END IF;
END $$;

ALTER TABLE user_followed_games ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own follows" ON user_followed_games;
CREATE POLICY "Users manage own follows"
  ON user_followed_games FOR ALL
  USING (auth.uid() = user_id);


-- ── 3. user_preferred_platforms ──────────────────────────────────────────────
-- One row per platform the user cares about.
-- Seeded from the library by the client on first login / library scan.

CREATE TABLE IF NOT EXISTS user_preferred_platforms (
  id         uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id    uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  platform   text        NOT NULL,  -- e.g. 'PC', 'PS5', 'Nintendo Switch'
  created_at timestamptz DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'user_preferred_platforms_user_id_platform_key'
  ) THEN
    ALTER TABLE user_preferred_platforms
      ADD CONSTRAINT user_preferred_platforms_user_id_platform_key
      UNIQUE (user_id, platform);
  END IF;
END $$;

ALTER TABLE user_preferred_platforms ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own preferred platforms" ON user_preferred_platforms;
CREATE POLICY "Users manage own preferred platforms"
  ON user_preferred_platforms FOR ALL
  USING (auth.uid() = user_id);


-- ── 4. global_game_executable_catalog ───────────────────────────────────────
-- Shared, crowd-sourced EXE-to-game mapping. Read-only from the client.
-- Written exclusively by the promote-catalog Edge Function.

CREATE TABLE IF NOT EXISTS global_game_executable_catalog (
  id                   uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  normalized_exe_name  text        NOT NULL UNIQUE,
  suggested_game_title text,
  classification       text        DEFAULT 'unknown',
    -- 'game' | 'launcher' | 'tool' | 'drm' | 'redistributable' | 'unknown'
  confidence           numeric(4,3) DEFAULT 0,   -- 0.000 – 1.000
  seen_count           int         DEFAULT 1,
  confirmed_count      int         DEFAULT 0,
  rejected_count       int         DEFAULT 0,
  metadata             jsonb,
  last_updated_at      timestamptz DEFAULT now(),
  created_at           timestamptz DEFAULT now()
);

ALTER TABLE global_game_executable_catalog ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read global catalog" ON global_game_executable_catalog;
CREATE POLICY "Public read global catalog"
  ON global_game_executable_catalog FOR SELECT
  USING (true);

-- No client INSERT / UPDATE / DELETE — the Edge Function uses service role key.


-- ── 5. user_game_executables ─────────────────────────────────────────────────
-- Per-user learning table.
-- Conflict key: (user_id, dedupe_key) — stable regardless of path normalisation.
--   dedupe_key format:
--     'h:<file_hash>'    — file-identity based (survives renames / moves)
--     'p:<norm_path>'    — path-based fallback (most common case)

CREATE TABLE IF NOT EXISTS user_game_executables (
  id                    uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id               uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  dedupe_key            text        NOT NULL,           -- upsert conflict target
  exe_name              text        NOT NULL,
  normalized_exe_name   text,
  exe_path              text        NOT NULL,
  folder_path           text,
  file_hash             text,
  file_size_bytes       bigint,
  source                text        DEFAULT 'auto_scan',
    -- 'auto_scan' | 'manual_add' | 'cloud_sync' | 'folder_scan'
  status                text        DEFAULT 'candidate',
    -- 'candidate' | 'confirmed_game' | 'rejected' | 'ignored'
  game_title            text,
  normalized_game_title text,
  launcher              text,       -- 'steam' | 'gog' | 'epic' | 'ubisoft' | null
  platform              text,
  confidence            numeric(4,3) DEFAULT 0,
  times_seen            int         DEFAULT 1,
  first_seen_at         timestamptz DEFAULT now(),
  last_seen_at          timestamptz DEFAULT now(),
  metadata              jsonb        NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz DEFAULT now(),
  updated_at            timestamptz DEFAULT now()
);

-- Primary upsert constraint — used by batchUpsertUserExecutables / upsertUserExecutable
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'user_game_executables_user_id_dedupe_key_key'
  ) THEN
    ALTER TABLE user_game_executables
      ADD CONSTRAINT user_game_executables_user_id_dedupe_key_key
      UNIQUE (user_id, dedupe_key);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS user_game_executables_user_normalized_idx
  ON user_game_executables (user_id, normalized_exe_name);

ALTER TABLE user_game_executables ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own executables" ON user_game_executables;
CREATE POLICY "Users manage own executables"
  ON user_game_executables FOR ALL
  USING (auth.uid() = user_id);


-- ── 6. user_executable_feedback ─────────────────────────────────────────────
-- Append-only feedback log written when a user removes / rejects a game.

CREATE TABLE IF NOT EXISTS user_executable_feedback (
  id                      uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id                 uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  user_game_executable_id uuid        REFERENCES user_game_executables(id) ON DELETE SET NULL,
  exe_name                text        NOT NULL DEFAULT '',
  normalized_exe_name     text,
  exe_path                text        NOT NULL DEFAULT '',
  reason                  text        NOT NULL,
    -- see FEEDBACK_REASON_LABELS in executableNorm.js
  details                 text,       -- free-text for 'Other'
  created_at              timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_executable_feedback_user_idx
  ON user_executable_feedback (user_id, normalized_exe_name);

ALTER TABLE user_executable_feedback ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own feedback" ON user_executable_feedback;
CREATE POLICY "Users manage own feedback"
  ON user_executable_feedback FOR ALL
  USING (auth.uid() = user_id);
