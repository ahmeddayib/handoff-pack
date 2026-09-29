import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { diffReports } from "../src/action/diff.js";
import { handoffReportSchema } from "../src/schema.js";

async function report(path: string) {
  return handoffReportSchema.parse(
    JSON.parse(await readFile(path, "utf8")) as unknown,
  );
}

describe("report diff", () => {
  it("shows planted findings and cron changes against the clean report", async () => {
    const oldReport = await report("examples/handoff-demo/clean/handoff.json");
    const newReport = await report(
      "examples/handoff-demo/planted/handoff.json",
    );
    const output = diffReports(oldReport, newReport);
    expect(output).toContain(
      "+ finding: env:PLANTED_MISSING_VAR:missing-production",
    );
    expect(output).toContain("+ cron: /api/cron/no-secret");
    expect(output).toContain("+ cron: /api/cron/planted-missing-route");
  });

  it("ignores generation timestamps", async () => {
    const oldReport = await report("examples/handoff-demo/clean/handoff.json");
    expect(
      diffReports(oldReport, {
        ...oldReport,
        generatedAt: "2026-09-25T00:00:00.000Z",
      }),
    ).toBe("No report changes.\n");
  });
});
