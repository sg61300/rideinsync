import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import { acquireRideChannel, type PgChangePayload } from "./rideChannel";
import {
  isDemoBackend,
  demoName,
  demoAlerts,
  demoResponses,
  demoSendSos,
  demoRespond,
  demoMarkReached,
  demoCloseSos,
  demoCancelSos,
  demoStay,
  subscribe as subscribeDemo,
} from "./sosDemo";
import { triggerPushNotify } from "./pushNotifications";
import { triggerSosEmail } from "./sosEmail";
import type {
  SosAlert,
  SosResponse,
  SosResponseInsert,
  RiderPositionInsert,
} from "./models";

// ============================================================================
// Flow 5 SOS — client library. All logs are prefixed "[sos]".
// Sending never blocks on GPS: a location read that denies/times out yields a
// null location and the alert is still raised.
// ============================================================================

type Pos = {
  lat: number;
  lng: number;
  accuracy: number | null;
  heading: number | null;
  speed: number | null;
};

/** Read one position. Resolves null (never rejects) on deny/timeout/no-support. */
function readPosition(): Promise<Pos | null> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
      console.warn("[sos] geolocation unavailable");
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) =>
        resolve({
          lat: p.coords.latitude,
          lng: p.coords.longitude,
          accuracy: p.coords.accuracy ?? null,
          heading: p.coords.heading ?? null,
          speed: p.coords.speed ?? null,
        }),
      (err) => {
        console.warn("[sos] geolocation unavailable", err.message);
        resolve(null);
      },
      { enableHighAccuracy: true, timeout: 8000 },
    );
  });
}

function positionInsert(rideId: string, userId: string, pos: Pos): RiderPositionInsert {
  return {
    ride_id: rideId,
    user_id: userId,
    lat: pos.lat,
    lng: pos.lng,
    heading: pos.heading,
    speed: pos.speed,
    accuracy: pos.accuracy,
  };
}

export type SendSosResult = { alertId: string; hasLocation: boolean };

/**
 * Raise an SOS. Order of operations:
 * 1. read location (best effort, never blocks),
 * 2. call raise_sos_alert RPC, which atomically:
 *    a. inserts sos_alerts (required — failure throws → error state),
 *    b. inserts rider_positions if we have a fix (best effort server-side),
 *    c. inserts ride_events type 'sos' (best effort server-side).
 * All 3 used to be separate unwrapped client round trips (required +
 * best-effort + best-effort); the RPC (0022_raise_sos_alert.sql) now does
 * them in one transaction, so a dropped connection can no longer leave a
 * sos_alerts row with no matching ride_events/rider_positions row. The
 * required-vs-best-effort semantics for each insert are unchanged.
 */
export async function sendSos(rideId: string, userId: string): Promise<SendSosResult> {
  if (isDemoBackend) return demoSendSos(rideId, userId);
  const pos = await readPosition();
  const payload = {
    location: pos
      ? { lat: pos.lat, lng: pos.lng, accuracy: pos.accuracy, recorded_at: new Date().toISOString() }
      : null,
    note: pos ? undefined : "location_unavailable",
  };

  const { data, error } = await supabase.rpc("raise_sos_alert", {
    p_ride_id: rideId,
    p_user_id: userId,
    p_payload: payload,
  });
  if (error || !data) {
    console.warn("[sos] alert insert failed", error?.message);
    throw error ?? new Error("alert insert failed");
  }
  const alertId = data as string;

  // Critical tier, per PRD/signals_haptics_plan.md §8: never throttled, fires
  // regardless of the (best-effort) ride_events insert inside the RPC above.
  triggerPushNotify(rideId, userId, "sos");
  // Also email the rider's emergency contact(s). Same fire-and-forget contract
  // as triggerPushNotify — never blocks or fails the alert (see sosEmail.ts).
  triggerSosEmail(alertId);

  console.info("[sos] alert sent", { alertId, rideId, hasLocation: Boolean(pos) });
  return { alertId, hasLocation: Boolean(pos) };
}

const TRACK_INTERVAL_MS = 10_000;

async function ping(rideId: string, userId: string): Promise<void> {
  const pos = await readPosition();
  if (!pos) return;
  const { error } = await supabase
    .from("rider_positions")
    .insert(positionInsert(rideId, userId, pos));
  if (error) console.warn("[sos] position ping failed", error.message);
  else console.info("[sos] position ping", { rideId });
}

