# SPEC: `handoff-pack` — Operating Runbook Generator for AI Apps on Vercel

Version: 1.0 (weekend MVP)
Audience: a coding agent building this from scratch.
Read this whole document before writing code. Where this spec says **VERIFY**, check the real API or package before implementing; do not guess.

---

## 0. Context and goal

AI consultancies ship production AI apps for clients on fixed timelines (for example, 90 days), then hand the system over. At handoff the client must operate the system alone. Today that handoff is a hand-written doc that goes stale immediately and misses things: env vars that only exist in the Vercel dashboard, API keys still billed to the consultancy, durable workflows paused mid-run, model IDs that will be retired next quarter.

`handoff-pack` is a CLI (plus an optional GitHub Action) that reads a repository and its Vercel project and produces an **operating runbook** where every claim is either **verified against the live deployment** or explicitly marked as unverified.

The core differentiator versus "ask a coding agent to write a runbook": this tool **checks what is actually deployed**, deterministically, and says so line by line. It does not use an LLM to write prose in the MVP.

### Target stack of scanned repos (MVP)

- Next.js (App Router and Pages Router), TypeScript or JavaScript
- Vercel AI SDK (`ai`, `@ai-sdk/*`), including AI Gateway string model IDs
- Vercel Workflow DevKit (`workflow` package, `"use workflow"` / `"use step"` directives)
- Deployed on Vercel

### Non-goals (MVP)

- Never read, print, store, or transmit secret **values**. Names and metadata only.
- No LLM calls anywhere in the pipeline.
- No auto-fixing code or changing Vercel settings. Read-only everywhere.
- No Python, Go, or non-JS repos. Detect and report "unsupported language" instead.
- No live traffic or cost telemetry beyond what is described in §10.

---

## 1. Tech stack and repository layout

- Language: TypeScript, strict mode. Runtime: Node.js 20+.
- Package manager: pnpm.
- CLI framework: `commander`.
- AST parsing: `ts-morph` (handles TS and JS). Do not use regex for code scanning except where noted as fallback.
- Vercel API: official `@vercel/sdk`. **VERIFY** method names and response field names against the installed SDK's TypeScript types; the endpoint list in §6 is the intent, the SDK types are the source of truth.
- Validation: `zod` for config, data files, and the JSON output schema.
- Cron descriptions: `cronstrue`.
- Markdown rendering: plain template functions (no templating engine needed).
- Tests: `vitest`.
- Lint/format: `eslint` + `prettier` (defaults are fine).

```
handoff-pack/
  package.json
  tsconfig.json
  src/
    cli.ts                     # commander entrypoint
    config.ts                  # load + validate handoff.config.json
    types.ts                   # all shared types (§3)
    pipeline.ts                # orchestrates collect → verify → enrich → render
    scanners/
      project.ts               # detect framework, router, language, package deps
      envVars.ts
      models.ts
      crons.ts
      workflows.ts
      services.ts              # external services + webhooks + OAuth
    vercel/
      client.ts                # thin wrapper over @vercel/sdk, read-only
      collect.ts               # fetch project, env metadata, domains, deployments, crons
    verify/
      rules.ts                 # all verification rules (§7)
    enrich/
      modelRegistry.ts         # deprecation + pricing (§9)
      cost.ts                  # §10
      playbook.ts              # failure playbook templates (§11)
      ownership.ts             # ownership transfer checklist (§8)
    render/
      markdown.ts              # HANDOFF.md (§12.1)
      json.ts                  # handoff.json (§12.2)
    action/
      diff.ts                  # compare two handoff.json files (§13)
      github.ts                # open PR / issue via GitHub REST
  data/
    models.json                # bundled model registry fallback (§9)
    services.json              # env-var-name → service map (§5.5)
    statusPages.json           # service → status page URL (§11)
  action.yml                   # GitHub Action definition (§13)
  test/
    fixtures/                  # small fake repos, one per scenario (§15)
    *.test.ts
  README.md
```

---

## 2. CLI interface

```
handoff-pack generate [options]

Options:
  --repo <path>              Path to repository root (default: ".")
  --vercel-project <idOrName> Vercel project id or name (optional; enables verification)
  --vercel-team <teamId>     Vercel team id (optional)
  --out <dir>                Output directory (default: "./handoff")
  --offline                  Skip all network calls (no Vercel, no registry fetch)
  --avg-input-tokens <n>     Cost model assumption (default: 1000)
  --avg-output-tokens <n>    Cost model assumption (default: 500)
  --deprecation-window <days> Flag models retiring within N days as HIGH (default: 90)
  --format <md|json|both>    Default: both
  --verbose

handoff-pack diff <old.json> <new.json>   Print a human-readable diff (used by the Action)
```

Auth: read the Vercel token from env var `VERCEL_TOKEN`. Never accept it as a CLI flag (it would land in shell history). If `--vercel-project` is set but `VERCEL_TOKEN` is missing, exit with code 2 and a clear message.

Exit codes:
- `0` success, no CRITICAL findings
- `1` success, at least one CRITICAL finding (lets CI fail on it)
- `2` usage or configuration error
- `3` unexpected internal error

### Optional config file: `handoff.config.json` (repo root)

```json
{
  "clientName": "Acme Corp",
  "consultancyName": "Example Consulting",
  "ownership": {
    "OPENAI_API_KEY": "client",
    "vercel-team": "consultancy",
    "domain:app.acme.com": "client"
  },
  "ignoreEnvVars": ["VERCEL_URL"],
  "ignorePaths": ["scripts/**"],
  "modelOverrides": {
    "my-internal-alias": { "provider": "openai", "modelId": "gpt-4o" }
  }
}
```

`ownership` values: `"client" | "consultancy" | "unknown"`. Validate with zod; unknown keys are an error (strict schema).

