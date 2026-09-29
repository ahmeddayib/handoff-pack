import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { detectProject } from "../src/scanners/project.js";

const fixture = (name: string) => resolve("test/fixtures", name);

describe("project scanner", () => {
  it("detects Next.js App Router, TypeScript, and package dependencies", async () => {
    const result = await detectProject(fixture("basic-ai-sdk"));
    expect(result.supported).toBe(true);
    expect(result.framework).toBe("nextjs");
    expect(result.nextVersion).toBe("15.5.0");
    expect(result.router).toBe("app");
    expect(result.language).toBe("typescript");
    expect(result.dependencies).toHaveProperty("ai");
    expect(result.dependencies).toHaveProperty("@ai-sdk/openai");
    expect(result.sourceFiles).toContain("src/app/api/chat/route.ts");
  });

  it("marks a Python-only repository unsupported", async () => {
    const result = await detectProject(fixture("unsupported"));
    expect(result.supported).toBe(false);
    expect(result.sourceFiles).toEqual([]);
  });

  it("respects ignorePaths while listing files", async () => {
    const result = await detectProject(fixture("basic-ai-sdk"), [
      "src/dynamic.ts",
    ]);
    expect(result.sourceFiles).not.toContain("src/dynamic.ts");
  });

  it("prunes dependency and build directories at every depth", async () => {
    const root = await mkdtemp(join(tmpdir(), "handoff-project-skip-"));
    try {
      await writeFile(join(root, "package.json"), "{}");
      for (const directory of [
        "node_modules/pkg",
        "apps/web/.next",
        "packages/api/dist",
        "apps/web/build",
      ]) {
        await mkdir(join(root, directory), { recursive: true });
        await writeFile(
          join(root, directory, "ignored.ts"),
          "export const ignored = true;",
        );
      }
      await mkdir(join(root, "src"));
      await writeFile(join(root, "src/kept.ts"), "export const kept = true;");
      expect((await detectProject(root)).sourceFiles).toEqual(["src/kept.ts"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
