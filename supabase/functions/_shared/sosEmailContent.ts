// Pure SOS-email body builder. No imports, no Deno/Node/Vite globals — so the
// send-sos-email Edge Function (Deno) imports it directly, and the unit tests
// (src/lib/sosEmail.test.ts, run under Node via esbuild) import the same file
// by relative path. One source of truth for the rendered email, exercised by
// tests: with/without location, with a display name or the "A rider" fallback.

export type SosEmailLocation = {
  lat: number;
  lng: number;
  accuracy?: number | null;
  recorded_at?: string | null;
} | null;

export type SosEmailInput = {
  /** Sender's display name; falls back to "A rider" when null/blank. */
  senderName: string | null;
  /** Ride name for context; omitted from the copy when null/blank. */
  rideName: string | null;
  /** Best-effort location from the SOS payload, or null when unavailable. */
  location: SosEmailLocation;
  /** ISO timestamp the alert was raised, for the email body. */
  triggeredAt?: string | null;
  /** "raised" (default) sends the alert email; "cancelled" sends the stand-down
   *  notice — "<name> has cancelled their SOS" + time, no location/map link. */
  event?: "raised" | "cancelled";
};

export type SosEmailContent = { subject: string; text: string; html: string };

export type SosEmailContact = { name?: string | null; email?: string | null };

/**
 * Pure recipient selection: from the rider's emergency contacts, the distinct
 * non-blank emails (trimmed + lowercased) to send the SOS email to. 0 contacts
 * (or none with an email) → [], which the caller treats as "skip, no_email".
 */
export function emailRecipients(contacts: SosEmailContact[]): string[] {
  const seen = new Set<string>();
  for (const c of contacts) {
    const email = (c.email ?? "").trim().toLowerCase();
    if (email) seen.add(email);
  }
  return [...seen];
}

/** Google Maps deep link for a coordinate, per the brief. */
export function mapsLink(lat: number, lng: number): string {
  return `https://maps.google.com/?q=${lat},${lng}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function displayName(name: string | null): string {
  const n = (name ?? "").trim();
  return n || "A rider";
}

/** Builds the plain-text + HTML SOS email. Pure and deterministic. */
export function buildSosEmailContent(input: SosEmailInput): SosEmailContent {
  const name = displayName(input.senderName);
  const ride = (input.rideName ?? "").trim();
  const when = (input.triggeredAt ?? "").trim();

  // Cancel notice: the raiser stood the SOS down. No location / map link — the
  // emergency is over; the contact just needs to know it was cancelled.
  if (input.event === "cancelled") {
    const subject = ride
      ? `${name} has cancelled their SOS on ${ride}`
      : `${name} has cancelled their SOS`;
    const clines: string[] = [];
    clines.push(`${name} has cancelled their SOS. They are no longer requesting help.`);
    if (ride) clines.push(`Ride: ${ride}`);
    if (when) clines.push(`Original SOS raised at: ${when}`);
    clines.push("");
    clines.push("This message was sent automatically by RideInSync.");
    const ctext = clines.join("\n");

    const chtml: string[] = [];
    chtml.push(`<h2 style="margin:0 0 12px">SOS cancelled by ${escapeHtml(name)}</h2>`);
    chtml.push(
      `<p style="margin:0 0 8px">${escapeHtml(name)} has cancelled their SOS. They are no longer requesting help.</p>`,
    );
    if (ride) chtml.push(`<p style="margin:0 0 8px"><strong>Ride:</strong> ${escapeHtml(ride)}</p>`);
    if (when) chtml.push(`<p style="margin:0 0 8px"><strong>Original SOS raised at:</strong> ${escapeHtml(when)}</p>`);
    chtml.push(
      `<p style="margin:16px 0 0;color:#666;font-size:13px">This message was sent automatically by RideInSync.</p>`,
    );
    return { subject, text: ctext, html: chtml.join("") };
  }

  const subject = ride ? `SOS: ${name} needs help on ${ride}` : `SOS: ${name} needs help`;

  const lines: string[] = [];
  lines.push(`${name} has raised an SOS and may need urgent help.`);
  if (ride) lines.push(`Ride: ${ride}`);
  if (when) lines.push(`Raised at: ${when}`);
  if (input.location) {
    const link = mapsLink(input.location.lat, input.location.lng);
    lines.push(`Last known location: ${link}`);
    if (input.location.accuracy != null) {
      lines.push(`(location accuracy ~${Math.round(input.location.accuracy)} m)`);
    }
  } else {
    lines.push("Location was not available at the time of the alert.");
  }
  lines.push("");
  lines.push("Please try to reach them. This message was sent automatically by RideInSync.");

  const text = lines.join("\n");

  const htmlParts: string[] = [];
  htmlParts.push(`<h2 style="margin:0 0 12px">SOS from ${escapeHtml(name)}</h2>`);
  htmlParts.push(`<p style="margin:0 0 8px">${escapeHtml(name)} has raised an SOS and may need urgent help.</p>`);
  if (ride) htmlParts.push(`<p style="margin:0 0 8px"><strong>Ride:</strong> ${escapeHtml(ride)}</p>`);
  if (when) htmlParts.push(`<p style="margin:0 0 8px"><strong>Raised at:</strong> ${escapeHtml(when)}</p>`);
  if (input.location) {
    const link = mapsLink(input.location.lat, input.location.lng);
    const acc = input.location.accuracy != null ? ` (~${Math.round(input.location.accuracy)} m accuracy)` : "";
    htmlParts.push(
      `<p style="margin:0 0 8px"><strong>Last known location:</strong> ` +
        `<a href="${escapeHtml(link)}">${escapeHtml(link)}</a>${escapeHtml(acc)}</p>`,
    );
  } else {
    htmlParts.push(`<p style="margin:0 0 8px">Location was not available at the time of the alert.</p>`);
  }
  htmlParts.push(
    `<p style="margin:16px 0 0;color:#666;font-size:13px">Please try to reach them. This message was sent automatically by RideInSync.</p>`,
  );

  const html = htmlParts.join("");

  return { subject, text, html };
}
