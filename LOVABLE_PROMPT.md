# First prompt for Lovable

Paste everything below the line into Lovable as the first message. It is deliberately
long so Lovable builds most of the app in one go and saves credits.

---

Build a mobile-first web app: a **live lecture feed for students**. A teacher talks and
writes on a whiteboard; this app shows students a live, accessible, rewindable feed of what
was said and written. A separate local server (not built here) produces the data as events.

## Hard constraints

- Frontend only. Do NOT connect Supabase or Lovable Cloud, and do NOT add auth or any AI features.
- All lecture data comes through ONE hook, `useLectureEvents()`, in `src/lib/events.ts`.
  Components never fetch data any other way.
- **Mode:** `live` if the URL has `?mode=live` or `import.meta.env.VITE_MODE === "live"`,
  otherwise `mock`.
  - **mock:** replay the sample events at the bottom of this prompt (put them in
    `src/lib/mockLecture.ts`) on a timer, using each event's `t` (ms since lecture start).
  - **live:** open a WebSocket to `import.meta.env.VITE_WS_URL`, defaulting to the same
    origin at path `/ws` (`wss:` on https, `ws:` on http). Each message is one JSON
    `LectureEvent`. On connect the server re-sends all past events, then streams new ones,
    so clear local state on reconnect. Reconnect automatically with backoff and show a
    small "Reconnecting…" banner while disconnected.
- A `caption` with an `id` that already exists replaces the earlier one (partial → final).
- Export these TypeScript types from `src/lib/events.ts` and use them everywhere:

```ts
export type LectureEvent =
  | { type: "caption"; id: string; t: number; text: string; final: boolean }
  | { type: "annotation"; captionId: string; kind: "idiom" | "term"; phrase: string; meaning: string;
      level: 1 | 2 | 3 } // how likely it is to confuse a student: 1 = most know it, 3 = likely to confuse
  | { type: "board"; id: string; t: number; snapshotUrl: string;
      blocks: { id: string; kind: "text" | "equation"; content: string }[] } // equations are LaTeX
  | { type: "mindmap"; t: number; markdown: string };
```

## Student view (`/`)

- **Header:** lecture title, a status pill ("LIVE" with a green dot, or "PAUSED"), and a
  settings button.
- **Bottom tab bar:** Feed · Board · Mind map.
- **Feed tab** (chronological):
  - Captions as readable paragraphs. Partial captions (`final: false`) appear muted and are
    replaced in place when the final version arrives.
  - Annotations: highlight the annotation's `phrase` inside its caption with a dotted
    underline. Tapping it expands the meaning inline under the sentence, labelled
    "AI explanation". Idioms and key terms get different colors AND a different icon plus
    a text label, never color alone.
  - Board events appear in the feed as cards: a small snapshot thumbnail (tap to enlarge)
    beside the cleaned-up content. Text blocks render as text; equation blocks render with
    **KaTeX**. Card label: "AI transcribed from the board · tap the photo to check".
  - **Auto-scroll and pause:** while the user is at the bottom, new items auto-scroll into
    view. As soon as the user scrolls up, stop auto-scrolling, set the pill to "PAUSED", and
    show a floating **"Jump to live (N new)"** button. Tapping it scrolls to the bottom and
    resumes. Also add an explicit Pause / Resume button.
- **Board tab:** the latest board state, large and full width, with a toggle to show the
  original snapshot.
- **Mind map tab:** render the latest `mindmap` markdown with **markmap** (`markmap-lib` +
  `markmap-view`), fitted to the screen, with pan and pinch-zoom. When a new mindmap event
  arrives, update it in place without resetting the user's zoom if possible.

## Settings (bottom sheet)

- Font: System / Atkinson Hyperlegible / Lexend / OpenDyslexic
- Text size slider (16–32 px), line spacing slider (1.4–2.2), wider letter spacing toggle
- Theme: Light / Dark / High contrast
- Density preset:
  - **Focus:** captions and board cards only, large text, annotations collapsed until tapped
  - **Standard:** the default
  - **Detailed:** timestamps on every item, all annotations expanded
