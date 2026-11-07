# Hackathon Plan: Live Accessible Lecture Feed

> Theme: make education more accessible using AI.
> Working name: TBD. Last updated: 2026-11-07.

## Status & decisions

| Item | State |
|---|---|
| Team | 2 people: Person 1 = pipeline (local, with Claude Code), Person 2 = student app (Lovable). **TODO**: put names on the roles |
| MVP scope | Decided, trimmed for two people (below) |
| Student app | Built in Lovable (TanStack Start), synced to GitHub, runs locally on port 8080 |
| Server + teacher page | **Built (v1)** in `server/`. Captions, notes, board reading and mind map tested end to end with real keys. How it works and why: `ARCHITECTURE.md` |
| Runtime AI | Called from our server: Claude Opus 5.5 (`claude-opus-5-5`) reads the board, Claude Haiku 5.5 (`claude-haiku-5-5`) does the text tasks (~$0.75 per lecture hour instead of ~$4.50). Lovable's built-in AI is **not** used |
| Speech-to-text | Deepgram streaming (AssemblyAI as backup) |
| Tunnel | cloudflared quick tunnel (ngrok as backup) |
| Primary persona | **TODO**: pick one (e.g. first-semester international student, or hard-of-hearing student) |
| Hackathon length / deadline | **TODO**: fill in, then adjust the timeline below |
| Repos | Server + docs: `leah24338/sync`. Student app: `leah24338/project-migration-hub` (Lovable; moved from `chengrace086-ux/lecture-lens`), cloned into `web/`, connected to the server through the Vite proxy and verified in live mode |

## The product in one sentence

A teacher points a phone at the whiteboard and talks; students scan a QR code and get a
live, rewindable feed of captions and cleaned-up board content, with idioms explained and
display settings they control.

Core idea: everything the teacher says and writes becomes one timestamped event stream.
Every feature is just a different view of that stream.

## Scope (two-person version)

**Must have (demo fails without these)**
- Live captions on a student's phone
- Pause / scroll back without losing the feed, plus a "Jump to live" button
- Whiteboard → clean typed text and rendered equations (KaTeX), triggered by a
  **"Capture board" button** on the teacher page
- Figurative-language notes: idioms explained inline, tap to expand, opt-in "Literal mode"
- Settings panel: font (Atkinson Hyperlegible / OpenDyslexic / Lexend), size, spacing,
  contrast, density presets (Focus / Standard / Detailed)
- Explanation amount, two layers (built on the server side): the teacher sets what the AI looks
  for (Off / Only tricky / Standard / Everything, for idioms and terms separately); each student
  filters what they see on their own phone by the note's 1–3 `level`

**Should have (after the core works end to end)**
- Evolving mind map (view built early in Lovable on mock data; server side is one Claude call)
- Automatic board capture (change + stillness detection) instead of the button
- Read-aloud (browser SpeechSynthesis)

**Cut**
- Custom hardware (a phone on a tripod + clip-on mic is the hardware)
- Sarcasm detection from tone of voice
- Translation into other languages
- Accounts / login, multiple classrooms, persistence

## Architecture

Everything runs on one laptop, except the two cloud APIs (Claude and Deepgram).
Phones reach the laptop through a tunnel URL (HTTPS, needed for phone camera access).

```
TEACHER DEVICE(S) — /teach page served by our Node server
  (phone on tripod and/or laptop with clip-on mic)
  ├─ mic ─────► audio chunks over WebSocket ─────────────────────┐
  └─ camera ──► "Capture board" button (auto-detect later) ─► JPEG ┤
                                                                 ▼
LAPTOP — Node backend (port 3001)
  ├─ audio  ─► Deepgram live STT ─────────► caption events
  ├─ frame  ─► Claude vision (prev state + new image) ─► board events
  ├─ final caption ─► Claude (figurative language) ─► annotation events
  ├─ every ~45 s ─► Claude (append-only outline) ─► mindmap events
  └─ append-only EVENT LOG (in memory) ─► broadcast to all students over WebSocket
                                                                 ▼
STUDENT PHONES — Lovable-built React app, run locally with Vite
  (check vite.config.ts for the port; Lovable templates usually use 8080)
  Vite proxies /ws, /api and /teach → localhost:3001
  renders the log: live mode / paused mode / settings / mind map
                                                                 ▲
cloudflared tunnel exposes the Vite port as a public HTTPS URL → QR code
```

