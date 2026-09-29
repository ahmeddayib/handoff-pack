import { build } from "esbuild";
import { rm } from "node:fs/promises";

await rm("dist/action-bundle", { recursive: true, force: true });
await build({
  entryPoints: ["src/action/index.ts"],
  outfile: "dist/action-bundle/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  banner: {
    js: [
      'import { createRequire as __handoffCreateRequire } from "node:module";',
      'import { fileURLToPath as __handoffFileURLToPath } from "node:url";',
      'import { dirname as __handoffDirname } from "node:path";',
      "const require = __handoffCreateRequire(import.meta.url);",
      "const __filename = __handoffFileURLToPath(import.meta.url);",
      "const __dirname = __handoffDirname(__filename);",
    ].join("\n"),
  },
});