---

## 3. Core data model (`src/types.ts`)

Every piece of output is a `Finding` with evidence. Rendering never invents information that is not in a `Finding`.

```ts
export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "INFO";

export type Verification =
  | "VERIFIED"       // confirmed against the live Vercel project or registry
  | "MISMATCH"       // repo and live state disagree
  | "UNVERIFIED"     // could not check (offline, no access, unknown to registry)
  | "NOT_APPLICABLE";

export interface CodeLocation {
  file: string;      // repo-relative, forward slashes
  line: number;      // 1-based
}

export interface Evidence {
  source: "repo" | "vercel" | "registry" | "config";
  detail: string;          // short, human readable, no secret values
  location?: CodeLocation;
}

export interface Finding {
  id: string;              // stable: `${category}:${key}` e.g. "env:OPENAI_API_KEY"
  rule: string | null;     // verification rule that produced it, e.g. "V1"; null for non-rule findings (ownership, playbook)
  subject: string;         // the thing the finding is about: env var name, cron path, model id, domain, file path
  category:
    | "env" | "model" | "cron" | "workflow" | "service"
    | "webhook" | "oauth" | "domain" | "protection" | "ownership";
  title: string;
  severity: Severity;
  verification: Verification;
  evidence: Evidence[];
  action?: string;         // what a human should do, imperative, one sentence
}

export interface EnvVarRecord {
  name: string;
  references: CodeLocation[];
  declaredIn: string[];            // e.g. [".env.example", "src/env.ts"]
  clientExposed: boolean;          // NEXT_PUBLIC_ prefix or t3-env client block
  vercelTargets?: ("production" | "preview" | "development")[];
  vercelType?: string;             // as reported by API, e.g. "encrypted", "sensitive", "plain"
  service?: string;                // from data/services.json
}

export interface ModelRecord {
  provider: string;                // "openai", "anthropic", "google", ...
  modelId: string | null;          // null if unresolved
  rawExpression: string;           // source text, truncated to 120 chars
  callKind: "generateText" | "streamText" | "generateObject" | "streamObject"
          | "embed" | "embedMany" | "agent" | "rawSdk" | "unknown";
  location: CodeLocation;
  maxOutputTokens?: number;        // if a literal is passed
  configuredViaEnv?: string;       // env var name if model id comes from env
}

export interface CronRecord {
  path: string;
  schedule: string;
  humanSchedule: string;           // cronstrue output + " (UTC)"
  routeFile?: string;
  hasGetHandler?: boolean;
  liveOnVercel?: boolean;
}

export interface WorkflowRecord {
  name: string;
  location: CodeLocation;
  steps: { name: string; location: CodeLocation }[];
  sleeps: { duration: string | null; location: CodeLocation }[];
  hooks: { kind: string; location: CodeLocation }[];   // hook / webhook creation calls
  startedFrom: CodeLocation[];     // call sites of start(thisWorkflow, ...)
}

export interface HandoffReport {
  schemaVersion: 1;
  toolVersion: string;
  generatedAt: string;             // ISO 8601
  repo: { path: string; commitSha: string | null; branch: string | null };
  vercel: { projectId: string | null; projectName: string | null; teamId: string | null; accessed: boolean };
  coverage: { verified: number; mismatch: number; unverified: number };
  envVars: EnvVarRecord[];
  models: ModelRecord[];
  crons: CronRecord[];
  workflows: WorkflowRecord[];
  findings: Finding[];
  limits: string[];                // honest list of what was not scanned and why
}
```

---

## 4. Pipeline (`src/pipeline.ts`)

Run in this exact order. Each stage is a pure function of its inputs plus I/O at the edges, so each can be unit tested.

1. **Detect project** (`scanners/project.ts`): read `package.json`; detect Next.js version, App vs Pages router (presence of `app/` or `src/app/` vs `pages/` or `src/pages/`), TS vs JS, presence of `ai`, `@ai-sdk/*`, `workflow`. If not a JS/TS project, write a report with a single CRITICAL finding "Unsupported project type" and exit 1.
2. **Repo scanners** (parallel): envVars, models, crons, workflows, services.
3. **Vercel collect** (skip if `--offline` or no project flag).
4. **Model registry load** (skip network fetch if `--offline`; always fall back to bundled data).
5. **Verify** (§7): produce `Finding`s by reconciling repo records with Vercel data and the registry.
6. **Enrich**: ownership checklist (§8), cost (§10), failure playbook (§11).
7. **Render**: `handoff/HANDOFF.md` and `handoff/handoff.json`.
8. Compute exit code from severities.

Respect `ignorePaths` and always ignore: `node_modules`, `.next`, `.vercel`, `dist`, `build`, `coverage`, `.git`, and test files matching `**/*.{test,spec}.{ts,tsx,js,jsx}` (report test-only references separately as INFO, not as production usage).

---

## 5. Repo scanners

### 5.1 Environment variables (`scanners/envVars.ts`)

Detect references via AST:
- `process.env.NAME`
- `process.env["NAME"]` and `process.env['NAME']`
- Destructuring: `const { NAME, OTHER } = process.env`
- `import.meta.env.NAME`
- t3-env / `@t3-oss/env-nextjs`: keys inside `createEnv({ server: {...}, client: {...}, runtimeEnv: {...} })`. Keys in `client` are `clientExposed: true`.
- Dynamic access (`process.env[someVar]`): record a `limits` entry with the location; do not guess.

Detect declarations (not usage) in: `.env.example`, `.env.sample`, `.env.template`, `.env.local.example`. Parse `NAME=` lines only; **never read** `.env`, `.env.local`, `.env.production`, or any file without an example/sample/template marker. If such files are committed to the repo, emit a CRITICAL finding "Env file committed to repository" with the file path only (do not open it).

