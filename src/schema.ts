import { z } from "zod";

const codeLocationSchema = z.strictObject({
  file: z.string(),
  line: z.number().int().positive(),
});

const evidenceSchema = z.strictObject({
  source: z.enum(["repo", "vercel", "registry", "config"]),
  detail: z.string(),
  location: codeLocationSchema.optional(),
});

export const findingSchema = z.strictObject({
  id: z.string(),
  rule: z.string().nullable(),
  subject: z.string(),
  category: z.enum([
    "env",
    "model",
    "cron",
    "workflow",
    "service",
    "webhook",
    "oauth",
    "domain",
    "protection",
    "ownership",
  ]),
  title: z.string(),
  severity: z.enum(["CRITICAL", "HIGH", "MEDIUM", "INFO"]),
  verification: z.enum([
    "VERIFIED",
    "MISMATCH",
    "UNVERIFIED",
    "NOT_APPLICABLE",
  ]),
  evidence: z.array(evidenceSchema),
  action: z.string().optional(),
});

export const handoffReportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  toolVersion: z.string(),
  generatedAt: z.iso.datetime(),
  repo: z.strictObject({
    path: z.string(),
    commitSha: z.string().nullable(),
    branch: z.string().nullable(),
  }),
  vercel: z.strictObject({
    projectId: z.string().nullable(),
    projectName: z.string().nullable(),
    teamId: z.string().nullable(),
    accessed: z.boolean(),
    plan: z.enum(["hobby", "pro", "enterprise"]).optional(),
  }),
  coverage: z.strictObject({
    verified: z.number().int().nonnegative(),
    mismatch: z.number().int().nonnegative(),
    unverified: z.number().int().nonnegative(),
  }),
  envVars: z.array(
    z.strictObject({
      name: z.string(),
      references: z.array(codeLocationSchema),
      declaredIn: z.array(z.string()),
      clientExposed: z.boolean(),
      vercelTargets: z
        .array(z.enum(["production", "preview", "development"]))
        .optional(),
      vercelType: z.string().optional(),
      service: z.string().optional(),
      implicitReader: z.string().optional(),
      status: z
        .enum(["VERIFIED", "MISMATCH", "UNVERIFIED", "NOT_APPLICABLE"])
        .optional(),
    }),
  ),
  omittedSystemEnvVars: z.array(z.string()).optional(),
  models: z.array(
    z.strictObject({
      provider: z.string(),
      modelId: z.string().nullable(),
      rawExpression: z.string().max(120),
      callKind: z.enum([
        "generateText",
        "streamText",
        "generateObject",
        "streamObject",
        "embed",
        "embedMany",
        "agent",
        "rawSdk",
        "unknown",
      ]),
      location: codeLocationSchema,
      maxOutputTokens: z.number().optional(),
      configuredViaEnv: z.string().optional(),
      declaredOnly: z.boolean().optional(),
    }),
  ),
  crons: z.array(
    z.strictObject({
      path: z.string(),
      schedule: z.string(),
      humanSchedule: z.string(),
      routeFile: z.string().optional(),
      hasGetHandler: z.boolean().optional(),
      liveOnVercel: z.boolean().optional(),
      status: z
        .enum(["VERIFIED", "MISMATCH", "UNVERIFIED", "NOT_APPLICABLE"])
        .optional(),
    }),
  ),
  workflows: z.array(
    z.strictObject({
      name: z.string(),
      location: codeLocationSchema,
      steps: z.array(
        z.strictObject({
          name: z.string(),
          location: codeLocationSchema,
          callCount: z.number().int().positive().default(1),
        }),
      ),
      sleeps: z.array(
        z.strictObject({
          duration: z.string().nullable(),
          location: codeLocationSchema,
        }),
      ),
      hooks: z.array(
        z.strictObject({ kind: z.string(), location: codeLocationSchema }),
      ),
      startedFrom: z.array(codeLocationSchema),
    }),
  ),
  services: z
    .array(
      z.strictObject({
        service: z.string(),
        category: z.string(),
        envVars: z.array(z.string()),
        packages: z.array(z.string()),
      }),
    )
    .optional(),
  ownership: z
    .array(
      z.strictObject({
        key: z.string(),
        item: z.string(),
        owner: z.enum(["client", "consultancy", "unknown"]),
        action: z.string(),
      }),
    )
    .optional(),
  findings: z.array(findingSchema),
  limits: z.array(z.string()),
});
