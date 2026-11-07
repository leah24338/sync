import * as z from "zod/v4";
import { askJson } from "./claude.js";
import type { BoardBlock, EventLog } from "./events.js";
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

const SYSTEM = `You read photos of a classroom whiteboard and keep a clean digital copy of what is written on it.

You get the CURRENT COPY (JSON) and a NEW PHOTO. Return the full updated board:
- Keep the id and content of blocks that are still on the board and unchanged.
- Update blocks the teacher added to or corrected. Give new blocks new ids (b1, b2, ...) that are not already used.
- Remove blocks that have been erased.
- Order blocks top to bottom, left to right, as on the board.
- kind "equation": maths, written as LaTeX with no $ delimiters. kind "text": everything else, spelling fixed.
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
        { type: "text", text: `CURRENT COPY:\n${JSON.stringify(this.blocks)}` },
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpeg.toString("base64") } },
        { type: "text", text: "NEW PHOTO is above. Return the updated board." },
      ],
    });
    if (!result || !result.changed) return;

    const seen = new Set<string>();
    const blocks = result.blocks
      .filter((b) => b.content.trim())
      .map((b) => {
        const id = seen.has(b.id) ? `${b.id}-${seen.size}` : b.id;
        seen.add(id);
        return { ...b, id };
      });
    if (JSON.stringify(blocks) === JSON.stringify(this.blocks)) return;

    const oldContent = new Set(this.blocks.map((b) => b.content));
    const added = blocks.filter((b) => !oldContent.has(b.content)).map((b) => b.content);
    this.blocks = blocks;

    const id = this.log.nextId("board-");
    this.snapshots.set(id, jpeg);
    this.log.push({ type: "board", id, t: this.log.now(), snapshotUrl: `/api/snapshots/${id}`, blocks });
    if (added.length) this.mindMapper.addBoard(added.join("; "));
  }
}
