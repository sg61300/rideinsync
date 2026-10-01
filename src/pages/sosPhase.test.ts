import { test } from "node:test";
import assert from "node:assert/strict";
import { initialSosPhase, shouldConsumeAutoFlag, shouldResumeSentPhase } from "./sosPhase";

// RC-A: a voice auto-send arms the countdown once; a second mount (Back/reload
// onto the same /sos entry, after the flag was consumed) must start in confirm.

test("initialSosPhase: auto true arms the countdown", () => {
  assert.equal(initialSosPhase(true), "countdown");
});

test("initialSosPhase: auto false starts in confirm (Back/reload after consume)", () => {
  assert.equal(initialSosPhase(false), "confirm");
});

test("shouldConsumeAutoFlag: true only while the flag is still set", () => {
  assert.equal(shouldConsumeAutoFlag({ auto: true }), true);
  assert.equal(shouldConsumeAutoFlag({ auto: false }), false);
  assert.equal(shouldConsumeAutoFlag(null), false);
  assert.equal(shouldConsumeAutoFlag(undefined), false);
  assert.equal(shouldConsumeAutoFlag({}), false);
});

// Item 6: resume the sent screen after a reload only from an idle screen, and
// only when the rider still has an unresolved alert. Never mid-countdown, and
// never re-enter once already sent/cancelled.
test("shouldResumeSentPhase: resumes from idle screens with an active alert", () => {
  assert.equal(shouldResumeSentPhase("confirm", true), true);
  assert.equal(shouldResumeSentPhase("no-ride", true), true);
});

test("shouldResumeSentPhase: never resumes without an active alert", () => {
  assert.equal(shouldResumeSentPhase("confirm", false), false);
  assert.equal(shouldResumeSentPhase("no-ride", false), false);
});

test("shouldResumeSentPhase: never resumes mid-flow or from a terminal screen", () => {
  for (const phase of ["countdown", "sending", "sent", "cancelled", "error"] as const) {
    assert.equal(shouldResumeSentPhase(phase, true), false, `phase ${phase} must not resume`);
  }
});
