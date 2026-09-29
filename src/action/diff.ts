import type { HandoffReport } from "../types.js";

function changes<T extends object>(
  label: string,
  oldRows: T[],
  newRows: T[],
  key: (row: T) => string,
): string[] {
  const oldByKey = new Map(oldRows.map((row) => [key(row), row]));
  const newByKey = new Map(newRows.map((row) => [key(row), row]));
  const lines: string[] = [];
  for (const id of [
    ...new Set([...oldByKey.keys(), ...newByKey.keys()]),
  ].sort()) {
    const before = oldByKey.get(id);
    const after = newByKey.get(id);
    if (!before) lines.push(`+ ${label}: ${id}`);
    else if (!after) lines.push(`- ${label}: ${id}`);
    else if (JSON.stringify(before) !== JSON.stringify(after))
      lines.push(`~ ${label}: ${id}`);
  }
  return lines;
}

export function diffReports(
  oldReport: HandoffReport,
  newReport: HandoffReport,
): string {
  const lines = [
    ...changes(
      "finding",
      oldReport.findings,
      newReport.findings,
      (row) => row.id,
    ),
    ...changes("env", oldReport.envVars, newReport.envVars, (row) => row.name),
    ...changes(
      "model",
      oldReport.models,
      newReport.models,
      (row) =>
        `${row.location.file}:${row.location.line} ${row.provider}/${row.modelId ?? "unresolved"}`,
    ),
    ...changes("cron", oldReport.crons, newReport.crons, (row) => row.path),
    ...changes(
      "workflow",
      oldReport.workflows,
      newReport.workflows,
      (row) => `${row.name} (${row.location.file}:${row.location.line})`,
    ),
    ...changes(
      "service",
      oldReport.services ?? [],
      newReport.services ?? [],
      (row) => row.service,
    ),
    ...changes(
      "ownership",
      oldReport.ownership ?? [],
      newReport.ownership ?? [],
      (row) => row.key,
    ),
    ...changes(
      "limit",
      oldReport.limits.map((value) => ({ value })),
      newReport.limits.map((value) => ({ value })),
      (row) => row.value,
    ),
  ];
  if (oldReport.repo.commitSha !== newReport.repo.commitSha)
    lines.unshift(
      `~ commit: ${oldReport.repo.commitSha ?? "unknown"} -> ${newReport.repo.commitSha ?? "unknown"}`,
    );
  return `${lines.length ? lines.join("\n") : "No report changes."}\n`;
}
