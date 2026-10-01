-- ============================================================================
-- 0037 — Auto-expire stale rides
-- ----------------------------------------------------------------------------
-- Rides only leave 'active' when a lead explicitly ends them, so abandoned,
-- test and demo rides pile up as 'active' forever — and their clients keep
-- flooding rider_positions, which saturated prod (14 rides stuck active for
-- weeks). This closes any active ride that has gone quiet (no fresh position
-- within p_idle) or has simply run too long (older than p_max_age), on a
-- schedule. Lightweight status flip (no summary / no push) since these are
-- abandoned, not cleanly finished — the real close flow stays the leader's.
-- ============================================================================

create or replace function expire_stale_rides(
  p_idle    interval default interval '30 minutes',
  p_max_age interval default interval '18 hours'
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  with stale as (
    select r.id
    from rides r
    left join lateral (
      select max(rp.recorded_at) as last_fix
      from rider_positions rp
      where rp.ride_id = r.id
    ) p on true
    where r.status = 'active'
      and ( coalesce(p.last_fix, r.created_at) < now() - p_idle
            or r.created_at < now() - p_max_age )
  )
  update rides r
     set status = 'ended', ended_at = now()
    from stale s
   where r.id = s.id;
  get diagnostics n = row_count;
  return n;
end;
$$;

comment on function expire_stale_rides(interval, interval) is
  'Closes active rides that have gone quiet (no position within p_idle) or run longer than p_max_age. Scheduled via pg_cron to stop abandoned/demo rides accumulating and flooding rider_positions.';

-- Schedule every 15 minutes via pg_cron when available. Enable it once in
-- Supabase: Dashboard -> Database -> Extensions -> pg_cron (or
-- `create extension pg_cron;`). Idempotent — unschedules any prior job first.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'expire-stale-rides') then
      perform cron.unschedule('expire-stale-rides');
    end if;
    perform cron.schedule('expire-stale-rides', '*/15 * * * *', 'select expire_stale_rides();');
  else
    raise notice 'pg_cron not installed. Enable it, then run: select cron.schedule(''expire-stale-rides'', ''*/15 * * * *'', ''select expire_stale_rides();'');';
  end if;
end$$;
