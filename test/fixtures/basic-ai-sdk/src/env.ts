import { createEnv as makeEnv } from '@t3-oss/env-nextjs';

export const env = makeEnv({
  server: { OPENAI_API_KEY: string() },
  client: { NEXT_PUBLIC_ANALYTICS_ID: string() },
  runtimeEnv: { OPENAI_API_KEY: process.env.OPENAI_API_KEY },
});
