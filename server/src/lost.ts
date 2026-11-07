import * as z from "zod/v4";
import type { EventLog, LectureEvent } from "./events.js";

const LostRequest = z.object({
  clientId: z.string().min(1).max(64),
  t: z.number().optional(),
  topicId: z.string().max(32).optional(),
});

const MIN_GAP_MS = 5_000; // one flag per phone every 5 s
const REPEAT_WINDOW_MS = 2 * 60_000; // the same phone flagging the same topic again within 2 min is ignored
const COUNT_WINDOW_MS = 10 * 60_000; // "N students lost here" counts the last 10 minutes

export type LostResult =
  | { ok: true; duplicate: boolean; topicId?: string; students: number }
  | { ok: false; status: number; error: string };

/**
 * Anonymous "I'm lost" flags. Phones send a random id only so one student can't inflate the
 * count; nothing identifying is stored or broadcast. Flags missing a topic get the topic the
 * teacher was on at that moment (from the focus history).
 */
export class LostTracker {
  private focusHistory: { t: number; topicId: string }[] = [];
  private lastFlagAt = new Map<string, number>();
  private flagged = new Map<string, { at: number; topicKey: string }[]>();
  private recent: { at: number; topicKey: string; clientId: string }[] = [];

  constructor(private log: EventLog) {}

  /** Called for every event so the tracker knows where the lecture was at any moment. */
  observe(event: LectureEvent): void {
    if (event.type === "focus") this.focusHistory.push({ t: event.t, topicId: event.topicId });
  }

  flag(body: unknown): LostResult {
    const parsed = LostRequest.safeParse(body);
    if (!parsed.success) return { ok: false, status: 400, error: "send { clientId, t?, topicId? }" };
    const { clientId } = parsed.data;
    const now = this.log.now();

    const last = this.lastFlagAt.get(clientId) ?? -Infinity;
    if (now - last < MIN_GAP_MS) return { ok: false, status: 429, error: "Please wait a few seconds before flagging again." };
    this.lastFlagAt.set(clientId, now);

    const t = Math.min(Math.max(0, parsed.data.t ?? now), now);
    const topicId = parsed.data.topicId || this.topicAt(t);
    const captionId = this.captionAt(t);
    const topicKey = topicId ?? `moment-${Math.floor(t / 30_000)}`; // no topic: group by 30 s moment

    const mine = (this.flagged.get(clientId) ?? []).filter((f) => now - f.at < REPEAT_WINDOW_MS);
    const duplicate = mine.some((f) => f.topicKey === topicKey);
    if (!duplicate) {
      mine.push({ at: now, topicKey });
      this.recent.push({ at: now, topicKey, clientId });
      this.log.push({ type: "lost", t, at: now, ...(topicId && { topicId }), ...(captionId && { captionId }) });
      console.log(`[lost] a student is lost${topicId ? ` on ${topicId}` : ""} at ${Math.round(t / 1000)} s`);
    }
    this.flagged.set(clientId, mine);

    this.recent = this.recent.filter((f) => now - f.at < COUNT_WINDOW_MS);
    const students = new Set(this.recent.filter((f) => f.topicKey === topicKey).map((f) => f.clientId)).size;
    return { ok: true, duplicate, topicId, students };
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