Why an event log: pause = stop auto-scrolling; Jump to live = scroll to the end;
late joiners get the whole log; replay mode = feed a saved log / recording through the
same pipeline.

### How Lovable fits in

- Lovable credits pay for **generating the student app's code**. They don't run anything
  at demo time: mind maps, idiom notes and board reading come from Claude via our server.
- Lovable builds against **mock events** first (see `LOVABLE_PROMPT.md`). All data goes
  through one hook, `useLectureEvents()` in `src/lib/events.ts`, which has a mock mode and
  a live WebSocket mode. Swapping mock → live is the only integration point.
- Lovable syncs two-way with GitHub on `main`. Clone that repo into `web/`.
  - Person 2 owns UI files and edits them in Lovable.
  - Person 1 only touches `src/lib/events.ts` and `vite.config.ts` (the proxy), always
    `git pull` first and pushes small commits, so the two never collide.
- Don't let Lovable connect Supabase / Lovable Cloud or add auth. Hosted Lovable features
  don't carry over to a local run.
- Save credits: one big detailed first prompt; make tiny tweaks (text, colors, spacing) by
  hand in the code; never debug the audio/camera pipeline in Lovable; keep ~20 credits in
  reserve for the last few hours.

### Event schema (shared contract between the two halves)

```ts
type LectureEvent =
  | { type: "caption"; id: string; t: number; text: string; final: boolean }
  | { type: "annotation"; captionId: string; kind: "idiom" | "term"; phrase: string; meaning: string }
  | { type: "board"; id: string; t: number; snapshotUrl: string;
      blocks: { id: string; kind: "text" | "equation"; content: string }[] } // equations as LaTeX
  | { type: "mindmap"; t: number; markdown: string };
```

A caption with the same `id` replaces the previous one (partial → final).
`t` is milliseconds since the lecture started.
Server WebSocket at `/ws`: each message is one JSON event; on connect it re-sends every past
event, then streams new ones. Student app uses live mode with `?mode=live`, otherwise mock.

### Pipeline rules

- **Captions never wait for AI.** Raw caption shows instantly; annotations attach 2–3 s later (measured).
- **Board frames:** start with the manual "Capture board" button. If time allows, add
  auto-capture: downscale to tiny grayscale, diff against the last sent frame, send only
  when the board changed AND stayed still ~2 s. Max ~1 call / 5–10 s. Always send the
  previous board state with the new image; ask for the updated state as JSON
  (structured outputs).
- **Mind map:** Claude returns a nested Markdown outline; instruction: keep every existing
  node, only add. Rendered with Markmap.
- **Trust:** always show the source next to the AI's version (board snapshot beside the
  equation, original quote beside the idiom note). Label AI-generated content.
- **Screen readers:** `aria-live="polite"` on finished captions only, never partials.

### Folder layout (planned)

```
wie_hack/              # this folder: its own git repo (ignores web/)
  PLAN.md
  ARCHITECTURE.md      # how the server works + optimizations (keep updated)
  LOVABLE_PROMPT.md    # first prompt to paste into Lovable
  .env                 # API keys — never commit
  .env.example
  server/              # Node + Express + ws (TypeScript)
    src/index.ts       # HTTP + WebSocket server, event log, broadcast, mock replay
    src/stt.ts         # Deepgram live transcription
    src/board.ts       # Claude vision → board state
    src/annotate.ts    # Claude figurative-language notes
    src/mindmap.ts     # Claude mind map outline
    src/replay.ts      # replay the demo lecture or a saved session
    public/            # teacher console (mic, camera, capture) + test viewer
    mock/lecture.json  # sample event stream
  web/                 # git clone of the Lovable GitHub repo (separate repo)
```

## Stack

| Layer | Pick |
|---|---|
| Student app | Lovable-generated React + Vite + TypeScript + Tailwind (shadcn/ui) |
| Equations | KaTeX |
| Mind map | Markmap |
| Fonts | Atkinson Hyperlegible, OpenDyslexic, Lexend |
| Read-aloud | Browser SpeechSynthesis |
| Backend | Node 22 + Express + `ws`, event log in memory |
| Speech-to-text | Deepgram streaming (`DEEPGRAM_API_KEY`) |
| AI | Anthropic SDK, `claude-opus-5-5`, structured outputs; effort `low` for per-sentence notes (Haiku 5.5 as an option if too slow) |
| Tunnel | `cloudflared tunnel --url http://localhost:<vite port>` (no account needed) |

