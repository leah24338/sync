import http from "node:http";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { Annotator } from "./annotate.js";
import { BoardReader } from "./board.js";
import { claudeEnabled } from "./claude.js";
import { config } from "./config.js";
import { EventLog, type CaptionEvent } from "./events.js";
import { MindMapper } from "./mindmap.js";
import { CatchUpWriter } from "./catchup.js";
import { LostTracker } from "./lost.js";
import { replayFile } from "./replay.js";
import { settings, updateSettings } from "./settings.js";
import { CaptionAssembler, DeepgramStream } from "./stt.js";

const log = new EventLog();
const snapshots = new Map<string, Buffer>();

/** The AI pipelines for one lecture. Rebuilt on reset so nothing leaks between lectures. */
function createPipelines() {
  const mindMapper = new MindMapper(log);
  const annotator = new Annotator(log);
  const board = new BoardReader(log, snapshots, mindMapper);
  return {
    board,
    onFinalCaption(caption: CaptionEvent) {
      annotator.add(caption);
      mindMapper.addSpeech(caption.text);
    },
    stop() {
      mindMapper.stop();
    },
  };
}

let pipelines = createPipelines();
let stopReplay: (() => void) | null = null;
let lost = new LostTracker(log);
let catchUps = new CatchUpWriter(log);
log.subscribe((event) => lost.observe(event));

// ---------- WebSockets: /ws for students (receive only), /ws/teacher for microphone audio ----------

const studentWss = new WebSocketServer({ noServer: true });
const teacherWss = new WebSocketServer({ noServer: true });
// The teacher console's own feed and its preview connect with ?role=preview so they aren't
// counted as students.
const previews = new WeakSet<WebSocket>();
const teacherSessions = new Set<{ ws: WebSocket; assembler: CaptionAssembler; close: () => void }>();

// Every event is serialized once and sent to every connected phone.
log.subscribe((event) => {
  const data = JSON.stringify(event);
  for (const ws of studentWss.clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
});

studentWss.on("connection", (ws) => {
  // Catch-up: a phone that joins late (or reconnects) first gets the whole lecture so far.
  for (const event of log.all()) ws.send(JSON.stringify(event));
});

teacherWss.on("connection", (ws) => {
  const send = (msg: object) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));
  const assembler = new CaptionAssembler(log, (caption) => pipelines.onFinalCaption(caption));
  let stream: DeepgramStream | null = null;
  let failed = false;

  if (!config.deepgramKey) {
    send({ type: "status", state: "error", message: "DEEPGRAM_API_KEY is not set in .env" });
  }

  // Protocol: the page sends {"type":"start"} right before each new recording, then binary
  // WebM chunks. Audio only ever goes to a stream opened by "start", so leftover chunks from an
  // old recording (which lack the WebM header) can never corrupt a new Deepgram stream.
  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      stream?.send(toBuffer(data));
      return;
    }
    let msg: { type?: string };
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.type !== "start" || !config.deepgramKey || failed) return;
    stream?.close();
    let opened = false;
    const current: DeepgramStream = new DeepgramStream(assembler, (status) => {
      send({ type: "status", ...status });
      if (status.state === "open") opened = true;
      if (status.state === "closed" && stream === current) {
        stream = null;
        // Dropped mid-lecture: ask the page for a fresh recording (new header).
        // If it never opened (e.g. a bad key), stop retrying until the page reconnects.
        if (opened) send({ type: "audio-restart" });
        else failed = true;
      }
    });
    stream = current;
  });

  const session = { ws, assembler, close: () => stream?.close() };
  teacherSessions.add(session);
  ws.on("close", () => {
    session.close();
    teacherSessions.delete(session);
  });
});

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  return Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
}

// Ping every 30 s: drops phones that vanished, and keeps the tunnel from closing quiet connections.
const alive = new WeakMap<WebSocket, boolean>();
for (const wss of [studentWss, teacherWss]) {
  wss.on("connection", (ws) => {
    alive.set(ws, true);
    ws.on("pong", () => alive.set(ws, true));
  });
}
setInterval(() => {
  for (const ws of [...studentWss.clients, ...teacherWss.clients]) {
    if (alive.get(ws) === false) {
      ws.terminate();
      continue;
    }
    alive.set(ws, false);
    ws.ping();
  }
}, 30_000);

function resetLecture(): void {
  stopReplay?.();
  stopReplay = null;
  for (const session of teacherSessions) {
    session.assembler.discard();
    session.close();
    session.ws.close(1012, "lecture reset"); // the teacher page reconnects with a fresh recorder
  }
  pipelines.stop();
  log.reset();
  snapshots.clear();
  pipelines = createPipelines();
  lost = new LostTracker(log);
  catchUps = new CatchUpWriter(log);
  // Phones reconnect automatically and download the (now empty) log.
  for (const ws of studentWss.clients) ws.close(1012, "lecture reset");
}

