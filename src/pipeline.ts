import { execFile } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { basename } from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "./config.js";
import { loadModelRegistry } from "./enrich/modelRegistry.js";
import { buildOwnership, collectRepositoryRemote } from "./enrich/ownership.js";
import { loadStatusPages } from "./enrich/playbook.js";
import { scanCrons } from "./scanners/crons.js";
import { scanEnvVars } from "./scanners/envVars.js";
import { scanModels } from "./scanners/models.js";
import { detectProject } from "./scanners/project.js";
import { scanServices } from "./scanners/services.js";
import { scanWorkflows } from "./scanners/workflows.js";
import { handoffReportSchema } from "./schema.js";
import { renderJson } from "./render/json.js";
import { renderMarkdown } from "./render/markdown.js";
import type { Finding, HandoffReport, Verification } from "./types.js";
import { verifyLiveRules, verifyModelRules } from "./verify/rules.js";
import { createVercelClient, type VercelReadClient } from "./vercel/client.js";
import { collectVercel, VercelAuthError } from "./vercel/collect.js";
import { isSystemEnvName } from "./systemEnv.js";

export interface GenerateOptions {
  repo: string;
  out: string;
  offline: boolean;
  vercelProject?: string;
  vercelTeam?: string;
  format: "md" | "json" | "both";
  deprecationWindowDays?: number;
  avgInputTokens?: number;
  avgOutputTokens?: number;
  now?: Date;
  vercelClient?: VercelReadClient;
  registryFetch?: typeof fetch;
  registryCachePath?: string;
}

export class UsageError extends Error {}

const TOOL_VERSION = "0.1.0";
const execFileAsync = promisify(execFile);

async function readGitInfo(repoPath: string): Promise<{
  commitSha: string | null;
  branch: string | null;
}> {
  try {
    const [root, commit, branch] = await Promise.all([
      execFileAsync("git", ["-C", repoPath, "rev-parse", "--show-toplevel"]),
      execFileAsync("git", ["-C", repoPath, "rev-parse", "HEAD"]),
      execFileAsync("git", ["-C", repoPath, "branch", "--show-current"]),
    ]);
    if (resolve(root.stdout.trim()) !== repoPath)
      return { commitSha: null, branch: null };
    return {
      commitSha: commit.stdout.trim() || null,
      branch: branch.stdout.trim() || null,
    };
  } catch {
    return { commitSha: null, branch: null };
  }
}

