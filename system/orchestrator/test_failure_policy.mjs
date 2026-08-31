import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createOrchestratorModelFixture } from "./adapters/fixture.mjs";
import { generateCustomerRepo } from "./customer_repo.mjs";
import { tick } from "./orchestrator.mjs";
import { prefixedId, utcNow } from "./util.mjs";

const CONFIG = {
  caps: { iteration_cap: 4, retry_cap: 2 },
  loops: {
    "company-research": {
      outputs: ["research/RESEARCH.json"],
    },
  },
  edges: [],
};

function failingRunLoop({ checkName = "competitors_count", notes = "Need five sourced competitors" }) {
  return async ({ db, loopRunId }) => {
    const now = utcNow();
    db.prepare("UPDATE loop_runs SET status = 'running', started_at = ? WHERE id = ?").run(now, loopRunId);
    db.prepare(
      `INSERT INTO iterations (id, loop_run_id, n, executor_output_path, reviewer_verdict, reviewer_notes, pi_trace_ref, created_at)
       VALUES (?, ?, 4, NULL, 'revise', ?, 'fixture://executor/4', ?)`,
    ).run(prefixedId("it"), loopRunId, notes, now);
    db.prepare(
      `INSERT INTO gate_checks (id, loop_run_id, check_name, passed, detail, created_at)
       VALUES (?, ?, ?, 0, ?, ?)`,
    ).run(prefixedId("chk"), loopRunId, checkName, "only 2 of 5", now);
    db.prepare("UPDATE loop_runs SET status = 'gate_failed', finished_at = ? WHERE id = ?").run(now, loopRunId);
    return { loopRunId, status: "gate_failed", iterations: [], gateChecks: [] };
  };
}

