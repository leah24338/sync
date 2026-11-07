import * as z from "zod/v4";
import { askJson } from "./claude.js";
import { config } from "./config.js";
import type { EventLog, MindmapTopic } from "./events.js";

const Changes = z.object({
  title: z.string(),
  current: z.string(),
  topics: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      relatedness: z.number(),
      parentId: z.string(),
      details: z.array(z.string()),
      links: z.array(z.object({ to: z.string(), strength: z.number() })),
    }),
  ),
});

const SYSTEM = `You maintain a mind map of a live lecture. The lecture's main subject ("title") is the centre of the map.

You get the CURRENT MAP (JSON) and the NEW TRANSCRIPT since the last update. Return only what changed:
- "title": the main subject. Repeat the current one; rename it only once the subject becomes clear.
- "topics": only topics that are new, or existing topics that gain new details or links. For an existing topic, repeat its id and label and list only the new details.
- "current": the id of the topic (existing or new) that the END of the new transcript is about, or "" if it's about none of them.

Each topic has:
- "id": keep existing ids; give new topics new ids (t1, t2, ...).
- "label": under 8 words.
- "details": short facts under 8 words each. Write maths in plain text (x² + 1), not LaTeX.
- "parentId": the id of the topic this one BRANCHES OFF (one of its cases, methods, examples, parts or consequences), or "" if it comes straight off the main subject. Build a real tree: e.g. "Factoring" and "Quadratic formula" branch off "Solving methods"; "Discriminant" branches off "Quadratic formula"; "Negative discriminant" branches off "Discriminant".
- "relatedness": how closely the topic relates to the main subject, 0 to 1. The app draws low-relatedness topics further out.
    1.0 the main subject itself · 0.7–0.9 a direct part of it · 0.4–0.6 background, an application or a connected idea · 0.1–0.3 a tangent or a different subject
- "links": OTHER connections beyond the parent ("to" is their id), with "strength" 0 to 1. Only link genuinely connected topics.

Rules:
- Put each new detail under the topic it belongs to; create a topic only for something new. Prefer a branch under an existing topic over a new top-level topic when it's a part of that topic.
- If the teacher moves on to something unrelated, add it as its own topic with low relatedness instead of forcing it under an existing one.
- Ignore filler, jokes and classroom logistics.
- If nothing new is worth adding, return the current title and an empty topics list (still fill in "current").`;

const Focus = z.object({ topicId: z.string() });

const FOCUS_SYSTEM = `You track where a live lecture is on its mind map.
Given the mind map's topics and the last few things the teacher said (most recent last), return the id of the topic the MOST RECENT sentences are about.
If they aren't about any listed topic (small talk, logistics, or something not on the map yet), return an empty string.`;

const MIN_NEW_WORDS = 15;
const MIN_FOCUS_WORDS = 6;

type MindMap = { title: string; topics: MindmapTopic[] };

/**
 * Grows the mind map every ~45 s. Each update sends the current map plus only what was said or
 * written since the last update, and Claude returns only the changes, which the server merges.
 * So the reply stays small however big the map gets, and the server (not the model) guarantees
 * that topics never disappear, move or get reworded between updates.
 */
export class MindMapper {
  private map: MindMap = { title: "", topics: [] };
  private pending: string[] = [];
  private busy = false;
  private timer: NodeJS.Timeout;

  // "You are here" tracking: the last few sentences, and words said since the last check.
  private recent: string[] = [];
  private wordsSinceFocus = 0;
  private focusId: string | null = null;
  private focusBusy = false;
  private focusTimer: NodeJS.Timeout;

  constructor(private log: EventLog) {
    this.timer = setInterval(() => void this.update(), config.mindmapIntervalMs);
    this.focusTimer = setInterval(() => void this.checkFocus(), config.focusIntervalMs);
  }

  addSpeech(text: string): void {
    this.pending.push(text);
    this.remember(text);
  }

  addBoard(text: string): void {
    this.pending.push(`[Written on the board] ${text}`);
    this.remember(`[Written on the board] ${text}`);
  }

  stop(): void {
    clearInterval(this.timer);
    clearInterval(this.focusTimer);
  }

  private remember(text: string): void {
    this.recent = [...this.recent, text].slice(-4);
    this.wordsSinceFocus += text.split(/\s+/).length;
  }

  /** Sends a focus event only when the topic actually changes. */
  private setFocus(topicId: string): void {
    if (topicId === this.focusId || !this.map.topics.some((t) => t.id === topicId)) return;
    this.focusId = topicId;
    this.log.push({ type: "focus", t: this.log.now(), topicId });
    console.log(`[focus] now on "${this.map.topics.find((t) => t.id === topicId)?.label}"`);
  }