Rough API cost: a board read is ~$0.02, an idiom note under $0.01. A day of testing
should be roughly $10–30 of Claude credit; Deepgram's new-account credit covers it.

## Team roles (two people)

**Person 1 — Pipeline** (works in this folder with Claude Code)
- Node server, event log, mock replay, WebSocket broadcast
- Teacher page: mic streaming, camera + "Capture board"
- Deepgram captions; Claude calls for board, idiom notes, mind map
- Tunnel, Vite proxy, swapping the student app from mock → live

**Person 2 — Student experience** (works in Lovable)
- Student app on mock events: feed, pause / Jump to live, board cards, settings,
  density presets, mind map view, QR "join" page
- Accessibility pass (contrast, keyboard, screen reader, touch targets)
- Demo lecture script, pitch slides, recorded backup demo video

## Timeline (assumes ~24 h — adjust once the deadline is known)

| Hours | Person 1 (pipeline) | Person 2 (student app) |
|---|---|---|
| 0–2 | API keys, `.env`, server skeleton + mock replay | Paste `LOVABLE_PROMPT.md` into Lovable, connect GitHub |
| 2–8 | Teacher page mic → Deepgram → caption events | Feed, pause / Jump to live, settings on mock data |
| 8–12 | **Checkpoint:** clone `web/`, wire live mode, speak → caption on a phone via tunnel. Then "Capture board" → Claude → equation | Board cards with KaTeX, density presets, fonts |
| 12–18 | Idiom notes, mind map call, auto board capture if time | Mind map view, QR page, accessibility pass, start pitch |
| 18–21 | Replay mode (saved lecture), bug fixes | Record backup demo video, polish |
| 21–24 | **Feature freeze.** Rehearse together 3+ times on the real setup | ← same |

If the checkpoint slips, cut the mind map and auto board capture first.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Scope creep with two people | Trimmed tiers above; feature freeze 3–4 h before deadline |
| Running out of Lovable credits | One big first prompt, hand-edit small tweaks, keep ~20 in reserve |
| Lovable and local edits colliding | Person 1 touches only `events.ts` + `vite.config.ts`; pull before every edit |
| Messy board images (glare, angle, teacher blocking, erasing) | Manual capture button; send previous state; dark markers, good light, fixed camera, crop to board; iPad + tldraw as backup input |
| Latency stacking | Two-speed design: captions instant, annotations attach later |
| Loud demo room | Clip-on mic; replay mode with a pre-recorded lecture; backup video |
| AI confidently wrong | Show source next to every AI interpretation; label AI content |
| Venue Wi-Fi blocks device-to-device traffic | Tunnel URL instead of LAN IP; phone hotspot as backup |
| Privacy questions from judges | Crop to board, no stored video or audio |

## Demo script (draft)

1. Judges scan the QR code on their phones.
2. One person gives a ~90 s scripted mini-lecture that hits every feature:
   "This proof is a piece of cake…" → writes the quadratic formula → taps Capture →
   "oh great, another negative discriminant."
3. The other person narrates: idiom note appearing, equation rendering from the board,
   pause + scroll back, Jump to live, switch to dyslexia font and Focus mode, mind map.
4. Pitch answer to "how is this different from Otter / Live Transcribe?": those are
   audio-only; this fuses the board with speech, explains what's meant, and lets you
   rewind without falling behind.

## Setup checklist

- [ ] Anthropic API key + credits (console.anthropic.com) → `ANTHROPIC_API_KEY` in `.env`
- [ ] Deepgram API key (console.deepgram.com) → `DEEPGRAM_API_KEY` in `.env`
- [ ] `cp .env.example .env` in the project folder, then paste both keys into `.env`
- [ ] `brew install cloudflared`
- [ ] Ask organizers about sponsor API credits
- [ ] Lovable: redeem the 100 credits, create the project from `LOVABLE_PROMPT.md`,
      connect GitHub (Settings → GitHub)
- [ ] GitHub: both teammates added to the Lovable repo and this repo
- [ ] Hardware: phone + tripod/clamp, clip-on or USB mic, dark whiteboard markers, chargers
- [x] Node 22 + npm installed
