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

function checkNotes(summary = "fixture") {
  return [1, 2, 3, 4, 5].map((n) => `${n}. pass — ${summary}.`).join("\n");
}

function withResearchJson(label) {
  const payload = {
    RESEARCH: {
      company: {
        name: "Acme",
        summary: String(label),
        customer_products: [{ id: "cp_01", name: "Widget", price: null, url: "" }],
      },
      competitors: [],
      product_matches: [],
      enhancement_ideas: [],
    },
    SOURCES_MD: "| url | http_status | note |\n| --- | --- | --- |\n",
  };
  return `${label}\n\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`\n`;
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
      executor: [withResearchJson("draft-1"), withResearchJson("draft-2")],
      reviewer: [
        JSON.stringify({ verdict: "revise", notes: checkNotes("needs work") }),
        JSON.stringify({ verdict: "approve", notes: checkNotes("ok") }),
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
      executor: [
        withResearchJson("draft-1"),
        withResearchJson("draft-2"),
        withResearchJson("draft-3"),
        withResearchJson("draft-4"),
      ],
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
  const revise = JSON.stringify({ verdict: "revise", notes: checkNotes("again") });
  const { db, result } = await run(
    t,
    createFixtureAdapter({
      executor: [
        withResearchJson("a"),
        withResearchJson("b"),
        withResearchJson("c"),
        withResearchJson("d"),
      ],
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
      executor: [withResearchJson("draft")],
      reviewer: [JSON.stringify({ verdict: "escalate", notes: checkNotes("need Moe") })],
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
      executor: [withResearchJson("draft")],
      reviewer: [JSON.stringify({ verdict: "approve", notes: checkNotes("ok") })],
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
    executor: [withResearchJson("THE-EXECUTOR-WROTE-THIS-9f2c")],
    reviewer: [JSON.stringify({ verdict: "approve", notes: checkNotes("ok") })],
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

test("I: executor prompt includes idea/site_url and handoff JSON from inputs", async (t) => {
  const seen = [];
  const inner = createFixtureAdapter({
    executor: [withResearchJson("draft")],
    reviewer: [JSON.stringify({ verdict: "approve", notes: checkNotes("ok") })],
  });
  const capturing = {
    async run(args) {
      seen.push({ role: args.role, prompt: args.prompt });
      return inner.run(args);
    },
  };
  const ctx = setup();
  t.after(() => {
    ctx.db.close();
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  });
  const handoff = {
    researchJsonPath: "/tmp/research/RESEARCH.json",
    sourcesPath: "/tmp/research/SOURCES.md",
    companyName: "Acme Dental",
    productCount: 2,
    competitorCount: 5,
  };
  await runLoop({
    db: ctx.db,
    dbPath: ctx.dbPath,
    loopName: "company-research",
    engagementId: ctx.engagementId,
    attempt: 0,
    workdir: ctx.workdir,
    config: CONFIG,
    adapter: capturing,
    gateRunner: async () => [{ check_name: "ok", passed: 1, detail: "" }],
    inputs: {
      idea: "Boutique dental clinic in Amman",
      site_url: "https://example.com/clinic",
      ...handoff,
    },
  });
  const execPrompt = seen.find((s) => s.role === "executor").prompt;
  assert.match(execPrompt, /Boutique dental clinic in Amman/);
  assert.match(execPrompt, /https:\/\/example.com\/clinic/);
  assert.match(execPrompt, /Handoff JSON:/);
  assert.match(execPrompt, /RESEARCH\.json/);
  assert.match(execPrompt, /"companyName":"Acme Dental"/);
  const started = ctx.db
    .prepare("SELECT payload FROM events WHERE kind = 'loop_run.started' ORDER BY id DESC LIMIT 1")
    .get();
  const payload = JSON.parse(started.payload);
  assert.equal(payload.inputs.idea, "Boutique dental clinic in Amman");
  assert.equal(payload.inputs.site_url, "https://example.com/clinic");
});

test("J: trailing prose after JSON fence → revise FORMAT, reviewer never called", async (t) => {
  let reviewerCalls = 0;
  const inner = createFixtureAdapter({
    executor: [
      `${withResearchJson("draft")}\nThanks, please review.\n`,
      `${withResearchJson("draft2")}\nThanks, please review.\n`,
      `${withResearchJson("draft3")}\nThanks, please review.\n`,
      `${withResearchJson("draft4")}\nThanks, please review.\n`,
    ],
    reviewer: [JSON.stringify({ verdict: "approve", notes: "should not run" })],
  });
  const capturing = {
    async run(args) {
      if (args.role === "reviewer") reviewerCalls += 1;
      return inner.run(args);
    },
  };
  const { result } = await run(t, capturing, async () => {
    throw new Error("gate must not run");
  });
  assert.equal(result.iterations[0].verdict, "revise");
  assert.match(result.iterations[0].notes, /^FORMAT:/);
  assert.match(result.iterations[0].notes, /JSON fence must be the last content of the message/);
  assert.equal(reviewerCalls, 0);
});

test("H: executor output with no JSON block → revise FORMAT, reviewer never called", async (t) => {
  let reviewerCalls = 0;
  const inner = createFixtureAdapter({
    executor: ["no json here", "still no json", "nope", "nothing"],
    reviewer: [JSON.stringify({ verdict: "approve", notes: "should not run" })],
  });
  const capturing = {
    async run(args) {
      if (args.role === "reviewer") reviewerCalls += 1;
      return inner.run(args);
    },
  };
  const { db, result } = await run(t, capturing, async () => {
    throw new Error("gate must not run");
  });
  assert.equal(result.status, "gate_failed");
  assert.equal(result.iterations.length, 4);
  assert.equal(result.iterations[0].verdict, "revise");
  assert.match(result.iterations[0].notes, /^FORMAT:/);
  assert.equal(reviewerCalls, 0);
  const row = db
    .prepare("SELECT reviewer_verdict, reviewer_notes FROM iterations WHERE loop_run_id = ? AND n = 1")
    .get(result.loopRunId);
  assert.equal(row.reviewer_verdict, "revise");
  assert.ok(row.reviewer_notes.startsWith("FORMAT:"));
  const ev = db
    .prepare("SELECT payload FROM events WHERE loop_run_id = ? AND kind = 'iteration.recorded' ORDER BY id LIMIT 1")
    .get(result.loopRunId);
  assert.equal(JSON.parse(ev.payload).materialize, false);
});

function designerFence() {
  const payload = {
    tokens: {
      color: { bg: "#f6f1ea", surface: "#fffaf4", text: "#2a241c", accent: "#1a6b63" },
      type: { family: { ui: "Georgia, serif", mono: "ui-monospace, monospace" } },
      space: { unit: 8 },
      radius: 12,
    },
    BRAND_MD: "Voice: calm.",
    logo_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="32"><text y="24">Acme</text></svg>',
    IMAGE_BRIEF_MD: "| asset | path | description | size |\n| hero | /images/hero.svg | hero | 800x400 |\n",
  };
  return `ok\n\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`\n`;
}

