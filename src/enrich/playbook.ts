import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { CodeLocation, HandoffReport } from "../types.js";

export type StatusPages = Record<string, string>;

export async function loadStatusPages(): Promise<StatusPages> {
  return z
    .record(z.string(), z.url())
    .parse(
      JSON.parse(
        await readFile(
          new URL("../../data/statusPages.json", import.meta.url),
          "utf8",
        ),
      ) as unknown,
    );
}

export interface PlaybookEntry {
  title: string;
  symptom: string;
  locations: CodeLocation[];
  firstCheck: string;
  mitigation: string;
  statusPage: string | null;
}

export function buildPlaybook(
  report: HandoffReport,
  pages: StatusPages = {},
): PlaybookEntry[] {
  const entries: PlaybookEntry[] = [];
  const add = (entry: PlaybookEntry): void => {
    entries.push(entry);
  };
  const statusFor = (names: string[]): string | null =>
    [
      ...new Set(names.flatMap((name) => (pages[name] ? [pages[name]] : []))),
    ].join(", ") || null;
  const modelLocations = report.models.map((item) => item.location);
  if (report.models.length)
    add({
      title: "LLM provider",
      symptom: "429, 5xx, or timeout errors from model calls",
      locations: modelLocations,
      firstCheck:
        "Check provider status and Vercel function logs for the listed routes.",
      mitigation: report.models.some((item) => item.configuredViaEnv)
        ? "If the model ID comes from an environment variable, update it and redeploy; otherwise change the listed call sites."
        : "Change the model ID at the listed call sites and redeploy.",
      statusPage: statusFor(
        (report.services ?? [])
          .filter((item) => item.category === "llm")
          .map((item) => item.service),
      ),
    });
  if (
    report.findings.some(
      (item) =>
        item.category === "model" &&
        ["V9", "V10", "V11"].includes(item.rule ?? ""),
    )
  )
    add({
      title: "Model retired or deprecated",
      symptom: "404 or model not found from the provider",
      locations: report.findings
        .filter(
          (item) =>
            item.category === "model" &&
            ["V9", "V10", "V11"].includes(item.rule ?? ""),
        )
        .flatMap((item) =>
          item.evidence.flatMap((evidence) =>
            evidence.location ? [evidence.location] : [],
          ),
        ),
      firstCheck: "Check the model dependencies table in this report.",
      mitigation:
        "Swap to the listed replacement and re-test prompts before shipping.",
      statusPage: statusFor(
        (report.services ?? [])
          .filter((item) => item.category === "llm")
          .map((item) => item.service),
      ),
    });
  const database = (report.services ?? []).filter(
    (item) => item.category === "database",
  );
  if (database.length)
    add({
      title: "Database",
      symptom: "Connection errors or timeouts",
      locations: report.envVars
        .filter((item) =>
          database.some((service) => service.envVars.includes(item.name)),
        )
        .flatMap((item) => item.references),
      firstCheck: "Check provider status and connection limits.",
      mitigation:
        "Check pooling configuration and confirm credentials were updated in Vercel after rotation.",
      statusPage: statusFor(database.map((item) => item.service)),
    });
  if (report.crons.length)
    add({
      title: "Cron job",
      symptom: "A scheduled job stops running",
      locations: report.crons.flatMap((item) =>
        item.routeFile ? [{ file: item.routeFile, line: 1 }] : [],
      ),
      firstCheck: "Check Vercel project cron jobs and function logs.",
      mitigation:
        "Confirm the route exists, returns 2xx, and CRON_SECRET matches.",
      statusPage: pages.Vercel ?? null,
    });
  if (report.workflows.length)
    add({
      title: "Durable workflow",
      symptom: "Runs are stuck or fail to resume",
      locations: report.workflows.map((item) => item.location),
      firstCheck: "Check workflow observability and failing step logs.",
      mitigation:
        "Inspect the persistent step error; steps retry automatically.",
      statusPage: pages.Vercel ?? null,
    });
  const webhook = report.findings.filter((item) => item.category === "webhook");
  if (webhook.length)
    add({
      title: "Webhook receiver",
      symptom: "A third party reports failed deliveries",
      locations: webhook.flatMap((item) =>
        item.evidence.flatMap((evidence) =>
          evidence.location ? [evidence.location] : [],
        ),
      ),
      firstCheck: "Check the third party's webhook dashboard.",
      mitigation:
        "Confirm the registered URL uses the production domain and the signing secret matches.",
      statusPage: (report.services ?? []).some(
        (item) => item.service === "Stripe",
      )
        ? (pages.Stripe ?? null)
        : null,
    });
  const oauth = report.findings.filter((item) => item.category === "oauth");
  const authServices = (report.services ?? []).filter(
    (item) => item.category === "auth",
  );
  if (oauth.length || authServices.length)
    add({
      title: "Auth provider",
      symptom: "Users cannot sign in",
      locations: [
        ...oauth.flatMap((item) =>
          item.evidence.flatMap((evidence) =>
            evidence.location ? [evidence.location] : [],
          ),
        ),
        ...report.envVars
          .filter((item) =>
            authServices.some((service) => service.envVars.includes(item.name)),
          )
          .flatMap((item) => item.references),
      ].filter(
        (location, index, all) =>
          all.findIndex(
            (other) =>
              other.file === location.file && other.line === location.line,
          ) === index,
      ),
      firstCheck: "Check provider status and redirect URI configuration.",
      mitigation: "Confirm redirect URIs include the production domain.",
      statusPage: statusFor(
        (report.services ?? [])
          .filter((item) => item.category === "auth")
          .map((item) => item.service),
      ),
    });
  return entries;
}
