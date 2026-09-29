# Manual accuracy check: handoff-demo

Checked against the fresh live clean report generated on 2026-09-27.

- Vercel environment listing: `RESEND_API_KEY` appeared with the production target, matching the report's verified row. No environment values were inspected.
- Cron listing: the clean report contained no cron rows; the clean repository has no configured cron entries.
- Code references: all five distinct `file:line` references in the report were inspected in the demo repository.

| Report reference                              | Source check                                  |
| --------------------------------------------- | --------------------------------------------- |
| `app/api/generate/request-rsvp.ts:13`         | Reads `process.env.RESEND_API_KEY`.           |
| `app/api/generate/send-recipient-email.ts:18` | Reads `process.env.RESEND_API_KEY`.           |
| `app/api/generate/generate-image.ts:15`       | Uses `google/gemini-2.5-flash-image-preview`. |
| `app/api/generate/generate-message.ts:15`     | Uses `google/gemini-3.1-flash-lite-preview`.  |
| `app/api/generate/generate-prompts.ts:16`     | Uses `google/gemini-3.1-flash-lite-preview`.  |

The spec calls for ten spot checks. This demo report contains only five distinct references, so that numerical target remains unmet. A stranger test was not performed. The [terminal demo](../../../examples/handoff-demo/demo.html) records the live scan and labels the saved planted report separately.