/** Start pinging the group's position every 10 s. Returns an interval handle. */
export function startSosTracking(rideId: string, userId: string): number {
  console.info("[sos] tracking started", { rideId });
  if (isDemoBackend) {
    // Demo: log the ping cadence, insert nothing.
    return window.setInterval(() => {
      console.info("[sos:demo] tracking ping (no insert)", { rideId });
    }, TRACK_INTERVAL_MS);
  }
  return window.setInterval(() => {
    void ping(rideId, userId);
  }, TRACK_INTERVAL_MS);
}

/** Stop a tracker started by startSosTracking. Safe to call with null. */
export function stopSosTracking(handle: number | null): void {
  if (handle == null) return;
  window.clearInterval(handle);
  console.info("[sos] tracking stopped");
}

/**
 * Fire-and-forget push to the SOS raiser only (never the whole ride) telling
 * them help is responding/arriving. Best-effort, same contract as sendSos's
 * triggerPushNotify: it never blocks or fails the response it is attached to.
 * `raiserUserId` is the alert owner; the worker fans out only to that user's
 * subscriptions (see push-notify's target_user_id path).
 */
function notifyRaiser(rideId: string, responderUserId: string, raiserUserId: string, detail: string): void {
  triggerPushNotify(rideId, responderUserId, "sos_response", { targetUserId: raiserUserId, detail });
  console.info("[sos] raiser push queued", { rideId, raiserUserId, detail });
}

/** Record that the current user is responding to an alert (unique per user). */
export async function respondToSos(alertId: string, rideId: string, userId: string): Promise<void> {
  if (isDemoBackend) return demoRespond(alertId, rideId, userId);
  const row: SosResponseInsert = { alert_id: alertId, ride_id: rideId, user_id: userId };
  const { error } = await supabase.from("sos_responses").insert(row);
  if (error) {
    console.warn("[sos] response insert failed", error.message);
    throw error;
  }
  console.info("[sos] response sent", { alertId, rideId });
  // Notify the raiser only. Load the alert's owner from the id we already have.
  const { data: alert } = await supabase
    .from("sos_alerts")
    .select("user_id")
    .eq("id", alertId)
    .maybeSingle();
  const raiserUserId = (alert as { user_id?: string } | null)?.user_id;
  if (raiserUserId) notifyRaiser(rideId, userId, raiserUserId, "is on the way.");
}

/** Mark the current user's own response as having reached the rider. */
export async function markReached(responseId: string): Promise<void> {
  if (isDemoBackend) return demoMarkReached(responseId);
  const { data, error } = await supabase
    .from("sos_responses")
    .update({ reached_at: new Date().toISOString() })
    .eq("id", responseId)
    .select("ride_id, alert_id, user_id")
    .maybeSingle();
  if (error) {
    console.warn("[sos] reached update failed", error.message);
    throw error;
  }
  console.info("[sos] reached", { responseId });
  // Notify the raiser only that a responder has arrived.
  const resp = data as { ride_id?: string; alert_id?: string; user_id?: string } | null;
  if (resp?.ride_id && resp.alert_id && resp.user_id) {
    const { data: alert } = await supabase
      .from("sos_alerts")
      .select("user_id")
      .eq("id", resp.alert_id)
      .maybeSingle();
    const raiserUserId = (alert as { user_id?: string } | null)?.user_id;
    if (raiserUserId) notifyRaiser(resp.ride_id, resp.user_id, raiserUserId, "has reached you.");
  }
}

/** Resolve (close) an alert. Only the rider in distress may do this (RLS). */
export async function closeSos(alertId: string, userId: string): Promise<void> {
  if (isDemoBackend) return demoCloseSos(alertId, userId);
  const { error } = await supabase
    .from("sos_alerts")
    .update({ resolved_at: new Date().toISOString(), resolved_by: userId })
    .eq("id", alertId);
  if (error) {
    console.warn("[sos] close failed", error.message);
    throw error;
  }
  console.info("[sos] closed", { alertId });
}

/**
 * Raiser cancels their own SOS. Calls the cancel_sos_alert RPC
 * (0032_sos_cancel.sql), which flips the alert to resolved + stamps
 * cancelled_at in one transaction — so every SosAlertCard and the raiser's own
 * bar disappear for the whole ride via the shared sos_alerts UPDATE. Then,
 * fire-and-forget (same best-effort contract as sendSos, never blocks or fails
 * the cancel): push every OTHER member "<name> cancelled their SOS", and email
 * the emergency contact the cancelled notice.
 */
