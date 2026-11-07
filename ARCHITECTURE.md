# Architecture

How the app works, why it's built this way, and the optimizations worth explaining to judges.
This is the living reference for the server side (Person 1). Update the changelog at the
bottom whenever something changes.

## The 30-second explanation

Everything the teacher says or writes becomes an **event** on one shared **timeline**.
The laptop server is the only part that talks to AI: it listens to the mic, reads the
whiteboard photos, asks Claude for explanations and the mind map, and adds each result to the
timeline. Students' phones just display the timeline.

That one idea is why pausing, scrolling back and joining late all work: the full timeline is
always on the server, so any phone can catch up from it at any moment.

## Big picture

```
TEACHER (browser: /teach/)                         LAPTOP: Node server (port 3001)
┌──────────────────────────┐                      ┌───────────────────────────────────────────┐
│ Mic → 250 ms audio chunks├──WebSocket──────────►│ Deepgram stream ──► CaptionAssembler       │
│                          │  /ws/teacher         │   (speech → text,    (words → sentences)   │
│ Camera → change detector │                      │    cloud)                 │                │
│   → JPEG ≤1280 px        ├──HTTP POST──────────►│ BoardReader ──► Claude    │ final caption  │
└──────────────────────────┘  /api/board          │   (photo → text + LaTeX)  ▼                │
                                                  │                  Annotator ──► Claude      │
                                                  │                  (idioms, terms)           │
                                                  │                  MindMapper ──► Claude     │
                                                  │                  (every 45 s)              │
                                                  │                         │                  │
                                                  │        all results ─────▼                  │
                                                  │                ┌──────────────┐            │
                                                  │                │  EVENT LOG   │ (timeline) │
                                                  │                └──────┬───────┘            │
                                                  └───────────────────────┼────────────────────┘
                                                                          │ WebSocket /ws
                                                       catch-up on connect, then live updates
                                                                          ▼
                                                  STUDENT PHONES (Lovable app, or /teach/viewer.html)
```

**Runs locally:** the server, the teacher page and the student app.
**In the cloud:** Deepgram (speech to text) and Claude (everything else). Phones reach the
laptop through a cloudflared tunnel, which also gives the HTTPS address phone cameras require.

## How it fundamentally works

### 1. The event log (`server/src/events.ts`)

There are four kinds of event (the same contract the Lovable app uses):

| Event | Meaning |
|---|---|
| `caption` | A sentence the teacher said. Re-sent with more words while they talk (`final: false`), then once more with `final: true`. |
| `annotation` | An explanation attached to a caption: an idiom/sarcasm (`idiom`) or a technical word (`term`). |
| `board` | The whole cleaned-up whiteboard at that moment: text blocks and LaTeX equations, plus a link to the photo. |
| `mindmap` | The whole mind map as a Markdown outline. |

The server keeps every event in order. When a phone connects, it first receives every past
event (catch-up), then each new one as it happens. The phone never asks for anything else.

### 2. What happens when the teacher says a sentence

1. The teacher page records the mic in 250 ms WebM/Opus chunks and streams them to the server.
2. The server forwards them to Deepgram, which streams back word guesses within a fraction of a second.
3. `CaptionAssembler` (`stt.ts`) turns those guesses into one caption per sentence. It re-sends the
   same caption id as words arrive, so the student sees text appear live.
4. When the sentence ends (a pause, a full stop, or 220 characters), the caption is marked final.
5. Only final captions go to the AI: the **Annotator** looks for idioms, sarcasm and key terms, and
   the **MindMapper** queues the sentence for its next update.
6. About 1–2 s later, any explanation arrives as an `annotation` event pointing at that caption.

### 3. What happens when the teacher writes on the board

1. The teacher presses **Capture board**, or auto-capture decides the board has new writing
   (details under optimizations).
2. The photo is shrunk to at most 1280 px wide and uploaded as a JPEG.
3. `BoardReader` (`board.ts`) sends Claude the photo **plus the current digital copy of the board**,
   and Claude returns the updated copy: kept blocks, new blocks, erased blocks removed.
4. If anything changed, a `board` event goes out with the blocks and the photo's URL, and the new
   writing is passed to the MindMapper too.

### 4. How the mind map grows

Every 45 s, if at least 15 new words were said or written, `MindMapper` (`mindmap.ts`) sends
Claude the current outline plus only the new text. Claude returns the outline with new topics
added. It is told never to remove or reword existing nodes, so the map grows without jumping
around. The phone draws the outline as a mind map (Markmap, in the Lovable app).

### 5. Replay

`replay.ts` plays a saved list of events (the built-in demo lecture, or a recorded session) back
into the log with its original timing. It makes no speech or AI calls, so it's free and
identical every time. It's the student app's test feed and the demo-day backup.

## Optimizations and design decisions

