import { readFile } from "node:fs/promises";
import type { EventLog, LectureEvent } from "./events.js";

let runCounter = 0;

/**
 * Plays a saved event list (the mock lecture or a recorded session) into the log with its
 * original timing. No speech or AI calls happen, so a replay is free and identical every time:
 * that makes it both the student app's test feed and the demo-day backup.
 * Returns a function that cancels the rest of the replay.
 */
export async function replayFile(log: EventLog, file: string, speed = 1): Promise<() => void> {
  const events = JSON.parse(await readFile(file, "utf8")) as LectureEvent[];
  // Prefix ids so a replay never collides with live captions or an earlier replay.
  const prefix = `r${++runCounter}-`;
  const startedAt = log.now();
  const firstT = events.find((e) => "t" in e)?.t ?? 0;
  const timers: NodeJS.Timeout[] = [];

  let lastT = firstT;
  for (const event of events) {
    // Annotations have no timestamp of their own; they play right after their caption.
    if ("t" in event) lastT = event.t;
    const offset = lastT - firstT;
    timers.push(
      setTimeout(() => log.push(retime(event, prefix, startedAt + offset)), offset / speed),
    );
  }
  return () => timers.forEach(clearTimeout);
}

function retime(event: LectureEvent, prefix: string, t: number): LectureEvent {
  switch (event.type) {
    case "caption":
      return { ...event, id: prefix + event.id, t };
    case "annotation":
      return { ...event, captionId: prefix + event.captionId };
    case "board":
      return { ...event, id: prefix + event.id, t };
    case "mindmap":
    case "focus":
      return { ...event, t };
  }
}
