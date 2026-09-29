import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadBundledRegistry } from "../src/enrich/modelRegistry.js";
import { generate } from "../src/pipeline.js";
import { renderJson } from "../src/render/json.js";
import { renderMarkdown } from "../src/render/markdown.js";
import type { HandoffReport } from "../src/types.js";

const created: string[] = [];
afterEach(async () => {
  await Promise.all(
    created.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("step 6 report rendering", () => {
  it("omits ownership findings from Other findings and groups model findings by provider, model, and rule", async () => {
    const locationA = { file: "src/a.ts", line: 1 };
    const locationB = { file: "src/b.ts", line: 2 };
    const report: HandoffReport = {
      schemaVersion: 1,
      toolVersion: "0.1.0",
      generatedAt: "2026-09-28T12:00:00.000Z",
      repo: { path: "/tmp/example", commitSha: null, branch: null },
      vercel: {
        projectId: null,
        projectName: null,
        teamId: null,
        accessed: false,
      },
      coverage: { verified: 0, mismatch: 0, unverified: 2 },
      envVars: [],
      models: [locationA, locationB].map((location) => ({
        provider: "google",
        modelId: "gemini-demo",
        rawExpression: "gemini-demo",
        callKind: "generateText",
        location,
      })),
      crons: [],
      workflows: [],
      services: [],
      ownership: [
        {
          key: "domain:demo.vercel.app",
          item: "Domain demo.vercel.app",
          owner: "unknown",
          action: "Vercel-provided domain.",
        },
      ],
      findings: [
        ...[locationA, locationB].map((location, index) => ({
          id: `model:gemini-demo:${index}`,
          rule: "V13",
          subject: "gemini-demo",
          category: "model" as const,
          title: "Model ID not found in registry",
          severity: "MEDIUM" as const,
          verification: "UNVERIFIED" as const,
          evidence: [
            { source: "repo" as const, detail: "model call", location },
          ],
          action: "Confirm the model ID.",
        })),
        {
          id: "ownership:domain:demo.vercel.app",
          rule: null,
          subject: "Domain demo.vercel.app",
          category: "ownership",
          title: "Ownership: Domain demo.vercel.app",
          severity: "INFO",
          verification: "UNVERIFIED",
          evidence: [],
          action: "Vercel-provided domain.",
        },
      ],
      limits: [],
    };
    const markdown = renderMarkdown(report, {
      registry: await loadBundledRegistry(),
      modelStatuses: ["UNVERIFIED", "UNVERIFIED"],
    });
    const other = markdown
      .split("## Other findings\n")[1]!
      .split("## 2. Ownership transfer checklist")[0]!;
    expect(other.match(/Model ID not found in registry/g)).toHaveLength(1);
    expect(other).not.toContain("Ownership:");
    expect(markdown).toContain("| - [ ] | Domain demo.vercel.app | unknown |");
    expect(renderJson(report)).toContain("ownership:domain:demo.vercel.app");
  });
  it("shows other findings, V17 drift, and per-run webhook workflow details", async () => {
    const out = await mkdtemp(join(tmpdir(), "handoff-workflow-render-"));
    created.push(out);
    const report = await generate({
      repo: resolve("test/fixtures/workflows-alias"),
      out,
      offline: true,
      format: "json",
    });
    const markdown = renderMarkdown(
      {
        ...report,
        findings: [
          ...report.findings,
          {
            id: "protection:production-commit",
            rule: "V17",
            subject: "production-commit",
            category: "protection",
            title: "Report describes a commit that is not in production",
            severity: "MEDIUM",
            verification: "MISMATCH",
            evidence: [],
            action: "Deploy the scanned commit.",
          },
        ],
      },
      { registry: await loadBundledRegistry(), modelStatuses: [] },
    );
    expect(markdown).toContain(
      "> ⚠️ Production is running a different commit than this report describes.",
    );
    expect(markdown).toContain("## Other findings");
    expect(markdown).toContain(
      "**MEDIUM · ❌ Mismatch:** Report describes a commit that is not in production. Deploy the scanned commit.",
    );
    expect(markdown).toContain(
      "writeProgressEvent (app/api/generate/generate-birthday-card.ts:9; 2 calls)",
    );
    expect(markdown).toContain("- Started from: app/api/generate/route.ts:5");
    expect(markdown).toContain(
      "Pending runs hold webhook URLs on the current domain; changing the production domain may break runs waiting on these webhooks.",
    );
    expect(markdown).not.toContain("### Webhook receiver");
  });
  it("renders chatbot fixture auth locations, declared models, and test-only variables", async () => {
    const out = await mkdtemp(join(tmpdir(), "handoff-chatbot-render-"));
    created.push(out);
    await generate({
      repo: resolve("test/fixtures/chatbot-patterns"),
      out,
      offline: true,
      format: "both",
      now: new Date("2026-09-28T12:00:00.000Z"),
    });
    const markdown = await readFile(join(out, "HANDOFF.md"), "utf8");
    expect(markdown).toContain(
      "- Where it's used: app/api/auth/route.ts:1, auth.ts:1",
    );
    expect(markdown).toContain(
      "Test-only variables: E2E_TOKEN (e2e/other.ts:1, tests/e2e/login.ts:1); PORT (playwright.config.ts:1).",
    );
    expect(markdown).toContain("read automatically by @vercel/blob");
    expect(markdown).toContain("read automatically by @ai-sdk/gateway");
    expect(markdown).toContain(
      "declared models (not traced to a call site): lib/ai/models.ts:2",
    );
    expect(markdown.match(/\| openai \| gpt-5-2025-08-07 \|/g)).toHaveLength(1);
    expect(markdown).toContain(
      "lib/ai/providers.ts:4; declared models (not traced to a call site): lib/ai/models.ts:2",
    );
    expect(markdown).toMatch(
      /## 4\. Scheduled jobs \(crons\)[\s\S]*?None detected\./,
    );
  });
  it("matches the offline basic AI SDK runbook snapshot", async () => {
    const out = await mkdtemp(join(tmpdir(), "handoff-pack-render-"));
    created.push(out);
    await generate({
      repo: resolve("test/fixtures/basic-ai-sdk"),
      out,
      offline: true,
      format: "both",
      now: new Date("2026-09-24T12:00:00.000Z"),
    });
    const markdown = await readFile(join(out, "HANDOFF.md"), "utf8");
    expect(markdown).toMatchSnapshot();
    expect(markdown).toContain("⚠️ Unverified");
    expect(markdown).toContain("✅ Verified");
  });

  it("escapes table pipes and sorts the JSON without changing the report", async () => {
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
      coverage: { verified: 0, mismatch: 0, unverified: 2 },
      envVars: [
        {
          name: "Z|VALUE",
          references: [
            { file: "z.ts", line: 3 },
            { file: "a.ts", line: 2 },
          ],
          declaredIn: [],
          clientExposed: false,
        },
        {
          name: "A",
          references: [],
          declaredIn: [],
          clientExposed: false,
        },
      ],
      models: [],
      crons: [],
      workflows: [],
      findings: [],
      limits: ["z", "a"],
    };
    const markdown = renderMarkdown(report, {
      registry: await loadBundledRegistry(),
      modelStatuses: [],
    });
    expect(markdown).toContain("Z\\|VALUE");
    expect(markdown).toMatch(
      /## 4\. Scheduled jobs \(crons\)[\s\S]*?None detected\./,
    );
    expect(markdown).toMatch(
      /## 6\. Model dependencies[\s\S]*?None detected\./,
    );
    const parsed = JSON.parse(renderJson(report)) as HandoffReport;
    expect(parsed.envVars.map((item) => item.name)).toEqual(["A", "Z|VALUE"]);
    expect(parsed.envVars[1]?.references).toEqual([
      { file: "a.ts", line: 2 },
      { file: "z.ts", line: 3 },
    ]);
    expect(parsed.limits).toEqual(["a", "z"]);
    expect(report.envVars[0]?.references[0]?.file).toBe("z.ts");
  });

  it("shows confirmed Hobby cron timing and a live missing-route warning", async () => {
    const report: HandoffReport = {
      schemaVersion: 1,
      toolVersion: "0.1.0",
      generatedAt: "2026-09-24T12:00:00.000Z",
      repo: { path: "/tmp/example", commitSha: null, branch: null },
      vercel: {
        projectId: "prj_1",
        projectName: "example",
        teamId: "team_1",
        accessed: true,
        plan: "hobby",
      },
      coverage: { verified: 0, mismatch: 1, unverified: 0 },
      envVars: [],
      omittedSystemEnvVars: ["VERCEL_OIDC_TOKEN"],
      models: [],
      crons: [
        {
          path: "/api/cron/missing",
          schedule: "0 12 * * *",
          humanSchedule: "At 12:00 PM (UTC)",
          liveOnVercel: true,
          status: "MISMATCH",
        },
      ],
      workflows: [],
      findings: [
        {
          id: "cron:/api/cron/missing:route",
          rule: "V7",
          subject: "/api/cron/missing",
          category: "cron",
          title: "Cron route or GET handler missing",
          severity: "CRITICAL",
          verification: "MISMATCH",
          evidence: [],
        },
      ],
      limits: [],
    };
    const context = {
      registry: await loadBundledRegistry(),
      modelStatuses: [],
    };
    const markdown = renderMarkdown(report, context);
    expect(markdown).toContain(
      "Omitted (managed by Vercel): VERCEL_OIDC_TOKEN.",
    );
    expect(markdown).toContain("| Live on Vercel | Status | Notes |");
    expect(markdown).toContain(
      "Scheduled on Vercel, but the route file doesn't exist; every run will 404.",
    );
    expect(markdown).toContain(
      "Hobby plan timing: cron jobs may run up to 59 minutes",
    );
    expect(
      renderMarkdown(
        { ...report, vercel: { ...report.vercel, plan: undefined } },
        context,
      ),
    ).not.toContain("Hobby plan timing:");
  });
});
