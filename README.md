# SYNC.

**A live, rewindable lecture feed that makes classes easier to follow.**

A teacher talks and writes on the whiteboard as usual. Students scan a QR code and get a live feed
on their phones: captions as the teacher speaks, the whiteboard turned into clean text and rendered
equations, idioms and key terms explained in context, and a mind map of the lecture that grows as
it goes. Students can pause and scroll back without losing their place, and they can tap
**"I'm lost"** to tell the teacher anonymously.

Built at the **WiE Hackathon** around the theme *making education more accessible with AI*.

## Who it's for

- **International students and English learners:** idioms, sarcasm and course vocabulary are
  explained inline ("a piece of cake", "oh great, another negative discriminant").
- **Deaf and hard-of-hearing students:** captions appear about a second behind the voice, next to
  what's on the board.
- **Students who need to process at their own pace:** the feed can be paused and rewound, so
  writing notes no longer means missing the next sentence.
- **Teachers:** a live count of how many students are lost, and on which topic, without anyone
  having to raise a hand.

## Features

| | |
|---|---|
| **Live captions** | Streaming speech-to-text, sentence by sentence, with words appearing as they're spoken |
| **Whiteboard → text** | A photo of the board (by button, clicker or automatic change detection) becomes typed text and KaTeX equations, with plain-text and screen-reader versions of every formula |
| **Screen share** | Slides or a digital whiteboard can be the "board" too |
| **Explanations** | Idioms, sarcasm and technical terms annotated with a 1–3 difficulty level; the teacher sets what to look for, each student filters what they see |
| **Evolving mind map** | Topics, branches and how closely each relates to the main subject, with a "you are here" marker following the teacher |
| **Topic notes** | Tap a topic for a summary, key points, an example and the formulas from the board |
| **"I'm lost"** | Anonymous flags to the teacher with the exact words that confused the student, plus a personal 2-line catch-up of what was just covered |
| **Teacher console** | One-button Start lecture, live caption line, students-lost card with "Addressed" buttons, QR join code, save and replay |
| **Replay** | A built-in demo lecture and saved sessions replay with original timing, with no API calls |

## How it works

Everything the teacher says or writes becomes an **event** on one shared timeline. The server is
the only part that talks to AI. Phones just display the timeline, which is why pausing, scrolling
back and joining late all work: any phone can catch up from the full log at any moment.

```
Teacher console (mic + camera / screen share)
        │  audio chunks over WebSocket, board photos over HTTP
        ▼
Node server ── Deepgram ─────────► captions
            ── Claude (vision) ──► board text + LaTeX
            ── Claude (text) ────► explanations, mind map, focus, catch-ups
            └─ append-only event log ──► WebSocket broadcast
        ▼
Student phones (catch up on connect, then live)
```

Some of the design decisions:

- **Captions never wait for AI.** Explanations attach to a caption 2–3 s later as separate events.
- **Cost grows with lectures, not students.** Each AI call happens once and is shared, so 3 or 300
  students cost the same: about **$0.75 per lecture hour**. Board reading uses a strong vision
  model, and the high-volume text tasks use a small, fast one.
- **The board is read as an edit, not from scratch.** The model gets the current copy plus the new
  photo, so unchanged writing keeps its wording and anything hidden behind the teacher is kept.
- **The mind map is incremental.** The model returns only changes, and the server guarantees topics
  never disappear, move or get reworded.
- **Maths is always readable.** Every LaTeX string is validated server-side with KaTeX; anything
  broken falls back to readable Unicode instead of a red error.
- **Privacy:** audio is never stored, board photos live in memory only, and "I'm lost" flags are
  anonymous (a salted per-lecture token, so screens count students without identifying anyone).

More detail, measurements and the full API are in [ARCHITECTURE.md](ARCHITECTURE.md).

## Tech stack

- **Server:** Node 22, TypeScript, Express 5, `ws`
- **AI:** Anthropic API with structured outputs (Zod schemas), Deepgram streaming speech-to-text
- **Maths:** KaTeX (validation, Unicode and spoken fallbacks)
- **Teacher console and test viewer:** plain HTML/CSS/JS, markmap for the mind map
- **Student app:** React + Vite + Tailwind, in a separate repository

## Running it locally

Requires Node 22+.

```bash
cd server
npm install
npm run dev
```

Open **http://localhost:3001/teach/**, expand *Settings & tools* and press **Demo lecture**.
The demo needs no API keys. Watch it in the test viewer at
**http://localhost:3001/teach/viewer.html**.

For live captions and AI features, copy `.env.example` to `.env` in the repo root and add:

```
ANTHROPIC_API_KEY=...
DEEPGRAM_API_KEY=...
```

To try it on a phone, expose the server over HTTPS (phone cameras require it), for example
`cloudflared tunnel --url http://localhost:3001`, and open the teacher console from the tunnel
address so the join QR code points somewhere phones can reach.

Other scripts (from `server/`):

```bash
npm run typecheck   # TypeScript check
npm run smoke       # real API calls through each AI pipeline (costs a few cents)
```

## Project structure

```
server/
  src/index.ts      HTTP + WebSocket server, routes, broadcast
  src/events.ts     Event types and the event log
  src/stt.ts        Deepgram stream → sentence-sized captions
  src/board.ts      Whiteboard photo → text + LaTeX
  src/annotate.ts   Idioms, sarcasm and key terms
  src/mindmap.ts    Incremental mind map and "you are here" focus
  src/lost.ts       Anonymous "I'm lost" flags
  src/catchup.ts    Personal catch-ups for lost students
  src/notes.ts      Notes for a mind map topic
  src/mathText.ts   LaTeX validation, Unicode and spoken versions
  public/           Teacher console and test viewer
  mock/             Demo lecture and pre-generated topic notes
```

## Team

- **Leah Chen:** server, AI pipelines, teacher console
- **Grace Chen:** student app
