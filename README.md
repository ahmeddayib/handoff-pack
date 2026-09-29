# handoff-pack

`handoff-pack` scans a JavaScript or TypeScript repository and produces an operating runbook for an AI app deployed on Vercel. It combines repository evidence with read-only Vercel metadata when a project and token are supplied. The generated Markdown labels verified, mismatched, and unverified rows; JSON contains the same findings and row statuses.

## Install and run

Requires Node.js 20 or later and pnpm.

```sh
pnpm install
pnpm build
node dist/cli.js generate --repo /path/to/app --out /path/to/app/handoff --offline
```

For live verification, set `VERCEL_TOKEN` in the environment and provide the Vercel project name or ID. Use a token scoped to the relevant team, with the least access needed for read-only metadata, and a short expiry such as seven days. The token is never accepted as a CLI argument.

```sh
VERCEL_TOKEN=... node dist/cli.js generate \
  --repo /path/to/app \
  --vercel-project my-app \
  --vercel-team team_... \
  --out /path/to/app/handoff
```

The command writes `HANDOFF.md` and `handoff.json`. `--format md` or `--format json` selects one. `--avg-input-tokens`, `--avg-output-tokens`, and `--deprecation-window` control the cost and model lifecycle estimates. `--verbose` prints finding, coverage, and limit counts to stderr. `node dist/cli.js diff old.json new.json` prints added, removed, and changed report rows while ignoring generation timestamps. Exit codes for `generate` are `0` for a report without CRITICAL findings, `1` for a report with CRITICAL findings, `2` for usage or configuration errors, and `3` for unexpected errors.

## Configuration

An optional `handoff.config.json` in the scanned repository can annotate ownership, ignore paths or environment variables, and resolve internal model aliases:

```json
{
  "clientName": "Acme Corp",
  "consultancyName": "Example Consulting",
  "ownership": {
    "OPENAI_API_KEY": "client",
    "vercel-team": "consultancy",
    "domain:app.example.com": "client"
  },
  "ignoreEnvVars": ["VERCEL_URL"],
  "ignorePaths": ["scripts/**"],
  "modelOverrides": {
    "internal-chat": { "provider": "openai", "modelId": "gpt-4o" }
  }
}
```

Owners may be `client`, `consultancy`, or `unknown`. The report never reads or writes secret values. Vercel environment requests explicitly disable decryption, and the SDK response is reduced to names and metadata at the client boundary.

## GitHub Action

The [Action](action.yml) runs on Node.js 20. Build and include `dist/action-bundle/index.js` when publishing a tag. `mode: pr` creates or updates one runbook pull request and opens deduplicated issues for retiring models. `mode: report` writes `handoff/HANDOFF.md` and `handoff/handoff.json` into the checked-out workspace without opening a PR or issue. `mode: issue` opens model issues only. The PR and issue modes need `GITHUB_TOKEN`; live Vercel verification also needs `vercel-token` and `vercel-project`.

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
      - uses: OWNER/handoff-pack@v1
        with:
          vercel-token: ${{ secrets.VERCEL_TOKEN }}
          vercel-project: my-project
          mode: pr
        env:
          GITHUB_TOKEN: ${{ github.token }}
