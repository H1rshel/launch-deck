-- ============================================================================
-- Launch Deck — shared Discover feed cache
--
-- get-discover-feeds called IGDB on every single request. Two problems:
--
--   1. IGDB allows 4 requests/second per client, and every Discover page view
--      is one request. That is a hard ceiling the app hits at a few hundred
--      concurrent users, regardless of how fast anything else is.
--   2. Every user paid the full ~1.8s upstream round trip, even though
--      `top_100` page 1 is a byte-identical query for everyone.
--
-- The in-process cache added in v0.1.74 could not solve this: Supabase Edge
-- Functions get a fresh isolate per request, so module-scope state never
-- survives (measured — six concurrent identical requests each paid the full
-- 2s). The cache has to live somewhere both shared and durable, which means
-- Postgres. This is the same pattern get-upcoming-feeds already uses against
-- upcoming_games_cache.
--
-- Keyed on the apicalypse query text, so the feed code keeps issuing exactly
-- the queries it issues today and pagination/has_more semantics are untouched.
-- ============================================================================

create table if not exists public.discover_cache (
  query_hash   text        primary key,   -- sha256 of query_text
  query_text   text        not null,      -- kept for debuggability
  payload      jsonb       not null,      -- raw IGDB response array
  refreshed_at timestamptz not null default now(),
  expires_at   timestamptz not null
);

-- Supports the opportunistic sweep of entries nothing asks for any more.
-- Live lookups are primary-key hits and need no other index.
create index if not exists discover_cache_expires_at_idx
  on public.discover_cache (expires_at);

-- Rows are overwritten in place under a stable key, so this table does not
-- grow with traffic — but it is updated in place constantly, which is exactly
-- the case that benefits from HOT-update headroom.
alter table public.discover_cache set (fillfactor = 70);

-- No client ever touches this table: get-discover-feeds reads and writes it
-- with the service role, which bypasses RLS. RLS on with zero policies is
-- therefore the correct posture — it denies anon and authenticated outright
-- rather than relying on nobody guessing the table name.
alter table public.discover_cache enable row level security;