Rules:
- `clientExposed = name.startsWith("NEXT_PUBLIC_") || inT3ClientBlock`.
- Ignore Vercel system vars: `VERCEL`, `VERCEL_ENV`, `VERCEL_URL`, `VERCEL_BRANCH_URL`, `VERCEL_PROJECT_PRODUCTION_URL`, `VERCEL_REGION`, `VERCEL_DEPLOYMENT_ID`, `VERCEL_OIDC_TOKEN`, `VERCEL_GIT_*`, `NODE_ENV`, `CI`, `NEXT_RUNTIME`, plus `config.ignoreEnvVars`.
- Map to service via `data/services.json` (§5.5).

### 5.2 Model dependencies (`scanners/models.ts`)

Detect, via AST:

**A. AI SDK provider factory calls.** Imports from `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/mistral`, `@ai-sdk/xai`, `@ai-sdk/groq`, `@ai-sdk/amazon-bedrock`, `@ai-sdk/azure`, `@ai-sdk/gateway`. Track the local binding name (handles `import { openai } from ...`, `import { createOpenAI } ...; const myOpenai = createOpenAI(...)`). Match:
- `openai("id")`, `anthropic("id")`, etc.
- Member forms: `openai.chat("id")`, `openai.responses("id")`, `openai.completion("id")`, `openai.embedding("id")`, `openai.textEmbeddingModel("id")`, `openai.image("id")`. Treat any member call on a provider binding whose first argument is a string as a model reference. **VERIFY** current member names in the installed `@ai-sdk/*` packages and add any missing ones.
- `gateway("provider/model")`.

**B. AI SDK gateway string IDs.** A string literal matching `^[a-z0-9-]+/[A-Za-z0-9._:-]+$` passed as the `model` property of the options object to `generateText`, `streamText`, `generateObject`, `streamObject`, `embed`, `embedMany`, or to an agent class constructor imported from `ai` (**VERIFY** agent class export names in the installed `ai` version). Split on the first `/` into provider and modelId.

**C. Raw provider SDKs.** `new OpenAI(...)` from `openai` then `x.chat.completions.create({ model: "..." })`, `x.responses.create({ model })`, `x.embeddings.create({ model })`; `new Anthropic(...)` from `@anthropic-ai/sdk` then `x.messages.create({ model })`. `callKind: "rawSdk"`.

**Resolving the model ID:**
- String literal → resolved.
- Identifier → follow to a `const` initialized with a string literal in the same file, or an exported `const` imported from another file in the repo (one hop only). Otherwise unresolved.
- Template literal with no substitutions → resolved. With substitutions → unresolved.
- `process.env.X` or `process.env.X ?? "literal"` → set `configuredViaEnv: "X"`; if there is a literal fallback, record it as `modelId` and note "default; production value comes from env var X and was not read".
- Apply `config.modelOverrides` for known aliases.
- Unresolved → `modelId: null`, emit INFO finding with location: "Dynamic model ID; verify manually."

Record `maxOutputTokens` (and legacy `maxTokens`) if passed as a numeric literal in the same options object.

Enclosing call detection: walk up from the model expression to the nearest call expression whose callee name is one of the AI SDK functions above; else `callKind: "unknown"`.

### 5.3 Cron jobs (`scanners/crons.ts`)

- Parse `vercel.json` → `crons: [{ path, schedule }]`. If a `vercel.ts` config exists, add a `limits` entry "vercel.ts detected; crons in it were not parsed" (do not execute it).
- `humanSchedule = cronstrue.toString(schedule) + " (UTC)"`. Vercel cron schedules run in UTC; state that explicitly.
- Resolve `routeFile`: strip query string from `path`; look for `app/<path>/route.{ts,js}` or `src/app/<path>/route.{ts,js}`, then `pages/api/...` equivalents.
- `hasGetHandler`: App Router → route file exports a `GET` function/const. Pages Router → default export exists (method not statically knowable; set `true` and note it).
- Detect whether the route checks `CRON_SECRET` (reference to `process.env.CRON_SECRET` in the route file). If not, MEDIUM finding "Cron endpoint does not check CRON_SECRET; it can be triggered by anyone."

### 5.4 Durable workflows (`scanners/workflows.ts`)

Only run if the `workflow` package is a dependency.

- A **workflow function** is a function (declaration, expression, or arrow) whose body's first statement is the expression statement `"use workflow"`. Same for **steps** with `"use step"`.
- For each workflow function, find within its body:
  - calls to the function imported as `sleep` from `"workflow"` → record literal duration argument (string like `"3d"` or number) or `null`.
  - calls to hook/webhook creation functions imported from `"workflow"` → **VERIFY** the exact export names in the installed package (expected to include hook and webhook creators); record `kind` as the imported name.
  - calls to step functions (identifiers that resolve to a `"use step"` function) → steps list.
- `startedFrom`: call sites of the function imported as `start` from `"workflow/api"` (**VERIFY** module path) whose first argument resolves to this workflow.
- Emit an INFO finding per workflow that contains any sleep ≥ 1 hour or any hook: "This workflow can be paused for long periods. Runs in progress at handoff will continue after the handoff."

### 5.5 External services, webhooks, OAuth (`scanners/services.ts`)

`data/services.json` maps env var name patterns and package names to services:

