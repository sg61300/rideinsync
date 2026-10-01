import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { HOME } from "../routes";
import { useSession } from "../lib/auth";
import { useActiveRide } from "../lib/activeRide";
import {
  cancelSosAlert,
  closeSos,
  diffResponders,
  sendSos,
  skipPendingLocationRead,
  startSosTracking,
  staySos,
  stopSosTracking,
  useOwnSosAlert,
  useSosResponses,
  type Responder,
} from "../lib/sos";
import { playSignalTone } from "../lib/earcon";
import { track } from "../lib/analytics";
import { vibrateForTier } from "../lib/haptics";
import type { SignalTier } from "../lib/signals";
import { initialSosPhase, shouldConsumeAutoFlag, shouldResumeSentPhase, type Phase } from "./sosPhase";

// A responder arriving is reassuring, not an emergency, so it uses the High
// "attention" tier (a descending two-note chime) rather than the Critical
// siren the raiser already heard on send. One tier drives both the earcon and
// the haptic pulse, per signals_haptics_plan.md §7e.
const RESPONSE_TIER: SignalTier = "high";

const headingStyle = {
  margin: "0 0 var(--space-sm)",
  fontSize: "var(--text-h1)",
  lineHeight: "var(--lh-h1)",
  fontWeight: "var(--weight-semibold)",
} as const;

const bodyStyle = {
  margin: "0 0 var(--space-lg)",
  color: "var(--color-text-secondary)",
  lineHeight: "var(--lh-body)",
} as const;

const COUNTDOWN_FROM = 5;

