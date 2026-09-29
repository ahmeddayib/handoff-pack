import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { scanCrons } from "../src/scanners/crons.js";
import { detectProject } from "../src/scanners/project.js";

describe("cron scanner", () => {
  it("resolves routes, GET handlers, UTC schedules, and missing CRON_SECRET", async () => {
    const root = resolve("test/fixtures/crons");
    const result = await scanCrons(root, await detectProject(root));
    expect(result.crons).toEqual([
      {
        path: "/api/cron/missing",
        schedule: "0 0 * * 1",
        humanSchedule: "At 12:00 AM, only on Monday (UTC)",
      },
      {
        path: "/api/cron/open",
        schedule: "*/15 * * * *",
        humanSchedule: "Every 15 minutes (UTC)",
        routeFile: "src/app/api/cron/open/route.ts",
        hasGetHandler: true,
      },
      {
        path: "/api/cron/secured?source=vercel",
        schedule: "0 5 * * *",
        humanSchedule: "At 05:00 AM (UTC)",
        routeFile: "src/app/api/cron/secured/route.ts",
        hasGetHandler: true,
      },
    ]);
    expect(result.findings).toMatchObject([
      { rule: "V7", subject: "/api/cron/missing", severity: "CRITICAL" },
      { rule: null, subject: "/api/cron/open", severity: "MEDIUM" },
    ]);
  });
});
