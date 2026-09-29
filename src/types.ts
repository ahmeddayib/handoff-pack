export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "INFO";

export type Verification =
  "VERIFIED" | "MISMATCH" | "UNVERIFIED" | "NOT_APPLICABLE";

export interface CodeLocation {
  file: string;
  line: number;
}

export interface Evidence {
  source: "repo" | "vercel" | "registry" | "config";
  detail: string;
  location?: CodeLocation;
}

export interface Finding {
  id: string;
  rule: string | null;
  subject: string;
  category:
    | "env"
    | "model"
    | "cron"
    | "workflow"
    | "service"
    | "webhook"
    | "oauth"
    | "domain"
    | "protection"
    | "ownership";
  title: string;
  severity: Severity;
  verification: Verification;
  evidence: Evidence[];
  action?: string;
}

export interface EnvVarRecord {
  name: string;
  references: CodeLocation[];
  declaredIn: string[];
  clientExposed: boolean;
  vercelTargets?: ("production" | "preview" | "development")[];
  vercelType?: string;
  service?: string;
  implicitReader?: string;
  status?: Verification;
}

export interface ModelRecord {
  provider: string;
  modelId: string | null;
  rawExpression: string;
  callKind:
    | "generateText"
    | "streamText"
    | "generateObject"
    | "streamObject"
    | "embed"
    | "embedMany"
    | "agent"
    | "rawSdk"
    | "unknown";
  location: CodeLocation;
  maxOutputTokens?: number;
  configuredViaEnv?: string;
  declaredOnly?: boolean;
}

export interface CronRecord {
  path: string;
  schedule: string;
  humanSchedule: string;
  routeFile?: string;
  hasGetHandler?: boolean;
  liveOnVercel?: boolean;
  status?: Verification;
}

export interface WorkflowRecord {
  name: string;
  location: CodeLocation;
  steps: { name: string; location: CodeLocation; callCount: number }[];
  sleeps: { duration: string | null; location: CodeLocation }[];
  hooks: { kind: string; location: CodeLocation }[];
  startedFrom: CodeLocation[];
}

export interface ServiceRecord {
  service: string;
  category: string;
  envVars: string[];
  packages: string[];
}

export interface OwnershipRecord {
  key: string;
  item: string;
  owner: "client" | "consultancy" | "unknown";
  action: string;
}

export interface HandoffReport {
  schemaVersion: 1;
  toolVersion: string;
  generatedAt: string;
  repo: { path: string; commitSha: string | null; branch: string | null };
  vercel: {
    projectId: string | null;
    projectName: string | null;
    teamId: string | null;
    accessed: boolean;
    plan?: "hobby" | "pro" | "enterprise";
  };
  coverage: { verified: number; mismatch: number; unverified: number };
  envVars: EnvVarRecord[];
  omittedSystemEnvVars?: string[];
  models: ModelRecord[];
  crons: CronRecord[];
  workflows: WorkflowRecord[];
  services?: ServiceRecord[];
  ownership?: OwnershipRecord[];
  findings: Finding[];
  limits: string[];
}
