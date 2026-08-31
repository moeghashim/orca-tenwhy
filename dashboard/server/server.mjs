import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  engagementBundle,
  hasUnprocessedApproval,
  previewDist,
  previewManifest,
  researchPayload,
  resolvePreviewPath,
  spawnLoopctlNew,
  writeClientAllowed,
} from "./customer_api.mjs";
import { prefixedId, utcNow } from "../../system/orchestrator/util.mjs";
import { buildSnapshot, entitiesForEvent, formatSsePatch } from "./snapshot.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DIST = path.join(ROOT, "dashboard/web/dist");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
};

export function openReadOnly(dbPath) {
  return new DatabaseSync(dbPath, { readOnly: true });
}

export function openWritable(dbPath) {
  return new DatabaseSync(dbPath);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(data);
}

function serveStatic(req, res) {
  if (!fs.existsSync(DIST)) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    res.end("dashboard/web/dist missing — run vite build");
    return;
  }
  const url = new URL(req.url, "http://127.0.0.1");
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";
  const abs = path.normalize(path.join(DIST, rel));
  if (!abs.startsWith(DIST)) {
    res.writeHead(403).end();
    return;
  }
  let file = abs;
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(DIST, "index.html");
  }
  const ext = path.extname(file);
  res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

export function createDashboardServer({
  dbPath,
  repoRoot = ROOT,
  pollMs = 500,
  heartbeatMs = 15_000,
} = {}) {
  const db = openReadOnly(dbPath);
  const clients = new Set();

  function snapshot() {
    return buildSnapshot(db, { repoRoot });
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/api/snapshot") {
      sendJson(res, 200, snapshot());
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/engagements") {
      Promise.resolve()
        .then(async () => {
          let body;
          try {
            body = JSON.parse((await readBody(req)) || "{}");
          } catch {
            sendJson(res, 400, { error: "invalid json" });
            return;
          }
          const idea = typeof body.idea === "string" ? body.idea.trim() : "";
          const site_url = typeof body.site_url === "string" ? body.site_url.trim() : "";
          const customer_name = typeof body.customer_name === "string" ? body.customer_name.trim() : "";
          if (!idea && !site_url) {
            sendJson(res, 400, { error: "idea or site_url required" });
            return;
          }
          const result = await spawnLoopctlNew({
            idea: idea || undefined,
            site_url: site_url || undefined,
            customer_name: customer_name || undefined,
            dbPath,
            repoRoot,
            env: process.env,
          });
          if (!result.ok) {
            sendJson(res, 502, { error: result.error });
            return;
          }
          sendJson(res, 201, { id: result.id });
        })
        .catch((err) => {
          sendJson(res, 502, { error: String(err.message || err) });
        });
      return;
    }
    const engGet = req.method === "GET" && url.pathname.match(/^\/api\/engagements\/([^/]+)$/);
    if (engGet) {
      const id = decodeURIComponent(engGet[1]);
      const bundle = engagementBundle(db, id, repoRoot);
      if (!bundle) {
        sendJson(res, 404, { error: "not found" });
        return;
      }
      sendJson(res, 200, bundle);
      return;
    }
    const researchGet = req.method === "GET" && url.pathname.match(/^\/api\/engagements\/([^/]+)\/research$/);
    if (researchGet) {
      const id = decodeURIComponent(researchGet[1]);
      const payload = researchPayload(db, id, repoRoot);
      if (!payload) {
        sendJson(res, 404, { error: "not found" });
        return;
      }
      sendJson(res, 200, payload);
      return;
    }
    const manifestGet = req.method === "GET" && url.pathname.match(/^\/api\/engagements\/([^/]+)\/preview-manifest$/);
    if (manifestGet) {
      const id = decodeURIComponent(manifestGet[1]);
      const dist = previewDist(db, id, repoRoot);
      if (!dist) {
        sendJson(res, 404, { error: "not found" });
        return;
      }
      sendJson(res, 200, previewManifest(dist));
      return;
    }
    const writeMatch = req.method === "POST" && url.pathname.match(/^\/api\/engagements\/([^/]+)\/(approve|request-changes)$/);
    if (writeMatch) {
      if (!writeClientAllowed(req)) {
        sendJson(res, 403, { error: "forbidden" });
        return;
      }
      const id = decodeURIComponent(writeMatch[1]);
      const action = writeMatch[2] === "approve" ? "approve" : "request_changes";
      Promise.resolve()
        .then(async () => {
          let body = {};
          try {
            body = JSON.parse((await readBody(req)) || "{}");
          } catch {
            sendJson(res, 400, { error: "invalid json" });
            return;
          }
          const notes = typeof body.notes === "string" ? body.notes.trim() : "";
          if (action === "request_changes" && !notes) {
            sendJson(res, 400, { error: "notes required" });
            return;
          }
          const w = openWritable(dbPath);
          try {
            w.exec("PRAGMA busy_timeout = 5000");
            w.exec("BEGIN IMMEDIATE");
            const eng = w.prepare("SELECT status FROM engagements WHERE id = ?").get(id);
            if (!eng || eng.status !== "awaiting_approval" || hasUnprocessedApproval(w, id)) {
              w.exec("ROLLBACK");
              sendJson(res, 409, { error: "this project isn't waiting for approval right now" });
              return;
            }
            const apr = prefixedId("apr");
            w.prepare(
              "INSERT INTO approvals (id, engagement_id, action, notes, created_at) VALUES (?, ?, ?, ?, ?)",
            ).run(apr, id, action, action === "request_changes" ? notes : null, utcNow());
            w.exec("COMMIT");
            sendJson(res, 200, { ok: true, id: apr });
          } catch (err) {
            try {
              w.exec("ROLLBACK");
            } catch {
              /* */
            }
            sendJson(res, 502, { error: String(err.message || err) });
          } finally {
            w.close();
          }
        })
        .catch((err) => sendJson(res, 502, { error: String(err.message || err) }));
      return;
    }
    const rawPath = (req.url || "").split("?")[0];
    const previewGet = req.method === "GET" && rawPath.match(/^\/preview\/([^/]+)(?:\/(.*))?$/);
    if (previewGet) {
      let id;
      try {
        id = decodeURIComponent(previewGet[1]);
      } catch {
        sendJson(res, 404, { error: "not found" });
        return;
      }
      const rest = previewGet[2] || "";
      const dist = previewDist(db, id, repoRoot);
      if (!dist) {
        sendJson(res, 404, { error: "not found" });
        return;
      }
      const file = resolvePreviewPath(dist, rest);
      if (!file) {
        sendJson(res, 404, { error: "not found" });
        return;
      }
      const ext = path.extname(file);
      res.writeHead(200, {
        "content-type": MIME[ext] || "application/octet-stream",
        "x-frame-options": "SAMEORIGIN",
        "content-security-policy": "sandbox allow-scripts",
      });
      fs.createReadStream(file).pipe(res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/events") {
      // since= is a bootstrap hint only. When Last-Event-ID is also present, use the
      // larger id so we never replay events the client has already applied.
      const headerId = Number(req.headers["last-event-id"] ?? 0) || 0;
      const queryId = Number(url.searchParams.get("since") ?? 0) || 0;
      let lastId = Math.max(headerId, queryId);
      const engagementId = url.searchParams.get("engagement") || null;
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      });
      res.write("\n");
      const client = { res, lastId, engagementId };
      clients.add(client);
      const heartbeat = setInterval(() => {
        try {
          res.write(": ping\n\n");
        } catch {
          /* closed */
        }
      }, heartbeatMs);
      const poll = setInterval(() => {
        try {
          const rows = client.engagementId
            ? db
                .prepare("SELECT * FROM events WHERE id > ? AND engagement_id = ? ORDER BY id")
                .all(client.lastId, client.engagementId)
            : db.prepare("SELECT * FROM events WHERE id > ? ORDER BY id").all(client.lastId);
          for (const row of rows) {
            const entities = entitiesForEvent(db, row, repoRoot);
            const data = formatSsePatch(row, entities);
            res.write(`event: patch\nid: ${row.id}\ndata: ${JSON.stringify(data)}\n\n`);
            client.lastId = row.id;
          }
        } catch {
          /* closed or db */
        }
      }, pollMs);
      req.on("close", () => {
        clearInterval(heartbeat);
        clearInterval(poll);
        clients.delete(client);
      });
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    serveStatic(req, res);
  });

  function close() {
    for (const c of clients) {
      try {
        c.res.end();
      } catch {
        /* */
      }
    }
    clients.clear();
    server.close();
    db.close();
  }

  return { server, db, snapshot, close };
}

function isMain() {
  const entry = process.argv[1] && path.resolve(process.argv[1]);
  return entry === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const dbPath = process.env.TENWHY_DB || path.join(ROOT, "state/orchestrator.db");
  const port = Number(process.env.PORT || 4310);
  const { server } = createDashboardServer({ dbPath, repoRoot: ROOT });
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(`dashboard http://127.0.0.1:${port}\n`);
  });
}
