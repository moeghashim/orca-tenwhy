#!/usr/bin/env node
// Serve dashboard/web/dist on a free localhost port (node:http, no deps) and
// run cdp_render.mjs against the render-check fixture. Exits non-zero if the
// grid does not paint. Invoked by `make grid-render-check`.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const dist = path.join(repo, "dashboard/web/dist");
const screenshot = path.join(repo, "state/logs/grid-render.png");
const cdp = path.join(here, "cdp_render.mjs");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".map": "application/json",
};

if (!fs.existsSync(path.join(dist, "render-check.html"))) {
  console.error("grid-render-check: dashboard/web/dist/render-check.html missing; run vite build first");
  process.exit(1);
}

fs.mkdirSync(path.dirname(screenshot), { recursive: true });

const server = http.createServer((req, relRes) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.normalize(path.join(dist, rel));
  if (!file.startsWith(dist + path.sep) && file !== dist) {
    relRes.writeHead(403).end("forbidden");
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      relRes.writeHead(404).end("not found");
      return;
    }
    relRes.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    relRes.end(data);
  });
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const port = server.address().port;
const url = `http://127.0.0.1:${port}/render-check.html`;

const child = spawn(process.execPath, [cdp, url, screenshot, "3500", "1"], {
  stdio: "inherit",
  cwd: repo,
});
const code = await new Promise((resolve) => {
  child.on("exit", (c, signal) => resolve(signal ? 1 : c ?? 1));
});
await new Promise((resolve) => server.close(resolve));
process.exit(code);
