import test from "node:test";
import assert from "node:assert/strict";
import { parseVoiceUtterance, WAKE_WORD, COMMAND_WORDS } from "./voicePhrase";

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