export async function cancelSosAlert(alertId: string, rideId: string, userId: string): Promise<void> {
  if (isDemoBackend) return demoCancelSos(alertId, userId);
  const { error } = await supabase.rpc("cancel_sos_alert", { p_alert_id: alertId });
  if (error) {
    console.warn("[sos] cancel failed", error.message);
    throw error;
  }
  console.info("[sos] cancelled", { alertId, rideId });
  triggerPushNotify(rideId, userId, "sos_cancelled");
  triggerSosEmail(alertId, { event: "cancelled" });
}

// ---- Ops resolution (lead / co-lead / sweep) --------------------------------

export const OPS_ROLES = ["leader", "co_leader", "sweep"] as const;

/** Ops-crew roles allowed to resolve another rider's SOS (mirrors is_ride_ops). */
export function canResolveSos(role: string | null | undefined): boolean {
  return role === "leader" || role === "co_leader" || role === "sweep";
}

export type SosResolution = {
  alertId: string;
  rideId: string;
  /** The rider who raised the SOS. */
  riderUserId: string;
  riderName: string;
  riderTriggeredAt: string;
  /** The ops member resolving it. */
  resolverUserId: string;
  resolvedAt: string;
};

export type SosResolutionLog = {
  resolvedAt: string;
  /** ride_events payload so the resolution is queryable alongside the SOS. */
  eventPayload: {
    action: "sos_resolved";
    alert_id: string;
    resolved_at: string;
    resolved_by: string;
    rider: { user_id: string; name: string; triggered_at: string };
  };
};

/**
 * Pure seam for the resolution audit record: timestamp + ride id + the SOS
 * rider's details. Unit-tested; resolveSosAlert stamps it into sos_alerts,
 * ride_events, and the console.
 */
export function buildSosResolutionLog(input: {
  alertId: string;
  rideId: string;
  riderUserId: string;
  riderName: string;
  riderTriggeredAt: string;
  resolverUserId: string;
  resolvedAt?: string;
}): SosResolutionLog {
  const resolvedAt = input.resolvedAt ?? new Date().toISOString();
  return {
    resolvedAt,
    eventPayload: {
      action: "sos_resolved",
      alert_id: input.alertId,
      resolved_at: resolvedAt,
      resolved_by: input.resolverUserId,
      rider: {
        user_id: input.riderUserId,
        name: input.riderName,
        triggered_at: input.riderTriggeredAt,
      },
    },
  };
}

/**
 * Resolve another rider's SOS as ops crew. Stamps resolved_at/resolved_by
 * (RLS: owner via sos_alerts_resolve_own, ops via sos_alerts_resolve_ops),
 * then best-effort appends a ride_events 'sos' row carrying the resolution
 * audit (timestamp, ride id, SOS rider details, resolver) and logs the same
 * object to the console. The events insert never fails the resolve: a
 * resolved alert must disappear from the live view even if logging fails.
 */
export async function resolveSosAlert(input: {
  alertId: string;
  rideId: string;
  riderUserId: string;
  riderName: string;
  riderTriggeredAt: string;
  resolverUserId: string;
}): Promise<SosResolution> {
  const log = buildSosResolutionLog(input);
  if (isDemoBackend) {
    await demoCloseSos(input.alertId, input.resolverUserId);
  } else {
    const { error } = await supabase
      .from("sos_alerts")
      .update({ resolved_at: log.resolvedAt, resolved_by: input.resolverUserId })
      .eq("id", input.alertId);
    if (error) {
      console.warn("[sos] resolve failed", error.message);
      throw error;
    }
    const { error: logError } = await supabase.from("ride_events").insert({
      ride_id: input.rideId,
      user_id: input.resolverUserId,
      type: "sos",
      payload: log.eventPayload,
    });
    if (logError) console.warn("[sos] resolution log insert failed", logError.message);
  }
  const resolution: SosResolution = {
    alertId: input.alertId,
    rideId: input.rideId,
    riderUserId: input.riderUserId,
    riderName: input.riderName,
    riderTriggeredAt: input.riderTriggeredAt,
    resolverUserId: input.resolverUserId,
    resolvedAt: log.resolvedAt,
  };
  console.info("[sos] resolved", resolution);
  return resolution;
}

