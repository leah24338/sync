import * as z from "zod/v4";

const Level = z.enum(["off", "tricky", "standard", "all"]);
export type NoteLevel = z.infer<typeof Level>;

const SettingsSchema = z.object({ idioms: Level, terms: Level });
export type Settings = z.infer<typeof SettingsSchema>;

/**
 * Teacher-wide settings: what the AI looks for, for everyone. Kept across lecture resets.
 * Each student can still hide more in their own app (annotations carry a `level`).
 */
export const settings: Settings = { idioms: "standard", terms: "standard" };

/** Lowest confusion level (1 = most students know it … 3 = likely to confuse) shown at each setting. */
export const MIN_LEVEL = { tricky: 3, standard: 2, all: 1 } as const;

export function updateSettings(input: unknown): Settings | null {
  const parsed = SettingsSchema.partial().safeParse(input);
  if (!parsed.success) return null;
  Object.assign(settings, parsed.data);
  return settings;
}
