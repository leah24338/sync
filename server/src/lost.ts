import { createHash, randomBytes } from "node:crypto";
import * as z from "zod/v4";
import type { EventLog, LectureEvent, LostHighlight } from "./events.js";

const LostRequest = z.object({
  clientId: z.string().min(1).max(64),
  t: z.number().optional(),
  topicId: z.string().max(32).optional(),
  highlights: z
    .array(z.object({ source: z.enum(["feed", "board"]), sourceId: z.string().max(64), text: z.string().max(300) }))
    .max(10)
    .optional(),
});

const BURST = 3; // a phone may send up to 3 flags…
const BURST_WINDOW_MS = 10_000; // …in any 10 seconds
const REPEAT_WINDOW_MS = 2 * 60_000; // the same phone flagging the same thing again within 2 min is ignored
// A student counts as "lost right now" for 5 minutes after pressing, or until the teacher marks
// that topic addressed. The teacher console uses the same window.
export const ACTIVE_MS = 5 * 60_000;
const MAX_HIGHLIGHTS = 5;
const MOMENT_MS = 30_000;

export type LostResult =
  | { ok: true; duplicate: boolean; t: number; topicId?: string; highlights: LostHighlight[]; students: number }
  | { ok: false; status: number; error: string };

const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Anonymous "I'm lost" flags. Phones send a random id only so one student can't inflate the
 * count; nothing identifying is stored or broadcast. Highlighted words are only accepted if they
 * really appear in the caption or board line they claim to come from, so the teacher's screen
 * can't be used for free-text messages. Flags missing a topic get the topic the teacher was on at
 * that moment (from the focus history). Each flag carries a `student` token (a salted hash of the
 * phone's id, new salt every lecture) so screens can count students, not presses.
 */
export class LostTracker {
  private focusHistory: { t: number; topicId: string }[] = [];
  private flagTimes = new Map<string, number[]>();
  private flagged = new Map<string, { at: number; key: string }[]>();
  private recent: { at: number; topicKey: string; clientId: string }[] = [];
  private addressedAt = new Map<string, number>(); // topic key ("*" = everything) → when
  private salt = randomBytes(16);

  constructor(private log: EventLog) {}

  /** Called for every event so the tracker knows where the lecture was at any moment. */
  observe(event: LectureEvent): void {
    if (event.type === "focus") this.focusHistory.push({ t: event.t, topicId: event.topicId });
    if (event.type === "addressed") this.addressedAt.set(addressedKey(event), event.t);
  }

  flag(body: unknown): LostResult {
    const parsed = LostRequest.safeParse(body);
    if (!parsed.success) return { ok: false, status: 400, error: "send { clientId, t?, topicId?, highlights? }" };
    const { clientId } = parsed.data;
    const now = this.log.now();

    const times = (this.flagTimes.get(clientId) ?? []).filter((at) => now - at < BURST_WINDOW_MS);
    if (times.length >= BURST) return { ok: false, status: 429, error: "Please wait a few seconds before flagging again." };
    this.flagTimes.set(clientId, [...times, now]);

    const checked = (parsed.data.highlights ?? []).map((h) => this.verify(h)).filter((h) => h !== null).slice(0, MAX_HIGHLIGHTS);
    const highlights = checked.map(({ highlight }) => highlight);

    // The moment: what the student sent, else the earliest highlighted line, else now.
    const earliest = checked.length ? Math.min(...checked.map((h) => h.t)) : undefined;
    const t = Math.min(Math.max(0, parsed.data.t ?? earliest ?? now), now);
    const topicId = parsed.data.topicId || this.topicAt(t);
    const captionId = highlights.find((h) => h.source === "feed")?.sourceId ?? this.captionAt(t);
    const topicKey = topicId ?? `moment-${Math.floor(t / MOMENT_MS)}`; // no topic: group by 30 s moment
    const key = `${topicKey}|${highlights.map((h) => normalize(h.text)).sort().join("|")}`;

    const mine = (this.flagged.get(clientId) ?? []).filter((f) => now - f.at < REPEAT_WINDOW_MS);
    const duplicate = mine.some((f) => f.key === key);
    if (!duplicate) {
      mine.push({ at: now, key });
      this.recent.push({ at: now, topicKey, clientId });
      this.log.push({
        type: "lost",
        t,
        at: now,
        ...(topicId && { topicId }),
        ...(captionId && { captionId }),
        ...(highlights.length && { highlights }),
        student: createHash("sha256").update(this.salt).update(clientId).digest("hex").slice(0, 10),
      });
      const words = highlights.length ? ` ("${highlights.map((h) => h.text).join('", "')}")` : "";
      console.log(`[lost] a student is lost${topicId ? ` on ${topicId}` : ""} at ${Math.round(t / 1000)} s${words}`);
    }
    this.flagged.set(clientId, mine);

    this.recent = this.recent.filter((f) => now - f.at < ACTIVE_MS);
    const since = Math.max(this.addressedAt.get(topicKey) ?? -1, this.addressedAt.get("*") ?? -1);
    const students = new Set(this.recent.filter((f) => f.topicKey === topicKey && f.at > since).map((f) => f.clientId)).size;
    return { ok: true, duplicate, t, topicId, highlights, students };
  }

  /** Keeps a highlight only if its words appear in the caption or board line it names. */
  private verify(h: { source: "feed" | "board"; sourceId: string; text: string }): { highlight: LostHighlight; t: number } | null {
    const words = normalize(h.text);
    if (!words) return null;
    for (const e of this.log.all()) {
      if (h.source === "feed" && e.type === "caption" && e.id === h.sourceId && normalize(e.text).includes(words)) {
        return { highlight: { source: "feed", sourceId: h.sourceId, text: h.text.trim() }, t: e.t };
      }
      if (h.source === "board" && e.type === "board") {
        const block = e.blocks.find((b) => b.id === h.sourceId);
        if (block && (normalize(block.plain).includes(words) || normalize(block.content).includes(words))) {
          return { highlight: { source: "board", sourceId: h.sourceId, text: h.text.trim() }, t: e.t };
        }
      }
    }
    return null;
  }

  private topicAt(t: number): string | undefined {
    let topic: string | undefined;
    for (const f of this.focusHistory) if (f.t <= t) topic = f.topicId;
    return topic;
  }

  private captionAt(t: number): string | undefined {
    let id: string | undefined;
    for (const e of this.log.all()) if (e.type === "caption" && e.final && e.t <= t) id = e.id;
    return id;
  }
}

/** The key an addressed event clears: a topic, a 30-second moment, or "*" for everything. */
export function addressedKey(event: { topicId?: string; moment?: number }): string {
  if (event.topicId) return event.topicId;
  return event.moment !== undefined ? `moment-${event.moment}` : "*";
}