test("K: website prepare success emits loop_run.prepared then iterations", async (t) => {
  const ctx = setup();
  t.after(() => {
    ctx.db.close();
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(ctx.workdir, "research"), { recursive: true });
  fs.writeFileSync(
    path.join(ctx.workdir, "research/RESEARCH.json"),
    JSON.stringify({
      company: {
        name: "Acme Dental",
        summary: "clinic",
        customer_products: [
          { id: "cp_01", name: "Teeth whitening", price: 80, url: "" },
          { id: "cp_02", name: "Clear aligners", price: 1200, url: "" },
          { id: "cp_03", name: "Hygiene checkup", price: 40, url: "" },
        ],
      },
    }),
  );
  const seen = [];
  const inner = createFixtureAdapter({
    executor: ["built site"],
    reviewer: [designerFence(), JSON.stringify({ verdict: "approve", notes: "1. 2. 3. 4. 5." })],
  });
  const capturing = {
    async run(args) {
      seen.push(args.role);
      return inner.run(args);
    },
  };
  const result = await runLoop({
    db: ctx.db,
    dbPath: ctx.dbPath,
    loopName: "website",
    engagementId: ctx.engagementId,
    attempt: 0,
    workdir: ctx.workdir,
    config: CONFIG,
    adapter: capturing,
    gateRunner: async () => [{ check_name: "ok", passed: 1, detail: "" }],
  });
  assert.equal(result.status, "gate_passed");
  assert.deepEqual(seen, ["reviewer", "executor", "reviewer"]);
  assert.equal(fs.existsSync(path.join(ctx.workdir, "brand/tokens.json")), true);
  assert.deepEqual(kinds(ctx.db, result.loopRunId), [
    "loop_run.started",
    "loop_run.prepared",
    "iteration.recorded",
    "gate.checked",
    "loop_run.finished",
  ]);
});

test("L: website prepare failure records design_spec and gate_failed", async (t) => {
  const ctx = setup();
  t.after(() => {
    ctx.db.close();
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(ctx.workdir, "research"), { recursive: true });
  fs.writeFileSync(
    path.join(ctx.workdir, "research/RESEARCH.json"),
    JSON.stringify({ company: { name: "Acme Dental", customer_products: [] } }),
  );
  let execCalls = 0;
  const inner = createFixtureAdapter({
    executor: ["should not run"],
    reviewer: ["not json at all"],
  });
  const capturing = {
    async run(args) {
      if (args.role === "executor") execCalls += 1;
      return inner.run(args);
    },
  };
  const result = await runLoop({
    db: ctx.db,
    dbPath: ctx.dbPath,
    loopName: "website",
    engagementId: ctx.engagementId,
    attempt: 0,
    workdir: ctx.workdir,
    config: CONFIG,
    adapter: capturing,
    gateRunner: async () => {
      throw new Error("gate must not run");
    },
  });
  assert.equal(result.status, "gate_failed");
  assert.equal(execCalls, 0);
  const checks = ctx.db
    .prepare("SELECT check_name, passed FROM gate_checks WHERE loop_run_id = ?")
    .all(result.loopRunId);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].check_name, "design_spec");
  assert.equal(checks[0].passed, 0);
  const runRow = ctx.db.prepare("SELECT status, pi_trace_ref FROM loop_runs WHERE id = ?").get(result.loopRunId);
  assert.equal(runRow.status, "gate_failed");
  assert.equal(runRow.pi_trace_ref, "fixture://reviewer/0");
  assert.ok(kinds(ctx.db, result.loopRunId).includes("gate.checked"));
  assert.ok(!kinds(ctx.db, result.loopRunId).includes("loop_run.prepared"));
});
