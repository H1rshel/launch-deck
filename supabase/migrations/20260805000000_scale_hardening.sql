-- ============================================================================
-- Launch Deck — Scale hardening
--
-- No schema or behaviour changes: same tables, same columns, same access
-- rules. This migration only changes how much work Postgres does to serve
-- them, so the project holds up at thousands of users instead of one.
--
-- Three problems, all invisible at a single-user scale:
--   1. RLS policies call auth.uid() per ROW instead of once per query, and
--      several tables stack two permissive policies for the same command
--      (every one of them is evaluated and OR'd together).
--   2. 16 indexes are duplicates or have never been scanned once in 146 days
--      of production traffic — including two GIN indexes on a jsonb column of
--      a table that takes ~8.7k writes per sync run. Every one of them is
--      maintained on every insert and non-HOT update.
--   3. The update-heavy tables have no free space in their pages, so routine
--      updates cannot use the HOT path and must write new index entries and
--      leave dead tuples for autovacuum.
-- ============================================================================


-- ── 1. RLS: evaluate auth.uid() once per query, one policy per table ────────
-- `auth.uid() = user_id` re-runs the function for every row considered.
-- `(select auth.uid()) = user_id` is an InitPlan: Postgres evaluates it once
-- and reuses the constant, which also lets the planner push the comparison
-- into an index scan instead of filtering after the fact.
--
-- Where a table had BOTH a catch-all `FOR ALL` policy and a set of
-- per-command policies, we collapse to a single `FOR ALL`. That is the same
-- access surface the `FOR ALL` policy already granted, minus the duplicate
-- evaluation. Tables with a deliberately NARROWER surface (device_link_codes:
-- insert/delete only, no select; profiles: no delete) keep their exact shape.

do $$
declare
  t text;
  p record;
begin
  foreach t in array array[
    'games',
    'user_devices',
    'device_game_installs',
    'device_commands',
    'user_settings',
    'user_game_metadata',
    'user_game_executables',
    'user_executable_feedback',
    'user_followed_games',
    'user_preferred_platforms',
    'user_game_taste_profile'
  ]
  loop
    for p in
      select policyname from pg_policies
      where schemaname = 'public' and tablename = t
    loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;

    execute format(
      'create policy "Users manage own rows" on public.%I for all
         using ((select auth.uid()) = user_id)
         with check ((select auth.uid()) = user_id)', t);
  end loop;
end $$;

-- Public read-only reference data: one policy, not two identical ones.
drop policy if exists "Public read upcoming_games_cache" on public.upcoming_games_cache;
drop policy if exists "ugc_select_all" on public.upcoming_games_cache;
create policy "Public read upcoming_games_cache"
  on public.upcoming_games_cache for select using (true);

drop policy if exists "Public read global catalog" on public.global_game_executable_catalog;
drop policy if exists "ggec_select_authenticated" on public.global_game_executable_catalog;
create policy "Public read global catalog"
  on public.global_game_executable_catalog for select using (true);

-- profiles: keyed on `id`, and deliberately has no DELETE policy.
drop policy if exists "Users can read own profile" on public.profiles;
drop policy if exists "Users can insert own profile" on public.profiles;
drop policy if exists "Users can update own profile" on public.profiles;
create policy "Users can read own profile"
  on public.profiles for select using ((select auth.uid()) = id);
create policy "Users can insert own profile"
  on public.profiles for insert with check ((select auth.uid()) = id);
create policy "Users can update own profile"
  on public.profiles for update using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- device_link_codes: a tablet claims a code through the link-device Edge
-- Function (service role), so clients deliberately get insert + delete only
-- and NO select. Preserved exactly.
drop policy if exists "Users create own link codes" on public.device_link_codes;
drop policy if exists "Users delete own link codes" on public.device_link_codes;
create policy "Users create own link codes"
  on public.device_link_codes for insert with check ((select auth.uid()) = user_id);
create policy "Users delete own link codes"
  on public.device_link_codes for delete using ((select auth.uid()) = user_id);


-- ── 2. Drop duplicate and never-scanned indexes ─────────────────────────────
-- Every index listed here either indexes exactly the same columns as another
-- index on the same table, or recorded idx_scan = 0 across the full 146-day
-- pg_stat_user_indexes window. Unique constraints are NOT dropped even when
-- unscanned — they enforce data integrity, not query speed — except where an
-- identical unique index remains to enforce the same rule.
--
-- Some of these names are constraint-backed and some are plain indexes, so
-- each is dropped by whichever mechanism owns it.

do $$
declare
  target text[];
  tbl text;
  obj text;
begin
  foreach target slice 1 in array array[
    -- exact duplicate uniques (the constraint-backed twin is kept, except
    -- where the plain index is the one carrying the traffic)
    array['user_game_executables', 'user_game_executables_user_id_dedupe_key_key'],
    array['user_followed_games',   'uq_user_followed_games_user_source_game'],
    array['user_preferred_platforms', 'uq_user_preferred_platforms_user_platform'],
    array['upcoming_games_cache',  'uq_upcoming_games_cache_source_game'],
    array['global_game_executable_catalog', 'global_game_executable_catalog_normalized_exe_name_key'],

    -- upcoming_games_cache: 7 unscanned indexes on a table that takes
    -- thousands of writes per sync run. Two of them are GIN indexes on a
    -- jsonb column, by far the most expensive kind to maintain.
    array['upcoming_games_cache', 'idx_upcoming_franchise'],
    array['upcoming_games_cache', 'idx_upcoming_games_cache_franchise'],
    array['upcoming_games_cache', 'idx_upcoming_platforms'],
    array['upcoming_games_cache', 'idx_upcoming_games_cache_platforms'],
    array['upcoming_games_cache', 'idx_upcoming_release_date'],
    array['upcoming_games_cache', 'idx_upcoming_games_cache_release_date'],
    array['upcoming_games_cache', 'idx_upcoming_status'],
    -- superseded by the (status, release_date) composite added below, which
    -- is a strict superset (status is its leading column)
    array['upcoming_games_cache', 'idx_upcoming_games_cache_status'],

    -- user_game_executables: unscanned, and all real queries are scoped by
    -- user_id first (RLS guarantees it), so the bare single-column indexes
    -- can never be the better plan.
    array['user_game_executables', 'idx_user_game_executables_user_id'],
    array['user_game_executables', 'idx_user_game_executables_dedupe_key'],
    array['user_game_executables', 'idx_user_game_executables_normalized_exe_name'],
    array['user_game_executables', 'idx_user_game_executables_file_hash'],
    -- replaced below by (status, last_seen_at desc), which promote-catalog's
    -- cross-user aggregation can actually walk without a sort
    array['user_game_executables', 'idx_user_game_executables_status'],

    array['user_followed_games', 'idx_user_followed_games_user'],
    array['user_preferred_platforms', 'idx_user_preferred_platforms_user'],

    array['user_executable_feedback', 'idx_user_executable_feedback_user_id'],
    array['user_executable_feedback', 'idx_user_executable_feedback_normalized_exe_name'],

    array['global_game_executable_catalog', 'idx_global_game_executable_catalog_classification'],
    array['global_game_executable_catalog', 'idx_global_game_executable_catalog_normalized_exe_name']
  ]
  loop
    tbl := target[1];
    obj := target[2];

    if exists (
      select 1 from pg_constraint
      where conname = obj
        and conrelid = format('public.%I', tbl)::regclass
    ) then
      execute format('alter table public.%I drop constraint %I', tbl, obj);
    else
      execute format('drop index if exists public.%I', obj);
    end if;
  end loop;
end $$;


-- ── 3. Add the three indexes the real query shapes actually want ────────────
-- Each replaces one or more of the single-column indexes dropped above and is
-- justified by a specific query. At today's row counts the planner seq-scans
-- these tables anyway (which is why the old indexes showed zero scans); these
-- exist for the shape of the data at thousands of users, where the same
-- queries would otherwise become full scans plus a sort.

-- get-upcoming-feeds: `status = 'upcoming' and release_date >= …` (and the
-- TBA variant, `release_date is null`), plus sync-upcoming-games' lifecycle
-- sweep `status = 'upcoming' and release_date < today`.
create index if not exists idx_upcoming_cache_status_release_date
  on public.upcoming_games_cache (status, release_date);

-- promote-catalog: `status = 'confirmed_game' order by last_seen_at desc`
-- across every user's rows — the single biggest table once the app has an
-- install base.
create index if not exists idx_user_game_executables_status_last_seen
  on public.user_game_executables (status, last_seen_at desc);

-- promote-catalog: `order by created_at desc limit 10000` over all feedback.
create index if not exists idx_user_executable_feedback_created_at
  on public.user_executable_feedback (created_at desc);


-- ── 4. Leave page headroom so updates can take the HOT path ─────────────────
-- A HOT (heap-only tuple) update writes the new row version into the same
-- page and skips every index — but only if the page has free space. At the
-- default fillfactor of 100 there is none, so each update also writes new
-- index entries and leaves work for autovacuum.
--
-- These are the tables that get updated in place repeatedly: the device
-- heartbeat rewrites last_seen every minute per PC, and the sync path
-- rewrites games/installs/settings rows whenever something genuinely changes.
-- None of the frequently-updated columns are indexed, so with free space
-- available these updates become HOT.

alter table public.user_devices            set (fillfactor = 70);
alter table public.games                   set (fillfactor = 85);
alter table public.device_game_installs    set (fillfactor = 85);
alter table public.user_settings           set (fillfactor = 70);
alter table public.user_game_taste_profile set (fillfactor = 70);
alter table public.user_game_metadata      set (fillfactor = 85);
alter table public.device_commands         set (fillfactor = 70);

-- NOTE: fillfactor only applies to pages written from here on. Existing rows
-- adopt it as they are rewritten by normal churn, or immediately via
-- `VACUUM FULL`. VACUUM FULL cannot run inside a transaction (and takes an
-- ACCESS EXCLUSIVE lock), so it is deliberately NOT part of this migration —
-- see the post-migration step in the accompanying notes. These tables are all
-- under 600 kB today, so running it by hand is near-instant; at real scale,
-- prefer letting churn do it, or use pg_repack.
