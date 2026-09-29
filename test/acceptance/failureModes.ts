import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { promisify } from "node:util";
import { handoffReportSchema } from "../../src/schema.js";
import { generate } from "../../src/pipeline.js";
import type { VercelReadClient } from "../../src/vercel/client.js";

const execFileAsync = promisify(execFile);
type Case = { name: string; result: "PASS" | "FAIL" | "SKIP"; detail: string };

async function run(
  name: string,
  repo: string,
  args: string[],
  check: (
    code: number,
    stdout: string,
    stderr: string,
    report: unknown,
  ) => boolean,
  token?: string,
): Promise<Case> {
  const out = await mkdtemp(join(tmpdir(), "handoff-failure-modes-"));
  try {
    const startedAt = performance.now();
    let code = 0;
    let stdout = "";
    let stderr = "";
    const env = { ...process.env };
    if (token === undefined) delete env.VERCEL_TOKEN;
    else env.VERCEL_TOKEN = token;
    try {
      const result = await execFileAsync(
        process.execPath,
        [
          resolve("dist/cli.js"),
          "generate",
          "--repo",
          repo,
          "--out",
          out,
          "--format",
          "json",
          ...args,
        ],
        { env, timeout: 30000 },
      );
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error) {
      const failure = error as Error & {
        code?: number;
        stdout?: string;
        stderr?: string;
      };
      code = typeof failure.code === "number" ? failure.code : 3;
      stdout = failure.stdout ?? "";
      stderr = failure.stderr ?? failure.message;
    }
    let report: unknown = null;
    try {
      report = handoffReportSchema.parse(
        JSON.parse(
          await readFile(join(out, "handoff.json"), "utf8"),
        ) as unknown,
      );
    } catch {
      /* A usage error intentionally has no report. */
    }
    return {
      name,
      result: check(code, stdout, stderr, report) ? "PASS" : "FAIL",
      detail:
        name === "Large repo"
          ? `exit ${code}; ${((performance.now() - startedAt) / 1000).toFixed(2)} s`
          : `exit ${code}`,
    };
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

async function partialPermissions(repo: string): Promise<Case> {
  const out = await mkdtemp(join(tmpdir(), "handoff-permissions-"));
  const prior = process.env.VERCEL_TOKEN;
  process.env.VERCEL_TOKEN = "mock-token";
  const client: VercelReadClient = {
    project: async () => ({
      id: "prj_1",
      name: "demo",
      accountId: "team_1",
      framework: "nextjs",
    }),
    envs: async () => ({ items: [], next: null, complete: true }),
    domains: async () => {
      throw { statusCode: 403 };
    },
    productionDeployment: async () => null,
    team: async () => ({ id: "team_1", name: "Demo", slug: "demo" }),
  };
  try {
    const report = await generate({
      repo,
      out,
      offline: false,
      vercelProject: "demo",
      vercelClient: client,
      format: "json",
    });
    const pass =
      report.vercel.accessed &&
      report.limits.some((item) => item.includes("cannot read domains")) &&
      !report.findings.some((item) => item.rule === "V16");
    return {
      name: "Partial permissions",
      result: pass ? "PASS" : "FAIL",
      detail: "mocked domains 403",
    };
  } catch (error) {
    return {
      name: "Partial permissions",
      result: "FAIL",
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (prior === undefined) delete process.env.VERCEL_TOKEN;
    else process.env.VERCEL_TOKEN = prior;
    await rm(out, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const cases: Case[] = [];
  const basic = resolve("test/fixtures/basic-ai-sdk");
  cases.push(
    await run(
      "Offline",
      basic,
      ["--offline"],
      (code, _stdout, _stderr, raw) => {
        const report = handoffReportSchema.safeParse(raw);
        return (
          [0, 1].includes(code) &&
          report.success &&
          !report.data.vercel.accessed &&
          report.data.envVars.every((row) => row.status === "UNVERIFIED")
        );
      },
    ),
  );
  cases.push(
    await run(
      "No token",
      basic,
      ["--vercel-project", "demo"],
      (code, _stdout, stderr) => code === 2 && stderr.includes("VERCEL_TOKEN"),
    ),
  );
  cases.push(
    await run(
      "Non-Next.js JS repo",
      resolve("."),
      ["--offline"],
      (code, _stdout, _stderr, raw) => {
        const report = handoffReportSchema.safeParse(raw);
        return (
          [0, 1].includes(code) &&
          report.success &&
          report.data.limits.some((item) =>
            item.includes("Next.js was not detected"),
          )
        );
      },
    ),
  );
  cases.push(
    await run(
      "Python repo",
      resolve("test/fixtures/unsupported"),
      ["--offline"],
      (code, _stdout, _stderr, raw) => {
        const report = handoffReportSchema.safeParse(raw);
        return (
          code === 1 &&
          report.success &&
          report.data.findings.some(
            (item) => item.title === "Unsupported project type",
          )
        );
      },
    ),
  );
  if (process.env.VERCEL_PROJECT) {
    cases.push(
      await run(
        "Bad token",
        basic,
        ["--vercel-project", process.env.VERCEL_PROJECT],
        (code, _stdout, stderr, raw) => {
          const report = handoffReportSchema.safeParse(raw);
          return (
            (code === 2 && stderr.includes("authentication")) ||
            (report.success &&
              report.data.limits.some((item) =>
                item.includes("authentication"),
              ))
          );
        },
        "invalid",
      ),
    );
    if (process.env.VERCEL_TOKEN && process.env.WRONG_VERCEL_TEAM)
      cases.push(
        await run(
          "Wrong team",
          basic,
          [
            "--vercel-project",
            process.env.VERCEL_PROJECT,
            "--vercel-team",
            process.env.WRONG_VERCEL_TEAM,
          ],
          (code, _stdout, _stderr, raw) => {
            const report = handoffReportSchema.safeParse(raw);
            return (
              code !== 3 &&
              report.success &&
              report.data.limits.some((item) => item.includes("project")) &&
              report.data.envVars.every((row) => row.status === "UNVERIFIED")
            );
          },
          process.env.VERCEL_TOKEN,
        ),
      );
    else
      cases.push({
        name: "Wrong team",
        result: "SKIP",
        detail: "Set VERCEL_TOKEN and WRONG_VERCEL_TEAM.",
      });
    if (process.env.VERCEL_TOKEN)
      cases.push(
        await run(
          "Valid token and project",
          resolve(process.env.VERCEL_REPO ?? basic),
          ["--vercel-project", process.env.VERCEL_PROJECT],
          (code, _stdout, _stderr, raw) => {
            const report = handoffReportSchema.safeParse(raw);
            return (
              [0, 1].includes(code) &&
              report.success &&
              report.data.vercel.accessed &&
              report.data.vercel.projectName === process.env.VERCEL_PROJECT
            );
          },
          process.env.VERCEL_TOKEN,
        ),
      );
    else
      cases.push({
        name: "Valid token and project",
        result: "SKIP",
        detail: "Set VERCEL_TOKEN.",
      });
  } else {
    cases.push({
      name: "Bad token",
      result: "SKIP",
      detail: "Set VERCEL_PROJECT.",
    });
    cases.push({
      name: "Wrong team",
      result: "SKIP",
      detail: "Set VERCEL_PROJECT, VERCEL_TOKEN, and WRONG_VERCEL_TEAM.",
    });
    cases.push({
      name: "Valid token and project",
      result: "SKIP",
      detail: "Set VERCEL_PROJECT and VERCEL_TOKEN.",
    });
  }
  cases.push(await partialPermissions(basic));
  if (process.env.LARGE_REPO)
    cases.push(
      await run(
        "Large repo",
        resolve(process.env.LARGE_REPO),
        ["--offline"],
        (code) => [0, 1].includes(code),
      ),
    );
  else
    cases.push({
      name: "Large repo",
      result: "SKIP",
      detail: "Set LARGE_REPO to a local Next.js checkout.",
    });
  process.stdout.write("Case | Result | Detail\n--- | --- | ---\n");
  for (const item of cases)
    process.stdout.write(`${item.name} | ${item.result} | ${item.detail}\n`);
  if (cases.some((item) => item.result === "FAIL")) process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 2;
});
