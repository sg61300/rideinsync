# Handoff — SOS auto re-fire, cancel failure, voice-command safety, reload resume

Branch: `shubham/sos-cancel-fix` (off `upstream/fox-architecture`). Not pushed, no PR.
Date: 2026-09-16. Lane: Opus 4.8.

## Commits

| SHA | Item | Summary |
|-----|------|---------|
| `e1f928b` | RC-A/B/C | SosPage: auto flag consumed once on mount; cancel failure surfaced; countdown copy |
| `37b69d1` | 4 | Bare wake word opens the rider's own ride, not the ungated `/ride/demo` |
| `173e009` | 5 | Voice commands require wake word + command in one breath |
| `a2187a9` | 6 | Resume the sent SOS screen after a reload / PWA relaunch |

## Root causes and fixes

### RC-A — SOS re-fires by itself (`src/pages/SosPage.tsx`)
The voice command navigates to `/sos` with `state: { auto: true }`; `phase`
initialised to `"countdown"` from that flag. The flag was cleared only AFTER
the countdown finished, and every Cancel was a `navigate(HOME)` PUSH, so the
`/sos` history entry kept `{ auto: true }`. A Back gesture, browser Back or PWA
reload onto that entry remounted in `"countdown"` and auto-sent an SOS 5 s later
with no user action (with GPS off the send completes in ~3 s).

Fix: consume the auto flag once on mount — a same-path
`navigate(pathname, { replace: true, state: { auto: false } })`. `phase` is
still initialised from the initial flag (captured in a `useState` initialiser),
so the voice-armed countdown is preserved, but Back/reload onto the entry now
starts in `"confirm"`. The post-countdown clearing effect was removed. Pure
helpers `initialSosPhase(auto)` and `shouldConsumeAutoFlag(state)` extracted to
`src/pages/sosPhase.ts`. Logs `[sos] auto flag consumed`.

### RC-B — cannot cancel a sent SOS (`src/pages/SosPage.tsx`)
`cancelSosAlert` (`src/lib/sos.ts:353`) calls RPC `cancel_sos_alert`, which does
not exist on the hosted DB (PGRST202, migration 0034 unpushed). `onConfirmCancel`
swallowed the error and did nothing visible, so "Yes, cancel" looked dead.

Fix: new `cancelError` state, set in the catch to
"Couldn't cancel the SOS. Check your connection and try again.", rendered
`role="alert"` under the cancel controls on the sent screen; cleared when a
retry starts. The existing `[sos] cancel failed` warn (in `sos.ts`) is unchanged.

### RC-C — false voice-cancel affordance (`src/pages/SosPage.tsx`)
Countdown copy said "Say 'cancel' or tap Cancel to stop." but no voice "cancel"
word exists (`voicePhrase.ts` `COMMAND_WORDS` has none). Changed to
"Tap Cancel to stop." Voice cancel remains a separate founder decision.

### Item 4 — bare wake word opened the ungated demo ride (`src/AppLayout.tsx`)
`handleVoiceActivate` did `navigate("/ride/demo")`; on production that route
seeds a real demo ride + ~8 sim riders and is not gated. Now navigates to the
viewer's active ride using the same role-correct path the bell deep-link
computes (`ridePath ?? "/rides"`); `ridePath`/`myRole` lifted once to component
scope and shared with the bell effect (role rule not duplicated). Logs
`[voice] activate → <path>`. "Sync activated" feedback unchanged.

### Item 5 — voice command completed across utterances (`src/lib/voiceCommands.ts`, `src/lib/voicePhrase.ts`)
`handleWord`'s `needsWake` branch completed the wake-word grace window for any
command heard as the next utterance, so a stray "sync" one breath then "sos"
the next fired an SOS. Founder ruling 2026-09-16: a wake word heard as a PREVIOUS
utterance must never complete into a command. The `needsWake` branch now only
prompts `say "sync <command>" together` and leaves the activate timer running.
Commands fire only when the wake word rode in the same utterance, or a bare
command while the picker is open (bare mode, unchanged). Decision is the pure
helper `shouldFireBareCommand(parsed, bareCommandsEnabled)` (false for a
needsWake parse with bare mode off).

Behaviour change for users: voice commands now require
**"sync hazard" / "sync regroup" / "sync pit stop" / "sync SOS" in one breath**;
a bare **"sync"** opens the ride view (Item 4).

### Item 6 — active SOS lost on reload / PWA relaunch (`src/pages/SosPage.tsx`)
`alertId` lived only in component state, so a reload or PWA relaunch while the
rider's SOS was still active showed the plain confirm screen with Cancel SOS
unreachable and tracking stopped. Now reads the rider's own unresolved alert via
the existing `useOwnSosAlert(rideId, userId)` and, when on an idle screen
(`confirm`/`no-ride`) with an active alert, restores `alertId` and re-enters the
`sent` phase (Cancel SOS works, tracking restarts). Never resumes mid-countdown/
-send or once already sent/cancelled. Decision is the pure helper
`shouldResumeSentPhase(phase, hasOwnAlert)`; logs `[sos] resumed active alert <id>`.
`hasLocation` stays `true` (the alert row does not carry it — the "location sent"
copy is correct for a resumed active alert).

## Tests

`npm test`: **145 pass, 0 fail** (was 138; +7 new).
- `src/pages/sosPhase.test.ts` — `initialSosPhase`, `shouldConsumeAutoFlag`, `shouldResumeSentPhase` (idle-only, alert-gated, never mid-flow/terminal).
- `src/lib/voicePhrase.test.ts` — `shouldFireBareCommand`: wake+command fires; bare+picker fires; bare command with wake heard earlier does NOT fire; activate/null never fire.

