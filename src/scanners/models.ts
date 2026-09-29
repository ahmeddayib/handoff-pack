import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import {
  Node,
  Project,
  SyntaxKind,
  type Expression,
  type SourceFile,
} from "ts-morph";
import type { Finding, ModelRecord } from "../types.js";
import type { ProjectInfo } from "./project.js";
import { isTestFile } from "./project.js";

const providerPackages = new Map([
  ["@ai-sdk/openai", "openai"],
  ["@ai-sdk/anthropic", "anthropic"],
  ["@ai-sdk/google", "google"],
  ["@ai-sdk/mistral", "mistral"],
  ["@ai-sdk/xai", "xai"],
  ["@ai-sdk/groq", "groq"],
  ["@ai-sdk/amazon-bedrock", "amazon-bedrock"],
  ["@ai-sdk/azure", "azure"],
  ["@ai-sdk/gateway", "gateway"],
]);
const aiCalls = new Set([
  "generateText",
  "streamText",
  "generateObject",
  "streamObject",
  "embed",
  "embedMany",
]);
const agentClasses = new Set(["ToolLoopAgent", "Experimental_Agent"]);
const gatewayId = /^([a-z0-9-]+)\/([A-Za-z0-9._:-]+)$/;

export interface ModelScanResult {
  models: ModelRecord[];
  findings: Finding[];
  limits: string[];
}

export interface ModelScanOptions {
  modelOverrides?: Record<string, { provider: string; modelId: string }>;
}

type Resolved = {
  modelId: string | null;
  configuredViaEnv?: string;
  defaultFromEnv?: boolean;
};

function memberChain(node: Expression): string[] | null {
  if (Node.isIdentifier(node)) return [node.getText()];
  if (Node.isPropertyAccessExpression(node)) {
    const parent = memberChain(node.getExpression());
    return parent ? [...parent, node.getName()] : null;
  }
  return null;
}

function unwrap(expression: Expression): Expression {
  while (
    Node.isParenthesizedExpression(expression) ||
    Node.isAsExpression(expression) ||
    Node.isNonNullExpression(expression)
  ) {
    expression = expression.getExpression();
  }
  return expression;
}

function envName(expression: Expression): string | null {
  expression = unwrap(expression);
  if (
    Node.isPropertyAccessExpression(expression) &&
    expression.getExpression().getText() === "process.env"
  )
    return expression.getName();
  if (
    Node.isElementAccessExpression(expression) &&
    expression.getExpression().getText() === "process.env"
  ) {
    const argument = expression.getArgumentExpression();
    return argument && Node.isStringLiteral(argument)
      ? argument.getLiteralText()
      : null;
  }
  return null;
}

function importedConst(
  source: SourceFile,
  name: string,
  files: Map<string, SourceFile>,
): Expression | null {
  for (const declaration of source.getImportDeclarations()) {
    const specifier = declaration.getModuleSpecifierValue();
    if (!specifier.startsWith(".")) continue;
    const imported = declaration
      .getNamedImports()
      .find(
        (item) => (item.getAliasNode()?.getText() ?? item.getName()) === name,
      );
    if (!imported) continue;
    const currentPath = [...files].find(([, file]) => file === source)?.[0];
    if (!currentPath) return null;
    const base = posix.normalize(
      posix.join(posix.dirname(currentPath), specifier),
    );
    const target = [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      `${base}.js`,
      `${base}.jsx`,
      `${base}/index.ts`,
      `${base}/index.js`,
    ]
      .map((path) => files.get(path))
      .find(Boolean);
    const variable = target?.getVariableDeclaration(imported.getName());
    if (
      variable?.getVariableStatement()?.isExported() &&
      variable.getVariableStatement()?.getDeclarationKind() === "const"
    )
      return variable.getInitializer() ?? null;
  }
  return null;
}

function resolveModel(
  expression: Expression,
  source: SourceFile,
  files: Map<string, SourceFile>,
  allowImport = true,
): Resolved {
  expression = unwrap(expression);
  if (
    Node.isStringLiteral(expression) ||
    Node.isNoSubstitutionTemplateLiteral(expression)
  )
    return { modelId: expression.getLiteralText() };
  if (
    Node.isBinaryExpression(expression) &&
    expression.getOperatorToken().getKind() === SyntaxKind.QuestionQuestionToken
  ) {
    const name = envName(expression.getLeft());
    if (name) {
      const fallback = resolveModel(
        expression.getRight(),
        source,
        files,
        false,
      );
      return {
        modelId: fallback.modelId,
        configuredViaEnv: name,
        defaultFromEnv: fallback.modelId !== null,
      };
    }
  }
  const directEnv = envName(expression);
  if (directEnv) return { modelId: null, configuredViaEnv: directEnv };
  if (Node.isPropertyAccessExpression(expression)) {
    const owner = expression.getExpression();
    if (Node.isIdentifier(owner)) {
      const local = source.getVariableDeclaration(owner.getText());
      const localInitializer =
        local?.getVariableStatement()?.getDeclarationKind() === "const"
          ? local.getInitializer()
          : null;
      const initializer =
        localInitializer ??
        (allowImport ? importedConst(source, owner.getText(), files) : null);
      const property = optionsProperty(
        initializer ?? undefined,
        expression.getName(),
      );
      if (property)
        return resolveModel(property, property.getSourceFile(), files, false);
    }
  }
  if (Node.isIdentifier(expression)) {
    const local = source.getVariableDeclaration(expression.getText());
    if (
      local?.getVariableStatement()?.getDeclarationKind() === "const" &&
      local.getInitializer()
    )
      return resolveModel(local.getInitializer()!, source, files, false);
    if (allowImport) {
      const imported = importedConst(source, expression.getText(), files);
      if (imported)
        return resolveModel(imported, imported.getSourceFile(), files, false);
    }
  }
  return { modelId: null };
}

