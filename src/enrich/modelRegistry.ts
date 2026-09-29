import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { ModelRecord } from "../types.js";

export const REMOTE_REGISTRY_URL =
  "https://raw.githubusercontent.com/techdevsynergy/llm-deprecation-data/main/llm_deprecation_data.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const remoteEntrySchema = z.object({
  provider: z.string().min(1),
  model_id: z.string().min(1),
  status: z.enum(["active", "legacy", "deprecated", "retired"]),
  deprecated_date: z.iso.date().nullable(),
  sunset_date: z.iso.date().nullable(),
  replacement: z.string().nullable(),
});
const remoteRegistrySchema = z.array(remoteEntrySchema).min(1);
type RemoteRegistry = z.infer<typeof remoteRegistrySchema>;

export interface RegistryLoadOptions {
  offline: boolean;
  models?: Pick<ModelRecord, "provider" | "modelId">[];
  cachePath?: string;
  now?: Date;
  fetchImpl?: typeof fetch;
}

export interface RegistryLoadResult {
  registry: ModelRegistry;
  limits: string[];
  source: "remote" | "cache" | "bundled";
}

export const modelEntrySchema = z.strictObject({
  provider: z.string().min(1),
  modelId: z.string().min(1),
  aliases: z.array(z.string().min(1)),
  status: z.enum(["active", "legacy", "deprecated", "retired"]),
  deprecationDate: z.iso.date().nullable(),
  retirementDate: z.iso.date().nullable(),
  replacement: z.string().nullable(),
  inputUsdPerMTok: z.number().nonnegative().nullable(),
  outputUsdPerMTok: z.number().nonnegative().nullable(),
  source: z.url(),
  coversSnapshots: z.boolean().optional(),
});

export const modelRegistrySchema = z.strictObject({
  verifiedAt: z.iso.date(),
  models: z.array(modelEntrySchema),
});

export type ModelEntry = z.infer<typeof modelEntrySchema>;
export type ModelRegistry = z.infer<typeof modelRegistrySchema>;

function normalize(value: string): string {
  return value.toLowerCase().replace(/^models\//, "");
}

export async function loadBundledRegistry(): Promise<ModelRegistry> {
  const file = new URL("../../data/models.json", import.meta.url);
  const parsed = modelRegistrySchema.parse(
    JSON.parse(await readFile(file, "utf8")) as unknown,
  );
  const seen = new Set<string>();
  for (const entry of parsed.models) {
    for (const id of [entry.modelId, ...entry.aliases]) {
      const key = `${normalize(entry.provider)}/${normalize(id)}`;
      if (seen.has(key)) throw new Error(`Duplicate model registry ID: ${key}`);
      seen.add(key);
    }
  }
  return parsed;
}

export function mergeRemoteRegistry(
  bundled: ModelRegistry,
  remote: RemoteRegistry,
  scannedModels: Pick<ModelRecord, "provider" | "modelId">[] = [],
): { registry: ModelRegistry; limits: string[] } {
  const models = bundled.models.map((entry) => ({ ...entry }));
  const positions = new Map(
    models.map((entry, index) => [
      `${normalize(entry.provider)}/${normalize(entry.modelId)}`,
      index,
    ]),
  );
  const limits: string[] = [];
  const relevantKeys = new Set(
    scannedModels.flatMap((model) => {
      if (!model.modelId) return [];
      const matched = findModel(bundled, model.provider, model.modelId);
      return [
        `${normalize(matched?.provider ?? model.provider)}/${normalize(matched?.modelId ?? model.modelId)}`,
      ];
    }),
  );
  for (const item of remote) {
    const key = `${normalize(item.provider)}/${normalize(item.model_id)}`;
    const index = positions.get(key);
    const current = index === undefined ? undefined : models[index];
    if (
      current?.retirementDate &&
      item.sunset_date &&
      current.retirementDate !== item.sunset_date &&
      relevantKeys.has(key)
    )
      limits.push(
        `Registry retirement date differs for ${item.provider}/${item.model_id}: remote ${item.sunset_date}, bundled ${current.retirementDate}; check the provider source.`,
      );
    const entry: ModelEntry = {
      provider: item.provider,
      modelId: item.model_id,
      aliases: current?.aliases ?? [],
      status: item.status,
      deprecationDate: item.deprecated_date,
      retirementDate: item.sunset_date ?? current?.retirementDate ?? null,
      replacement: item.replacement,
      inputUsdPerMTok: current?.inputUsdPerMTok ?? null,
      outputUsdPerMTok: current?.outputUsdPerMTok ?? null,
      source: REMOTE_REGISTRY_URL,
      ...(current?.coversSnapshots ? { coversSnapshots: true } : {}),
    };
    if (index === undefined) {
      positions.set(key, models.length);
      models.push(entry);
    } else models[index] = entry;
  }
  return {
    registry: { verifiedAt: bundled.verifiedAt, models },
    limits: [...new Set(limits)].sort(),
  };
}

export async function loadModelRegistry(
  options: RegistryLoadOptions,
): Promise<RegistryLoadResult> {
  const bundled = await loadBundledRegistry();
  if (options.offline)
    return {
      registry: bundled,
      limits: [
        "Remote model registry skipped in offline mode; bundled data used.",
      ],
      source: "bundled",
    };
  const cachePath =
    options.cachePath ?? join(homedir(), ".cache/handoff-pack/registry.json");
  const now = options.now ?? new Date();
  try {
    const cacheStat = await stat(cachePath);
    if (now.getTime() - cacheStat.mtimeMs < CACHE_TTL_MS) {
      const remote = remoteRegistrySchema.parse(
        JSON.parse(await readFile(cachePath, "utf8")) as unknown,
      );
      const merged = mergeRemoteRegistry(bundled, remote, options.models);
      return { ...merged, source: "cache" };
    }
  } catch {
    // An absent or invalid cache is refreshed below.
  }
  try {
    const response = await (options.fetchImpl ?? fetch)(REMOTE_REGISTRY_URL, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const remote = remoteRegistrySchema.parse(await response.json());
    const merged = mergeRemoteRegistry(bundled, remote, options.models);
    try {
      await mkdir(dirname(cachePath), { recursive: true });
      await writeFile(cachePath, `${JSON.stringify(remote)}\n`);
    } catch {
      merged.limits.push("Remote model registry cache could not be written.");
    }
    return { ...merged, source: "remote" };
  } catch {
    return {
      registry: bundled,
      limits: ["Remote model registry fetch failed; bundled data used."],
      source: "bundled",
    };
  }
}

export function findModel(
  registry: ModelRegistry,
  provider: string,
  modelId: string,
): ModelEntry | null {
  const normalizedProvider = normalize(provider);
  const normalizedId = normalize(modelId);
  const candidates = registry.models.filter(
    (entry) => normalize(entry.provider) === normalizedProvider,
  );
  const exact = candidates.find(
    (entry) => normalize(entry.modelId) === normalizedId,
  );
  if (exact) return exact;
  const alias = candidates.find((entry) =>
    entry.aliases.some((id) => normalize(id) === normalizedId),
  );
  if (alias) return alias;
  return (
    candidates.find((entry) => {
      if (!entry.coversSnapshots) return false;
      const prefix = `${normalize(entry.modelId)}-`;
      return (
        normalizedId.startsWith(prefix) &&
        /^\d{4}-\d{2}-\d{2}$/.test(normalizedId.slice(prefix.length))
      );
    }) ?? null
  );
}
