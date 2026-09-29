const systemEnvNames = new Set([
  "VERCEL",
  "VERCEL_ENV",
  "VERCEL_URL",
  "VERCEL_BRANCH_URL",
  "VERCEL_PROJECT_PRODUCTION_URL",
  "VERCEL_REGION",
  "VERCEL_DEPLOYMENT_ID",
  "VERCEL_OIDC_TOKEN",
  "NODE_ENV",
  "CI",
  "NEXT_RUNTIME",
]);

export function isSystemEnvName(name: string): boolean {
  return systemEnvNames.has(name) || name.startsWith("VERCEL_GIT_");
}
