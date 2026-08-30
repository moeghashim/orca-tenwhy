import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createOrchestratorModelFixture } from "./adapters/fixture.mjs";
import { generateCustomerRepo } from "./customer_repo.mjs";
import { cmdUpdate } from "./commands.mjs";
import { absorbResearch, historyEntries } from "./knowledge.mjs";
import { tick } from "./orchestrator.mjs";
import { openDb, utcNow } from "./util.mjs";

const CONFIG = {
  caps: { iteration_cap: 4, retry_cap: 2 },
  loops: {
    "company-research": { outputs: ["research/RESEARCH.json", "research/SOURCES.md"] },
    website: { outputs: ["brand/", "website/"] },
  },
  edges: [{ from: "company-research", to: "website" }],
};

const RESEARCH = {
  company: { name: "Acme", customer_products: [{ id: "p1", name: "Widget" }] },
  competitors: [{ name: "Rival Co" }],
};

function writeResearch(workdir) {
  fs.mkdirSync(path.join(workdir, "research"), { recursive: true });
  fs.writeFileSync(path.join(workdir, "research/RESEARCH.json"), JSON.stringify(RESEARCH));
  fs.writeFileSync(path.join(workdir, "research/SOURCES.md"), "# sources\n");
}

test("two research passes leave two dated History entries on company/*.md", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tenwhy-upd-"));
  const dbPath = path.join(tmp, "t.db");
  const db = openDb(dbPath);
  const workdir = path.join(tmp, "state/customers/acme");
  const t0 = utcNow();
  generateCustomerRepo({
    slug: "acme",
    customerName: "Acme",
    idea: "clinic",
    siteUrl: "",
    targetDir: workdir,
    now: t0,
  });
  for (const [rel, title] of [
    ["company/OVERVIEW.md", "Overview"],
    ["company/POSITIONING.md", "Positioning"],
    ["company/FINDINGS.md", "Findings"],
  ]) {
    fs.writeFileSync(
      path.join(workdir, rel),
      `---\nupdated: ${t0}\ntrace: none\n---\n\n# ${title}\n\nseed\n\n## History\n`,
    );
  }
  const engId = "eng_upd0000";
  db.prepare(
    `INSERT INTO engagements (id, customer_name, idea, site_url, repo_url, status, created_at, updated_at)
     VALUES (?, 'Acme', 'clinic', NULL, ?, 'new', ?, ?)`,
  ).run(engId, workdir, t0, t0);

  const model = createOrchestratorModelFixture();
  const runLoop = async ({ db: d, loopRunId, loopName, workdir: wd }) => {
    d.prepare("UPDATE loop_runs SET status = 'running', started_at = ? WHERE id = ?").run(utcNow(), loopRunId);
    if (loopName === "company-research") writeResearch(wd);
    d.prepare("UPDATE loop_runs SET status = 'gate_passed', finished_at = ? WHERE id = ?").run(utcNow(), loopRunId);
    return { loopRunId, status: "gate_passed", iterations: [{ executorTrace: `fixture://${loopRunId}` }] };
  };
  const absorb = (opts) => absorbResearch({ ...opts, model });

  await tick({ db, config: CONFIG, repoRoot: tmp, runLoop, absorbResearch: absorb, adapters: { orchestrator: model } });

  for (const name of ["OVERVIEW.md", "POSITIONING.md", "FINDINGS.md"]) {
    const hist = historyEntries(fs.readFileSync(path.join(workdir, "company", name), "utf8"));
    assert.equal(hist.length, 1, name);
  }
  const websites = db.prepare("SELECT id FROM loop_runs WHERE loop_name = 'website'").all();
  assert.equal(websites.length, 1);

  db.close();
  cmdUpdate({ engagementId: engId, dbPath });
  const db2 = openDb(dbPath);
  await tick({ db: db2, config: CONFIG, repoRoot: tmp, runLoop, absorbResearch: absorb, adapters: { orchestrator: model } });

  for (const name of ["OVERVIEW.md", "POSITIONING.md", "FINDINGS.md"]) {
    const hist = historyEntries(fs.readFileSync(path.join(workdir, "company", name), "utf8"));
    assert.equal(hist.length, 2, name);
    assert.notEqual(hist[0], hist[1]);
  }
  const websitesAfter = db2.prepare("SELECT id FROM loop_runs WHERE loop_name = 'website'").all();
  assert.equal(websitesAfter.length, 1);
  const absorbed = db2.prepare("SELECT 1 FROM events WHERE kind = 'update.absorbed'").all();
  assert.ok(absorbed.length >= 1);
  const requested = db2.prepare("SELECT 1 FROM events WHERE kind = 'engagement.update_requested'").all();
  assert.equal(requested.length, 1);
  db2.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
