import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HandoffConfig } from "../config.js";
import type {
  Finding,
  OwnershipRecord,
  ServiceRecord,
  WorkflowRecord,
} from "../types.js";
import type { VercelCollection } from "../vercel/collect.js";

const execFileAsync = promisify(execFile);

export interface OwnershipResult {
  items: OwnershipRecord[];
  findings: Finding[];
}

export function safeRemote(remote: string): string | null {
  const trimmed = remote.trim();
  try {
    const url = new URL(trimmed);
    const parts = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
    return url.hostname && parts ? `${url.hostname}/${parts}` : null;
  } catch {
    const match = /^(?:[^@\s]+@)?([^:\s]+):([^\s]+)$/.exec(trimmed);
    return match ? `${match[1]}/${match[2]!.replace(/\.git$/, "")}` : null;
  }
}

export async function collectRepositoryRemote(
  repo: string,
): Promise<string | null> {
  try {
    const result = await execFileAsync("git", [
      "-C",
      repo,
      "remote",
      "get-url",
      "origin",
    ]);
    return safeRemote(result.stdout);
  } catch {
    return null;
  }
}

export function buildOwnership(
  config: HandoffConfig,
  services: ServiceRecord[],
  live: VercelCollection | null,
  remote: string | null,
  workflows: WorkflowRecord[],
  otherFindings: Finding[],
): OwnershipResult {
  const items: OwnershipRecord[] = [];
  const explicit = config.ownership ?? {};
  function add(
    key: string,
    item: string,
    action: string,
    alternateKeys: string[] = [],
  ): void {
    const owner =
      [key, ...alternateKeys].map((name) => explicit[name]).find(Boolean) ??
      "unknown";
    items.push({ key, item, owner, action });
  }
  if (live?.project) {
    const teamName =
      live.team?.name ?? live.team?.slug ?? live.project.accountId;
    add(
      "vercel-team",
      `Vercel project ${live.project.name} in team ${teamName}`,
      "Transfer the project to the client's team or confirm the client will own this team.",
    );
  }
  for (const service of services.filter((item) => item.envVars.length)) {
    add(
      `service:${service.service}`,
      `${service.service} credentials (${service.envVars.join(", ")})`,
      "Confirm the account belongs to the client. After transfer, rotate the keys.",
      service.envVars,
    );
  }
  for (const domain of live?.domains ?? []) {
    add(
      `domain:${domain.name}`,
      `Domain ${domain.name}`,
      domain.name.endsWith(".vercel.app")
        ? "Vercel-provided domain; the client will likely add their own custom domain."
        : "Confirm the client controls the registrar and DNS.",
    );
  }
  if (remote)
    add(
      "git-repository",
      `Git repository ${remote}`,
      "Transfer the repository to the client's organization or grant admin access.",
    );
  for (const finding of otherFindings.filter(
    (item) => item.category === "webhook" || item.category === "oauth",
  )) {
    add(
      finding.id,
      finding.title,
      finding.action ??
        "Confirm ownership and update the production configuration.",
    );
  }
  if (workflows.length)
    add(
      "workflows",
      "Durable workflows",
      "In-flight runs will continue after handoff and use credentials configured at resume time; plan credential rotation deliberately.",
    );
  if (
    workflows.some((workflow) =>
      workflow.hooks.some((hook) => hook.kind === "createWebhook"),
    )
  )
    add(
      "workflow-webhook-domain",
      "Workflow webhook URLs",
      "Pending runs hold webhook URLs on the current domain; changing the production domain may break runs waiting on these webhooks.",
    );
  const findings: Finding[] = items.map((item) => ({
    id: `ownership:${item.key}`,
    rule: null,
    subject: item.item,
    category: "ownership",
    title: `Ownership: ${item.item}`,
    severity:
      item.key.startsWith("domain:") && item.key.endsWith(".vercel.app")
        ? "INFO"
        : item.owner === "consultancy"
          ? "HIGH"
          : item.owner === "unknown"
            ? "MEDIUM"
            : "INFO",
    verification: item.owner === "unknown" ? "UNVERIFIED" : "NOT_APPLICABLE",
    evidence: [
      {
        source: config.ownership?.[item.key] ? "config" : "repo",
        detail: `Owner: ${item.owner}.`,
      },
    ],
    action: item.action,
  }));
  return {
    items: items.sort((a, b) => a.key.localeCompare(b.key)),
    findings: findings.sort((a, b) => a.id.localeCompare(b.id)),
  };
}