- "Explanations" choice: **Everything** (level 1+, the default) / **Standard** (level 2+) /
  **Only tricky ones** (level 3 only) / **Off**. It hides annotations below the chosen `level`
  on this phone only.
- Read aloud toggle: speak each new FINAL caption with the browser's SpeechSynthesis, plus
  a speech-rate slider
- Apply settings through CSS variables on the root element. Save them to localStorage,
  wrapped in try/catch so the app still works if storage is blocked.

## Join page (`/join`)

For projecting on a screen: a large QR code (`qrcode.react`) for `{current origin}/?mode=live`,
with that URL in big text underneath and a one-line instruction ("Scan to follow the lecture").

## Accessibility (required)

- One visually hidden `aria-live="polite"` region that announces only FINAL captions,
  never partials.
- Everything keyboard-accessible with a visible focus ring; touch targets at least 44×44 px.
- WCAG AA contrast in every theme. Respect `prefers-reduced-motion` (no smooth-scroll animation).
- Semantic HTML landmarks; every icon button has an accessible label.

## Look and feel

Calm, clean, highly readable, generous whitespace. Feels like a focused reading app, not a
dashboard and not childish.

## Sample events for mock mode (use exactly these)

```json
[
  {"type":"caption","id":"c1","t":0,"text":"Okay everyone, today we're","final":false},
  {"type":"caption","id":"c1","t":1500,"text":"Okay everyone, today we're tackling quadratic equations.","final":true},
  {"type":"caption","id":"c2","t":4500,"text":"Don't worry, once you see the pattern this is a piece of cake.","final":true},
  {"type":"annotation","captionId":"c2","kind":"idiom","phrase":"a piece of cake","meaning":"Very easy.","level":2},
  {"type":"caption","id":"c3","t":9000,"text":"A quadratic is any equation where the highest power of x is two.","final":true},
  {"type":"annotation","captionId":"c3","kind":"term","phrase":"quadratic","meaning":"An equation whose highest power of the variable is 2, like ax² + bx + c = 0.","level":2},
  {"type":"mindmap","t":11000,"markdown":"# Quadratic equations\n## Definition\n- Highest power of x is 2"},
  {"type":"board","id":"b1","t":15000,"snapshotUrl":"/placeholder.svg","blocks":[{"id":"k1","kind":"text","content":"Standard form"},{"id":"k2","kind":"equation","content":"ax^2 + bx + c = 0"}]},
  {"type":"caption","id":"c4","t":19000,"text":"As a rule of thumb, always get it into standard form first.","final":true},
  {"type":"annotation","captionId":"c4","kind":"idiom","phrase":"rule of thumb","meaning":"A general guideline that usually works, not a strict rule.","level":2},
  {"type":"caption","id":"c5","t":24000,"text":"Then we plug a, b and c into the quadratic formula.","final":true},
  {"type":"board","id":"b2","t":28000,"snapshotUrl":"/placeholder.svg","blocks":[{"id":"k1","kind":"text","content":"Standard form"},{"id":"k2","kind":"equation","content":"ax^2 + bx + c = 0"},{"id":"k3","kind":"text","content":"Quadratic formula"},{"id":"k4","kind":"equation","content":"x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}"}]},
  {"type":"mindmap","t":31000,"markdown":"# Quadratic equations\n## Definition\n- Highest power of x is 2\n## Standard form\n- ax² + bx + c = 0\n## Quadratic formula\n- x = (−b ± √(b² − 4ac)) / 2a"},
  {"type":"caption","id":"c6","t":35000,"text":"The part under the square root is called the discriminant.","final":true},
  {"type":"annotation","captionId":"c6","kind":"term","phrase":"discriminant","meaning":"b² − 4ac. Its sign tells you how many real solutions there are.","level":3},
  {"type":"caption","id":"c7","t":40000,"text":"Oh great, another negative discriminant.","final":true},
  {"type":"annotation","captionId":"c7","kind":"idiom","phrase":"Oh great","meaning":"Said sarcastically: the speaker isn't actually happy. A negative discriminant means there are no real solutions.","level":3},
  {"type":"mindmap","t":43000,"markdown":"# Quadratic equations\n## Definition\n- Highest power of x is 2\n## Standard form\n- ax² + bx + c = 0\n## Quadratic formula\n- x = (−b ± √(b² − 4ac)) / 2a\n## Discriminant\n- b² − 4ac\n- Negative → no real solutions"}
]
```

