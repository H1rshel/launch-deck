-- ============================================================================
-- Launch Deck — Retention for transient rows
--
-- Two tables are written as a side effect of normal operation and were never
-- read again after their brief useful life, yet nothing ever deleted them:
--
--   * device_commands   — one row per command sent between the user's PCs.
--     The client ignores anything older than COMMAND_MAX_AGE_MS (5 min) and
--     sendCommand() gives up after 45 s, so a row is dead within a minute of
--     being written. It still keeps its index entry forever.
--   * device_link_codes — one row per pairing code. The UI stops showing a
--     code after 10 minutes, so a surviving row is an unusable secret sitting
--     in the table indefinitely.
--
-- Neither table is anywhere near a problem today (device_commands is empty,
-- the whole database is ~10 MB). This is preventive: both grow strictly with
-- usage and neither has any natural ceiling, so the cost of leaving them
-- unbounded only ever goes up. Retention is deliberately far longer than the
-- functional lifetime above — 24 hours leaves a full day of rows for
-- debugging a failed pairing while still bounding the tables.
--
-- The delete is a no-op when nothing has aged out (no matching rows, no WAL),
-- so the hourly job costs nothing on an idle project.
-- ============================================================================

create extension if not exists pg_cron;

create or replace function public.purge_expired_transient_rows()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from public.device_commands
  where created_at < now() - interval '24 hours';

  delete from public.device_link_codes
  where created_at < now() - interval '24 hours';
end;
$$;

-- Maintenance only — this runs as the cron job owner, never from a client.
revoke all on function public.purge_expired_transient_rows() from public;
revoke all on function public.purge_expired_transient_rows() from anon, authenticated;

-- device_link_codes has no created_at index; the purge scans it, which is
-- correct for a table that holds a handful of rows and would otherwise pay
-- index maintenance on every insert for one sweep an hour.

select cron.unschedule('purge-expired-transient-rows')
where exists (
  select 1 from cron.job where jobname = 'purge-expired-transient-rows'
);

-- Off the hour so it never lands on the same tick as sync-upcoming-games.
select cron.schedule(
  'purge-expired-transient-rows',
  '17 * * * *',
  $$select public.purge_expired_transient_rows()$$
);