export function SosPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const auto = Boolean((location.state as { auto?: boolean } | null)?.auto);
  const { userId } = useSession();
  const { rideId, loading } = useActiveRide(userId, location.pathname);
  // Item 6: the rider's own unresolved alert, if any — lets a reload / PWA
  // relaunch land back on the sent screen instead of a dead confirm.
  const ownAlert = useOwnSosAlert(rideId, userId);

  // Captured once from the initial history entry: the countdown is armed only
  // on the mount that carried { auto: true }. The auto flag is consumed below
  // so a later Back/reload onto this same /sos entry sees auto === false.
  const [phase, setPhase] = useState<Phase>(() => initialSosPhase(auto));
  const [count, setCount] = useState(COUNTDOWN_FROM);
  const [alertId, setAlertId] = useState<string | null>(null);
  const [hasLocation, setHasLocation] = useState(true);
  // Responders the rider has acknowledged with "Stay"; a later reach re-prompts.
  const [stayedIds, setStayedIds] = useState<Set<string>>(new Set());
  // Inline "Cancel your SOS request?" confirm, shown over the sent screen.
  const [confirmCancel, setConfirmCancel] = useState(false);
  // RC-B: surfaced when the cancel RPC fails (e.g. cancel_sos_alert missing on
  // the hosted DB) so "Yes, cancel" is never a dead tap. Cleared on retry.
  const [cancelError, setCancelError] = useState<string | null>(null);
  // After 1.5 s in the "sending" phase, offer "Send now without location" so a
  // rider with GPS off is never stuck waiting on the location read.
  const [showSendNow, setShowSendNow] = useState(false);

  const responsesByAlert = useSosResponses(phase === "sent" ? rideId : null);
  const responders = alertId ? responsesByAlert[alertId] ?? [] : [];
  const reachedPending = responders.filter((r) => r.reachedAt && !stayedIds.has(r.id));
  const prompt = reachedPending[0] ?? null;

  // Alert the raiser (earcon + haptic) when a responder newly appears or newly
  // reaches them. Seed from a ref so an already-populated first render (e.g.
  // returning to the page) produces no diff and no sound — it only fires on a
  // real transition.
  const seenResponders = useRef<Responder[] | null>(null);
  useEffect(() => {
    const prev = seenResponders.current;
    seenResponders.current = responders;
    if (prev === null) return; // baseline capture — never fire on initial load
    const { newOnTheWay, newReached } = diffResponders(prev, responders);
    if (newOnTheWay.length === 0 && newReached.length === 0) return;
    console.info("[sos] responder transition", {
      newOnTheWay: newOnTheWay.length,
      newReached: newReached.length,
    });
    playSignalTone(RESPONSE_TIER);
    vibrateForTier(RESPONSE_TIER);
  }, [responders]);

  // Reveal the "Send now without location" button 1.5 s into the sending phase.
  useEffect(() => {
    if (phase !== "sending") {
      setShowSendNow(false);
      return;
    }
    const id = window.setTimeout(() => setShowSendNow(true), 1500);
    return () => window.clearTimeout(id);
  }, [phase]);

  // Fall into no-ride only before any action has been taken.
  useEffect(() => {
    if (!loading && !rideId && phase === "confirm") setPhase("no-ride");
  }, [loading, rideId, phase]);

  const confirmShownRef = useRef(false);
  useEffect(() => {
    if (confirmShownRef.current) return;
    if (loading || !rideId) return; // no active ride -> flips to no-ride, don't count
    if (phase === "confirm" || phase === "countdown") {
      confirmShownRef.current = true;
      track("sos_confirm_shown", { mode: phase === "countdown" ? "auto" : "manual" });
    }
  }, [phase, loading, rideId]);

  // RC-A: consume the auto flag once, on the mount that carried it. `phase` was
  // already initialised from this same flag, and a same-path replace keeps
  // that phase state — but it rewrites this /sos history entry to
  // { auto: false }, so a Back gesture, browser Back or PWA reload landing on
  // the entry remounts in "confirm" instead of silently re-arming a countdown.
  useEffect(() => {
    if (!shouldConsumeAutoFlag(location.state as { auto?: boolean } | null)) return;
    console.info("[sos] auto flag consumed");
    navigate(location.pathname, { replace: true, state: { auto: false } });
    // Mount-once: intentionally not re-run when location changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Item 6: resume the sent screen for an SOS still unresolved on the backend
  // after a reload / PWA relaunch. Only from an idle screen (confirm/no-ride);
  // never mid-countdown or once already sent/cancelled. hasLocation stays true
  // (the alert row does not carry it) — the "location sent" copy is correct for
  // a resumed active alert. Restores alertId so Cancel SOS works and the
  // tracking effect below restarts.
  useEffect(() => {
    if (!ownAlert) return;
    if (!shouldResumeSentPhase(phase, true)) return;
    console.info("[sos] resumed active alert", ownAlert.id);
    setAlertId(ownAlert.id);
    setPhase("sent");
  }, [ownAlert, phase]);

  // Location tracking runs only while the SOS is active; cleared on unmount.
  useEffect(() => {
    if (phase !== "sent" || !rideId || !userId) return;
    const handle = startSosTracking(rideId, userId);
    return () => stopSosTracking(handle);
  }, [phase, rideId, userId]);

  async function onConfirm() {
    if (!rideId || !userId) {
      setPhase("no-ride");
      return;
    }
    track("sos_confirmed", { ride_id: rideId, surface: "sos_page" });
    setPhase("sending");
    // Fired synchronously before the `await` below — see DemoControlsPage's
    // SignalModal.sendSignal for why: AudioContext.resume() only unlocks
    // within a user gesture's call stack, and a real network round-trip
    // (sendSos) breaks that chain. Critical tier, same 3-beep tone every
    // other rider hears on the receive side (AppLayout's tonedAlertIds
    // effect). Note this still won't play for the voice-triggered auto-send
    // countdown path (no user gesture exists there at all) unless some
    // earlier tap in the session already unlocked the shared AudioContext.
    playSignalTone("critical");
    try {
      const res = await sendSos(rideId, userId);
      track("sos_delivered", { ride_id: rideId, surface: "sos_page", has_location: res.hasLocation });
      setAlertId(res.alertId);
      setHasLocation(res.hasLocation);
      setPhase("sent");
    } catch {
      setPhase("error");
    }
  }

  // Countdown for the voice-triggered auto-send. Cleared on unmount / phase change.
  useEffect(() => {
    if (phase !== "countdown") return;
    if (count <= 0) {
      void onConfirm();
      return;
    }
    const id = window.setTimeout(() => setCount((c) => c - 1), 1000);
    return () => window.clearTimeout(id);
    // onConfirm is stable enough for this one-shot ladder; count drives it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, count]);

  const goHome = () => navigate(HOME);

  async function onCloseSos() {
    if (alertId && userId) {
      try {
        await closeSos(alertId, userId);
      } catch {
        /* logged in closeSos; navigate home regardless */
      }
    }
    navigate(HOME); // unmount clears tracking interval + realtime channel
  }

  async function onConfirmCancel() {
    setConfirmCancel(false);
    setCancelError(null); // clear any prior failure as this retry starts
    if (!alertId || !rideId || !userId) {
      // Nothing to cancel server-side; just leave the SOS screen.
      setPhase("cancelled");
      return;
    }
    try {
      await cancelSosAlert(alertId, rideId, userId);
      setPhase("cancelled");
    } catch {
      // RPC failed → the SOS is NOT cancelled. Stay on the sent screen and
      // surface the failure so "Yes, cancel" is not a dead tap; the rider can
      // retry. The error itself is logged in cancelSosAlert.
      setCancelError("Couldn't cancel the SOS. Check your connection and try again.");
    }
  }

  if (phase === "no-ride") {
    return (
      <Card>
        <h1 style={headingStyle}>You are not in a ride</h1>
        <p style={bodyStyle}>Join or start a ride to enable SOS.</p>
        <Button variant="secondary" onClick={goHome}>
          Back to home
        </Button>
      </Card>
    );
  }

  if (phase === "countdown") {
    return (
      <Card>
        <h1 style={headingStyle}>Sending SOS in {count}</h1>
        <p style={bodyStyle}>Tap Cancel to stop.</p>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-sm)" }}>
          <Button variant="danger" onClick={() => void onConfirm()}>
            Send now
          </Button>
          <Button variant="secondary" onClick={goHome}>
            Cancel
          </Button>
        </div>
      </Card>
    );
  }

  if (phase === "sending") {
    return (
      <Card>
        <h1 style={headingStyle}>Sending SOS…</h1>
        <p style={bodyStyle}>Getting your location (a few seconds)…</p>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-sm)" }}>
          <Button variant="danger" loading>
            Send SOS
          </Button>
          {showSendNow && (
            <Button variant="secondary" onClick={() => skipPendingLocationRead()}>
              Send now without location
            </Button>
          )}
        </div>
      </Card>
    );
  }

  if (phase === "sent") {
    return (
      <Card>
        <h1 style={headingStyle}>Location sent to the group. Help is arriving.</h1>
        {responders.map((r) => (
          <p key={r.id} style={{ ...bodyStyle, marginBottom: "var(--space-sm)" }}>
            {r.reachedAt ? `${r.name} has reached you.` : `${r.name} is on the way.`}
          </p>
        ))}
        {!hasLocation && (
          <p style={bodyStyle}>We could not read your location. Tell the group where you are.</p>
        )}

        {prompt && (
          <Card
            elevated
            role="alert"
            style={{
              margin: "0 0 var(--space-md)",
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-sm)",
            }}
          >
            <p style={{ ...bodyStyle, margin: 0 }}>
              {prompt.name} has reached you. Do you still need help?
            </p>
            <Button variant="primary" onClick={() => void onCloseSos()}>
              Close SOS
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                // Hide the local prompt immediately; a later reach re-prompts.
                setStayedIds((prev) => new Set(prev).add(prompt.id));
                if (alertId && userId) {
                  void staySos(alertId, userId).catch(() => {
                    /* logged in staySos */
                  });
                }
              }}
            >
              Stay
            </Button>
          </Card>
        )}

        {confirmCancel ? (
          <Card
            elevated
            role="alertdialog"
            aria-label="Cancel your SOS request?"
            style={{
              margin: "var(--space-md) 0 0",
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-sm)",
            }}
          >
            <p style={{ ...bodyStyle, margin: 0 }}>Cancel your SOS request?</p>
            <Button variant="danger" onClick={() => void onConfirmCancel()}>
              Yes, cancel
            </Button>
            <Button variant="secondary" onClick={() => setConfirmCancel(false)}>
              Keep SOS
            </Button>
          </Card>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-sm)" }}>
            <Button variant="secondary" onClick={() => setConfirmCancel(true)}>
              Cancel SOS
            </Button>
            <Button variant="secondary" onClick={goHome}>
              Back to home
            </Button>
          </div>
        )}
        {cancelError && (
          <p role="alert" style={{ ...bodyStyle, margin: "var(--space-md) 0 0" }}>
            {cancelError}
          </p>
        )}
      </Card>
    );
  }

  if (phase === "cancelled") {
    return (
      <Card>
        <h1 style={headingStyle}>SOS cancelled</h1>
        <p style={bodyStyle}>
          The group and your emergency contact have been told.
        </p>
        <Button variant="secondary" onClick={goHome}>
          Back to ride
        </Button>
      </Card>
    );
  }

  if (phase === "error") {
    return (
      <Card>
        <h1 style={headingStyle}>Could not reach the group.</h1>
        <p style={bodyStyle}>Check your connection and try again.</p>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-sm)" }}>
          <Button variant="danger" onClick={() => void onConfirm()}>
            Try again
          </Button>
          <Button variant="secondary" onClick={goHome}>
            Cancel
          </Button>
        </div>
      </Card>
    );
  }

  // confirm
  return (
    <Card>
      <h1 style={headingStyle}>Send an SOS?</h1>
      <p style={bodyStyle}>This shares your live location with everyone in your ride.</p>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-sm)" }}>
        <Button variant="danger" onClick={() => void onConfirm()}>
          Send SOS
        </Button>
        <Button variant="secondary" onClick={goHome}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}
