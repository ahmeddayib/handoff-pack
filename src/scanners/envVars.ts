import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { Node, Project, SyntaxKind } from "ts-morph";
import { z } from "zod";
import type { CodeLocation, EnvVarRecord, Finding } from "../types.js";
import type { ProjectInfo } from "./project.js";
import { isTestFile } from "./project.js";
import { isSystemEnvName } from "../systemEnv.js";

const execFileAsync = promisify(execFile);
const safeExamples = new Set([
  ".env.example",
  ".env.sample",
  ".env.template",
  ".env.local.example",
]);
const serviceSchema = z.array(
  z.strictObject({
    service: z.string(),
    envPatterns: z.array(z.string()),
    packages: z.array(z.string()),
    category: z.string(),
  }),
);

export interface EnvScanResult {
  envVars: EnvVarRecord[];
  omittedSystemEnvVars: string[];
  findings: Finding[];
  limits: string[];
}

export interface EnvScanOptions {
  ignoreEnvVars?: string[];
  trackedFiles?: string[] | TrackedFile[];
}

interface TrackedFile {
  path: string;
  mode: string;
}

function isIgnored(name: string, extra: string[]): boolean {
  return isSystemEnvName(name) || extra.includes(name);
}

function basename(path: string): string {
  return path.split("/").at(-1) ?? path;
}

async function trackedFiles(root: string): Promise<TrackedFile[]> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", root, "ls-files", "--cached", "--stage", "-z"],
      { encoding: "buffer" },
    );
    return stdout
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .flatMap((entry) => {
        const tab = entry.indexOf("\t");
        if (tab < 0) return [];
        return [
          {
            mode: entry.slice(0, tab).split(" ")[0]!,
            path: entry.slice(tab + 1),
          },
        ];
      });
  } catch {
    return [];
  }
}