```json
[
  { "service": "OpenAI", "envPatterns": ["^OPENAI_"], "packages": ["openai", "@ai-sdk/openai"], "category": "llm" },
  { "service": "Anthropic", "envPatterns": ["^ANTHROPIC_"], "packages": ["@anthropic-ai/sdk", "@ai-sdk/anthropic"], "category": "llm" },
  { "service": "Google AI", "envPatterns": ["^GOOGLE_GENERATIVE_AI_"], "packages": ["@ai-sdk/google"], "category": "llm" },
  { "service": "Vercel AI Gateway", "envPatterns": ["^AI_GATEWAY_"], "packages": ["@ai-sdk/gateway"], "category": "llm" },
  { "service": "Postgres", "envPatterns": ["^DATABASE_URL$", "^POSTGRES_"], "packages": ["pg", "postgres", "@neondatabase/serverless", "drizzle-orm", "@prisma/client"], "category": "database" },
  { "service": "Supabase", "envPatterns": ["^SUPABASE_", "^NEXT_PUBLIC_SUPABASE_"], "packages": ["@supabase/supabase-js"], "category": "database" },
  { "service": "Redis/KV", "envPatterns": ["^KV_", "^UPSTASH_REDIS_", "^REDIS_URL$"], "packages": ["@upstash/redis", "@vercel/kv", "redis", "ioredis"], "category": "database" },
  { "service": "Vercel Blob", "envPatterns": ["^BLOB_READ_WRITE_TOKEN$"], "packages": ["@vercel/blob"], "category": "storage" },
  { "service": "Stripe", "envPatterns": ["^STRIPE_"], "packages": ["stripe"], "category": "payments" },
  { "service": "Resend", "envPatterns": ["^RESEND_"], "packages": ["resend"], "category": "email" },
  { "service": "Slack", "envPatterns": ["^SLACK_"], "packages": ["@slack/web-api", "@slack/bolt"], "category": "messaging" },
  { "service": "Clerk", "envPatterns": ["^CLERK_", "^NEXT_PUBLIC_CLERK_"], "packages": ["@clerk/nextjs"], "category": "auth" },
  { "service": "Auth.js", "envPatterns": ["^AUTH_", "^NEXTAUTH_"], "packages": ["next-auth", "@auth/core"], "category": "auth" },
  { "service": "Sentry", "envPatterns": ["^SENTRY_", "^NEXT_PUBLIC_SENTRY_"], "packages": ["@sentry/nextjs"], "category": "observability" },
  { "service": "Langfuse", "envPatterns": ["^LANGFUSE_"], "packages": ["langfuse", "langfuse-vercel"], "category": "observability" }
]
```

The agent may extend this list; keep it data, not code.

