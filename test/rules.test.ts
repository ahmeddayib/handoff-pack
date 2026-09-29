import { describe, expect, it } from "vitest";
import type { ModelRecord } from "../src/types.js";
import { modelRegistrySchema } from "../src/enrich/modelRegistry.js";
import { verifyModelRules } from "../src/verify/rules.js";

const source = "https://example.com/provider-docs";
const registry = modelRegistrySchema.parse({
  verifiedAt: "2026-09-24",
  models: [
    {
      provider: "openai",
      modelId: "retired",
      aliases: [],
      status: "retired",
      deprecationDate: "2026-01-01",
      retirementDate: "2026-06-01",
      replacement: "active",
      inputUsdPerMTok: null,
      outputUsdPerMTok: null,
      source,
    },
    {
      provider: "openai",
      modelId: "soon",
      aliases: [],
      status: "deprecated",
      deprecationDate: "2026-09-01",
      retirementDate: "2026-10-01",
      replacement: "active",
      inputUsdPerMTok: null,
      outputUsdPerMTok: null,
      source,
    },
    {
      provider: "openai",
      modelId: "later",
      aliases: [],
      status: "deprecated",
      deprecationDate: "2026-09-01",
      retirementDate: "2027-05-01",
      replacement: "active",
      inputUsdPerMTok: null,
      outputUsdPerMTok: null,
      source,
    },
    {
      provider: "openai",
      modelId: "legacy",
      aliases: [],
      status: "legacy",
      deprecationDate: null,
      retirementDate: null,
      replacement: null,
      inputUsdPerMTok: null,
      outputUsdPerMTok: null,
      source,
    },
    {
      provider: "openai",
      modelId: "active",
      aliases: [],
      status: "active",
      deprecationDate: null,
      retirementDate: null,
      replacement: null,
      inputUsdPerMTok: 2,
      outputUsdPerMTok: 8,
      source,
    },
  ],
});

function model(
  modelId: string | null,
  line: number,
  configuredViaEnv?: string,
): ModelRecord {
  return {
    provider: "openai",
    modelId,
    rawExpression: modelId ?? "dynamic",
    callKind: "generateText",
    location: { file: "src/app.ts", line },
    ...(configuredViaEnv ? { configuredViaEnv } : {}),
  };
}

describe("model verification rules V9-V14", () => {
  it("classifies retired, near retirement, later retirement, legacy, active, unknown, and dynamic IDs", () => {
    const result = verifyModelRules({
      models: [
        model("retired", 1),
        model("soon", 2),
        model("later", 3),
        model("legacy", 4),
        model("active", 5),
        model("unknown", 6),
        model(null, 7),
      ],
      registry,
      now: new Date("2026-09-24T12:00:00Z"),
      deprecationWindowDays: 90,
    });
    expect(
      result.findings
        .map((finding) => [
          finding.rule,
          finding.severity,
          finding.verification,
        ])
        .sort(
          (a, b) =>
            Number(String(a[0]).slice(1)) - Number(String(b[0]).slice(1)),
        ),
    ).toEqual([
      ["V9", "CRITICAL", "VERIFIED"],
      ["V10", "HIGH", "VERIFIED"],
      ["V11", "MEDIUM", "VERIFIED"],
      ["V11", "MEDIUM", "VERIFIED"],
      ["V13", "MEDIUM", "UNVERIFIED"],
      ["V14", "MEDIUM", "UNVERIFIED"],
    ]);
    expect(result.statuses).toEqual([
      "VERIFIED",
      "VERIFIED",
      "VERIFIED",
      "VERIFIED",
      "VERIFIED",
      "UNVERIFIED",
      "UNVERIFIED",
    ]);
    expect(
      result.findings.some((finding) => finding.subject === "active"),
    ).toBe(false);
  });

  it("treats an env default as unverified production state", () => {
    const result = verifyModelRules({
      models: [model("retired", 1, "MODEL")],
      registry,
      now: new Date("2026-09-24T12:00:00Z"),
      deprecationWindowDays: 90,
    });
    expect(result.findings).toMatchObject([
      { rule: "V14", verification: "UNVERIFIED" },
    ]);
    expect(result.statuses).toEqual(["UNVERIFIED"]);
  });

  it("does not verify a deprecated entry whose retirement date has passed", () => {
    const result = verifyModelRules({
      models: [model("soon", 1)],
      registry,
      now: new Date("2026-10-02T12:00:00Z"),
      deprecationWindowDays: 90,
    });
    expect(result.statuses).toEqual(["UNVERIFIED"]);
    expect(result.findings).toMatchObject([
      { rule: null, verification: "UNVERIFIED" },
    ]);
    expect(result.limits).toHaveLength(1);
  });
});
