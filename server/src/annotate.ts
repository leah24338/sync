import * as z from "zod/v4";
import { askJson } from "./claude.js";
import type { CaptionEvent, EventLog } from "./events.js";

const Notes = z.object({
  annotations: z.array(
    z.object({
      kind: z.enum(["idiom", "term"]),
      phrase: z.string(),
      meaning: z.string(),
    }),
  ),
});

const SYSTEM = `You help students follow a live lecture. Some are new to English, some read language literally.

For the NEW SENTENCE only, find:
- "idiom": idioms, figurative language, slang, or sarcasm/irony that a literal reader or an English learner could misread. "meaning": what the speaker actually means here, in plain words. For sarcasm, say it is sarcastic and what they really mean.
- "term": subject-specific technical words a student may not know yet. "meaning": a short plain-English definition.

Rules:
- "phrase" must be copied exactly, word for word, from the NEW SENTENCE.
- Each meaning is at most 20 words.
- Skip anything obvious, and skip phrases listed as already explained.
- Most sentences need nothing: return an empty list. Never more than 3 annotations.`;

/** Explains idioms, sarcasm and key terms in each finished caption. */
export class Annotator {
  private recent: string[] = [];
  private explained = new Set<string>();

  constructor(private log: EventLog) {}

  add(caption: CaptionEvent): void {
    const context = this.recent.slice(-3);
    this.recent.push(caption.text);
    // Fire and forget: the caption is already on screen, the note attaches when it's ready.
    void this.annotate(caption, context);
  }

  private async annotate(caption: CaptionEvent, context: string[]): Promise<void> {
    if (caption.text.split(/\s+/).length < 2) return;
    const result = await askJson({
      label: `annotate ${caption.id}`,
      schema: Notes,
      effort: "low",
      system: SYSTEM,
      content: [
        `Earlier in the lecture:\n${context.join("\n") || "(start of lecture)"}`,
        `Already explained: ${[...this.explained].join(", ") || "(nothing yet)"}`,
        `NEW SENTENCE:\n${caption.text}`,
      ].join("\n\n"),
    });
    if (!result) return;

    for (const note of result.annotations.slice(0, 3)) {
      // Only keep phrases that really appear in the caption, using the caption's own spelling,
      // so the student app can always find and underline them.
      const start = caption.text.toLowerCase().indexOf(note.phrase.trim().toLowerCase());
      if (start === -1) continue;
      const phrase = caption.text.slice(start, start + note.phrase.trim().length);
      const key = phrase.toLowerCase();
      if (this.explained.has(key)) continue;
      this.explained.add(key);
      this.log.push({ type: "annotation", captionId: caption.id, kind: note.kind, phrase, meaning: note.meaning });
    }
  }
}