**Webhook receivers** (things registered at a third party that point at this deployment's URL):
- Route files whose path contains `webhook` or `webhooks`.
- Any file calling `stripe.webhooks.constructEvent` (or `constructEventAsync`).
- Any file referencing `SLACK_SIGNING_SECRET`.
- Workflow webhooks from §5.4.
Each → `Finding` category `webhook` with the route path and action "Re-register this webhook URL in <service> under the client's account and the client's production domain."

**OAuth apps**: env vars matching `^AUTH_[A-Z]+_ID$`, `^(GITHUB|GOOGLE|AZURE_AD|MICROSOFT)_CLIENT_ID$`, `^NEXTAUTH_` → `Finding` category `oauth`, action "Confirm the OAuth app is registered under the client's organization; update redirect URIs to the client's production domain."

---

## 6. Vercel collector (`src/vercel/`)

Read-only. Use `@vercel/sdk`. Pass `teamId` when provided. Handle pagination and 429 (respect rate-limit headers; exponential backoff, max 5 retries).

Intended data (**VERIFY** exact SDK methods and field names against the SDK's types):

| Data | Intended REST endpoint | Fields used |
|---|---|---|
| Project | `GET /v9/projects/{idOrName}` | id, name, framework, accountId/team, protection settings (SSO / password / trusted IPs), cron definitions if present |
| Env var metadata | `GET /v10/projects/{idOrName}/env` | key, target(s), type, gitBranch, createdAt, updatedAt. **Never** call with decrypt enabled. Never read `value`; drop it from the object immediately if returned. |
| Domains | `GET /v9/projects/{idOrName}/domains` | name, verified, redirect, gitBranch |
| Latest production deployment | `GET /v6/deployments?projectId=…&target=production&limit=1` | uid, url, createdAt, meta.githubCommitSha (or equivalent), state |
| Team | team endpoint via SDK | team name/slug (for ownership checklist) |

If any call returns 403/404, record it in `limits` (e.g., "Token cannot read domains; domain checks UNVERIFIED") and continue. Never crash on partial access.

Token guidance for README: recommend a token scoped to the single team, read-only usage, expiring within 7 days.

---

## 7. Verification rules (`src/verify/rules.ts`)

Each rule is a pure function `(ctx) => Finding[]`. Implement exactly these for the MVP:

| # | Rule | Severity | Verification |
|---|---|---|---|
| V1 | Env var referenced in production code but absent from Vercel `production` target | CRITICAL | MISMATCH |
| V2 | Env var referenced in code, present in Vercel production | INFO (rolled into env table, not listed as finding) | VERIFIED |
| V3 | Env var in Vercel but not referenced anywhere in code | INFO ("possibly orphaned") | VERIFIED |
| V4 | `clientExposed` var whose name matches `/(SECRET|PRIVATE|PASSWORD|TOKEN|_KEY$)/` and is not a known publishable key (allowlist `NEXT_PUBLIC_*PUBLISHABLE_KEY`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SENTRY_DSN`) | HIGH | VERIFIED if in Vercel, else UNVERIFIED |
| V5 | Secret-like var stored in Vercel with type `plain` (**VERIFY** the type enum values) | MEDIUM | VERIFIED |
| V6 | Env var declared in `.env.example` but never referenced | INFO | NOT_APPLICABLE |
| V7 | Cron in `vercel.json` with no matching route file or no GET handler | CRITICAL | MISMATCH |
| V8 | Cron in `vercel.json` not present in the live project's cron definitions (only if API exposes them) | HIGH | MISMATCH |
| V9 | Model ID found in registry with status `retired` | CRITICAL | VERIFIED |
| V10 | Model ID `deprecated` with retirement date within `--deprecation-window` days | HIGH | VERIFIED |
| V11 | Model ID `deprecated` with retirement date beyond the window, or `legacy` | MEDIUM | VERIFIED |
| V12 | Model ID `active` | INFO (table only) | VERIFIED |
| V13 | Model ID not in registry | MEDIUM | UNVERIFIED |
| V14 | Model ID unresolved (dynamic) | MEDIUM | UNVERIFIED |
| V15 | Production deployment protection fully disabled (informational; many public apps are intentionally public) | INFO | VERIFIED |
| V16 | Domain attached but not verified | HIGH | MISMATCH |
| V17 | Latest production deployment commit SHA differs from the scanned repo HEAD | MEDIUM ("Report describes a commit that is not what's in production") | MISMATCH |
| V18 | Committed `.env`-style file (from §5.1) | CRITICAL | VERIFIED |

When Vercel is not accessed, every rule that needs Vercel data emits nothing for that aspect, and the env table shows `UNVERIFIED` in its status column.

`coverage` counts are computed over rows in the env, model, and cron tables (not over findings).

---

## 8. Ownership transfer checklist (`src/enrich/ownership.ts`)

The tool cannot know who owns an account. It **enumerates every item that has an owner** and shows the owner from `handoff.config.json` if annotated, else `unknown`. Items:

1. **Vercel project/team**: "Project lives in team `<team name>`. Transfer the project to the client's team or confirm the client will own this team."
2. **One item per service** detected in §5.5 that has at least one env var: "`<SERVICE>` credentials (`VAR_A`, `VAR_B`): confirm the account belongs to the client. After transfer, rotate the keys."
3. **One item per domain** from Vercel: "Domain `<name>`: confirm the client controls the registrar and DNS."
4. **Git repository**: read `git remote get-url origin` (host/org/repo only, strip any credentials in the URL). "Repository is hosted at `<org>/<repo>`. Transfer to the client's organization or grant admin access."
5. **One item per webhook receiver** (§5.5).
6. **One item per OAuth app** (§5.5).
7. **Durable workflows** (if any): "In-flight workflow runs will continue after handoff and will use whichever credentials are configured at resume time. Rotate credentials before or after, deliberately."

Render as a Markdown checklist (`- [ ]`) with an Owner column. Items with owner `consultancy` are HIGH findings; `unknown` are MEDIUM; `client` are INFO and pre-checked (`- [x]`).

---

## 9. Model registry: deprecation and pricing (`src/enrich/modelRegistry.ts`)

### 9.1 Sources

1. **Remote**: the open registry published by the `llm-model-deprecation` project (GitHub: techdevsynergy/llm-model-deprecation). **VERIFY**: locate the exact raw JSON URL of its data registry in that repo, confirm its schema, and **confirm its license permits reuse**; credit it in README and in the report footer. Cache the fetched file to `~/.cache/handoff-pack/registry.json` with a 24h TTL.
2. **Bundled fallback**: `data/models.json` (schema below). Always loaded. Remote entries override bundled entries on (provider, modelId) match, except pricing fields, which only come from bundled data.

### 9.2 Bundled schema (`data/models.json`)

```json
{
  "verifiedAt": "YYYY-MM-DD",
  "models": [
    {
      "provider": "openai",
      "modelId": "example-model-id",
      "aliases": [],
      "status": "active",
      "deprecationDate": null,
      "retirementDate": null,
      "replacement": null,
      "inputUsdPerMTok": null,
      "outputUsdPerMTok": null,
      "source": "https://…provider deprecation or pricing page…"
    }
  ]
}
```

`status`: `"active" | "legacy" | "deprecated" | "retired"`. The agent must populate this file from the providers' official deprecation and pricing pages for OpenAI, Anthropic, and Google, covering at minimum the ~30 most common current and recently deprecated model IDs. Every entry needs a `source` URL. Do not invent prices; leave `null` if not found. Validate with zod on load; a malformed file is a startup error.

### 9.3 Matching

Normalize: lowercase; strip a leading `models/` (Google style). Match on exact `(provider, modelId)` first, then aliases. For gateway IDs, the provider prefix is the gateway provider name (e.g., `openai/…`). Also try matching dated snapshot IDs to their base ID only if the registry marks the base as covering snapshots; otherwise treat as not found (V13). Never fuzzy-match.

### 9.4 Replacement cost delta

If a flagged model has a `replacement` and both have prices, compute cost per 1,000 requests for both (§10) and render "switching changes estimated cost from $X to $Y per 1,000 requests".

---

## 10. Cost estimate (`src/enrich/cost.ts`)

Per model call site with a resolved, priced model:

```
outputTokens = maxOutputTokens (if literal found) ?? avgOutputTokens
costPer1k = 1000 * (avgInputTokens * inputUsdPerMTok + outputTokens * outputUsdPerMTok) / 1_000_000
```

- Round to 2 decimal places, display as `$X.XX per 1,000 requests`.
- When `maxOutputTokens` was used, label it "upper bound (uses maxOutputTokens)".
- Embeddings: input-only cost.
- Always print the assumptions used at the top of the cost section.
- If price is unknown: "price unknown".
- Do **not** estimate monthly totals. Instead render a one-line formula the client can fill in: `monthly ≈ (requests per month ÷ 1,000) × cost per 1,000`.
- AI Gateway spend data is out of scope for MVP; add to `limits`: "Actual spend not read; if the project uses Vercel AI Gateway, check its usage dashboard."

---

## 11. Failure playbook (`src/enrich/playbook.ts`)

Deterministic templates keyed by dependency category. Fill in real names and code locations from findings. No LLM. One subsection per dependency actually detected (not a generic list).

Template fields: **Symptom**, **Where it's used** (file:line list, max 5 then "and N more"), **First check**, **Mitigation**, **Status page**.

| Category | Symptom | First check | Mitigation |
|---|---|---|---|
| LLM provider | 429 / 5xx / timeouts from model calls | Provider status page; Vercel function logs for the routes listed | If the model ID is read from an env var, switch it there and redeploy; otherwise change it at the listed locations |
| Model retired | 404 or "model not found" from provider | This report's model table | Swap to the listed replacement; re-test prompts before shipping |
| Database | Connection errors, timeouts | Provider status page; connection limits | Check pooling configuration; confirm credentials were not rotated without updating Vercel |
| Cron job | Job silently stops running | Vercel project → cron jobs / logs | Confirm the route still exists and returns 2xx; confirm `CRON_SECRET` matches |
| Durable workflow | Runs stuck or not resuming | Workflow observability UI (**VERIFY** current CLI command, e.g. `npx workflow web`) | Check the failing step's logs; steps retry automatically, so look for a persistent error |
| Webhook receiver | Third party reports failed deliveries | Third party's webhook dashboard | Confirm the registered URL points at the current production domain and the signing secret matches |
| Auth provider | Users cannot sign in | Provider status page; redirect URI config | Confirm redirect URIs include the production domain |

`data/statusPages.json` maps service → status page URL. **VERIFY** each URL resolves before committing it; omit any you cannot confirm.

---

## 12. Output

### 12.1 `handoff/HANDOFF.md` structure (exact section order)

```
# Operating Runbook: <project name>

> Generated by handoff-pack <version> on <date> from commit <sha> (branch <branch>).
> Vercel project: <name> (<accessed | not accessed>).
> Verification coverage: <V> verified · <M> mismatches · <U> unverified.

## 1. Action items
(All CRITICAL and HIGH findings, CRITICAL first, each with its `action`. If none: "No critical or high-severity items.")

## 2. Ownership transfer checklist
| | Item | Owner | Action |

## 3. Environment variables
| Name | Service | Used in | Vercel targets | Type | Client-exposed | Status |
("Used in": up to 3 file:line, then "+N")

## 4. Scheduled jobs (crons)
| Path | Schedule | Runs | Route file | Checks CRON_SECRET | Status |

## 5. Durable workflows
Per workflow: name, file, steps, sleeps, hooks/webhooks, started from.

## 6. Model dependencies
| Provider | Model | Call sites | Status | Retires | Replacement | Est. cost / 1k requests |
Assumptions line above the table.

## 7. External services
| Service | Category | Env vars | Packages |

## 8. Failure playbook
One subsection per detected dependency (§11).

## 9. Scan limits
Bullet list of `limits` entries. This section is mandatory, even if short.

---
Model deprecation data: llm-model-deprecation registry (credit + link) and bundled data verified <date>.
```

Status column values render as: `✅ Verified`, `❌ Mismatch`, `⚠️ Unverified`, `—`.

Markdown must render correctly on GitHub. Escape `|` in table cells.

### 12.2 `handoff/handoff.json`

The full `HandoffReport` object (§3), validated against a zod schema before writing. Sorted deterministically (by id / name / file / line) so diffs are stable. No timestamps other than `generatedAt`.

---

## 13. GitHub Action (stretch goal — build only after §16 Day 2 core is done)

`action.yml`, `runs.using: node20`, bundled with `@vercel/ncc` into `dist/index.js`.

Inputs:
- `vercel-token` (secret, optional)
- `vercel-project` (optional)
- `vercel-team` (optional)
- `mode`: `report` | `pr` | `issue` (default `pr`)
- `deprecation-window-days` (default `90`)

Behavior:
1. Run `generate` into a temp dir.
2. Load committed `handoff/handoff.json` if present; run `diff`.
3. `mode: pr` and diff is non-empty → create branch `handoff-pack/update-<yyyymmdd>`, commit new `handoff/`, open a PR titled `Runbook update: <N> changes` with the diff summary as the body. If an open PR from a `handoff-pack/update-*` branch exists, update it instead of opening another.
4. For each model finding V9/V10 not already covered by an open issue with label `handoff-pack:deprecation` and the same title → open an issue:

```
Title: Model <provider>/<modelId> retires on <date>

<modelId> is used in <N> place(s):
- path/to/file.ts:42
- …

Status: <deprecated|retired> · Retirement date: <date> (<D> days from now)
Suggested replacement: <replacement or "none listed">
Estimated cost change: $X.XX → $Y.YY per 1,000 requests (assumptions: …)
Source: <registry source URL>

Test prompts against the replacement before switching.
```

Required workflow permissions (document in README): `contents: write`, `pull-requests: write`, `issues: write`.

Example workflow to include in README:

```yaml
name: handoff-pack
on:
  schedule: [{ cron: "0 14 * * 1" }]
  workflow_dispatch:
permissions:
  contents: write
  pull-requests: write
  issues: write
jobs:
  runbook:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: <owner>/handoff-pack@v1
        with:
          vercel-token: ${{ secrets.VERCEL_TOKEN }}
          vercel-project: my-project
```

---

## 14. Security and privacy requirements (non-negotiable)

1. Never read secret values: never call Vercel env endpoints with decryption; never open `.env`, `.env.local`, `.env.production`, `.env.development`, or any env file not marked example/sample/template.
2. If an API response contains a `value` field for an env var, delete it before the object leaves `vercel/client.ts`. Add a unit test that asserts no `value` key survives.
3. Strip credentials from git remote URLs before output.
4. Network calls allowed: `api.vercel.com` (only with a token and a project flag), the single registry URL (§9.1), and GitHub API in Action mode. Nothing else. `--offline` makes zero network calls; add a test that stubs `fetch` and asserts it is never called in offline mode.
5. No telemetry.
6. Truncate any source excerpt (`rawExpression`) to 120 characters.

---

## 15. Testing

Fixtures in `test/fixtures/`, each a minimal fake repo:

- `basic-ai-sdk/`: App Router, `openai("…")` literal, `anthropic` via const, gateway string ID, `process.env.MODEL ?? "…"`, t3-env with a client block.
- `crons/`: `vercel.json` with 3 crons: one valid with CRON_SECRET check, one valid without it, one pointing at a missing route.
- `workflows/`: one workflow with 2 steps, `sleep("3d")`, a hook, and a `start()` call site.
- `leaky/`: a `NEXT_PUBLIC_…_SECRET` reference, a committed `.env` file (contents: `X=do-not-read`; test asserts the string never appears in output), a Stripe webhook route.
- `unsupported/`: a Python project.

Tests:
- One unit test file per scanner asserting exact records.
- Rule tests (§7) with hand-built contexts, including Vercel data mocks.
- Snapshot test of `HANDOFF.md` for `basic-ai-sdk` in offline mode (use a fixed clock and fixed tool version).
- Security tests from §14 (items 2 and 4, plus the `.env` fixture assertion).
- `diff` test: two JSON reports → expected human-readable output.

All tests must pass with `pnpm test` and no network.

---

## 16. Build order (weekend) with acceptance criteria

### Day 1 (Saturday): offline end to end

1. Scaffold repo, tsconfig, CLI skeleton, types, zod schemas. **Done when** `handoff-pack generate --offline` writes an empty but valid report.
2. `project.ts` + `envVars.ts`. **Done when** fixtures `basic-ai-sdk` and `leaky` produce correct env records.
3. `models.ts`. **Done when** all four model reference styles in `basic-ai-sdk` resolve correctly, including the env-var default case.
4. `crons.ts` + `workflows.ts`. **Done when** the `crons` and `workflows` fixtures pass.
5. `data/models.json` populated with sourced entries; `modelRegistry.ts` with bundled data only. **Done when** V9–V14 fire correctly in tests.
6. `markdown.ts` + `json.ts`. **Done when** the snapshot test passes and the output reads cleanly on GitHub.

### Day 2 (Sunday): live verification and the handoff-specific value

7. `vercel/client.ts` + `collect.ts` against a real deployed project. **Done when** V1, V3, V16, V17 work against the live project and `value` never survives.
8. `services.ts` + `ownership.ts`. **Done when** the ownership checklist lists team, services, domains, repo, webhooks, OAuth.
9. `cost.ts` + `playbook.ts`. **Done when** each detected dependency gets exactly one playbook subsection with real locations.
10. Remote registry fetch with cache + license credit. **Done when** remote data merges over bundled data and offline mode still works.
11. All §15 tests green. README with install, token guidance, example output.
12. Acceptance harness (§19): `pnpm acceptance` scoring script and `failure-modes` script. **Done when** both run against the demo project and print a scorecard. Do not cut this step.
13. *Stretch*: GitHub Action (§13).

Cut order if short on time (cut from the bottom first): Action → remote registry fetch → V8 → cost section → workflow `startedFrom`.

---

## 17. Demo plan

1. Fork 2–3 of the Workflow DevKit demo apps from `vercel-labs` (each lives in its own repo; pick ones that use sleeps, hooks, and AI SDK calls). Deploy each to your own Vercel account.
2. On one project, deliberately leave one env var out of the production target and add a cron route without a `CRON_SECRET` check. These are real configuration states on a real deployment, not a synthetic case study.
3. Run `handoff-pack generate` against each. Commit the generated `HANDOFF.md` files to a public `examples/` folder.
4. Record a 60–90 second screen capture: run the command, open `HANDOFF.md`, scroll to Action items and the Ownership checklist, show one verified row next to one mismatch.

---

## 18. VERIFY list (resolve before or while implementing)

- [ ] `@vercel/sdk` method names and response fields for project, env list (without decryption), domains, deployments, team; env `type` enum values; whether the project response exposes cron definitions.
- [ ] `@ai-sdk/*` provider member method names in the installed versions; agent class export names in `ai`.
- [ ] `workflow` package: exact exports for `sleep`, hook creation, webhook creation; module path and name of `start`; current CLI command for the local observability UI.
- [ ] `llm-model-deprecation` registry: raw JSON URL, schema, and license.
- [ ] Provider deprecation and pricing pages used to populate `data/models.json` (record each as `source`).
- [ ] Status page URLs in `data/statusPages.json`.

If a VERIFY item cannot be confirmed, implement the conservative behavior (skip the check, add a `limits` entry) rather than guessing.

---

## 19. Ground-truth acceptance testing

Unit tests (§15) prove the logic on inputs we control. This section proves the tool is correct on **real deployments**: every known problem is caught (recall), and nothing correct is flagged (precision). The tool itself stays read-only; issues are planted **manually** by the human, and the scripts below only measure results.

### 19.1 Files

```
test/acceptance/
  expected/
    <demo-project-name>.planted.json   # findings that MUST appear after planting
    <demo-project-name>.clean.json     # findings that MUST NOT appear after cleanup
  score.ts                             # scoring script
  failureModes.ts                      # degraded-environment script
  PLANTING.md                          # human checklist (§19.3)
```

`package.json` scripts:

```json
{
  "acceptance": "tsx test/acceptance/score.ts",
  "failure-modes": "tsx test/acceptance/failureModes.ts"
}
```

These are dev scripts, not part of the published CLI. They are excluded from `pnpm test` because they need a live Vercel project and token.

### 19.2 Expected-findings file format

```json
{
  "project": "demo-project-name",
  "mustFind": [
    { "rule": "V1",  "subject": "PLANTED_MISSING_VAR", "severity": "CRITICAL" },
    { "rule": "V3",  "subject": "PLANTED_ORPHAN_VAR" },
    { "rule": "V7",  "subject": "/api/cron/planted-missing-route", "severity": "CRITICAL" },
    { "rule": null,  "subject": "/api/cron/no-secret", "category": "cron", "titleIncludes": "CRON_SECRET" },
    { "rule": "V10", "subject": "<deprecated model id chosen by human>" },
    { "rule": "V16", "subject": "<unverified domain>" },
    { "rule": "V17", "subject": "production-commit" }
  ],
  "mustNotFind": [
    { "rule": "V1", "subject": "<an env var that IS set in production>" }
  ],
  "verifiedRows": {
    "envVars": ["<var names the human confirmed are set in Vercel production>"],
    "crons": ["<cron paths the human confirmed are live>"]
  }
}
```

Matching rules for an expected entry against a report finding:
- `rule` and `subject` must both match exactly (when `rule` is `null`, match on `category` + `subject`).
- `severity`, `category`, and `titleIncludes` are checked only if present.

`verifiedRows` lists rows the human manually confirmed in the Vercel dashboard. The script checks that the report marks each of them `VERIFIED` and that **no other** env or cron row is marked `VERIFIED` unless it appears in the live Vercel data returned by the collector. A row marked `VERIFIED` that the human did not confirm is reported as a **false verification**.

### 19.3 Planting checklist (`PLANTING.md`, performed by a human in the Vercel dashboard and repo)

On one deployed demo project:

1. Add `PLANTED_MISSING_VAR` to the code (read it in any server route); do **not** add it to Vercel production.
2. Add `PLANTED_ORPHAN_VAR` in Vercel production; do not reference it in code.
3. Add a cron in `vercel.json` pointing at `/api/cron/planted-missing-route` with no route file.
4. Add a cron route `/api/cron/no-secret` that works but does not check `CRON_SECRET`.
5. Change one model call to a model ID the registry marks deprecated within the window.
6. Attach a domain you control to the project without completing DNS verification (or skip this item and remove it from the expected file).
7. Deploy. Then make one local commit that is not deployed, so HEAD differs from production.

Record the exact names used in the `.planted.json` file **before** running the tool.

Cleanup: undo items 1–7, redeploy, sync HEAD with production, then fill in `.clean.json` with the same entries moved to `mustNotFind`.

### 19.4 `score.ts` behavior

```
pnpm acceptance -- --report handoff/handoff.json --expected test/acceptance/expected/<name>.planted.json
```

1. Load and zod-validate both files.
2. For each `mustFind` entry: find a matching finding → **caught**; else **missed**.
3. For each `mustNotFind` entry: a matching finding exists → **false positive**.
4. Every CRITICAL or HIGH finding in the report that matches no `mustFind` entry → listed as **unexpected** (human reviews each: real issue or false positive).
5. Check `verifiedRows` as described in §19.2 → list any **false verifications**.
6. Print a scorecard:

```
Acceptance: demo-project-name (planted)
  Caught:              6 / 7
  Missed:              V16 <domain>
  False positives:     0
  Unexpected HIGH+:    1  (review: env:SOME_VAR V4)
  False verifications: 0
  Result: FAIL (1 missed)
```

7. Exit `0` only if missed = 0, false positives = 0, and false verifications = 0. Unexpected findings do not fail the run but must be listed.
8. Also write the scorecard as `test/acceptance/results/<name>-<planted|clean>.md` for use in the demo.

Target: both the planted run and the clean run pass with zero misses, zero false positives, and zero false verifications. **A false verification is the most serious defect in this project**; fix it before anything else.

### 19.5 `failureModes.ts` behavior

Runs `handoff-pack generate` as a child process under each condition below and checks the outcome. Each case must finish without an unhandled exception (exit code must not be `3`) and must produce the listed result.

| Case | How to set up | Expected |
|---|---|---|
| Offline | `--offline` | Exit 0/1; all Vercel-dependent rows `UNVERIFIED`; zero network calls |
| No token | `--vercel-project` set, `VERCEL_TOKEN` unset | Exit 2 with a clear message |
| Bad token | `VERCEL_TOKEN=invalid` | Exit 2 or report with `limits` entry "Vercel authentication failed"; no crash |
| Wrong team | valid token, wrong `--vercel-team` | `limits` entry; Vercel rows `UNVERIFIED` |
| Partial permissions | token that can read the project but not domains (if not creatable, simulate with a mocked 403 on the domains call) | Domain rows `UNVERIFIED`; `limits` entry names the domains check |
| Non-Next.js JS repo | point `--repo` at a plain Node library | Report generated; framework-specific scanners skipped with `limits` entries |
| Python repo | `test/fixtures/unsupported` | CRITICAL "Unsupported project type"; exit 1 |
| Large repo | any large public Next.js repo, cloned locally | Completes; prints elapsed time; `node_modules` and build folders confirmed skipped |

Print a pass/fail table and exit non-zero if any case fails.

### 19.6 Human checks (not automated; list them in README under "How this was tested")

1. **Manual accuracy pass:** with the Vercel dashboard open beside `HANDOFF.md`, confirm every `✅ Verified` row, and spot-check at least 10 file:line references in the code.
2. **Stranger test:** give `HANDOFF.md` to a developer who has never seen the project. Using only the report, they should be able to answer: which env vars must exist in production; what to do if the model provider goes down; what must move to the client's accounts; which background jobs run and when. Record which questions they could and could not answer, and fix gaps in the templates.
3. **Action test** (if §13 was built): on a throwaway repo, trigger the Action manually; confirm it opens one PR; trigger again and confirm it updates the same PR; confirm the deprecation issue is not duplicated.
