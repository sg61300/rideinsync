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
  startSosTracking,
  staySos,
  stopSosTracking,
  useSosResponses,
  type Responder,
} from "../lib/sos";
import { playSignalTone } from "../lib/earcon";
import { vibrateForTier } from "../lib/haptics";
import type { SignalTier } from "../lib/signals";

// A responder arriving is reassuring, not an emergency, so it uses the High
// "attention" tier (a descending two-note chime) rather than the Critical
// siren the raiser already heard on send. One tier drives both the earcon and
// the haptic pulse, per signals_haptics_plan.md §7e.
const RESPONSE_TIER: SignalTier = "high";

type Phase = "no-ride" | "confirm" | "countdown" | "sending" | "sent" | "cancelled" | "error";

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
  const { rideId, loading } = useActiveRide(userId);

  const [phase, setPhase] = useState<Phase>(auto ? "countdown" : "confirm");
  const [count, setCount] = useState(COUNTDOWN_FROM);
  const [alertId, setAlertId] = useState<string | null>(null);
  const [hasLocation, setHasLocation] = useState(true);
  // Responders the rider has acknowledged with "Stay"; a later reach re-prompts.
  const [stayedIds, setStayedIds] = useState<Set<string>>(new Set());
  // Inline "Cancel your SOS request?" confirm, shown over the sent screen.
  const [confirmCancel, setConfirmCancel] = useState(false);

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

  // Fall into no-ride only before any action has been taken.
  useEffect(() => {
    if (!loading && !rideId && phase === "confirm") setPhase("no-ride");
  }, [loading, rideId, phase]);

  // Once the countdown ends, clear the auto flag (same-path replace keeps phase
  // state) so a later cancel word no longer navigates home from the sent screen.
  useEffect(() => {
    if (phase !== "countdown" && auto) {
      navigate(location.pathname, { replace: true, state: { auto: false } });
    }
  }, [phase, auto, navigate, location.pathname]);

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
    if (!alertId || !rideId || !userId) {
      // Nothing to cancel server-side; just leave the SOS screen.
      setPhase("cancelled");
      return;
    }
    try {
      await cancelSosAlert(alertId, rideId, userId);
      setPhase("cancelled");
    } catch {
      // RPC failed → the SOS is NOT cancelled. Stay on the sent screen so the
      // rider can retry; the failure is logged in cancelSosAlert.
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
        <p style={bodyStyle}>Say 'cancel' or tap Cancel to stop.</p>
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
        <h1 style={headingStyle}>Sending your location…</h1>
        <Button variant="danger" loading>
          Send SOS
        </Button>
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
