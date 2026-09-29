import { readFile, writeFile } from "node:fs/promises";
import { format } from "prettier";

const [header, ...events] = (
  await readFile("examples/handoff-demo/demo.cast", "utf8")
)
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const data = JSON.stringify({ header, events }).replaceAll("<", "\\u003c");
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>handoff-demo terminal recording</title>
<style>
body { margin: 24px; font: 16px system-ui; background: #10141b; color: #e9eef5; }
h1 { font-size: 20px; }
nav { display: flex; gap: 12px; align-items: center; margin-bottom: 16px; }
input { flex: 1; }
button { padding: 8px 14px; cursor: pointer; }
pre { padding: 20px; background: #05080d; white-space: pre-wrap; overflow-wrap: anywhere; font: 13px/1.5 monospace; min-height: 580px; }
</style>
</head>
<body>
<h1>handoff-demo terminal recording</h1>
<nav><button id="play">Play</button><button id="restart">Restart</button><input id="seek" type="range" min="0" max="65" step="0.1" value="0" aria-label="Recording time"><span id="time">0 / 65 s</span></nav>
<pre id="screen" aria-live="off"></pre>
<script>
const recording = ${data};
const screen = document.getElementById("screen");
const seek = document.getElementById("seek");
const button = document.getElementById("play");
const clock = document.getElementById("time");
let current = 0, running = false, previous = 0;
function render() {
  let text = "";
  for (const event of recording.events) {
    if (event[0] > current) break;
    if (event[1] !== "o") continue;
    const chunks = event[2].split("\\u001b[2J\\u001b[H");
    if (chunks.length > 1) text = chunks.at(-1); else text += chunks[0];
  }
  screen.textContent = text.replaceAll("\\r", "");
  seek.value = current;
  clock.textContent = Math.floor(current) + " / " + recording.header.duration + " s";
  button.textContent = running ? "Pause" : "Play";
}
function frame(now) {
  if (running) {
    current = Math.min(recording.header.duration, current + (now - previous) / 1000);
    if (current === recording.header.duration) running = false;
    render();
  }
  previous = now;
  requestAnimationFrame(frame);
}
button.onclick = () => { if (current === recording.header.duration) current = 0; running = !running; render(); };
document.getElementById("restart").onclick = () => { current = 0; running = false; render(); };
seek.oninput = () => { current = Number(seek.value); render(); };
render();
requestAnimationFrame(frame);
</script>
</body>
</html>
`;
await writeFile(
  "examples/handoff-demo/demo.html",
  await format(html, { parser: "html" }),
);
