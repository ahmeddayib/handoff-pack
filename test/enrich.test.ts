import { describe, expect, it } from "vitest";
import { modelCost } from "../src/enrich/cost.js";
import { buildPlaybook, loadStatusPages } from "../src/enrich/playbook.js";
import type { HandoffReport, ModelRecord } from "../src/types.js";

const model: ModelRecord = {
  provider: "openai",
  modelId: "gpt-4o",
  rawExpression: "gpt-4o",
  callKind: "generateText",
  location: { file: "src/chat.ts", line: 8 },
};

describe("report enrichment", () => {
  it("prices calls with configured assumptions and max output token bounds", () => {
    const registry = {
      verifiedAt: "2026-09-24",
      models: [
        {
          provider: "openai",
          modelId: "gpt-4o",
          aliases: [],
          status: "active" as const,
          deprecationDate: null,
          retirementDate: null,
          replacement: null,
          inputUsdPerMTok: 2.5,
          outputUsdPerMTok: 10,
          source: "https://example.com",
        },
      ],
    };
    expect(
      modelCost(model, registry, { avgInputTokens: 1000, avgOutputTokens: 500 })
        .label,
    ).toBe("$7.50");
    expect(
      modelCost({ ...model, maxOutputTokens: 4000 }, registry, {
        avgInputTokens: 1000,
        avgOutputTokens: 500,
      }).label,
    ).toBe("$42.50 upper bound (uses maxOutputTokens)");
  });

  it("creates one playbook entry per detected dependency category", () => {
    const report: HandoffReport = {
      schemaVersion: 1,
      toolVersion: "0.1.0",
      generatedAt: "2026-09-24T12:00:00.000Z",
      repo: { path: "/tmp/example", commitSha: null, branch: null },
      vercel: {
        projectId: null,
        projectName: null,
        teamId: null,
        accessed: false,
      },
      coverage: { verified: 0, mismatch: 0, unverified: 0 },
      envVars: [],
      models: [
        model,
        { ...model, location: { file: "src/other.ts", line: 4 } },
      ],
      crons: [],
      workflows: [],
      services: [],
      findings: [],
      limits: [],
    };
    const playbook = buildPlaybook(report);
    expect(playbook.map((item) => item.title)).toEqual(["LLM provider"]);
    expect(playbook[0]?.locations).toHaveLength(2);
  });

  it("loads validated status pages and attaches relevant links", async () => {
    const pages = await loadStatusPages();
    expect(pages.OpenAI).toBe("https://status.openai.com/");
    const report: HandoffReport = {
      schemaVersion: 1,
      toolVersion: "0.1.0",
      generatedAt: "2026-09-24T12:00:00.000Z",
      repo: { path: "/tmp/example", commitSha: null, branch: null },
      vercel: {
        projectId: null,
        projectName: null,
        teamId: null,
        accessed: false,
      },
      coverage: { verified: 0, mismatch: 0, unverified: 0 },
      envVars: [],
      models: [model],
      crons: [],
      workflows: [],
      services: [
        {
          service: "OpenAI",
          category: "llm",
          envVars: [],
          packages: ["@ai-sdk/openai"],
        },
      ],
      findings: [],
      limits: [],
    };
    expect(buildPlaybook(report, pages)[0]?.statusPage).toBe(pages.OpenAI);
  });
});
