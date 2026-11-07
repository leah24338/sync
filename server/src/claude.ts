import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type * as z from "zod/v4";
import { config } from "./config.js";

const client = config.anthropicKey ? new Anthropic({ apiKey: config.anthropicKey }) : null;

export const claudeEnabled = client !== null;
if (!claudeEnabled) console.warn("[claude] ANTHROPIC_API_KEY not set: idiom notes, board reading and mind map are off");

// Cap how many Claude calls run at once so a burst of sentences can't trip rate limits.
// A finished call hands its slot straight to the next waiter.
const MAX_CONCURRENT = 4;
let active = 0;
const waiting: Array<() => void> = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active < MAX_CONCURRENT) active++;
  else await new Promise<void>((resolve) => waiting.push(resolve));
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}

// $ per million input / output tokens (prompts under 100K tokens), for the running cost tally.
const PRICES: Record<string, [number, number]> = {
  "claude-opus-5-5": [4, 20],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-5-5": [0.1, 0.5],
};

/** What the AI has cost since the server started, per kind of call. */
export const usage = {
  calls: 0,
  costUsd: 0,
  byTask: {} as Record<string, { calls: number; inputTokens: number; outputTokens: number; costUsd: number }>,
};

function record(label: string, model: string, inputTokens: number, outputTokens: number): number {
  const [inPrice, outPrice] = Object.entries(PRICES).find(([id]) => model.startsWith(id))?.[1] ?? [0, 0];
  const cost = (inputTokens * inPrice + outputTokens * outPrice) / 1e6;
  const kind = label.split(" ")[0]; // "annotate c12" → "annotate"
  const entry = (usage.byTask[kind] ??= { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
  entry.calls++;
  entry.inputTokens += inputTokens;
  entry.outputTokens += outputTokens;
  entry.costUsd += cost;
  usage.calls++;
  usage.costUsd += cost;
  return cost;
}

type Content = string | Anthropic.Beta.Messages.BetaContentBlockParam[];

/**
 * One Claude call whose reply is guaranteed to match `schema` (structured outputs), so the
 * pipelines never parse free text. Returns null instead of throwing: a failed annotation or
 * board read must never take the live captions down with it.
 */
export async function askJson<S extends z.ZodType>(opts: {
  label: string;
  schema: S;
  system: string;
  content: Content;
  effort: "low" | "medium";
  /** "board" uses the strong model; "text" the cheaper one (see config). */
  task: "board" | "text";
}): Promise<z.infer<S> | null> {
  if (!client) return null;
  const model = opts.task === "board" ? config.claudeModel : config.claudeTextModel;
  // Haiku has no server-side refusal fallback; the other current models do.
  const fallback = model.startsWith("claude-haiku")
    ? {}
    : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const };
  return withSlot(async () => {
    const started = Date.now();
    try {
      const response = await client.beta.messages.parse({
        model,
        max_tokens: 16000,
        // If a safety classifier ever declines, retry on Anthropic's recommended fallback model.
        ...fallback,
        system: opts.system,
        output_config: { effort: opts.effort, format: betaZodOutputFormat(opts.schema) },
        messages: [{ role: "user", content: opts.content }],
      });
      const { input_tokens, output_tokens } = response.usage;
      const cost = record(opts.label, response.model, input_tokens, output_tokens);
      console.log(
        `[claude] ${opts.label} (${response.model}): ${Date.now() - started} ms, ${input_tokens} in / ${output_tokens} out tokens, $${cost.toFixed(4)}`,
      );
      if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") {
        console.warn(`[claude] ${opts.label}: stopped with ${response.stop_reason}`);
        return null;
      }
      return response.parsed_output;
    } catch (error) {
      if (error instanceof Anthropic.RateLimitError) {
        console.warn(`[claude] ${opts.label}: rate limited, skipping`);
      } else if (error instanceof Anthropic.APIError) {
        console.error(`[claude] ${opts.label}: API error ${error.status}: ${error.message}`);
      } else {
        console.error(`[claude] ${opts.label}:`, error);
      }
      return null;
    }
  });
}