/** The current user's membership role in a ride (null when not a member). */
export function useMyRideRole(rideId: string | null, userId: string | null): string | null {
  const [role, setRole] = useState<string | null>(null);

  useEffect(() => {
    setRole(null);
    if (!rideId || !userId) return;
    let active = true;
    supabase
      .from("ride_members")
      .select("role")
      .eq("ride_id", rideId)
      .eq("user_id", userId)
      .maybeSingle()
      .then(({ data }) => {
        if (!active) return;
        setRole((data as { role?: string } | null)?.role ?? null);
      });
    return () => {
      active = false;
    };
  }, [rideId, userId]);

  return role;
}

/**
 * Rider taps "Stay" — still needs help after a responder reported reaching them.
 * Sets stay_requested_at = now() on the alert (RLS: owner only). This re-shows
 * the member alert card for everyone (see sosCardState).
 */
export async function staySos(alertId: string, userId: string): Promise<void> {
  if (isDemoBackend) return demoStay(alertId);
  const { error } = await supabase
    .from("sos_alerts")
    .update({ stay_requested_at: new Date().toISOString() })
    .eq("id", alertId)
    .eq("user_id", userId);
  if (error) {
    console.warn("[sos] stay update failed", error.message);
    throw error;
  }
  console.info("[sos] stay requested", { alertId });
}

// ---- Receiving side ---------------------------------------------------------

async function fetchDisplayName(userId: string, cache: Map<string, string>): Promise<string> {
  const hit = cache.get(userId);
  if (hit) return hit;
  const { data } = await supabase
    .from("profiles")
    .select("display_name")
    .eq("id", userId)
    .maybeSingle();
  const name = data?.display_name ?? "A rider";
  cache.set(userId, name);
  return name;
}

export type IncomingAlert = {
  id: string;
  userId: string;
  name: string;
  triggeredAt: string;
  resolved: boolean;
  /** True only when the alert was resolved by the raiser cancelling it. */
  cancelled: boolean;
  stayRequestedAt: string | null;
};

/**
 * Visibility rule for the member alert card, shared by live + demo paths.
 * Given an alert and its responders:
 *   latestReached = newest reached_at across responders (or null);
 *   visible = not resolved AND (no one has reached yet OR the rider tapped Stay
 *             strictly after that latest reach);
 *   still   = visible AND at least one responder had reached (→ "still needs help").
 * Timestamps are compared via Date.parse so different clocks are safe.
 */
export function sosCardState(
  a: { resolved: boolean; stayRequestedAt: string | null },
  responders: Pick<Responder, "reachedAt">[],
): { visible: boolean; still: boolean } {
  const reachedTimes = responders
    .map((r) => r.reachedAt)
    .filter((t): t is string => Boolean(t));
  const latestReached = reachedTimes.length
    ? reachedTimes.reduce((m, t) => (Date.parse(t) > Date.parse(m) ? t : m))
    : null;
  const visible =
    !a.resolved &&
    (latestReached == null ||
      (a.stayRequestedAt != null && Date.parse(a.stayRequestedAt) > Date.parse(latestReached)));
  const still = visible && latestReached != null;
  return { visible, still };
}

/**
 * Live list of alerts in the ride, excluding the current user's own. Fetches
 * existing unresolved alerts on mount (so a member who opens the app late still
 * sees the card) and listens for INSERT and UPDATE. Each entry carries
 * resolved_at and stay_requested_at; sosCardState turns those (plus responders)
 * into the card's visibility — a resolved alert is simply not shown.
 */
