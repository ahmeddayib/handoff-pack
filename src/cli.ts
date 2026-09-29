#!/usr/bin/env node
import { Command, InvalidArgumentError } from "commander";
import { readFile } from "node:fs/promises";
import { ZodError } from "zod";
import { diffReports } from "./action/diff.js";
import { generate, UsageError } from "./pipeline.js";
import { handoffReportSchema } from "./schema.js";

function nonnegativeInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new InvalidArgumentError("Expected a nonnegative integer.");
  return parsed;
}

const program = new Command();
program
  .name("handoff-pack")
  .description("Generate an operating runbook for a Vercel AI app.");
program
  .command("generate")
  .option("--repo <path>", "repository root", ".")
  .option("--vercel-project <idOrName>", "Vercel project ID or name")
  .option("--vercel-team <teamId>", "Vercel team ID")
  .option("--out <dir>", "output directory", "./handoff")
  .option("--offline", "skip network calls")
  .option(
    "--avg-input-tokens <n>",
    "average input tokens",
    nonnegativeInteger,
    1000,
  )
  .option(
    "--avg-output-tokens <n>",
    "average output tokens",
    nonnegativeInteger,
    500,
  )
  .option(
    "--deprecation-window <days>",
    "deprecation window in days",
    nonnegativeInteger,
    90,
  )
  .option("--format <format>", "md, json, or both", "both")
  .option("--verbose", "print additional details")
  .action(
    async (options: {
      repo: string;
      vercelProject?: string;
      vercelTeam?: string;
      out: string;
      offline: boolean;
      format: string;
      deprecationWindow: number;
      avgInputTokens: number;
      avgOutputTokens: number;
      verbose: boolean;
    }) => {
      try {
        if (!["md", "json", "both"].includes(options.format))
          throw new UsageError("--format must be md, json, or both.");
        const report = await generate({
          repo: options.repo,
          out: options.out,
          offline: options.offline ?? false,
          vercelProject: options.vercelProject,
          vercelTeam: options.vercelTeam,
          format: options.format as "md" | "json" | "both",
          deprecationWindowDays: options.deprecationWindow,
          avgInputTokens: options.avgInputTokens,
          avgOutputTokens: options.avgOutputTokens,
        });
        process.stdout.write(`Wrote report for ${report.repo.path}\n`);
        if (options.verbose)
          process.stderr.write(
            `Findings: ${report.findings.length}; coverage: ${report.coverage.verified} verified, ${report.coverage.mismatch} mismatched, ${report.coverage.unverified} unverified; limits: ${report.limits.length}.\n`,
          );
        process.exitCode = report.findings.some(
          (finding) => finding.severity === "CRITICAL",
        )
          ? 1
          : 0;
      } catch (error) {
        if (
          error instanceof UsageError ||
          error instanceof ZodError ||
          error instanceof SyntaxError
        ) {
          process.stderr.write(`Configuration error: ${error.message}\n`);
          process.exitCode = 2;
        } else {
          process.stderr.write(
            `Internal error: ${error instanceof Error ? error.message : String(error)}\n`,
          );
          process.exitCode = 3;
        }
      }
    },
  );

program
  .command("diff <old.json> <new.json>")
  .description("Print changes between two handoff.json reports.")
  .action(async (oldFile: string, newFile: string) => {
    try {
      const [oldText, newText] = await Promise.all([
        readFile(oldFile, "utf8"),
        readFile(newFile, "utf8"),
      ]);
      const oldReport = handoffReportSchema.parse(
        JSON.parse(oldText) as unknown,
      );
      const newReport = handoffReportSchema.parse(
        JSON.parse(newText) as unknown,
      );
      process.stdout.write(diffReports(oldReport, newReport));
    } catch (error) {
      if (
        error instanceof ZodError ||
        error instanceof SyntaxError ||
        (error instanceof Error && "code" in error && error.code === "ENOENT")
      ) {
        process.stderr.write(
          `Configuration error: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exitCode = 2;
      } else {
        process.stderr.write(
          `Internal error: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exitCode = 3;
      }
    }
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  process.stderr.write(
    `Internal error: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 3;
});
