import test from "node:test";
import assert from "node:assert/strict";
import { normalizeEmail, isValidEmail, triggerSosEmail } from "./sosEmail";
import {
  buildSosEmailContent,
  emailRecipients,
  mapsLink,
} from "../../supabase/functions/_shared/sosEmailContent";
// Aliased to scripts/test/supabaseMock.ts by the unit-test bundler — mutating
// its `functions` here exercises triggerSosEmail's error paths.
import { supabase } from "./supabase";

// ---- email validation / normalisation --------------------------------------

test("normalizeEmail trims + lowercases, and empties null/blank", () => {
  assert.equal(normalizeEmail("  Priya@Example.COM "), "priya@example.com");
  assert.equal(normalizeEmail("\tA@B.co\n"), "a@b.co");
  assert.equal(normalizeEmail(""), "");
  assert.equal(normalizeEmail("   "), "");
  assert.equal(normalizeEmail(null), "");
  assert.equal(normalizeEmail(undefined), "");
});

test("isValidEmail accepts sane addresses and rejects malformed ones", () => {
  for (const ok of ["a@b.co", "priya.sharma@example.com", "x+y@sub.domain.io"]) {
    assert.equal(isValidEmail(ok), true, `${ok} should be valid`);
  }
  for (const bad of ["", "plainaddress", "no@dot", "@no-local.com", "no-domain@", "a @b.com", "a@b.com ", "two@@b.com"]) {
    assert.equal(isValidEmail(bad), false, `${bad} should be invalid`);
  }
});

// ---- recipient selection (0 / 1 / 2 contacts) ------------------------------

test("emailRecipients filters, normalises and dedupes contact emails", () => {
  assert.deepEqual(emailRecipients([]), [], "0 contacts");
  assert.deepEqual(emailRecipients([{ name: "No email", email: null }]), [], "contact without email");
  assert.deepEqual(emailRecipients([{ name: "One", email: " One@Example.com " }]), ["one@example.com"], "1 contact");
  assert.deepEqual(
    emailRecipients([
      { name: "A", email: "a@x.com" },
      { name: "B", email: "B@X.com" },
    ]),
    ["a@x.com", "b@x.com"],
    "2 contacts",
  );
  assert.deepEqual(
    emailRecipients([
      { name: "A", email: "same@x.com" },
      { name: "A2", email: "SAME@x.com" },
    ]),
    ["same@x.com"],
    "duplicate collapses",
  );
});

// ---- email body / template builder -----------------------------------------

test("buildSosEmailContent renders location as a Google Maps link", () => {
  const c = buildSosEmailContent({
    senderName: "Alex R.",
    rideName: "Nandi Hills Run",
    location: { lat: 12.34, lng: 56.78, accuracy: 15, recorded_at: "2026-09-14T10:00:00Z" },
    triggeredAt: "2026-09-14T10:00:00Z",
  });
  assert.equal(c.subject, "SOS: Alex R. needs help on Nandi Hills Run");
  const link = mapsLink(12.34, 56.78);
  assert.equal(link, "https://maps.google.com/?q=12.34,56.78");
  assert.ok(c.text.includes(link), "text has maps link");
  assert.ok(c.text.includes("Nandi Hills Run"), "text has ride name");
  assert.ok(c.text.includes("~15 m"), "text has rounded accuracy");
  assert.ok(c.html.includes(`href="${link}"`), "html has anchor to maps link");
});

test("buildSosEmailContent handles a missing location", () => {
  const c = buildSosEmailContent({ senderName: "Alex", rideName: "Ride X", location: null });
  assert.ok(c.text.includes("Location was not available"), "text notes missing location");
  assert.ok(c.html.includes("Location was not available"), "html notes missing location");
  assert.ok(!c.text.includes("maps.google.com"), "no maps link when no location");
});

test("buildSosEmailContent falls back to 'A rider' and drops ride when blank", () => {
  const c = buildSosEmailContent({ senderName: null, rideName: "", location: null });
  assert.equal(c.subject, "SOS: A rider needs help", "no ride name in subject");
  assert.ok(c.text.startsWith("A rider has raised an SOS"), "fallback display name");
  assert.ok(!c.text.includes("Ride:"), "no ride line when ride name blank");

  const c2 = buildSosEmailContent({ senderName: "   ", rideName: null, location: null });
  assert.ok(c2.text.startsWith("A rider has raised an SOS"), "whitespace name also falls back");
});

