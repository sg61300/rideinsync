-- ============================================================================
-- Task 2c — push the SOS raiser when a responder is on the way / has reached.
-- ----------------------------------------------------------------------------
-- 0027_push_jobs_queue.sql created push_jobs for the four ride signals
-- (hazard/regroup/pitstop/sos), each fanned out to every ride member EXCEPT
-- the sender. The raiser's own device was therefore never notified when help
-- responded — the whole point of this change.
--
-- This migration adds ONE new kind, 'sos_response', plus two nullable columns
-- the worker (supabase/functions/push-notify/index.ts) reads:
--   * target_user_id — when set, the worker notifies ONLY this user's
--     subscriptions (the raiser) instead of "everyone except the sender".
--   * detail — the body phrase ("is on the way.", "has reached you.") so the
--     single sos_response kind covers both the respond and the reached case
--     without a second kind.
-- Both are null for the existing signal kinds, so their fanout is unchanged.
--
-- No RLS policies needed (same as 0027): only the Edge Function's service-role
-- client and the cron-invoked process_queue mode ever touch push_jobs.
-- ============================================================================

alter table push_jobs
  drop constraint push_jobs_kind_check,
  add constraint push_jobs_kind_check
    check (kind in ('hazard', 'regroup', 'pitstop', 'sos', 'sos_response'));

alter table push_jobs
  add column target_user_id uuid references profiles (id) on delete cascade,
  add column detail text;

comment on column push_jobs.target_user_id is
  'sos_response only: when set, push-notify fans out to this user alone (the '
  'SOS raiser) instead of every ride member except the sender.';
comment on column push_jobs.detail is
  'sos_response only: body detail phrase (e.g. ''is on the way.''); null for '
  'the fixed-copy signal kinds.';