export async function scanEnvVars(
  root: string,
  projectInfo: ProjectInfo,
  options: EnvScanOptions = {},
): Promise<EnvScanResult> {
  const servicesPath = new URL("../../data/services.json", import.meta.url);
  const services = serviceSchema.parse(
    JSON.parse(await readFile(servicesPath, "utf8")) as unknown,
  );
  const implicitReaders = z
    .record(z.string(), z.array(z.string()))
    .parse(
      JSON.parse(
        await readFile(
          new URL("../../data/implicitEnv.json", import.meta.url),
          "utf8",
        ),
      ) as unknown,
    );
  const records = new Map<string, EnvVarRecord>();
  const omittedSystemEnvVars = new Set<string>();
  const testReferences = new Map<string, CodeLocation[]>();
  const limits: string[] = [];
  const findings: Finding[] = [];
  const extraIgnored = options.ignoreEnvVars ?? [];

  function record(
    name: string,
    location: CodeLocation,
    test: boolean,
    declaredIn?: string,
    client = false,
  ): void {
    if (isSystemEnvName(name)) {
      omittedSystemEnvVars.add(name);
      return;
    }
    if (isIgnored(name, extraIgnored)) return;
    if (test) {
      const locations = testReferences.get(name) ?? [];
      if (
        !locations.some(
          (existing) =>
            existing.file === location.file && existing.line === location.line,
        )
      )
        locations.push(location);
      testReferences.set(name, locations);
      return;
    }
    let current = records.get(name);
    if (!current) {
      current = {
        name,
        references: [],
        declaredIn: [],
        clientExposed: name.startsWith("NEXT_PUBLIC_"),
      };
      records.set(name, current);
    }
    if (
      !current.references.some(
        (existing) =>
          existing.file === location.file && existing.line === location.line,
      )
    )
      current.references.push(location);
    if (declaredIn && !current.declaredIn.includes(declaredIn))
      current.declaredIn.push(declaredIn);
    current.clientExposed ||= client;
  }

  const astProject = new Project({
    useInMemoryFileSystem: true,
    skipAddingFilesFromTsConfig: true,
  });
  for (const path of projectInfo.sourceFiles) {
    const source = astProject.createSourceFile(
      path,
      await readFile(join(root, path), "utf8"),
    );
    const test = isTestFile(path);
    const createEnvBindings = new Set<string>();
    for (const declaration of source.getImportDeclarations()) {
      if (declaration.getModuleSpecifierValue() !== "@t3-oss/env-nextjs")
        continue;
      for (const named of declaration.getNamedImports()) {
        if (named.getName() === "createEnv")
          createEnvBindings.add(named.getAliasNode()?.getText() ?? "createEnv");
      }
    }
    source.forEachDescendant((node) => {
      if (Node.isPropertyAccessExpression(node)) {
        const expression = node.getExpression().getText();
        if (expression === "process.env" || expression === "import.meta.env")
          record(
            node.getName(),
            { file: path, line: node.getStartLineNumber() },
            test,
          );
      }
      if (
        Node.isElementAccessExpression(node) &&
        node.getExpression().getText() === "process.env"
      ) {
        const argument = node.getArgumentExpression();
        if (
          argument &&
          (Node.isStringLiteral(argument) ||
            Node.isNoSubstitutionTemplateLiteral(argument))
        )
          record(
            argument.getLiteralText(),
            { file: path, line: node.getStartLineNumber() },
            test,
          );
        else
          limits.push(
            `Dynamic environment variable access at ${path}:${node.getStartLineNumber()}; name not inferred.`,
          );
      }
      if (
        Node.isVariableDeclaration(node) &&
        node.getInitializer()?.getText() === "process.env"
      ) {
        const nameNode = node.getNameNode();
        if (!Node.isObjectBindingPattern(nameNode)) return;
        for (const element of nameNode.getElements()) {
          const property =
            element.getPropertyNameNode() ?? element.getNameNode();
          const name =
            Node.isIdentifier(property) || Node.isStringLiteral(property)
              ? property.getText().replace(/^['"]|['"]$/g, "")
              : null;
          if (name)
            record(
              name,
              { file: path, line: element.getStartLineNumber() },
              test,
            );
        }
      }
      if (
        Node.isCallExpression(node) &&
        createEnvBindings.has(node.getExpression().getText())
      ) {
        const options = node.getArguments()[0];
        if (!options || !Node.isObjectLiteralExpression(options)) return;
        for (const blockName of ["server", "client", "runtimeEnv"]) {
          const block = options.getProperty(blockName);
          if (!block || !Node.isPropertyAssignment(block)) continue;
          const value = block.getInitializerIfKind(
            SyntaxKind.ObjectLiteralExpression,
          );
          if (!value) continue;
          for (const property of value.getProperties()) {
            if (
              !Node.isPropertyAssignment(property) &&
              !Node.isShorthandPropertyAssignment(property)
            )
              continue;
            const name = property.getName();
            record(
              name,
              { file: path, line: property.getStartLineNumber() },
              test,
              path,
              blockName === "client",
            );
          }
        }
      }
    });
  }

  for (const path of projectInfo.exampleEnvFiles) {
    if (!safeExamples.has(basename(path))) continue;
    const contents = await readFile(join(root, path), "utf8");
    for (const line of contents.split(/\r?\n/)) {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
      const name = match?.[1];
      if (!name || isIgnored(name, extraIgnored)) continue;
      let current = records.get(name);
      if (!current) {
        current = {
          name,
          references: [],
          declaredIn: [],
          clientExposed: name.startsWith("NEXT_PUBLIC_"),
        };
        records.set(name, current);
      }
      if (!current.declaredIn.includes(path)) current.declaredIn.push(path);
    }
  }

  const tracked = options.trackedFiles ?? (await trackedFiles(root));
  for (const item of tracked) {
    const path = typeof item === "string" ? item : item.path;
    if (typeof item !== "string" && item.mode === "120000") continue;
    const name = basename(path);
    if (
      !name.startsWith(".env") ||
      /(?:^|\.)(?:example|sample|template)(?:\.|$)/.test(name)
    )
      continue;
    const testEnvironmentFile =
      name === ".env.test" &&
      path
        .split("/")
        .slice(0, -1)
        .some((part) =>
          ["test", "tests", "__tests__", "fixtures"].includes(part),
        );
    findings.push({
      id: `env:${path}`,
      rule: "V18",
      subject: path,
      category: "env",
      title: testEnvironmentFile
        ? "Test environment file committed to repository"
        : "Env file committed to repository",
      severity: testEnvironmentFile ? "MEDIUM" : "CRITICAL",
      verification: "VERIFIED",
      evidence: [{ source: "repo", detail: `Tracked file: ${path}` }],
      action: testEnvironmentFile
        ? "Review this test file for credentials; remove it and rotate any exposed values if needed."
        : "Remove this env file from the repository and rotate any exposed credentials.",
    });
  }

  for (const record of records.values()) {
    record.references.sort(
      (a, b) => a.file.localeCompare(b.file) || a.line - b.line,
    );
    record.declaredIn.sort();
    record.service = services.find((service) =>
      service.envPatterns.some((pattern) =>
        new RegExp(pattern).test(record.name),
      ),
    )?.service;
    if (!record.references.length) {
      const reader = implicitReaders[record.name]?.find(
        (name) => name in projectInfo.dependencies,
      );
      if (reader) record.implicitReader = reader;
    }
  }
  for (const [name, record] of records) {
    if (testReferences.has(name) && !record.references.length)
      records.delete(name);
  }
  for (const [name, locations] of testReferences) {
    if (records.get(name)?.references.length) continue;
    findings.push({
      id: `env:test-only:${name}`,
      rule: null,
      subject: name,
      category: "env",
      title: "Environment variable referenced only in tests",
      severity: "INFO",
      verification: "NOT_APPLICABLE",
      evidence: locations.map((location) => ({
        source: "repo",
        detail: "Test-only reference",
        location,
      })),
    });
  }
  return {
    envVars: [...records.values()].sort((a, b) => a.name.localeCompare(b.name)),
    omittedSystemEnvVars: [...omittedSystemEnvVars].sort(),
    findings: findings.sort((a, b) => a.id.localeCompare(b.id)),
    limits: limits.sort(),
  };
}
