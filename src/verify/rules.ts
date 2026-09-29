import type {
  EnvVarRecord,
  Finding,
  ModelRecord,
  Verification,
} from "../types.js";
import { findModel, type ModelRegistry } from "../enrich/modelRegistry.js";
import type { VercelCollection } from "../vercel/collect.js";
import { isSystemEnvName } from "../systemEnv.js";

export interface ModelRuleContext {
  models: ModelRecord[];
  registry: ModelRegistry;
  now: Date;
  deprecationWindowDays: number;
}

export interface ModelRuleResult {
  findings: Finding[];
  statuses: Verification[];
  limits: string[];
}

export function verifyModelRules(ctx: ModelRuleContext): ModelRuleResult {
  const findings: Finding[] = [];
  const statuses: Verification[] = [];
  const limits: string[] = [];
  const today = Date.UTC(
    ctx.now.getUTCFullYear(),
    ctx.now.getUTCMonth(),
    ctx.now.getUTCDate(),
  );
  for (const model of ctx.models) {
    const location = model.location;
    const id = `model:${model.provider}/${model.modelId ?? "dynamic"}:${location.file}:${location.line}`;
    const evidence: Finding["evidence"] = [
      {
        source: "repo",
        detail: `Model ${model.declaredOnly ? "declaration" : "call"} at ${location.file}:${location.line}`,
        location,
      },
    ];
    function finding(
      rule: string | null,
      title: string,
      severity: Finding["severity"],
      verification: Verification,
      action: string,
    ): void {
      findings.push({
        id,
        rule,
        subject: model.modelId ?? "<dynamic>",
        category: "model",
        title,
        severity,
        verification,
        evidence: [...evidence],
        action,
      });
    }
    if (model.configuredViaEnv) {
      statuses.push("UNVERIFIED");
      finding(
        "V14",
        "Production model ID comes from an unread environment variable",
        "MEDIUM",
        "UNVERIFIED",
        `Confirm the production value of ${model.configuredViaEnv} in Vercel without exposing it.`,
      );
      continue;
    }
    if (!model.modelId) {
      statuses.push("UNVERIFIED");
      finding(
        "V14",
        "Dynamic model ID; verify manually",
        "MEDIUM",
        "UNVERIFIED",
        "Resolve the model ID used at this call site.",
      );
      continue;
    }
    const entry = findModel(ctx.registry, model.provider, model.modelId);
    if (!entry) {
      statuses.push("UNVERIFIED");
      finding(
        "V13",
        "Model ID not found in registry",
        "MEDIUM",
        "UNVERIFIED",
        "Confirm the model ID and lifecycle with the provider.",
      );
      continue;
    }
    evidence.push({
      source: "registry",
      detail: `${entry.status} in bundled registry; source: ${entry.source}`,
    });
    if (entry.status === "retired") {
      statuses.push("VERIFIED");
      finding(
        "V9",
        `Model retired${entry.retirementDate ? ` on ${entry.retirementDate}` : ""}`,
        "CRITICAL",
        "VERIFIED",
        `Replace ${model.modelId}${entry.replacement ? ` with ${entry.replacement}` : ""} and re-test prompts.`,
      );
      continue;
    }
    if (entry.status === "deprecated") {
      const date = entry.retirementDate
        ? Date.parse(`${entry.retirementDate}T00:00:00Z`)
        : NaN;
      if (!Number.isFinite(date) || date < today) {
        statuses.push("UNVERIFIED");
        limits.push(
          `Retirement state for ${model.provider}/${model.modelId} could not be confirmed from bundled data.`,
        );
        finding(
          null,
          "Deprecated model has an unconfirmed retirement state",
          "MEDIUM",
          "UNVERIFIED",
          "Check the provider's current deprecation page before changing this model.",
        );
        continue;
      }
      statuses.push("VERIFIED");
      const days = Math.ceil((date - today) / 86400000);
      if (days <= ctx.deprecationWindowDays)
        finding(
          "V10",
          `Model retires on ${entry.retirementDate}`,
          "HIGH",
          "VERIFIED",
          `Replace ${model.modelId}${entry.replacement ? ` with ${entry.replacement}` : ""} before ${entry.retirementDate}.`,
        );
      else
        finding(
          "V11",
          `Model deprecated; retires on ${entry.retirementDate}`,
          "MEDIUM",
          "VERIFIED",
          `Plan migration from ${model.modelId} before ${entry.retirementDate}.`,
        );
      continue;
    }
    statuses.push("VERIFIED");
    if (entry.status === "legacy")
      finding(
        "V11",
        "Legacy model",
        "MEDIUM",
        "VERIFIED",
        `Plan migration from ${model.modelId} to a supported model.`,
      );
    // V12 active models appear as verified table rows; they are not findings.
  }
  return {
    findings: findings.sort((a, b) => a.id.localeCompare(b.id)),
    statuses,
    limits: limits.sort(),
  };
}

