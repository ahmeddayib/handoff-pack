import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configSchema } from "../src/config.js";
import { generate, UsageError } from "../src/pipeline.js";
import { handoffReportSchema } from "../src/schema.js";

const created: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    created.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("step 1 offline scaffold", () => {
  it("writes an empty report that passes the full JSON schema without network calls", async () => {
    const root = await mkdtemp(join(tmpdir(), "handoff-pack-step1-"));
    created.push(root);
    await writeFile(join(root, "package.json"), '{"name":"empty-project"}');
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const now = new Date("2026-09-24T12:00:00.000Z");
    const report = await generate({
      repo: root,
      out: join(root, "handoff"),
      offline: true,
      format: "both",
      now,
    });

    const parsed = JSON.parse(
      await readFile(join(root, "handoff", "handoff.json"), "utf8"),
    ) as unknown;
    expect(handoffReportSchema.parse(parsed)).toEqual(report);
    expect(report.envVars).toEqual([]);
    expect(report.models).toEqual([]);
    expect(report.crons).toEqual([]);
    expect(report.workflows).toEqual([]);
    expect(report.findings).toEqual([]);
    expect(report.generatedAt).toBe(now.toISOString());
    expect(
      await readFile(join(root, "handoff", "HANDOFF.md"), "utf8"),
    ).toContain("## 9. Scan limits");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects unknown config keys", () => {
    expect(() => configSchema.parse({ unexpected: true })).toThrow();
  });

  it("rejects a project request without a Vercel token", async () => {
    const root = await mkdtemp(join(tmpdir(), "handoff-pack-step1-"));
    created.push(root);
    const previous = process.env.VERCEL_TOKEN;
    delete process.env.VERCEL_TOKEN;
    try {
      await expect(
        generate({
          repo: root,
          out: join(root, "out"),
          offline: false,
          vercelProject: "example",
          format: "json",
        }),
      ).rejects.toThrow(UsageError);
    } finally {
      if (previous === undefined) delete process.env.VERCEL_TOKEN;
      else process.env.VERCEL_TOKEN = previous;
    }
  });

  it("loads and validates the optional config before writing", async () => {
    const root = await mkdtemp(join(tmpdir(), "handoff-pack-step1-"));
    created.push(root);
    await writeFile(
      join(root, "handoff.config.json"),
      JSON.stringify({ ownership: { key: "someone" } }),
    );
    await expect(
      generate({
        repo: root,
        out: join(root, "out"),
        offline: true,
        format: "json",
      }),
    ).rejects.toThrow();
  });

  it("writes fixture environment records into the offline report", async () => {
    const root = await mkdtemp(join(tmpdir(), "handoff-pack-step2-"));
    created.push(root);
    const report = await generate({
      repo: resolve("test/fixtures/basic-ai-sdk"),
      out: root,
      offline: true,
      format: "json",
    });
    expect(report.envVars.map((item) => item.name)).toEqual([
      "AI_GATEWAY_API_KEY",
      "ANTHROPIC_API_KEY",
      "MODEL",
      "NEXT_PUBLIC_ANALYTICS_ID",
      "OPENAI_API_KEY",
      "UNUSED_EXAMPLE",
    ]);
    expect(report.models).toHaveLength(4);
    expect(report.coverage).toEqual({
      verified: 3,
      mismatch: 0,
      unverified: 7,
    });
    expect(
      handoffReportSchema.parse(
        JSON.parse(await readFile(join(root, "handoff.json"), "utf8")),
      ).envVars,
    ).toHaveLength(6);
  });

  it("reports an unsupported Python repository with one critical finding", async () => {
    const root = await mkdtemp(join(tmpdir(), "handoff-pack-step2-"));
    created.push(root);
    const report = await generate({
      repo: resolve("test/fixtures/unsupported"),
      out: root,
      offline: true,
      format: "json",
    });
    expect(report.findings).toMatchObject([
      {
        title: "Unsupported project type",
        severity: "CRITICAL",
      },
    ]);
    expect(report.findings).toHaveLength(1);
  });

  it("names a nested Next.js app when the repository root is a monorepo", async () => {
    const root = await mkdtemp(join(tmpdir(), "handoff-monorepo-"));
    created.push(root);
    await writeFile(join(root, "package.json"), '{"name":"workspace-root"}');
    await mkdir(join(root, "apps", "web"), { recursive: true });
    await writeFile(
      join(root, "apps", "web", "package.json"),
      '{"name":"web","dependencies":{"next":"^16.0.0"}}',
    );
    const report = await generate({
      repo: root,
      out: join(root, "out"),
      offline: true,
      format: "json",
    });
    expect(report.limits).toContain(
      "Monorepo detected; Next.js app at apps/web was not scanned as the project root. Re-run with --repo apps/web.",
    );
  });

  it("writes cron and workflow records into offline reports", async () => {
    const root = await mkdtemp(join(tmpdir(), "handoff-pack-step4-"));
    created.push(root);
    const cronReport = await generate({
      repo: resolve("test/fixtures/crons"),
      out: join(root, "crons"),
      offline: true,
      format: "json",
    });
    expect(cronReport.crons).toHaveLength(3);
    expect(cronReport.findings.some((finding) => finding.rule === "V7")).toBe(
      true,
    );
    expect(cronReport.coverage.unverified).toBeGreaterThanOrEqual(3);
    const workflowReport = await generate({
      repo: resolve("test/fixtures/workflows"),
      out: join(root, "workflows"),
      offline: true,
      format: "json",
    });
    expect(workflowReport.workflows).toHaveLength(1);
    expect(workflowReport.workflows[0]?.startedFrom).toEqual([
      { file: "src/app/api/order/route.ts", line: 5 },
    ]);
  });
});
