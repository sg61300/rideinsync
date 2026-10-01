// Pure SOS-phase helpers, split out of SosPage so they can be unit-tested
// without mounting React. See RC-A in the sos-cancel-fix handoff: the voice
// command navigates to /sos with { auto: true }, which must arm the countdown
// exactly once — a Back gesture or reload landing on that same history entry
// must NOT re-arm it.

export type Phase =
  | "no-ride"
  | "confirm"
  | "countdown"
  | "sending"
  | "sent"
  | "cancelled"
  | "error";

/** Starting phase for a fresh SosPage mount: countdown only when auto-armed. */
export function initialSosPhase(auto: boolean): Phase {
  return auto ? "countdown" : "confirm";
}

/**
 * Whether this mount should consume the auto flag (replace history state with
 * { auto: false }). True only while the flag is still set; once consumed a
 * Back/reload onto /sos sees auto === false and starts in "confirm".
 */
export function shouldConsumeAutoFlag(state: { auto?: boolean } | null | undefined): boolean {
  return Boolean(state?.auto);
}

/**
 * Whether to re-enter the "sent" screen for an SOS still active on the backend
 * (Item 6 — reload / PWA relaunch). Resume only from an idle screen ("confirm"
 * or "no-ride"): a fresh reload lands on "confirm" but the rider's alert is
 * still unresolved server-side, so surface the Cancel-SOS controls and restart
 * tracking instead of showing a dead confirm. Never resume mid-countdown,
 * mid-send, or once already on "sent"/"cancelled"/"error".
 */
export function shouldResumeSentPhase(phase: Phase, hasOwnAlert: boolean): boolean {
  return hasOwnAlert && (phase === "confirm" || phase === "no-ride");
}
