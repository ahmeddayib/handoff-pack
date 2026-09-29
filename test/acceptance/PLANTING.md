# Ground truth for a deployed demo

Use a disposable Vercel project and record each exact value in `expected/<project>.planted.json` before running the scanner. Plant these issues manually; the CLI only reads configuration.

1. Reference `PLANTED_MISSING_VAR` in a server route and leave it absent from Vercel production.
2. Add `PLANTED_ORPHAN_VAR` to Vercel production without referencing it in the repository.
3. Add a `vercel.json` cron for `/api/cron/planted-missing-route` without creating that route.
4. Add `/api/cron/no-secret` as a working cron route that does not read `CRON_SECRET`.
5. Use a model ID the bundled registry marks deprecated within the chosen window.
6. If you control a suitable domain, attach it without completing DNS verification. Otherwise omit V16 from the expectation file.
7. Deploy, then make a local commit that is not deployed, so HEAD differs from production.

Create an expectation file using this shape, replacing the placeholders with the exact findings and listing **every** env and cron row you manually confirmed as verified:

```json
{
  "project": "demo",
  "mustFind": [
    { "rule": "V1", "subject": "PLANTED_MISSING_VAR", "severity": "CRITICAL" },
    { "rule": "V3", "subject": "PLANTED_ORPHAN_VAR" },
    { "rule": "V7", "subject": "/api/cron/planted-missing-route" },
    {
      "rule": null,
      "category": "cron",
      "subject": "/api/cron/no-secret",
      "titleIncludes": "CRON_SECRET"
    },
    { "rule": "V10", "subject": "<deprecated model id>" },
    { "rule": "V17", "subject": "production-commit" }
  ],
  "mustNotFind": [{ "rule": "V1", "subject": "<production env var>" }],
  "verifiedRows": { "envVars": ["<production env var>"], "crons": [] }
}
```

Generate a live report, then score it:

```sh
VERCEL_TOKEN=... pnpm dev generate --repo /path/to/demo --vercel-project demo --out handoff
pnpm acceptance -- --report handoff/handoff.json --expected test/acceptance/expected/demo.planted.json
```

After the planted run, undo all changes, redeploy, and sync HEAD with production. Copy the expected file to `demo.clean.json`; move planted entries from `mustFind` to `mustNotFind`, then score the clean report. Review every unexpected HIGH or CRITICAL finding. Results are written under `test/acceptance/results/`.
