-- "Date added" sync: without it every PC stamps its own install date on
-- every game, making "Latest Added" ordering meaningless on secondary PCs.
-- Stored as the ISO string used by the local SQLite created_at column.

alter table public.games
  add column if not exists added_at text;
