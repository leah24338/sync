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
}): Promise<z.infer<S> | null> {
  if (!client) return null;
  return withSlot(async () => {
    const started = Date.now();
    try {
      const response = await client.beta.messages.parse({
        model: config.claudeModel,
        max_tokens: 16000,
        // If a safety classifier ever declines, retry on Anthropic's recommended fallback model.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: opts.system,
        output_config: { effort: opts.effort, format: betaZodOutputFormat(opts.schema) },
        messages: [{ role: "user", content: opts.content }],
      });
      const { input_tokens, output_tokens } = response.usage;
      console.log(
        `[claude] ${opts.label}: ${Date.now() - started} ms, ${input_tokens} in / ${output_tokens} out tokens`,
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