export function useSosAlerts(rideId: string | null, selfUserId: string | null): IncomingAlert[] {
  const [alerts, setAlerts] = useState<IncomingAlert[]>([]);

  useEffect(() => {
    setAlerts([]);
    if (!rideId) return;

    if (isDemoBackend) {
      const derive = () =>
        setAlerts(
          demoAlerts()
            .filter((a) => a.ride_id === rideId && a.user_id !== selfUserId)
            .map((a) => ({
              id: a.id,
              userId: a.user_id,
              name: demoName(a.user_id),
              triggeredAt: a.triggered_at,
              resolved: Boolean(a.resolved_at),
              cancelled: Boolean(a.cancelled_at),
              stayRequestedAt: a.stay_requested_at,
            })),
        );
      derive();
      return subscribeDemo(derive);
    }

    let active = true;
    const names = new Map<string, string>();

    async function add(row: SosAlert) {
      if (row.user_id === selfUserId) return;
      const name = await fetchDisplayName(row.user_id, names);
      if (!active) return;
      const resolved = Boolean(row.resolved_at);
      const cancelled = Boolean(row.cancelled_at);
      const stayRequestedAt = row.stay_requested_at;
      setAlerts((prev) =>
        prev.some((a) => a.id === row.id)
          ? prev.map((a) => (a.id === row.id ? { ...a, resolved, cancelled, stayRequestedAt } : a))
          : [
              ...prev,
              { id: row.id, userId: row.user_id, name, triggeredAt: row.triggered_at, resolved, cancelled, stayRequestedAt },
            ],
      );
    }

    function onUpdate(row: SosAlert) {
      if (row.user_id === selfUserId) return;
      const resolved = Boolean(row.resolved_at);
      const cancelled = Boolean(row.cancelled_at);
      const stayRequestedAt = row.stay_requested_at;
      if (cancelled) console.info("[sos] cancelled received", { alertId: row.id });
      else if (resolved) console.info("[sos] resolved received", { alertId: row.id });
      setAlerts((prev) => prev.map((a) => (a.id === row.id ? { ...a, resolved, cancelled, stayRequestedAt } : a)));
    }

    supabase
      .from("sos_alerts")
      .select("*")
      .eq("ride_id", rideId)
      .is("resolved_at", null)
      .order("triggered_at", { ascending: true })
      .then(({ data, error }) => {
        if (error) {
          console.warn("[sos] alert fetch failed", error.message);
          return;
        }
        data?.forEach((row) => void add(row as SosAlert));
      });

    // M3 channel consolidation: sos_alerts INSERT/UPDATE now ride on the
    // same shared `ride-<id>` channel useRideChannel owns (src/lib/
    // rideChannel.ts), instead of this hook opening its own
    // `ride:<id>:sos:*` channel. External contract (params in, alerts out)
    // is unchanged.
    const handle = acquireRideChannel(rideId);
    const onSosAlertsChange = (payload: PgChangePayload) => {
      const row = payload.new as SosAlert;
      if (payload.eventType === "INSERT") void add(row);
      else if (payload.eventType === "UPDATE") onUpdate(row);
    };
    handle.listeners.sosAlerts.add(onSosAlertsChange);

    return () => {
      active = false;
      handle.listeners.sosAlerts.delete(onSosAlertsChange);
      handle.release();
    };
  }, [rideId, selfUserId]);

  return alerts;
}

export type Responder = { id: string; userId: string; name: string; reachedAt: string | null };

/**
 * Pure transition detector for the raiser's SosPage earcon/haptic (Task 2a).
 * Given the previously-seen responders and the current list, returns the ones
 * that are newly on the way (a responder id not seen before, not yet reached)
 * and the ones that newly reached (seen before without reachedAt, now with it —
 * or a brand-new responder that already shows reachedAt). Fires once per
 * transition; callers seed `prev` from a ref so an already-populated initial
 * load produces no diff (and no sound).
 */
export function diffResponders(
  prev: Responder[],
  next: Responder[],
): { newOnTheWay: Responder[]; newReached: Responder[] } {
  const prevById = new Map(prev.map((r) => [r.id, r]));
  const newOnTheWay: Responder[] = [];
  const newReached: Responder[] = [];
  for (const r of next) {
    const before = prevById.get(r.id);
    if (!before) {
      if (r.reachedAt) newReached.push(r);
      else newOnTheWay.push(r);
    } else if (!before.reachedAt && r.reachedAt) {
      newReached.push(r);
    }
  }
  return { newOnTheWay, newReached };
}

/**
 * Pure status-line builder for the raiser's own SOS bar (Task 2b). Reached
 * beats on-the-way beats waiting; with several on the way it names the first
 * and counts the rest, mirroring SosAlertCard's compact detail text.
 */
export function buildOwnSosStatus(responders: Responder[]): string {
  const reached = responders.filter((r) => r.reachedAt);
  if (reached.length > 0) return `${reached[0].name} has reached you`;
  const onWay = responders.filter((r) => !r.reachedAt);
  if (onWay.length === 0) return "Waiting for a response…";
  const extra = onWay.length - 1;
  return extra > 0
    ? `Help is coming: ${onWay[0].name} and ${extra} other${extra > 1 ? "s" : ""} on the way`
    : `Help is coming: ${onWay[0].name} is on the way`;
}

/**
 * The current user's own unresolved SOS alert in the ride, or null (Task 2b).
 * useSosAlerts deliberately filters the raiser's own alert out, so this is the
 * one hook that surfaces it — used by AppLayout to show the raiser a "help is
 * coming" bar on every in-app screen except /sos. Rides on the same shared
 * `ride-<id>` channel as useSosAlerts (rideChannel.ts), not a new channel.
 */
