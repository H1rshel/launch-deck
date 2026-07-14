-- ============================================================================
-- Launch Deck — Streaming + Multi-PC Sync
-- Adds: device registry, per-device install map, settings sync, per-user
-- game metadata sync, streaming command bus, and full customization columns
-- on the per-user games table.
--
-- Safe to re-run: all statements use IF NOT EXISTS / idempotent guards.
-- ============================================================================

-- ── 1. games — full customization sync columns ──────────────────────────────
-- The per-user `games` table was created out-of-band; these columns let every
-- user customization (image position, favorite, custom collection, metadata)
-- follow the account onto a new PC. Encodings match the local SQLite columns
-- (CSV strings / JSON strings) so no re-shaping is needed on either side.

alter table public.games
  add column if not exists hero_position text,
  add column if not exists favorite boolean,
  add column if not exists user_collection text,
  add column if not exists rating real,
  add column if not exists release_date text,
  add column if not exists franchise text,
  add column if not exists franchise_slug text,
  add column if not exists genres text,
  add column if not exists themes text,
  add column if not exists developers text,
  add column if not exists publishers text,
  add column if not exists collections text,
  add column if not exists franchises text,
  add column if not exists imported_playtime_minutes integer;

-- ── 2. user_devices — one row per (user, PC) ─────────────────────────────────
-- device_id is a UUID generated on each install and persisted in the local
-- SQLite app_meta table. last_seen is refreshed by a 60s heartbeat while the
-- app runs; a device is considered "online" when last_seen < 3 minutes old.

create table if not exists public.user_devices (
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null,
  hostname text not null default '',
  hardware jsonb not null default '{}',
  app_version text not null default '',
  lan_ip text not null default '',
  streaming_host_enabled boolean not null default false,
  sunshine_provisioned boolean not null default false,
  last_seen timestamptz not null default now(),
  created_at timestamptz not null default now(),
  primary key (user_id, device_id)
);

alter table public.user_devices enable row level security;

drop policy if exists "Users manage own devices" on public.user_devices;
create policy "Users manage own devices"
  on public.user_devices for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ── 3. device_game_installs — which games are installed on which PC ─────────
-- game_id matches the cloud games.game_id (getCloudGameId(): 'steam_123' etc).
-- No install paths in the cloud — the host resolves paths from its own DB.

create table if not exists public.device_game_installs (
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null,
  game_id text not null,
  installed boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (user_id, device_id, game_id)
);

alter table public.device_game_installs enable row level security;

drop policy if exists "Users manage own installs" on public.device_game_installs;
create policy "Users manage own installs"
  on public.device_game_installs for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ── 4. user_settings — synced app preferences (whole-document LWW) ──────────
-- Only whitelisted keys are stored (see src/lib/settingsSync.js). Machine-
-- specific settings (startup, tray, folders) and OAuth tokens never sync.

create table if not exists public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  settings jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

alter table public.user_settings enable row level security;

drop policy if exists "Users manage own settings" on public.user_settings;
create policy "Users manage own settings"
  on public.user_settings for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ── 5. user_game_metadata — chosen metadata/description per game ────────────
-- Mirrors the local game_details_cache provider='metadata' payload (the
-- description and the user's chosen IGDB/RAWG match) so a new PC shows the
-- same description without re-fetching or losing a manual metadata pick.

create table if not exists public.user_game_metadata (
  user_id uuid not null references auth.users(id) on delete cascade,
  game_id text not null,
  payload jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (user_id, game_id)
);

alter table public.user_game_metadata enable row level security;

drop policy if exists "Users manage own game metadata" on public.user_game_metadata;
create policy "Users manage own game metadata"
  on public.user_game_metadata for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ── 6. device_commands — streaming command bus between the user's PCs ───────
-- Durable request/response rows. The host subscribes to INSERTs targeted at
-- its device_id (Realtime postgres_changes) and also polls as a fallback;
-- the sender watches its row for status transitions.

create table if not exists public.device_commands (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  target_device_id uuid not null,
  from_device_id uuid not null,
  type text not null,                       -- 'pair_request' | 'prepare_stream' | 'end_stream'
  payload jsonb not null default '{}',
  status text not null default 'pending',   -- pending | acked | done | error
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists device_commands_target_idx
  on public.device_commands (user_id, target_device_id, status, created_at desc);

alter table public.device_commands enable row level security;

drop policy if exists "Users manage own commands" on public.device_commands;
create policy "Users manage own commands"
  on public.device_commands for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Realtime: needed for postgres_changes subscriptions on the command bus.
do $$
begin
  alter publication supabase_realtime add table public.device_commands;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;
