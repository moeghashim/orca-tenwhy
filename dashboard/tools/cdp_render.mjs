#!/usr/bin/env node
// Mechanical render check for canvas UIs: open a URL in headless Chrome over the DevTools protocol,
// wait real time (so requestAnimationFrame paints happen), probe the DOM, screenshot, and exit non-zero
// when the page reported an error or drew no canvas. Node 24 built-in WebSocket; no dependencies.
//
//   node dashboard/tools/cdp_render.mjs <url> <out.png> [waitMs=3500] [minCanvases=1]
//
// The page under test should expose <pre id="err"> filled by window 'error' / 'unhandledrejection'
// handlers (empty or "no-error-yet" means clean).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const [url, out, waitArg, minArg] = process.argv.slice(2);
if (!url || !out) {
  console.error("usage: cdp_render.mjs <url> <out.png> [waitMs] [minCanvases]");
  process.exit(2);
}
const waitMs = Number(waitArg || 3500);
const minCanvases = Number(minArg || 1);
const port = 9300 + Math.floor(Math.random() * 500);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-render-"));
const chrome = spawn(
  CHROME,
  ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--remote-debugging-port=${port}`, "--window-size=1200,900", `--user-data-dir=${profile}`, "about:blank"],
  { stdio: "ignore" },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanup = () => { try { chrome.kill(); } catch {} try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} };
try {
  let targets = null;
  for (let i = 0; i < 60 && !targets; i++) {
    await sleep(250);
    try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch {}
  }
  if (!targets) throw new Error("chrome did not expose a debugging target");
  const page = targets.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url });
  await sleep(waitMs);
  const probe = await send("Runtime.evaluate", {
    expression: "JSON.stringify({ canvases: document.querySelectorAll('canvas').length, portals: document.querySelectorAll('#portal').length, err: (document.getElementById('err') && document.getElementById('err').textContent) || '' })",
    returnByValue: true,
  });
  const dom = JSON.parse(probe.result.result.value);
  const shot = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(out, Buffer.from(shot.result.data, "base64"));
  ws.close();
  console.log(JSON.stringify({ url, ...dom, screenshot: out }));
  const clean = !dom.err || dom.err === "no-error-yet";
  if (!clean) { console.error(`render check: page error: ${dom.err}`); process.exit(1); }
  if (dom.canvases < minCanvases) { console.error(`render check: expected >= ${minCanvases} canvas, found ${dom.canvases}`); process.exit(1); }
} finally {
  cleanup();
}
