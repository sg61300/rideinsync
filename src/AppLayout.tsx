import { useEffect, useRef, useState } from "react";
import { Navigate, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "./hooks/useAuth";
import { SignInSheet } from "./components/SignInSheet";
import { AccountBar } from "./components/AccountBar";
import { TabBar } from "./components/ui/TabBar";
import { Loader } from "./components/ui/Loader";
import { SosAlertCard } from "./components/SosAlertCard";
import { SosButton, shouldShowSos } from "./components/SosButton";
import { HomeWallpaper, shouldShowWallpaper } from "./components/HomeWallpaper";
import { consumePendingJoinCode, consumePendingGroupJoinCode } from "./services/authService";
import { useActiveRide } from "./lib/activeRide";
import { buildOwnSosStatus, canResolveSos, markReached, resolveSosAlert, respondToSos, sosCardState, useMyRideRole, useOwnSosAlert, useSosAlerts, useSosResponses, type IncomingAlert } from "./lib/sos";
import { VoicePermissionSheet } from "./components/VoicePermissionSheet";
import { usePersistedToggle } from "./lib/preference";
import { useVoiceCommand, VOICE_COMMANDS_KEY } from "./lib/voiceCommands";
import {
  publishVoiceHeard,
  publishVoiceActivate,
  publishVoiceListening,
  publishVoiceError,
  publishVoiceCommandFired,
  useSignalModalOpen,
} from "./lib/voiceActivity";
import { SIGNAL_LABEL, SIGNAL_TIER, sendRideSignal, useRideSignalListener, type SignalKind } from "./lib/signals";
import { playSignalTone } from "./lib/earcon";
import { vibrateForTier } from "./lib/haptics";

const JOIN_PATH_RE = /^\/join\/([^/]+)$/;
const GROUP_JOIN_PATH_RE = /^\/groups\/join\/([^/]+)$/;
const FEEDBACK_MS = 3_000;
const VOICE_ONBOARDING_KEY = "voice.onboarding.seen";
// Routes a signed-out visitor can browse so they can experience the app
// before creating an account. Anything that would reveal a ride's sharing
// code (the /ride/:id/invite screen reached after a successful create/join)
// stays behind the sign-in gate below.
const PUBLIC_PATHS = new Set(["/", "/ride/create", "/create"]);

// Floating-SOS footprint above the tab bar, read (read-only) from SosButton.tsx:
// the button sits `var(--space-md)` above the nav+safe-area and is
// SOS_BUTTON_SIZE px tall. When it is shown, the scrolling content wrapper must
// clear that whole footprint (plus a normal `var(--space-lg)` gap) so a control
// at the very bottom of a page can always scroll clear of the button instead of
// sitting under it. When SOS is hidden the padding is unchanged — just the nav
// clearance. Pure seam so the arithmetic is unit-tested.
export const SOS_BUTTON_SIZE = 60;
export function contentBottomPadding(showSos: boolean): string {
  const navClearance = "var(--tabbar-height) + env(safe-area-inset-bottom)";
  return showSos
    ? `calc(${navClearance} + var(--space-md) + ${SOS_BUTTON_SIZE}px + var(--space-lg))`
    : `calc(${navClearance} + var(--space-lg))`;
}
export function AppLayout() {
  const { loading, isAuthenticated, user } = useAuth();
  const location = useLocation();
  const { pathname } = location;
  const navigate = useNavigate();
  const resumedRef = useRef(false);

  const joinCodeFromPath = pathname.match(JOIN_PATH_RE)?.[1];
  const groupJoinCodeFromPath = pathname.match(GROUP_JOIN_PATH_RE)?.[1];

  // Resume a join interrupted by the Google OAuth redirect: the code was
  // stashed (see authService) before leaving the app, and is restored here
  // once auth resolves — the deep-link `/join/:code` (or `/groups/join/:code`)
  // route may not be where the OAuth provider actually landed us.
  useEffect(() => {
    if (!isAuthenticated || resumedRef.current) return;
    resumedRef.current = true;
    const pendingCode = consumePendingJoinCode();
    if (pendingCode && pendingCode !== joinCodeFromPath) {
      navigate(`/join/${pendingCode}`, { replace: true });
      return;
    }
    const pendingGroupCode = consumePendingGroupJoinCode();
    if (pendingGroupCode && pendingGroupCode !== groupJoinCodeFromPath) {
      navigate(`/groups/join/${pendingGroupCode}`, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated]);

  // SOS wiring (Flow 5). The fork's placeholder useSession() is superseded by
  // this branch's real useAuth — we feed its user id to the SOS hooks directly.
  // `inApp` gates every subscription so nothing opens on the public landing.
  // Raising an SOS only happens via Signal on the Ride screen now; this stays
  // global so an alert already in progress is never missed on another tab.
  const userId = isAuthenticated ? user?.id ?? null : null;

  const inApp = isAuthenticated && pathname !== "/";
  const { rideId } = useActiveRide(inApp ? userId : null);

  const alerts = useSosAlerts(inApp ? rideId : null, userId);
  const responsesByAlert = useSosResponses(inApp ? rideId : null);
  // The raiser's OWN unresolved alert (useSosAlerts filters it out). Drives a
  // "help is coming" bar shown to the raiser on every in-app screen but /sos,
  // which has its own responder list. Hidden on /sos to avoid doubling up.
  const ownAlert = useOwnSosAlert(inApp ? rideId : null, userId);
  const showOwnSosBar = Boolean(ownAlert) && pathname !== "/sos";
  const myRole = useMyRideRole(inApp ? rideId : null, userId);
  const canResolve = canResolveSos(myRole);

  // A card is shown until any responder reaches the rider; it returns only if the
  // rider taps Stay (stay_requested_at > that reach). No local hide state.
  const visibleAlerts = alerts
    .map((a) => ({ alert: a, ...sosCardState(a, responsesByAlert[a.id] ?? []) }))
    .filter((x) => x.visible);

  // In-app sound (§7d/§7e) for incoming SOS — Critical tier, 3 beeps. `alerts`
  // already excludes the current user's own (useSosAlerts filters self out),
  // so this only ever tones for someone *else's* SOS landing on this device.
  // Tracked by id, not just "alerts.length > 0", so it fires once per alert
  // rather than replaying every time this component re-renders.
  const tonedAlertIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const a of alerts) {
      if (!tonedAlertIds.current.has(a.id)) {
        tonedAlertIds.current.add(a.id);
        playSignalTone("critical");
        vibrateForTier("critical");
      }
    }
  }, [alerts]);

  function handleRespond(alertId: string) {
    if (!rideId || !userId) return;
    void respondToSos(alertId, rideId, userId).catch(() => {
      /* logged in respondToSos; unique-constraint clashes are expected */
    });
  }

  function handleReached(responseId: string) {
    void markReached(responseId).catch(() => {
      /* logged in markReached */
    });
  }

  function handleResolve(alert: IncomingAlert) {
    if (!rideId || !userId) return Promise.reject(new Error("Not in a ride."));
    return resolveSosAlert({
      alertId: alert.id,
      rideId,
      riderUserId: alert.userId,
      riderName: alert.name,
      riderTriggeredAt: alert.triggeredAt,
      resolverUserId: userId,
    }).then(() => {});
  }

  // "Sync, ___" wake word + signal command (toggled on Profile). Runs
  // app-wide during an active ride so it works hands-free from any screen,
  // not just the Ride tab. The wake word alone (no signal name) "activates"
  // the app by bringing the live ride view to front.
  const [voiceOn] = usePersistedToggle(VOICE_COMMANDS_KEY, false);
  const [voiceOnboardingSeen, setVoiceOnboardingSeen] = usePersistedToggle(VOICE_ONBOARDING_KEY, false);
  const [voiceFeedback, setVoiceFeedback] = useState<string | null>(null);
  const voiceFeedbackTimer = useRef<number | null>(null);

  // Two-stage feedback for commands: "Sync heard" fires the instant the wake
  // word is recognized, then gets replaced by the actual outcome once the
  // (async) signal send resolves — so there's never a silent gap between
  // saying "sync" and seeing *something* happen on screen.
  function showVoiceFeedback(message: string) {
    if (voiceFeedbackTimer.current != null) window.clearTimeout(voiceFeedbackTimer.current);
    setVoiceFeedback(message);
    voiceFeedbackTimer.current = window.setTimeout(() => setVoiceFeedback(null), FEEDBACK_MS);
  }

  function handleVoiceCommand(kind: SignalKind) {
    publishVoiceHeard();
    publishVoiceCommandFired();
    showVoiceFeedback("Sync heard");
    if (!rideId || !userId) return;
    if (kind === "sos") {
      navigate("/sos");
      return;
    }
    // Fired immediately rather than after the send resolves — a voice
    // command has no user gesture of its own to unlock the AudioContext, so
    // this only makes sound once VoicePermissionSheet's onboarding tap has
    // already primed it (see primeAudioContext), but firing it eagerly at
    // least avoids adding the network round-trip's delay on top of that.
    playSignalTone(SIGNAL_TIER[kind]);
    void sendRideSignal(rideId, userId, kind, `Voice-signalled ${kind}`).then(() => {
      showVoiceFeedback(`${SIGNAL_LABEL[kind]} signalled`);
    });
  }

  function handleVoiceActivate() {
    publishVoiceHeard();
    publishVoiceActivate();
    navigate("/ride/demo");
    showVoiceFeedback("Sync activated");
  }

  const signalModalOpen = useSignalModalOpen();

  // The receiving half of handleVoiceCommand/the Signal modal's sends: every
  // other member with the app open sees a toast when someone raises hazard/
  // regroup/pit-stop, the same way SOS alerts are global rather than scoped
  // to the Ride tab. The sender is excluded server-round-trip-side (see
  // useRideSignalListener) so they don't get a duplicate of their own toast.
  useRideSignalListener(inApp ? rideId : null, userId, (kind) => {
    playSignalTone(SIGNAL_TIER[kind]);
    vibrateForTier(SIGNAL_TIER[kind]);
    showVoiceFeedback(`${SIGNAL_LABEL[kind]} signalled`);
  });

  const voice = useVoiceCommand({
    enabled: inApp && Boolean(rideId) && voiceOn,
    onCommand: handleVoiceCommand,
    onActivate: handleVoiceActivate,
    bareCommandsEnabled: signalModalOpen,
  });

  useEffect(() => {
    publishVoiceListening(voice.listening);
  }, [voice.listening]);

  useEffect(
    () => () => {
      if (voiceFeedbackTimer.current != null) window.clearTimeout(voiceFeedbackTimer.current);
    },
    [],
  );

  useEffect(() => {
    publishVoiceError(voice.error);
  }, [voice.error]);

  if (loading) {
    // Brief beat while the initial session check resolves — avoids flashing
    // the landing/login for an already-authenticated user.
    return (
      <div style={{ minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Loader size={64} />
      </div>
    );
  }

  const onLanding = pathname === "/";

  // Landing ("/") is the public login entry. Signed-in users skip it and go
  // straight to the home screen.
  if (isAuthenticated && onLanding) {
    return <Navigate to="/home" replace />;
  }
  // A protected route without a session: keep the join deep-link's sign-in
  // sheet (it stashes the code across the Google redirect); PUBLIC_PATHS
  // (landing, create) stay browsable so a visitor can try the app before
  // making an account; everything else bounces to the landing to log in.
  if (!isAuthenticated && !PUBLIC_PATHS.has(pathname)) {
    if (joinCodeFromPath) return <SignInSheet joinCode={joinCodeFromPath} />;
    if (groupJoinCodeFromPath) return <SignInSheet groupJoinCode={groupJoinCodeFromPath} />;
    return <Navigate to="/" replace />;
  }
  // One-time, right after sign-in: ask for mic access up front so it's already
  // granted by the time a rider wants hands-free voice commands mid-ride.
  // Gated to /home only — this used to intercept every route (including the
  // public/landing root), which showed the sheet before a rider had even
  // reached the app's home screen.
  if (isAuthenticated && pathname === "/home" && !voiceOnboardingSeen) {
    return <VoicePermissionSheet onDone={() => setVoiceOnboardingSeen(true)} />;
  }
  const showSos = shouldShowSos(inApp, rideId, location.pathname);

  return (
    <>
      {shouldShowWallpaper(location.pathname) && <HomeWallpaper />}

      <div
        style={{
          // Lift above the fixed HomeWallpaper (z-index 0): a static element
          // would otherwise paint *under* a positioned z-index:0 sibling.
          position: "relative",
          zIndex: 1,
          maxWidth: 600,
          minHeight: "100%",
          margin: "0 auto",
          padding: "var(--space-lg) var(--gutter)",
          // Clear the fixed TabBar — and, when the floating SOS button is shown,
          // its footprint too, so a bottom-edge control can scroll clear of it.
          paddingBottom: isAuthenticated
            ? contentBottomPadding(showSos)
            : "calc(var(--space-2xl) + env(safe-area-inset-bottom))",
        }}
      >
        {isAuthenticated && <AccountBar />}
        <Outlet />
      </div>

      {inApp && (visibleAlerts.length > 0 || showOwnSosBar) && (
        <div
          style={{
            position: "fixed",
            left: 0,
            right: 0,
            // Above the TabBar.
            bottom:
              "calc(var(--tabbar-height) + env(safe-area-inset-bottom) + var(--space-sm))",
            zIndex: 41,
            maxWidth: 600,
            margin: "0 auto",
            padding: "0 var(--gutter)",
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-sm)",
          }}
        >
          {showOwnSosBar && ownAlert && (
            <button
              type="button"
              onClick={() => navigate("/sos")}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "var(--space-sm)",
                width: "100%",
                textAlign: "left",
                padding: "var(--space-xs) var(--space-md)",
                borderRadius: "var(--radius-md)",
                background: "var(--color-surface-2)",
                border: "1px solid var(--color-divider)",
                boxShadow: "var(--shadow-card, 0 8px 24px rgba(0,0,0,.5))",
                color: "var(--color-text-primary)",
                fontSize: "var(--text-body-strong)",
                fontWeight: "var(--weight-semibold)" as unknown as number,
                cursor: "pointer",
              }}
            >
              <span style={{ minWidth: 0 }}>
                {buildOwnSosStatus(responsesByAlert[ownAlert.id] ?? [])}
              </span>
              <span
                style={{
                  flexShrink: 0,
                  color: "var(--color-text-secondary)",
                  fontSize: "var(--text-label)",
                  fontWeight: "var(--weight-regular)" as unknown as number,
                }}
              >
                View
              </span>
            </button>
          )}
          {visibleAlerts.map(({ alert: a, still }) => (
            <SosAlertCard
              key={a.id}
              name={a.name}
              triggeredAt={a.triggeredAt}
              responders={responsesByAlert[a.id] ?? []}
              selfUserId={userId}
              still={still}
              onRespond={() => handleRespond(a.id)}
              onReached={handleReached}
              canResolve={canResolve}
              onResolve={() => handleResolve(a)}
            />
          ))}
        </div>
      )}

      {voiceFeedback && (
        <div
          style={{
            position: "fixed",
            left: 0,
            right: 0,
            bottom: "calc(var(--tabbar-height) + env(safe-area-inset-bottom) + var(--space-sm))",
            zIndex: 42,
            display: "flex",
            justifyContent: "center",
            pointerEvents: "none",
          }}
        >
          <span
            style={{
              background: "var(--color-inverse-surface)",
              color: "var(--color-text-on-inverse)",
              padding: "8px 16px",
              borderRadius: "var(--radius-full)",
              fontSize: "var(--text-label)",
              fontWeight: "var(--weight-semibold)" as unknown as number,
            }}
          >
            {voiceFeedback}
          </span>
        </div>
      )}
      {isAuthenticated && <TabBar activeRideId={rideId} />}
      {showSos && (
        // Floating corner SOS: shown ONLY to a member of a started ride, and
        // never on the /sos screen itself (that screen has its own Send SOS
        // button). Taps open the /sos confirm screen. z-index 40 keeps it above
        // page content but below the SosAlert stack (41) and voice feedback
        // (42). Voice toggle is intentionally off here — this branch drives
        // voice via VoicePermissionSheet + the persisted VOICE_COMMANDS toggle,
        // not a mic button (see handoff).
        <SosButton
          showVoiceToggle={false}
          voiceOn={voiceOn}
          voiceSupported={voice.supported}
          voiceListening={voice.listening}
          voiceError={voice.error}
          onToggleVoice={() => {}}
        />
      )}
    </>
  );
}
