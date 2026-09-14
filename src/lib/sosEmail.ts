// SOS-email client seam. Two responsibilities:
//   1. Email validation/normalisation (normalizeEmail / isValidEmail) used by
//      the profile UI and onboardingService before an emergency-contact email
//      is persisted.
//   2. triggerSosEmail — fire-and-forget invoke of the send-sos-email Edge
//      Function after an SOS is raised. Mirrors triggerPushNotify
//      (src/lib/pushNotifications.ts): best-effort, must NEVER throw or delay
//      the alert. Wrapped in try/catch so even a synchronous failure (e.g. the
//      functions client being unavailable) is swallowed.
import { supabase } from "./supabase";

// Deliberately simple RFC-ish check: one local part, one domain, a dot in the
// domain, and no whitespace/@ inside either side. Matches the DB CHECK added in
// 0030_emergency_contact_email.sql so client and server agree on what's valid.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Trim + lowercase. Returns "" for null/undefined/blank. */
export function normalizeEmail(raw: string | null | undefined): string {
  return (raw ?? "").trim().toLowerCase();
}

/** True only for a non-empty, structurally-valid email. */
export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email);
}

/**
 * Ask the send-sos-email Edge Function to email the sender's emergency
 * contact(s). Fire-and-forget: any error (function not deployed, offline,
 * functions client missing) is logged and swallowed so the SOS itself is never
 * blocked. Called once in sos.ts right after triggerPushNotify.
 */
export function triggerSosEmail(
  alertId: string,
  opts?: { event?: "raised" | "cancelled" },
): void {
  try {
    // Keep the "raised" body byte-identical to before this change (no `event`
    // key) so the default path — and the edge function's default — is unchanged;
    // only the cancel path adds it.
    const body: { alert_id: string; event?: "cancelled" } = { alert_id: alertId };
    if (opts?.event === "cancelled") body.event = "cancelled";
    void Promise.resolve(
      supabase.functions.invoke("send-sos-email", { body }),
    )
      .then((res) => {
        const error = (res as { error?: { message?: string } } | null)?.error;
        if (error) console.warn("[sos-email] trigger failed", error.message);
      })
      .catch((err) => console.warn("[sos-email] trigger failed", err));
  } catch (err) {
    console.warn("[sos-email] trigger failed", err);
  }
}