function optionsProperty(
  options: Node | undefined,
  name: string,
): Expression | null {
  if (!options || !Node.isObjectLiteralExpression(options)) return null;
  const property = options.getProperty(name);
  return property && Node.isPropertyAssignment(property)
    ? (property.getInitializer() ?? null)
    : null;
}

function numericMax(options: Node | undefined): number | undefined {
  const expression =
    optionsProperty(options, "maxOutputTokens") ??
    optionsProperty(options, "maxTokens");
  return expression && Node.isNumericLiteral(expression)
    ? Number(expression.getLiteralValue())
    : undefined;
}

function nearestAiCall(
  node: Node,
  calls: Map<string, string>,
  agents: Set<string>,
): { kind: ModelRecord["callKind"]; options?: Node } {
  let parent = node.getParent();
  while (parent) {
    if (
      Node.isCallExpression(parent) &&
      Node.isIdentifier(parent.getExpression())
    ) {
      const kind = calls.get(parent.getExpression().getText());
      if (kind)
        return {
          kind: kind as ModelRecord["callKind"],
          options: parent.getArguments()[0],
        };
    }
    if (
      Node.isNewExpression(parent) &&
      Node.isIdentifier(parent.getExpression()) &&
      agents.has(parent.getExpression().getText())
    )
      return { kind: "agent", options: parent.getArguments()?.[0] };
    parent = parent.getParent();
  }
  return { kind: "unknown" };
}