`npx tsc --noEmit`: my changed files produce **zero** errors. 5 errors remain,
all pre-existing on the base branch and OUT OF SCOPE (confirmed identical with
my changes stashed):
- `src/AppLayout.tsx(29,1)` TS6133 `'track'` declared but never read.
- `src/components/ui/Carousel.tsx` (41,43,79,103) TS2304 `Cannot find name 'onUserEngage'`.

`npm run build`: **fails** — `tsc -b` halts on the same 5 pre-existing
out-of-scope errors above before `vite build` runs. Not caused by this branch's
changes. See "Reported back" below.

## Browser proof (demo dev server, `npx vite --port 5174`, `.env.local` demo mode)

localStorage: `rideinsync:devAuth=1`, `tour.welcome.seen=1`, `voice.onboarding.seen=1`.
Demo has an active ride ("Nandi Hills Sunrise Run", Lead). Repro of the voice
auto-nav via `history.pushState({usr:{auto:true},…},'','/sos')` + `popstate`.
Demo send log is `[sos:demo] alert sent`.

| Step | Expected | Observed |
|------|----------|----------|
| Auto entry to /sos | countdown "Sending SOS in 5" | "Sending SOS in 5"; `[sos] auto flag consumed` logged |
| Cancel during countdown | → /home | /home |
| Back onto /sos | confirm "Send an SOS?", not countdown | "Send an SOS?" |
| Reload /sos | confirm, `history.state.usr={auto:false}` | "Send an SOS?", `{auto:false}` |
| No auto-send on Back/reload | no `[sos:demo] alert sent` | none |
| RC-B: Yes, cancel with failing RPC (temp dev throw, removed before commit) | error text renders, stays on sent screen | `role="alert"` "Couldn't cancel the SOS. Check your connection and try again."; stayed on sent |
| Item 6 resume (SPA re-nav, fresh mount) | sent screen, Cancel SOS present | "Location sent to the group…", Cancel SOS present; `[sos] resumed active alert d8ac…` |
| Item 6 cancel after resume (demo) | cancel succeeds | "SOS cancelled"; `[sos:demo] cancelled` |

### Acceptance criterion — "once cancelled, SOS must not re-trigger" (all after an auto entry)

| Cancel point | After cancel | Back onto /sos | Reload /sos | New `[sos]` send |
|--------------|--------------|----------------|-------------|------------------|
| 1. During countdown | /home | "Send an SOS?" | "Send an SOS?" | none |
| 2. On confirm screen | /home | "Send an SOS?" | "Send an SOS?" | none |
| 3. "Yes, cancel" after sent → Back to ride | /home | "Send an SOS?" | "Send an SOS?" | exactly 1 (the intentional auto-send); none from cancel/back/reload |

Item 4: not browser-verified — ride pages do not load in demo. Covered by code
review + tsc; the handler reuses the already-verified bell `ridePath`.
Item 5: unit-tested (4 cases). The Vosk recogniser cannot be fed from the console,
so no live `[voice]` log capture — unit-tested only.

### Notes / limitations
- Demo backend stores alerts in module memory, so a full page reload wipes them;
  Item 6's resume was therefore proven via SPA re-navigation (the same fresh-mount
  path the effect handles, `alertId` dropped, own alert present). On the real
  Supabase backend the alert persists server-side and a hard reload/PWA relaunch
  resumes identically.
- Countdown `setTimeout`s throttle in a backgrounded tab; the auto-send in
  acceptance row 3 needed extra wall-clock wait. Behaviour is unaffected.

## Owner action required (out of my scope)
1. **Run `supabase db push`** so `cancel_sos_alert` (migration `0034_sos_cancel.sql`)
   and any other unapplied migrations exist on the hosted project. Probe: POST
   `/rest/v1/rpc/cancel_sos_alert` returned PGRST202 on 2026-09-16. Until then the
   client shows the RC-B error on every real cancel (demo cancel works).
2. **Pre-existing build break on `fox-architecture`** (blocks `npm run build`),
   both out of my task scope:
   - `src/components/ui/Carousel.tsx` references an undefined `onUserEngage`
     (4 sites) — looks like a botched merge; the prop/callback needs restoring.
   - `src/AppLayout.tsx:29` imports `track` but never uses it — remove the import
     or wire it up.
3. **Stale `node_modules`**: `posthog-js@^1.433.3` (added upstream in `fd52851`)
   was declared but never installed, which broke `npm test` and the build. I ran
   `npm install` with the cache redirected to `D:\Downloads\npm-cache` (nothing on
   C:); 11 packages added, `package-lock.json` unchanged. Other clones of this
   branch need the same `npm install`.

## Orchestrator re-proof (Fable, 2026-09-16, demo dev server, DOM reads via JS)
| Step | Observed |
|---|---|
| Auto entry from /home | "Sending SOS in 5 · Tap Cancel to stop." ; history state already `{auto:false}` (consumed on mount) |
| Cancel during countdown → Back → wait 6 s | /home, then "Send an SOS?" on Back; still "Send an SOS?" 6 s later, no send |
| Reload on /sos after cancel | "Send an SOS?" |
| Auto entry → countdown completes | sent screen "Location sent to the group. Help is arriving." with Cancel SOS |
| Reload with active SOS | showed confirm — INCONCLUSIVE in demo: `sosDemo.ts` keeps alerts in an in-memory `store`, so a reload wipes the alert itself. The resume path was proven by the lane with a fresh mount against a live alert (same code path). Real-reload proof needs production (Supabase-persisted alert). |
| "Yes, cancel" → Back to ride → browser Back → wait 6 s | /home, no countdown, no send |
Also verified: npm test 145/145; `tsc` 5 errors, all pre-existing on upstream/fox-architecture (Carousel.tsx `onUserEngage` ×4, AppLayout unused `track`), identical on the base with this branch stashed.
