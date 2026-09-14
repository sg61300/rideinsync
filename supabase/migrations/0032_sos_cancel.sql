-- ============================================================================
-- SOS cancel by the raiser.
-- ----------------------------------------------------------------------------
-- The rider who raised an SOS can cancel it at any time. Cancelling is a
-- resolution: it flips the alert to resolved (so every SosAlertCard and the
-- raiser's own "help is coming" bar vanish for everyone via sos_alerts UPDATE
-- on the shared ride channel — see src/lib/sos.ts sosCardState / useOwnSosAlert),
-- and additionally records WHY it closed (cancelled, not helped-then-resolved).
--
-- Mechanism: a SECURITY DEFINER RPC, mirroring 0022_raise_sos_alert.sql. The
-- raiser already has RLS UPDATE on their own alert (sos_alerts_resolve_own,
-- 0004_sos.sql), so no new RLS policy is needed — the RPC exists to (a) stamp
-- the same resolved_at/resolved_by columns 0028/0004's resolve path uses, (b)
-- set cancelled_at, and (c) append a best-effort ride_events audit row in one
-- transaction, exactly as 0022 does for the raise.
-- ============================================================================

-- Why the alert closed. Nullable: null for a helped-then-resolved alert (0028
-- ops resolve / owner close), set only when the raiser cancelled it.
alter table sos_alerts add column if not exists cancelled_at timestamptz null;

-- New ride_events audit kind. `add value if not exists` mirrors 0011_ending.sql;
-- kept out of any transaction that then uses it (the RPC only casts this label
-- at call time, long after this migration commits).
alter type event_type add value if not exists 'sos_cancelled';

-- Widen the push_jobs kind check (0027/0031) to accept the cancel push.
alter table push_jobs
  drop constraint push_jobs_kind_check,
  add constraint push_jobs_kind_check
    check (kind in ('hazard', 'regroup', 'pitstop', 'sos', 'sos_response', 'sos_cancelled'));

-- Cancel one's own SOS. Only the raiser (auth.uid() = user_id) may cancel, and
-- only an unresolved alert (a no-op re-cancel of an already-closed alert is
-- rejected so a stale tap can't rewrite an ops resolution). Returns the row.
create or replace function cancel_sos_alert(p_alert_id uuid)
returns sos_alerts
language plpgsql security definer set search_path = public as $$
declare
  v_alert sos_alerts;
  v_now timestamptz := now();
begin
  select * into v_alert from sos_alerts where id = p_alert_id for update;
  if not found then
    raise exception 'sos alert % not found', p_alert_id;
  end if;
  if v_alert.user_id <> auth.uid() then
    raise exception 'only the rider who raised this SOS may cancel it';
  end if;
  if v_alert.resolved_at is not null then
    raise exception 'sos alert % is already resolved', p_alert_id;
  end if;

  update sos_alerts
     set resolved_at = v_now,
         resolved_by = v_alert.user_id,
         cancelled_at = v_now
   where id = p_alert_id
  returning * into v_alert;

  -- Best-effort audit, same contract as 0022: a logging failure must never
  -- roll back the cancel itself.
  begin
    insert into ride_events (ride_id, user_id, type, payload)
    values (
      v_alert.ride_id,
      v_alert.user_id,
      'sos_cancelled',
      jsonb_build_object('alert_id', p_alert_id, 'cancelled_at', v_now)
    );
  exception when others then
    raise warning 'cancel_sos_alert: ride_events insert failed for alert %: %', p_alert_id, sqlerrm;
  end;

  return v_alert;
end;
$$;

grant execute on function cancel_sos_alert(uuid) to authenticated;
