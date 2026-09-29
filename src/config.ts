import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export const configSchema = z.strictObject({
  clientName: z.string().optional(),
  consultancyName: z.string().optional(),
  ownership: z
    .record(z.string(), z.enum(["client", "consultancy", "unknown"]))
    .optional(),
  ignoreEnvVars: z.array(z.string()).optional(),
  ignorePaths: z.array(z.string()).optional(),
  modelOverrides: z
    .record(
      z.string(),
      z.strictObject({ provider: z.string(), modelId: z.string() }),
    )
    .optional(),
});

export type HandoffConfig = z.infer<typeof configSchema>;

export async function loadConfig(repoPath: string): Promise<HandoffConfig> {
  const filename = join(repoPath, "handoff.config.json");
  let contents: string;
  try {
    contents = await readFile(filename, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  return configSchema.parse(JSON.parse(contents) as unknown);
}
