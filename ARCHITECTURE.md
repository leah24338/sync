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
| `annotation` | An explanation attached to a caption: an idiom/sarcasm (`idiom`) or a technical word (`term`), with a `level` from 1 (most students know it) to 3 (likely to confuse). |
| `board` | The whole cleaned-up whiteboard at that moment, plus a link to the photo. Each line: `content` (LaTeX for equations; words with any maths in `$…$` for text), `plain` (readable Unicode) and `spoken` (words for screen readers). |
| `lost` | A student pressed "I'm lost" (anonymous): `t` (the moment they were lost at), `at` (when they pressed), `topicId`, `captionId` (what was being said), `highlights` (exact words they marked, verified). |
| `focus` | Which mind map topic the teacher is talking about right now (`topicId`). Only sent when it changes; the log keeps just the latest one. |
| `mindmap` | The whole mind map: `title` (the main subject), `topics` (each with a `relatedness` score 0–1, `details` and `links` to other topics), and the same map as a Markdown outline (`markdown`) for simple tree views. |

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
6. A few seconds later (typically 2–3 s, measured), any explanation arrives as an `annotation`
   event pointing at that caption.

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
Claude the current map plus only the new text. Claude returns **only the changes** (new topics,
and new details or links on existing ones), and the server merges them in. The server, not the
model, guarantees topics never disappear, move or get reworded.

**Relatedness:** each topic gets a score for how closely it relates to the lecture's main
subject: 1 = the subject itself, 0.7–0.9 a direct part of it, 0.4–0.6 background or an
application, 0.1–0.3 a tangent. Topics can also link to each other with a strength. The student
app uses this to place topics: core topics near the centre, tangents near the edge, linked topics
next to each other. **We compute the scores (understanding the lecture); Person 2's app does the
placement (drawing).** Tested: core topic 0.8, a historical aside and a sports application 0.5,
an unrelated aside about octopuses 0.1.

**Branches:** each topic can have a `parentId` (the topic it branches off: a case, method,
example or part of it). It's set once, when the topic first appears, so branches never move;
broken or looping parents fall back to the centre. Branches are also sent as a strong link so
layouts that only read links still draw the tree. Tested with real speech: Solving methods →
Factoring / Completing the square / Quadratic formula → Discriminant.

**Topic notes (`notes.ts`, `GET /api/topics/:id/notes`):** written the first time anyone opens a
topic, then shared (3 ms on repeat). Grounded in what was said while the focus was on that topic or
its branches (windows start 8 s early because the focus lags the words), plus any sentence naming
it, the board at that time and the terms explained then. Returns a summary, key points, an
example, board formulas (with plain/spoken), terms and how much material it used. Regenerated only
when the topic has grown. About a cent per topic opened.

**"You are here" (focus):** the server also tracks which topic the teacher is on right now, so
the student app can put a dot on it. Two sources, both in `mindmap.ts`:
1. Each mind map update also returns `current`: the topic the new speech ended on.
2. Between updates, every ~10 s of new speech (at least 6 words), a small call sends the topic
   list plus the last few sentences and asks which topic they're about. This catches the teacher
   jumping back to an earlier idea, which adds nothing new to the map. "None of these" keeps the
   dot where it was, so small talk doesn't make it jump.

A `focus` event goes out only when the topic changes. Tested with real calls: the focus followed
the speaker from Discriminant to an unrelated aside and back; a seven-word remark about "those
old clay tablets" moved it to Babylonian history without a mind map update. Cost: each check is
~500 input tokens (≈ $0.003), at most a few a minute and only while someone is talking.

### "I'm lost": students talking back to the teacher (`lost.ts`)

The one place students send something to the server:

1. A student presses "I'm lost" and picks the moment (and optionally the topic) in the app.
2. The app sends `POST /api/lost` `{ clientId, t?, topicId?, highlights? }`. `clientId` is a random
   id kept on the phone, used only so one student can't count twice. Nothing identifying is stored or
   shown. `highlights` are the exact words the student marked in a caption or board line; the server
   keeps only words that really appear in the line they name (up to 5), so nobody can post free text
   onto the teacher's screen.
