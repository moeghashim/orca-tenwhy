import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
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
