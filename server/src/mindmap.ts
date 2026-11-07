import * as z from "zod/v4";
import { askJson } from "./claude.js";
import { config } from "./config.js";
import type { EventLog } from "./events.js";

const Outline = z.object({ markdown: z.string() });

const SYSTEM = `You maintain a mind map of a live lecture as a Markdown outline.

Format:
- Exactly one "# " line: the lecture topic.
- "## " lines for main topics.
- "- " bullets under a topic for details, optionally one more level ("  - ").
- Every label under 8 words. Write maths in plain text (x² + 1), not LaTeX.

Rules:
- Keep every existing node and its wording. You may only rename the "# " root once the topic becomes clear.
- Add new topics and details from the NEW TRANSCRIPT, each under the topic it belongs to.
- Ignore filler, jokes and classroom logistics.
- If there is nothing new worth adding, return the current outline unchanged.`;

const MIN_NEW_WORDS = 15;

/**
 * Grows the mind map every ~45 s. Each update sends only the current outline plus what was
 * said or written since the last update, so the prompt stays the same size however long the
 * lecture runs, and Claude edits the map instead of redrawing it.
 */
export class MindMapper {
  private outline = "";
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
      const result = await askJson({
        label: "mindmap",
        schema: Outline,
        effort: "low",
        system: SYSTEM,
        content: `CURRENT OUTLINE:\n${this.outline || "(empty: start a new one)"}\n\nNEW TRANSCRIPT:\n${newText}`,
      });
      if (!result) {
        this.pending.unshift(newText); // try again next tick
        return;
      }
      const markdown = result.markdown.trim();
      if (markdown && markdown !== this.outline) {
        this.outline = markdown;
        this.log.push({ type: "mindmap", t: this.log.now(), markdown });
      }
    } finally {
      this.busy = false;
    }
  }
}
