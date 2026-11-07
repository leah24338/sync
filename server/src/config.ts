import path from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = fileURLToPath(new URL("..", import.meta.url));
const repoDir = path.join(serverDir, "..");

// API keys live in wie_hack/.env (never committed). Node 22 can read it without dotenv.
try {
  process.loadEnvFile(path.join(repoDir, ".env"));
} catch {
  // No .env yet: mock replay still works, the AI and speech pipelines stay off.
}

export const config = {
  port: Number(process.env.PORT ?? 3001),
  anthropicKey: process.env.ANTHROPIC_API_KEY || undefined,
  deepgramKey: process.env.DEEPGRAM_API_KEY || undefined,
  deepgramModel: process.env.DEEPGRAM_MODEL ?? "nova-3",
  claudeModel: process.env.CLAUDE_MODEL ?? "claude-opus-5-5",
  mindmapIntervalMs: Number(process.env.MINDMAP_INTERVAL_MS ?? 45_000),
  // How often to check which mind map topic the teacher is on (only when there's new speech).
  focusIntervalMs: Number(process.env.FOCUS_INTERVAL_MS ?? 10_000),
  // Optional: when set, teacher controls (mic, board, reset, replay) require ?key=<value>.
  teacherKey: process.env.TEACHER_KEY || undefined,
  publicDir: path.join(serverDir, "public"),
  mockFile: path.join(serverDir, "mock", "lecture.json"),
  sessionsDir: path.join(serverDir, "sessions"),
};
