import { useEffect, useRef, useState } from "react";
// Dynamically imported (see getModel below) — vosk-browser bundles its WASM
// engine inline and is multiple MB by itself. A static import here would pull
// all of it into AppLayout's chunk (loaded on every route, voice on or off),
// which is exactly what blew the production build's PWA precache budget the
// first time this was wired up statically.
import type { Model, KaldiRecognizer } from "vosk-browser";
import { SIGNAL_LABEL, type SignalKind } from "./signals";
import { publishVoiceAudioLevel, publishVoiceDetection, publishVoicePartial } from "./voiceActivity";
// The wake word, command vocabulary, and the whole-utterance matcher live in
// voicePhrase.ts (pure + unit-tested). Importing them here keeps the Vosk
// grammar below and the matcher on one single source of truth.
import { WAKE_WORD, COMMAND_WORDS, parseVoiceUtterance } from "./voicePhrase";

// ============================================================================
// "Sync, ___" wake word + signal command, via Vosk (on-device, WASM, grammar-
// constrained speech recognition — see https://github.com/ccoreilly/vosk-browser).
//
// This replaces an earlier Web Speech API (webkitSpeechRecognition) version.
// That engine is a free-dictation model tuned for natural sentences, and
// console logs from real use showed it consistently mis-hearing the bare word
// "sync" as "think" / "Singh" / "sink" — a fundamental accuracy problem, not
// a bug, since a dictation model biases toward "plausible sentences" over a
// context-free syllable. Vosk's `grammar` parameter constrains recognition to
// only the words we actually care about (see GRAMMAR below), which is what
// actually fixes it, rather than chasing more mis-heard aliases.
//
// Side benefits over the Web Speech API: runs fully offline after the model
// loads (no more "network" errors reaching Google's speech backend), and
// works in browsers that never had Web Speech support at all (Firefox, Safari).
// Trade-off: a ~40MB one-time model download, and unlike Web Speech there's no
// company/account signup gate — this library needs neither.
//
// All logs are prefixed "[voice]".
// ============================================================================

/** localStorage key for the on/off preference (Profile page reads/writes it
 *  via usePersistedToggle; AppLayout reads it to gate the listener). */
export const VOICE_COMMANDS_KEY = "voice.commands";

// Community-hosted build of the standard small English Vosk model (the same
// one linked from the library's own README/demo). ~40MB, fetched once and
// cached by the browser's own HTTP cache thereafter.
const MODEL_URL = "https://ccoreilly.github.io/vosk-browser/models/vosk-model-small-en-us-0.15.tar.gz";
const SAMPLE_RATE = 16_000;

// The fixed vocabulary Vosk is allowed to output. "[unk]" is Vosk's standard
// catch-all for speech that doesn't match anything else in the grammar —
// without it, every utterance gets forced into the closest grammar word,
// which would misfire constantly on ordinary conversation. Built from the same
// WAKE_WORD/COMMAND_WORDS the matcher uses, so the two never drift.
const GRAMMAR = JSON.stringify([
  "[unk]",
  WAKE_WORD,
  ...COMMAND_WORDS.flatMap((c) => c.words),
]);

// How long after "recognition started" without a single onaudioprocess
// callback before we warn: this is the signature of a ScriptProcessorNode with
// no path to the destination (Chromium won't pull it), which produced 0
// callbacks in 5s in production and total silence with nothing in the console.
const AUDIOPROCESS_WATCHDOG_MS = 3_000;

// Shorter than the old SOS-only debounce: these are routine, repeatable
// actions, not a one-shot distress trigger.
const DEBOUNCE_MS = 4_000;
// How long to wait after a bare wake word, with no command following, before
// treating it as "just activate" rather than a command still being spoken.
const ACTIVATE_GRACE_MS = 1_500;

/** The ~40MB model should load once per browser session no matter how many
 *  times the listener effect below tears down and restarts. */
