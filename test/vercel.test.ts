import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { generate } from "../src/pipeline.js";
import {
  createVercelClient,
  type VercelReadClient,
} from "../src/vercel/client.js";
import { collectVercel, VercelAuthError } from "../src/vercel/collect.js";
import { verifyLiveRules } from "../src/verify/rules.js";
import type { EnvVarRecord } from "../src/types.js";

function fakeClient(
  overrides: Partial<VercelReadClient> = {},
): VercelReadClient {
  return {
    project: async () => ({
      id: "prj_1",
      name: "demo",
      accountId: "team_1",
      framework: "nextjs",
    }),
    envs: async () => ({ items: [], next: null, complete: true }),
    domains: async () => ({ items: [], next: null, complete: true }),
    productionDeployment: async () => null,
    team: async () => ({ id: "team_1", name: "Demo", slug: "demo" }),
    ...overrides,
  };
}

describe("Vercel collection and live rules", () => {
  it("treats an invalid-token 403 as authentication failure", async () => {
    await expect(
      collectVercel(
        fakeClient({
          project: async () => {
            throw {
              statusCode: 403,
              body: JSON.stringify({ error: { invalidToken: true } }),
            };
          },
        }),
        "demo",
      ),
    ).rejects.toBeInstanceOf(VercelAuthError);
  });

  it("keeps a project-scope 403 unverified", async () => {
    const result = await collectVercel(
      fakeClient({
        project: async () => {
          throw { statusCode: 403, body: '{"error":{"code":"forbidden"}}' };
        },
      }),
      "demo",
    );
    expect(result.project).toBeNull();
    expect(result.limits).toContain(
      "Token cannot read project; project checks UNVERIFIED.",
    );
  });

  it("drops env values and encrypted hints at the SDK boundary", async () => {
    const filterProjectEnvs = vi.fn().mockResolvedValue({
      envs: [
        {
          key: "API_KEY",
          target: ["production"],
          type: "encrypted",
          value: "do-not-print",
          legacyValue: "also-secret",
          internalContentHint: { encryptedValue: "ciphertext" },
        },
      ],
      pagination: { count: 1, next: null, prev: null },
    });
    const sdk = { projects: { filterProjectEnvs } } as unknown as Parameters<
      typeof createVercelClient
    >[1];
    const result = await createVercelClient("unused", sdk).envs("demo");
    expect(filterProjectEnvs).toHaveBeenCalledWith({
      idOrName: "demo",
      teamId: undefined,
      decrypt: "false",
    });
    expect(result.items).toEqual([
      { key: "API_KEY", target: ["production"], type: "encrypted" },
    ]);
    expect(JSON.stringify(result)).not.toContain("do-not-print");
    expect(JSON.stringify(result)).not.toContain("also-secret");
    expect(JSON.stringify(result)).not.toContain("ciphertext");
  });

  it("retries 429, paginates domains, and keeps a denied env check unverified", async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const live = await collectVercel(
      fakeClient({
        envs: async () => {
          throw { statusCode: 403 };
        },
        domains: async (_project, _team, since) => {
          if (since === undefined && attempts++ === 0)
            throw {
              statusCode: 429,
              headers: new Headers({ "retry-after": "1" }),
            };
          return since === undefined
            ? {
                items: [{ name: "bad.example", verified: false }],
                next: 12,
                complete: false,
              }
            : {
                items: [{ name: "good.example", verified: true }],
                next: null,
                complete: true,
              };
        },
      }),
      "demo",
      undefined,
      async (ms) => {
        sleeps.push(ms);
      },
    );
    expect(sleeps).toEqual([1000]);
    expect(live.domains).toHaveLength(2);
    expect(live.envsComplete).toBe(false);
    expect(live.limits).toContain(
      "Token cannot read environment variables; environment variables checks UNVERIFIED.",
    );
  });

  it("classifies V1, V3, V16, V17 and leaves present production vars verified", async () => {
    const live = await collectVercel(
      fakeClient({
        envs: async () => ({
          items: [
            { key: "PRESENT", target: ["production"], type: "encrypted" },
            { key: "ORPHAN", target: ["preview"], type: "plain" },
          ],
          next: null,
          complete: true,
        }),
        domains: async () => ({
          items: [{ name: "bad.example", verified: false }],
          next: null,
          complete: true,
        }),
        productionDeployment: async () => ({
          uid: "d1",
          url: "demo.vercel.app",
          createdAt: 1,
          commitSha: "deployed",
        }),
      }),
      "demo",
    );
    const envVars: EnvVarRecord[] = ["MISSING", "PRESENT"].map((name) => ({
      name,
      references: [{ file: "src/index.ts", line: 1 }],
      declaredIn: [],
      clientExposed: false,
    }));
    const result = verifyLiveRules({
      envVars,
      vercel: live,
      repoCommitSha: "local",
    });
    expect(result.findings.map((finding) => finding.rule).sort()).toEqual([
      "V1",
      "V16",
      "V17",
      "V3",
    ]);
    expect(result.envVars.map((item) => item.name)).toEqual([
      "MISSING",
      "ORPHAN",
      "PRESENT",
    ]);
    expect(result.envStatuses).toEqual(["MISMATCH", "VERIFIED", "VERIFIED"]);
    expect(result.envVars[2]?.vercelTargets).toEqual(["production"]);
  });

  it("does not claim V1 when the env listing is incomplete", () => {
    const result = verifyLiveRules({
      envVars: [
        {
          name: "UNKNOWN",
          references: [{ file: "a.ts", line: 1 }],
          declaredIn: [],
          clientExposed: false,
        },
      ],
      vercel: {
        project: { id: "p", name: "p", accountId: "t", framework: null },
        envs: [],
        envsComplete: false,
        domains: [],
        domainsComplete: false,
        deployment: null,
        deploymentChecked: false,
        team: null,
        limits: [],
      },
      repoCommitSha: null,
    });
    expect(result.envStatuses).toEqual(["UNVERIFIED"]);
    expect(result.findings).toEqual([]);
  });

  it("treats a sample-file declaration without code references as possibly orphaned", async () => {
    const live = await collectVercel(
      fakeClient({
        envs: async () => ({
          items: [{ key: "SAMPLE_ONLY", target: ["preview"], type: "plain" }],
          next: null,
          complete: true,
        }),
      }),
      "demo",
    );
    const result = verifyLiveRules({
      envVars: [
        {
          name: "SAMPLE_ONLY",
          references: [],
          declaredIn: [".env.example"],
          clientExposed: false,
        },
      ],
      vercel: live,
      repoCommitSha: null,
    });
    expect(result.envVars).toHaveLength(1);
    expect(result.envStatuses).toEqual(["VERIFIED"]);
    expect(result.findings.map((finding) => finding.rule)).toEqual([
      "V3",
      "V6",
    ]);
  });

  it("uses live metadata in the full report and keeps offline mode network-free", async () => {
    const out = await mkdtemp(join(tmpdir(), "handoff-vercel-"));
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => {
        throw new Error("Unexpected network call");
      });
    const previous = process.env.VERCEL_TOKEN;
    process.env.VERCEL_TOKEN = "test-token";
    const project = vi.fn(fakeClient().project);
    const client = fakeClient({
      project,
      envs: async () => ({
        items: [
          { key: "OPENAI_API_KEY", target: ["production"], type: "encrypted" },
          { key: "ORPHAN", target: ["production"], type: "plain" },
          { key: "VERCEL_REGION", target: ["production"], type: "system" },
        ],
        next: null,
        complete: true,
      }),
    });
    try {
      const online = await generate({
        repo: resolve("test/fixtures/basic-ai-sdk"),
        out: join(out, "online"),
        offline: false,
        vercelProject: "demo",
        vercelClient: client,
        registryFetch: async () => {
          throw new Error("Mock registry unavailable");
        },
        registryCachePath: join(out, "registry.json"),
        format: "both",
        now: new Date("2026-09-24T12:00:00Z"),
      });
      expect(online.vercel).toMatchObject({
        projectId: "prj_1",
        accessed: true,
      });
      expect(online.omittedSystemEnvVars).toEqual([
        "VERCEL_OIDC_TOKEN",
        "VERCEL_REGION",
        "VERCEL_URL",
      ]);
      expect(online.envVars.some((item) => item.name === "VERCEL_REGION")).toBe(
        false,
      );
      expect(online.findings.some((finding) => finding.rule === "V1")).toBe(
        true,
      );
      expect(online.findings.some((finding) => finding.rule === "V3")).toBe(
        true,
      );
      expect(
        online.envVars.find((item) => item.name === "OPENAI_API_KEY")
          ?.vercelTargets,
      ).toEqual(["production"]);
      expect(
        await readFile(join(out, "online", "HANDOFF.md"), "utf8"),
      ).toContain("❌ Mismatch");
      expect(JSON.stringify(online)).not.toContain("test-token");
      project.mockClear();
      await generate({
        repo: resolve("test/fixtures/basic-ai-sdk"),
        out: join(out, "offline"),
        offline: true,
        vercelProject: "demo",
        vercelClient: client,
        format: "json",
      });
      expect(project).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      if (previous === undefined) delete process.env.VERCEL_TOKEN;
      else process.env.VERCEL_TOKEN = previous;
      await rm(out, { recursive: true, force: true });
    }
  });

  it("records cron verification and V8 when live definitions differ", async () => {
    const out = await mkdtemp(join(tmpdir(), "handoff-cron-live-"));
    const previous = process.env.VERCEL_TOKEN;
    process.env.VERCEL_TOKEN = "test-token";
    try {
      const report = await generate({
        repo: resolve("test/fixtures/crons"),
        out,
        offline: false,
        vercelProject: "demo",
        vercelClient: fakeClient({
          project: async () => ({
            id: "prj_1",
            name: "demo",
            accountId: "team_1",
            framework: "nextjs",
            crons: [],
          }),
        }),
        registryFetch: async () => {
          throw new Error("Mock registry unavailable");
        },
        registryCachePath: join(out, "registry.json"),
        format: "json",
      });
      expect(report.crons.every((item) => item.status === "MISMATCH")).toBe(
        true,
      );
      expect(report.findings.some((item) => item.rule === "V8")).toBe(true);
      expect(report.coverage.mismatch).toBeGreaterThanOrEqual(
        report.crons.length,
      );
    } finally {
      if (previous === undefined) delete process.env.VERCEL_TOKEN;
      else process.env.VERCEL_TOKEN = previous;
      await rm(out, { recursive: true, force: true });
    }
  });
});