---

# Follow-up prompts

Use these only if the first prompt above was already pasted before they were added.

## 1. Explanation levels (added 2026-11-07)

> Annotation events now include a `level` field: `1 | 2 | 3` (how likely the phrase is to
> confuse a student: 1 = most students know it, 3 = likely to confuse). Add it to the
> `LectureEvent` type in `src/lib/events.ts` and to every annotation in the mock data:
> "a piece of cake" 2, "quadratic" 2, "rule of thumb" 2, "discriminant" 3, "Oh great" 3.
> In Settings, replace the "Explain idioms and key terms" toggle with an "Explanations" choice:
> Everything (level 1+, default) / Standard (level 2+) / Only tricky ones (level 3 only) / Off.
> It hides annotations below the chosen level on this phone only. Save it with the other settings.

## 2. Mind map placed by relatedness (added 2026-11-07)

> Mind map events now also include `title` and `topics` (the `markdown` field stays, so nothing
> breaks). Add them to the `LectureEvent` type:
>
> ```ts
> { type: "mindmap"; t: number; markdown: string; title?: string;
>   topics?: { id: string; label: string; relatedness: number; details: string[];
>              links: { to: string; strength: number }[] }[] }
> ```
>
> `relatedness` (0–1) is how closely a topic relates to the lecture's main subject; `links` connect
> related topics (`to` is another topic's id, `strength` 0–1). Topic ids stay the same across updates.
>
> Redraw the Mind map tab as a **radial map** using `d3-force` (add it as a dependency):
> - The `title` sits fixed in the centre.
> - Each topic is a node pulled to a ring whose radius grows as relatedness drops:
>   `radius = minR + (1 - relatedness) * (maxR - minR)` with `forceRadial`. Core topics hug the
>   centre; tangents sit near the edge.
> - `forceLink` between linked topics (strength from `links`) so related topics cluster on the
>   same side; `forceCollide` so labels don't overlap.
> - A topic's `details` appear as small chips under its label (or on tap, on small screens).
> - Keep node positions keyed by `id` between updates so existing topics don't jump; new topics
>   animate in. Respect `prefers-reduced-motion`.
> - Draw a faint ring guide at each relatedness band and a small legend: "closer to the centre =
>   more related to today's topic".
> - If an event has no `topics`, fall back to the current markmap tree from `markdown`.
>
> Add this sample as the last event of the mock lecture (at t: 50000) so the layout has a tangent
> to show:
>
> ```json
> {"type": "mindmap", "t": 50000, "markdown": "# Quadratic equations\n## Definition\n- Highest power of x is 2\n## Standard form\n- ax² + bx + c = 0\n## Quadratic formula\n- x = (−b ± √(b² − 4ac)) / 2a\n## Discriminant\n- b² − 4ac\n- Negative → no real solutions\n## Babylonian origins\n- Solved ~4,000 years ago\n- Written on clay tablets", "title": "Quadratic equations", "topics": [{"id": "t1", "label": "Definition", "relatedness": 0.9, "details": ["Highest power of x is 2"], "links": []}, {"id": "t2", "label": "Standard form", "relatedness": 0.85, "details": ["ax² + bx + c = 0"], "links": [{"to": "t1", "strength": 0.6}]}, {"id": "t3", "label": "Quadratic formula", "relatedness": 0.9, "details": ["x = (−b ± √(b² − 4ac)) / 2a"], "links": [{"to": "t2", "strength": 0.8}]}, {"id": "t4", "label": "Discriminant", "relatedness": 0.8, "details": ["b² − 4ac", "Negative → no real solutions"], "links": [{"to": "t3", "strength": 0.9}]}, {"id": "t5", "label": "Babylonian origins", "relatedness": 0.3, "details": ["Solved ~4,000 years ago", "Written on clay tablets"], "links": [{"to": "t3", "strength": 0.3}]}]}
> ```

## 3. "You are here" dot on the mind map (added 2026-11-07)

> The server now also sends **focus** events: which mind map topic the teacher is talking about
> right now. Add this to the `LectureEvent` union in `src/lib/events.ts`:
>
> ```ts
> | { type: "focus"; t: number; topicId: string } // id of a topic in the latest mindmap event
> ```
>
> Store the latest one in the lecture state (`latestFocus`). On reconnect the server re-sends only
> the most recent focus event. A focus may arrive before or after the mind map that contains its
> topic, so look the id up whenever either changes and show nothing if it isn't found.
>
> On the radial mind map:
> - Draw a **"you are here" marker** on the focused topic: a small solid dot in the live/accent
>   colour sitting on the edge of the topic's bubble, with a soft pulsing halo, and a tiny "Now"
>   label next to it.
> - When the focus changes, **animate the dot travelling** from the old topic to the new one
>   (about 600 ms, eased, passing near the centre), then pulse once on arrival. With
>   `prefers-reduced-motion`, jump without animation or pulsing.
> - Give the focused topic's bubble a slightly stronger outline so it reads as "current" even
>   without the dot.
> - Above the map show a small chip: "● Now: {topic label}". Tapping it centres the map on that topic.
> - In the markmap tree fallback (no `topics`), skip the dot.
> - Accessibility: put the "Now: {label}" text in an `aria-live="polite"` region so screen readers
>   hear when the lecture moves to a new topic.
>
> Add these to the mock lecture right after each mind map event so the dot moves in mock mode:
>
> ```json
> {"type":"focus","t":11500,"topicId":"t1"}
> {"type":"focus","t":31500,"topicId":"t3"}
> {"type":"focus","t":43500,"topicId":"t4"}
> {"type":"focus","t":50500,"topicId":"t5"}
> ```

## 4. Readable maths on the board (added 2026-11-07)

> Board blocks now carry readable versions of their maths. Update the block type in
> `src/lib/events.ts`:
>
> ```ts
> blocks: { id: string; kind: "text" | "equation";
>           content: string;  // equation: LaTeX. text: words, with any maths inside $…$
>           plain: string;    // readable Unicode, e.g. "x = (−b ± √(b² − 4ac)) / 2a"
>           spoken: string;   // words for screen readers, e.g. "x, equals, start fraction, minus, b, …"
>         }[]
> ```
>
> The server guarantees every LaTeX string renders with KaTeX 0.19.1 and never sends stray
> `^`, `_` or backslash commands in text. Make the board easy to read:
> - **Text blocks with maths:** split `content` on `$…$` (ignore an escaped `\$`) and render each maths
>   part inline with KaTeX (`displayMode: false`); everything else is plain text. Never show the
>   `$` signs or raw LaTeX anywhere: Feed, Board tab, enlarged view or bullets.
> - **The condensed bullets** ("first 6 words…" summaries) must never cut inside a `$…$` part:
>   count words from `plain`, and when you shorten a line, show the start of `plain` instead.
> - **Equation blocks:** render with KaTeX `displayMode: true` inside a try/catch with
>   `throwOnError: true`; if it fails, show `plain` as text (no red error text). Make equations
>   clearly bigger than body text (scale with the reader's text-size setting), give them generous
>   line height, and let wide ones scroll sideways with a soft fade at the edge instead of shrinking.
> - **Accessibility:** use `spoken` as the `aria-label` of every board line (not the LaTeX). Read-aloud
>   should speak `spoken` for board lines.
> - **Copy:** a small "Copy" action on equations copies `plain`.
> - **High contrast theme:** equations use the full foreground colour.
> - Older events without `plain`/`spoken` (mock data from before): fall back to `content`.
>
> Replace the board events in the mock lecture with this shape. Example (the second board):
>
> ```json
> {"type": "board", "id": "b2", "t": 28000, "snapshotUrl": "/placeholder.svg", "blocks": [{"id": "k1", "kind": "text", "content": "Standard form", "plain": "Standard form", "spoken": "Standard form"}, {"id": "k2", "kind": "equation", "content": "ax^2 + bx + c = 0", "plain": "ax² + bx + c = 0", "spoken": "a, x, squared, plus, b, x, plus, c, equals, 0"}, {"id": "k3", "kind": "text", "content": "Quadratic formula", "plain": "Quadratic formula", "spoken": "Quadratic formula"}, {"id": "k4", "kind": "equation", "content": "x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}", "plain": "x = (−b ± √(b² − 4ac)) / 2a", "spoken": "x, equals, start fraction, minus, b, plus minus, square root of, b, squared, minus, 4, a, c, end square root, divided by, 2, a, end fraction"}, {"id": "k5", "kind": "text", "content": "Works whenever $a \\neq 0$", "plain": "Works whenever a ≠ 0", "spoken": "Works whenever a, does not equal, 0"}]}
> ```

## 5. "I'm lost" reaches the teacher (added 2026-11-07)

> Right now "I'm lost" flags stay on the student's own phone, so the teacher never sees them.
> Send them to the lecture server instead, and build the Pulse view from everyone's flags.
>
> **New event** from the server (add to the `LectureEvent` union and keep a `lost` array in the
> lecture state; on reconnect the server re-sends all of them):
>
> ```ts
> | { type: "lost"; t: number; at: number; topicId?: string; captionId?: string }
> // t: lecture moment the student was lost at · at: when they pressed it
> // topicId: mind map topic (if known) · captionId: what was being said at t (if known)
> ```
>
> **Sending a flag** (when the student confirms in the "Which part lost you?" sheet):
> - `POST {serverBase}/api/lost` with JSON `{ clientId, t, topicId }`. `serverBase` is the
>   `?server=` address when present, otherwise the page's own origin (same rule as the WebSocket).
> - `clientId`: a random id made once with `crypto.randomUUID()` and kept in localStorage
>   (`lectureLensClientId`; wrap storage in try/catch and fall back to an in-memory id). It's only
>   used to stop one phone counting twice. Never send names or anything personal.
> - `topicId` is optional: if the student doesn't pick one, the server fills in the topic the
>   teacher was on at moment `t`.
> - Responses: `200 { ok: true, duplicate, topicId?, students }`. Show a confirmation (in an
>   `aria-live` region): "Sent anonymously. {students} student(s) lost on {topic label} right now."
>   If `duplicate` is true: "You've already flagged this. Your teacher knows." On `429`: "Give it a
>   few seconds before flagging again." On a network error: "Couldn't send. Try again."
>
> **The sheet:** keep the timestamp slider and the quote of what was being said. Above it, add
> topic chips from the latest mind map topics, with the current focus topic pre-selected and a
> "Not sure" chip (sends no `topicId`). Moving the slider pre-selects the topic that was current
> at that moment if you know it.
>
> **Remove the local `flags` state.** The Pulse tab now uses the `lost` events from the server
> (class-wide, anonymous): bars per topic (labels from the latest mind map; "Not on the mind map
> yet" for flags without a known topic) and per 30-second moment with the quoted caption (look up
> `captionId`). Add a line for students: "You're not alone: {n} students flagged this part."
>
> Add these to the mock lecture (after the event at t: 28000, 36000 and 40000 respectively) so the
> Pulse view has data in mock mode:
>
> ```json
> {"type":"lost","t":24500,"at":30000,"topicId":"t3","captionId":"c5"}
> {"type":"lost","t":36000,"at":39000,"topicId":"t4","captionId":"c6"}
> {"type":"lost","t":40500,"at":42000,"topicId":"t4","captionId":"c7"}
> ```

## 6. "I'm lost" catch-up for the student (added 2026-11-07)

> The response from `POST /api/lost` (prompt 5) now also includes a personal catch-up:
>
> ```ts
> {
>   ok: true, duplicate: boolean, t: number, topicId?: string, students: number,
>   catchUp: null | {
>     summary: string[];                                  // exactly 2 short lines
>     assumed: { term: string; explanation: string }[];   // 0–3 things the teacher assumed you knew
>   }
> }
> ```
>
> It takes about 2–5 seconds (the teacher's count updates instantly; the catch-up is written by AI).
> All text is plain (maths like x² + 6x + 5 = 0), so render it as text.
>
> After the student confirms in the "Which part lost you?" sheet, turn the sheet into a
> **catch-up card** instead of closing it:
> - While waiting: a calm skeleton with "Catching you up…" (no spinner flashing; respect
>   reduced motion).
> - Heading "Here's what you missed", then the 2 `summary` lines as short paragraphs in
>   comfortable reading size (follow the reader's font, size and spacing settings).
> - If `assumed` isn't empty: a section "You were assumed to know" listing each `term` in bold
>   with its `explanation`; collapsed behind a "Show" toggle when there are more than 2.
> - A small line underneath: "{students} student(s) lost here too. Your teacher can see it."
>   (anonymous).
> - Buttons: "Got it" (closes and jumps the feed back to live) and "Read it to me" (speaks the
>   summary and explanations with the browser's speech synthesis).
> - If `catchUp` is null (nothing to summarise yet, or the AI was unavailable), show just the
>   confirmation from prompt 5.
> - Put the card's text in an `aria-live="polite"` region so screen readers read it when it arrives.
>
> For mock mode, when the student presses "I'm lost", wait 1.5 s and show this sample:
>
> ```json
> {"ok":true,"duplicate":false,"t":45034,"topicId":"t4","students":2,"catchUp":{"summary":["Quadratics have x² as the highest power; rearrange to ax² + bx + c = 0, then plug a, b, c into the quadratic formula.","The part under the square root, b² − 4ac, is the discriminant; now we've hit an example where it's negative."],"assumed":[{"term":"Square root of a negative number","explanation":"No real number squared gives a negative, so √ of a negative has no real answer, meaning the equation has no real solutions."},{"term":"± symbol","explanation":"Plus-or-minus means you work out the formula twice, once adding and once subtracting, usually giving two answers."},{"term":"Coefficients a, b, c","explanation":"These are the numbers in front of x², in front of x, and the constant on its own, read from standard form."}]}}
> ```

## 7. Send the highlighted words to the teacher (added 2026-11-07)

> The lecture server now accepts the exact words a student highlights, so the teacher can see
> them. Change `sendLost` in `src/lib/lost.ts`:
>
> - Send **one request per "I'm lost" press** (not one per timestamp) with all the highlighted
>   pieces:
>   ```ts
>   POST {serverBase}/api/lost
>   { clientId, t?, highlights: { source: "feed" | "board"; sourceId: string; text: string }[] }
>   ```
>   `source`/`sourceId` are the `TextPiece` fields (caption id for "feed", board block id for
>   "board"); `text` is the highlighted words exactly as shown (for board lines, from `plain`).
>   Send up to 5 pieces. `t` is optional: without it the server uses the earliest highlighted line.
> - The server only keeps words that really appear in that caption or board line, and replies
>   `{ ok, duplicate, t, topicId?, highlights, students, catchUp }`; `highlights` is what it kept.
> - Replace the note "Your teacher receives the lecture moments, not the highlighted words" with
>   "Your teacher sees the words you highlight. It's anonymous."
> - `lost` events now may include `highlights` (same shape). In the Pulse tab, under each moment,
>   list the highlighted words with how many students marked them (most first), instead of only the
>   whole caption.
> - Update `src/test/lost.test.ts`: the request body now has `clientId`, `highlights` (and `t` when
>   sent).
> - The catch-up card (prompt 6) now focuses on the highlighted words; no change needed there.
