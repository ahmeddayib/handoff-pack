import { readFile } from "node:fs/promises";
import { join } from "node:path";
import cronstrue from "cronstrue";
import { Node, Project, SyntaxKind } from "ts-morph";
import { z } from "zod";
import type { CronRecord, Finding } from "../types.js";
import type { ProjectInfo } from "./project.js";

const vercelConfigSchema = z.object({
  crons: z
    .array(z.object({ path: z.string(), schedule: z.string() }))
    .optional(),
});

export interface CronScanResult {
  crons: CronRecord[];
  findings: Finding[];
  limits: string[];
}

function routeCandidates(path: string): string[] {
  const clean = path.split("?")[0]!.replace(/^\/+|\/+$/g, "");
  const api = clean.startsWith("api/") ? clean.slice(4) : null;
  return [
    `app/${clean}/route.ts`,
    `app/${clean}/route.js`,
    `src/app/${clean}/route.ts`,
    `src/app/${clean}/route.js`,
    ...(api === null
      ? []
      : [
          `pages/api/${api}.ts`,
          `pages/api/${api}.js`,
          `pages/api/${api}/index.ts`,
          `pages/api/${api}/index.js`,
          `src/pages/api/${api}.ts`,
          `src/pages/api/${api}.js`,
          `src/pages/api/${api}/index.ts`,
          `src/pages/api/${api}/index.js`,
        ]),
  ];
}

function hasGetExport(
  source: ReturnType<Project["createSourceFile"]>,
): boolean {
  if (source.getFunction("GET")?.isExported()) return true;
  return (
    source
      .getVariableDeclaration("GET")
      ?.getVariableStatement()
      ?.isExported() ?? false
  );
}

function hasDefaultExport(
  source: ReturnType<Project["createSourceFile"]>,
): boolean {
  return (
    source
      .getExportAssignments()
      .some((assignment) => !assignment.isExportEquals()) ||
    source.getFunctions().some((fn) => fn.isDefaultExport()) ||
    source.getClasses().some((cls) => cls.isDefaultExport())
  );
}

function hasCronSecretReference(
  source: ReturnType<Project["createSourceFile"]>,
): boolean {
  return (
    source
      .getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)
      .some(
        (node) =>
          node.getExpression().getText() === "process.env" &&
          node.getName() === "CRON_SECRET",
      ) ||
    source
      .getDescendantsOfKind(SyntaxKind.ElementAccessExpression)
      .some((node) => {
        const argument = node.getArgumentExpression();
        return (
          node.getExpression().getText() === "process.env" &&
          !!argument &&
          Node.isStringLiteral(argument) &&
          argument.getLiteralText() === "CRON_SECRET"
        );
      })
  );
}

export async function scanCrons(
  root: string,
  projectInfo: ProjectInfo,
): Promise<CronScanResult> {
  const limits: string[] = [];
  const findings: Finding[] = [];
  if (projectInfo.sourceFiles.includes("vercel.ts"))
    limits.push("vercel.ts detected; crons in it were not parsed.");
  let config: z.infer<typeof vercelConfigSchema>;
  try {
    config = vercelConfigSchema.parse(
      JSON.parse(await readFile(join(root, "vercel.json"), "utf8")) as unknown,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { crons: [], findings, limits };
    throw error;
  }
  const files = new Set(projectInfo.sourceFiles);
  const project = new Project({
    useInMemoryFileSystem: true,
    skipAddingFilesFromTsConfig: true,
  });
  const crons: CronRecord[] = [];
  for (const entry of config.crons ?? []) {
    const routeFile = routeCandidates(entry.path).find((path) =>
      files.has(path),
    );
    const route = routeFile
      ? (project.getSourceFile(routeFile) ??
        project.createSourceFile(
          routeFile,
          await readFile(join(root, routeFile), "utf8"),
        ))
      : null;
    const pages = routeFile?.includes("pages/api/") ?? false;
    const hasGetHandler = route
      ? pages
        ? hasDefaultExport(route)
        : hasGetExport(route)
      : undefined;
    const record: CronRecord = {
      path: entry.path,
      schedule: entry.schedule,
      humanSchedule: `${cronstrue.toString(entry.schedule)} (UTC)`,
      ...(routeFile ? { routeFile, hasGetHandler } : {}),
    };
    crons.push(record);
    if (pages && route && hasGetHandler)
      limits.push(
        `Cron ${entry.path} uses a Pages Router default export; its HTTP method cannot be determined statically.`,
      );
    if (!route || !hasGetHandler)
      findings.push({
        id: `cron:${entry.path}:route`,
        rule: "V7",
        subject: entry.path,
        category: "cron",
        title: "Cron route or GET handler missing",
        severity: "CRITICAL",
        verification: "MISMATCH",
        evidence: [
          {
            source: "repo",
            detail: routeFile
              ? `No GET handler in ${routeFile}`
              : "No matching route file",
          },
        ],
        action:
          "Add a matching cron route with a GET handler, or remove this cron entry.",
      });
    if (route && !hasCronSecretReference(route))
      findings.push({
        id: `cron:${entry.path}:secret`,
        rule: null,
        subject: entry.path,
        category: "cron",
        title:
          "Cron endpoint does not check CRON_SECRET; it can be triggered by anyone.",
        severity: "MEDIUM",
        verification: "NOT_APPLICABLE",
        evidence: [
          {
            source: "repo",
            detail: `No CRON_SECRET reference in ${routeFile}`,
          },
        ],
        action: "Check CRON_SECRET in the cron route before performing work.",
      });
  }
  return {
    crons: crons.sort((a, b) => a.path.localeCompare(b.path)),
    findings: findings.sort((a, b) => a.id.localeCompare(b.id)),
    limits: limits.sort(),
  };
}
