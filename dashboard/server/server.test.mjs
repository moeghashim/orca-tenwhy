import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createDashboardServer, openReadOnly } from "./server.mjs";
import { seedDemo } from "./seed.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tenwhy-dash-"));
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function postJson(port, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: pathname,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(data),
          ...headers,
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => {
          raw += c;
        });
        res.on("end", () => {
          let json = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch {
            json = { raw };
          }
          resolve({ status: res.statusCode, json, headers: res.headers });
        });
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function maskRow(row) {
  return {
    customer_name: row.customer_name,
    idea: row.idea,
    site_url: row.site_url,
    status: row.status,
  };
}

function treeFiles(dir) {
  const out = [];
  function walk(p, rel) {
    let entries = [];
    try {
      entries = fs.readdirSync(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === ".git") continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(p, e.name), r);
      else out.push(r);
    }
  }
  walk(dir, "");
  return out.sort();
}

function getJson(port, pathname) {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}${pathname}`, (res) => {
        let body = "";
        res.on("data", (c) => {
          body += c;
        });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(body) });
          } catch (err) {
            reject(err);
          }
        });
      })
      .on("error", reject);
  });
}

test("dashboard connection throws on INSERT (readOnly)", () => {
  const dir = tmpDir();
  const dbPath = path.join(dir, "t.db");
  seedDemo({ dbPath, repoRoot: dir });
  const db = openReadOnly(dbPath);
  assert.throws(
    () =>
      db
        .prepare(
          "INSERT INTO events (engagement_id, loop_run_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("eng_0141", null, "probe", "{}", "2026-08-30T00:00:00Z"),
    /readonly|read only|SQLITE_READONLY/i,
  );
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("/api/snapshot from the seeded DB has comparisons with valid and flagged cells and kb_files listing the real files", async (t) => {
  const dir = tmpDir();
  const dbPath = path.join(dir, "t.db");
  seedDemo({ dbPath, repoRoot: dir });
  const { server, close } = createDashboardServer({ dbPath, repoRoot: dir });
  t.after(() => {
    close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const port = await listen(server);
  const { status, json } = await getJson(port, "/api/snapshot");
  assert.equal(status, 200);
  assert.ok(json.serverTime);
  assert.equal(json.snapshotAt, json.serverTime);
  const cmp = json.comparisons.run_res_0143;
  assert.ok(cmp, `comparisons keys: ${Object.keys(json.comparisons)}`);
  assert.deepEqual(
    cmp.columns.map((c) => c.label),
    ["customer product", "competitor", "competitor product", "price", "source"],
  );
  const states = cmp.rows.flatMap((r) => r.cells.map((c) => c.state).filter(Boolean));
  assert.ok(states.includes("valid"), states);
  assert.ok(states.includes("flagged"), states);
  const harbor = json.engagements.find((e) => e.id === "eng_0143");
  assert.ok(harbor);
  const names = harbor.kb_files.map((f) => f.path);
  assert.ok(names.includes("company/OVERVIEW.md"), names);
  assert.ok(names.includes("company/POSITIONING.md"), names);
  assert.ok(names.includes("BRIEF.md"), names);
  assert.equal(harbor.status, "awaiting_approval");
  const bloom = json.engagements.find((e) => e.id === "eng_0137");
  assert.equal(bloom.live_url, "https://bloomfloristry.example");
  const it = json.iterations.find((i) => i.id === "it_0141_1");
  assert.match(it.executor_summary, /Compiled firm profile/);
  const researchChecks = json.gate_checks.filter((g) => g.loop_run_id === "run_res_0143");
  assert.deepEqual(
    researchChecks.map((g) => g.check_name),
    ["schema_valid", "competitors≥5", "product_coverage≥25%", "enhancement_ideas≥3", "sources_complete"],
  );
  assert.ok(researchChecks.every((g) => g.passed === 1 || g.passed === true));
  const bloomWebChecks = json.gate_checks.filter((g) => g.loop_run_id === "run_web_0137");
  assert.deepEqual(
    bloomWebChecks.map((g) => g.check_name),
    ["brand_assets_valid", "build_ok", "links_ok", "copy_grounded", "lighthouse≥85"],
  );
  assert.ok(bloomWebChecks.every((g) => g.passed === 1 || g.passed === true));
});

test("insert an events row via sqlite3 while an SSE client is connected → patch received in < 2 s with the re-read entity", async (t) => {
  const dir = tmpDir();
  const dbPath = path.join(dir, "t.db");
  seedDemo({ dbPath, repoRoot: dir });
  const { server, close } = createDashboardServer({ dbPath, repoRoot: dir, pollMs: 50, heartbeatMs: 1000 });
  t.after(() => {
    close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const port = await listen(server);
  const received = [];
  const started = Date.now();
  await new Promise((resolve, reject) => {
    const kill = setTimeout(() => reject(new Error("SSE patch not received in 2s")), 1900);
    const req = http.get(`http://127.0.0.1:${port}/api/events?since=0`, (res) => {
      assert.equal(res.statusCode, 200);
      let buf = "";
      res.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        if (buf.includes("event: patch") && buf.includes("probe.ping")) {
          received.push(buf);
          clearTimeout(kill);
          req.destroy();
          resolve();
        }
      });
    });
    req.on("error", (err) => {
      if (err.code !== "ECONNRESET") reject(err);
    });
    setTimeout(() => {
      const ins = spawnSync(
        "sqlite3",
        [
          dbPath,
          "INSERT INTO events (engagement_id, loop_run_id, kind, payload, created_at) VALUES ('eng_0141', 'run_res_0141', 'probe.ping', '{}', datetime('now'));",
        ],
        { encoding: "utf8" },
      );
      if (ins.status !== 0) reject(new Error(ins.stderr || ins.stdout));
    }, 80);
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `elapsed ${elapsed}`);
  assert.match(received.join(""), /probe\.ping/);
  assert.match(received.join(""), /"engagements"/);
  assert.match(received.join(""), /eng_0141/);
});

