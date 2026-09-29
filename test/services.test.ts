import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildOwnership, safeRemote } from "../src/enrich/ownership.js";
import { scanEnvVars } from "../src/scanners/envVars.js";
import { detectProject } from "../src/scanners/project.js";
import { scanServices } from "../src/scanners/services.js";
import { scanWorkflows } from "../src/scanners/workflows.js";
import type { VercelCollection } from "../src/vercel/collect.js";

describe("services and ownership", () => {
  it("keeps per-run workflow webhooks out of third-party handoff and handles Vercel domains", async () => {
    const root = resolve("test/fixtures/workflows-alias");
    const project = await detectProject(root);
    const workflows = (await scanWorkflows(root, project)).workflows;
    const serviceScan = await scanServices(root, project, []);
    expect(
      serviceScan.findings.filter((item) => item.category === "webhook"),
    ).toEqual([]);
    const live: VercelCollection = {
      project: {
        id: "prj_1",
        name: "demo",
        accountId: "team_1",
        framework: "nextjs",
      },
      envs: [],
      envsComplete: true,
      domains: [{ name: "demo.vercel.app", verified: true }],
      domainsComplete: true,
      deployment: null,
      deploymentChecked: true,
      team: null,
      limits: [],
    };
    const ownership = buildOwnership(
      {},
      [],
      live,
      null,
      workflows,
      serviceScan.findings,
    );
    expect(
      ownership.items.find((item) => item.key === "domain:demo.vercel.app")
        ?.action,
    ).toBe(
      "Vercel-provided domain; the client will likely add their own custom domain.",
    );
    expect(
      ownership.findings.find(
        (item) => item.id === "ownership:domain:demo.vercel.app",
      )?.severity,
    ).toBe("INFO");
    expect(
      ownership.items.find((item) => item.key === "workflow-webhook-domain")
        ?.action,
    ).toBe(
      "Pending runs hold webhook URLs on the current domain; changing the production domain may break runs waiting on these webhooks.",
    );
    expect(
      ownership.items.some((item) => item.key.startsWith("webhook:")),
    ).toBe(false);
  });
  it("detects service credentials and webhook routes from repository evidence", async () => {
    const root = resolve("test/fixtures/leaky");
    const project = await detectProject(root);
    const env = await scanEnvVars(root, project, { trackedFiles: [] });
    const result = await scanServices(root, project, [
      ...env.envVars,
      {
        name: "GOOGLE_CLIENT_ID",
        references: [],
        declaredIn: [".env.example"],
        clientExposed: false,
      },
    ]);
    expect(
      result.findings.some(
        (item) =>
          item.category === "webhook" && item.subject === "/api/webhook",
      ),
    ).toBe(true);
    expect(result.services.some((item) => item.service === "Stripe")).toBe(
      true,
    );
    expect(
      result.findings.some((item) => item.id === "oauth:GOOGLE_CLIENT_ID"),
    ).toBe(true);
  });

  it("strips remote credentials and honors ownership annotations", () => {
    expect(safeRemote("https://user:secret@github.com/acme/app.git")).toBe(
      "github.com/acme/app",
    );
    expect(safeRemote("git@github.com:acme/app.git")).toBe(
      "github.com/acme/app",
    );
    const result = buildOwnership(
      {
        ownership: {
          "service:OpenAI": "client",
          "git-repository": "consultancy",
        },
      },
      [
        {
          service: "OpenAI",
          category: "llm",
          envVars: ["OPENAI_API_KEY"],
          packages: [],
        },
      ],
      null,
      "github.com/acme/app",
      [],
      [],
    );
    expect(
      result.items.find((item) => item.key === "service:OpenAI")?.owner,
    ).toBe("client");
    expect(
      result.findings.find((item) => item.id === "ownership:git-repository")
        ?.severity,
    ).toBe("HIGH");
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("lists live team and domains alongside webhook and OAuth handoff items", () => {
    const live: VercelCollection = {
      project: {
        id: "prj_1",
        name: "demo",
        accountId: "team_1",
        framework: "nextjs",
      },
      envs: [],
      envsComplete: true,
      domains: [{ name: "app.example.com", verified: true }],
      domainsComplete: true,
      deployment: null,
      deploymentChecked: true,
      team: { id: "team_1", name: "Agency", slug: "agency" },
      limits: [],
    };
    const result = buildOwnership(
      {},
      [],
      live,
      null,
      [],
      [
        {
          id: "webhook:route.ts",
          rule: null,
          subject: "/webhook",
          category: "webhook",
          title: "Webhook receiver",
          severity: "MEDIUM",
          verification: "UNVERIFIED",
          evidence: [],
        },
        {
          id: "oauth:GOOGLE_CLIENT_ID",
          rule: null,
          subject: "GOOGLE_CLIENT_ID",
          category: "oauth",
          title: "OAuth app",
          severity: "MEDIUM",
          verification: "UNVERIFIED",
          evidence: [],
        },
      ],
    );
    expect(result.items.map((item) => item.key)).toEqual([
      "domain:app.example.com",
      "oauth:GOOGLE_CLIENT_ID",
      "vercel-team",
      "webhook:route.ts",
    ]);
  });
});
