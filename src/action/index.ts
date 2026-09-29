import {
  appendFile,
  copyFile,
  mkdtemp,
  readFile,
  rm,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { diffReports } from "./diff.js";
import { GitHubClient } from "./github.js";
import { modelCost } from "../enrich/cost.js";
import { findModel, loadModelRegistry } from "../enrich/modelRegistry.js";
import { generate } from "../pipeline.js";
import { handoffReportSchema } from "../schema.js";
import type { HandoffReport } from "../types.js";

function input(name: string): string {
  return (
    process.env[`INPUT_${name.toUpperCase()}`] ??
    process.env[`INPUT_${name.toUpperCase().replaceAll("-", "_")}`] ??
    ""
  ).trim();
}

async function priorReport(path: string): Promise<HandoffReport | null> {
  try {
    return handoffReportSchema.parse(
      JSON.parse(await readFile(path, "utf8")) as unknown,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeOutput(name: string, value: string): Promise<void> {
  if (process.env.GITHUB_OUTPUT)
    await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

async function createIssues(
  client: GitHubClient,
  report: HandoffReport,
  offline: boolean,
): Promise<void> {
  const { registry } = await loadModelRegistry({
    offline,
    models: report.models,
  });
  const seen = new Set<string>();
  for (const finding of report.findings.filter(
    (item) => item.rule === "V9" || item.rule === "V10",
  )) {
    const model = report.models.find(
      (item) =>
        item.modelId === finding.subject &&
        finding.evidence.some(
          (evidence) =>
            evidence.location?.file === item.location.file &&
            evidence.location.line === item.location.line,
        ),
    );
    if (!model || !model.modelId) continue;
    const key = `${model.provider}/${model.modelId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = findModel(registry, model.provider, model.modelId);
    if (!entry) continue;
    const matches = report.models.filter(
      (item) =>
        item.provider === model.provider && item.modelId === model.modelId,
    );
    const title = `Model ${key} retires on ${entry.retirementDate ?? "unknown date"}`;
    const cost = modelCost(model, registry, {
      avgInputTokens: 1000,
      avgOutputTokens: 500,
    });
    const days = entry.retirementDate
      ? Math.ceil(
          (Date.parse(`${entry.retirementDate}T00:00:00Z`) - Date.now()) /
            86_400_000,
        )
      : null;
    const body = [
      `${model.modelId} is used in ${matches.length} place(s):`,
      ...matches.map((item) => `- ${item.location.file}:${item.location.line}`),
      "",
      `Status: ${entry.status} · Retirement date: ${entry.retirementDate ?? "unknown"}${days === null ? "" : ` (${days} days from now)`}`,
      `Suggested replacement: ${entry.replacement ?? "none listed"}`,
      `Estimated cost: ${cost.replacement ?? `${cost.label} per 1,000 requests`} (assumptions: 1,000 input and 500 output tokens per request)`,
      `Source: ${entry.source}`,
      "",
      "Test prompts against the replacement before switching.",
    ].join("\n");
    const url = await client.openDeprecationIssue(title, body);
    process.stdout.write(`Deprecation issue: ${url}\n`);
  }
}

async function main(): Promise<void> {
  const mode = input("mode") || "pr";
  if (!["report", "pr", "issue"].includes(mode))
    throw new Error("mode must be report, pr, or issue.");
  const workspace = process.env.GITHUB_WORKSPACE;
  if (!workspace) throw new Error("GITHUB_WORKSPACE is required.");
  const project = input("vercel-project");
  const token = input("vercel-token");
  if (project && !token)
    throw new Error("vercel-token is required with vercel-project.");
  if (token) process.env.VERCEL_TOKEN = token;
  const windowDays = Number(input("deprecation-window-days") || "90");
  if (!Number.isSafeInteger(windowDays) || windowDays < 0)
    throw new Error("deprecation-window-days must be a nonnegative integer.");
  const out = await mkdtemp(join(tmpdir(), "handoff-pack-action-"));
  try {
    const report = await generate({
      repo: workspace,
      out,
      offline: !project,
      ...(project ? { vercelProject: project } : {}),
      ...(input("vercel-team") ? { vercelTeam: input("vercel-team") } : {}),
      deprecationWindowDays: windowDays,
      format: "both",
    });
    const destination = resolve(workspace, "handoff");
    const prior = await priorReport(join(destination, "handoff.json"));
    const summary = prior ? diffReports(prior, report) : "Initial runbook.\n";
    process.stdout.write(summary);
    await writeOutput(
      "changed",
      prior ? String(summary !== "No report changes.\n") : "true",
    );
    if (mode === "report") {
      await mkdir(destination, { recursive: true });
      await Promise.all(
        ["HANDOFF.md", "handoff.json"].map((file) =>
          copyFile(join(out, file), join(destination, file)),
        ),
      );
      return;
    }
    const githubToken = process.env.GITHUB_TOKEN;
    const repository = process.env.GITHUB_REPOSITORY;
    if (!githubToken || !repository)
      throw new Error(
        "GITHUB_TOKEN and GITHUB_REPOSITORY are required for PR or issue mode.",
      );
    const github = new GitHubClient(repository, githubToken);
    if (mode === "pr" && (!prior || summary !== "No report changes.\n")) {
      const files = await Promise.all(
        ["HANDOFF.md", "handoff.json"].map(async (file) => ({
          path: `handoff/${file}`,
          content: await readFile(join(out, file), "utf8"),
        })),
      );
      const pull = await github.upsertRunbookPull(
        files,
        summary,
        new Date().toISOString().slice(0, 10).replaceAll("-", ""),
      );
      process.stdout.write(`Runbook PR: ${pull.html_url}\n`);
      await writeOutput("pull-request-url", pull.html_url);
    }
    await createIssues(github, report, !project);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
