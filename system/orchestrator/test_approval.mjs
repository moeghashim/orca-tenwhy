import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { generateCustomerRepo } from "./customer_repo.mjs";
import { tick } from "./orchestrator.mjs";
import { openDb, prefixedId, utcNow } from "./util.mjs";

const CONFIG = {
  caps: { iteration_cap: 4, retry_cap: 2 },
  loops: {
    "company-research": { outputs: ["research/RESEARCH.json"] },
    website: { outputs: ["brand/", "website/"] },
  },
  edges: [{ from: "company-research", to: "website" }],
};

function passingRunLoop() {
  return async ({ db, loopRunId, loopName, workdir }) => {
    db.prepare("UPDATE loop_runs SET status = 'running', started_at = ? WHERE id = ?").run(utcNow(), loopRunId);
    if (loopName === "company-research") {
      fs.mkdirSync(path.join(workdir, "research"), { recursive: true });
      fs.writeFileSync(
        path.join(workdir, "research/RESEARCH.json"),
        JSON.stringify({ company: { name: "Acme", customer_products: [] }, competitors: [] }),
      );
    }
    db.prepare("UPDATE loop_runs SET status = 'gate_passed', finished_at = ? WHERE id = ?").run(utcNow(), loopRunId);
    return { loopRunId, status: "gate_passed", iterations: [] };
  };
}

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tenwhy-apr-"));
  const db = openDb(path.join(tmp, "t.db"));
  const workdir = path.join(tmp, "state/customers/acme");
  generateCustomerRepo({
    slug: "acme",
    customerName: "Acme",
    idea: "clinic",
    siteUrl: "",
    targetDir: workdir,
  });
  const id = prefixedId("eng");
  const now = utcNow();
  db.prepare(
    `INSERT INTO engagements (id, customer_name, idea, site_url, repo_url, status, created_at, updated_at)
     VALUES (?, 'Acme', 'clinic', NULL, ?, 'new', ?, ?)`,
  ).run(id, workdir, now, now);
  return { tmp, db, workdir, id };
}

test("awaiting_approval does not deploy; approve deploys once then complete", async () => {
  const { tmp, db, id } = setup();
  const calls = [];
  const deploy = async (args) => {
    calls.push(args);
    return { liveUrl: "https://acme.example.workers.dev" };
  };
  await tick({ db, config: CONFIG, repoRoot: tmp, runLoop: passingRunLoop(), deploy });
  const afterGate = db.prepare("SELECT status FROM engagements WHERE id = ?").get(id);
  assert.equal(afterGate.status, "awaiting_approval");
  assert.equal(calls.length, 0);
  const apr = prefixedId("apr");
  db.prepare("INSERT INTO approvals (id, engagement_id, action, notes, created_at) VALUES (?, ?, 'approve', NULL, ?)").run(
    apr,
    id,
    utcNow(),
  );
  await tick({ db, config: CONFIG, repoRoot: tmp, runLoop: passingRunLoop(), deploy });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].engagementId, id);
  const done = db.prepare("SELECT status FROM engagements WHERE id = ?").get(id);
  assert.equal(done.status, "complete");
  const complete = db.prepare("SELECT payload FROM events WHERE kind = 'engagement.complete'").get();
  assert.equal(JSON.parse(complete.payload).liveUrl, "https://acme.example.workers.dev");
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("request_changes spawns website run at attempt 0 with change_request_id", async () => {
  const { tmp, db, id } = setup();
  await tick({ db, config: CONFIG, repoRoot: tmp, runLoop: passingRunLoop(), deploy: async () => ({}) });
  const prior = db.prepare("SELECT attempt FROM loop_runs WHERE loop_name = 'website'").all();
  assert.equal(prior.length, 1);
  assert.equal(prior[0].attempt, 0);
  const apr = prefixedId("apr");
  db.prepare(
    "INSERT INTO approvals (id, engagement_id, action, notes, created_at) VALUES (?, ?, 'request_changes', ?, ?)",
  ).run(apr, id, "Please use a darker green", utcNow());
  await tick({ db, config: CONFIG, repoRoot: tmp, runLoop: passingRunLoop(), deploy: async () => ({}) });
  const sites = db
    .prepare("SELECT attempt, change_request_id, adjusted_instructions, status FROM loop_runs WHERE loop_name = 'website'")
    .all();
  assert.equal(sites.length, 2);
  const original = sites.find((s) => s.change_request_id == null);
  const cr = sites.find((s) => s.change_request_id === apr);
  assert.ok(original);
  assert.equal(original.attempt, 0);
  assert.ok(cr);
  assert.equal(cr.attempt, 0);
  assert.match(cr.adjusted_instructions, /^Customer change request:\nPlease use a darker green/);
  const eng = db.prepare("SELECT status FROM engagements WHERE id = ?").get(id);
  assert.equal(eng.status, "running");
  const ev = db.prepare("SELECT 1 FROM events WHERE kind = 'engagement.change_requested'").get();
  assert.ok(ev);
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("approve while running → approval.rejected_state, no deploy", async () => {
  const { tmp, db, id } = setup();
  db.prepare("UPDATE engagements SET status = 'running' WHERE id = ?").run(id);
  const calls = [];
  const apr = prefixedId("apr");
  db.prepare("INSERT INTO approvals (id, engagement_id, action, notes, created_at) VALUES (?, ?, 'approve', NULL, ?)").run(
    apr,
    id,
    utcNow(),
  );
  await tick({
    db,
    config: CONFIG,
    repoRoot: tmp,
    runLoop: passingRunLoop(),
    deploy: async (args) => {
      calls.push(args);
      return { liveUrl: "nope" };
    },
  });
  assert.equal(calls.length, 0);
  const ev = db.prepare("SELECT payload FROM events WHERE kind = 'approval.rejected_state'").get();
  assert.ok(ev);
  assert.equal(JSON.parse(ev.payload).approvalId, apr);
  const eng = db.prepare("SELECT status FROM engagements WHERE id = ?").get(id);
  assert.equal(eng.status, "running");
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
