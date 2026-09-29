import { basename } from "node:path";
import { findModel, type ModelRegistry } from "../enrich/modelRegistry.js";
import { modelCost } from "../enrich/cost.js";
import { buildPlaybook, type StatusPages } from "../enrich/playbook.js";
import type {
  CodeLocation,
  CronRecord,
  Finding,
  HandoffReport,
  ModelRecord,
  Verification,
} from "../types.js";

export interface MarkdownContext {
  registry: ModelRegistry;
  modelStatuses: Verification[];
  envStatuses?: Verification[];
  projectName?: string;
  avgInputTokens?: number;
  avgOutputTokens?: number;
  statusPages?: StatusPages;
}

function cell(value: string | number | boolean | null | undefined): string {
  return String(value ?? "—")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");
}

function row(values: (string | number | boolean | null | undefined)[]): string {
  return `| ${values.map(cell).join(" | ")} |`;
}

function table(headers: string[], rows: string[][]): string[] {
  return [row(headers), row(headers.map(() => "---")), ...rows.map(row)];
}

function location(value: CodeLocation): string {
  return `${value.file}:${value.line}`;
}

function locations(values: CodeLocation[], max: number): string {
  const listed = values.slice(0, max).map(location).join(", ");
  const remainder = values.length - max;
  return `${listed || "—"}${remainder > 0 ? `, +${remainder}` : ""}`;
}

function status(value: Verification): string {
  switch (value) {
    case "VERIFIED":
      return "✅ Verified";
    case "MISMATCH":
      return "❌ Mismatch";
    case "UNVERIFIED":
      return "⚠️ Unverified";
    case "NOT_APPLICABLE":
      return "—";
  }
}

function cronStatus(cron: CronRecord): Verification {
  if (cron.status) return cron.status;
  if (!cron.routeFile || !cron.hasGetHandler) return "MISMATCH";
  return cron.liveOnVercel === true ? "VERIFIED" : "UNVERIFIED";
}

function modelLabel(model: ModelRecord): string {
  return model.modelId ?? "<dynamic>";
}

function actionItems(findings: Finding[]): string[] {
  const important = findings
    .filter((finding) => ["CRITICAL", "HIGH"].includes(finding.severity))
    .sort(
      (a, b) =>
        (a.severity === "CRITICAL" ? 0 : 1) -
          (b.severity === "CRITICAL" ? 0 : 1) || a.id.localeCompare(b.id),
    );
  if (!important.length) return ["No critical or high-severity items."];
  return important.map(
    (finding) =>
      `- **${finding.severity} · ${status(finding.verification)}:** ${finding.title} (${finding.subject}). ${finding.action ?? "Review this finding."}`,
  );
}

function otherFindings(report: HandoffReport): string[] {
  const seenModels = new Set<string>();
  const others = report.findings
    .filter((finding) => {
      if (finding.category === "ownership") return false;
      if (!["MEDIUM", "INFO"].includes(finding.severity)) return false;
      if (finding.category !== "model") return true;
      const model = report.models.find((candidate) =>
        finding.evidence.some(
          (evidence) =>
            evidence.location?.file === candidate.location.file &&
            evidence.location.line === candidate.location.line,
        ),
      );
      const key = `${model?.provider ?? "unknown"}/${model?.modelId ?? finding.subject}/${finding.rule ?? "none"}`;
      if (seenModels.has(key)) return false;
      seenModels.add(key);
      return true;
    })
    .sort(
      (a, b) =>
        (a.severity === "MEDIUM" ? 0 : 1) - (b.severity === "MEDIUM" ? 0 : 1) ||
        a.id.localeCompare(b.id),
    );
  return others.length
    ? others.map((finding) => {
        const title = finding.title.replace(/\.+$/, "");
        const labeledTitle =
          title.includes(finding.subject) || finding.rule === "V17"
            ? title
            : `${title} (${finding.subject})`;
        return `- **${finding.severity} · ${status(finding.verification)}:** ${labeledTitle}. ${finding.action ?? "Review this finding."}`;
      })
    : ["None detected."];
}

