-- ============================================================================
-- Launch Deck — Make the upcoming-games sync actually run, once a day
--
-- The sync-upcoming-games cron job calls net.http_post(), but the pg_net
-- extension was never created in this database: its background worker is
-- preloaded, yet there is no `net` schema. Every run since 2026-04-17 failed
-- with `schema "net" does not exist`, so upcoming_games_cache was last
-- refreshed on 2026-04-20 and the Upcoming feeds have been serving a
-- six-month-old catalogue.
--
-- Daily instead of every 6 hours: each run rewrites the whole cache (~4k rows),
-- and release calendars don't move fast enough to justify four of those a day
-- on a Nano instance that is already short on memory and Disk IO.
--
-- The job's command embeds a bearer token, so it is rebuilt from the existing
-- row rather than written out here. The new command also lifts pg_net's 5s
-- default HTTP timeout — a sync takes ~20s and would otherwise be cut off.
-- ============================================================================

create extension if not exists pg_net;

-- 03:30 UTC: clear of the transient purge at 04:17.
select cron.alter_job(
  j.jobid,
  schedule := '30 3 * * *',
  command := format(
    $cmd$select net.http_post(
      url := %L,
      headers := jsonb_build_object('Authorization', %L, 'Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 150000
    )$cmd$,
    'https://aqoqmrcxjltwtojpgpan.supabase.co/functions/v1/sync-upcoming-games',
    substring(j.command from $re$'(Bearer [^']+)'$re$)
  )
)
from cron.job j
where j.jobname = 'sync-upcoming-games'
  and j.command ~ 'Bearer ';
