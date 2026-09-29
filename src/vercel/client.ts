import { Vercel } from "@vercel/sdk";

type ProjectResponse = Awaited<ReturnType<Vercel["projects"]["getProject"]>>;
type EnvResponse = Awaited<ReturnType<Vercel["projects"]["filterProjectEnvs"]>>;
type EnvItem =
  | Extract<EnvResponse, { key: string }>
  | Extract<EnvResponse, { envs: unknown }>["envs"][number];
type DomainResponse = Awaited<
  ReturnType<Vercel["projects"]["getProjectDomains"]>
>;
type DeploymentResponse = Awaited<
  ReturnType<Vercel["deployments"]["getDeployments"]>
>;
type TeamResponse = Awaited<ReturnType<Vercel["teams"]["getTeam"]>>;

export interface EnvMetadata {
  key: string;
  target: ("production" | "preview" | "development")[];
  type: string;
  gitBranch?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface DomainMetadata {
  name: string;
  verified: boolean;
  redirect?: string;
  gitBranch?: string;
}

export interface DeploymentMetadata {
  uid: string;
  url: string;
  createdAt: number;
  state?: string;
  commitSha?: string;
}

export interface ProjectMetadata {
  id: string;
  name: string;
  accountId: string;
  framework: string | null;
  crons?: { path: string; schedule: string }[];
  productionProtectionEnabled?: boolean;
}

export interface TeamMetadata {
  id: string;
  name: string | null;
  slug: string;
  plan?: "hobby" | "pro" | "enterprise";
}

export interface Page<T> {
  items: T[];
  next: number | null;
  complete: boolean;
  hiddenProductionEnvCount?: number;
}

export interface VercelReadClient {
  project(idOrName: string, teamId?: string): Promise<ProjectMetadata>;
  envs(idOrName: string, teamId?: string): Promise<Page<EnvMetadata>>;
  domains(
    idOrName: string,
    teamId?: string,
    since?: number,
  ): Promise<Page<DomainMetadata>>;
  productionDeployment(
    projectId: string,
    teamId?: string,
  ): Promise<DeploymentMetadata | null>;
  team(teamId: string): Promise<TeamMetadata>;
}

function sanitizeEnv(item: EnvItem): EnvMetadata {
  const targets =
    item.target === undefined
      ? []
      : Array.isArray(item.target)
        ? item.target
        : [item.target];
  return {
    key: item.key,
    target: targets,
    type: item.type,
    ...(item.gitBranch ? { gitBranch: item.gitBranch } : {}),
    ...(item.createdAt !== undefined ? { createdAt: item.createdAt } : {}),
    ...(item.updatedAt !== undefined ? { updatedAt: item.updatedAt } : {}),
  };
}

export function createVercelClient(
  token: string,
  sdk = new Vercel({ bearerToken: token }),
): VercelReadClient {
  return {
    async project(idOrName, teamId) {
      const item: ProjectResponse = await sdk.projects.getProject({
        idOrName,
        teamId,
      });
      const protectionKnown =
        item.passwordProtection !== undefined ||
        item.ssoProtection !== undefined ||
        item.trustedIps !== undefined;
      const protectsProduction = (deploymentType: string): boolean =>
        ["all", "production", "prod_deployment_urls_and_all_previews"].includes(
          deploymentType,
        );
      return {
        id: item.id,
        name: item.name,
        accountId: item.accountId,
        framework: item.framework ?? null,
        ...(protectionKnown
          ? {
              productionProtectionEnabled:
                item.passwordProtection != null ||
                (item.ssoProtection != null &&
                  protectsProduction(item.ssoProtection.deploymentType)) ||
                (item.trustedIps != null &&
                  protectsProduction(item.trustedIps.deploymentType)),
            }
          : {}),
        ...(item.crons
          ? {
              crons: item.crons.definitions.map(({ path, schedule }) => ({
                path,
                schedule,
              })),
            }
          : {}),
      };
    },
    async envs(idOrName, teamId) {
      // Do not request decryption. The SDK response type still includes `value`;
      // copy only metadata before returning anything from this boundary.
      const response: EnvResponse = await sdk.projects.filterProjectEnvs({
        idOrName,
        teamId,
        decrypt: "false",
      });
      if (!("envs" in response))
        return { items: [sanitizeEnv(response)], next: null, complete: true };
      return {
        items: response.envs.map(sanitizeEnv),
        next: "pagination" in response ? response.pagination.next : null,
        complete:
          !("pagination" in response && response.pagination.next !== null) &&
          !(
            "hiddenProductionEnvCount" in response &&
            response.hiddenProductionEnvCount > 0
          ),
        ...("hiddenProductionEnvCount" in response
          ? { hiddenProductionEnvCount: response.hiddenProductionEnvCount }
          : {}),
      };
    },
    async domains(idOrName, teamId, since) {
      const response: DomainResponse = await sdk.projects.getProjectDomains({
        idOrName,
        teamId,
        limit: 100,
        ...(since !== undefined ? { since } : {}),
      });
      return {
        items: response.domains.map((item) => ({
          name: item.name,
          verified: item.verified,
          ...(item.redirect ? { redirect: item.redirect } : {}),
          ...(item.gitBranch ? { gitBranch: item.gitBranch } : {}),
        })),
        next: response.pagination.next,
        complete: response.pagination.next === null,
      };
    },
    async productionDeployment(projectId, teamId) {
      const response: DeploymentResponse = await sdk.deployments.getDeployments(
        {
          projectId,
          target: "production",
          limit: 1,
          teamId,
        },
      );
      const item = response.deployments[0];
      if (!item) return null;
      return {
        uid: item.uid,
        url: item.url,
        createdAt: item.createdAt,
        ...(item.state ? { state: item.state } : {}),
        ...(item.meta?.githubCommitSha
          ? { commitSha: item.meta.githubCommitSha }
          : {}),
      };
    },
    async team(teamId) {
      const item: TeamResponse = await sdk.teams.getTeam({ teamId });
      return {
        id: item.id,
        name: item.name,
        slug: item.slug,
        ...(item.billing?.plan ? { plan: item.billing.plan } : {}),
      };
    },
  };
}
