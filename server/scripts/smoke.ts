// Checks the Claude pipelines with real API calls (costs a few cents).
// Usage: npm run smoke            (idiom notes + mind map)
//        npm run smoke -- board.jpg (also reads a whiteboard photo)
import { readFile } from "node:fs/promises";
import { Annotator } from "../src/annotate.js";
import { BoardReader } from "../src/board.js";
import { claudeEnabled } from "../src/claude.js";
import { EventLog, type LectureEvent } from "../src/events.js";
import { MindMapper } from "../src/mindmap.js";

if (!claudeEnabled) {
  console.error("Add ANTHROPIC_API_KEY to wie_hack/.env first.");
  process.exit(1);
}

const log = new EventLog();
const seen: LectureEvent[] = [];
log.subscribe((event) => {
  seen.push(event);
  console.log(JSON.stringify(event, null, 1));
});

const sentences = [
  "Okay everyone, today we're tackling quadratic equations.",
  "Don't worry, once you see the pattern this is a piece of cake.",
  "The part under the square root is called the discriminant.",
  "Oh great, another negative discriminant.",
];

const annotator = new Annotator(log);
const mindMapper = new MindMapper(log); // MINDMAP_INTERVAL_MS=2000 is set by the npm script
sentences.forEach((text, i) => {
  annotator.add({ type: "caption", id: `c${i + 1}`, t: i * 4000, text, final: true });
  mindMapper.addSpeech(text);
});

const photo = process.argv[2];
if (photo) {
  new BoardReader(log, new Map(), mindMapper).submit(await readFile(photo));
}

const deadline = Date.now() + 90_000;
const done = () => seen.some((e) => e.type === "mindmap") && (!photo || seen.some((e) => e.type === "board"));
while (!done() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
await new Promise((r) => setTimeout(r, 3000)); // let late idiom notes land

mindMapper.stop();
const count = (type: string) => seen.filter((e) => e.type === type).length;
console.log(`\nDone: ${count("annotation")} notes, ${count("mindmap")} mind map, ${count("board")} board reads.`);
process.exit(0);