let modelPromise: Promise<Model> | null = null;
function getModel(): Promise<Model> {
  modelPromise ??= import("vosk-browser").then(({ createModel }) => createModel(MODEL_URL));
  return modelPromise;
}

/** Vosk needs WASM + Web Audio + a mic — supported far more broadly than the
 *  Web Speech API it replaced (which Firefox and Safari never implemented). */
export function isVoiceCommandSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof WebAssembly !== "undefined" &&
    typeof AudioContext !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia)
  );
}

export type VoiceCommandState = { supported: boolean; listening: boolean; error: string | null };

type Args = {
  enabled: boolean;
  onCommand: (kind: SignalKind) => void;
  /** The wake word was heard with no signal name following it — "activate"
   *  the app (bring the live ride view to front) rather than send a signal. */
  onActivate?: () => void;
  /** Skip the wake word and match a bare signal name on its own — for when
   *  the Signal picker is already open (via "sync" or a manual tap) and
   *  repeating "sync" before each choice would be redundant. */
  bareCommandsEnabled?: boolean;
};

/**
 * Grammar-constrained Vosk recognition, running continuously while enabled.
 * Unlike the Web Speech API there's no session that ends after silence, so
 * there's no restart loop here — the audio graph just keeps streaming.
 */
export function useVoiceCommand({
  enabled,
  onCommand,
  onActivate,
  bareCommandsEnabled,
}: Args): VoiceCommandState {
  const supported = isVoiceCommandSupported();
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onCommandRef = useRef(onCommand);
  onCommandRef.current = onCommand;
  const onActivateRef = useRef(onActivate);
  onActivateRef.current = onActivate;
  const bareCommandsRef = useRef(bareCommandsEnabled);
  bareCommandsRef.current = bareCommandsEnabled;
  const lastTriggerRef = useRef(0);

  useEffect(() => {
    if (!supported || !enabled) {
      console.log(`[voice] not starting: ${!supported ? "unsupported browser" : "disabled"}`);
      setListening(false);
      publishVoiceAudioLevel(0);
      publishVoicePartial("");
      publishVoiceDetection(null);
      return;
    }

    console.log(
      `[voice] starting — origin=${location.protocol}//${location.hostname} ` +
        `secureContext=${window.isSecureContext} onLine=${navigator.onLine}`,
    );

    let cancelled = false;
    let stream: MediaStream | null = null;
    let audioContext: AudioContext | null = null;
    let recognizer: KaldiRecognizer | null = null;
    let activateTimer: number | null = null;
    // Audio graph nodes — held at effect scope so cleanup can disconnect them
    // (see Defect A: an un-disconnected ScriptProcessorNode also leaks).
    let mediaSource: MediaStreamAudioSourceNode | null = null;
    let scriptNode: ScriptProcessorNode | null = null;
    // Watchdog for "recognition started but no audio callback ever fires".
    let audioWatchdog: number | null = null;
    let gotAudioCallback = false;

    // Publishes what Vosk finalized and what the app decided to do about it,
    // for the mic button's live "heard X -> doing Y" caption, plus a matching
    // console log so the same story is visible without the UI open.
    function detect(word: string, action: string) {
      publishVoiceDetection({ text: word, action });
      console.log(`[voice] detected "${word}" -> ${action}`);
    }

    // Fire a signal command, respecting the debounce. Returns false (and logs
    // the "ignored" reason) if it was too soon after the previous trigger.
    function triggerCommand(text: string, kind: SignalKind): boolean {
      const now = Date.now();
      if (now - lastTriggerRef.current < DEBOUNCE_MS) {
        detect(text, "ignored (too soon after the last command)");
        return false;
      }
      lastTriggerRef.current = now;
      detect(text, `${SIGNAL_LABEL[kind]} triggered`);
      onCommandRef.current(kind);
      return true;
    }

    function handleWord(word: string) {
      const w = word.toLowerCase().trim();
      if (!w) return;
      console.log(`[voice] heard: "${w}"`);
      publishVoicePartial("");

      // Tokenised, whole-utterance parse (Vosk hands us the full utterance,
      // e.g. "sync hazard" — not one word at a time). Pure + unit-tested in
      // voicePhrase.test.ts.
      const parsed = parseVoiceUtterance(w, { bareCommandsEnabled: bareCommandsRef.current });

      if (!parsed) {
        detect(w, "not recognized");
        return;
      }

      // Wake word + command in the same utterance, or a bare command while the
      // picker is open — fire it now, cancelling any pending activation.
      if ("kind" in parsed && !("needsWake" in parsed)) {
        if (activateTimer != null) {
          window.clearTimeout(activateTimer);
          activateTimer = null;
        }
        triggerCommand(w, parsed.kind);
        return;
      }

      // Command with no wake word (bare mode off).
      if ("needsWake" in parsed) {
        if (activateTimer != null) {
          // The wake word was heard as the PREVIOUS utterance and we're inside
          // the grace window — this command completes it.
          window.clearTimeout(activateTimer);
          activateTimer = null;
          triggerCommand(w, parsed.kind);
          return;
        }
        detect(w, `heard, but say "${WAKE_WORD}" first`);
        return;
      }

      // Bare wake word, no command yet — give it a moment in case the command
      // arrives as the next utterance before treating it as bare activation.
      if (activateTimer != null) window.clearTimeout(activateTimer);
      detect(w, "waiting for a command");
      activateTimer = window.setTimeout(() => {
        activateTimer = null;
        const now = Date.now();
        if (now - lastTriggerRef.current < DEBOUNCE_MS) {
          detect(w, "ignored (too soon after the last command)");
          return;
        }
        lastTriggerRef.current = now;
        detect(w, "activated");
        onActivateRef.current?.();
      }, ACTIVATE_GRACE_MS);
    }

    (async () => {
      try {
        const model = await getModel();
        if (cancelled) return;

        stream = await navigator.mediaDevices.getUserMedia({
          video: false,
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            channelCount: 1,
            sampleRate: SAMPLE_RATE,
          },
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        recognizer = new model.KaldiRecognizer(SAMPLE_RATE, GRAMMAR);
        recognizer.on("result", (message) => {
          if (message.event === "result") handleWord(message.result.text);
        });
        recognizer.on("partialresult", (message) => {
          if (message.event !== "partialresult") return;
          const partial = message.result.partial ?? "";
          publishVoicePartial(partial);
          if (partial) console.log(`[voice] partial: "${partial}"`);
        });
        recognizer.on("error", (message) => {
          if (message.event === "error") console.warn(`[voice] recognizer error ${message.error}`);
        });

        // Must match the recognizer's declared rate above — without this,
        // AudioContext runs at the hardware default (typically 44.1/48kHz)
        // and every buffer handed to acceptWaveform() is ~3x faster than
        // Kaldi is told to expect, garbling the decode with no error thrown:
        // recognition starts fine, audio flows fine, but partials/results
        // never fire because the phoneme timing is entirely wrong.
        audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
        // Chrome (and others) start a context "suspended" unless the page has
        // had a user gesture — and this effect can turn on with no gesture at
        // all (voiceOn was already true from a previous session, and
        // AppLayout just found inApp && rideId && voiceOn all true on
        // mount/navigation). Suspended means onaudioprocess below never
        // fires: no partials, no results, no audio-level meter, total
        // silence with nothing in the console to explain why.
        if (audioContext.state === "suspended") {
          await audioContext.resume().catch(() => {});
        }
        if (cancelled) return;
        if (audioContext.state !== "running") {
          console.warn(`[voice] audio context stuck in "${audioContext.state}" state — no audio will reach the recognizer`);
          setError("audio-suspended");
          return;
        }
        const source = audioContext.createMediaStreamSource(stream);
        mediaSource = source;
        // ScriptProcessorNode is deprecated but is what the library's own
        // examples use, and AudioWorklet would need a separate module file
        // served alongside it — not worth the extra moving part here.
        const node = audioContext.createScriptProcessor(4_096, 1, 1);
        scriptNode = node;
        node.onaudioprocess = (event) => {
          // First callback: the audio graph is actually pulling — cancel the
          // silent-failure watchdog.
          if (!gotAudioCallback) {
            gotAudioCallback = true;
            if (audioWatchdog != null) {
              window.clearTimeout(audioWatchdog);
              audioWatchdog = null;
            }
          }
          // RMS of this buffer, scaled up so ordinary speech actually moves
          // the meter (raw mic RMS at normal gain sits well under 1.0) — this
          // is "is there audio around" feedback, independent of whether Vosk
          // recognizes any of it as a word.
          const data = event.inputBuffer.getChannelData(0);
          let sumSquares = 0;
          for (let i = 0; i < data.length; i++) sumSquares += data[i] * data[i];
          const rms = Math.sqrt(sumSquares / data.length);
          publishVoiceAudioLevel(Math.min(1, rms * 8));

          try {
            recognizer?.acceptWaveform(event.inputBuffer);
          } catch (err) {
            console.warn("[voice] acceptWaveform failed", err);
          }
        };
        source.connect(node);
        // Defect A: Chromium (desktop Chrome AND the Android WebView) does not
        // pull a ScriptProcessorNode that has no path to the destination, so
        // onaudioprocess never fires — 0 callbacks in 5s in production, silent
        // with nothing in the console. Connecting it to the destination makes
        // the graph run. The onaudioprocess handler above never writes to the
        // output buffer, and a ScriptProcessor's output buffer starts zeroed
        // each callback, so this path stays silent (no mic echo).
        node.connect(audioContext.destination);

        if (!cancelled) {
          setListening(true);
          setError(null);
          console.log("[voice] recognition started");
          // Arm the silent-failure watchdog: if no audio callback arrives soon
          // after "started", something in the graph isn't being pulled.
          gotAudioCallback = false;
          audioWatchdog = window.setTimeout(() => {
            audioWatchdog = null;
            if (!gotAudioCallback) {
              console.warn(
                `[voice] no audioprocess callback within ${AUDIOPROCESS_WATCHDOG_MS}ms of ` +
                  `"recognition started" — audio graph is not being pulled (no audio reaching the recognizer)`,
              );
            }
          }, AUDIOPROCESS_WATCHDOG_MS);
        }
      } catch (err) {
        if (cancelled) return;
        // Normalized to the same short codes the Ride screen's error copy
        // already knows how to translate (see describeVoiceError there).
        const name = err instanceof DOMException ? err.name : "";
        const code =
          name === "NotAllowedError" || name === "SecurityError"
            ? "not-allowed"
            : name === "NotFoundError"
              ? "audio-capture"
              : err instanceof TypeError || String(err).toLowerCase().includes("fetch")
                ? "network"
                : err instanceof Error
                  ? err.message
                  : String(err);
        console.warn("[voice] failed to start", err);
        setError(code);
        setListening(false);
      }
    })();

    return () => {
      cancelled = true;
      if (activateTimer != null) window.clearTimeout(activateTimer);
      if (audioWatchdog != null) window.clearTimeout(audioWatchdog);
      // Tear down the audio graph so nodes don't linger past teardown.
      try {
        scriptNode?.disconnect();
      } catch {
        /* ignore */
      }
      if (scriptNode) scriptNode.onaudioprocess = null;
      try {
        mediaSource?.disconnect();
      } catch {
        /* ignore */
      }
      try {
        recognizer?.remove();
      } catch {
        /* ignore */
      }
      try {
        void audioContext?.close();
      } catch {
        /* ignore */
      }
      stream?.getTracks().forEach((track) => track.stop());
      setListening(false);
      publishVoiceAudioLevel(0);
      publishVoicePartial("");
      publishVoiceDetection(null);
    };
  }, [supported, enabled]);

  return { supported, listening, error };
}
