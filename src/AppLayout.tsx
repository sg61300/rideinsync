import { useEffect, useRef, useState } from "react";
import { Navigate, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "./hooks/useAuth";
import { SignInSheet } from "./components/SignInSheet";
import { AccountBar } from "./components/AccountBar";
import { TabBar } from "./components/ui/TabBar";
import { Loader } from "./components/ui/Loader";
import { SosButton, shouldShowSos, SOS_BUTTON_SIZE, SOS_BUTTON_FOOTPRINT } from "./components/SosButton";
import { HomeWallpaper, shouldShowWallpaper } from "./components/HomeWallpaper";
import { consumePendingJoinCode, consumePendingGroupJoinCode } from "./services/authService";
import { useActiveRide } from "./lib/activeRide";
import { useSosAlerts, useMyRideRole, OPS_ROLES } from "./lib/sos";
import { VoicePermissionSheet } from "./components/VoicePermissionSheet";
import { usePersistedToggle } from "./lib/preference";
import { TOUR_WELCOME_KEY } from "./lib/tour";
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
import { publishBellEvent, publishBellRidePath } from "./lib/notificationBell";

const JOIN_PATH_RE = /^\/join\/([^/]+)$/;
const GROUP_JOIN_PATH_RE = /^\/groups\/join\/([^/]+)$/;
const FEEDBACK_MS = 3_000;
const VOICE_ONBOARDING_KEY = "voice.onboarding.seen";
// Routes a signed-out visitor can browse so they can experience the app
// before creating an account. Anything that would reveal a ride's sharing
// code (the /ride/:id/invite screen reached after a successful create/join)
// stays behind the sign-in gate below.
const PUBLIC_PATHS = new Set(["/", "/ride/create", "/create"]);

// Floating-SOS footprint above the tab bar — SOS_BUTTON_SIZE and the derived
// SOS_BUTTON_FOOTPRINT are owned by SosButton.tsx (single source of truth) and
// re-exported here for the existing footprint tests. When the button is shown,
// the scrolling content wrapper must clear that whole footprint (plus a normal
// `var(--space-lg)` gap) so a control at the very bottom of a page can always
// scroll clear of the button instead of sitting under it. When SOS is hidden the
// padding is unchanged — just the nav clearance. Pure seam so the arithmetic is
// unit-tested.
export { SOS_BUTTON_SIZE, SOS_BUTTON_FOOTPRINT };
export function contentBottomPadding(showSos: boolean): string {
  const navClearance = "var(--tabbar-height) + env(safe-area-inset-bottom)";
  return showSos
    ? `calc(${navClearance} + ${SOS_BUTTON_FOOTPRINT} + var(--space-lg))`
    : `calc(${navClearance} + var(--space-lg))`;
}

// The fixed alert container (own-SOS bar + incoming SosAlertStack) is anchored
// just above the tab bar and paints at z-index 41 — one above the z-40 floating
// SOS button. Full-width, it would otherwise be drawn ACROSS the bottom-right
// button and swallow its taps. When the button is shown we lift the container's
// bottom edge ABOVE the button's footprint (+ a small gap) so the button keeps
// its corner and the alerts stack upward from above it, never intersecting.
// When the button is hidden the container keeps its plain nav clearance.
export function alertContainerBottom(showSos: boolean): string {
  const navClearance = "var(--tabbar-height) + env(safe-area-inset-bottom)";
  return showSos
    ? `calc(${navClearance} + ${SOS_BUTTON_FOOTPRINT} + var(--space-sm))`
    : `calc(${navClearance} + var(--space-sm))`;
}

// Pure decision for a "sync SOS" voice command: where to navigate. Opening /sos
// with { auto: true } makes SosPage start its 5s countdown + auto-send instead
// of sitting in the "confirm" phase waiting for a tap. When the rider is already
// on the /sos screen (any /sos* path), there's nothing to do — SosPage owns the
// flow from there — so this returns null and the caller does nothing extra.
// Unit-tested seam (voiceSosNavigation) so the decision is checked without a DOM.
export function voiceSosNavigation(
  pathname: string,
): { to: string; state: { auto: true } } | null {
  if (pathname.startsWith("/sos")) return null;
  return { to: "/sos", state: { auto: true } };
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
  const { rideId } = useActiveRide(inApp ? userId : null, pathname);

  // AppLayout keeps the incoming-SOS subscription only to drive the critical
  // earcon/haptic and light the AccountBar bell — the SOS cards themselves now
  // render in the ride view's combined Signals card (LiveOps), and the responder
  // actions live there too. The raiser's own status and responses moved with it.
  const alerts = useSosAlerts(inApp ? rideId : null, userId);

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
        // Light the bell so a member off the ride view still sees the SOS.
        publishBellEvent({ id: a.id, kind: "sos", at: Date.now() });
      }
    }
  }, [alerts]);

  // A brief toast when someone else's SOS this device was showing flips to
  // cancelled — the card vanishes on its own (sosCardState hides a resolved
  // alert), so this is just a courtesy stand-down note. Fired once per alert.
  // An alert only enters `alerts` unresolved (useSosAlerts' initial fetch
  // filters resolved out), so `cancelled` here is always a real transition.
  const cancelToastedIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const a of alerts) {
      if (a.cancelled && !cancelToastedIds.current.has(a.id)) {
        cancelToastedIds.current.add(a.id);
        console.info("[sos] cancel toast", { alertId: a.id });
        showVoiceFeedback(`${a.name} cancelled their SOS`);
      }
    }
    // showVoiceFeedback is a stable hoisted declaration; alerts drives this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alerts]);

  // "Sync, ___" wake word + signal command (toggled on Profile). Runs
  // app-wide during an active ride so it works hands-free from any screen,
  // not just the Ride tab. The wake word alone (no signal name) "activates"
  // the app by bringing the live ride view to front.
  const [voiceOn] = usePersistedToggle(VOICE_COMMANDS_KEY, false);
  const [voiceOnboardingSeen, setVoiceOnboardingSeen] = usePersistedToggle(VOICE_ONBOARDING_KEY, false);
  const [tourSeen] = usePersistedToggle(TOUR_WELCOME_KEY, false);
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
      const nav = voiceSosNavigation(pathname);
      if (nav) {
        console.info("[voice] sos command → /sos auto-send");
        navigate(nav.to, { state: nav.state });
      } else {
        console.info("[voice] sos command ignored — already on /sos");
      }
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

  // Role-correct deep-link path for the viewer's active ride: ops crew
  // (leader/co-leader/sweep) must land on /ride/:id/lead (the member view fails
  // for them), everyone else on /ride/:id. Shared by the bell deep-link effect
  // and the bare wake-word activate below so the role rule lives in one place.
  const myRole = useMyRideRole(inApp ? rideId : null, userId);
  const ridePath = rideId
    ? (OPS_ROLES as readonly string[]).includes(myRole ?? "")
      ? `/ride/${rideId}/lead`
      : `/ride/${rideId}`
    : null;

  function handleVoiceActivate() {
    publishVoiceHeard();
    publishVoiceActivate();
    // A bare wake word ("sync") opens the viewer's own active ride, never the
    // ungated /ride/demo (which on production seeds a real demo ride + sim
    // riders). Falls back to the rides list when there is no active ride.
    const to = ridePath ?? "/rides";
    console.info(`[voice] activate → ${to}`);
    navigate(to);
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
    // Light the bell for hazard/regroup/pit-stop from another rider. No stable
    // id from the realtime callback, so mint one — the store dedupes by id.
    publishBellEvent({ id: crypto.randomUUID(), kind, at: Date.now() });
  });

  // Keep the bell store's deep-link path current so the bell opens the ride view
  // the viewer can actually load: ops crew (leader/co-leader/sweep) must land on
  // /ride/:id/lead (LeadViewPage) — the member view fails for them — everyone
  // else on the plain /ride/:id (mirrors resumePath's rule). null (ride ended /
  // left the app) also clears unseen events. While the role is still resolving
  // it is null, so we publish the plain path first and upgrade to /lead once it
  // arrives — an ops rider might briefly deep-link to the member view, but never
  // the reverse (which is the failure mode), and the role settles in one fetch.
  useEffect(() => {
    publishBellRidePath(inApp ? ridePath : null);
  }, [inApp, ridePath]);

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
  // First-run tour: once the voice sheet is dealt with, a rider who hasn't
  // seen the tour is sent to /welcome. Gated to /home so it never interrupts a
  // ride, a join deep-link, or /sos — /welcome clears the flag on exit.
  if (isAuthenticated && pathname === "/home" && !tourSeen) {
    return <Navigate to="/welcome" replace />;
  }
  const showSos = shouldShowSos(inApp, rideId, location.pathname);
  // The welcome tour is a full-screen immersive route (like VoicePermissionSheet
  // above): suppress the app chrome so the TabBar/SOS overlays — which render at
  // the root, above this layout's content wrapper — don't paint over it.
  const onWelcome = pathname === "/welcome";

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

      {/* The fixed SOS strip above the tab bar was removed (2026-09-16 design):
          incoming SOS + the raiser's own status now live in the ride view's
          combined Signals card, and the global entry point is the AccountBar
          bell. AppLayout still owns the SOS subscription (useSosAlerts) purely
          to drive the critical earcon/haptic and the bell. */}

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
      {isAuthenticated && !onWelcome && <TabBar activeRideId={rideId} />}
      {showSos && !onWelcome && (
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
