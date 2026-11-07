// Checks the Claude pipelines with real API calls (costs a few cents).
// Usage: npm run smoke            (idiom notes + two mind map updates)
//        npm run smoke -- board.jpg (also reads a whiteboard photo)
import { readFile } from "node:fs/promises";
import { Annotator } from "../src/annotate.js";
import { BoardReader } from "../src/board.js";
import { claudeEnabled } from "../src/claude.js";
import { EventLog, type LectureEvent, type MindmapEvent } from "../src/events.js";
import { MindMapper } from "../src/mindmap.js";

if (!claudeEnabled) {
  console.error("Add ANTHROPIC_API_KEY to wie_hack/.env first.");
  process.exit(1);
}

const log = new EventLog();
const seen: LectureEvent[] = [];
log.subscribe((event) => {
  seen.push(event);
  if (event.type === "focus") {
    const label = mindmaps().at(-1)?.topics?.find((t) => t.id === event.topicId)?.label;
    console.log(`  → focus: ${event.topicId} "${label}"`);
  } else if (event.type !== "mindmap" && event.type !== "annotation") {
    console.log(JSON.stringify(event));
  }
});

// Round 1 is the core lesson; round 2 adds a related aside, an application and an unrelated tangent.
const rounds = [
  [
    "Okay everyone, today we're tackling quadratic equations.",
    "Don't worry, once you see the pattern this is a piece of cake.",
    "The part under the square root is called the discriminant.",
    "Oh great, another negative discriminant.",
  ],
  [
    "Fun fact, Babylonian scribes were solving problems like this almost four thousand years ago on clay tablets.",
    "And the same curve describes how a basketball flies through the air after a jump shot.",
    "Totally unrelated, but I read last night that octopuses have three hearts and blue blood.",
  ],
];
// Round 3 says nothing new: it returns to an earlier topic, so only the focus should move.
const backToEarlierTopic = [
  "Okay, back to the discriminant.",
  "If b squared minus four a c is positive, the equation has two real solutions.",
];

const annotator = new Annotator(log);
const mindMapper = new MindMapper(log); // MINDMAP_INTERVAL_MS=2000 is set by the npm script
const photo = process.argv[2];
if (photo) new BoardReader(log, new Map(), mindMapper).submit(await readFile(photo));

const mindmaps = () => seen.filter((e): e is MindmapEvent => e.type === "mindmap");
let id = 0;
for (const [round, sentences] of rounds.entries()) {
  for (const text of sentences) {
    annotator.add({ type: "caption", id: `c${++id}`, t: id * 4000, text, final: true });
    mindMapper.addSpeech(text);
  }
  const deadline = Date.now() + 60_000;
  while (mindmaps().length <= round && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
  const map = mindmaps().at(-1);
  console.log(`\nMind map after round ${round + 1}: "${map?.title}"`);
  for (const t of map?.topics ?? []) {
    const links = t.links.map((l) => `${l.to}@${l.strength}`).join(", ");
    console.log(`  ${t.id}  relatedness ${t.relatedness.toFixed(2)}  ${t.label}  [${t.details.length} details]${links ? `  links: ${links}` : ""}`);
  }
}

console.log("\nRound 3: returning to an earlier topic");
const focusesBefore = seen.filter((e) => e.type === "focus").length;
for (const text of backToEarlierTopic) mindMapper.addSpeech(text);
const focusDeadline = Date.now() + 30_000;
while (seen.filter((e) => e.type === "focus").length === focusesBefore && Date.now() < focusDeadline) {
  await new Promise((r) => setTimeout(r, 500));
}

if (photo) {
  const deadline = Date.now() + 60_000;
  while (!seen.some((e) => e.type === "board") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
}
await new Promise((r) => setTimeout(r, 3000)); // let late idiom notes land

mindMapper.stop();
const count = (type: string) => seen.filter((e) => e.type === type).length;
console.log(`\nDone: ${count("annotation")} notes, ${count("mindmap")} mind map updates, ${count("focus")} focus changes, ${count("board")} board reads.`);
process.exit(0);