export async function scanModels(
  root: string,
  projectInfo: ProjectInfo,
  options: ModelScanOptions = {},
): Promise<ModelScanResult> {
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

  const models: ModelRecord[] = [];
  const findings: Finding[] = [];
  const limits: string[] = [];

  for (const [path, source] of files) {
    const providers = new Map<string, string>();
    const factories = new Map<string, string>();
    const calls = new Map<string, string>();
    const agents = new Set<string>();
    const rawConstructors = new Map<string, string>();
    for (const declaration of source.getImportDeclarations()) {
      const specifier = declaration.getModuleSpecifierValue();
      const provider = providerPackages.get(specifier);
      for (const named of declaration.getNamedImports()) {
        if (named.isTypeOnly()) continue;
        const imported = named.getName();
        const local = named.getAliasNode()?.getText() ?? imported;
        if (provider) {
          if (imported.startsWith("create")) factories.set(local, provider);
          else providers.set(local, provider);
        }
        if (specifier === "ai" && imported === "gateway")
          providers.set(local, "gateway");
        if (specifier === "ai" && aiCalls.has(imported))
          calls.set(local, imported);
        if (specifier === "ai" && agentClasses.has(imported)) agents.add(local);
        if (specifier === "openai" && imported === "OpenAI")
          rawConstructors.set(local, "openai");
        if (specifier === "@anthropic-ai/sdk" && imported === "Anthropic")
          rawConstructors.set(local, "anthropic");
      }
      const defaultImport = declaration.getDefaultImport()?.getText();
      if (defaultImport && specifier === "openai")
        rawConstructors.set(defaultImport, "openai");
      if (defaultImport && specifier === "@anthropic-ai/sdk")
        rawConstructors.set(defaultImport, "anthropic");
    }
    const rawClients = new Map<string, string>();
    for (const variable of source.getDescendantsOfKind(
      SyntaxKind.VariableDeclaration,
    )) {
      const init = variable.getInitializer();
      if (!init || !Node.isIdentifier(variable.getNameNode())) continue;
      if (
        Node.isCallExpression(init) &&
        Node.isIdentifier(init.getExpression())
      ) {
        const provider = factories.get(init.getExpression().getText());
        if (provider) providers.set(variable.getName(), provider);
      }
      if (
        Node.isNewExpression(init) &&
        Node.isIdentifier(init.getExpression())
      ) {
        const provider = rawConstructors.get(init.getExpression().getText());
        if (provider) rawClients.set(variable.getName(), provider);
      }
    }

    function addModel(
      expression: Expression,
      provider: string,
      callKind: ModelRecord["callKind"],
      maxOutputTokens?: number,
      declaredOnly = false,
    ): void {
      const resolved = resolveModel(expression, source, files);
      const override = resolved.modelId
        ? options.modelOverrides?.[resolved.modelId]
        : undefined;
      let modelId = override?.modelId ?? resolved.modelId;
      provider = override?.provider ?? provider;
      if (provider === "gateway" && modelId) {
        const match = gatewayId.exec(modelId);
        if (match) {
          provider = match[1]!;
          modelId = match[2]!;
        } else {
          modelId = null;
        }
      }
      const location = { file: path, line: expression.getStartLineNumber() };
      models.push({
        provider,
        modelId,
        rawExpression: expression.getText().slice(0, 120),
        callKind,
        location,
        ...(declaredOnly ? { declaredOnly: true } : {}),
        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
        ...(resolved.configuredViaEnv
          ? { configuredViaEnv: resolved.configuredViaEnv }
          : {}),
      });
      if (resolved.defaultFromEnv)
        limits.push(
          `Model at ${path}:${location.line} is a default; production value comes from env var ${resolved.configuredViaEnv} and was not read.`,
        );
      if (!modelId)
        findings.push({
          id: `model:dynamic:${path}:${location.line}`,
          rule: null,
          subject: path,
          category: "model",
          title: "Dynamic model ID; verify manually.",
          severity: "INFO",
          verification: "UNVERIFIED",
          evidence: [
            {
              source: "repo",
              detail: "Model expression could not be resolved",
              location,
            },
          ],
          action: "Verify the model ID configured at this location.",
        });
    }

    if (/(?:^|\/)models\.[cm]?[jt]sx?$/.test(path)) {
      for (const statement of source.getVariableStatements()) {
        if (!statement.isExported()) continue;
        for (const declaration of statement.getDeclarations()) {
          if (!/model/i.test(declaration.getName())) continue;
          const initializer = declaration.getInitializer();
          if (!initializer) continue;
          const candidates = [
            initializer,
            ...initializer.getDescendantsOfKind(SyntaxKind.StringLiteral),
            ...initializer.getDescendantsOfKind(
              SyntaxKind.NoSubstitutionTemplateLiteral,
            ),
          ];
          for (const candidate of candidates) {
            if (
              (Node.isStringLiteral(candidate) ||
                Node.isNoSubstitutionTemplateLiteral(candidate)) &&
              gatewayId.test(candidate.getLiteralText())
            )
              addModel(candidate, "gateway", "unknown", undefined, true);
          }
        }
      }
    }

    source.forEachDescendant((node) => {
      if (Node.isCallExpression(node)) {
        const callee = node.getExpression();
        const arg = node.getArguments()[0];
        if (arg && Node.isExpression(arg)) {
          const provider = Node.isIdentifier(callee)
            ? providers.get(callee.getText())
            : Node.isPropertyAccessExpression(callee) &&
                Node.isIdentifier(callee.getExpression())
              ? providers.get(callee.getExpression().getText())
              : undefined;
          if (provider) {
            const enclosing = nearestAiCall(node, calls, agents);
            addModel(
              arg,
              provider,
              enclosing.kind,
              numericMax(enclosing.options),
            );
          }
        }
        if (Node.isIdentifier(callee) && calls.has(callee.getText())) {
          const optionsObject = node.getArguments()[0];
          const model = optionsProperty(optionsObject, "model");
          if (
            model &&
            (Node.isStringLiteral(model) ||
              Node.isNoSubstitutionTemplateLiteral(model)) &&
            gatewayId.test(model.getLiteralText())
          )
            addModel(
              model,
              "gateway",
              calls.get(callee.getText()) as ModelRecord["callKind"],
              numericMax(optionsObject),
            );
        }
        if (
          Node.isPropertyAccessExpression(callee) &&
          callee.getName() === "create"
        ) {
          const chain = memberChain(callee.getExpression());
          const client = chain?.[0];
          const method = chain?.slice(1).join(".");
          if (
            client &&
            rawClients.has(client) &&
            ((rawClients.get(client) === "openai" &&
              ["chat.completions", "responses", "embeddings"].includes(
                method ?? "",
              )) ||
              (rawClients.get(client) === "anthropic" && method === "messages"))
          ) {
            const model = optionsProperty(node.getArguments()[0], "model");
            if (model) addModel(model, rawClients.get(client)!, "rawSdk");
          }
        }
      }
      if (
        Node.isNewExpression(node) &&
        Node.isIdentifier(node.getExpression()) &&
        agents.has(node.getExpression().getText())
      ) {
        const optionsObject = node.getArguments()?.[0];
        const model = optionsProperty(optionsObject, "model");
        if (
          model &&
          (Node.isStringLiteral(model) ||
            Node.isNoSubstitutionTemplateLiteral(model)) &&
          gatewayId.test(model.getLiteralText())
        )
          addModel(model, "gateway", "agent", numericMax(optionsObject));
      }
    });
  }
  models.sort(
    (a, b) =>
      a.location.file.localeCompare(b.location.file) ||
      a.location.line - b.location.line ||
      a.provider.localeCompare(b.provider),
  );
  if (
    !models.length &&
    Object.keys(projectInfo.dependencies).some(
      (name) => name === "ai" || name.startsWith("@ai-sdk/"),
    )
  )
    limits.push(
      "AI SDK dependency detected, but no model references were found.",
    );
  return {
    models,
    findings: findings.sort((a, b) => a.id.localeCompare(b.id)),
    limits: limits.sort(),
  };
}