export function useOwnSosAlert(rideId: string | null, userId: string | null): IncomingAlert | null {
  const [own, setOwn] = useState<IncomingAlert | null>(null);

  useEffect(() => {
    setOwn(null);
    if (!rideId || !userId) return;

    if (isDemoBackend) {
      const derive = () => {
        const a = demoAlerts()
          .filter((x) => x.ride_id === rideId && x.user_id === userId && !x.resolved_at)
          .at(-1);
        setOwn(
          a
            ? {
                id: a.id,
                userId: a.user_id,
                name: demoName(a.user_id),
                triggeredAt: a.triggered_at,
                resolved: false,
                cancelled: false,
                stayRequestedAt: a.stay_requested_at,
              }
            : null,
        );
      };
      derive();
      return subscribeDemo(derive);
    }

    let active = true;
    const apply = (row: SosAlert) => {
      if (!active || row.user_id !== userId) return;
      if (row.resolved_at) {
        setOwn((prev) => (prev && prev.id === row.id ? null : prev));
        return;
      }
      setOwn({
        id: row.id,
        userId: row.user_id,
        name: "You",
        triggeredAt: row.triggered_at,
        resolved: false,
        cancelled: false,
        stayRequestedAt: row.stay_requested_at,
      });
    };

    supabase
      .from("sos_alerts")
      .select("*")
      .eq("ride_id", rideId)
      .eq("user_id", userId)
      .is("resolved_at", null)
      .order("triggered_at", { ascending: false })
      .limit(1)
      .then(({ data, error }) => {
        if (error) {
          console.warn("[sos] own alert fetch failed", error.message);
          return;
        }
        const row = data?.[0] as SosAlert | undefined;
        if (row) apply(row);
      });

    const handle = acquireRideChannel(rideId);
    const onSosAlertsChange = (payload: PgChangePayload) => {
      const row = payload.new as SosAlert;
      if (payload.eventType === "INSERT" || payload.eventType === "UPDATE") apply(row);
    };
    handle.listeners.sosAlerts.add(onSosAlertsChange);

    return () => {
      active = false;
      handle.listeners.sosAlerts.delete(onSosAlertsChange);
      handle.release();
    };
  }, [rideId, userId]);

  return own;
}

/** Live map of alertId → responders (with names + reached state) for the ride. */
export function useSosResponses(rideId: string | null): Record<string, Responder[]> {
  const [byAlert, setByAlert] = useState<Record<string, Responder[]>>({});

  useEffect(() => {
    setByAlert({});
    if (!rideId) return;

    if (isDemoBackend) {
      const derive = () => {
        const next: Record<string, Responder[]> = {};
        for (const r of demoResponses()) {
          if (r.ride_id !== rideId) continue;
          (next[r.alert_id] ??= []).push({
            id: r.id,
            userId: r.user_id,
            name: demoName(r.user_id),
            reachedAt: r.reached_at,
          });
        }
        setByAlert(next);
      };
      derive();
      return subscribeDemo(derive);
    }

    let active = true;
    const names = new Map<string, string>();

    async function upsert(row: SosResponse) {
      const name = await fetchDisplayName(row.user_id, names);
      if (!active) return;
      const entry: Responder = { id: row.id, userId: row.user_id, name, reachedAt: row.reached_at };
      setByAlert((prev) => {
        const list = prev[row.alert_id] ?? [];
        const idx = list.findIndex((r) => r.id === row.id);
        if (idx === -1) return { ...prev, [row.alert_id]: [...list, entry] };
        const next = list.slice();
        next[idx] = entry;
        return { ...prev, [row.alert_id]: next };
      });
    }

    supabase
      .from("sos_responses")
      .select("*")
      .eq("ride_id", rideId)
      .then(({ data, error }) => {
        if (error) {
          console.warn("[sos] response fetch failed", error.message);
          return;
        }
        data?.forEach((row) => void upsert(row as SosResponse));
      });

    const channel = supabase
      .channel(`ride:${rideId}:sos-responses:${Math.random().toString(36).slice(2)}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "sos_responses",
          filter: `ride_id=eq.${rideId}`,
        },
        (payload) => {
          const row = payload.new as SosResponse;
          if (row?.id) void upsert(row);
        },
      )
      .subscribe();

    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, [rideId]);

  return byAlert;
}
