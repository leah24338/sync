import * as z from "zod/v4";
import { askJson } from "./claude.js";
import type { BoardBlock, EventLog } from "./events.js";
import { normalizeBlock } from "./mathText.js";
import type { MindMapper } from "./mindmap.js";

const BoardState = z.object({
  changed: z.boolean(),
  blocks: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(["text", "equation"]),
      content: z.string(),
    }),
  ),
});

const SYSTEM = `You read images of what a teacher is showing (a photo of a classroom whiteboard, or a screenshot of their shared screen: slides or a digital whiteboard) and keep a clean digital copy of the content.
For screenshots, copy only the lesson content: ignore window frames, toolbars, taskbars, slide numbers and the mouse cursor.

You get the CURRENT COPY (JSON) and a NEW PHOTO. Return the full updated board:
- Keep the id and content of blocks that are still on the board and unchanged.
- Update blocks the teacher added to or corrected. Give new blocks new ids (b1, b2, ...) that are not already used.
- Remove blocks that have been erased.
- Order blocks top to bottom, left to right, as on the board.
- kind "equation": a line that is only maths, written as LaTeX with no $ delimiters (x^2 + 6x + 5 = 0, \\frac{a}{b}).
- kind "text": words, spelling fixed. Wrap EVERY piece of maths inside a text line in $…$ as LaTeX, e.g. "Discriminant: $b^2 - 4ac$" or "if $\\Delta < 0$, no real roots". Never write ^, _ or backslash commands outside $…$.
- Ignore people, hands, glare and anything that is not writing on the board. If part of the board is blocked, keep the current copy of that part.
- Never guess at writing you cannot read: leave it out.
- "changed": false if nothing was added, corrected or erased compared with the current copy.`;

/** Turns whiteboard photos into clean text and LaTeX, one photo at a time. */
export class BoardReader {
  private blocks: BoardBlock[] = [];
  private pending: Buffer | null = null;
  private busy = false;

  constructor(
    private log: EventLog,
    private snapshots: Map<string, Buffer>,
    private mindMapper: MindMapper,
  ) {}

  /**
   * Latest photo wins: while one read is in flight, newer photos replace each other in a
   * single waiting slot. A burst of captures costs at most two Claude calls, and the board
   * is never read out of order.
   */
  submit(jpeg: Buffer): void {
    this.pending = jpeg;
    if (!this.busy) void this.drain();
  }

  private async drain(): Promise<void> {
    this.busy = true;
    while (this.pending) {
      const jpeg = this.pending;
      this.pending = null;
      await this.read(jpeg);
    }
    this.busy = false;
  }

  private async read(jpeg: Buffer): Promise<void> {
    const result = await askJson({
      label: "board",
      schema: BoardState,
      effort: "medium",
      system: SYSTEM,
      content: [
        { type: "text", text: `CURRENT COPY:\n${JSON.stringify(this.blocks.map(({ id, kind, content }) => ({ id, kind, content })))}` },
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpeg.toString("base64") } },
        { type: "text", text: "NEW PHOTO is above. Return the updated board." },
      ],
    });
    if (!result) return;
    if (!result.changed) {
      console.log("[board] nothing new in that image, no update sent");
      return;
    }

    const seen = new Set<string>();
    const blocks = result.blocks
      .filter((b) => b.content.trim())
      .map((b) => {
        const id = seen.has(b.id) ? `${b.id}-${seen.size}` : b.id;
        seen.add(id);
        // Validate the maths and add readable (plain) and spoken versions.
        return normalizeBlock({ ...b, id });
      });
    if (JSON.stringify(blocks) === JSON.stringify(this.blocks)) {
      console.log("[board] same content as before, no update sent");
      return;
    }

    const oldContent = new Set(this.blocks.map((b) => b.content));
    const added = blocks.filter((b) => !oldContent.has(b.content)).map((b) => b.plain);
    this.blocks = blocks;

    const id = this.log.nextId("board-");
    this.snapshots.set(id, jpeg);
    this.log.push({ type: "board", id, t: this.log.now(), snapshotUrl: `/api/snapshots/${id}`, blocks });
    console.log(`[board] update sent: ${blocks.length} blocks, ${added.length} new`);
    if (added.length) this.mindMapper.addBoard(added.join("; "));
  }
}
