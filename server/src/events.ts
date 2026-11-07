// The shared contract between the server and the student app (same shape as LOVABLE_PROMPT.md).
export type BoardBlock = { id: string; kind: "text" | "equation"; content: string };

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
export type MindmapEvent = { type: "mindmap"; t: number; markdown: string };

export type LectureEvent = CaptionEvent | AnnotationEvent | BoardEvent | MindmapEvent;

type Listener = (event: LectureEvent) => void;

/**
 * Append-only log of everything that happened in the lecture, and the single source of truth
 * for every student. New students get the whole log, then live updates.
 *
 * Captions are the one exception to append-only: a partial caption is replaced in place when
 * its next version (or the final one) arrives, so ~1 update per second of speech doesn't
 * bloat the log or the catch-up a reconnecting phone has to download.
 */
export class EventLog {
  private events: LectureEvent[] = [];
  private captionSlots = new Map<string, number>();
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
    this.startedAt = Date.now();
    this.idCounter = 0;
  }
}
