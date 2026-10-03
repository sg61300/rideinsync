// Live ops map for a REAL ride (Flow 3 ↔ Flow 1 integration). Takes a ride
// created via the onboarding form — whose start/destination are text labels —
// geocodes them into a Google route, draws it, and overlays the real roster's
// live positions from Supabase Realtime. A "Simulate pack" action populates
// riders through the real request→approve→track flow so the map has movement
// without needing many phones.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { APIProvider, AdvancedMarker, Map, useMap, useMapsLibrary } from "@vis.gl/react-google-maps";
import { useRideChannel } from "../../hooks/useRideChannel";
import { RideSimulator } from "../../lib/simulator";
import { closeRide, startRide } from "../../lib/ending";
import { canResolveSos, markReached, resolveSosAlert, respondToSos, useOwnSosAlert, useSosAlerts, useSosResponses, type IncomingAlert } from "../../lib/sos";
import { useLocation, useNavigate } from "react-router-dom";
import { track } from "../../lib/analytics";
import { useAuth } from "../../hooks/useAuth";
import { useGeolocation } from "../../hooks/useGeolocation";
import type { Fix } from "../../hooks/useGeolocation";
import { supabase } from "../../lib/supabase";
import type { Ride, RiderOnMap, GroupStatus, RideEvent } from "../../lib/models";
import { SIGNAL_LABEL, SIGNAL_TYPES, signalsCount } from "../../lib/signals";
import { bearingDeg, haversineMeters, type LatLng } from "../../lib/geo";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Icon } from "../ui/Icon";
import { IconButton } from "../ui/IconButton";
import { ROLE_COLOR, ROLE_LABEL } from "../../lib/roles";
import { SosAlertStack } from "../SosAlertStack";
import { OwnSosBar } from "../OwnSosBar";
import { LoadingState } from "../ui/Loader";
import { createPortal } from "react-dom";
import QRCode from "qrcode";
import { usePersistedToggle } from "../../lib/preference";
import { VOICE_COMMANDS_KEY } from "../../lib/voiceCommands";
import { useVoiceListening, publishSignalModalOpen, useVoiceCommandFiredListener } from "../../lib/voiceActivity";
import { usePushNotifications } from "../../lib/pushNotifications";
import { RideDetailsModal, SignalModal } from "./RideActionModals";
import { MAP_OVERLAY_BUTTON } from "./overlayStyles";

const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
const MAP_ID = import.meta.env.VITE_MAP_ID;

// Backoff schedule for positions-ingest retries (M5 hardening) — starts at
// 1s, doubles per consecutive failure, capped at 30s; jitter is added on top
// of each computed delay (see scheduleRetry below) rather than baked in here.
const INITIAL_RETRY_MS = 1000;
const MAX_RETRY_MS = 30000;

const STATUS_COLOR: Record<GroupStatus, string> = {
  intact: "#5AC8FA",
  behind: "#FF9F0A",
  stopped: "#FF453A",
  stale: "#8A8A8E",
};

// The non-SOS signal kinds that make up the collated signal log (SOS has its
// own alert stack), plus their icon/color, keyed for quick lookup.
const SIGNAL_KINDS = ["hazard", "regroup", "pitstop"];
const SIGNAL_META = Object.fromEntries(SIGNAL_TYPES.map((t) => [t.kind, t])) as Record<
  string,
  (typeof SIGNAL_TYPES)[number]
>;

/** Short relative time for the signal log ("just now", "3m ago", "2h ago"). */
function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const secs = Math.floor((Date.now() - then) / 1000);
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function labelOf(pt: Ride["start_point"]): string | null {
  return pt && typeof pt === "object" && "label" in pt ? String((pt as { label?: unknown }).label ?? "") || null : null;
}

// Exact coordinates when the ride was created with a Places-picked address.
function pointOf(pt: Ride["start_point"]): LatLng | null {
  if (pt && typeof pt === "object") {
    const o = pt as { lat?: unknown; lng?: unknown };
    if (typeof o.lat === "number" && typeof o.lng === "number") return { lat: o.lat, lng: o.lng };
  }
  return null;
}

// Google's `overview_path` is decimated for whole-route display: its points are
// spread thin across the full route, so at nav-mode zoom the line between them
// visibly cuts across roads. Stitching the per-step paths keeps every road-curve
// vertex, so the route hugs the road at any zoom level.
function detailedPath(route: google.maps.DirectionsRoute): LatLng[] {
  const pts: LatLng[] = [];
  for (const leg of route.legs ?? []) {
    for (const step of leg.steps ?? []) {
      for (const p of step.path ?? []) pts.push({ lat: p.lat(), lng: p.lng() });
    }
  }
  return pts;
}

// Speed → nav zoom, mirroring how driving apps zoom in when you slow toward a
// turn and out at highway speed. Control points are (km/h, zoom); we linearly
// interpolate and clamp. ~z18 stopped (100-200m radius) → ~z14 at 130km/h
// (a few km radius). `speed` is metres/second (null when the GPS reports none).
function zoomForSpeed(speedMps: number | null): number {
  const kmh = Math.max(0, (speedMps ?? 0) * 3.6);
  const pts: Array<[number, number]> = [
    [0, 18],
    [20, 17],
    [50, 16],
    [90, 15],
    [130, 14],
  ];
  if (kmh <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (kmh <= pts[i][0]) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      return y0 + ((y1 - y0) * (kmh - x0)) / (x1 - x0);
    }
  }
  return pts[pts.length - 1][1];
}

export function LiveOps({ ride }: { ride: Ride }) {
  if (!MAPS_KEY) {
    return (
      <div style={{ padding: "var(--space-md)", color: "var(--color-text-secondary)" }}>
        Set VITE_GOOGLE_MAPS_API_KEY to show the live map.
      </div>
    );
  }
  // Every pin here (self, lead, fellow riders) is an AdvancedMarker, which
  // needs a vector map — no Map ID means the map still loads (raster, route
  // line intact) but every marker silently fails to mount. Surface that
  // explicitly instead of leaving "GPS works, no pins" unexplained.
  if (!MAP_ID) {
    return (
      <div style={{ padding: "var(--space-md)", color: "var(--color-text-secondary)" }}>
        Set VITE_MAP_ID (a vector Map ID from Google Cloud Console → Maps Platform → Map Management) to
        show rider pins — the map loads without it, but markers won't render.
      </div>
    );
  }
  return (
    <APIProvider apiKey={MAPS_KEY}>
      <LiveOpsInner ride={ride} />
    </APIProvider>
  );
}