// ---------- HTTP ----------

const app = express();

function requireTeacher(req: Request, res: Response, next: NextFunction): void {
  const key = req.query.key ?? req.get("x-teacher-key");
  if (!config.teacherKey || key === config.teacherKey) return next();
  res.status(401).json({ error: "teacher key required" });
}

app.get("/", (_req, res) => res.redirect("/teach/"));
app.use("/teach", express.static(config.publicDir, { index: "teach.html" }));

app.get("/api/status", (_req, res) => {
  res.json({
    events: log.all().length,
    students: [...studentWss.clients].filter((ws) => !previews.has(ws)).length,
    teachers: teacherWss.clients.size,
    claude: claudeEnabled,
    deepgram: Boolean(config.deepgramKey),
  });
});

// Students press "I'm lost". Open to any site (Lovable's preview runs on its own domain);
// it's anonymous and rate-limited per phone.
app.use("/api/lost", (req, res, next) => {
  res.set({ "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "content-type" });
  if (req.method === "OPTIONS") return void res.sendStatus(204);
  next();
});
app.post("/api/lost", express.json(), async (req, res) => {
  // The flag reaches the teacher immediately; the student's reply then waits (~2-4 s) for a
  // catch-up, which is shared by everyone lost at the same moment on the same topic.
  const result = lost.flag(req.body);
  if (!result.ok) return void res.status(result.status).json({ error: result.error });
  const catchUp = await catchUps.get(result.t, result.topicId, result.highlights);
  res.json({ ...result, catchUp });
});

app.get("/api/settings", (_req, res) => res.json(settings));

app.post("/api/settings", requireTeacher, express.json(), (req, res) => {
  const updated = updateSettings(req.body);
  if (!updated) return void res.status(400).json({ error: 'idioms/terms must be "off", "tricky", "standard" or "all"' });
  console.log(`[settings] idioms: ${updated.idioms}, terms: ${updated.terms}`);
  res.json(updated);
});

app.get("/api/snapshots/:id", (req, res) => {
  const jpeg = snapshots.get(req.params.id);
  if (!jpeg) return void res.sendStatus(404);
  res.type("jpeg").set("Cache-Control", "public, max-age=31536000, immutable").send(jpeg);
});

app.post("/api/board", requireTeacher, express.raw({ type: "image/*", limit: "10mb" }), (req, res) => {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return void res.status(400).json({ error: "send the photo as an image/jpeg body" });
  }
  pipelines.board.submit(req.body);
  res.status(202).json({ queued: true, claude: claudeEnabled });
});

app.post("/api/reset", requireTeacher, (_req, res) => {
  resetLecture();
  res.json({ ok: true });
});

app.post("/api/save", requireTeacher, async (_req, res) => {
  await mkdir(config.sessionsDir, { recursive: true });
  const name = `session-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  await writeFile(path.join(config.sessionsDir, name), JSON.stringify(log.finished(), null, 1));
  res.json({ saved: name });
});

app.get("/api/sessions", requireTeacher, async (_req, res) => {
  const files = await readdir(config.sessionsDir).catch(() => [] as string[]);
  res.json({ sessions: files.filter((f) => f.endsWith(".json")).sort().reverse() });
});

app.post("/api/replay", requireTeacher, express.json(), async (req, res) => {
  const session = typeof req.body?.session === "string" ? path.basename(req.body.session) : null;
  const file = session ? path.join(config.sessionsDir, session) : config.mockFile;
  stopReplay?.();
  try {
    stopReplay = await replayFile(log, file, Number(req.body?.speed) || 1);
    res.json({ replaying: session ?? "mock lecture" });
  } catch {
    res.status(404).json({ error: `could not read ${session ?? "the mock lecture"}` });
  }
});

app.post("/api/replay/stop", requireTeacher, (_req, res) => {
  stopReplay?.();
  stopReplay = null;
  res.json({ ok: true });
});

const server = http.createServer(app);

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/ws") {
    studentWss.handleUpgrade(req, socket, head, (ws) => {
      if (url.searchParams.get("role") === "preview") previews.add(ws);
      studentWss.emit("connection", ws, req);
    });
  } else if (url.pathname === "/ws/teacher" && (!config.teacherKey || url.searchParams.get("key") === config.teacherKey)) {
    teacherWss.handleUpgrade(req, socket, head, (ws) => teacherWss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

server.listen(config.port, () => {
  console.log(`Lecture server on http://localhost:${config.port}`);
  console.log(`  Teacher console: http://localhost:${config.port}/teach/`);
  console.log(`  Test viewer:     http://localhost:${config.port}/teach/viewer.html`);
  console.log(`  Student feed:    ws://localhost:${config.port}/ws`);
  console.log(`  Claude: ${claudeEnabled ? "on" : "OFF (no key)"} · Deepgram: ${config.deepgramKey ? "on" : "OFF (no key)"}`);
});