export interface LiveRuleContext {
  envVars: EnvVarRecord[];
  vercel: VercelCollection | null;
  repoCommitSha: string | null;
  ignoreEnvVars?: string[];
}

export interface LiveRuleResult {
  envVars: EnvVarRecord[];
  envStatuses: Verification[];
  findings: Finding[];
  limits: string[];
}

const secretLike = /(SECRET|PRIVATE|PASSWORD|TOKEN|_KEY$)/;
const publishableKey = /^NEXT_PUBLIC_.*(?:PUBLISHABLE|PUBLIC)_KEY$/;
const sensitiveMarker = /(SECRET|PRIVATE|PASSWORD|TOKEN)/;
const publishableNames = new Set([
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "NEXT_PUBLIC_SENTRY_DSN",
]);

export function verifyLiveRules(ctx: LiveRuleContext): LiveRuleResult {
  const findings: Finding[] = [];
  const limits: string[] = [];
  const live = ctx.vercel;
  const envByName = new Map<string, NonNullable<typeof live>["envs"]>();
  for (const env of live?.envs ?? []) {
    if (isSystemEnvName(env.key) || ctx.ignoreEnvVars?.includes(env.key))
      continue;
    const rows = envByName.get(env.key) ?? [];
    rows.push(env);
    envByName.set(env.key, rows);
  }
  const repoRecords = new Map(ctx.envVars.map((item) => [item.name, item]));
  const envVars = ctx.envVars.map((item) => {
    const liveRows = envByName.get(item.name) ?? [];
    const targets = [...new Set(liveRows.flatMap((row) => row.target))].sort();
    return {
      ...item,
      ...(liveRows.length
        ? { vercelTargets: targets, vercelType: liveRows[0]!.type }
        : {}),
    };
  });
  const envStatuses: Verification[] = envVars.map((item) => {
    const liveRows = envByName.get(item.name) ?? [];
    if (
      liveRows.some(
        (row) => row.target.includes("production") && !row.gitBranch,
      )
    )
      return "VERIFIED";
    if (liveRows.length && !item.references.length) return "VERIFIED";
    if (!live?.envsComplete || !item.references.length) return "UNVERIFIED";
    findings.push({
      id: `env:${item.name}:missing-production`,
      rule: "V1",
      subject: item.name,
      category: "env",
      title: "Environment variable missing from Vercel production",
      severity: "CRITICAL",
      verification: "MISMATCH",
      evidence: [
        ...item.references.map((location) => ({
          source: "repo" as const,
          detail: "Referenced in production code",
          location,
        })),
        { source: "vercel", detail: "Not found in production target" },
      ],
      action: `Add ${item.name} to the Vercel production environment.`,
    });
    return "MISMATCH";
  });
  for (const item of envVars) {
    const liveRows = envByName.get(item.name) ?? [];
    if (
      item.clientExposed &&
      item.references.length > 0 &&
      secretLike.test(item.name) &&
      !(
        !sensitiveMarker.test(item.name) &&
        (publishableKey.test(item.name) || publishableNames.has(item.name))
      )
    )
      findings.push({
        id: `env:${item.name}:client-exposed-secret`,
        rule: "V4",
        subject: item.name,
        category: "env",
        title: "Secret-like environment variable is client-exposed",
        severity: "HIGH",
        verification: liveRows.length ? "VERIFIED" : "UNVERIFIED",
        evidence: [
          {
            source: "repo",
            detail:
              "Client-exposed variable name matches a secret-like pattern.",
            ...(item.references[0] ? { location: item.references[0] } : {}),
          },
          ...(liveRows.length
            ? [
                {
                  source: "vercel" as const,
                  detail: "Variable metadata is present in Vercel.",
                },
              ]
            : []),
        ],
        action: `Remove ${item.name} from the client bundle if it contains a secret; rotate the credential.`,
      });
    if (
      !item.references.length &&
      item.declaredIn.some((file) => file.split("/").at(-1) === ".env.example")
    )
      findings.push({
        id: `env:${item.name}:unused-example`,
        rule: "V6",
        subject: item.name,
        category: "env",
        title:
          "Environment variable is declared in .env.example but not referenced",
        severity: "INFO",
        verification: "NOT_APPLICABLE",
        evidence: item.declaredIn
          .filter((file) => file.endsWith(".env.example"))
          .map((file) => ({
            source: "repo" as const,
            detail: `Declared in ${file}.`,
          })),
        action: `Confirm whether ${item.name} is still required; remove stale example entries.`,
      });
  }
  for (const [name, rows] of envByName) {
    if (repoRecords.get(name)?.references.length) continue;
    const targets = [...new Set(rows.flatMap((row) => row.target))].sort();
    if (!repoRecords.has(name)) {
      envVars.push({
        name,
        references: [],
        declaredIn: [],
        clientExposed: name.startsWith("NEXT_PUBLIC_"),
        vercelTargets: targets,
        vercelType: rows[0]!.type,
      });
      envStatuses.push("VERIFIED");
    }
    findings.push({
      id: `env:${name}:orphan`,
      rule: "V3",
      subject: name,
      category: "env",
      title: "Possibly orphaned Vercel environment variable",
      severity: "INFO",
      verification: "VERIFIED",
      evidence: [
        {
          source: "vercel",
          detail: `Present for ${targets.join(", ") || "unknown"} target; no repository reference found`,
        },
      ],
      action: `Confirm whether ${name} is still needed before removing it.`,
    });
  }
  for (const [name, rows] of envByName) {
    if (!secretLike.test(name) || !rows.some((row) => row.type === "plain"))
      continue;
    findings.push({
      id: `env:${name}:plain-secret`,
      rule: "V5",
      subject: name,
      category: "env",
      title: "Secret-like environment variable is stored as plain text",
      severity: "MEDIUM",
      verification: "VERIFIED",
      evidence: [
        {
          source: "vercel",
          detail: "Vercel environment variable type is plain.",
        },
      ],
      action: `Store ${name} as an encrypted or sensitive Vercel environment variable and rotate it if needed.`,
    });
  }
  if (live?.domains) {
    for (const domain of live.domains.filter((item) => !item.verified))
      findings.push({
        id: `domain:${domain.name}`,
        rule: "V16",
        subject: domain.name,
        category: "domain",
        title: "Domain attached to Vercel project but not verified",
        severity: "HIGH",
        verification: "MISMATCH",
        evidence: [{ source: "vercel", detail: "Domain verified=false" }],
        action: `Complete Vercel domain verification for ${domain.name}.`,
      });
  }
  if (live?.project?.productionProtectionEnabled === false)
    findings.push({
      id: "protection:production-disabled",
      rule: "V15",
      subject: "production-deployment",
      category: "protection",
      title: "Production deployment protection is disabled",
      severity: "INFO",
      verification: "VERIFIED",
      evidence: [
        {
          source: "vercel",
          detail:
            "Project password, SSO, and trusted IP protection are disabled for production.",
        },
      ],
      action: "Confirm that public access to production is intentional.",
    });
  else if (
    live?.project &&
    live.project.productionProtectionEnabled === undefined
  )
    limits.push(
      "Production deployment protection settings were not exposed; V15 UNVERIFIED.",
    );
  if (
    live?.deployment?.commitSha &&
    ctx.repoCommitSha &&
    live.deployment.commitSha !== ctx.repoCommitSha
  )
    findings.push({
      id: "protection:production-commit",
      rule: "V17",
      subject: "production-commit",
      category: "protection",
      title: "Report describes a commit that is not in production",
      severity: "MEDIUM",
      verification: "MISMATCH",
      evidence: [
        { source: "repo", detail: `Scanned commit ${ctx.repoCommitSha}` },
        {
          source: "vercel",
          detail: `Production commit ${live.deployment.commitSha}`,
        },
      ],
      action:
        "Deploy the scanned commit or regenerate this report from the production commit.",
    });
  const ordered = envVars
    .map((item, index) => ({ item, status: envStatuses[index]! }))
    .sort((a, b) => a.item.name.localeCompare(b.item.name));
  return {
    envVars: ordered.map((entry) => entry.item),
    envStatuses: ordered.map((entry) => entry.status),
    findings: findings.sort((a, b) => a.id.localeCompare(b.id)),
    limits,
  };
}