Each row is something you can point to in the code and explain.

### Speed (latency)

| What | Why | Where |
|---|---|---|
| Streaming speech-to-text with interim results | Words appear while the teacher is still talking, not after the sentence ends | `stt.ts` (Deepgram URL params) |
| Captions never wait for AI | The caption shows instantly; the explanation attaches 1–2 s later as a separate event | `annotate.ts` (fire-and-forget `add`) |
| Sentence-sized captions | Ends on a 300 ms pause, a full stop, or 220 characters, with Deepgram's "utterance end" as a backup in noisy rooms | `stt.ts` `CaptionAssembler` |
| Effort tuned per task | `low` for per-sentence notes and the mind map (fast), `medium` for reading the board (accuracy matters more) | `annotate.ts`, `mindmap.ts`, `board.ts` |

### Cost (fewer, smaller AI calls)

| What | Why | Where |
|---|---|---|
| Auto-capture only sends useful photos | Compares tiny 160×90 grayscale frames twice a second. Sends only when the picture has been **still for 2 s** (teacher stepped away), **differs from the last photo** (new writing), and **5 s** have passed. A few photos a minute instead of 30 frames a second | `public/teach.js` |
| Photos shrunk before upload | ≤1280 px JPEG at 80% quality: about 1,200 Claude tokens per photo (~$0.02 a read), fast to upload | `public/teach.js` `captureBoard` |
| Latest photo wins | While one board read runs, newer photos replace each other in a single waiting slot. A burst of captures costs at most two calls and is never read out of order | `board.ts` `submit`/`drain` |
| Incremental mind map | Sends the outline plus only the new text, so the prompt stays the same size however long the lecture runs; skipped entirely when under 15 new words | `mindmap.ts` |
| Explain once | Phrases already explained are passed to Claude and filtered out, so "discriminant" isn't explained ten times | `annotate.ts` `explained` |
| Replay is free | Demo and testing don't touch the APIs | `replay.ts` |
| Max 4 Claude calls at once | Avoids rate-limit errors during bursts of speech | `claude.ts` `withSlot` |

### Bandwidth and reconnects

| What | Why | Where |
|---|---|---|
| Compacted log | A partial caption is **replaced in place** by its next version instead of appended, so a phone that reconnects downloads each sentence once, not every in-between version | `events.ts` `push` |
| Serialize once, send to all | Each event is turned into JSON once and the same bytes go to every phone | `index.ts` broadcast |
| Photos sent separately | Events carry only a photo URL; phones download the image only if it's shown, and it's cached forever (`immutable`) | `index.ts` `/api/snapshots/:id` |
| 32 kbps Opus audio | Plenty for speech, light on venue Wi-Fi | `public/teach.js` `MediaRecorder` |

### Reliability

| What | Why | Where |
|---|---|---|
| One source of truth | Late joiners, reloads and dropped phones all recover by replaying the log; no phone can end up "behind" | `index.ts` catch-up on connect |
| Heartbeat every 30 s | Keeps quiet connections from being closed by the tunnel, and drops phones that disappeared | `index.ts` ping/pong |
| Audio header never lost | The first audio chunk holds the WebM header; chunks that arrive before Deepgram is ready are queued, not dropped | `stt.ts` `backlog` |
| "start" signal per recording | Audio only goes to a stream opened by the page's `start` message, so leftover chunks from an old recording can't corrupt a new one | `index.ts` teacher connection, `teach.js` `startRecorder` |
| Self-healing mic | If Deepgram drops mid-lecture, the server asks the page to start a fresh recording; with a bad key it stops instead of looping | `index.ts`, `teach.js` |
| KeepAlive | Deepgram hangs up after ~10 s of silence; the server pings it while the mic is paused | `stt.ts` |
| AI failures are contained | Every Claude call returns `null` on error instead of throwing, so a failed explanation never stops captions | `claude.ts` `askJson` |
| Structured outputs | Claude's replies are forced to match a schema (Zod), so there's no fragile text parsing | `claude.ts` |
| Refusal fallback | If a safety classifier ever declines a request, the API retries it on Anthropic's recommended fallback model | `claude.ts` (`fallbacks: "default"`) |
| Clean reset | Reset discards half-finished captions and reconnects every phone to the empty log | `index.ts` `resetLecture` |

### Accuracy and trust

| What | Why | Where |
|---|---|---|
| Board read as an edit, not from scratch | Claude sees the current copy and updates it, so unchanged writing keeps its wording and ids, and parts blocked by the teacher's body are kept | `board.ts` prompt |
| Never guess | Claude is told to leave out writing it can't read | `board.ts` prompt |
| Source always available | Each board event links the original photo, so students can check the AI's transcription | `board.ts` `snapshotUrl` |
| Explanations verified | An annotation is kept only if its phrase really appears in the caption, using the caption's own spelling, so the app can always underline it | `annotate.ts` |
| Context for sarcasm | The last 3 sentences go along with each new one, since sarcasm depends on context | `annotate.ts` |
| Board feeds the mind map | New writing on the board is added to the mind map, not just speech | `board.ts` → `mindmap.ts` |

