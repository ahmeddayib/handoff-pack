import { describe, expect, it, vi } from "vitest";
import { verifyLiveRules } from "../src/verify/rules.js";
import { createVercelClient } from "../src/vercel/client.js";
import type { VercelCollection } from "../src/vercel/collect.js";
import type { EnvVarRecord } from "../src/types.js";

function live(overrides: Partial<VercelCollection> = {}): VercelCollection {
  return {
    project: { id: "p", name: "p", accountId: "team_1", framework: "nextjs" },
    envs: [],
    envsComplete: true,
    domains: [],
    domainsComplete: true,
    deployment: null,
    deploymentChecked: true,
    team: null,
    limits: [],
    ...overrides,
  };
}

function env(
  name: string,
  overrides: Partial<EnvVarRecord> = {},
): EnvVarRecord {
  return {
    name,
    references: [{ file: "src/app.ts", line: 2 }],
    declaredIn: [],
    clientExposed: false,
    ...overrides,
  };
}

describe("remaining live verification rules", () => {
  it("flags exposed secrets and plain Vercel secrets while honoring publishable names", () => {
    const result = verifyLiveRules({
      envVars: [
        env("NEXT_PUBLIC_STRIPE_SECRET", { clientExposed: true }),
        env("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", { clientExposed: true }),
        env("NEXT_PUBLIC_STRIPE_PUBLIC_KEY", { clientExposed: true }),
        env("NEXT_PUBLIC_VAPID_PUBLIC_KEY", { clientExposed: true }),
        env("NEXT_PUBLIC_SUPABASE_ANON_KEY", { clientExposed: true }),
        env("NEXT_PUBLIC_SENTRY_DSN", { clientExposed: true }),
      ],
      vercel: live({
        envs: [
          {
            key: "NEXT_PUBLIC_STRIPE_SECRET",
            target: ["production"],
            type: "plain",
          },
          { key: "ORPHAN_TOKEN", target: ["production"], type: "plain" },
        ],
      }),
      repoCommitSha: null,
    });
    expect(
      result.findings
        .filter((item) => item.rule === "V4")
        .map((item) => ({ subject: item.subject, severity: item.severity }))
        .sort((a, b) => a.subject.localeCompare(b.subject)),
    ).toEqual([{ subject: "NEXT_PUBLIC_STRIPE_SECRET", severity: "HIGH" }]);
    expect(
      result.findings
        .filter((item) => item.rule === "V5")
        .map((item) => item.subject)
        .sort(),
    ).toEqual(["NEXT_PUBLIC_STRIPE_SECRET", "ORPHAN_TOKEN"]);
  });

  it.each([
    "NEXT_PUBLIC_PRIVATE_KEY",
    "NEXT_PUBLIC_SECRET_PUBLIC_KEY",
    "NEXT_PUBLIC_TOKEN_PUBLIC_KEY",
  ])("flags %s as V4 HIGH", (name) => {
    const result = verifyLiveRules({
      envVars: [env(name, { clientExposed: true })],
      vercel: live(),
      repoCommitSha: null,
    });
    expect(result.findings.find((item) => item.rule === "V4")).toMatchObject({
      subject: name,
      severity: "HIGH",
    });
  });

  it("marks client exposure unverified offline and reports unused example declarations", () => {
    const result = verifyLiveRules({
      envVars: [
        env("NEXT_PUBLIC_API_SECRET", { clientExposed: true }),
        env("UNUSED_EXAMPLE", { references: [], declaredIn: [".env.example"] }),
        env("NEXT_PUBLIC_UNUSED_SECRET", {
          references: [],
          declaredIn: [".env.example"],
          clientExposed: true,
        }),
      ],
      vercel: null,
      repoCommitSha: null,
    });
    expect(
      result.findings.find((item) => item.rule === "V4")?.verification,
    ).toBe("UNVERIFIED");
    expect(
      result.findings.find(
        (item) => item.rule === "V6" && item.subject === "UNUSED_EXAMPLE",
      ),
    ).toMatchObject({
      subject: "UNUSED_EXAMPLE",
      verification: "NOT_APPLICABLE",
    });
    expect(result.findings.filter((item) => item.rule === "V4")).toHaveLength(
      1,
    );
  });

  it("only verifies disabled production protection when the project exposes its state", () => {
    const disabled = verifyLiveRules({
      envVars: [],
      vercel: live({
        project: {
          id: "p",
          name: "p",
          accountId: "team_1",
          framework: "nextjs",
          productionProtectionEnabled: false,
        },
      }),
      repoCommitSha: null,
    });
    expect(
      disabled.findings.find((item) => item.rule === "V15")?.verification,
    ).toBe("VERIFIED");
    const unknown = verifyLiveRules({
      envVars: [],
      vercel: live(),
      repoCommitSha: null,
    });
    expect(unknown.findings.some((item) => item.rule === "V15")).toBe(false);
    expect(unknown.limits).toContain(
      "Production deployment protection settings were not exposed; V15 UNVERIFIED.",
    );
  });

  it("normalizes typed SDK protection fields conservatively", async () => {
    const getProject = vi.fn().mockResolvedValue({
      id: "p",
      name: "p",
      accountId: "team_1",
      framework: "nextjs",
      passwordProtection: null,
      ssoProtection: { deploymentType: "preview" },
      trustedIps: null,
    });
    const sdk = { projects: { getProject } } as unknown as Parameters<
      typeof createVercelClient
    >[1];
    expect(
      (await createVercelClient("unused", sdk).project("p"))
        .productionProtectionEnabled,
    ).toBe(false);
    getProject.mockResolvedValue({
      id: "p",
      name: "p",
      accountId: "team_1",
      framework: "nextjs",
      passwordProtection: {},
      ssoProtection: null,
      trustedIps: null,
    });
    expect(
      (await createVercelClient("unused", sdk).project("p"))
        .productionProtectionEnabled,
    ).toBe(true);
  });
});
