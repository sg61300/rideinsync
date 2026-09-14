// send-sos-email — emails a rider's emergency contact(s) when an SOS is raised.
// Companion to push-notify: push reaches fellow riders' devices; this reaches
// the off-ride emergency contact by email. Invoked fire-and-forget by the
// client (src/lib/sosEmail.ts triggerSosEmail) right after raise_sos_alert
// succeeds — so it must never be on the SOS critical path, and returns 200 even
// when it does nothing, so the caller's fire-and-forget contract holds.
//
// Request body: { alert_id: string } (also accepts { ride_id, sender_user_id }
// for parity with push-notify, but alert_id is authoritative). The caller's JWT
// must belong to the alert's own user_id — otherwise this could be used to spam
// email at other riders' contacts under a spoofed identity.
//
// Provider: Gmail SMTP (smtp.gmail.com) via nodemailer, behind a tiny
// sendEmail() so it can be swapped. The sender is a dedicated Gmail account used
// only for emergency-contact mail (founder decision). Secrets (never client env
// vars):
//   GMAIL_USER          — the Gmail address (also the From)
//   GMAIL_APP_PASSWORD  — a Gmail App Password (NOT the account password)
// If either is missing we log and return 200 { skipped: true } — SOS never fails
// because email isn't configured on a deploy.
//
// The Gmail account needs 2-Step Verification enabled and an App Password
// generated (Google Account → Security → App passwords). Gmail SMTP is capped at
// ~500 recipients/day for a free account — fine for emergency-contact volume,
// but revisit (a transactional provider) if that ceiling is ever a risk.
//
// One-time deploy (needs your own Supabase CLI login — cannot be done from the
// repo alone):
//   supabase secrets set GMAIL_USER=you@gmail.com GMAIL_APP_PASSWORD='xxxx xxxx xxxx xxxx'
//   supabase functions deploy send-sos-email
//   supabase db push        # applies 0030_emergency_contact_email.sql

import { createClient } from "npm:@supabase/supabase-js@2.45.0";
import nodemailer from "npm:nodemailer@6";
import {
  buildSosEmailContent,
  emailRecipients,
  type SosEmailContent,
  type SosEmailLocation,
} from "../_shared/sosEmailContent.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GMAIL_USER = Deno.env.get("GMAIL_USER");
const GMAIL_APP_PASSWORD = Deno.env.get("GMAIL_APP_PASSWORD");

const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Lazily built (and reused) SMTP transport — only constructed once the secrets
// have been checked, so a missing-credentials deploy never reaches here.
let transporter: ReturnType<typeof nodemailer.createTransport> | null = null;
function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    });
  }
  return transporter;
}

/** Swappable provider seam. Sends one email via Gmail SMTP. Throws on failure. */
async function sendEmail(to: string, content: SosEmailContent): Promise<void> {
  await getTransporter().sendMail({
    from: GMAIL_USER,
    to,
    subject: content.subject,
    text: content.text,
    html: content.html,
  });
}

/** Parse the SOS alert payload's optional location into the email shape. */
function locationFromPayload(payload: unknown): SosEmailLocation {
  const loc = (payload as { location?: unknown } | null)?.location;
  if (!loc || typeof loc !== "object") return null;
  const l = loc as { lat?: unknown; lng?: unknown; accuracy?: unknown; recorded_at?: unknown };
  if (typeof l.lat !== "number" || typeof l.lng !== "number") return null;
  return {
    lat: l.lat,
    lng: l.lng,
    accuracy: typeof l.accuracy === "number" ? l.accuracy : null,
    recorded_at: typeof l.recorded_at === "string" ? l.recorded_at : null,
  };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  // Secrets missing → do nothing, but never fail the SOS. Checked first so an
  // unconfigured deploy short-circuits before any DB work.
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    console.log("[send-sos-email] GMAIL_USER / GMAIL_APP_PASSWORD not set; skipping");
    return json({ skipped: true, reason: "no_smtp_credentials" });
  }

  let body: { alert_id?: string; event?: string };
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  const alertId = body.alert_id;
  if (!alertId) {
    console.warn("[send-sos-email] missing alert_id");
    return new Response("Missing alert_id", { status: 400 });
  }
  // "cancelled" sends the stand-down notice; anything else (incl. absent) is the
  // original raised alert. Keeps the raised path unchanged.
  const event: "raised" | "cancelled" = body.event === "cancelled" ? "cancelled" : "raised";
  console.log("[send-sos-email] request", { alertId, event });

  // Load the alert (service role — bypasses RLS to read the payload/user_id).
  const { data: alert, error: alertErr } = await serviceClient
    .from("sos_alerts")
    .select("id, ride_id, user_id, payload, triggered_at")
    .eq("id", alertId)
    .maybeSingle();
  if (alertErr) {
    console.error("[send-sos-email] alert lookup failed", alertErr.message);
    return new Response("Alert lookup failed", { status: 500 });
  }
  if (!alert) {
    console.warn("[send-sos-email] alert not found", alertId);
    return new Response("Alert not found", { status: 404 });
  }

  // The caller must be the rider who raised this alert.
  const authHeader = req.headers.get("Authorization") ?? "";
  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: caller, error: authErr } = await callerClient.auth.getUser();
  if (authErr || caller.user?.id !== alert.user_id) {
    console.warn("[send-sos-email] unauthorized caller for alert", alertId);
    return new Response("Unauthorized", { status: 401 });
  }

  // Emergency contacts with an email on file.
  const { data: contacts, error: contactErr } = await serviceClient
    .from("emergency_contacts")
    .select("name, email")
    .eq("user_id", alert.user_id)
    .not("email", "is", null);
  if (contactErr) {
    console.error("[send-sos-email] contact lookup failed", contactErr.message);
    return new Response("Contact lookup failed", { status: 500 });
  }
  const recipients = emailRecipients(contacts ?? []);
  if (recipients.length === 0) {
    console.log("[send-sos-email] no emergency contact email on file; skipping", { alertId });
    return json({ skipped: true, reason: "no_email" });
  }

  // Sender display name + ride name for the email body (best-effort context).
  const [{ data: sender }, { data: ride }] = await Promise.all([
    serviceClient.from("profiles").select("display_name").eq("id", alert.user_id).maybeSingle(),
    serviceClient.from("rides").select("name").eq("id", alert.ride_id).maybeSingle(),
  ]);

  const content = buildSosEmailContent({
    senderName: sender?.display_name ?? null,
    rideName: ride?.name ?? null,
    // Cancel notice carries no location/map link (see the builder).
    location: event === "cancelled" ? null : locationFromPayload(alert.payload),
    triggeredAt: alert.triggered_at ?? null,
    event,
  });

  const results = await Promise.allSettled(recipients.map((to) => sendEmail(to, content)));
  const sent = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.length - sent;
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      console.error(`[send-sos-email] send to ${recipients[i]} failed`, r.reason?.message ?? r.reason);
    }
  });
  console.log("[send-sos-email] done", { alertId, event, recipients: recipients.length, sent, failed });

  return json({ sent, failed });
});