3. The server fills in the topic the teacher was on at moment `t` (from the focus history) when the
   student didn't pick one, and what was being said then. It ignores the same phone flagging the same
   thing again within 2 minutes, allows up to 3 presses per phone in any 10 s, and broadcasts a `lost`
   event (with the highlights) to every screen.
4. It replies with how many students are lost on that topic (last 10 min), so the student sees
   "you're not alone", plus a **personal catch-up** (`catchup.ts`): a 2-line summary of the last
   3 minutes before that moment and up to 3 things the teacher assumed students knew, each explained
   in one sentence. Claude writes it from the transcript, the board and the mind map topic. The flag
   reaches the teacher before the AI runs; the student's reply waits ~2–5 s. **Shared**: students
   lost within the same 30 seconds on the same topic get the same catch-up, so a whole class lost at
   one point costs one call (about a cent). Tested: first student 4.5 s, the second at the same moment
   7 ms with the identical catch-up.
5. The teacher console's **Students lost** panel shows the total for the last 10 minutes, a bar per
   topic (the current topic is marked "now"), the **words students highlighted** with counts, the most
   confusing moments with the caption at that time, and an alert toast as each press arrives.
6. The catch-up focuses on the highlighted words when there are any.

`/api/lost` allows cross-site requests, so Lovable's own preview (on its own domain) can send flags
too. Tested: automatic topic (a press "now" → Quadratic formula, a press pointing at 0:16 →
Definition), counts, the duplicate and rate limits, cross-site access via the server tunnel, and the
panel with the demo lecture's sample presses.

### 5. Explanation settings: two layers (`settings.ts`)

| Layer | Who sets it | What it does | Cost effect |
|---|---|---|---|
| **Teacher** (teacher console, "Explanations") | The teacher, for everyone | Tells the AI what to look for, separately for idioms/sarcasm and key terms: Off · Only tricky ones · Standard · Everything | **Both off = no AI call per sentence.** "Only tricky" makes replies shorter |
| **Student** (each phone) | Each student, for themselves | Hides explanations below their chosen level. Every annotation carries a `level` (1–3), so this is just a filter on the phone | Free: no extra AI calls, and nobody else is affected |

Levels: **3** = likely to confuse many students (uncommon idiom, sarcasm, advanced or new term),
**2** = could confuse an English learner or literal reader (common idiom, course vocabulary),
**1** = most students already know it. Teacher settings map to a minimum level: Only tricky = 3,
Standard = 2 (the default), Everything = 1. The server also re-checks each note against the
current setting, so a change applies from the very next sentence.

### 6. Replay

`replay.ts` plays a saved list of events (the built-in demo lecture, or a recorded session) back
into the log with its original timing. It makes no speech or AI calls, so it's free and
identical every time. It's the student app's test feed and the demo-day backup.

## Optimizations and design decisions

Each row is something you can point to in the code and explain.

### Speed (latency)

| What | Why | Where |
|---|---|---|
| Streaming speech-to-text with interim results | Words appear while the teacher is still talking, not after the sentence ends | `stt.ts` (Deepgram URL params) |
| Captions never wait for AI | The caption shows instantly; the explanation attaches a few seconds later (2–3 s typical) as a separate event | `annotate.ts` (fire-and-forget `add`) |
| Sentence-sized captions | Ends on a 300 ms pause, a full stop, or 220 characters, with Deepgram's "utterance end" as a backup in noisy rooms | `stt.ts` `CaptionAssembler` |
| Effort tuned per task | `low` for per-sentence notes and the mind map (fast), `medium` for reading the board (accuracy matters more) | `annotate.ts`, `mindmap.ts`, `board.ts` |
| Fast model for text tasks | Claude Haiku 5.5 answers notes in ~0.6–1.7 s (Opus: 2–3 s) | `config.ts` `claudeTextModel` |

