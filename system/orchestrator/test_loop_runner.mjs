import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createFixtureAdapter } from "./adapters/fixture.mjs";
import { runLoop } from "./loop_runner.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CONFIG = {
  caps: { iteration_cap: 4, retry_cap: 2 },
  roles: {
    executor: { harness: "pi", provider: "xai", model: "grok-4.6", thinking: "high", auth: "oauth" },
    reviewer: {
      harness: "pi",
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      thinking: "high",
      auth: "oauth",
    },
  },
  loops: {
    "company-research": { gate: "system/gates/research_gate.py" },
  },
};

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tenwhy-loop-"));
  const dbPath = path.join(dir, "t.db");
  const workdir = path.join(dir, "work");
  fs.mkdirSync(workdir);
  const migrated = spawnSync("bash", [path.join(ROOT, "system/db/migrate.sh"), dbPath], {
    encoding: "utf8",
  });
  assert.equal(migrated.status, 0, migrated.stderr);
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  const engagementId = "e-test";
  db.prepare(
    "INSERT INTO engagements (id, status, created_at, updated_at) VALUES (?, ?, datetime('now'), datetime('now'))",
  ).run(engagementId, "running");
  return { dir, dbPath, db, workdir, engagementId };
}

function kinds(db, loopRunId) {
  return db
    .prepare("SELECT kind FROM events WHERE loop_run_id = ? ORDER BY id")
    .all(loopRunId)
    .map((r) => r.kind);
}

async function run(t, adapter, gateRunner) {
  const ctx = setup();
  t.after(() => {
    ctx.db.close();
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  });
  const result = await runLoop({
    db: ctx.db,
    dbPath: ctx.dbPath,
    loopName: "company-research",
    engagementId: ctx.engagementId,
    attempt: 0,
    workdir: ctx.workdir,
    config: CONFIG,
    adapter,
    gateRunner,
  });
  return { ...ctx, result };
}

test("A: revise then approve, gate all-pass → gate_passed", async (t) => {
  const { db, result } = await run(
    t,
    createFixtureAdapter({
      executor: ["draft-1", "draft-2"],
      reviewer: [
        JSON.stringify({ verdict: "revise", notes: "needs work" }),
        JSON.stringify({ verdict: "approve", notes: "ok" }),
      ],
    }),
    async () => [{ check_name: "ok", passed: 1, detail: "all good" }],
  );
  assert.equal(result.status, "gate_passed");
  const runRow = db.prepare("SELECT status FROM loop_runs WHERE id = ?").get(result.loopRunId);
  assert.equal(runRow.status, "gate_passed");
  const iters = db
    .prepare("SELECT n, reviewer_verdict FROM iterations WHERE loop_run_id = ? ORDER BY n")
    .all(result.loopRunId);
  assert.equal(iters.length, 2);
  assert.equal(iters[0].reviewer_verdict, "revise");
  assert.equal(iters[1].reviewer_verdict, "approve");
  const checks = db.prepare("SELECT check_name, passed FROM gate_checks WHERE loop_run_id = ?").all(result.loopRunId);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].passed, 1);
  assert.deepEqual(kinds(db, result.loopRunId), [
    "loop_run.started",
    "iteration.recorded",
    "iteration.recorded",
    "gate.checked",
    "loop_run.finished",
  ]);
});

test("B: reviewer prose with no JSON is coerced to revise FORMAT:", async (t) => {
  const prose = "This looks fine to me, ship it.";
  const { db, result } = await run(
    t,
    createFixtureAdapter({
      executor: ["draft-1", "draft-2", "draft-3", "draft-4"],
      reviewer: [prose, prose, prose, prose],
    }),
    async () => [{ check_name: "ok", passed: 1, detail: "ok" }],
  );
  assert.equal(result.iterations[0].verdict, "revise");
  assert.match(result.iterations[0].notes, /^FORMAT:/);
  const row = db
    .prepare("SELECT reviewer_verdict, reviewer_notes FROM iterations WHERE loop_run_id = ? AND n = 1")
    .get(result.loopRunId);
  assert.equal(row.reviewer_verdict, "revise");
  assert.ok(row.reviewer_notes.startsWith("FORMAT:"));
});

