import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import {
  Node,
  Project,
  SyntaxKind,
  type ArrowFunction,
  type FunctionDeclaration,
  type FunctionExpression,
  type SourceFile,
} from "ts-morph";
import type { Finding, WorkflowRecord } from "../types.js";
import type { ProjectInfo } from "./project.js";
import { isTestFile } from "./project.js";

type WorkflowFunction =
  FunctionDeclaration | FunctionExpression | ArrowFunction;
type NamedFunction = { name: string; node: WorkflowFunction };

export interface WorkflowScanResult {
  workflows: WorkflowRecord[];
  findings: Finding[];
  limits: string[];
}

function directive(node: WorkflowFunction): "workflow" | "step" | null {
  const body = node.getBody();
  if (!body || !Node.isBlock(body)) return null;
  const first = body.getStatements()[0];
  if (!first || !Node.isExpressionStatement(first)) return null;
  const expression = first.getExpression();
  if (!Node.isStringLiteral(expression)) return null;
  const value = expression.getLiteralText();
  return value === "use workflow"
    ? "workflow"
    : value === "use step"
      ? "step"
      : null;
}

function functionName(node: WorkflowFunction): string {
  if (Node.isFunctionDeclaration(node) || Node.isFunctionExpression(node)) {
    const name = node.getName();
    if (name) return name;
  }
  const parent = node.getParent();
  if (parent && Node.isVariableDeclaration(parent)) return parent.getName();
  return `anonymous@${node.getStartLineNumber()}`;
}

function importedName(
  source: SourceFile,
  local: string,
  targetNames: Map<string, Set<string>>,
  currentPath: string,
): string | null {
  for (const declaration of source.getImportDeclarations()) {
    const specifier = declaration.getModuleSpecifierValue();
    if (!specifier.startsWith(".") && !specifier.startsWith("@/")) continue;
    const imported = declaration
      .getNamedImports()
      .find(
        (item) => (item.getAliasNode()?.getText() ?? item.getName()) === local,
      );
    if (!imported) continue;
    const base = specifier.startsWith("@/")
      ? posix.normalize(specifier.slice(2))
      : posix.normalize(posix.join(posix.dirname(currentPath), specifier));
    for (const candidate of [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      `${base}.js`,
      `${base}.jsx`,
      `${base}/index.ts`,
      `${base}/index.js`,
    ]) {
      if (targetNames.get(candidate)?.has(imported.getName()))
        return `${candidate}:${imported.getName()}`;
    }
  }
  return null;
}

function importBindings(
  source: SourceFile,
  moduleName: string,
): Map<string, string> {
  const bindings = new Map<string, string>();
  for (const declaration of source.getImportDeclarations()) {
    if (declaration.getModuleSpecifierValue() !== moduleName) continue;
    for (const named of declaration.getNamedImports()) {
      if (!named.isTypeOnly())
        bindings.set(
          named.getAliasNode()?.getText() ?? named.getName(),
          named.getName(),
        );
    }
  }
  return bindings;
}

function durationMs(duration: string | null): number | null {
  if (duration === null) return null;
  if (/^\d+$/.test(duration)) return Number(duration);
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)$/.exec(duration);
  if (!match) return null;
  const factors: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60000,
    h: 3600000,
    d: 86400000,
    w: 604800000,
  };
  return Number(match[1]) * factors[match[2]!]!;
}