export function renderMarkdown(
  report: HandoffReport,
  context: MarkdownContext,
): string {
  const projectName =
    report.vercel.projectName ??
    context.projectName ??
    basename(report.repo.path);
  const modelGroups = new Map<
    string,
    { records: ModelRecord[]; statuses: Verification[] }
  >();
  report.models.forEach((model, index) => {
    const key = `${model.provider}\0${model.modelId ?? ""}`;
    const group = modelGroups.get(key) ?? { records: [], statuses: [] };
    group.records.push(model);
    group.statuses.push(context.modelStatuses[index] ?? "UNVERIFIED");
    modelGroups.set(key, group);
  });
  const modelRows = [...modelGroups.values()].map(({ records, statuses }) => {
    const model = records[0]!;
    const entry = model.modelId
      ? findModel(context.registry, model.provider, model.modelId)
      : null;
    const modelStatus: Verification = statuses.includes("MISMATCH")
      ? "MISMATCH"
      : statuses.includes("UNVERIFIED")
        ? "UNVERIFIED"
        : "VERIFIED";
    const callSites = [
      ...new Set(
        records
          .filter((item) => !item.declaredOnly)
          .map((item) => location(item.location)),
      ),
    ];
    const declarations = [
      ...new Set(
        records
          .filter((item) => item.declaredOnly)
          .map((item) => location(item.location)),
      ),
    ];
    const costs = [
      ...new Set(
        records.map(
          (item) =>
            modelCost(item, context.registry, {
              avgInputTokens: context.avgInputTokens ?? 1000,
              avgOutputTokens: context.avgOutputTokens ?? 500,
            }).label,
        ),
      ),
    ];
    return [
      model.provider,
      modelLabel(model),
      [
        ...callSites,
        ...(declarations.length
          ? [
              `declared models (not traced to a call site): ${declarations.join(", ")}`,
            ]
          : []),
      ].join("; "),
      status(modelStatus),
      entry && modelStatus === "VERIFIED" ? (entry.retirementDate ?? "—") : "—",
      entry && modelStatus === "VERIFIED" ? (entry.replacement ?? "—") : "—",
      costs.join("; "),
    ];
  });
  const playbook = buildPlaybook(report, context.statusPages);
  const costDeltas = [...modelGroups.values()].flatMap(({ records }) => {
    const model = records[0]!;
    const value = modelCost(model, context.registry, {
      avgInputTokens: context.avgInputTokens ?? 1000,
      avgOutputTokens: context.avgOutputTokens ?? 500,
    });
    return value.replacement
      ? [`- ${model.modelId ?? "dynamic"}: ${value.replacement}.`]
      : [];
  });
  const omittedVercelVars = (report.omittedSystemEnvVars ?? []).filter((name) =>
    name.startsWith("VERCEL"),
  );
  const omittedOtherSystemVars = (report.omittedSystemEnvVars ?? []).filter(
    (name) => !name.startsWith("VERCEL"),
  );
  const sections = [
    `# Operating Runbook: ${projectName}`,
    "",
    `> Generated by handoff-pack ${report.toolVersion} on ${report.generatedAt.slice(0, 10)} from commit ${report.repo.commitSha ?? "unknown"} (branch ${report.repo.branch ?? "unknown"}).`,
    `> Vercel project: ${report.vercel.projectName ?? "unknown"} (${report.vercel.accessed ? "accessed" : "not accessed"}).`,
    `> Verification coverage: ${report.coverage.verified} verified · ${report.coverage.mismatch} mismatches · ${report.coverage.unverified} unverified.`,
    ...(report.findings.some((finding) => finding.rule === "V17")
      ? [
          "> ⚠️ Production is running a different commit than this report describes.",
        ]
      : []),
    "",
    "## 1. Action items",
    "",
    ...actionItems(report.findings),
    "",
    "## Other findings",
    "",
    ...otherFindings(report),
    "",
    "## 2. Ownership transfer checklist",
    "",
    ...table(
      ["", "Item", "Owner", "Action"],
      (report.ownership ?? []).map((item) => [
        item.owner === "client" ? "- [x]" : "- [ ]",
        item.item,
        item.owner,
        item.action,
      ]),
    ),
    ...((report.ownership ?? []).length
      ? []
      : ["", "No ownership items detected."]),
    "",
    "## 3. Environment variables",
    "",
    ...table(
      [
        "Name",
        "Service",
        "Used in",
        "Vercel targets",
        "Type",
        "Client-exposed",
        "Status",
      ],
      report.envVars.map((item, index) => [
        item.name,
        item.service ?? "—",
        item.implicitReader && !item.references.length
          ? `read automatically by ${item.implicitReader}`
          : locations(item.references, 3),
        item.vercelTargets?.join(", ") ?? "—",
        item.vercelType ?? "—",
        item.clientExposed ? "Yes" : "No",
        status(item.status ?? context.envStatuses?.[index] ?? "UNVERIFIED"),
      ]),
    ),
    ...(report.findings.some((item) => item.id.startsWith("env:test-only:"))
      ? [
          "",
          `Test-only variables: ${report.findings
            .filter((item) => item.id.startsWith("env:test-only:"))
            .map(
              (item) =>
                `${item.subject} (${locations(
                  item.evidence.flatMap((evidence) =>
                    evidence.location ? [evidence.location] : [],
                  ),
                  3,
                )})`,
            )
            .join("; ")}.`,
        ]
      : []),
    ...(omittedVercelVars.length
      ? ["", `Omitted (managed by Vercel): ${omittedVercelVars.join(", ")}.`]
      : []),
    ...(omittedOtherSystemVars.length
      ? [
          "",
          `Omitted (system variables): ${omittedOtherSystemVars.join(", ")}.`,
        ]
      : []),
    "",
    "## 4. Scheduled jobs (crons)",
    "",
    ...table(
      [
        "Path",
        "Schedule",
        "Runs",
        "Route file",
        "Checks CRON_SECRET",
        "Live on Vercel",
        "Status",
        "Notes",
      ],
      report.crons.map((item) => [
        item.path,
        item.schedule,
        item.humanSchedule,
        item.routeFile ?? "—",
        report.findings.some(
          (finding) =>
            finding.category === "cron" &&
            finding.subject === item.path &&
            finding.title.includes("CRON_SECRET"),
        )
          ? "No"
          : item.routeFile
            ? "Yes (reference found)"
            : "—",
        item.liveOnVercel === true
          ? "Yes"
          : item.liveOnVercel === false
            ? "No"
            : "Unverified",
        status(cronStatus(item)),
        item.liveOnVercel === true &&
        report.findings.some(
          (finding) => finding.rule === "V7" && finding.subject === item.path,
        )
          ? "Scheduled on Vercel, but the route file doesn't exist; every run will 404."
          : "—",
      ]),
    ),
    ...(report.crons.length ? [] : ["", "None detected."]),
    ...(report.vercel.plan === "hobby" && report.crons.length
      ? [
          "",
          "Hobby plan timing: cron jobs may run up to 59 minutes after the scheduled time. [Vercel cron timing](https://vercel.com/docs/cron-jobs/usage-and-pricing).",
        ]
      : []),
    "",
    "## 5. Durable workflows",
    "",
    ...(report.workflows.length
      ? report.workflows.flatMap((item) => [
          `### ${item.name}`,
          "",
          `- Defined at: ${location(item.location)}`,
          `- Steps: ${item.steps.map((step) => `${step.name} (${location(step.location)}; ${step.callCount} ${step.callCount === 1 ? "call" : "calls"})`).join(", ") || "none found"}`,
          `- Sleeps: ${item.sleeps.map((sleep) => `${sleep.duration ?? "dynamic"} (${location(sleep.location)})`).join(", ") || "none found"}`,
          `- Hooks/webhooks: ${item.hooks.map((hook) => `${hook.kind} (${location(hook.location)})`).join(", ") || "none found"}`,
          `- Started from: ${locations(item.startedFrom, Number.MAX_SAFE_INTEGER)}`,
          ...(item.hooks.some((hook) => hook.kind === "createWebhook")
            ? [
                "- Pending runs hold webhook URLs on the current domain; changing the production domain may break runs waiting on these webhooks.",
              ]
            : []),
          "",
        ])
      : ["No durable workflows detected.", ""]),
    "## 6. Model dependencies",
    "",
    `Assumptions: ${context.avgInputTokens ?? 1000} input tokens and ${context.avgOutputTokens ?? 500} output tokens per request; estimates are per 1,000 requests.`,
    "",
    ...table(
      [
        "Provider",
        "Model",
        "Call sites",
        "Status",
        "Retires",
        "Replacement",
        "Est. cost / 1k requests",
      ],
      modelRows,
    ),
    ...(report.models.length ? [] : ["", "None detected."]),
    "",
    ...costDeltas,
    ...(costDeltas.length ? [""] : []),
    "Monthly estimate ≈ (requests per month ÷ 1,000) × cost per 1,000.",
    "",
    "## 7. External services",
    "",
    ...table(
      ["Service", "Category", "Env vars", "Packages"],
      (report.services ?? []).map((item) => [
        item.service,
        item.category,
        item.envVars.join(", ") || "—",
        item.packages.join(", ") || "—",
      ]),
    ),
    ...((report.services ?? []).length
      ? []
      : ["", "No external services detected."]),
    "",
    "## 8. Failure playbook",
    "",
    ...(playbook.length
      ? playbook.flatMap((item) => [
          `### ${item.title}`,
          "",
          `- Symptom: ${item.symptom}`,
          `- Where it's used: ${locations(item.locations, 5)}`,
          `- First check: ${item.firstCheck}`,
          `- Mitigation: ${item.mitigation}`,
          `- Status page: ${item.statusPage ?? "Not listed"}`,
          "",
        ])
      : ["No failure playbook entries detected.", ""]),
    "",
    "## 9. Scan limits",
    "",
    ...(report.limits.length
      ? report.limits.map((limit) => `- ${limit}`)
      : ["- No scan limits recorded."]),
    "",
    "---",
    "",
    `Model deprecation data: [llm-model-deprecation registry](https://github.com/techdevsynergy/llm-model-deprecation), MIT license; bundled data verified ${context.registry.verifiedAt}.`,
    "",
  ];
  return sections.join("\n");
}