test("Last-Event-ID 20 and since=5 delivers first event id 21", async (t) => {
  const dir = tmpDir();
  const dbPath = path.join(dir, "t.db");
  seedDemo({ dbPath, repoRoot: dir });
  const db = new DatabaseSync(dbPath);
  const max = db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM events").get().id;
  for (let i = max + 1; i <= 25; i++) {
    db.prepare(
      "INSERT INTO events (engagement_id, loop_run_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("eng_0141", "run_res_0141", "probe.pad", "{}", "2026-08-30T00:00:00Z");
  }
  db.close();
  const { server, close } = createDashboardServer({ dbPath, repoRoot: dir, pollMs: 40, heartbeatMs: 1000 });
  t.after(() => {
    close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const port = await listen(server);
  const firstId = await new Promise((resolve, reject) => {
    const kill = setTimeout(() => reject(new Error("no SSE event")), 1900);
    const req = http.get(
      {
        hostname: "127.0.0.1",
        port,
        path: "/api/events?since=5",
        headers: { "Last-Event-ID": "20" },
      },
      (res) => {
        assert.equal(res.statusCode, 200);
        let buf = "";
        res.on("data", (chunk) => {
          buf += chunk.toString("utf8");
          const match = buf.match(/\nid:\s*(\d+)\n/);
          if (match) {
            clearTimeout(kill);
            req.destroy();
            resolve(Number(match[1]));
          }
        });
      },
    );
    req.on("error", (err) => {
      if (err.code !== "ECONNRESET") reject(err);
    });
  });
  assert.equal(firstId, 21);
});

test("POST /api/engagements matches loopctl new row fields and customer-repo tree", async (t) => {
  const prevBackend = process.env.TENWHY_REPO_BACKEND;
  process.env.TENWHY_REPO_BACKEND = "local";
  const stamp = Date.now().toString(36);
  const name = `P10 Compare ${stamp}`;
  const idea = "Boutique dental clinic in Amman";
  const url = "https://example.com";
  const dir = tmpDir();
  const dbCli = path.join(dir, "cli.db");
  const dbApi = path.join(dir, "api.db");
  const mig = spawnSync("bash", [path.join(ROOT, "system/db/migrate.sh"), dbApi], { encoding: "utf8" });
  assert.equal(mig.status, 0, mig.stderr || mig.stdout);
  const cli = spawnSync(
    process.execPath,
    [path.join(ROOT, "bin/loopctl"), "new", idea, "--url", url, "--name", name],
    { encoding: "utf8", env: { ...process.env, TENWHY_DB: dbCli, TENWHY_REPO_BACKEND: "local" }, cwd: ROOT },
  );
  t.after(() => {
    if (prevBackend === undefined) delete process.env.TENWHY_REPO_BACKEND;
    else process.env.TENWHY_REPO_BACKEND = prevBackend;
    for (const dbPath of [dbCli, dbApi]) {
      if (!fs.existsSync(dbPath)) continue;
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const rows = db.prepare("SELECT id, json_extract(payload,'$.slug') AS slug FROM events WHERE kind='engagement.created'").all();
      db.close();
      for (const r of rows) {
        if (r.slug) {
          fs.rmSync(path.join(ROOT, "state/customers", r.slug), { recursive: true, force: true });
          fs.rmSync(path.join(ROOT, "state/remotes", `${r.slug}.git`), { recursive: true, force: true });
        }
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(cli.status, 0, cli.stderr || cli.stdout);
  const cliId = cli.stdout.trim();
  const { server, close } = createDashboardServer({ dbPath: dbApi, repoRoot: ROOT });
  t.after(() => close());
  const port = await listen(server);
  const posted = await postJson(port, "/api/engagements", { idea, site_url: url, customer_name: name });
  assert.equal(posted.status, 201, posted.json);
  const apiId = posted.json.id;
  assert.match(apiId, /^eng_/);
  const db1 = new DatabaseSync(dbCli, { readOnly: true });
  const db2 = new DatabaseSync(dbApi, { readOnly: true });
  const row1 = db1.prepare("SELECT * FROM engagements WHERE id = ?").get(cliId);
  const row2 = db2.prepare("SELECT * FROM engagements WHERE id = ?").get(apiId);
  assert.deepEqual(maskRow(row2), maskRow(row1));
  const slug1 = db1.prepare("SELECT json_extract(payload,'$.slug') AS slug FROM events WHERE engagement_id=? AND kind='engagement.created'").get(cliId).slug;
  const slug2 = db2.prepare("SELECT json_extract(payload,'$.slug') AS slug FROM events WHERE engagement_id=? AND kind='engagement.created'").get(apiId).slug;
  db1.close();
  db2.close();
  assert.deepEqual(treeFiles(path.join(ROOT, "state/customers", slug2)), treeFiles(path.join(ROOT, "state/customers", slug1)));
  const bad = await postJson(port, "/api/engagements", { customer_name: "x" });
  assert.equal(bad.status, 400);
});

test("GET /api/engagements/:id returns the engagement subset", async (t) => {
  const dir = tmpDir();
  const dbPath = path.join(dir, "t.db");
  seedDemo({ dbPath, repoRoot: dir });
  const { server, close } = createDashboardServer({ dbPath, repoRoot: dir });
  t.after(() => {
    close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const port = await listen(server);
  const { status, json } = await getJson(port, "/api/engagements/eng_0143");
  assert.equal(status, 200);
  assert.equal(json.engagement.id, "eng_0143");
  assert.ok(json.loop_runs.some((r) => r.id === "run_res_0143"));
  assert.ok(json.events.some((e) => e.kind === "engagement.awaiting_approval"));
  const missing = await getJson(port, "/api/engagements/nope");
  assert.equal(missing.status, 404);
});
