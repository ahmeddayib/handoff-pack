import type {
  DeploymentMetadata,
  DomainMetadata,
  EnvMetadata,
  ProjectMetadata,
  VercelReadClient,
  TeamMetadata,
} from "./client.js";

export class VercelAuthError extends Error {}

export interface VercelCollection {
  project: ProjectMetadata | null;
  envs: EnvMetadata[];
  envsComplete: boolean;
  domains: DomainMetadata[];
  domainsComplete: boolean;
  deployment: DeploymentMetadata | null;
  deploymentChecked: boolean;
  team: TeamMetadata | null;
  limits: string[];
}

function statusCode(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("statusCode" in error))
    return null;
  return typeof error.statusCode === "number" ? error.statusCode : null;
}

function invalidToken(error: unknown): boolean {
  if (statusCode(error) === 401) return true;
  if (
    statusCode(error) !== 403 ||
    !error ||
    typeof error !== "object" ||
    !("body" in error) ||
    typeof error.body !== "string"
  )
    return false;
  try {
    const body = JSON.parse(error.body) as {
      error?: { invalidToken?: unknown };
    };
    return body.error?.invalidToken === true;
  } catch {
    return false;
  }
}

function retryDelay(error: unknown, attempt: number): number {
  if (
    error &&
    typeof error === "object" &&
    "headers" in error &&
    error.headers instanceof Headers
  ) {
    const retryAfter = error.headers.get("retry-after");
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0)
        return Math.min(seconds * 1000, 30000);
      const date = Date.parse(retryAfter);
      if (Number.isFinite(date))
        return Math.min(Math.max(date - Date.now(), 0), 30000);
    }
  }
  return Math.min(1000 * 2 ** attempt, 30000);
}

export async function collectVercel(
  client: VercelReadClient,
  idOrName: string,
  teamId?: string,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<VercelCollection> {
  const limits: string[] = [];
  async function read<T>(
    label: string,
    call: () => Promise<T>,
  ): Promise<T | null> {
    for (let attempt = 0; attempt <= 5; attempt++) {
      try {
        return await call();
      } catch (error) {
        const code = statusCode(error);
        if (invalidToken(error))
          throw new VercelAuthError("Vercel authentication failed.");
        if (code === 429 && attempt < 5) {
          await sleep(retryDelay(error, attempt));
          continue;
        }
        limits.push(
          code === 403 || code === 404
            ? `Token cannot read ${label}; ${label} checks UNVERIFIED.`
            : `${label} could not be read; ${label} checks UNVERIFIED.`,
        );
        return null;
      }
    }
    return null;
  }

  const project = await read("project", () => client.project(idOrName, teamId));
  if (!project)
    return {
      project: null,
      envs: [],
      envsComplete: false,
      domains: [],
      domainsComplete: false,
      deployment: null,
      deploymentChecked: false,
      team: null,
      limits,
    };

  const envPage = await read("environment variables", () =>
    client.envs(project.id, teamId),
  );
  const envsComplete = !!envPage?.complete;
  if (envPage && !envsComplete)
    limits.push(
      "Environment variable list is incomplete; missing-variable checks UNVERIFIED.",
    );

  const domains: DomainMetadata[] = [];
  let domainsComplete = true;
  let cursor: number | undefined;
  let domainsFinished = false;
  const seenCursors = new Set<number>();
  while (!domainsFinished) {
    const page = await read("domains", () =>
      client.domains(project.id, teamId, cursor),
    );
    if (!page) {
      domainsComplete = false;
      domainsFinished = true;
      continue;
    }
    domains.push(...page.items);
    if (!page.complete && page.next === null) {
      domainsComplete = false;
      limits.push(
        "Domain list is incomplete; domain checks UNVERIFIED for unlisted domains.",
      );
    }
    if (page.next === null) {
      domainsFinished = true;
      continue;
    }
    if (seenCursors.has(page.next)) {
      domainsComplete = false;
      limits.push(
        "Domain pagination repeated a cursor; domain checks UNVERIFIED for unlisted domains.",
      );
      domainsFinished = true;
      continue;
    }
    seenCursors.add(page.next);
    cursor = page.next;
  }

  const deploymentResult = await read("production deployment", () =>
    client.productionDeployment(project.id, teamId),
  );
  // A null deployment is a valid empty result; a failed call adds a limit.
  const deploymentChecked = !limits.some(
    (limit) =>
      limit.startsWith("Token cannot read production deployment") ||
      limit.startsWith("production deployment could not be read"),
  );
  const resolvedTeamId =
    teamId ??
    (project.accountId.startsWith("team_") ? project.accountId : null);
  const team = resolvedTeamId
    ? await read("team", () => client.team(resolvedTeamId))
    : null;
  return {
    project,
    envs: envPage?.items ?? [],
    envsComplete,
    domains,
    domainsComplete,
    deployment: deploymentResult,
    deploymentChecked,
    team,
    limits,
  };
}
