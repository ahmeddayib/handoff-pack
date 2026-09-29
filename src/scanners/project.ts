import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { minimatch } from "minimatch";

const ignoredDirectories = new Set([
  "node_modules",
  ".next",
  ".vercel",
  "dist",
  "build",
  "coverage",
  ".git",
]);
const sourceExtensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".cts",
  ".mjs",
  ".cjs",
]);

export interface ProjectInfo {
  supported: boolean;
  framework: "nextjs" | null;
  nextVersion: string | null;
  router: "app" | "pages" | "both" | null;
  language: "typescript" | "javascript" | null;
  dependencies: Record<string, string>;
  sourceFiles: string[];
  exampleEnvFiles: string[];
  nestedNextApps: string[];
}

function relativePath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function isIgnored(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) =>
    minimatch(path, pattern, { dot: true, matchBase: true }),
  );
}

export async function listRepoFiles(
  root: string,
  ignorePaths: string[] = [],
): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(directory, entry.name);
      const path = relativePath(root, fullPath);
      if (isIgnored(path, ignorePaths)) continue;
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) await visit(fullPath);
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
  }
  await visit(root);
  return files.sort();
}

function hasDirectory(root: string, path: string): Promise<boolean> {
  return stat(join(root, path))
    .then((value) => value.isDirectory())
    .catch(() => false);
}

export async function detectProject(
  root: string,
  ignorePaths: string[] = [],
): Promise<ProjectInfo> {
  let packageJson: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  try {
    packageJson = JSON.parse(
      await readFile(join(root, "package.json"), "utf8"),
    ) as typeof packageJson;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return {
      supported: false,
      framework: null,
      nextVersion: null,
      router: null,
      language: null,
      dependencies: {},
      sourceFiles: [],
      exampleEnvFiles: [],
      nestedNextApps: [],
    };
  }
  const dependencies = {
    ...packageJson.devDependencies,
    ...packageJson.dependencies,
  };
  const files = await listRepoFiles(root, ignorePaths);
  const sourceFiles = files.filter((path) =>
    sourceExtensions.has(`.${path.split(".").at(-1) ?? ""}`),
  );
  const pythonOnly =
    sourceFiles.length === 0 && files.some((path) => path.endsWith(".py"));
  const exampleEnvFiles = files.filter((path) =>
    [
      ".env.example",
      ".env.sample",
      ".env.template",
      ".env.local.example",
    ].includes(basename(path)),
  );
  const nestedNextApps: string[] = [];
  if (!dependencies.next) {
    for (const path of files.filter((item) => item.endsWith("/package.json"))) {
      try {
        const nested = JSON.parse(await readFile(join(root, path), "utf8")) as {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        if (nested.dependencies?.next || nested.devDependencies?.next)
          nestedNextApps.push(path.slice(0, -"/package.json".length));
      } catch {
        // A malformed nested manifest cannot establish a Next.js app.
      }
    }
  }
  const hasApp =
    (await hasDirectory(root, "app")) || (await hasDirectory(root, "src/app"));
  const hasPages =
    (await hasDirectory(root, "pages")) ||
    (await hasDirectory(root, "src/pages"));
  const router =
    hasApp && hasPages ? "both" : hasApp ? "app" : hasPages ? "pages" : null;
  const language = pythonOnly
    ? null
    : files.some(
          (path) =>
            path === "tsconfig.json" || /\.(?:ts|tsx|mts|cts)$/.test(path),
        )
      ? "typescript"
      : "javascript";
  return {
    supported: !pythonOnly,
    framework: dependencies.next ? "nextjs" : null,
    nextVersion: dependencies.next ?? null,
    router,
    language,
    dependencies,
    sourceFiles,
    exampleEnvFiles,
    nestedNextApps,
  };
}

export function isTestFile(path: string): boolean {
  return (
    /\.(?:test|spec)\.(?:ts|tsx|js|jsx)$/.test(path) ||
    /(?:^|\/)(?:tests?|e2e|__tests__)\//.test(path) ||
    /(?:^|\/)playwright\.config\.[cm]?[jt]s$/.test(path)
  );
}