  /**
   * Between mind map updates, a small, cheap call (topic list + last few sentences) checks which
   * existing topic the teacher is on, so the "you are here" dot follows them back to earlier ideas.
   * It runs only after new speech, and "none of these" keeps the dot where it was.
   */
  private async checkFocus(): Promise<void> {
    if (this.focusBusy || this.busy || this.wordsSinceFocus < MIN_FOCUS_WORDS || !this.map.topics.length) return;
    this.focusBusy = true;
    this.wordsSinceFocus = 0;
    try {
      const topics = this.map.topics.map((t) => `${t.id}: ${t.label}${t.details.length ? ` (${t.details.join("; ")})` : ""}`);
      const result = await askJson({
        label: "focus",
        schema: Focus,
        effort: "low",
        task: "text",
        system: FOCUS_SYSTEM,
        content: `TOPICS:\n${topics.join("\n")}\n\nWHAT THE TEACHER JUST SAID:\n${this.recent.join("\n")}`,
      });
      if (result?.topicId) this.setFocus(result.topicId);
    } finally {
      this.focusBusy = false;
    }
  }

  private async update(): Promise<void> {
    const newText = this.pending.join("\n");
    // Skip the call entirely when too little has happened since the last update.
    if (this.busy || newText.split(/\s+/).length < MIN_NEW_WORDS) return;
    this.busy = true;
    this.pending = [];
    try {
      const changes = await askJson({
        label: "mindmap",
        schema: Changes,
        effort: "low",
        task: "text",
        system: SYSTEM,
        content: `CURRENT MAP:\n${this.map.topics.length ? JSON.stringify(this.map) : "(empty: start a new one)"}\n\nNEW TRANSCRIPT:\n${newText}`,
      });
      if (!changes) {
        this.pending.unshift(newText); // try again next tick
        return;
      }
      const merged = merge(this.map, changes);
      if (JSON.stringify(merged) !== JSON.stringify(this.map)) {
        this.map = merged;
        this.log.push({ type: "mindmap", t: this.log.now(), markdown: toMarkdown(merged), ...merged });
        console.log(`[mindmap] update sent: ${merged.topics.length} topics`);
      } else {
        console.log("[mindmap] nothing new worth adding (filler, or already covered)");
      }
      // The update already knows where the speech ended up, so no separate focus check is needed.
      if (changes.current) {
        this.setFocus(changes.current);
        this.wordsSinceFocus = 0;
      }
    } finally {
      this.busy = false;
    }
  }
}

/** Applies Claude's changes: new topics are added; existing topics only gain details and links. */
function merge(current: MindMap, changes: z.infer<typeof Changes>): MindMap {
  const topics = current.topics.map((t) => ({ ...t, details: [...t.details], links: [...t.links] }));
  const byId = new Map(topics.map((t) => [t.id, t]));

  for (const change of changes.topics) {
    const details = change.details.map((d) => d.trim()).filter(Boolean);
    let topic = byId.get(change.id);
    if (!topic) {
      if (!change.label.trim()) continue;
      topic = { id: change.id, label: change.label.trim(), relatedness: clamp01(change.relatedness), details: [], links: [] };
      // A topic's place in the tree is set once, when it first appears, so branches never move.
      if (change.parentId && change.parentId !== change.id) topic.parentId = change.parentId;
      topics.push(topic);
      byId.set(topic.id, topic);
    }
    for (const d of details) if (!topic.details.includes(d)) topic.details.push(d);
    for (const link of change.links) {
      const existing = topic.links.find((l) => l.to === link.to);
      if (existing) existing.strength = Math.max(existing.strength, clamp01(link.strength));
      else topic.links.push({ to: link.to, strength: clamp01(link.strength) });
    }
  }

  // Links and parents may point at topics added later in the same reply, so check once everything
  // is in. A parent that doesn't exist, or that would make a loop, puts the topic off the centre.
  for (const topic of topics) {
    topic.links = topic.links.filter((l) => l.to !== topic.id && byId.has(l.to));
    if (topic.parentId && (!byId.has(topic.parentId) || makesLoop(topic, byId))) delete topic.parentId;
    // Also express the branch as a strong link, for layouts that only read links.
    if (topic.parentId && !topic.links.some((l) => l.to === topic.parentId)) topic.links.unshift({ to: topic.parentId, strength: 0.9 });
  }
  return { title: changes.title.trim() || current.title || "Lecture", topics };
}

function makesLoop(topic: MindmapTopic, byId: Map<string, MindmapTopic>): boolean {
  const seen = new Set([topic.id]);
  for (let p = topic.parentId; p; p = byId.get(p)?.parentId) {
    if (seen.has(p)) return true;
    seen.add(p);
  }
  return false;
}

function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.round(Math.min(1, Math.max(0, x)) * 100) / 100 : 0.5;
}

/** The same tree as a nested outline: branches become deeper headings. */
function toMarkdown(map: MindMap): string {
  const lines = [`# ${map.title}`];
  const add = (parentId: string | undefined, depth: number) => {
    for (const t of map.topics.filter((x) => x.parentId === parentId)) {
      lines.push(`${"#".repeat(Math.min(depth, 6))} ${t.label}`, ...t.details.map((d) => `- ${d}`));
      add(t.id, depth + 1);
    }
  };
  add(undefined, 2);
  return lines.join("\n");
}
