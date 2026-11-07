import * as z from "zod/v4";
import { askJson } from "./claude.js";
import type { EventLog, LostHighlight } from "./events.js";

const CatchUpReply = z.object({
  summary: z.array(z.string()),
  assumed: z.array(z.object({ term: z.string(), explanation: z.string() })),
});

export type CatchUp = { summary: string[]; assumed: { term: string; explanation: string }[] };

const SYSTEM = `A student in a live lecture just pressed "I'm lost". Help them get back on track fast.

You get the last few minutes of the lecture before the moment they got lost: what the teacher said, what was on the board, and the mind map topic.

Return:
- "summary": exactly 2 short lines (each under 25 words) catching them up on what was just covered, ending where the lecture is now. Plain, friendly language.
- "assumed": up to 3 ideas the teacher used WITHOUT explaining that a student might not know (background knowledge, earlier topics, notation). Each "explanation" is one plain sentence under 25 words. Skip anything the teacher explained in the transcript. Return an empty list if nothing was assumed.

If the student highlighted specific words, make sure the summary makes those words make sense, and explain them in "assumed" if they rely on knowledge the teacher didn't give.

Write maths in plain text (x² + 6x + 5 = 0, √, ±), never LaTeX. Don't mention the student, the button or the transcript.`;

const WINDOW_MS = 3 * 60_000; // "the last few minutes"
const SLICE_MS = 30_000; // students lost within the same 30 s on the same topic share one catch-up

/**
 * Personal catch-ups for "I'm lost". Shared per (30-second moment, topic), so a whole class lost
 * at the same point costs one Claude call; concurrent requests wait for the same call.
 */
export class CatchUpWriter {
  private cache = new Map<string, Promise<CatchUp | null>>();

  constructor(private log: EventLog) {}

  get(t: number, topicId?: string, highlights: LostHighlight[] = []): Promise<CatchUp | null> {
    // Students who highlighted the same words (or none) at the same moment share a catch-up.
    const words = [...new Set(highlights.map((h) => h.text.toLowerCase().replace(/\s+/g, " ").trim()))].sort();
    const key = `${Math.floor(t / SLICE_MS)}:${topicId ?? ""}:${words.join("|")}`;
    let pending = this.cache.get(key);
    if (!pending) {
      pending = this.write(t, topicId, words);
      this.cache.set(key, pending);
      // Don't keep failures: the next student gets a fresh try.
      pending.then((result) => result ?? this.cache.delete(key));
    }
    return pending;
  }

  private async write(t: number, topicId: string | undefined, highlighted: string[]): Promise<CatchUp | null> {
    const events = this.log.all();
    const said = events
      .filter((e) => e.type === "caption" && e.final && e.t <= t && e.t >= t - WINDOW_MS)
      .map((e) => (e.type === "caption" ? e.text : ""));
    if (!said.length) return null; // nothing to catch up on yet

    let board = "";
    let topic = "";
    for (const e of events) {
      if (e.type === "board" && e.t <= t) board = e.blocks.map((b) => b.plain).join("\n");
      if (e.type === "mindmap" && e.t <= t) {
        const found = e.topics?.find((x) => x.id === topicId);
        if (found) topic = `${found.label}${found.details.length ? ` (${found.details.join("; ")})` : ""}`;
        else if (e.title) topic = topic || e.title;
      }
    }

    const reply = await askJson({
      label: "catch-up",
      schema: CatchUpReply,
      effort: "low",
      system: SYSTEM,
      content: [
        ...(highlighted.length ? [`THE STUDENT HIGHLIGHTED THESE WORDS AS CONFUSING: ${highlighted.map((w) => `"${w}"`).join(", ")}`] : []),
        `TOPIC: ${topic || "(not known)"}`,
        `ON THE BOARD:\n${board || "(nothing yet)"}`,
        `WHAT THE TEACHER SAID (oldest first):\n${said.join("\n")}`,
      ].join("\n\n"),
    });
    if (!reply) return null;
    return {
      summary: reply.summary.map((s) => s.trim()).filter(Boolean).slice(0, 2),
      assumed: reply.assumed.filter((a) => a.term.trim() && a.explanation.trim()).slice(0, 3),
    };
  }
}
