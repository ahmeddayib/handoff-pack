import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { detectProject } from "../src/scanners/project.js";
import { scanWorkflows } from "../src/scanners/workflows.js";

describe("workflow scanner", () => {
  it("detects workflow directives, two steps, a long sleep, a hook, and start site", async () => {
    const root = resolve("test/fixtures/workflows");
    const result = await scanWorkflows(root, await detectProject(root));
    expect(result.workflows).toEqual([
      {
        name: "orderWorkflow",
        location: { file: "src/workflows/order.ts", line: 13 },
        steps: [
          {
            name: "chargeCard",
            location: { file: "src/workflows/order.ts", line: 15 },
            callCount: 1,
          },
          {
            name: "sendReceipt",
            location: { file: "src/workflows/order.ts", line: 19 },
            callCount: 1,
          },
        ],
        sleeps: [
          {
            duration: "3d",
            location: { file: "src/workflows/order.ts", line: 16 },
          },
        ],
        hooks: [
          {
            kind: "createHook",
            location: { file: "src/workflows/order.ts", line: 17 },
          },
        ],
        startedFrom: [{ file: "src/app/api/order/route.ts", line: 5 }],
      },
    ]);
    expect(result.findings).toMatchObject([
      {
        category: "workflow",
        severity: "INFO",
        subject: "orderWorkflow",
      },
    ]);
  });

  it("resolves a root-alias workflow import and counts repeated step calls", async () => {
    const root = resolve("test/fixtures/workflows-alias");
    const result = await scanWorkflows(root, await detectProject(root));
    expect(result.workflows).toMatchObject([
      {
        name: "generateBirthdayCard",
        steps: [
          {
            name: "writeProgressEvent",
            callCount: 2,
            location: {
              file: "app/api/generate/generate-birthday-card.ts",
              line: 9,
            },
          },
        ],
        hooks: [{ kind: "createWebhook" }],
        startedFrom: [{ file: "app/api/generate/route.ts", line: 5 }],
      },
    ]);
  });

  it("skips workflow scanning when the package is absent", async () => {
    const root = resolve("test/fixtures/crons");
    expect(await scanWorkflows(root, await detectProject(root))).toEqual({
      workflows: [],
      findings: [],
      limits: [],
    });
  });
});