export async function scanWorkflows(
  root: string,
  projectInfo: ProjectInfo,
): Promise<WorkflowScanResult> {
  if (!projectInfo.dependencies.workflow)
    return { workflows: [], findings: [], limits: [] };
  const project = new Project({
    useInMemoryFileSystem: true,
    skipAddingFilesFromTsConfig: true,
  });
  const files = new Map<string, SourceFile>();
  for (const path of projectInfo.sourceFiles.filter(
    (path) => !isTestFile(path),
  ))
    files.set(
      path,
      project.createSourceFile(path, await readFile(join(root, path), "utf8")),
    );
  const workflowsByFile = new Map<string, NamedFunction[]>();
  const stepsByFile = new Map<string, NamedFunction[]>();
  const names = new Map<string, Set<string>>();
  const stepNames = new Map<string, Set<string>>();
  for (const [path, source] of files) {
    const workflows: NamedFunction[] = [];
    const steps: NamedFunction[] = [];
    source.forEachDescendant((node) => {
      if (
        !Node.isFunctionDeclaration(node) &&
        !Node.isFunctionExpression(node) &&
        !Node.isArrowFunction(node)
      )
        return;
      const kind = directive(node);
      if (kind === "workflow")
        workflows.push({ name: functionName(node), node });
      if (kind === "step") steps.push({ name: functionName(node), node });
    });
    workflowsByFile.set(path, workflows);
    stepsByFile.set(path, steps);
    names.set(path, new Set(workflows.map((item) => item.name)));
    stepNames.set(path, new Set(steps.map((item) => item.name)));
  }

  const records = new Map<string, WorkflowRecord>();
  const findings: Finding[] = [];
  const limits: string[] = [];
  for (const [path, functions] of workflowsByFile) {
    const source = files.get(path)!;
    const imports = importBindings(source, "workflow");
    const definedHooks = new Set<string>();
    for (const declaration of source.getVariableDeclarations()) {
      const initializer = declaration.getInitializer();
      if (
        initializer &&
        Node.isCallExpression(initializer) &&
        Node.isIdentifier(initializer.getExpression()) &&
        imports.get(initializer.getExpression().getText()) === "defineHook"
      )
        definedHooks.add(declaration.getName());
    }
    for (const item of functions) {
      const record: WorkflowRecord = {
        name: item.name,
        location: { file: path, line: item.node.getStartLineNumber() },
        steps: [],
        sleeps: [],
        hooks: [],
        startedFrom: [],
      };
      const body = item.node.getBody()!;
      for (const call of body.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const callee = call.getExpression();
        const location = { file: path, line: call.getStartLineNumber() };
        if (Node.isIdentifier(callee)) {
          const imported = imports.get(callee.getText());
          if (imported === "sleep") {
            const arg = call.getArguments()[0];
            const duration =
              arg &&
              (Node.isStringLiteral(arg) ||
                Node.isNoSubstitutionTemplateLiteral(arg))
                ? arg.getLiteralText()
                : arg && Node.isNumericLiteral(arg)
                  ? arg.getText()
                  : null;
            record.sleeps.push({ duration, location });
          }
          if (imported === "createHook" || imported === "createWebhook")
            record.hooks.push({ kind: imported, location });
          const step =
            stepsByFile
              .get(path)
              ?.find((step) => step.name === callee.getText()) ??
            (importedName(source, callee.getText(), stepNames, path)
              ? { name: callee.getText() }
              : undefined);
          if (step)
            record.steps.push({ name: step.name, location, callCount: 1 });
        }
        if (
          Node.isPropertyAccessExpression(callee) &&
          callee.getName() === "create" &&
          Node.isIdentifier(callee.getExpression()) &&
          definedHooks.has(callee.getExpression().getText())
        )
          record.hooks.push({ kind: "defineHook", location });
      }
      const groupedSteps = new Map<string, WorkflowRecord["steps"][number]>();
      for (const step of record.steps) {
        const current = groupedSteps.get(step.name);
        if (current) current.callCount += 1;
        else groupedSteps.set(step.name, { ...step, callCount: 1 });
      }
      record.steps = [...groupedSteps.values()].sort(
        (a, b) => a.location.line - b.location.line,
      );
      record.sleeps.sort((a, b) => a.location.line - b.location.line);
      record.hooks.sort((a, b) => a.location.line - b.location.line);
      records.set(`${path}:${item.name}`, record);
      if (
        record.hooks.length ||
        record.sleeps.some(
          (sleep) => (durationMs(sleep.duration) ?? 0) >= 3600000,
        )
      )
        findings.push({
          id: `workflow:${path}:${item.name}:paused`,
          rule: null,
          subject: item.name,
          category: "workflow",
          title:
            "This workflow can be paused for long periods. Runs in progress at handoff will continue after the handoff.",
          severity: "INFO",
          verification: "NOT_APPLICABLE",
          evidence: [
            {
              source: "repo",
              detail: "Long sleep or hook in workflow",
              location: record.location,
            },
          ],
          action: "Review in-flight runs and their credentials during handoff.",
        });
    }
  }
  for (const [path, source] of files) {
    const startBindings = importBindings(source, "workflow/api");
    source.forEachDescendant((node) => {
      if (
        !Node.isCallExpression(node) ||
        !Node.isIdentifier(node.getExpression()) ||
        startBindings.get(node.getExpression().getText()) !== "start"
      )
        return;
      const first = node.getArguments()[0];
      if (!first || !Node.isIdentifier(first)) return;
      const name = first.getText();
      const key = names.get(path)?.has(name)
        ? `${path}:${name}`
        : importedName(source, name, names, path);
      if (key)
        records
          .get(key)
          ?.startedFrom.push({ file: path, line: node.getStartLineNumber() });
    });
  }
  const workflows = [...records.values()].sort(
    (a, b) =>
      a.location.file.localeCompare(b.location.file) ||
      a.location.line - b.location.line,
  );
  for (const record of workflows)
    record.startedFrom.sort(
      (a, b) => a.file.localeCompare(b.file) || a.line - b.line,
    );
  return {
    workflows,
    findings: findings.sort((a, b) => a.id.localeCompare(b.id)),
    limits,
  };
}
