-- ============================================================================
-- Launch Deck — Run the transient-row purge daily instead of hourly
--
-- Every pg_cron run writes its own bookkeeping row (cron.job_run_details), so
-- even when the purge deletes nothing, each run is a write. With
-- archive_timeout = 2min, any write forces Postgres to close and archive a
-- full 16 MB WAL segment — so the hourly no-op purge alone cost 24 segment
-- archives a day against the Disk IO budget.
--
-- Retention is 24 hours and the rows are dead within a minute of being
-- written (see 20260822000000_transient_row_retention.sql), so one sweep a day
-- bounds both tables just as well.
-- ============================================================================

select cron.unschedule('purge-expired-transient-rows')
where exists (
  select 1 from cron.job where jobname = 'purge-expired-transient-rows'
);

-- 04:17 UTC: off the hour so it never lands on the same tick as
-- sync-upcoming-games (0 */6 * * *), and in the small hours for most users.
select cron.schedule(
  'purge-expired-transient-rows',
  '17 4 * * *',
  $$select public.purge_expired_transient_rows()$$
);
