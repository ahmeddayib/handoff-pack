import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanModels } from "../src/scanners/models.js";
import { detectProject } from "../src/scanners/project.js";
import { loadBundledRegistry } from "../src/enrich/modelRegistry.js";
import { verifyModelRules } from "../src/verify/rules.js";

const created: string[] = [];
afterEach(async () => {
  await Promise.all(
    created.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("model scanner", () => {
  it("finds gateway imports, exported model lists, and registry deprecations in chatbot patterns", async () => {
    const root = resolve("test/fixtures/chatbot-patterns");
    const result = await scanModels(root, await detectProject(root));
    expect(result.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "gateway",
          modelId: null,
          location: { file: "lib/ai/providers.ts", line: 3 },
        }),
        expect.objectContaining({
          provider: "openai",
          modelId: "gpt-5-2025-08-07",
          location: { file: "lib/ai/providers.ts", line: 4 },
        }),
        expect.objectContaining({
          provider: "openai",
          modelId: "gpt-4o",
          location: { file: "lib/ai/other.ts", line: 2 },
        }),
        expect.objectContaining({
          provider: "deepseek",
          modelId: "deepseek-v3.2",
          declaredOnly: true,
        }),
      ]),
    );
    expect(result.models.filter((model) => model.declaredOnly)).toHaveLength(3);
    const rules = verifyModelRules({
      models: result.models,
      registry: await loadBundledRegistry(),
      now: new Date("2026-09-28T12:00:00Z"),
      deprecationWindowDays: 90,
    });
    expect(rules.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule: "V14", severity: "MEDIUM" }),
        expect.objectContaining({
          rule: "V10",
          severity: "HIGH",
          id: "model:openai/gpt-5-2025-08-07:lib/ai/models.ts:2",
        }),
      ]),
    );
  });

  it("warns when an AI SDK dependency yields no models", async () => {
    const root = await mkdtemp(join(tmpdir(), "handoff-no-models-"));
    created.push(root);
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { ai: "7" } }),
    );
    const result = await scanModels(root, await detectProject(root));
    expect(result.models).toEqual([]);
    expect(result.limits).toContain(
      "AI SDK dependency detected, but no model references were found.",
    );
  });
  it("resolves the four AI SDK styles in basic-ai-sdk, including an env default", async () => {
    const root = resolve("test/fixtures/basic-ai-sdk");
    const result = await scanModels(root, await detectProject(root));
    expect(result.models).toMatchObject([
      {
        provider: "openai",
        modelId: "gpt-4o",
        callKind: "generateText",
        maxOutputTokens: 200,
        location: { file: "src/app/api/chat/route.ts", line: 12 },
      },
      {
        provider: "anthropic",
        modelId: "claude-sonnet-4-5",
        callKind: "generateText",
        location: { file: "src/app/api/chat/route.ts", line: 13 },
      },
      {
        provider: "openai",
        modelId: "gpt-4o",
        callKind: "generateText",
        location: { file: "src/app/api/chat/route.ts", line: 14 },
      },
      {
        provider: "openai",
        modelId: "gpt-4o",
        callKind: "generateText",
        configuredViaEnv: "MODEL",
        location: { file: "src/app/api/chat/route.ts", line: 15 },
      },
    ]);
    expect(result.models).toHaveLength(4);
    expect(result.limits).toContain(
      "Model at src/app/api/chat/route.ts:15 is a default; production value comes from env var MODEL and was not read.",
    );
    expect(result.findings).toEqual([]);
  });

  it("tracks aliases, provider factories, one-hop constants, agents, raw SDKs, and unresolved IDs", async () => {
    const root = await mkdtemp(join(tmpdir(), "handoff-models-"));
    created.push(root);
    await mkdir(join(root, "src"));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { ai: "7", "@ai-sdk/openai": "4" } }),
    );
    await writeFile(
      join(root, "src", "constants.ts"),
      "export const MODEL_ID = 'gpt-4.1';\n",
    );
    await writeFile(
      join(root, "src", "models.ts"),
      [
        "import { createOpenAI } from '@ai-sdk/openai';",
        "import { streamText as stream, ToolLoopAgent as Agent } from 'ai';",
        "import OpenAI from 'openai';",
        "import Anthropic from '@anthropic-ai/sdk';",
        "import { MODEL_ID as chosen } from './constants';",
        "const provider = createOpenAI({});",
        "const openaiClient = new OpenAI();",
        "const anthropicClient = new Anthropic();",
        "const dynamic = chooseModel();",
        "stream({ model: provider.responses(chosen), maxTokens: 300 });",
        "stream({ model: provider.embeddingModel('text-embedding-3-small') });",
        "new Agent({ model: 'anthropic/claude-sonnet-4-5' });",
        "openaiClient.chat.completions.create({ model: 'gpt-4o' });",
        "anthropicClient.messages.create({ model: 'claude-sonnet-4-5' });",
        "stream({ model: provider(dynamic) });",
      ].join("\n"),
    );
    const result = await scanModels(root, await detectProject(root));
    expect(
      result.models.map(({ provider, modelId, callKind }) => ({
        provider,
        modelId,
        callKind,
      })),
    ).toEqual([
      { provider: "openai", modelId: "gpt-4.1", callKind: "streamText" },
      {
        provider: "openai",
        modelId: "text-embedding-3-small",
        callKind: "streamText",
      },
      {
        provider: "anthropic",
        modelId: "claude-sonnet-4-5",
        callKind: "agent",
      },
      { provider: "openai", modelId: "gpt-4o", callKind: "rawSdk" },
      {
        provider: "anthropic",
        modelId: "claude-sonnet-4-5",
        callKind: "rawSdk",
      },
      { provider: "openai", modelId: null, callKind: "streamText" },
    ]);
    expect(result.models[0]?.maxOutputTokens).toBe(300);
    expect(result.findings).toMatchObject([
      { title: "Dynamic model ID; verify manually.", severity: "INFO" },
    ]);
  });
});
