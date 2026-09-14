import type { SignalKind } from "./signals";

// ============================================================================
// Pure whole-utterance matcher for the "sync, <command>" voice flow.
//
// Vosk returns the FULL utterance after each silence, not one word at a time.
// The original handleWord compared that whole string against WAKE_WORD or ran
// it through a single-word lookup, so real speech logged in production as:
//   heard: "sync hazard"            -> not recognized
//   heard: "sync hazard sync hazard" -> not recognized
// Only a rider who paused between the two words (splitting them into two
// separate utterances) inside the grace window ever fired a command.
//
// This function is deliberately pure (no timers, no debounce, no logging) so
// it is unit-testable in isolation; useVoiceCommand keeps the grace-timer and
// debounce semantics around it. It is the single source of truth for the wake
// word and command vocabulary — voiceCommands.ts imports these constants to
// build the Vosk grammar, so grammar and matcher can never drift apart.
// ============================================================================

/** The wake word that must precede a command (unless bare commands are on). */
export const WAKE_WORD = "sync";

/** Command vocabulary. `words` are the accepted spoken forms per signal; a
 *  form may be multiple tokens ("pit stop"). Vosk emits these as separate
 *  whitespace-delimited tokens, so the matcher below matches token sequences. */
export const COMMAND_WORDS: { kind: SignalKind; words: string[] }[] = [
  { kind: "sos", words: ["sos", "emergency"] },
  { kind: "hazard", words: ["hazard"] },
  { kind: "regroup", words: ["regroup"] },
  { kind: "pitstop", words: ["pit stop"] },
];

/** Vosk's catch-all token for out-of-grammar speech; never a command. */
const UNK = "[unk]";

// Flattened command specs as token arrays, so "pit stop" is matched as the two
// tokens Vosk actually emits.
const COMMAND_SPECS: { kind: SignalKind; tokens: string[] }[] = COMMAND_WORDS.flatMap((c) =>
  c.words.map((phrase) => ({ kind: c.kind, tokens: phrase.split(/\s+/) })),
);

export type ParsedUtterance =
  /** Wake word followed by a command, or a bare command when bare mode is on. */
  | { kind: SignalKind }
  /** Bare wake word with no command in this utterance — bring the app forward. */
  | { activate: true }
  /** Command heard with no wake word (bare mode off) — prompt "say sync first". */
  | { kind: SignalKind; needsWake: true }
  /** Empty, only [unk], or nothing recognizable. */
  | null;

type Options = { bareCommandsEnabled?: boolean };

function matchesAt(tokens: string[], at: number, phrase: string[]): boolean {
  if (at + phrase.length > tokens.length) return false;
  for (let i = 0; i < phrase.length; i++) {
    if (tokens[at + i] !== phrase[i]) return false;
  }
  return true;
}

/** First command found at or after `from`, or null. Multi-token commands are
 *  matched as a contiguous sequence. */
function firstCommand(tokens: string[], from: number): SignalKind | null {
  for (let i = from; i < tokens.length; i++) {
    for (const spec of COMMAND_SPECS) {
      if (matchesAt(tokens, i, spec.tokens)) return spec.kind;
    }
  }
  return null;
}

/**
 * Parse a full Vosk utterance into an intent. Pure: no side effects.
 *
 * - wake word + a command after it        -> { kind }
 * - bare wake word (no command)            -> { activate: true }
 * - command, no wake word, bare mode on    -> { kind }
 * - command, no wake word, bare mode off   -> { kind, needsWake: true }
 * - nothing recognizable / empty / [unk]   -> null
 */
export function parseVoiceUtterance(text: string, { bareCommandsEnabled }: Options = {}): ParsedUtterance {
  const tokens = text
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0 && t !== UNK);
  if (tokens.length === 0) return null;

  const wakeIdx = tokens.indexOf(WAKE_WORD);
  if (wakeIdx >= 0) {
    const kind = firstCommand(tokens, wakeIdx + 1);
    return kind ? { kind } : { activate: true };
  }

  const kind = firstCommand(tokens, 0);
  if (kind) return bareCommandsEnabled ? { kind } : { kind, needsWake: true };
  return null;
}