test("buildSosEmailContent escapes HTML in dynamic fields", () => {
  const c = buildSosEmailContent({ senderName: 'Ann <b>"x"</b>', rideName: "R&D ride", location: null });
  assert.ok(c.html.includes("Ann &lt;b&gt;&quot;x&quot;&lt;/b&gt;"), "name escaped in html");
  assert.ok(c.html.includes("R&amp;D ride"), "ride escaped in html");
  // Plain-text stays raw (no escaping needed there).
  assert.ok(c.text.includes('Ann <b>"x"</b>'));
});

// ---- cancelled variant (stand-down notice) ---------------------------------

test("buildSosEmailContent cancelled variant: subject + body, no map link", () => {
  const c = buildSosEmailContent({
    senderName: "Alex R.",
    rideName: "Nandi Hills Run",
    // A cancel notice ignores location; even if one were passed, no link.
    location: { lat: 12.34, lng: 56.78, accuracy: 15, recorded_at: null },
    triggeredAt: "2026-09-14T10:00:00Z",
    event: "cancelled",
  });
  assert.equal(c.subject, "Alex R. has cancelled their SOS on Nandi Hills Run");
  assert.ok(c.text.startsWith("Alex R. has cancelled their SOS"), "text leads with cancel");
  assert.ok(c.text.includes("Nandi Hills Run"), "ride name in text");
  assert.ok(c.text.includes("2026-09-14T10:00:00Z"), "original raised time in text");
  assert.ok(!c.text.includes("maps.google.com"), "no maps link in a cancel notice");
  assert.ok(!c.html.includes("maps.google.com"), "no maps link in cancel html");
  assert.ok(c.html.includes("SOS cancelled by Alex R."), "cancel html heading");
});

test("buildSosEmailContent cancelled variant: falls back to 'A rider', drops blank ride", () => {
  const c = buildSosEmailContent({ senderName: null, rideName: "", location: null, event: "cancelled" });
  assert.equal(c.subject, "A rider has cancelled their SOS", "no ride in subject");
  assert.ok(c.text.startsWith("A rider has cancelled their SOS"), "fallback name");
  assert.ok(!c.text.includes("Ride:"), "no ride line when blank");
});

// ---- triggerSosEmail must never throw / reject -----------------------------

test("triggerSosEmail swallows a rejected invoke (no throw, no unhandled rejection)", async () => {
  const original = (supabase as { functions?: unknown }).functions;
  let called = false;
  (supabase as { functions?: unknown }).functions = {
    invoke: () => {
      called = true;
      return Promise.reject(new Error("boom"));
    },
  };
  try {
    assert.doesNotThrow(() => triggerSosEmail("alert-1"));
    assert.equal(called, true, "invoke was attempted");
    // Let the swallowed rejection settle; an unhandled rejection would fail the run.
    await new Promise((r) => setTimeout(r, 10));
  } finally {
    (supabase as { functions?: unknown }).functions = original;
  }
});

test("triggerSosEmail swallows an { error } result", async () => {
  const original = (supabase as { functions?: unknown }).functions;
  (supabase as { functions?: unknown }).functions = {
    invoke: () => Promise.resolve({ data: null, error: { message: "not deployed" } }),
  };
  try {
    assert.doesNotThrow(() => triggerSosEmail("alert-2"));
    await new Promise((r) => setTimeout(r, 10));
  } finally {
    (supabase as { functions?: unknown }).functions = original;
  }
});

test("triggerSosEmail swallows a synchronous failure (functions client missing)", () => {
  const original = (supabase as { functions?: unknown }).functions;
  (supabase as { functions?: unknown }).functions = undefined; // accessing .invoke throws
  try {
    assert.doesNotThrow(() => triggerSosEmail("alert-3"));
  } finally {
    (supabase as { functions?: unknown }).functions = original;
  }
});