### Privacy

- Audio is never stored: it goes to Deepgram and only text comes back.
- Board photos live in memory only and are cleared on reset.
- A session is written to disk only when the teacher presses Save (`server/sessions/`, git-ignored).
- Optional `TEACHER_KEY` locks the teacher controls when the tunnel URL is public.

## Interfaces

### Student WebSocket: `/ws`
Receive-only. Each message is one JSON event. On connect the server re-sends every past event,
then streams new ones. A reset closes the connection (code 1012); the app reconnects and starts fresh.

### Teacher WebSocket: `/ws/teacher`
Page → server: `{"type":"start"}` before each recording, then binary WebM/Opus chunks.
Server → page: `{"type":"status","state":"connecting|open|closed|error","message"?}` and
`{"type":"audio-restart"}`.

### HTTP

| Route | Purpose |
|---|---|
| `GET /teach/` | Teacher console. `/teach/viewer.html` is a bare-bones student view for testing |
| `GET /api/status` | Viewer count, event count, whether Claude/Deepgram keys are set |
| `POST /api/board` | Body: a JPEG. Queues a board read (202) |
| `GET /api/snapshots/:id` | A stored board photo |
| `POST /api/replay` | `{}` for the demo lecture, or `{"session":"<file>","speed":2}` |
| `POST /api/replay/stop` · `POST /api/save` · `GET /api/sessions` · `POST /api/reset` | Lecture controls |

## Files

```
server/
  src/index.ts      HTTP + WebSocket server, broadcast, heartbeat, routes, reset
  src/events.ts     Event types + the event log (compaction, catch-up)
  src/stt.ts        Deepgram stream + CaptionAssembler (words → sentences)
  src/claude.ts     Shared Claude call: structured outputs, fallback, concurrency cap, errors
  src/annotate.ts   Idioms, sarcasm, key terms
  src/board.ts      Whiteboard photo → text + LaTeX
  src/mindmap.ts    Incremental mind map outline
  src/replay.ts     Play a saved event list with original timing
  src/config.ts     Settings and API keys from wie_hack/.env
  public/teach.*    Teacher console (mic, camera, auto-capture, controls)
  public/viewer.html Test viewer (renders events, KaTeX for equations)
  mock/lecture.json Demo lecture (same as the Lovable mock data)
  scripts/smoke.ts  Real Claude calls to check the AI pipelines
```

## Running it

```bash
cd server && npm install        # once
npm run dev                     # from server/: restarts on file changes
```

- Teacher console: http://localhost:3001/teach/ → **Replay demo lecture** works with no keys.
- With keys in `wie_hack/.env` (copy `.env.example`): **Start mic** for captions, **Start camera** for the board.
- Check the AI pipelines (a few cents): `npm run smoke`, or `npm run smoke -- photo.jpg` to include a board photo.
- On a phone before the Lovable app is wired up: `cloudflared tunnel --url http://localhost:3001`, then
  open `https://<random>.trycloudflare.com/teach/viewer.html` (or `/teach/` for the camera).

### Connecting the Lovable app

In the Lovable repo's `vite.config.ts`, proxy our routes to the server and allow the tunnel host
(Vite rejects unknown hostnames otherwise):

```ts
server: {
  host: "::",
  port: 8080,
  allowedHosts: [".trycloudflare.com"],
  proxy: {
    "/ws": { target: "ws://localhost:3001", ws: true },
    "/api": "http://localhost:3001",
    "/teach": "http://localhost:3001",
  },
},
```

Then tunnel the Vite port instead (`cloudflared tunnel --url http://localhost:8080`) and open
`/?mode=live` on phones. One URL serves the student app, the teacher console and the feed.

## Status

**Verified (2026-11-07, without API keys):** demo replay streams all four event types; a phone
joining late gets the compacted log (18 live messages → 17 stored); save and replay of a recorded
session; reset disconnects phones with code 1012; board upload accepted; teacher connection
reports a missing Deepgram key; the test viewer renders captions, notes, KaTeX equations and
mind map updates.

**Not verified yet:** real Deepgram captions and Claude calls (need keys), auto-capture
thresholds on a real whiteboard, phones over the tunnel, the Lovable app in live mode.

## Changelog

- **2026-11-07:** Server v1: event log with caption compaction and catch-up, Deepgram streaming
  captions, Claude idiom/term notes, board reading, incremental mind map, replay and saved
  sessions, teacher console with manual and auto board capture, test viewer, smoke test.
