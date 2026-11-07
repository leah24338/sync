import * as z from "zod/v4";
import { askJson } from "./claude.js";
import type { EventLog, LectureEvent, MindmapTopic } from "./events.js";

const NotesReply = z.object({
  summary: z.string(),
  keyPoints: z.array(z.string()),
  example: z.string(),
});

export type TopicNotes = {
  topicId: string;
  label: string;
  parentLabel?: string;
  /** 2–3 sentences. */
  summary: string;
  /** 3–6 short revision points. */
  keyPoints: string[];
  /** A worked example or analogy from the lecture, or "". */
  example: string;
  /** Equations written on the board while this topic was discussed. */
  formulas: { latex: string; plain: string; spoken: string }[];
  /** Idioms and terms explained during this topic. */
  terms: { phrase: string; meaning: string }[];
  /** How much lecture material the notes were written from. */
  basedOn: { sentences: number; boardLines: number };
};

const SYSTEM = `You write short revision notes for one topic of a live lecture, for a student who taps the topic on the lecture's mind map.

Use only what the lecture covered (what the teacher said and wrote), adding at most a few words of clarification. Return:
- "summary": 2–3 plain sentences explaining the topic as taught.
- "keyPoints": 3–6 short points (each under 18 words) a student should remember.
- "example": one worked example or analogy from the lecture in 1–2 sentences, or "" if there wasn't one.

Write maths in plain text (x² + 6x + 5 = 0, √, ±), never LaTeX. Don't mention the transcript or the student.`;

const BOARD_GRACE_MS = 20_000; // board photos usually land a little after the words they go with
const FOCUS_LAG_MS = 8_000;
const STOP_WORDS = new Set(["with", "from", "that", "this", "into", "when", "what", "real", "only", "more", "some"]);

/**
 * Notes for a mind map topic, written when someone first opens it and shared with everyone.
 * Grounded in what was said while the "you are here" focus was on that topic (or its branches),
 * the board at that time and the terms explained then. Regenerated only when the topic has grown.
 */
export class TopicNotesWriter {
  private focusHistory: { t: number; topicId: string }[] = [];
  private cache = new Map<string, Promise<TopicNotes>>();

  constructor(private log: EventLog) {}

  observe(event: LectureEvent): void {
    if (event.type === "focus") this.focusHistory.push({ t: event.t, topicId: event.topicId });
  }

  get(topicId: string): Promise<TopicNotes> | null {
    const map = this.latestMap();
    const topic = map?.find((t) => t.id === topicId);
    if (!map || !topic) return null;
    const material = this.gather(topic, map);
    const key = `${topicId}:${topic.label}:${topic.details.length}:${material.sentences.length}:${material.boardLines.length}`;
    let pending = this.cache.get(key);
    if (!pending) {
      pending = this.write(topic, map, material);
      this.cache.set(key, pending);
    }
    return pending;
  }

  private latestMap(): MindmapTopic[] | undefined {
    let topics: MindmapTopic[] | undefined;
    for (const e of this.log.all()) if (e.type === "mindmap" && e.topics) topics = e.topics;
    return topics;
  }

  /** Everything said, written and explained while the lecture was on this topic or its branches. */
  private gather(topic: MindmapTopic, map: MindmapTopic[]) {
    const ids = new Set([topic.id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const t of map) if (t.parentId && ids.has(t.parentId) && !ids.has(t.id)) ids.add(t.id), (grew = true);
    }
    const windows: [number, number][] = [];
    this.focusHistory.forEach((f, i) => {
      if (ids.has(f.topicId)) windows.push([f.t, this.focusHistory[i + 1]?.t ?? Infinity]);
    });
    // The focus moves a few seconds after the words that caused it, so windows start a bit early.
    const inWindow = (t: number, grace = 0) => windows.some(([a, b]) => t >= a - FOCUS_LAG_MS && t < b + grace);

    const events = this.log.all();
    // Also use any sentence that names the topic (or one of its branches), wherever it was said.
    const words = map
      .filter((t) => ids.has(t.id))
      .flatMap((t) => t.label.toLowerCase().split(/\W+/))
      .filter((w) => w.length > 3 && !STOP_WORDS.has(w));
    const mentions = (text: string) => words.some((w) => text.toLowerCase().includes(w));

    const captions = events.filter(
      (e): e is Extract<LectureEvent, { type: "caption" }> => e.type === "caption" && e.final && (inWindow(e.t) || mentions(e.text)),
    );
    const captionIds = new Set(captions.map((c) => c.id));
    const terms = events
      .filter((e): e is Extract<LectureEvent, { type: "annotation" }> => e.type === "annotation" && captionIds.has(e.captionId))
      .map((a) => ({ phrase: a.phrase, meaning: a.meaning }));

    const boardLines: string[] = [];
    const formulas: TopicNotes["formulas"] = [];
    for (const e of events) {
      if (e.type !== "board") continue;
      const relevant = windows.length ? inWindow(e.t, BOARD_GRACE_MS) : e.blocks.some((b) => mentions(b.plain));
      if (!relevant) continue;
      for (const b of e.blocks) {
        if (!boardLines.includes(b.plain)) boardLines.push(b.plain);
        if (b.kind === "equation" && !formulas.some((f) => f.latex === b.content)) {
          formulas.push({ latex: b.content, plain: b.plain, spoken: b.spoken });
        }
      }
    }
    return { sentences: captions.map((c) => c.text).slice(-40), boardLines, formulas: formulas.slice(0, 4), terms: terms.slice(0, 5) };
  }

  private async write(topic: MindmapTopic, map: MindmapTopic[], material: ReturnType<TopicNotesWriter["gather"]>): Promise<TopicNotes> {
    const parentLabel = map.find((t) => t.id === topic.parentId)?.label;
    const branches = map.filter((t) => t.parentId === topic.id).map((t) => t.label);
    const reply = await askJson({
      label: `notes ${topic.id}`,
      schema: NotesReply,
      effort: "low",
      task: "text",
      system: SYSTEM,
      content: [
        `TOPIC: ${topic.label}${parentLabel ? ` (part of: ${parentLabel})` : ""}`,
        `MIND MAP DETAILS: ${topic.details.join("; ") || "(none)"}`,
        ...(branches.length ? [`BRANCHES OF THIS TOPIC: ${branches.join("; ")}`] : []),
        `ON THE BOARD:\n${material.boardLines.join("\n") || "(nothing)"}`,
        `WHAT THE TEACHER SAID:\n${material.sentences.join("\n") || "(nothing recorded for this topic)"}`,
      ].join("\n\n"),
    });
    return {
      topicId: topic.id,
      label: topic.label,
      ...(parentLabel && { parentLabel }),
      // Without the AI, the mind map's own details still make useful notes.
      summary: reply?.summary.trim() ?? "",
      keyPoints: reply ? reply.keyPoints.map((p) => p.trim()).filter(Boolean).slice(0, 6) : topic.details,
      example: reply?.example.trim() ?? "",
      formulas: material.formulas,
      terms: material.terms,
      basedOn: { sentences: material.sentences.length, boardLines: material.boardLines.length },
    };
  }
}
