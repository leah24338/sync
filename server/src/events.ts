// The shared contract between the server and the student app (same shape as LOVABLE_PROMPT.md).
/**
 * One line of the board. `content`: LaTeX for equations; for text, words with any maths inside
 * `$…$`. `plain`: readable Unicode (x² + 1). `spoken`: words, for screen readers and read-aloud.
 */
export type BoardBlock = { id: string; kind: "text" | "equation"; content: string; plain: string; spoken: string };

export type CaptionEvent = { type: "caption"; id: string; t: number; text: string; final: boolean };
export type AnnotationEvent = {
  type: "annotation";
  captionId: string;
  kind: "idiom" | "term";
  phrase: string;
  meaning: string;
  /** How likely it is to confuse a student: 1 = most know it, 3 = likely to confuse. */
  level: 1 | 2 | 3;
};
export type BoardEvent = { type: "board"; id: string; t: number; snapshotUrl: string; blocks: BoardBlock[] };
export type MindmapTopic = {
  id: string;
  label: string;
  /** How closely the topic relates to the lecture's main subject: 1 = core … 0 = unrelated. */
  relatedness: number;
  details: string[];
  /** Other topics this one connects to, with strength 0–1. */
  links: { to: string; strength: number }[];
};
/** `markdown` is the same map as an outline (for simple tree views); `title` + `topics` carry relatedness. */
export type MindmapEvent = { type: "mindmap"; t: number; markdown: string; title?: string; topics?: MindmapTopic[] };

/** Which mind map topic the teacher is talking about right now (an id from the latest mind map). */
export type FocusEvent = { type: "focus"; t: number; topicId: string };

/** Words a student highlighted as confusing, from a caption ("feed") or a board line ("board"). */
export type LostHighlight = { source: "feed" | "board"; sourceId: string; text: string };

/**
 * A student pressed "I'm lost" (anonymous). `t`: the lecture moment they were lost at;
 * `at`: when they pressed it; `topicId`: mind map topic (if known); `captionId`: what was being
 * said at `t` (if known); `highlights`: the exact words they marked, checked against the source.
 */
export type LostEvent = {
  type: "lost";
  t: number;
  at: number;
  topicId?: string;
  captionId?: string;
  highlights?: LostHighlight[];
};

export type LectureEvent = CaptionEvent | AnnotationEvent | BoardEvent | MindmapEvent | FocusEvent | LostEvent;

type Listener = (event: LectureEvent) => void;

/**
 * Append-only log of everything that happened in the lecture, and the single source of truth
 * for every student. New students get the whole log, then live updates.
 *
 * Two exceptions to append-only keep the catch-up small: a partial caption is replaced in place
 * when its next version (or the final one) arrives, and there's only ever one focus event (the
 * latest), since a phone joining late only needs to know where the lecture is now.
 */
export class EventLog {
  private events: LectureEvent[] = [];
  private captionSlots = new Map<string, number>();
  private focusSlot: number | null = null;
  private listeners = new Set<Listener>();
  private startedAt = Date.now();
  private idCounter = 0;

  /** Milliseconds since the lecture started. */
  now(): number {
    return Date.now() - this.startedAt;
  }

  nextId(prefix: string): string {
    return `${prefix}${++this.idCounter}`;
  }

  push(event: LectureEvent): void {
    if (event.type === "caption") {
      const slot = this.captionSlots.get(event.id);
      if (slot === undefined) {
        this.captionSlots.set(event.id, this.events.length);
        this.events.push(event);
      } else {
        this.events[slot] = event;
      }
    } else if (event.type === "focus") {
      if (this.focusSlot === null) {
        this.focusSlot = this.events.length;
        this.events.push(event);
      } else {
        this.events[this.focusSlot] = event;
      }
    } else {
      this.events.push(event);
    }
    for (const listener of this.listeners) listener(event);
  }

  all(): readonly LectureEvent[] {
    return this.events;
  }

  /** Events worth saving for a replay: everything except captions still in progress. */
  finished(): LectureEvent[] {
    return this.events.filter((e) => e.type !== "caption" || e.final);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  reset(): void {
    this.events = [];
    this.captionSlots.clear();
    this.focusSlot = null;
    this.startedAt = Date.now();
    this.idCounter = 0;
  }
}
