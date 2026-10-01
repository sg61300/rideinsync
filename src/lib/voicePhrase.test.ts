import test from "node:test";
import assert from "node:assert/strict";
import { parseVoiceUtterance, shouldFireBareCommand, WAKE_WORD, COMMAND_WORDS } from "./voicePhrase";

// The parser is the whole-utterance matcher extracted from useVoiceCommand's
// handleWord. Vosk returns the FULL utterance after silence (e.g. "sync
// hazard"), so equality-against-a-single-word matching — the production bug —
// rejected every real command. These cases pin the tokenised behaviour,
// including the exact strings production logged as "not recognized".

test("bare wake word alone -> activate", () => {
  assert.deepEqual(parseVoiceUtterance("sync", {}), { activate: true });
});

test('production failure: "sync hazard" in one utterance -> hazard command', () => {
  assert.deepEqual(parseVoiceUtterance("sync hazard", {}), { kind: "hazard" });
});

test('production failure: repeated "sync hazard sync hazard" -> one hazard command', () => {
  assert.deepEqual(parseVoiceUtterance("sync hazard sync hazard", {}), { kind: "hazard" });
});

test("wake word + each command word", () => {
  assert.deepEqual(parseVoiceUtterance("sync sos", {}), { kind: "sos" });
  assert.deepEqual(parseVoiceUtterance("sync emergency", {}), { kind: "sos" });
  assert.deepEqual(parseVoiceUtterance("sync regroup", {}), { kind: "regroup" });
});

test('two-token command "pit stop" after wake -> pitstop', () => {
  assert.deepEqual(parseVoiceUtterance("sync pit stop", {}), { kind: "pitstop" });
});

test("command without wake word (bare disabled) -> needs wake", () => {
  assert.deepEqual(parseVoiceUtterance("hazard", {}), { kind: "hazard", needsWake: true });
  assert.deepEqual(parseVoiceUtterance("pit stop", {}), { kind: "pitstop", needsWake: true });
});

test("command without wake word (bare ENABLED) -> fires directly", () => {
  assert.deepEqual(parseVoiceUtterance("hazard", { bareCommandsEnabled: true }), { kind: "hazard" });
  assert.deepEqual(parseVoiceUtterance("pit stop", { bareCommandsEnabled: true }), { kind: "pitstop" });
});

test("bare wake word with bare ENABLED still activates (not a command)", () => {
  assert.deepEqual(parseVoiceUtterance("sync", { bareCommandsEnabled: true }), { activate: true });
});

test("[unk] tokens are ignored", () => {
  assert.deepEqual(parseVoiceUtterance("[unk] sync [unk] hazard", {}), { kind: "hazard" });
  assert.deepEqual(parseVoiceUtterance("[unk]", {}), null);
  assert.deepEqual(parseVoiceUtterance("[unk] sync [unk]", {}), { activate: true });
});

test("empty / whitespace-only -> null", () => {
  assert.deepEqual(parseVoiceUtterance("", {}), null);
  assert.deepEqual(parseVoiceUtterance("   ", {}), null);
});

test("first command AFTER the wake word wins", () => {
  // A command spoken before the wake word does not pre-empt the wake flow.
  assert.deepEqual(parseVoiceUtterance("hazard sync sos", {}), { kind: "sos" });
});

test("wake word with trailing repeats but no command -> activate", () => {
  assert.deepEqual(parseVoiceUtterance("sync sync", {}), { activate: true });
});

test("case and extra whitespace are normalised", () => {
  assert.deepEqual(parseVoiceUtterance("  SYNC   Hazard  ", {}), { kind: "hazard" });
});

test("exports stay in lockstep with the grammar constants", () => {
  assert.equal(WAKE_WORD, "sync");
  assert.ok(COMMAND_WORDS.some((c) => c.kind === "pitstop" && c.words.includes("pit stop")));
});

// Item 5 (founder 2026-09-16, "automatic triggering of SOS"): a command fires
// only when the wake word rode in the SAME utterance (or the picker is open in
// bare mode). A bare command whose wake word was heard as the PREVIOUS
// utterance parses to { kind, needsWake } with bare mode off — and must NOT
// fire, so a stray "sync" one breath earlier can never complete into an SOS.
test("shouldFireBareCommand: wake word + command in one breath fires", () => {
  const parsed = parseVoiceUtterance("sync sos");
  assert.deepEqual(parsed, { kind: "sos" });
  assert.equal(shouldFireBareCommand(parsed, false), true);
});

test("shouldFireBareCommand: bare command with the picker open fires", () => {
  const parsed = parseVoiceUtterance("sos", { bareCommandsEnabled: true });
  assert.deepEqual(parsed, { kind: "sos" });
  assert.equal(shouldFireBareCommand(parsed, true), true);
});

test("shouldFireBareCommand: bare command, wake word heard earlier, does NOT fire", () => {
  // parseVoiceUtterance with bare mode off = the "wake word was a previous
  // utterance" case the grace window used to (wrongly) complete.
  const parsed = parseVoiceUtterance("sos", { bareCommandsEnabled: false });
  assert.deepEqual(parsed, { kind: "sos", needsWake: true });
  assert.equal(shouldFireBareCommand(parsed, false), false);
});

test("shouldFireBareCommand: bare wake word (activate) and null never fire", () => {
  assert.equal(shouldFireBareCommand(parseVoiceUtterance("sync"), false), false);
  assert.equal(shouldFireBareCommand(null, false), false);
  assert.equal(shouldFireBareCommand(parseVoiceUtterance("[unk]"), true), false);
});
