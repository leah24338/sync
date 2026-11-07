import * as z from "zod/v4";
import { askJson } from "./claude.js";
import { config } from "./config.js";
import type { EventLog, MindmapTopic } from "./events.js";

const Changes = z.object({
  title: z.string(),
  topics: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      relatedness: z.number(),
      details: z.array(z.string()),
      links: z.array(z.object({ to: z.string(), strength: z.number() })),
    }),
  ),
});

const SYSTEM = `You maintain a mind map of a live lecture. The lecture's main subject ("title") is the centre of the map.

You get the CURRENT MAP (JSON) and the NEW TRANSCRIPT since the last update. Return only what changed:
- "title": the main subject. Repeat the current one; rename it only once the subject becomes clear.
- "topics": only topics that are new, or existing topics that gain new details or links. For an existing topic, repeat its id and label and list only the new details.

Each topic has:
- "id": keep existing ids; give new topics new ids (t1, t2, ...).
- "label": under 8 words.
- "details": short facts under 8 words each. Write maths in plain text (x² + 1), not LaTeX.
- "relatedness": how closely the topic relates to the main subject, 0 to 1. The app draws low-relatedness topics further from the centre.
    1.0 the main subject itself · 0.7–0.9 a direct part of it · 0.4–0.6 background, an application or a connected idea · 0.1–0.3 a tangent or a different subject
- "links": other topics it builds on or connects to ("to" is their id), with "strength" 0 to 1. Only link genuinely connected topics.

Rules:
- Put each new detail under the topic it belongs to; create a topic only for something new.
- If the teacher moves on to something unrelated, add it as its own topic with low relatedness instead of forcing it under an existing one.
- Ignore filler, jokes and classroom logistics.
- If nothing new is worth adding, return the current title and an empty topics list.`;

const MIN_NEW_WORDS = 15;

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

  constructor(private log: EventLog) {
    this.timer = setInterval(() => void this.update(), config.mindmapIntervalMs);
  }

  addSpeech(text: string): void {
    this.pending.push(text);
  }

  addBoard(text: string): void {
    this.pending.push(`[Written on the board] ${text}`);
  }

  stop(): void {
    clearInterval(this.timer);
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

  // Links may point at topics added later in the same reply, so filter once everything is in.
  for (const topic of topics) topic.links = topic.links.filter((l) => l.to !== topic.id && byId.has(l.to));
  return { title: changes.title.trim() || current.title || "Lecture", topics };
}

function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.round(Math.min(1, Math.max(0, x)) * 100) / 100 : 0.5;
}

function toMarkdown(map: MindMap): string {
  return [`# ${map.title}`, ...map.topics.flatMap((t) => [`## ${t.label}`, ...t.details.map((d) => `- ${d}`)])].join("\n");
}
