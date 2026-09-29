import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { handoffReportSchema } from "../../src/schema.js";
import type { Finding, HandoffReport } from "../../src/types.js";

const expectedEntry = z
  .strictObject({
    rule: z.string().nullable(),
    subject: z.string(),
    severity: z.enum(["CRITICAL", "HIGH", "MEDIUM", "INFO"]).optional(),
    category: z
      .enum([
        "env",
        "model",
        "cron",
        "workflow",
        "service",
        "webhook",
        "oauth",
        "domain",
        "protection",
        "ownership",
      ])
      .optional(),
    titleIncludes: z.string().optional(),
  })
  .refine((item) => item.rule !== null || item.category !== undefined, {
    message: "category is required when rule is null",
  });
export const expectedSchema = z.strictObject({
  project: z.string().regex(/^[A-Za-z0-9_-]+$/),
  mustFind: z.array(expectedEntry),
  mustNotFind: z.array(expectedEntry),
  verifiedRows: z.strictObject({
    envVars: z.array(z.string()),
    crons: z.array(z.string()),
  }),
});
type Expected = z.infer<typeof expectedSchema>;
type ExpectedEntry = Expected["mustFind"][number];

function matches(finding: Finding, entry: ExpectedEntry): boolean {
  return (
    finding.rule === entry.rule &&
    finding.subject === entry.subject &&
    (entry.category === undefined || finding.category === entry.category) &&
    (entry.severity === undefined || finding.severity === entry.severity) &&
    (entry.titleIncludes === undefined ||
      finding.title.includes(entry.titleIncludes))
  );
}

function label(entry: ExpectedEntry): string {
  return `${entry.rule ?? entry.category} ${entry.subject}`;
}

export function score(
  report: HandoffReport,
  expected: Expected,
): {
  markdown: string;
  pass: boolean;
} {
  const missed = expected.mustFind.filter(
    (entry) => !report.findings.some((finding) => matches(finding, entry)),
  );
  const falsePositives = expected.mustNotFind.filter((entry) =>
    report.findings.some((finding) => matches(finding, entry)),
  );
  const unexpected = report.findings.filter(
    (finding) =>
      ["CRITICAL", "HIGH"].includes(finding.severity) &&
      !expected.mustFind.some((entry) => matches(finding, entry)),
  );
  const confirmedEnv = new Set(expected.verifiedRows.envVars);
  const confirmedCrons = new Set(expected.verifiedRows.crons);
  const falseVerifications = [
    ...report.envVars
      .filter((row) => row.status === "VERIFIED" && !confirmedEnv.has(row.name))
      .map((row) => `env ${row.name}`),
    ...report.crons
      .filter(
        (row) => row.status === "VERIFIED" && !confirmedCrons.has(row.path),
      )
      .map((row) => `cron ${row.path}`),
    ...expected.verifiedRows.envVars
      .filter(
        (name) =>
          report.envVars.find((row) => row.name === name)?.status !==
          "VERIFIED",
      )
      .map((name) => `expected verified env ${name}`),
    ...expected.verifiedRows.crons
      .filter(
        (path) =>
          report.crons.find((row) => row.path === path)?.status !== "VERIFIED",
      )
      .map((path) => `expected verified cron ${path}`),
  ];
  const pass =
    !missed.length && !falsePositives.length && !falseVerifications.length;
  const lines = [
    `# Acceptance: ${expected.project}`,
    "",
    `- Caught: ${expected.mustFind.length - missed.length} / ${expected.mustFind.length}`,
    `- Missed: ${missed.length}${missed.length ? ` (${missed.map(label).join(", ")})` : ""}`,
    `- False positives: ${falsePositives.length}${falsePositives.length ? ` (${falsePositives.map(label).join(", ")})` : ""}`,
    `- Unexpected HIGH+: ${unexpected.length}${unexpected.length ? ` (review: ${unexpected.map((item) => `${item.id} ${item.rule ?? ""}`).join(", ")})` : ""}`,
    `- False verifications: ${falseVerifications.length}${falseVerifications.length ? ` (${falseVerifications.join(", ")})` : ""}`,
    `- Result: ${pass ? "PASS" : "FAIL"}`,
    "",
  ];
  return { markdown: lines.join("\n"), pass };
}

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1])
    throw new Error(`Missing ${name}.`);
  return process.argv[index + 1]!;
}

async function main(): Promise<void> {
  const reportFile = resolve(argument("--report"));
  const expectedFile = resolve(argument("--expected"));
  const report = handoffReportSchema.parse(
    JSON.parse(await readFile(reportFile, "utf8")) as unknown,
  );
  const expected = expectedSchema.parse(
    JSON.parse(await readFile(expectedFile, "utf8")) as unknown,
  );
  const result = score(report, expected);
  const kind = basename(expectedFile).includes(".clean.") ? "clean" : "planted";
  const output = resolve(
    "test/acceptance/results",
    `${expected.project}-${kind}.md`,
  );
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, result.markdown);
  process.stdout.write(result.markdown);
  if (!result.pass) process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  });
}