test("C: four revise → gate_failed, no gate_checks", async (t) => {
  const revise = JSON.stringify({ verdict: "revise", notes: "again" });
  const { db, result } = await run(
    t,
    createFixtureAdapter({
      executor: ["a", "b", "c", "d"],
      reviewer: [revise, revise, revise, revise],
    }),
    async () => [{ check_name: "should-not-run", passed: 1, detail: "nope" }],
  );
  assert.equal(result.status, "gate_failed");
  const iters = db.prepare("SELECT n FROM iterations WHERE loop_run_id = ?").all(result.loopRunId);
  assert.equal(iters.length, 4);
  const checks = db.prepare("SELECT id FROM gate_checks WHERE loop_run_id = ?").all(result.loopRunId);
  assert.equal(checks.length, 0);
  const runRow = db.prepare("SELECT status FROM loop_runs WHERE id = ?").get(result.loopRunId);
  assert.equal(runRow.status, "gate_failed");
});

test("D: escalate on iteration 1 → needs_human", async (t) => {
  const { db, result } = await run(
    t,
    createFixtureAdapter({
      executor: ["draft"],
      reviewer: [JSON.stringify({ verdict: "escalate", notes: "need Moe" })],
    }),
    async () => [{ check_name: "ok", passed: 1, detail: "ok" }],
  );
  assert.equal(result.status, "needs_human");
  const runRow = db.prepare("SELECT status FROM loop_runs WHERE id = ?").get(result.loopRunId);
  assert.equal(runRow.status, "needs_human");
  const kindsList = kinds(db, result.loopRunId);
  assert.ok(kindsList.includes("loop_run.needs_human"));
});

test("E: approve but gate fails one check → gate_failed", async (t) => {
  const { db, result } = await run(
    t,
    createFixtureAdapter({
      executor: ["draft"],
      reviewer: [JSON.stringify({ verdict: "approve", notes: "ok" })],
    }),
    async () => [
      { check_name: "schema", passed: 1, detail: "ok" },
      { check_name: "copy_grounded", passed: 0, detail: "missing products" },
    ],
  );
  assert.equal(result.status, "gate_failed");
  const checks = db
    .prepare("SELECT check_name, passed, detail FROM gate_checks WHERE loop_run_id = ? ORDER BY check_name")
    .all(result.loopRunId);
  const fail = checks.find((c) => c.check_name === "copy_grounded");
  assert.ok(fail);
  assert.equal(fail.passed, 0);
  assert.equal(fail.detail, "missing products");
});

test("F: adapter failure (e.g. pi exit≠0 / OAuth) → needs_human with loop_run.error, no iteration row", async (t) => {
  const failing = {
    async run({ role }) {
      const err = new Error(`pi ${role} run failed (exit 1): OAuth refresh failed`);
      err.code = "PI_RUN_FAILED";
      err.traceRef = "pi://session/dead-beef";
      throw err;
    },
  };
  const { db, result } = await run(t, failing, async () => {
    throw new Error("gate must not run");
  });
  assert.equal(result.status, "needs_human");
  assert.match(result.error, /OAuth refresh failed/);
  const runRow = db.prepare("SELECT status, pi_trace_ref FROM loop_runs WHERE id = ?").get(result.loopRunId);
  assert.equal(runRow.status, "needs_human");
  assert.equal(runRow.pi_trace_ref, "pi://session/dead-beef");
  assert.equal(db.prepare("SELECT count(*) c FROM iterations WHERE loop_run_id = ?").get(result.loopRunId).c, 0);
  assert.deepEqual(kinds(db, result.loopRunId), ["loop_run.started", "loop_run.error", "loop_run.needs_human"]);
  const ev = db.prepare("SELECT payload FROM events WHERE loop_run_id = ? AND kind = 'loop_run.error'").get(result.loopRunId);
  assert.equal(JSON.parse(ev.payload).role, "executor");
});

test("G: reviewer prompt inlines the executor output verbatim (no-tools reviewer can read the work)", async (t) => {
  const seen = [];
  const inner = createFixtureAdapter({
    executor: ["THE-EXECUTOR-WROTE-THIS-9f2c"],
    reviewer: [JSON.stringify({ verdict: "approve", notes: "ok" })],
  });
  const capturing = {
    async run(args) {
      seen.push({ role: args.role, prompt: args.prompt });
      return inner.run(args);
    },
  };
  const { result } = await run(t, capturing, async () => [{ check_name: "ok", passed: 1, detail: "" }]);
  assert.equal(result.status, "gate_passed");
  const reviewerPrompt = seen.find((s) => s.role === "reviewer").prompt;
  assert.match(reviewerPrompt, /=== EXECUTOR OUTPUT \(verbatim\) ===/);
  assert.match(reviewerPrompt, /THE-EXECUTOR-WROTE-THIS-9f2c/);
});