### Cost (fewer, smaller AI calls)

| What | Why | Where |
|---|---|---|
| Auto-capture only sends useful photos | Compares tiny 160×90 grayscale frames twice a second. Sends only when the picture has been **still for 2 s** (teacher stepped away), **differs from the last photo** (new writing), and **5 s** have passed. A few photos a minute instead of 30 frames a second | `public/teach.js` |
| Photos shrunk before upload | ≤1280 px JPEG at 80% quality: a 16:9 photo is ~1,200 image tokens, ~1,900 with the prompt (about $0.01 a read), and uploads fast | `public/teach.js` `captureBoard` |
| Latest photo wins | While one board read runs, newer photos replace each other in a single waiting slot. A burst of captures costs at most two calls and is never read out of order | `board.ts` `submit`/`drain` |
| Incremental mind map | Sends the map plus only the new text, and Claude replies with only the changes (measured: 72 then 191 output tokens), so the reply doesn't grow with the map; skipped entirely when under 15 new words | `mindmap.ts` `merge` |
| Explain once | Phrases already explained are passed to Claude and filtered out, so "discriminant" isn't explained ten times | `annotate.ts` `explained` |
| Flat prompt size | Only the 40 most recent explained phrases are sent; older repeats are caught on the server. Without this cap, every call grew a little all lecture (measured: 715 → 953 tokens over 16 sentences) | `annotate.ts` `EXPLAINED_SENT` |
| Teacher can switch explanations off | With idioms and terms both off, the per-sentence AI call is skipped entirely (verified: zero calls); "Only tricky" cuts reply size from ~110 to ~11 tokens on sentences with nothing tricky | `annotate.ts` `add`, `settings.ts` |
| Student filtering on the phone | Each student's "how many explanations" choice is a filter on data already sent, so personalizing costs nothing | `annotation.level`, student app |
| Replay is free | Demo and testing don't touch the APIs | `replay.ts` |
| Two models, picked per task | Reading the board (vision, accuracy matters most) stays on Claude Opus 5.5; the high-volume text tasks (notes, mind map, focus, catch-ups, topic notes) run on Claude Haiku 5.5, $0.10 / $0.50 per million tokens instead of $4 / $20. Measured: a note costs ~$0.0001 instead of ~$0.005. Change either with `CLAUDE_MODEL` / `CLAUDE_TEXT_MODEL` in `.env` | `config.ts`, `claude.ts` `askJson` (`task`) |
| Running cost counter | Every call's cost is logged (`[claude] annotate c3 (claude-haiku-5-5): … $0.0001`) and totalled per kind of call in `GET /api/status` (`ai`), so spend is visible, not guessed | `claude.ts` `usage` |
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
| Refusal fallback | If a safety classifier ever declines a request, the API retries it on Anthropic's recommended fallback model (board reads only: Haiku has no server-side fallback, so a declined text call is skipped like any other failed call) | `claude.ts` (`fallbacks: "default"`) |
| Clean reset | Reset discards half-finished captions and reconnects every phone to the empty log | `index.ts` `resetLecture` |

### Accuracy and trust

