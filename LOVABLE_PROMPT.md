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
