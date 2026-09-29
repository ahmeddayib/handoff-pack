import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Node, Project } from "ts-morph";
import { z } from "zod";
import type { EnvVarRecord, Finding, ServiceRecord } from "../types.js";
import type { ProjectInfo } from "./project.js";
import { isTestFile } from "./project.js";

const serviceSchema = z.array(
  z.strictObject({
    service: z.string(),
    envPatterns: z.array(z.string()),
    packages: z.array(z.string()),
    category: z.string(),
  }),
);

export interface ServiceScanResult {
  services: ServiceRecord[];
  findings: Finding[];
  limits: string[];
}

function routePath(file: string): string | null {
  const app = /^(?:src\/)?app\/(.*)\/route\.[cm]?[jt]sx?$/.exec(file);
  if (app) return `/${app[1]!.replace(/\/(?:\([^/]+\))(?=\/|$)/g, "")}`;
  const pages = /^(?:src\/)?pages\/(api\/.*)\.[cm]?[jt]sx?$/.exec(file);
  return pages ? `/${pages[1]}` : null;
}

export async function scanServices(
  root: string,
  project: ProjectInfo,
  envVars: EnvVarRecord[],
): Promise<ServiceScanResult> {
  const definitions = serviceSchema.parse(
    JSON.parse(
      await readFile(
        new URL("../../data/services.json", import.meta.url),
        "utf8",
      ),
    ) as unknown,
  );
  const services = definitions.flatMap((definition) => {
    const envNames = envVars
      .filter((item) =>
        definition.envPatterns.some((pattern) =>
          new RegExp(pattern).test(item.name),
        ),
      )
      .map((item) => item.name)
      .sort();
    const packages = definition.packages
      .filter((name) => name in project.dependencies)
      .sort();
    return envNames.length || packages.length
      ? [
          {
            service: definition.service,
            category: definition.category,
            envVars: envNames,
            packages,
          },
        ]
      : [];
  });
  const findings: Finding[] = [];
  const webhookFiles = new Map<
    string,
    { route: string; service: string; line: number }
  >();
  const ast = new Project({
    useInMemoryFileSystem: true,
    skipAddingFilesFromTsConfig: true,
  });
  for (const file of project.sourceFiles.filter((path) => !isTestFile(path))) {
    const route = routePath(file);
    const source = ast.createSourceFile(
      file,
      await readFile(join(root, file), "utf8"),
    );
    let stripeLine: number | null = null;
    source.forEachDescendant((node) => {
      if (
        Node.isCallExpression(node) &&
        /(?:^|\.)webhooks\.constructEvent(?:Async)?$/.test(
          node.getExpression().getText(),
        )
      )
        stripeLine ??= node.getStartLineNumber();
    });
    const slackLine = envVars
      .find((item) => item.name === "SLACK_SIGNING_SECRET")
      ?.references.find((item) => item.file === file)?.line;
    if (route && (/webhooks?/.test(route) || stripeLine || slackLine)) {
      webhookFiles.set(file, {
        route,
        service: stripeLine ? "Stripe" : slackLine ? "Slack" : "the provider",
        line: stripeLine ?? slackLine ?? 1,
      });
    } else if (stripeLine || slackLine) {
      webhookFiles.set(file, {
        route: file,
        service: stripeLine ? "Stripe" : "Slack",
        line: stripeLine ?? slackLine ?? 1,
      });
    }
  }
  for (const [file, item] of webhookFiles) {
    findings.push({
      id: `webhook:${file}`,
      rule: null,
      subject: item.route,
      category: "webhook",
      title: `Webhook receiver detected: ${item.route}`,
      severity: "MEDIUM",
      verification: "UNVERIFIED",
      evidence: [
        {
          source: "repo",
          detail: `Webhook receiver in ${file}.`,
          location: { file, line: item.line },
        },
      ],
      action: `Re-register this webhook URL in ${item.service} under the client's account and the client's production domain.`,
    });
  }
  const oauthPattern =
    /^(?:AUTH_[A-Z]+_ID|(?:GITHUB|GOOGLE|AZURE_AD|MICROSOFT)_CLIENT_ID|NEXTAUTH_.*)$/;
  for (const env of envVars.filter((item) => oauthPattern.test(item.name))) {
    findings.push({
      id: `oauth:${env.name}`,
      rule: null,
      subject: env.name,
      category: "oauth",
      title: `OAuth configuration detected: ${env.name}`,
      severity: "MEDIUM",
      verification: "UNVERIFIED",
      evidence: [
        {
          source: "repo",
          detail: `Environment variable ${env.name}.`,
          ...(env.references[0] ? { location: env.references[0] } : {}),
        },
      ],
      action:
        "Confirm the OAuth app is registered under the client's organization; update redirect URIs to the client's production domain.",
    });
  }
  return {
    services,
    findings: findings.sort((a, b) => a.id.localeCompare(b.id)),
    limits: [],
  };
}