test("forced failure: attempts 0,1,2 then needs_human; retries cite checks and notes", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tenwhy-fail-"));
  const dbPath = path.join(tmp, "t.db");
  const { openDb } = await import("./util.mjs");
  const db = openDb(dbPath);
  const workdir = path.join(tmp, "state/customers/acme");
  generateCustomerRepo({
    slug: "acme",
    customerName: "Acme",
    idea: "clinic",
    siteUrl: "",
    targetDir: workdir,
  });
  const engId = "eng_fail000";
  const now = utcNow();
  db.prepare(
    `INSERT INTO engagements (id, customer_name, idea, site_url, repo_url, status, created_at, updated_at)
     VALUES (?, 'Acme', 'clinic', NULL, ?, 'new', ?, ?)`,
  ).run(engId, workdir, now, now);

  const notes = "Need five sourced competitors";
  const checkName = "competitors_count";
  await tick({
    db,
    config: CONFIG,
    repoRoot: tmp,
    runLoop: failingRunLoop({ checkName, notes }),
    adapters: {
      orchestrator: createOrchestratorModelFixture({
        instructions: ["Focus on competitor coverage.", "Add source URLs for every competitor."],
      }),
    },
  });

  const runs = db
    .prepare("SELECT id, attempt, status, adjusted_instructions FROM loop_runs WHERE loop_name = 'company-research' ORDER BY attempt")
    .all();
  assert.equal(runs.length, 3);
  assert.deepEqual(
    runs.map((r) => r.attempt),
    [0, 1, 2],
  );
  assert.ok(runs.every((r) => r.status === "gate_failed"));
  assert.equal(runs[0].adjusted_instructions, null);
  for (const r of runs.slice(1)) {
    assert.ok(r.adjusted_instructions && r.adjusted_instructions.length > 0);
    assert.ok(r.adjusted_instructions.includes(checkName));
    assert.ok(r.adjusted_instructions.includes(notes));
  }
  assert.notEqual(runs[1].adjusted_instructions, runs[2].adjusted_instructions);

  const eng = db.prepare("SELECT status FROM engagements WHERE id = ?").get(engId);
  assert.equal(eng.status, "needs_human");
  const ev = db.prepare("SELECT payload FROM events WHERE kind = 'engagement.needs_human' ORDER BY id DESC LIMIT 1").get();
  assert.ok(ev);
  const payload = JSON.parse(ev.payload);
  assert.equal(payload.loop, "company-research");
  assert.equal(payload.lastRunId, runs[2].id);
  assert.ok(payload.failedChecks.includes(checkName));
  const retries = db.prepare("SELECT 1 FROM events WHERE kind = 'loop_run.retry'").all();
  assert.equal(retries.length, 2);
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("retries stay distinct when the model fixture returns the same text twice", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tenwhy-fail-same-"));
  const dbPath = path.join(tmp, "t.db");
  const { openDb } = await import("./util.mjs");
  const db = openDb(dbPath);
  const workdir = path.join(tmp, "state/customers/acme");
  generateCustomerRepo({
    slug: "acme",
    customerName: "Acme",
    idea: "clinic",
    siteUrl: "",
    targetDir: workdir,
  });
  const engId = "eng_fail001";
  const now = utcNow();
  db.prepare(
    `INSERT INTO engagements (id, customer_name, idea, site_url, repo_url, status, created_at, updated_at)
     VALUES (?, 'Acme', 'clinic', NULL, ?, 'new', ?, ?)`,
  ).run(engId, workdir, now, now);
  const same = "Please scrape five competitor homepages.";
  await tick({
    db,
    config: CONFIG,
    repoRoot: tmp,
    runLoop: failingRunLoop({}),
    adapters: {
      orchestrator: createOrchestratorModelFixture({ instructions: [same, same] }),
    },
  });
  const runs = db
    .prepare("SELECT attempt, adjusted_instructions FROM loop_runs WHERE loop_name = 'company-research' ORDER BY attempt")
    .all();
  assert.equal(runs.length, 3);
  assert.notEqual(runs[1].adjusted_instructions, runs[2].adjusted_instructions);
  assert.match(runs[1].adjusted_instructions, /^Attempt 1\/2/);
  assert.match(runs[2].adjusted_instructions, /^Attempt 2\/2/);
  assert.ok(runs[2].adjusted_instructions.includes(runs[1].adjusted_instructions));
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("iteration-cap retry cites check 5 from reviewer notes when gate_checks is empty", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tenwhy-fail-cap-"));
  const dbPath = path.join(tmp, "t.db");
  const { openDb } = await import("./util.mjs");
  const db = openDb(dbPath);
  const workdir = path.join(tmp, "state/customers/acme");
  generateCustomerRepo({
    slug: "acme",
    customerName: "Acme",
    idea: "clinic",
    siteUrl: "",
    targetDir: workdir,
  });
  const engId = "eng_fail002";
  const now = utcNow();
  db.prepare(
    `INSERT INTO engagements (id, customer_name, idea, site_url, repo_url, status, created_at, updated_at)
     VALUES (?, 'Acme', 'clinic', NULL, ?, 'new', ?, ?)`,
  ).run(engId, workdir, now, now);
  const notes = [
    "1. pass — RESEARCH.json matches the schema extra words.",
    "2. pass — five competitors each have a 200 scrape URL.",
    "3. pass — product coverage is 50 percent with priced sources.",
    "4. pass — three enhancement_ideas have rationale.",
    "5. fail — SOURCES.md omits scrape rows from the ledger.",
  ].join("\n");
  await tick({
    db,
    config: CONFIG,
    repoRoot: tmp,
    runLoop: async ({ db: runDb, loopRunId }) => {
      const ts = utcNow();
      runDb.prepare("UPDATE loop_runs SET status = 'running', started_at = ? WHERE id = ?").run(ts, loopRunId);
      runDb.prepare(
        `INSERT INTO iterations (id, loop_run_id, n, executor_output_path, reviewer_verdict, reviewer_notes, pi_trace_ref, created_at)
         VALUES (?, ?, 4, NULL, 'revise', ?, 'fixture://executor/4', ?)`,
      ).run(prefixedId("it"), loopRunId, notes, ts);
      runDb.prepare("UPDATE loop_runs SET status = 'gate_failed', finished_at = ? WHERE id = ?").run(ts, loopRunId);
      return { loopRunId, status: "gate_failed", iterations: [], gateChecks: [] };
    },
    adapters: {
      orchestrator: createOrchestratorModelFixture({
        instructions: ["Keep every scrapes row in SOURCES.md."],
      }),
    },
  });
  const runs = db
    .prepare("SELECT attempt, adjusted_instructions FROM loop_runs WHERE loop_name = 'company-research' ORDER BY attempt")
    .all();
  assert.ok(runs.length >= 2);
  assert.match(runs[1].adjusted_instructions, /^Attempt 1\/2/);
  assert.match(runs[1].adjusted_instructions, /did not resolve: sources_complete/);
  assert.match(runs[1].adjusted_instructions, /5\. fail/);
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
