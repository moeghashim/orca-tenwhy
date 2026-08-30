import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { generateCustomerRepo } from "./customer_repo.mjs";
import { computeHandoff, tick } from "./orchestrator.mjs";
import { insertEvent, openDb, utcNow } from "./util.mjs";

const BASE_CONFIG = {
  caps: { iteration_cap: 4, retry_cap: 2 },
  loops: {
    "company-research": {
      inputs: ["idea", "site_url"],
      outputs: ["research/RESEARCH.json", "research/SOURCES.md", "company/"],
    },
    website: {
      inputs: ["research/RESEARCH.json"],
      outputs: ["brand/", "website/"],
    },
  },
  edges: [{ from: "company-research", to: "website" }],
};

function writeResearch(workdir) {
  fs.mkdirSync(path.join(workdir, "research"), { recursive: true });
  const json = {
    company: {
      name: "Acme Dental",
      customer_products: [
        { id: "p1", name: "Whitening" },
        { id: "p2", name: "Aligners" },
      ],
    },
    competitors: [{ name: "C1" }, { name: "C2" }, { name: "C3" }],
  };
  fs.writeFileSync(path.join(workdir, "research/RESEARCH.json"), JSON.stringify(json, null, 2));
  fs.writeFileSync(path.join(workdir, "research/SOURCES.md"), "# sources\n");
  return json;
}

function createRunLoopFixture({ delayMs = 40, clocks }) {
  return async ({ db, loopRunId, loopName, workdir }) => {
    clocks[loopName] = clocks[loopName] || {};
    clocks[loopName].started = Date.now();
    db.prepare("UPDATE loop_runs SET status = 'running', started_at = ? WHERE id = ?").run(
      utcNow(),
      loopRunId,
    );
    await new Promise((r) => setTimeout(r, delayMs));
    if (loopName === "company-research") writeResearch(workdir);
    db.prepare("UPDATE loop_runs SET status = 'gate_passed', finished_at = ? WHERE id = ?").run(
      utcNow(),
      loopRunId,
    );
    clocks[loopName].finished = Date.now();
    return { loopRunId, status: "gate_passed", iterations: [], gateChecks: [] };
  };
}

function setup(tmp, { customerName = "Acme Dental" } = {}) {
  const db = openDb(path.join(tmp, "t.db"));
  const slug = "acme-dental";
  const workdir = path.join(tmp, "state/customers", slug);
  generateCustomerRepo({
    slug,
    customerName,
    idea: "Boutique dental clinic",
    siteUrl: "https://example.com",
    targetDir: workdir,
  });
  const id = "eng_test000";
  const now = utcNow();
  db.prepare(
    `INSERT INTO engagements (id, customer_name, idea, site_url, repo_url, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'new', ?, ?)`,
  ).run(id, customerName, "Boutique dental clinic", "https://example.com", workdir, now, now);
  return { db, workdir, id };
}

test("research runs first; website queued only after gate_passed; handoff payload matches outputs", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tenwhy-sched-"));
  const { db, workdir, id } = setup(tmp);
  const clocks = {};
  const order = [];
  const runLoop = async (opts) => {
    order.push(opts.loopName);
    return createRunLoopFixture({ delayMs: 5, clocks })(opts);
  };
  await tick({ db, config: BASE_CONFIG, runLoop, repoRoot: tmp });
  assert.deepEqual(order, ["company-research", "website"]);
  const runs = db
    .prepare("SELECT loop_name, status, started_at, finished_at FROM loop_runs ORDER BY started_at")
    .all();
  assert.equal(runs[0].loop_name, "company-research");
  assert.equal(runs[0].status, "gate_passed");
  assert.equal(runs[1].loop_name, "website");
  assert.equal(runs[1].status, "gate_passed");
  assert.ok(runs[0].finished_at <= runs[1].started_at);
  const handoff = db.prepare("SELECT payload FROM events WHERE kind = 'handoff'").get();
  assert.ok(handoff);
  const payload = JSON.parse(handoff.payload);
  const expected = computeHandoff(workdir, { customer_name: "Acme Dental" });
  assert.equal(payload.from, "company-research");
  assert.equal(payload.to, "website");
  assert.equal(payload.companyName, expected.companyName);
  assert.equal(payload.productCount, 2);
  assert.equal(payload.competitorCount, 3);
  assert.equal(payload.researchJsonPath, expected.researchJsonPath);
  assert.equal(payload.sourcesPath, expected.sourcesPath);
  const eng = db.prepare("SELECT status FROM engagements WHERE id = ?").get(id);
  assert.equal(eng.status, "awaiting_approval");
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("two root loops from edges run concurrently", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tenwhy-par-"));
  const { db } = setup(tmp);
  const config = {
    ...BASE_CONFIG,
    loops: {
      ...BASE_CONFIG.loops,
      "extra-root": { inputs: [], outputs: [] },
    },
    edges: [{ from: "company-research", to: "website" }],
  };
  const clocks = {};
  await tick({
    db,
    config,
    repoRoot: tmp,
    runLoop: createRunLoopFixture({ delayMs: 50, clocks }),
  });
  assert.ok(clocks["company-research"]?.started);
  assert.ok(clocks["extra-root"]?.started);
  assert.ok(clocks["company-research"].started < clocks["extra-root"].finished);
  assert.ok(clocks["extra-root"].started < clocks["company-research"].finished);
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