```

Replace `OWNER` and `my-project` with the published Action owner and Vercel project. The Action uses GitHub's REST API for repository writes; it does not push through the local checkout.

`pnpm build` compiles the CLI and bundles the Action with esbuild, preserving runtime filesystem paths for scanned repositories and bundled data.

## Reading the report

Action items contain CRITICAL and HIGH findings. The ownership checklist names credentials, domains, the Vercel team, repository, webhooks, OAuth apps, and durable workflows when detected. Model prices estimate cost per 1,000 requests using the token assumptions shown in the report. They are estimates, not live spend. A model selected by an environment variable has no trustworthy production price estimate until its value is confirmed.

Model deprecation data comes from the [llm-model-deprecation project](https://github.com/techdevsynergy/llm-model-deprecation) and its [registry feed](https://github.com/techdevsynergy/llm-deprecation-data), credited under the MIT license. The CLI fetches the feed at runtime and caches it for 24 hours in `~/.cache/handoff-pack/registry.json`; it does not include a copy of the feed in this repository. Remote lifecycle data overrides matching [bundled entries](data/models.json), while prices come only from the bundled entries. A missing remote retirement date keeps the bundled date. Offline scans and failed fetches use the bundled registry and record that limit. When both sources give different retirement dates for a model in the report, the remote date is shown and the difference appears in Scan limits.

The playbook uses a small [status-page map](data/statusPages.json) of provider pages checked during development. A missing URL is shown as “Not listed”; the CLI does not fetch status pages while generating a report.

## How this was tested

- `pnpm test` passed 73 tests covering scanning, registry caching and merging, live rules, Vercel collection, rendering, report diffing, mocked GitHub API updates, and acceptance scoring. `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm build` passed. The Action bundle was exercised in `report` mode and in PR mode with mocked GitHub responses on a copied fixture; no real PR or issue was created during those checks.
- The [planted scorecard](test/acceptance/results/handoff-demo-planted.md) caught 6/6 expected findings; the [clean scorecard](test/acceptance/results/handoff-demo-clean.md) had no missed findings, false positives, unexpected HIGH+ findings, or false verifications. Both passed. See [all acceptance results](test/acceptance/results/) and the [test procedure](test/acceptance/PLANTING.md).
- Example reports: [handoff-demo baseline](examples/handoff-demo/baseline/HANDOFF.md), [planted](examples/handoff-demo/planted/HANDOFF.md), [clean](examples/handoff-demo/clean/HANDOFF.md), and [ai-chatbot](examples/ai-chatbot/HANDOFF.md). Each directory also contains `handoff.json`.
- The [65-second terminal demo](examples/handoff-demo/demo.html) shows a live clean scan, saved planted findings, and the clean acceptance result. The [recording file](examples/handoff-demo/demo.cast) uses asciinema format. Re-record it with `pnpm demo /path/to/handoff-demo` and `VERCEL_TOKEN` set in the environment.
- [Manual accuracy checks](test/acceptance/results/handoff-demo-manual.md) compared the project's environment variable names and production targets with the Vercel listing, checked cron entries and route files, and reviewed the model lifecycle source. The fresh clean report has five distinct file:line references; all five were checked against the demo source. The scanner did not read environment variable values.

`pnpm failure-modes` was run with the live `handoff-demo` project and an offline cal.com checkout. The partial-permissions case uses a mocked domain API response.

| Case                          | Result | Detail                                |
| ----------------------------- | ------ | ------------------------------------- |
| Offline                       | PASS   | Exit 0                                |
| No token                      | PASS   | Exit 2                                |
| Non-Next.js JS repo           | PASS   | Exit 0                                |
| Python repo                   | PASS   | Exit 1, unsupported project reported  |
| Bad token                     | PASS   | Exit 2                                |
| Wrong team                    | PASS   | Exit 0, project access limit reported |
| Valid token and project       | PASS   | Exit 0                                |
| Partial permissions           | PASS   | Mocked domains 403                    |
| Large repo (cal.com, offline) | PASS   | Exit 0; 21.36 s                       |

Tests and manual checks exposed three issues that were fixed:

1. Vercel returned 403 for an invalid token. The collector now recognizes the response's `invalidToken` field as an authentication failure while keeping other 403 responses as permission limits.
2. The cal.com scan exhausted the Node.js heap when repository scanners ran together. They now run sequentially; the large-repo case completed in 21.36 seconds.
3. The cal.com report had four CRITICAL or HIGH false positives: Stripe and VAPID public keys were classified as secrets, a tracked test `.env.test` file was rated CRITICAL, and a Git-tracked `.env` symlink was treated as committed secret content. V4 now recognizes public key names unless they contain sensitive markers; V18 rates the test fixture MEDIUM and ignores tracked symlinks. A regular tracked `.env` remains CRITICAL.

## Known limitations

- For monorepos, set `--repo` to the app folder, such as `apps/web`. A workspace-root scan does not treat nested apps as the project root; detected nested Next.js apps appear in Scan limits.
- Python repositories are unsupported. The scanner supports JavaScript and TypeScript.
- Model cost is estimated per 1,000 requests using configured token assumptions; the CLI does not read actual spend.
- Dynamic expressions, environment-selected model IDs, unreadable Vercel resources, and unavailable live data appear as unverified or in Scan limits. The CLI does not modify code or Vercel settings, read traffic, or call an LLM.
- Validation uses only the deployed handoff-demo project, as requested. The spec's ten-reference manual check could not be completed with this demo's five distinct references. A stranger test and live GitHub PR/issue exercise have not been performed.