| What | Why | Where |
|---|---|---|
| Board read as an edit, not from scratch | Claude sees the current copy and updates it, so unchanged writing keeps its wording and ids, and parts blocked by the teacher's body are kept | `board.ts` prompt |
| Never guess | Claude is told to leave out writing it can't read | `board.ts` prompt |
| Readable maths, guaranteed | Claude marks maths inside text lines with `$…$`. The server checks every LaTeX string with KaTeX 0.19.1 (the student app's exact version): broken LaTeX or stray `x^2` in prose becomes readable Unicode (x²) instead of raw source or a red error, and a text line that's only maths is promoted to a rendered equation | `mathText.ts` |
| Maths for every reader | Each board line also gets `plain` (x = (−b ± √(b² − 4ac)) / 2a) for fallbacks, copying and the mind map, and `spoken` ("x equals start fraction minus b plus minus square root of…", from KaTeX's accessibility helper) for screen readers and read-aloud. Computed on the server, so it's free and identical for every phone | `mathText.ts` |
| Source always available | Each board event links the original photo, so students can check the AI's transcription | `board.ts` `snapshotUrl` |
| Explanations verified | An annotation is kept only if its phrase really appears in the caption, using the caption's own spelling, so the app can always underline it | `annotate.ts` |
| Context for sarcasm | The last 3 sentences go along with each new one, since sarcasm depends on context | `annotate.ts` |
| Board feeds the mind map | New writing on the board is added to the mind map, not just speech | `board.ts` → `mindmap.ts` |

## Cost model

**The key point: AI cost grows with lectures, not with students.** Every Claude and Deepgram call
happens once on the server and the result is shared with every phone, so 3 students or 300 cost
the same.

**Estimated cost of one lecture hour** (assumes ~10 finished sentences a minute, ~1 board read a
minute, a mind map update every 45 s; per-call costs measured):

| Part | Calls per hour | All on Opus 5.5 (before) | Text on Haiku 5.5 (now) |
|---|---|---|---|
| Idiom / term notes | ~600 | ~$3.00 | ~$0.08 |
| Board reads (Opus in both) | ~60 | ~$0.60 | ~$0.60 |
| Mind map + focus | ~80 + ~200 | ~$0.30 + ~$0.60 | ~$0.03 + ~$0.02 |
| Deepgram speech-to-text | per minute of audio | check the Deepgram console | same |
| **Claude total** | | **~$4.50 per lecture hour** | **~$0.75 per lecture hour** (~$0.03 per student in a class of 30) |

Board reads are now ~80% of the bill. Check real numbers in `GET /api/status` → `ai.byTask`.

**Quality check (2026-11-07, `npm run smoke` on Haiku):** sarcasm ("Oh great", level 3), idioms
("a piece of cake") and terms (discriminant, negative discriminant, quadratic equations) all came
back; the mind map got the same relatedness spread as Opus (core 0.8, asides 0.5, octopus tangent
0.1) and the focus followed the speaker back to "Discriminant". One miss vs Opus: "tackling" wasn't
flagged as an idiom. If notes ever look worse, set `CLAUDE_TEXT_MODEL=claude-opus-5-5` (old
behaviour) or `claude-sonnet-5-5` (middle: $2 / $10).

### Further options (not built yet)

| Option | Saves | Trade-off |
|---|---|---|
| Board reads on Claude Sonnet 5.5 ($2 / $10) | Roughly halves the biggest remaining part (~$0.60 → ~$0.30 an hour) | Must re-check handwriting and LaTeX accuracy on real board photos first |
| Batch notes: one call per ~3 sentences or ~10 s | ~half the note calls' input tokens (the instructions are sent once, not three times) | Notes arrive up to ~10 s after the sentence |
| Crop the camera to the board once at setup | Fewer image tokens, and less background for Claude to misread | One extra setup step |
| Pause the AI when no phone is connected | Nothing spent during setup and rehearsals (meanwhile, set both explanation settings to Off) | Late joiners miss notes from that stretch |
| Spending limit in the Anthropic console | Caps the worst case | None |

**What wouldn't help:** prompt caching (the fixed part of each prompt, the instructions, is under
the 512-token minimum that current models can cache; everything after it changes every call) and a database (it stores data; it doesn't reduce AI calls).

## Privacy

- Audio is never stored: it goes to Deepgram and only text comes back.
- Board photos live in memory only and are cleared on reset.
- A session is written to disk only when the teacher presses Save (`server/sessions/`, git-ignored).
- Optional `TEACHER_KEY` locks the teacher controls when the tunnel URL is public.

## Interfaces

### Student WebSocket: `/ws`
Receive-only. Each message is one JSON event. On connect the server re-sends every past event,
then streams new ones. A reset closes the connection (code 1012); the app reconnects and starts fresh.
`/ws?role=preview` is the same feed but isn't counted as a student (used by the teacher console
and its preview), so "N students joined" is accurate.

## Teacher console (`/teach/`)

Built so a teacher needs one button:

| Part | What it does |
|---|---|
| **Start lecture** | Turns on the microphone and the board camera together (each can be unticked, e.g. a phone that's only the camera). Plain-language errors if access is blocked, no device is found, or the page isn't on https |
| **Live card** | LIVE badge, timer, "N students joined", the line being captioned right now, and a mic level bar |
| **Pause captions** (or `P`) | Stops sending audio without hanging up, for private remarks; resuming is instant |
| **End lecture** | Stops the devices and saves the lecture automatically, so it can be replayed later |
| **Board source: Camera or Screen share** | Camera points at a whiteboard. Screen share captures slides or a digital whiteboard from the teacher's computer (desktop browsers only), turns auto-capture on (key presses go to the slides app, not the console), sends larger images (1600 px) for small slide text, and stops cleanly when sharing ends from the browser bar. The board reader ignores window frames, toolbars, slide numbers and the cursor |
| **Capture board** (or `Space`, `→`, Page Down, or a presentation clicker) | Flash, "photo sent", then "Board read ✓ 2 new lines" once Claude has read it, or "no new writing found" |
| **Show join code** | QR code and link for students; warns when the console is opened on `localhost`, which phones can't reach |
| **Device pickers** | Appear only when there's more than one mic or camera (clip-on mic, USB webcam) |
| **Settings & tools** (collapsed) | Explanation settings, replaying the demo or a saved lecture (listed by date), save now, clear for everyone |

The audio protocol and capture logic are unchanged from the earlier console.

**Look:** the console shares the student app's "SYNC." identity (`web/src/styles.css`): the
italic SYNC. wordmark, Playfair Display headings, Atkinson Hyperlegible text, and the same oklch
palette (cream paper and burgundy ink in light mode, slate and cyan in dark mode). It's tuned to
feel more like a professional tool: thin lines instead of heavy borders, small uppercase section
labels, a thin brand bar, consistent spacing, and quiet shadows. The embedded preview uses the same
palette and font.

### Teacher WebSocket: `/ws/teacher`
Page → server: `{"type":"start"}` before each recording, then binary WebM/Opus chunks.
Server → page: `{"type":"status","state":"connecting|open|closed|error","message"?}` and
`{"type":"audio-restart"}`.

### HTTP

| Route | Purpose |
|---|---|
| `GET /teach/` | Teacher console. `/teach/viewer.html` is a bare-bones student view for testing |
| `GET /api/status` | Viewer count, event count, whether Claude/Deepgram keys are set |
| `GET /api/settings` · `POST /api/settings` | Explanation settings: `{"idioms":"off|tricky|standard|all","terms":"…"}` (either field optional) |
| `POST /api/board` | Body: a JPEG. Queues a board read (202) |
| `POST /api/lost` | `{ clientId, t?, topicId?, highlights? }` from a student's phone (`highlights`: `[{ source: "feed"|"board", sourceId, text }]`). Returns `{ ok, duplicate, t, topicId?, highlights, students, catchUp }` (`catchUp`: `{ summary: [2 lines], assumed: [{ term, explanation }] }` or null); 429 after 3 presses in 10 s. Open to any site |
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
  src/annotate.ts   Idioms, sarcasm, key terms (with a 1–3 confusion level)
  src/settings.ts   Teacher's explanation settings (off / tricky / standard / all)
  src/lost.ts       Anonymous "I'm lost" flags: topic lookup, limits, counts
  src/catchup.ts    "I'm lost" catch-ups (2-line summary + assumed knowledge), shared per moment
  src/notes.ts      Notes for a mind map topic, written on first open and shared
  mock/notes.json   Pre-generated notes for the demo lecture's topics
  src/board.ts      Whiteboard photo → text + LaTeX
  src/mathText.ts   Validates LaTeX, converts to readable Unicode and spoken words
  src/mindmap.ts    Incremental mind map outline
  src/replay.ts     Play a saved event list with original timing
  src/config.ts     Settings and API keys from wie_hack/.env
  public/teach.*    Teacher console (see "Teacher console" below)
  public/viewer.html Test viewer: Feed tab (captions, notes, board with KaTeX) and Mind map tab
                    (drawn live with markmap), plus the per-student explanation filter
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

### The student app (Lovable)

Repo: `leah24338/project-migration-hub` (Lovable, Person 2; moved there from `chengrace086-ux/lecture-lens`), cloned into `wie_hack/web` (ignored by our repo).
It's a TanStack Start app on Lovable's Vite wrapper. Its `src/lib/events.ts` already speaks our
event format and connects to `/ws` in live mode, so the only change on our side is the proxy in
`web/vite.config.ts` (passed through the wrapper's `vite:` option):

```ts
vite: {
  server: {
    allowedHosts: [".trycloudflare.com"],   // Vite rejects unknown hostnames otherwise
    proxy: {
      "/ws": { target: "ws://localhost:3001", ws: true },
      "/api": "http://localhost:3001",
      "/teach": "http://localhost:3001",
    },
  },
},
```

Lovable's own sandbox strips the proxy, so its preview keeps using mock data.

**Install** (once): `npm install` fails on this project (an npm bug with its package
overrides), so use bun, which installs the exact versions in its `bun.lock`:

```bash
cd web && npx -y bun@1.4.3 install --frozen-lockfile
```

**Run everything** (or use the `lecture-server` and `student-app` entries in `.claude/launch.json`):

```bash
npm run dev --prefix server     # lecture server, port 3001
npm run dev --prefix web        # student app, port 8080
cloudflared tunnel --url http://localhost:8080
```

On phones open `https://<random>.trycloudflare.com/?mode=live`. The same address serves the
teacher console at `/teach/`.

**Ownership rule:** Person 2 owns every screen and component. We only touch `vite.config.ts`
(and `src/lib/events.ts` if the connection ever needs changing), and always `git pull` first,
because Lovable commits to `main` directly.

## Status

**Verified without keys (2026-11-07):** demo replay streams all four event types; a phone
joining late gets the compacted log (18 live messages → 17 stored); save and replay of a recorded
session; reset disconnects phones with code 1012; the test viewer renders captions, notes,
KaTeX equations and mind map updates.

**Verified with real keys (2026-11-07):**
- Live captions: generated speech streamed through `/ws/teacher` at real-time speed → words
  appeared about 1 s behind the voice, growing in place, and each sentence finalized at its pause
  (4 sentences: 4 final captions, 12 partial updates).
- Notes: idioms ("a piece of cake", "tackling"), sarcasm ("Oh, great." flagged as sarcastic) and
  key terms ("discriminant", "quadratic equations") came back correctly.
- Board: a rendered whiteboard image was read into correct LaTeX
  (`x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}`); re-sending the same photo produced no update; a photo
  with two new lines kept both original blocks' ids and added two new blocks.
- Mind map: grew from speech and ignored filler.

**Measured performance (Claude Opus 5.5):**

| Call | Typical time | Range seen | Tokens in / out | Approx. cost |
|---|---|---|---|---|
| Idiom / term note (per sentence) | ~2–3 s | 1.5–6.3 s | ~800 / 10–150 | ~$0.005 |
| Board read | ~2.5 s | 2.3–6.9 s | ~2,900 / 100–500 (square test image; a 16:9 camera photo is ~1,900 in) | ~$0.015 test, ~$0.01 real |
| Mind map update | ~2 s | 1.8–2.2 s | ~600–750 / 50–80 | ~$0.004 |

**Verified over the tunnel (2026-11-07):** a phone opened the teacher console through the
cloudflared address and its camera captures were read by Claude (2 reads: 3.0 s, and 14.5 s for a
dense printed page with ~1,700 output tokens, about $0.05; a whiteboard has far less text). The
public address also served the live feed over a secure WebSocket.

**Student app in live mode (2026-11-07):** the Lovable app at `/?mode=live` rendered the server's
captions, underlined idiom/term phrases, board cards (photos loaded through the proxy), KaTeX
equations, the LIVE indicator, and its Mind map tab drew the server's outline. Verified locally
and through a tunnel to port 8080 (app, `/teach/`, `/api` and the `/ws` feed all on one address).
The app doesn't use the annotation `level` yet (follow-up prompt in `LOVABLE_PROMPT.md`).

**Not verified yet:** a real handwritten whiteboard, auto-capture thresholds.

**Known quirk:** two sentences annotated at the same moment can't see each other's explanations,
so a closely related phrase may get explained twice ("discriminant", then "negative discriminant").

### When the board and mind map update (expected behaviour, not a bug)

- **Board:** only after a capture (button, Space/clicker, or auto-capture), and only when Claude
  finds new lesson content. Re-capturing the same board, or a screen showing our own apps, sends
  nothing. The server log says which: `[board] update sent`, `[board] nothing new in that image`.
- **Mind map:** at most every ~45 s, after ~15 new words of speech or board text, and only when
  there's real lesson content (filler and chatter are ignored). Log: `[mindmap] update sent` /
  `[mindmap] nothing new worth adding`.
- **Screen share auto-capture** needs a bigger change (4% of the image, roughly a new slide) and a
  10 s gap, because screens change constantly in small ways. Camera auto-capture keeps 0.8% / 5 s.

## Changelog

- **2026-11-07:** The student app moved to a new Lovable project, `leah24338/project-migration-hub`;
  `web/` now pulls from it and no longer from the old repo. Its first commit was a copy of an older
  version of the app, so the latest code (topic notes panel, demo data, branching) was pushed on top
  as a normal commit (`607cf79`), keeping Lovable's migration ledger and favicon.

- **2026-11-07:** Cheaper AI: text tasks (notes, mind map, focus, catch-ups, topic notes) moved to
  Claude Haiku 5.5, board reading stays on Opus 5.5 (`CLAUDE_TEXT_MODEL` / `CLAUDE_MODEL`). Each
  call's cost is logged and totalled in `/api/status` (`ai`). Estimated ~$4.50 → ~$0.75 per lecture
  hour. Smoke-tested on Haiku: notes, sarcasm, mind map and focus all correct; notes also faster.

- **2026-11-07:** Branching mind map (`parentId`), topic notes on demand (`notes.ts`), and a new
  ~90 s demo lecture with a real tree, varied relatedness, focus moves, board lines and "I'm lost"
  presses (`mock/lecture.json`) plus pre-generated notes (`mock/notes.json`), also copied into the
  student app as mock data. Found a student-app crash that only happens right after its code changes
  while the dev server runs: restart the student app after pulling. Lovable prompt 8.

- **2026-11-07:** Teacher console restyled to match the student app's SYNC. design (wordmark,
  Playfair Display + Atkinson Hyperlegible, shared oklch palette in light and dark), in a more
  restrained, professional form; preview restyled to match. Layout and behaviour unchanged.

- **2026-11-07:** "I'm lost" accepts the exact highlighted words (verified against the caption or
  board line, max 5), shows them to the teacher ("Words students highlighted") and focuses the
  catch-up on them. Fixed: the app's one-request-per-moment flags hit the 5 s limit; now up to 3
  presses per 10 s. Lovable prompt 7.

- **2026-11-07:** "I'm lost" now returns a personal catch-up (2-line summary of the last 3 minutes
  + up to 3 assumed-knowledge explanations), shared per 30-second moment and topic. Lovable prompt 6.

- **2026-11-07:** "I'm lost" goes to the teacher: `POST /api/lost` (anonymous, rate-limited,
  cross-site), `lost` events with the topic filled in from the focus history, a Students lost panel
  in the teacher console (per topic, top moments, alert toasts), sample presses in the demo
  lecture, replays play presses when they were pressed. Lovable prompt 5.

- **2026-11-07:** Readable board maths: `$…$` inline maths in text lines, server-side KaTeX
  validation with Unicode fallback, `plain` and `spoken` on every board line, mind map fed with
  `plain`. Verified on real images ("Discriminant: $b^2 - 4ac$" → plain "b² − 4ac") and edge cases
  (broken LaTeX, stray `x^2` in prose, all-maths text lines, hyphens left alone). Lovable prompt 4.

- **2026-11-07:** "You are here" tracking: new `focus` event (latest kept in the log), set by
  each mind map update's `current` topic and by a cheap check every ~10 s of new speech. Teacher
  console shows "On the mind map: ●topic"; test viewer shows "● Now: topic". Demo lecture has
  focus events; Lovable follow-up prompt 3 describes the moving dot.

- **2026-11-07:** Investigated "board photos and mind map don't update": a test session had only
  chatter (nothing for the mind map) and a shared screen showing our own apps (no new board content),
  while screen auto-capture fired ~25 times in 5 minutes. Added logs for skipped updates and stricter
  screen auto-capture (4% change, 10 s gap). Verified through the app's proxy: new slide → board
  update in 3 s, repeat → skipped, new board → update, mind map grew from board text alone.

- **2026-11-07:** Screen share as a board source (Camera / Screen share switch). Verified: the
  switch updates the console; a slide screenshot with an app toolbar was read as a title plus
  three LaTeX equations, ignoring the toolbar and slide number. Actual screen sharing not testable
  in the browser pane.

- **2026-11-07:** Teacher console rebuilt around one Start lecture / End lecture flow: pause
  captions, timer, live caption line, student count (previews excluded via `/ws?role=preview`),
  join QR dialog, keyboard and clicker capture with "Board read ✓" confirmation, device pickers,
  plain-language errors, auto-save on End, rarely used controls collapsed. Verified: idle/live
  layouts, QR dialog, student counting, board-read confirmation; mic and camera clicks not
  testable in the browser pane.

- **2026-11-07:** Mind map topics now carry `relatedness` (0–1) and `links`; Claude returns only
  changes and the server merges them (topics never disappear or move). Demo lecture gains
  relatedness data and a tangent topic; Lovable follow-up prompt 2 describes the radial layout.
  Teacher console redesigned (card layout, status chips, mic level meter, LIVE badge, links to
  the student app and join page); all element ids and behaviour unchanged.

- **2026-11-07:** Connected the student app (`chengrace086-ux/lecture-lens`, cloned into `web/`):
  added the Vite proxy and tunnel host, documented install (bun) and how to run both apps;
  verified live mode locally and over the tunnel.

- **2026-11-07:** Test viewer gets a Mind map tab that draws the outline as a live tree with
  markmap (d3 7.9.0, markmap 0.18.12 from jsDelivr; falls back to plain text if they can't load).
  Feed shows a short "Mind map updated" line instead of the raw outline. Phone camera tested
  through the tunnel.

- **2026-11-07:** Explanation settings. Teacher console: idioms/sarcasm and key terms each set
  to Off / Only tricky / Standard / Everything (both off skips the per-sentence AI call).
  Annotations now carry `level` 1–3 so each student can filter on their phone; the test viewer
  has the filter. Capped the "already explained" list at 40 so prompt size stays flat. Verified
  with generated speech: Everything → 8 notes, tricky idioms only → 1 (the sarcasm), Off → 0
  notes and 0 Claude calls.

- **2026-11-07:** Added the cost model (cost per lecture hour, scaling with students, further
  options). Corrected board token numbers: the test image was square, real camera photos are smaller.

- **2026-11-07:** Tested with real Deepgram and Claude keys: live captions, notes, board reading
  and the mind map all work end to end. Recorded measured latency and cost.

- **2026-11-07:** Server v1: event log with caption compaction and catch-up, Deepgram streaming
  captions, Claude idiom/term notes, board reading, incremental mind map, replay and saved
  sessions, teacher console with manual and auto board capture, test viewer, smoke test.
