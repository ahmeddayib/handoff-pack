import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { scanEnvVars } from "../src/scanners/envVars.js";
import { detectProject } from "../src/scanners/project.js";
import { verifyLiveRules } from "../src/verify/rules.js";

const fixture = (name: string) => resolve("test/fixtures", name);

describe("environment scanner", () => {
  it("keeps Playwright and e2e references test-only and labels package-managed keys", async () => {
    const root = fixture("chatbot-patterns");
    const result = await scanEnvVars(root, await detectProject(root), {
      trackedFiles: [],
    });
    expect(result.envVars.map((item) => item.name)).toEqual([
      "AI_GATEWAY_API_KEY",
      "AUTH_SECRET",
      "BLOB_READ_WRITE_TOKEN",
    ]);
    expect(
      result.envVars.find((item) => item.name === "AI_GATEWAY_API_KEY"),
    ).toMatchObject({ implicitReader: "@ai-sdk/gateway" });
    expect(
      result.envVars.find((item) => item.name === "BLOB_READ_WRITE_TOKEN"),
    ).toMatchObject({ implicitReader: "@vercel/blob" });
    expect(
      result.envVars.find((item) => item.name === "AUTH_SECRET")?.references,
    ).toEqual([
      { file: "app/api/auth/route.ts", line: 1 },
      { file: "auth.ts", line: 1 },
    ]);
    expect(
      result.findings.filter((item) => item.id.startsWith("env:test-only:")),
    ).toMatchObject([
      {
        subject: "E2E_TOKEN",
        evidence: [
          { location: { file: "e2e/other.ts" } },
          { location: { file: "tests/e2e/login.ts" } },
        ],
      },
      {
        subject: "PORT",
        evidence: [{ location: { file: "playwright.config.ts" } }],
      },
    ]);
  });
  it("ignores the automatically injected VERCEL_OIDC_TOKEN", async () => {
    const root = fixture("basic-ai-sdk");
    const result = await scanEnvVars(root, await detectProject(root), {
      trackedFiles: [],
    });
    expect(
      result.envVars.some((item) => item.name === "VERCEL_OIDC_TOKEN"),
    ).toBe(false);
    expect(
      result.findings.some((item) => item.subject === "VERCEL_OIDC_TOKEN"),
    ).toBe(false);
    expect(result.omittedSystemEnvVars).toContain("VERCEL_OIDC_TOKEN");
    expect(result.omittedSystemEnvVars).toContain("VERCEL_URL");
    expect(result.omittedSystemEnvVars).not.toContain("VERCEL_ENV");
  });

  it("finds AST references, example declarations, and t3 client exposure", async () => {
    const root = fixture("basic-ai-sdk");
    const result = await scanEnvVars(root, await detectProject(root), {
      trackedFiles: [],
    });
    expect(result.envVars).toEqual([
      {
        name: "AI_GATEWAY_API_KEY",
        references: [{ file: "src/app/api/chat/route.ts", line: 8 }],
        declaredIn: [],
        clientExposed: false,
        service: "Vercel AI Gateway",
      },
      {
        name: "ANTHROPIC_API_KEY",
        references: [{ file: "src/app/api/chat/route.ts", line: 7 }],
        declaredIn: [".env.example"],
        clientExposed: false,
        service: "Anthropic",
      },
      {
        name: "MODEL",
        references: [
          { file: "src/app/api/chat/route.ts", line: 9 },
          { file: "src/app/api/chat/route.ts", line: 15 },
        ],
        declaredIn: [],
        clientExposed: false,
        service: undefined,
      },
      {
        name: "NEXT_PUBLIC_ANALYTICS_ID",
        references: [{ file: "src/env.ts", line: 5 }],
        declaredIn: [".env.example", "src/env.ts"],
        clientExposed: true,
        service: undefined,
      },
      {
        name: "OPENAI_API_KEY",
        references: [
          { file: "src/app/api/chat/route.ts", line: 6 },
          { file: "src/env.ts", line: 4 },
          { file: "src/env.ts", line: 6 },
        ],
        declaredIn: [".env.example", "src/env.ts"],
        clientExposed: false,
        service: "OpenAI",
      },
      {
        name: "UNUSED_EXAMPLE",
        references: [],
        declaredIn: [".env.example"],
        clientExposed: false,
        service: undefined,
      },
    ]);
    expect(result.findings).toMatchObject([
      {
        subject: "TEST_ONLY_KEY",
        title: "Environment variable referenced only in tests",
        severity: "INFO",
      },
    ]);
    expect(result.limits).toEqual([
      "Dynamic environment variable access at src/dynamic.ts:2; name not inferred.",
    ]);
  });

  it("reports a tracked secret file by path without reading its contents", async () => {
    const root = fixture("leaky");
    const result = await scanEnvVars(root, await detectProject(root), {
      trackedFiles: [{ path: ".env", mode: "100644" }],
    });
    expect(result.envVars.map((item) => item.name)).toEqual([
      "NEXT_PUBLIC_STRIPE_SECRET",
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
    ]);
    expect(result.envVars[0]?.clientExposed).toBe(true);
    expect(result.envVars.map((item) => item.service)).toEqual([
      undefined,
      "Stripe",
      "Stripe",
    ]);
    expect(result.findings).toMatchObject([
      {
        rule: "V18",
        subject: ".env",
        severity: "CRITICAL",
        title: "Env file committed to repository",
      },
    ]);
    expect(
      verifyLiveRules({
        envVars: result.envVars,
        vercel: null,
        repoCommitSha: null,
      }).findings.find((item) => item.rule === "V4"),
    ).toMatchObject({
      subject: "NEXT_PUBLIC_STRIPE_SECRET",
      severity: "HIGH",
    });
    expect(JSON.stringify(result)).not.toContain("do-not-read");
  });

  it("keeps a tracked test fixture visible without a critical secret alert", async () => {
    const root = fixture("basic-ai-sdk");
    const result = await scanEnvVars(root, await detectProject(root), {
      trackedFiles: ["packages/lib/test/.env.test"],
    });
    expect(result.findings.find((item) => item.rule === "V18")).toMatchObject({
      subject: "packages/lib/test/.env.test",
      severity: "MEDIUM",
      title: "Test environment file committed to repository",
    });
  });

  it("does not flag a tracked env symlink as a committed env file", async () => {
    const root = fixture("basic-ai-sdk");
    const result = await scanEnvVars(root, await detectProject(root), {
      trackedFiles: [
        { path: "packages/prisma/.env", mode: "120000" },
        { path: "packages/lib/test/.env.test", mode: "100644" },
      ],
    });
    expect(result.findings.filter((item) => item.rule === "V18")).toMatchObject(
      [{ subject: "packages/lib/test/.env.test", severity: "MEDIUM" }],
    );
  });
});
