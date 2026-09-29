import { handoffReportSchema } from "../schema.js";
import type { CodeLocation, HandoffReport } from "../types.js";

function compareLocations(a: CodeLocation, b: CodeLocation): number {
  return a.file.localeCompare(b.file) || a.line - b.line;
}

export function renderJson(report: HandoffReport): string {
  const sorted: HandoffReport = {
    ...report,
    ...(report.omittedSystemEnvVars
      ? { omittedSystemEnvVars: [...report.omittedSystemEnvVars].sort() }
      : {}),
    envVars: report.envVars
      .map((item) => ({
        ...item,
        references: [...item.references].sort(compareLocations),
        declaredIn: [...item.declaredIn].sort(),
        ...(item.vercelTargets
          ? { vercelTargets: [...item.vercelTargets].sort() }
          : {}),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    models: [...report.models].sort(
      (a, b) =>
        compareLocations(a.location, b.location) ||
        a.provider.localeCompare(b.provider) ||
        (a.modelId ?? "").localeCompare(b.modelId ?? ""),
    ),
    crons: [...report.crons].sort((a, b) => a.path.localeCompare(b.path)),
    workflows: report.workflows
      .map((item) => ({
        ...item,
        steps: [...item.steps].sort((a, b) =>
          compareLocations(a.location, b.location),
        ),
        sleeps: [...item.sleeps].sort((a, b) =>
          compareLocations(a.location, b.location),
        ),
        hooks: [...item.hooks].sort((a, b) =>
          compareLocations(a.location, b.location),
        ),
        startedFrom: [...item.startedFrom].sort(compareLocations),
      }))
      .sort((a, b) => compareLocations(a.location, b.location)),
    ...(report.services
      ? {
          services: report.services
            .map((item) => ({
              ...item,
              envVars: [...item.envVars].sort(),
              packages: [...item.packages].sort(),
            }))
            .sort((a, b) => a.service.localeCompare(b.service)),
        }
      : {}),
    ...(report.ownership
      ? {
          ownership: [...report.ownership].sort((a, b) =>
            a.key.localeCompare(b.key),
          ),
        }
      : {}),
    findings: report.findings
      .map((item) => ({
        ...item,
        evidence: [...item.evidence].sort(
          (a, b) =>
            a.source.localeCompare(b.source) ||
            (a.location && b.location
              ? compareLocations(a.location, b.location)
              : 0) ||
            a.detail.localeCompare(b.detail),
        ),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    limits: [...report.limits].sort(),
  };
  return `${JSON.stringify(handoffReportSchema.parse(sorted), null, 2)}\n`;
}
