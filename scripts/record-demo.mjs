import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { setTimeout } from "node:timers";
import { promisify } from "node:util";

const repo = process.argv[2];
if (!repo || !process.env.VERCEL_TOKEN)
  throw new Error(
    "Usage: VERCEL_TOKEN set in environment; pnpm demo /path/to/handoff-demo",
  );
const exec = promisify(execFile);
const out = await mkdtemp(join(tmpdir(), "handoff-demo-recording-"));
const started = performance.now();
const events = [];
function screen(text) {
  events.push([
    (performance.now() - started) / 1000,
    "o",
    text.replaceAll("\n", "\r\n"),
  ]);
}
async function at(seconds) {
  await new Promise((done) =>
    setTimeout(
      done,
      Math.max(0, seconds * 1000 - (performance.now() - started)),
    ),
  );
}
function section(markdown, start, end) {
  const from = markdown.indexOf(start);
  const to = end ? markdown.indexOf(end, from) : markdown.length;
  return markdown.slice(from, to);
}

process.stdout.write(
  "Recording the handoff-demo terminal demo (65 seconds).\n",
);
screen(
  "$ node dist/cli.js generate --repo handoff-demo --vercel-project handoff-demo --verbose\n",
);
const scan = await exec(process.execPath, [
  resolve("dist/cli.js"),
  "generate",
  "--repo",
  resolve(repo),
  "--vercel-project",
  "handoff-demo",
  "--out",
  out,
  "--verbose",
]);
screen(scan.stdout + scan.stderr);
const clean = await readFile(join(out, "HANDOFF.md"), "utf8");
const planted = await readFile(
  "examples/handoff-demo/planted/HANDOFF.md",
  "utf8",
);
await at(12);
screen(
  "\x1b[2J\x1b[HLIVE CLEAN REPORT\n\n" +
    section(clean, "## 1. Action items", "## 4. Scheduled jobs"),
);
await at(28);
screen(
  "\x1b[2J\x1b[HSAVED PLANTED REPORT: known issues on the same demo project\n\n" +
    section(planted, "## 1. Action items", "## 2. Ownership transfer"),
);
screen(
  section(planted, "## 3. Environment variables", "## 5. Durable workflows"),
);
await at(44);
screen(
  "\x1b[2J\x1b[HSAVED PLANTED REPORT: account handoff and model dependencies\n\n" +
    section(planted, "## 2. Ownership transfer", "## 3. Environment variables"),
);
screen(section(planted, "## 6. Model dependencies", "## 7. External services"));
await at(56);
screen(
  "\x1b[2J\x1b[H$ pnpm acceptance -- --report <fresh-live-report> --expected test/acceptance/expected/handoff-demo.clean.json\n\n",
);
const score = await exec("pnpm", [
  "acceptance",
  "--",
  "--report",
  join(out, "handoff.json"),
  "--expected",
  "test/acceptance/expected/handoff-demo.clean.json",
]);
screen(score.stdout + score.stderr);
await at(65);
screen("\nEnd of terminal recording.\n");
const header = {
  version: 2,
  width: 140,
  height: 45,
  timestamp: Math.floor(Date.now() / 1000),
  title: "handoff-demo: live clean scan and saved planted findings",
  duration: 65,
};
await writeFile(
  "examples/handoff-demo/demo.cast",
  [
    JSON.stringify(header),
    ...events.map((event) => JSON.stringify(event)),
  ].join("\n") + "\n",
);
process.stdout.write("Wrote examples/handoff-demo/demo.cast.\n");