export async function generate(
  options: GenerateOptions,
): Promise<HandoffReport> {
  const repoPath = resolve(options.repo);
  const outPath = resolve(options.out);
  try {
    if (!(await stat(repoPath)).isDirectory())
      throw new UsageError("Repository path must be a directory.");
  } catch (error) {
    if (error instanceof UsageError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new UsageError("Repository path does not exist.");
    throw error;
  }
  const config = await loadConfig(repoPath);

  if (options.vercelProject && !options.offline && !process.env.VERCEL_TOKEN)
    throw new UsageError("VERCEL_TOKEN is required with --vercel-project.");

  const projectInfo = await detectProject(repoPath, config.ignorePaths);
  const [envScan, modelScan, cronScan, workflowScan] = projectInfo.supported
    ? ([
        await scanEnvVars(repoPath, projectInfo, {
          ignoreEnvVars: config.ignoreEnvVars,
        }),
        await scanModels(repoPath, projectInfo, {
          modelOverrides: config.modelOverrides,
        }),
        await scanCrons(repoPath, projectInfo),
        await scanWorkflows(repoPath, projectInfo),
      ] as const)
    : [
        { envVars: [], omittedSystemEnvVars: [], findings: [], limits: [] },
        { models: [], findings: [], limits: [] },
        { crons: [], findings: [], limits: [] },
        { workflows: [], findings: [], limits: [] },
      ];
  const gitInfo = await readGitInfo(repoPath);
  const remote = await collectRepositoryRemote(repoPath);
  const serviceScan = projectInfo.supported
    ? await scanServices(repoPath, projectInfo, envScan.envVars)
    : { services: [], findings: [], limits: [] };
  let live = null;
  if (options.vercelProject && !options.offline) {
    try {
      live = await collectVercel(
        options.vercelClient ?? createVercelClient(process.env.VERCEL_TOKEN!),
        options.vercelProject,
        options.vercelTeam,
      );
    } catch (error) {
      if (error instanceof VercelAuthError) throw new UsageError(error.message);
      throw error;
    }
  }
  const liveRules = verifyLiveRules({
    envVars: envScan.envVars,
    vercel: live,
    repoCommitSha: gitInfo.commitSha,
    ignoreEnvVars: config.ignoreEnvVars,
  });
  const registryLoad = await loadModelRegistry({
    offline: options.offline,
    models: modelScan.models,
    ...(options.registryFetch ? { fetchImpl: options.registryFetch } : {}),
    ...(options.registryCachePath
      ? { cachePath: options.registryCachePath }
      : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  const registry = registryLoad.registry;
  const statusPages = await loadStatusPages();
  const modelRules = verifyModelRules({
    models: modelScan.models,
    registry,
    now: options.now ?? new Date(),
    deprecationWindowDays: options.deprecationWindowDays ?? 90,
  });
  const envVars = liveRules.envVars.map((item, index) => ({
    ...item,
    status: liveRules.envStatuses[index]!,
  }));
  const cronFindings: Finding[] = [];
  const crons = cronScan.crons.map((cron) => {
    const liveDefinitions = live?.project?.crons;
    const present = liveDefinitions?.some(
      (item) => item.path === cron.path && item.schedule === cron.schedule,
    );
    const status: Verification =
      !cron.routeFile || !cron.hasGetHandler
        ? "MISMATCH"
        : present === true
          ? "VERIFIED"
          : present === false
            ? "MISMATCH"
            : "UNVERIFIED";
    if (present === false)
      cronFindings.push({
        id: `cron:${cron.path}:missing-live`,
        rule: "V8",
        subject: cron.path,
        category: "cron",
        title: "Cron is absent from the live Vercel project",
        severity: "HIGH",
        verification: "MISMATCH",
        evidence: [
          { source: "repo", detail: `Configured schedule: ${cron.schedule}.` },
          { source: "vercel", detail: "No matching live cron definition." },
        ],
        action:
          "Deploy the cron configuration and confirm its path and schedule in Vercel.",
      });
    return {
      ...cron,
      ...(present !== undefined ? { liveOnVercel: present } : {}),
      status,
    };
  });
  const ownership = buildOwnership(
    config,
    serviceScan.services,
    live,
    remote,
    workflowScan.workflows,
    serviceScan.findings,
  );
  const unsupportedFinding: HandoffReport["findings"] = projectInfo.supported
    ? []
    : [
        {
          id: "service:unsupported-project",
          rule: null,
          subject: repoPath,
          category: "service",
          title: "Unsupported project type",
          severity: "CRITICAL",
          verification: "NOT_APPLICABLE",
          evidence: [
            {
              source: "repo",
              detail: "No JavaScript or TypeScript package.json found.",
            },
          ],
          action:
            "Use a JavaScript or TypeScript repository with package.json.",
        },
      ];
  const report: HandoffReport = {
    schemaVersion: 1,
    toolVersion: TOOL_VERSION,
    generatedAt: (options.now ?? new Date()).toISOString(),
    repo: { path: repoPath, ...gitInfo },
    vercel: {
      projectId: live?.project?.id ?? null,
      projectName: live?.project?.name ?? null,
      teamId: live?.team?.id ?? options.vercelTeam ?? null,
      accessed: !!live?.project,
      ...(live?.team?.plan ? { plan: live.team.plan } : {}),
    },
    coverage: {
      verified: [
        ...modelRules.statuses,
        ...envVars.map((item) => item.status),
        ...crons.map((item) => item.status),
      ].filter((status) => status === "VERIFIED").length,
      mismatch: [
        ...modelRules.statuses,
        ...envVars.map((item) => item.status),
        ...crons.map((item) => item.status),
      ].filter((status) => status === "MISMATCH").length,
      unverified: [
        ...modelRules.statuses,
        ...envVars.map((item) => item.status),
        ...crons.map((item) => item.status),
      ].filter((status) => status === "UNVERIFIED").length,
    },
    envVars,
    omittedSystemEnvVars: [
      ...new Set([
        ...envScan.omittedSystemEnvVars,
        ...(live?.envs ?? [])
          .filter((item) => isSystemEnvName(item.key))
          .map((item) => item.key),
      ]),
    ].sort(),
    models: modelScan.models,
    crons,
    workflows: workflowScan.workflows,
    services: serviceScan.services,
    ownership: ownership.items,
    findings: [
      ...unsupportedFinding,
      ...envScan.findings,
      ...modelScan.findings,
      ...modelRules.findings,
      ...liveRules.findings,
      ...cronScan.findings,
      ...cronFindings,
      ...workflowScan.findings,
      ...serviceScan.findings,
      ...ownership.findings,
    ].sort((a, b) => a.id.localeCompare(b.id)),
    limits: [
      ...envScan.limits,
      ...modelScan.limits,
      ...modelRules.limits,
      ...cronScan.limits,
      ...workflowScan.limits,
      ...serviceScan.limits,
      ...liveRules.limits,
      ...(live?.limits ?? []),
      ...registryLoad.limits,
      ...(!live?.project
        ? ["Live Vercel verification was not available."]
        : []),
      ...(live?.project && !gitInfo.commitSha
        ? [
            "Repository commit could not be determined; production commit comparison UNVERIFIED.",
          ]
        : []),
      ...(live?.deployment && !live.deployment.commitSha
        ? [
            "Production deployment commit SHA was not provided; commit comparison UNVERIFIED.",
          ]
        : []),
      ...(modelScan.models.length
        ? [
            "Actual spend not read; if the project uses Vercel AI Gateway, check its usage dashboard.",
          ]
        : []),
      ...(projectInfo.framework
        ? []
        : [
            "Next.js was not detected; framework-specific checks were skipped.",
          ]),
      ...projectInfo.nestedNextApps.map(
        (path) =>
          `Monorepo detected; Next.js app at ${path} was not scanned as the project root. Re-run with --repo ${path}.`,
      ),
    ],
  };
  const json = renderJson(report);
  const validated = handoffReportSchema.parse(JSON.parse(json) as unknown);
  await mkdir(outPath, { recursive: true });
  if (options.format === "json" || options.format === "both") {
    await writeFile(resolve(outPath, "handoff.json"), json);
  }
  if (options.format === "md" || options.format === "both") {
    const statuses = validated.models.map((model) => {
      const index = modelScan.models.findIndex(
        (item) =>
          item.location.file === model.location.file &&
          item.location.line === model.location.line &&
          item.modelId === model.modelId &&
          item.provider === model.provider,
      );
      return modelRules.statuses[index] ?? "UNVERIFIED";
    });
    await writeFile(
      resolve(outPath, "HANDOFF.md"),
      renderMarkdown(validated, {
        registry,
        modelStatuses: statuses,
        envStatuses: liveRules.envStatuses,
        projectName: basename(repoPath),
        avgInputTokens: options.avgInputTokens ?? 1000,
        avgOutputTokens: options.avgOutputTokens ?? 500,
        statusPages,
      }),
    );
  }
  return validated;
}