function LiveOpsInner({ ride }: { ride: Ride }) {
  const geocodingLib = useMapsLibrary("geocoding");
  const routesLib = useMapsLibrary("routes");
  const [route, setRoute] = useState<LatLng[]>([]);
  const [stopPoints, setStopPoints] = useState<LatLng[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const simRef = useRef<RideSimulator | null>(null);

  const { user } = useAuth();
  const { riders, events, rideStatus, joinToasts, dismissJoinToast } = useRideChannel(ride.id);
  const [ending, setEnding] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [navMode, setNavMode] = useState(false); // heading-up follow-me (rider nav)
  // Any member can tap a rider in the strip below the map to focus them: the
  // map pans to their fix, their pin is highlighted, and their live
  // coordinates are shown. Tapping again (or the focused rider going away)
  // clears it.
  const [selectedRiderId, setSelectedRiderId] = useState<string | null>(null);
  // Folded rider list under the lead/sweep pills — names are revealed on demand.
  const [ridersExpanded, setRidersExpanded] = useState(false);
  // Live-map action controls, mirroring the /ride/demo view: roster + join QR,
  // the signal picker, OS push notifications, and hands-free voice.
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [signalOpen, setSignalOpen] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [voiceOn, setVoiceOn] = usePersistedToggle(VOICE_COMMANDS_KEY, false);
  const micListening = useVoiceListening();
  const push = usePushNotifications(ride.id, user?.id ?? null);
  // Collated signal log — so a rider who missed the transient toast (or has no
  // push) can still open one place and read what's been signalled. `events`
  // from the channel only carries signals received while open, so we also fetch
  // recent history once on mount.
  const [signalsExpanded, setSignalsExpanded] = useState(false);
  const [signalHistory, setSignalHistory] = useState<RideEvent[]>([]);
  // True while the initial ride_events history fetch is in flight, so the
  // expanded card can show a loader instead of an empty log (§3 Loading).
  const [signalHistoryLoading, setSignalHistoryLoading] = useState(true);
  // The combined Signals card auto-expands + scrolls into view when reached via
  // the notification bell (navigation state { openSignals: true }, §3/§4).
  const location = useLocation();
  const navigate = useNavigate();
  const signalsCardRef = useRef<HTMLDivElement>(null);
  // Bumped on each navigate tap so the map pans+zooms to the rider even if
  // they're already selected (re-centering on demand).
  const [focusNonce, setFocusNonce] = useState(0);
  const isLeader = user?.id === ride.leader_id;

  function focusRider(id: string) {
    setSelectedRiderId(id);
    setFocusNonce((n) => n + 1);
  }

  // Join QR for the roster modal — the deep link a real rider scans to join.
  useEffect(() => {
    // window.location, not react-router's useLocation() (shadowed as `location`).
    const url = `${window.location.origin}/r?code=${ride.code}`;
    QRCode.toDataURL(url, { width: 220, margin: 1 }).then(setQr).catch(() => setQr(null));
  }, [ride.code]);

  // Seed the signal log with recent history (SOS lives in its own alert stack).
  useEffect(() => {
    let cancelled = false;
    setSignalHistoryLoading(true);
    void supabase
      .from("ride_events")
      .select("*")
      .eq("ride_id", ride.id)
      .in("type", ["hazard", "regroup", "pitstop"])
      .order("created_at", { ascending: false })
      .limit(30)
      .then(({ data, error }) => {
        // supabase's builder is a PromiseLike that resolves (never rejects)
        // with { data, error }, so this single callback is the finally too.
        if (cancelled) return;
        if (error) {
          // Show the live-only log (no error UI) — a failed history fetch must
          // not hide signals received while the app is open (§8).
          console.warn("[signals] history fetch failed", error.message);
        } else if (data) {
          setSignalHistory(data as RideEvent[]);
          console.info(`[signals] history loaded ${data.length}`);
        }
        setSignalHistoryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ride.id]);

  // Bare signal names ("hazard", "regroup") are only matched by the global
  // voice listener while the picker is open — keep it informed, and close the
  // picker once a spoken choice fires (matching a tap+close).
  useEffect(() => publishSignalModalOpen(signalOpen), [signalOpen]);
  useEffect(() => () => publishSignalModalOpen(false), []);
  useVoiceCommandFiredListener(() => setSignalOpen(false));

  // Reached via the notification bell: expand the Signals card and scroll it
  // into view, then clear the flag so a reload doesn't re-trigger it (§3/§4).
  useEffect(() => {
    if (!(location.state as { openSignals?: boolean } | null)?.openSignals) return;
    setSignalsExpanded(true);
    signalsCardRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    navigate(location.pathname, { replace: true, state: null });
  }, [location.state, location.pathname, navigate]);

  async function handleMicToggle() {
    if (voiceOn) {
      setVoiceOn(false);
      return;
    }
    setNote(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      setVoiceOn(true);
    } catch {
      setNote("Microphone access was denied.");
    }
  }

  async function handlePushToggle() {
    if (push.subscribed) await push.disable();
    else await push.enable();
  }

  // Prefer the live status from Realtime, falling back to the prop the page
  // loaded with (Realtime may not have delivered the first row yet).
  const status = rideStatus ?? ride.status;
  const ended = status === "ended";
  const notStarted = status === "draft";
  const [starting, setStarting] = useState(false);

  // SOS alerts render embedded in this page via the shared SosAlertStack
  // (collapse-to-strip + responder/resolve actions). AppLayout suppresses its
  // global fixed overlay on the ride view so there's no fixed duplicate here.
  const sosAlerts = useSosAlerts(ride.id, user?.id ?? null);
  const sosResponsesByAlert = useSosResponses(ride.id);
  // The viewer's OWN unresolved SOS (useSosAlerts filters it out) — shown as a
  // one-line status at the top of the combined Signals card, tapping through to
  // /sos (§3.1). Reuses OwnSosBar so the styling matches the /sos surfaces.
  const ownAlert = useOwnSosAlert(ride.id, user?.id ?? null);
  const selfRole = riders.find((r) => r.member.user_id === user?.id)?.member.role ?? null;
  const canResolve = canResolveSos(selfRole);

  function handleSosRespond(alertId: string) {
    if (!user) return;
    void respondToSos(alertId, ride.id, user.id).catch(() => {
      /* logged in respondToSos; duplicate responses are expected */
    });
  }
  function handleSosReached(responseId: string) {
    void markReached(responseId)
      .then(() => track("sos_reached", { ride_id: ride.id }))
      .catch(() => {
        /* logged in markReached */
      });
  }
  function handleSosResolve(alert: IncomingAlert): Promise<void> {
    if (!user) return Promise.reject(new Error("Not signed in."));
    return resolveSosAlert({
      alertId: alert.id,
      rideId: ride.id,
      riderUserId: alert.userId,
      riderName: alert.name,
      riderTriggeredAt: alert.triggeredAt,
      resolverUserId: user.id,
    }).then(() => {});
  }

  // Geocode the form's start/destination labels → a driving route polyline.
  useEffect(() => {
    if (!geocodingLib || !routesLib) return;
    const startLabel = labelOf(ride.start_point);
    const destLabel = labelOf(ride.destination);
    if (!startLabel || !destLabel) return;
    let cancelled = false;

    const geocoder = new geocodingLib.Geocoder();
    const geocode = (address: string) =>
      new Promise<google.maps.LatLngLiteral | null>((resolve) => {
        const q = ride.city ? `${address}, ${ride.city}` : address;
        geocoder.geocode({ address: q, region: "in" }, (res, status) =>
          resolve(status === "OK" && res?.[0] ? res[0].geometry.location.toJSON() : null),
        );
      });

    (async () => {
      // Prefer exact Places coordinates stored on the ride; geocode the label
      // only as a fallback for rides created before address autocomplete.
      const [a, b] = await Promise.all([
        pointOf(ride.start_point) ?? geocode(startLabel),
        pointOf(ride.destination) ?? geocode(destLabel),
      ]);
      if (cancelled || !a || !b) return;

      // Route stops with coordinates become waypoints the route runs through.
      const { data: stopRows } = await supabase
        .from("route_stops")
        .select("location, seq")
        .eq("ride_id", ride.id)
        .order("seq", { ascending: true });
      if (cancelled) return;
      const waypointCoords = (stopRows ?? [])
        .map((r) => pointOf(r.location as Ride["start_point"]))
        .filter((p): p is LatLng => !!p);
      setStopPoints(waypointCoords);

      const ds = new routesLib.DirectionsService();
      ds.route(
        {
          origin: a,
          destination: b,
          waypoints: waypointCoords.map((location) => ({ location, stopover: true })),
          optimizeWaypoints: true, // let Google reorder stops for the best route
          travelMode: google.maps.TravelMode.DRIVING,
        },
        (result, status) => {
          if (cancelled) return;
          const road = status === "OK" && result?.routes?.[0] ? detailedPath(result.routes[0]) : [];
          if (road.length > 1) {
            setRoute(road);
          } else {
            if (status !== "OK") {
              console.warn(`[LiveOps] Directions failed (${status}); drawing straight-line fallback.`);
            }
            setRoute([a, ...waypointCoords, b]); // fall back to a straight polyline
          }
        },
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [geocodingLib, routesLib, ride.id, ride.start_point, ride.destination, ride.city]);

  useEffect(() => () => void simRef.current?.stop(), []);

  // Push the current user's own GPS so their heading arrow (lead=red / you=green)
  // appears and moves on the map. Foreground only; stops once the ride ends.
  const { fix, liveFix, error: geoError, retry: retryGps } = useGeolocation(!ended && !!user);

  const firstFixLoggedRef = useRef(false);
  useEffect(() => {
    if (firstFixLoggedRef.current) return;
    if (notStarted || ended || !user) return; // only started rides, tracked user
    const key = `rideinsync:first_fix:${ride.id}`;
    let already = false;
    try { already = sessionStorage.getItem(key) === "1"; } catch { /* ignore */ }
    if (already) { firstFixLoggedRef.current = true; return; }

    if (fix) {
      firstFixLoggedRef.current = true;
      try { sessionStorage.setItem(key, "1"); } catch { /* ignore */ }
      track("rider_first_fix", { ride_id: ride.id, got_fix: true });
    } else if (geoError) {
      firstFixLoggedRef.current = true;
      try { sessionStorage.setItem(key, "1"); } catch { /* ignore */ }
      track("rider_first_fix", { ride_id: ride.id, got_fix: false });
    }
  }, [fix, geoError, notStarted, ended, user, ride.id]);
  // Stable travel heading for the nav camera + self arrow. Course over ground —
  // the bearing between consecutive positions — is the reliable signal and is
  // used first: `coords.heading` is unreliable (null when slow, and on many
  // Android GPS layers a spurious 0 whenever there's no real bearing, which
  // pinned navHeading to 0 and left the arrow stuck facing north). We only fall
  // back to device course when we haven't moved enough to derive a bearing, and
  // only when it looks real (non-null, non-zero, actually moving). Otherwise we
  // hold the last good heading, so it never snaps back to north at a stop.
  const prevFixRef = useRef<LatLng | null>(null);
  const [navHeading, setNavHeading] = useState(0);
  useEffect(() => {
    if (!fix) return;
    const prev = prevFixRef.current;
    let next: number | null = null;
    const moved = prev ? haversineMeters(prev, fix) : 0;
    if (prev && moved > 5) {
      next = bearingDeg(prev, fix); // course over ground: our primary signal
    } else if (fix.heading != null && fix.heading !== 0 && (fix.speed ?? 0) > 1) {
      next = fix.heading; // device course, only when it looks genuine
    }
    if (next != null) setNavHeading(((next % 360) + 360) % 360);
    // Advance the baseline only once we've actually moved (or on the first fix),
    // so slow drift accumulates into a real bearing instead of resetting to
    // near-identical points that never clear the 5m threshold.
    if (!prev || moved > 5) prevFixRef.current = { lat: fix.lat, lng: fix.lng };
  }, [fix]);

  // Rendezvous route: before the pack is together, a rider who is elsewhere gets
  // a blue "go to the lead" route (their position -> the lead's live position) on
  // top of the green actual route. It disappears once they're within 500m of the
  // lead (regrouped). Lead never sees it (they are the target).
  const RENDEZVOUS_HIDE_M = 500;
  const leadRider = riders.find((r) => r.member.user_id === ride.leader_id);
  const leadPos: LatLng | null = leadRider?.latest
    ? { lat: leadRider.latest.lat, lng: leadRider.latest.lng }
    : null;
  const gapToLead = fix && leadPos ? haversineMeters({ lat: fix.lat, lng: fix.lng }, leadPos) : null;
  const showRendezvous =
    !isLeader && !ended && !!fix && !!leadPos && gapToLead != null && gapToLead > RENDEZVOUS_HIDE_M;

  const [rendezvousRoute, setRendezvousRoute] = useState<LatLng[]>([]);
  // Last endpoints we routed for; used to throttle Directions calls to ~75m of
  // movement (either endpoint) instead of one per accepted GPS fix.
  const lastRvRef = useRef<{ from: LatLng; to: LatLng } | null>(null);
  useEffect(() => {
    if (!routesLib || !showRendezvous || !fix || !leadPos) {
      setRendezvousRoute([]);
      lastRvRef.current = null;
      return;
    }
    const from = { lat: fix.lat, lng: fix.lng };
    const to = { lat: leadPos.lat, lng: leadPos.lng };
    const last = lastRvRef.current;
    if (last && haversineMeters(last.from, from) < 75 && haversineMeters(last.to, to) < 75) return;
    lastRvRef.current = { from, to };
    let cancelled = false;
    const ds = new routesLib.DirectionsService();
    ds.route(
      { origin: from, destination: to, travelMode: google.maps.TravelMode.DRIVING },
      (result, status) => {
        if (cancelled) return;
        const road = status === "OK" && result?.routes?.[0] ? detailedPath(result.routes[0]) : [];
        setRendezvousRoute(road.length > 1 ? road : [from, to]); // straight-line fallback
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routesLib, showRendezvous, fix?.lat, fix?.lng, leadPos?.lat, leadPos?.lng]);

  // M5 hardening (docs/scale-readiness-roadmap.md): the raw .then/.catch ->
  // console.warn here used to silently drop a fix on any ingest failure
  // (network error, or the 429 positions-ingest returns under its own 3s
  // rate limit). Two additions, both scoped to this effect only — they don't
  // touch useGeolocation's {fix,error} contract or its 5s/20m gating:
  //   1. Exponential backoff + jitter: a failed send schedules a retry after
  //      an increasing delay (capped) instead of firing again on the very
  //      next fix/render.
  //   2. A one-slot outbox: a fix that fails to send is held (overwriting
  //      any previously-pending fix — only the latest position matters for a
  //      live ride) and retried, instead of being dropped. Precedence rule
  //      (documented here since the task allows either choice): a *new* fix
  //      arriving always wins and is sent immediately, superseding whatever
  //      was pending — freshest position beats a queued stale one. The
  //      backoff timer exists only to retry when no new fix has arrived.
  const pendingFixRef = useRef<Fix | null>(null);
  const retryDelayRef = useRef(INITIAL_RETRY_MS);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef(false);

  useEffect(() => {
    // Ride ended / user gone — drop any pending retry, nothing left to send.
    if (!user || ended) {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
      pendingFixRef.current = null;
      return;
    }
    return () => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, [user, ended]);

  useEffect(() => {
    if (!fix || !user) return;
    // A fresh fix always supersedes whatever was queued (see precedence note
    // above) and cancels any pending retry — this send attempt replaces it.
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    void sendFix(fix, user.id);
  }, [fix, user, ride.id]);

  async function sendFix(toSend: Fix, userId: string): Promise<void> {
    if (inFlightRef.current) {
      // A send is already in progress (e.g. a retry firing right as a new
      // fix arrives) — queue this one; the in-flight call flushes it below
      // once it settles, so this never gets stranded.
      pendingFixRef.current = toSend;
      return;
    }
    inFlightRef.current = true;
    let failed = false;
    try {
      const { error } = await supabase.functions.invoke("positions-ingest", {
        body: {
          ride_id: ride.id,
          user_id: userId,
          lat: toSend.lat,
          lng: toSend.lng,
          heading: toSend.heading,
          speed: toSend.speed,
          accuracy: toSend.accuracy,
        },
      });
      if (error) {
        console.warn("[liveops] position ingest failed:", error.message);
        failed = true;
      } else {
        retryDelayRef.current = INITIAL_RETRY_MS; // success resets backoff
      }
    } catch (err) {
      console.warn("[liveops] position ingest failed:", err);
      failed = true;
    } finally {
      inFlightRef.current = false;
    }
    if (failed) {
      // If a newer fix already queued up while this one was in flight, that
      // one wins (freshest position beats the stale one that just failed) —
      // only fall back to re-queuing the failed fix itself if nothing newer
      // showed up.
      const newer = pendingFixRef.current;
      scheduleRetry(newer ?? toSend, userId);
      return;
    }
    // Flush whatever queued up while this send was in flight — inFlightRef is
    // already false here, so this recursive call actually sends instead of
    // just re-queuing itself.
    const queued = pendingFixRef.current;
    pendingFixRef.current = null;
    if (queued) void sendFix(queued, userId);
  }

  function scheduleRetry(toSend: Fix, userId: string): void {
    pendingFixRef.current = toSend;
    const base = retryDelayRef.current;
    const jitter = base * (0.25 + Math.random() * 0.5); // +/- jitter, avoids thundering herd
    const delay = Math.min(base + jitter, MAX_RETRY_MS);
    retryDelayRef.current = Math.min(base * 2, MAX_RETRY_MS);
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    retryTimerRef.current = setTimeout(() => {
      retryTimerRef.current = null;
      const toRetry = pendingFixRef.current;
      pendingFixRef.current = null;
      if (toRetry) void sendFix(toRetry, userId);
    }, delay);
  }


  async function beginRide() {
    setStarting(true);
    setNote(null);
    try {
      await startRide(ride.id); // leader-gated by RLS; draft → active
      track("ride_started", { ride_id: ride.id });
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Couldn't start the ride.");
    } finally {
      setStarting(false);
    }
  }

  async function endRide() {
    setEnding(true);
    setNote(null);
    try {
      await closeRide(ride.id); // leader-gated + idempotent server-side
      track("ride_ended", { ride_id: ride.id });
      await simRef.current?.stop();
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Couldn't end the ride.");
    } finally {
      setEnding(false);
    }
  }

  // Count the pack from the DB (excluding self) + yourself when you have a live fix.
  const inSync =
    riders.filter((r) => r.member.user_id !== user?.id && r.status === "intact").length +
    (fix ? 1 : 0);
  const total = riders.length;
  const center = route[Math.floor(route.length / 2)] ?? { lat: 12.9716, lng: 77.5946 };

  // Focused rider (from the tappable strip). Self's freshest coordinates come
  // from the live GPS fix; everyone else's from their last broadcast position.
  const selectedIsSelf = !!selectedRiderId && selectedRiderId === user?.id;
  const selectedRider = riders.find((r) => r.member.user_id === selectedRiderId) ?? null;
  const selectedPos: LatLng | null = selectedIsSelf
    ? fix
      ? { lat: fix.lat, lng: fix.lng }
      : selectedRider?.latest
        ? { lat: selectedRider.latest.lat, lng: selectedRider.latest.lng }
        : null
    : selectedRider?.latest
      ? { lat: selectedRider.latest.lat, lng: selectedRider.latest.lng }
      : null;

  // Your own marker: prefer the live GPS fix, but fall back to your last known
  // DB position so you never vanish from the map while a fix is pending (GPS
  // still resolving, weak signal, or a momentary gap). Heading likewise: live
  // when we have it, otherwise your last broadcast heading.
  const selfRider = riders.find((r) => r.member.user_id === user?.id) ?? null;
  // Prefer the raw native-rate liveFix for rendering (smooth ~1Hz movement),
  // then the gated fix, then the last known DB position.
  const selfPos: LatLng | null = liveFix
    ? { lat: liveFix.lat, lng: liveFix.lng }
    : fix
      ? { lat: fix.lat, lng: fix.lng }
      : selfRider?.latest
        ? { lat: selfRider.latest.lat, lng: selfRider.latest.lng }
        : null;
  const selfHeading = fix || liveFix ? navHeading : selfRider?.latest?.heading ?? navHeading;

  // Maximizing the map = ride/nav mode (heading-up follow); minimizing = overview.
  function toggleFullscreen() {
    setFullscreen((f) => {
      const next = !f;
      setNavMode(next);
      return next;
    });
  }
  // In nav mode the map rotates to the rider's heading, so markers rotate relative
  // to that (self points "up"); in overview the map is north-up.
  const mapHeading = navMode ? navHeading : 0;
  // Speed-adaptive zoom, like a real nav app: tight when slow / stopped (see the
  // next turn or intersection), widening on the highway for situational awareness.
  const navZoom = zoomForSpeed(fix?.speed ?? null);
  // In overview, frame the rendezvous path (rider -> lead) while it's active so
  // a distant rider can see their way in; otherwise frame the actual route.
  const fitPath = showRendezvous && rendezvousRoute.length > 1 ? rendezvousRoute : route;
  // In fullscreen the overlay sits under the status bar/notch — clear it.
  const topInset = fullscreen ? "calc(env(safe-area-inset-top, 0px) + 52px)" : 12;

  const visibleJoinToasts = joinToasts.filter((t) => t.userId !== user?.id);

  // Collated signal log: live events (received while open) merged with the
  // fetched history, deduped by id, newest first. This is the "one place" a
  // rider can open and read what was signalled, with or without push.
  // `Map` here is the Google Maps component (imported above), so use the JS Map
  // via globalThis to dedupe/lookup.
  const signalById = new globalThis.Map<string, RideEvent>();
  for (const e of [...events, ...signalHistory]) {
    if (SIGNAL_KINDS.includes(e.type)) signalById.set(e.id, e);
  }
  const signalLog = [...signalById.values()].sort((a, b) =>
    (b.created_at ?? "").localeCompare(a.created_at ?? ""),
  );
  const nameByUserId = new globalThis.Map(riders.map((r) => [r.member.user_id, r.profile.display_name] as const));

  // Combined Signals card (§3): header count = open incoming SOS + signal-log
  // length. The card renders whenever the ride is active OR there's anything to
  // show (an incoming SOS, the viewer's own SOS, or any logged signal); it's
  // hidden only when there's nothing and the ride isn't active.
  const signalsHeaderCount = signalsCount(sosAlerts, signalLog);
  const hasSignalsContent =
    sosAlerts.some((a) => !a.resolved) || Boolean(ownAlert) || signalLog.length > 0;
  const showSignalsCard = status === "active" || hasSignalsContent;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-sm)" }}>
      {/* New-rider toast — Realtime already keeps `riders` current with no
          reload needed; this just surfaces that as a transient, dismissible
          nudge for whoever's already on this screen when someone joins. */}
      {visibleJoinToasts.map((t) => {
        const name = riders.find((r) => r.member.user_id === t.userId)?.profile.display_name || "A rider";
        return (
          <Card key={t.id} padding="var(--space-sm) var(--space-md)" style={{ borderLeft: "3px solid var(--color-accent)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-sm)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "var(--space-sm)", minWidth: 0 }}>
                <Icon name="users" size={18} color="var(--color-accent)" />
                <span style={{ fontSize: "var(--text-body-size)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  <strong>{name}</strong> joined the ride
                </span>
              </div>
              <IconButton
                name="x"
                size={32}
                iconSize={16}
                aria-label="Dismiss"
                onClick={() => dismissJoinToast(t.id)}
              />
            </div>
          </Card>
        );
      })}
      {ended && (
        <Card style={{ borderLeft: "3px solid #FF453A" }}>
          <strong style={{ color: "#FF453A" }}>Ride ended</strong>
          <span style={{ color: "var(--color-text-secondary)", marginLeft: 8, fontSize: 13 }}>
            The lead has ended this ride.
          </span>
        </Card>
      )}
      {/* Incoming SOS alert cards now live inside the combined Signals card
          below (§3), not as a standalone stack above the map. */}
      {(() => {
      // Fullscreen = ride/nav mode. AppLayout wraps this view in a
      // `position: relative; z-index: 1` container, which is its own stacking
      // context — a nested `z-index: 1000` can't escape it, so the fixed
      // TabBar (root context, z-index 50) would paint over the "fullscreen"
      // map. Portal the panel to <body> so its z-index applies at the root and
      // the map truly fills the screen, TabBar included.
      const mapPanel = (
      <div
        style={
          fullscreen
            ? { position: "fixed", inset: 0, zIndex: 1000, background: "var(--color-surface-2)" }
            : {
                position: "relative",
                height: "44vh",
                borderRadius: "var(--radius-lg)",
                overflow: "hidden",
                background: "var(--color-surface-2)",
              }
        }
      >
        <Map
          mapId={MAP_ID}
          defaultCenter={center}
          defaultZoom={12}
          gestureHandling="greedy"
          disableDefaultUI
          style={{ width: "100%", height: "100%" }}
        >
          {route.length > 1 && <RoutePolyline path={route} />}
          {/* Blue "go to the lead" route, drawn above the green route so the
              immediate rendezvous path reads first. Hidden within 500m. */}
          {showRendezvous && rendezvousRoute.length > 1 && (
            <RoutePolyline path={rendezvousRoute} color="#2E7DFF" weight={6} zIndex={2} />
          )}
          {!(navMode && fix) && !selectedPos && fitPath.length > 1 && <FitToRoute path={fitPath} />}
          {navMode && fix && (
            <FollowCamera target={{ lat: (liveFix ?? fix).lat, lng: (liveFix ?? fix).lng }} zoom={navZoom} heading={navHeading} tilt={45} />
          )}
          {!navMode && selectedPos && <PanToRider target={selectedPos} nonce={focusNonce} zoom={17} />}
          {stopPoints.map((p, i) => (
            <AdvancedMarker key={`stop-${i}`} position={p}>
              <StopPin index={i + 1} />
            </AdvancedMarker>
          ))}
          {/* Other riders from the DB (self is drawn from the live fix below).
              Rotation is relative to the map heading so heading-up stays correct. */}
          {riders.map((r) => {
            if (!r.latest || r.member.user_id === user?.id) return null;
            const isLead = r.member.role === "leader" || r.member.role === "co_leader";
            const pos = { lat: r.latest.lat, lng: r.latest.lng };
            const selected = r.member.user_id === selectedRiderId;
            return (
              // Tween over ~5s (their broadcast cadence) so packmates glide.
              <AnimatedMarker key={r.member.user_id} position={pos} durationMs={5000} zIndex={selected ? 1000 : undefined}>
                {isLead ? (
                  <ArrowPin color="#FF453A" heading={(r.latest.heading ?? 0) - mapHeading} name={r.profile.display_name} kind="Lead" selected={selected} />
                ) : (
                  <RiderPin rider={r} selected={selected} />
                )}
              </AnimatedMarker>
            );
          })}
          {/* Your own arrow: live GPS when available, else your last known
              position, so you always see yourself (not just the lead).
              Tween over ~1.2s so it glides with the ~1Hz liveFix. */}
          {selfPos && (
            <AnimatedMarker position={selfPos} durationMs={1200} zIndex={selectedIsSelf ? 1000 : undefined}>
              <ArrowPin
                color={isLeader ? "#FF453A" : "#34C759"}
                heading={selfHeading - mapHeading}
                name="You"
                kind={isLeader ? "Lead" : "You"}
                selected={selectedIsSelf}
              />
            </AnimatedMarker>
          )}
        </Map>

        {/* Top overlay: the in-sync tray sits with notifications + voice (the
            other two actions live at the bottom). Translucent dark pills so the
            white content stays legible over the light map tiles. */}
        <div style={{ position: "absolute", top: topInset, left: 12, zIndex: 999, display: "flex", alignItems: "center", gap: 8 }}>
          <span
            aria-label={`${inSync} of ${total} riders in sync`}
            style={{ ...MAP_OVERLAY_BUTTON, height: 44, display: "inline-flex", alignItems: "center", padding: "0 14px", borderRadius: 999, color: "#fff", fontSize: 13, fontWeight: 600 }}
          >
            {inSync}/{total} in sync
          </span>
          <IconButton
            name="bell"
            size={44}
            iconSize={20}
            variant={push.subscribed ? "accent" : "surface"}
            style={push.subscribed ? undefined : MAP_OVERLAY_BUTTON}
            disabled={!push.supported || push.loading}
            aria-label={
              !push.supported
                ? "Notifications aren't supported in this browser"
                : push.subscribed
                  ? "Turn off notifications for this ride"
                  : "Turn on notifications for this ride"
            }
            aria-pressed={push.subscribed}
            onClick={() => void handlePushToggle()}
          />
          <IconButton
            name="mic"
            size={44}
            iconSize={20}
            variant={voiceOn ? "accent" : "surface"}
            style={voiceOn ? undefined : MAP_OVERLAY_BUTTON}
            className={voiceOn && micListening ? "mic-listening" : undefined}
            aria-label={voiceOn ? "Turn off RideInSync voice commands" : "Turn on RideInSync voice commands"}
            aria-pressed={voiceOn}
            onClick={() => void handleMicToggle()}
          />
        </div>

        {/* Bottom overlay: signal picker + roster (rider details). Signalling
            only makes sense once the ride is underway, so the signal action is
            hidden until it's active (a draft has no pack to signal yet, and an
            ended ride is over); rider details stays available throughout. */}
        <div style={{ position: "absolute", left: 12, bottom: 12, zIndex: 999, display: "flex", gap: 8 }}>
          {status === "active" && (
            <IconButton
              name="signal"
              size={44}
              iconSize={20}
              style={MAP_OVERLAY_BUTTON}
              aria-label="Send a signal"
              title="Send a signal"
              onClick={() => setSignalOpen(true)}
            />
          )}
          <IconButton
            name="users"
            size={44}
            iconSize={20}
            style={MAP_OVERLAY_BUTTON}
            aria-label="Ride details"
            title="Ride details"
            onClick={() => setDetailsOpen(true)}
          />
        </div>

        {/* Map controls: maximize/minimize + orientation (nav heading-up / overview).
            Explicit z-index (above the map's own internal panes/marker layer,
            which can otherwise paint over a plain-stacked sibling during pan/
            zoom) keeps these pinned on top of the map instead of getting
            buried mid-gesture. */}
        <div style={{ position: "absolute", top: topInset, right: 12, zIndex: 999, display: "flex", flexDirection: "column", gap: 8 }}>
          <MapControlButton title={fullscreen ? "Minimize map" : "Maximize map"} onClick={toggleFullscreen}>
            {fullscreen ? "⤡" : "⤢"}
          </MapControlButton>
          <MapControlButton
            title={navMode ? "Switch to overview (north-up)" : "Navigation (heading-up)"}
            active={navMode}
            onClick={() => setNavMode((n) => !n)}
          >
            ➤
          </MapControlButton>
        </div>

        {/* GPS status: when the watch fails it never recovers on its own, so
            the pill becomes a retry button that restarts the watch. */}
        {geoError && (
          <button
            type="button"
            onClick={retryGps}
            title={geoError}
            aria-label={`GPS unavailable (${geoError}). Retry GPS.`}
            style={{ position: "absolute", right: 12, bottom: 12, background: "rgba(20,20,22,.85)", color: "#FF453A", padding: "6px 12px", borderRadius: 999, fontSize: 12, fontWeight: 600, maxWidth: "55%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", border: "1px solid #FF453A", cursor: "pointer", minHeight: 44 }}
          >
            GPS unavailable — tap to retry
          </button>
        ) 
        // : (
        //   <span style={{ position: "absolute", right: 12, bottom: 12, background: "rgba(20,20,22,.85)", color: fix ? "#34C759" : "#FF9F0A", padding: "6px 12px", borderRadius: 999, fontSize: 12, fontWeight: 600, maxWidth: "55%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        //     {fix ? `GPS ${fix.lat.toFixed(4)}, ${fix.lng.toFixed(4)}` : "Locating…"}
        //   </span>
        // )
        }
      </div>
      );
      return fullscreen ? createPortal(mapPanel, document.body) : mapPanel;
      })()}

      {/* Tappable rider strip — every member can focus any rider to pan the
          map to them, highlight their pin, and read their live coordinates. */}
      {riders.length > 0 && (() => {
        const isLeadRole = (r: RiderOnMap) => r.member.role === "leader" || r.member.role === "co_leader";
        // Lead(s) and sweep(s) always sit first, tagged with their role. The
        // rest fold into a collapsible strip whose names appear on demand.
        const priority = riders
          .filter((r) => isLeadRole(r) || r.member.role === "sweep")
          .sort((a, b) => (isLeadRole(a) ? 0 : 1) - (isLeadRole(b) ? 0 : 1));
        const others = riders.filter((r) => !isLeadRole(r) && r.member.role !== "sweep");

        const riderPill = (r: RiderOnMap, opts?: { showName?: boolean }) => {
          const isSelf = r.member.user_id === user?.id;
          const selected = r.member.user_id === selectedRiderId;
          const name = isSelf ? "You" : r.profile.display_name || "Rider";
          const showName = opts?.showName ?? true;
          const roleLabel = isLeadRole(r) ? ROLE_LABEL.leader : r.member.role === "sweep" ? ROLE_LABEL.sweep : null;
          return (
            <button
              key={r.member.user_id}
              type="button"
              title={`Focus ${name} on the map`}
              aria-label={roleLabel ? `Focus ${name} (${roleLabel}) on the map` : `Focus ${name} on the map`}
              onClick={() => focusRider(r.member.user_id)}
              style={{
                flex: "none",
                display: "inline-flex",
                alignItems: "center",
                gap: "var(--space-2xs)",
                height: 36,
                padding: showName ? "0 var(--space-xs) 0 var(--space-sm)" : "0 var(--space-2xs)",
                minWidth: showName ? undefined : 36,
                justifyContent: "center",
                borderRadius: "var(--radius-full)",
                border: selected ? "1px solid var(--color-accent)" : "1px solid rgba(255,255,255,.14)",
                background: selected ? "color-mix(in srgb, var(--color-accent) 18%, transparent)" : "var(--color-surface-3)",
                color: "var(--color-text-primary)",
                fontSize: "var(--text-label)",
                fontWeight: "var(--weight-medium)" as unknown as number,
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: STATUS_COLOR[r.status], flex: "none" }} />
              {showName && name}
              {showName && roleLabel && (
                <span
                  style={{
                    padding: "1px 6px",
                    borderRadius: "var(--radius-full)",
                    background: ROLE_COLOR[r.member.role],
                    color: "var(--color-text-on-accent)",
                    fontSize: 10,
                    fontWeight: "var(--weight-semibold)" as unknown as number,
                    lineHeight: 1.4,
                  }}
                >
                  {roleLabel}
                </span>
              )}
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 24,
                  height: 24,
                  borderRadius: "50%",
                  background: selected ? "var(--color-accent)" : "var(--color-surface-4)",
                  color: selected ? "var(--color-text-on-accent)" : "var(--color-text-secondary)",
                  flex: "none",
                }}
              >
                <Icon name="navigation" size={13} />
              </span>
            </button>
          );
        };

        return (
        <div>
          {/* Lead/sweep pills and the collapsed "N riders" toggle share one
              line; the folded riders drop to a second line only when opened. */}
          <div style={{ display: "flex", gap: "var(--space-xs)", overflowX: "auto", paddingBottom: 4 }}>
            {priority.map((r) => riderPill(r))}
            {others.length > 0 && (
              <button
                type="button"
                aria-expanded={ridersExpanded}
                onClick={() => setRidersExpanded((v) => !v)}
                style={{
                  flex: "none",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "var(--space-2xs)",
                  height: 36,
                  padding: "0 var(--space-sm)",
                  borderRadius: "var(--radius-full)",
                  border: "1px solid rgba(255,255,255,.14)",
                  background: "var(--color-surface-3)",
                  color: "var(--color-text-secondary)",
                  fontSize: "var(--text-label)",
                  fontWeight: "var(--weight-medium)" as unknown as number,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                <span style={{ display: "inline-flex", transform: ridersExpanded ? "rotate(90deg)" : "none", transition: "transform .15s" }}>
                  <Icon name="chevron-right" size={14} />
                </span>
                {others.length} {others.length === 1 ? "rider" : "riders"}
              </button>
            )}
          </div>
          {others.length > 0 && ridersExpanded && (
            <div style={{ display: "flex", gap: "var(--space-xs)", overflowX: "auto", paddingBottom: 4, marginTop: "var(--space-2xs)" }}>
              {others.map((r) => riderPill(r, { showName: true }))}
            </div>
          )}
          {selectedRider && (
            <div style={{ marginTop: "var(--space-xs)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-sm)", fontSize: "var(--text-label)", color: "var(--color-text-secondary)" }}>
              <span>
                <strong style={{ color: "var(--color-text-primary)" }}>{selectedIsSelf ? "You" : selectedRider.profile.display_name || "Rider"}</strong>
                {notStarted
                  ? " · start the ride to get rider location"
                  : (
                    <>
                      {" · "}{selectedRider.status}
                      {selectedPos
                        ? <> · <span style={{ fontVariantNumeric: "tabular-nums" }}>{selectedPos.lat.toFixed(5)}, {selectedPos.lng.toFixed(5)}</span></>
                        : " · locating…"}
                    </>
                  )}
              </span>
              <button
                type="button"
                onClick={() => setSelectedRiderId(null)}
                style={{ flex: "none", border: "none", background: "transparent", color: "var(--color-text-tertiary)", cursor: "pointer", fontSize: "var(--text-label)" }}
              >
                Clear
              </button>
            </div>
          )}
        </div>
        );
      })()}

      {/* Combined Signals card (§3): the viewer's own SOS status, incoming SOS
          alert cards, and the collated hazard/regroup/pit-stop log — one place
          so a missed toast (or no push) isn't a missed signal. Auto-expands and
          scrolls into view when reached via the notification bell. */}
      {showSignalsCard && (
        <div ref={signalsCardRef}>
          <Card padding="var(--space-sm) var(--space-md)">
            <button
              type="button"
              aria-expanded={signalsExpanded}
              onClick={() => setSignalsExpanded((v) => !v)}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "var(--space-sm)",
                width: "100%",
                minHeight: 44,
                background: "transparent",
                border: "none",
                padding: 0,
                cursor: "pointer",
                color: "var(--color-text-primary)",
              }}
            >
              <span style={{ display: "flex", alignItems: "center", gap: "var(--space-xs)", fontSize: "var(--text-body-size)", fontWeight: "var(--weight-semibold)" as unknown as number }}>
                <Icon name="signal" size={18} />
                Signals
                <span style={{ color: "var(--color-text-secondary)", fontWeight: "var(--weight-regular)" as unknown as number }}>({signalsHeaderCount})</span>
              </span>
              <span style={{ display: "inline-flex", transform: signalsExpanded ? "rotate(90deg)" : "none", transition: "transform .15s", color: "var(--color-text-tertiary)" }}>
                <Icon name="chevron-right" size={16} />
              </span>
            </button>
            {signalsExpanded && (
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-sm)", marginTop: "var(--space-sm)" }}>
                {/* 1. Own open SOS status — safety-critical, so it (and the
                    incoming stack below) always render, even while history
                    loads; only the log waits on the loader. */}
                {ownAlert && (
                  <OwnSosBar
                    responders={sosResponsesByAlert[ownAlert.id] ?? []}
                    onView={() => navigate("/sos")}
                  />
                )}
                {/* 2. Incoming SOS alert cards (Respond / Reached / Resolve). */}
                <SosAlertStack
                  alerts={sosAlerts}
                  responsesByAlert={sosResponsesByAlert}
                  selfUserId={user?.id ?? null}
                  canResolve={canResolve}
                  onRespond={handleSosRespond}
                  onReached={handleSosReached}
                  onResolve={handleSosResolve}
                />
                {/* 3. Signal log — LoadingState while the initial history fetch
                    is pending (§3 Loading), then the collated rows. */}
                {signalHistoryLoading ? (
                  <LoadingState label="Loading signals" size={40} />
                ) : (
                  signalLog.map((e) => {
                    const meta = SIGNAL_META[e.type];
                    const who = e.user_id === user?.id ? "You" : nameByUserId.get(e.user_id) || "A rider";
                    return (
                      <div key={e.id} style={{ display: "flex", alignItems: "center", gap: "var(--space-sm)" }}>
                        <span
                          aria-hidden
                          style={{ flex: "none", width: 32, height: 32, borderRadius: "var(--radius-full)", display: "grid", placeItems: "center", background: meta?.color ?? "var(--color-surface-3)", color: "var(--color-text-on-accent)" }}
                        >
                          <Icon name={meta?.icon ?? "signal"} size={16} />
                        </span>
                        <span style={{ flex: 1, minWidth: 0, fontSize: "var(--text-body-size)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          <strong>{who}</strong> · {SIGNAL_LABEL[e.type as keyof typeof SIGNAL_LABEL] ?? e.type}
                        </span>
                        <span style={{ flex: "none", fontSize: "var(--text-caption)", color: "var(--color-text-tertiary)" }}>
                          {relativeTime(e.created_at)}
                        </span>
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </Card>
        </div>
      )}


      {/* Lead-only tools: a rider viewing the same map doesn't seed dummy
          riders or own the invite QR. */}
    
      {note && <p style={{ color: "var(--color-role-sweep)", fontSize: 13, margin: 0 }}>{note}</p>}

      {isLeader && notStarted && (
        <Button
          fullWidth={false}
          loading={starting}
          onClick={() => void beginRide()}
        >
          Start ride
        </Button>
      )}

      {isLeader && !ended && !notStarted && (
        <Button
          variant="secondary"
          fullWidth={false}
          loading={ending}
          onClick={() => void endRide()}
        >
          End ride
        </Button>
      )}

      {/* Roster + signal picker — portalled to <body> so the fixed scrim isn't
          trapped under the map/TabBar stacking. Join QR is lead-only. */}
      {detailsOpen &&
        createPortal(
          <RideDetailsModal
            riders={riders}
            code={isLeader ? ride.code : null}
            qr={isLeader ? qr : null}
            onFocusRider={focusRider}
            onClose={() => setDetailsOpen(false)}
          />,
          document.body,
        )}
      {signalOpen && user &&
        createPortal(
          <SignalModal
            rideId={ride.id}
            senderId={user.id}
            voiceOn={voiceOn}
            onClose={() => setSignalOpen(false)}
          />,
          document.body,
        )}
    </div>
  );
}

function RoutePolyline({
  path,
  color = "#C4F82A",
  weight = 5,
  opacity = 0.95,
  zIndex,
}: {
  path: LatLng[];
  color?: string;
  weight?: number;
  opacity?: number;
  zIndex?: number;
}) {
  const map = useMap();
  const mapsLib = useMapsLibrary("maps");
  useEffect(() => {
    if (!map || !mapsLib) return;
    const line = new mapsLib.Polyline({
      path,
      strokeColor: color,
      strokeOpacity: opacity,
      strokeWeight: weight,
      zIndex,
      map,
    });
    return () => line.setMap(null);
  }, [map, mapsLib, path, color, weight, opacity, zIndex]);
  return null;
}

function FitToRoute({ path }: { path: LatLng[] }) {
  const map = useMap();
  useEffect(() => {
    if (!map || path.length === 0) return;
    const bounds = new google.maps.LatLngBounds();
    path.forEach((p) => bounds.extend(p));
    map.fitBounds(bounds, 56);
  }, [map, path]);
  return null;
}

// Navigation camera: recenters on the rider, zoomed for the next turn, rotated
// heading-up (with tilt) like a nav app. Runs while nav mode is on.
function FollowCamera({
  target,
  zoom,
  heading,
  tilt,
}: {
  target: LatLng;
  zoom: number;
  heading: number;
  tilt: number;
}) {
  const map = useMap();
  useEffect(() => {
    if (!map) return;
    map.moveCamera({ center: target, zoom, heading, tilt });
  }, [map, target.lat, target.lng, zoom, heading, tilt]);
  return null;
}

// A marker that glides to each new position instead of teleporting. Tweens via
// requestAnimationFrame over `durationMs` (own rider ~1.2s to match the ~1Hz
// liveFix; packmates ~5s to match their broadcast cadence). Each instance owns
// its own tween, so only that marker re-renders, never the whole map. Snaps on
// tiny moves, big jumps (teleport/first fix), and prefers-reduced-motion.
function AnimatedMarker({
  position,
  durationMs = 1000,
  zIndex,
  children,
}: {
  position: LatLng;
  durationMs?: number;
  zIndex?: number;
  children: ReactNode;
}) {
  const [pos, setPos] = useState<LatLng>(position);
  const posRef = useRef<LatLng>(position);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const moved = haversineMeters(posRef.current, position);
    if (reduce || moved < 0.5 || moved > 500) {
      posRef.current = position;
      setPos(position);
      return;
    }
    const from = posRef.current;
    const target = position;
    const start = performance.now();
    let lastFrame = 0;
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / durationMs);
      if (t - lastFrame >= 32 || k >= 1) {
        // ~30fps cap keeps re-renders cheap across many markers.
        lastFrame = t;
        const p = { lat: from.lat + (target.lat - from.lat) * k, lng: from.lng + (target.lng - from.lng) * k };
        posRef.current = p;
        setPos(p);
      }
      if (k < 1) rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [position.lat, position.lng, durationMs]);

  return (
    <AdvancedMarker position={pos} zIndex={zIndex}>
      {children}
    </AdvancedMarker>
  );
}

// Pan + zoom to a focused rider. Keyed on `nonce` (bumped each time the user
// taps a rider's navigate button), so it fires on the tap — not on every
// position update — leaving the user free to pan/zoom afterward without the
// camera yanking back as the rider moves.
function PanToRider({ target, nonce, zoom }: { target: LatLng; nonce: number; zoom: number }) {
  const map = useMap();
  useEffect(() => {
    if (!map || nonce === 0) return;
    map.panTo(target);
    map.setZoom(zoom);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, nonce]);
  return null;
}

function MapControlButton({
  title,
  active,
  onClick,
  children,
}: {
  title: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      style={{
        width: 44,
        height: 44,
        borderRadius: 12,
        border: "none",
        background: active ? "#C4F82A" : "rgba(20,20,22,.9)",
        color: active ? "#0A0A0B" : "#fff",
        fontSize: 20,
        lineHeight: 1,
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        boxShadow: "0 2px 8px rgba(0,0,0,.4)",
      }}
    >
      {children}
    </button>
  );
}

function StopPin({ index }: { index: number }) {
  return (
    <div
      title={`Stop ${index}`}
      style={{
        width: 22,
        height: 22,
        borderRadius: "50%",
        background: "#C4F82A",
        border: "2px solid #0A0A0B",
        color: "#0A0A0B",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontWeight: 700,
        fontSize: 12,
        fontFamily: "var(--font-ui)",
        boxShadow: "0 1px 5px rgba(0,0,0,.5)",
      }}
    >
      {index}
    </div>
  );
}

// Directional arrow for the lead (red) and the current rider (green). Rotates
// to the GPS heading (0 = north). Others use the circle pin below.
function ArrowPin({
  color,
  heading,
  name,
  kind,
  selected,
}: {
  color: string;
  heading: number;
  name: string;
  kind: "Lead" | "You";
  selected?: boolean;
}) {
  const size = selected ? 40 : 30;
  return (
    <div
      title={`${name} — ${kind}`}
      style={{
        transform: `rotate(${heading}deg)`,
        transformOrigin: "50% 50%",
        // Accent halo behind the arrow when focused from the rider strip.
        borderRadius: "50%",
        boxShadow: selected ? "0 0 0 4px rgba(196,248,42,.45)" : "none",
      }}
    >
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
        <path
          d="M12 2 L19 21 L12 16 L5 21 Z"
          fill={color}
          stroke="#0A0A0B"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

function RiderPin({ rider, selected }: { rider: RiderOnMap; selected?: boolean }) {
  const isLeader = rider.member.role === "leader" || rider.member.role === "co_leader";
  const ring = selected ? "var(--color-accent)" : isLeader ? "#C4F82A" : STATUS_COLOR[rider.status];
  const initial = (rider.profile.display_name || "R").trim().charAt(0).toUpperCase();
  const dim = selected ? 46 : 36;
  return (
    <div
      title={`${rider.profile.display_name} — ${rider.status}`}
      style={{
        width: dim,
        height: dim,
        borderRadius: "50%",
        background: "#1C1C1E",
        border: `3px solid ${ring}`,
        boxShadow: selected ? "0 0 0 4px rgba(196,248,42,.35), 0 2px 8px rgba(0,0,0,.5)" : "0 2px 8px rgba(0,0,0,.5)",
        color: "#fff",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontWeight: 600,
        fontSize: selected ? 18 : 14,
        fontFamily: "var(--font-ui)",
        overflow: "hidden",
        opacity: rider.status === "stale" ? 0.65 : 1,
      }}
    >
      {rider.profile.avatar_url ? (
        <img
          src={rider.profile.avatar_url}
          alt=""
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : (
        initial
      )}
    </div>
  );
}
