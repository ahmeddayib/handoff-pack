import { describe, expect, it } from "vitest";
import { expectedSchema, score } from "./acceptance/score.js";
import type { HandoffReport } from "../src/types.js";

const report: HandoffReport = {
  schemaVersion: 1,
  toolVersion: "0.1.0",
  generatedAt: "2026-09-25T00:00:00.000Z",
  repo: { path: "/tmp/demo", commitSha: null, branch: null },
  vercel: {
    projectId: "prj_1",
    projectName: "demo",
    teamId: null,
    accessed: true,
  },
  coverage: { verified: 1, mismatch: 1, unverified: 0 },
  envVars: [
    {
      name: "OK",
      references: [],
      declaredIn: [],
      clientExposed: false,
      status: "VERIFIED",
    },
    {
      name: "MISSING",
      references: [{ file: "src/api.ts", line: 1 }],
      declaredIn: [],
      clientExposed: false,
      status: "MISMATCH",
    },
  ],
  models: [],
  crons: [],
  workflows: [],
  findings: [
    {
      id: "env:MISSING:missing-production",
      rule: "V1",
      subject: "MISSING",
      category: "env",
      title: "Missing",
      severity: "CRITICAL",
      verification: "MISMATCH",
      evidence: [],
    },
  ],
  limits: [],
};

describe("acceptance scoring", () => {
  it("passes when planted findings and verified rows match ground truth", () => {
    const expected = expectedSchema.parse({
      project: "demo",
      mustFind: [{ rule: "V1", subject: "MISSING", severity: "CRITICAL" }],
      mustNotFind: [{ rule: "V1", subject: "OK" }],
      verifiedRows: { envVars: ["OK"], crons: [] },
    });
    expect(score(report, expected).pass).toBe(true);
  });

  it("fails on a verified row the human did not confirm", () => {
    const expected = expectedSchema.parse({
      project: "demo",
      mustFind: [{ rule: "V1", subject: "MISSING" }],
      mustNotFind: [],
      verifiedRows: { envVars: [], crons: [] },
    });
    const result = score(report, expected);
    expect(result.pass).toBe(false);
    expect(result.markdown).toContain("False verifications: 1 (env OK)");
  });
});
