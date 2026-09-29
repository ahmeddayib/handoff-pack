import { mkdtemp, readFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findModel,
  loadBundledRegistry,
  loadModelRegistry,
  modelRegistrySchema,
  REMOTE_REGISTRY_URL,
} from "../src/enrich/modelRegistry.js";
import { generate } from "../src/pipeline.js";

const created: string[] = [];
afterEach(async () => {
  await Promise.all(
    created.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("bundled model registry", () => {
  it("loads at least 30 sourced entries and resolves exact aliases", async () => {
    const registry = await loadBundledRegistry();
    expect(registry.models.length).toBeGreaterThanOrEqual(30);
    expect(
      registry.models.every((item) => item.source.startsWith("https://")),
    ).toBe(true);
    expect(findModel(registry, "anthropic", "claude-sonnet-4-5")?.modelId).toBe(
      "claude-sonnet-4-5-20250929",
    );
    expect(
      findModel(registry, "GOOGLE", "models/gemini-2.5-flash")?.modelId,
    ).toBe("gemini-2.5-flash");
    expect(findModel(registry, "openai", "gpt-4o-2024-08-06")?.modelId).toBe(
      "gpt-4o",
    );
    expect(findModel(registry, "openai", "gpt-4o-2099-01-01")).toBeNull();
    expect(findModel(registry, "openai", "gpt-4o")?.inputUsdPerMTok).toBe(2.5);
  });

  it("rejects malformed data before use", () => {
    expect(() =>
      modelRegistrySchema.parse({
        verifiedAt: "2026-09-24",
        models: [{ provider: "openai" }],
      }),
    ).toThrow();
  });
});

describe("remote model registry", () => {
  it("merges lifecycle data, keeps bundled prices, notes date conflicts, and caches for 24 hours", async () => {
    const root = await mkdtemp(join(tmpdir(), "handoff-registry-"));
    created.push(root);
    const cachePath = join(root, "registry.json");
    const fixture = JSON.parse(
      await readFile(resolve("test/fixtures/remote-registry.json"), "utf8"),
    ) as unknown;
    const fetchImpl = vi.fn(async () => Response.json(fixture));
    const now = new Date();
    const first = await loadModelRegistry({
      offline: false,
      cachePath,
      fetchImpl,
      now,
      models: [{ provider: "openai", modelId: "gpt-5-2025-08-07" }],
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      REMOTE_REGISTRY_URL,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(first.source).toBe("remote");
    expect(findModel(first.registry, "openai", "gpt-4o")).toMatchObject({
      status: "deprecated",
      retirementDate: "2026-12-01",
      replacement: "gpt-4.1",
      inputUsdPerMTok: 2.5,
      outputUsdPerMTok: 10,
      source: REMOTE_REGISTRY_URL,
    });
    expect(
      findModel(first.registry, "openai", "remote-only-model"),
    ).toMatchObject({
      inputUsdPerMTok: null,
      outputUsdPerMTok: null,
    });
    expect(first.limits).toContain(
      "Registry retirement date differs for openai/gpt-5-2025-08-07: remote 2026-12-01, bundled 2026-12-11; check the provider source.",
    );
    expect(first.limits.some((note) => note.includes("openai/gpt-4o"))).toBe(
      false,
    );
    const cached = await loadModelRegistry({
      offline: false,
      cachePath,
      fetchImpl,
      now: new Date(now.getTime() + 60_000),
      models: [{ provider: "openai", modelId: "gpt-5-2025-08-07" }],
    });
    expect(cached.source).toBe("cache");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(cached.registry).toEqual(first.registry);
    await utimes(
      cachePath,
      new Date(now.getTime() - 25 * 3600_000),
      new Date(now.getTime() - 25 * 3600_000),
    );
    const refreshed = await loadModelRegistry({
      offline: false,
      cachePath,
      fetchImpl,
      now,
      models: [{ provider: "openai", modelId: "gpt-5-2025-08-07" }],
    });
    expect(refreshed.source).toBe("remote");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("uses a bundled retirement date when the remote date is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "handoff-registry-null-date-"));
    created.push(root);
    const fixture = JSON.parse(
      await readFile(resolve("test/fixtures/remote-registry.json"), "utf8"),
    ) as { model_id: string; sunset_date: string | null }[];
    fixture.find((item) => item.model_id === "gpt-5-2025-08-07")!.sunset_date =
      null;
    const result = await loadModelRegistry({
      offline: false,
      cachePath: join(root, "registry.json"),
      fetchImpl: async () => Response.json(fixture),
      models: [{ provider: "openai", modelId: "gpt-5-2025-08-07" }],
    });
    expect(
      findModel(result.registry, "openai", "gpt-5-2025-08-07")?.retirementDate,
    ).toBe("2026-12-11");
    expect(
      result.limits.some((note) => note.includes("retirement date differs")),
    ).toBe(false);
  });

  it("uses bundled data offline and after a failed fetch without calling the network offline", async () => {
    const root = await mkdtemp(join(tmpdir(), "handoff-registry-fallback-"));
    created.push(root);
    const cachePath = join(root, "registry.json");
    const fetchImpl = vi.fn(async () => {
      throw new Error("unavailable");
    });
    const offline = await loadModelRegistry({
      offline: true,
      cachePath,
      fetchImpl,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(offline.source).toBe("bundled");
    expect(offline.limits).toContain(
      "Remote model registry skipped in offline mode; bundled data used.",
    );
    const failed = await loadModelRegistry({
      offline: false,
      cachePath,
      fetchImpl,
    });
    expect(failed.source).toBe("bundled");
    expect(failed.limits).toContain(
      "Remote model registry fetch failed; bundled data used.",
    );
    expect(findModel(failed.registry, "openai", "gpt-4o")?.status).toBe(
      "active",
    );
  });

  it("shows the remote retirement date and conflict note in a generated report", async () => {
    const root = await mkdtemp(join(tmpdir(), "handoff-registry-report-"));
    created.push(root);
    const fixture = JSON.parse(
      await readFile(resolve("test/fixtures/remote-registry.json"), "utf8"),
    ) as unknown;
    const report = await generate({
      repo: resolve("test/fixtures/chatbot-patterns"),
      out: root,
      offline: false,
      format: "both",
      now: new Date("2026-09-28T12:00:00Z"),
      registryCachePath: join(root, "registry.json"),
      registryFetch: async () => Response.json(fixture),
    });
    expect(report.limits).toContain(
      "Registry retirement date differs for openai/gpt-5-2025-08-07: remote 2026-12-01, bundled 2026-12-11; check the provider source.",
    );
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule: "V10",
          subject: "gpt-5-2025-08-07",
          title: "Model retires on 2026-12-01",
        }),
      ]),
    );
    const markdown = await readFile(join(root, "HANDOFF.md"), "utf8");
    expect(markdown).toContain("| 2026-12-01 | gpt-5.6-sol |");
    expect(markdown).toContain("llm-model-deprecation registry");
  });

  it("omits a date conflict for a model absent from the report", async () => {
    const root = await mkdtemp(join(tmpdir(), "handoff-registry-scope-"));
    created.push(root);
    const fixture = JSON.parse(
      await readFile(resolve("test/fixtures/remote-registry.json"), "utf8"),
    ) as unknown;
    const report = await generate({
      repo: resolve("test/fixtures/basic-ai-sdk"),
      out: root,
      offline: false,
      format: "json",
      registryCachePath: join(root, "registry.json"),
      registryFetch: async () => Response.json(fixture),
    });
    expect(
      report.models.some((model) => model.modelId === "gpt-5-2025-08-07"),
    ).toBe(false);
    expect(
      report.limits.some((note) => note.includes("gpt-5-2025-08-07")),
    ).toBe(false);
  });
});
