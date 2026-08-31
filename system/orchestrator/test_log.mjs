import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { generateCustomerRepo } from "./customer_repo.mjs";
import { tick } from "./orchestrator.mjs";
import { utcNow } from "./util.mjs";

function captureStdout(fn) {
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = (chunk, encoding, cb) => {
    chunks.push(String(chunk));
    if (typeof encoding === "function") encoding();
    if (typeof cb === "function") cb();
    return true;
  };
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      process.stdout.write = orig;
    })
    .then((result) => ({ result, text: chunks.join("") }));
}

test("tick emits structured logs for start, loop, and end", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tenwhy-log-"));
  const { openDb } = await import("./util.mjs");
  const db = openDb(path.join(tmp, "t.db"));
  const workdir = path.join(tmp, "state/customers/acme");
  generateCustomerRepo({
    slug: "acme",
    customerName: "Acme",
    idea: "clinic",
    siteUrl: "",
    targetDir: workdir,
  });
  const now = utcNow();
  db.prepare(
    `INSERT INTO engagements (id, customer_name, idea, site_url, repo_url, status, created_at, updated_at)
     VALUES ('eng_log', 'Acme', 'clinic', NULL, ?, 'new', ?, ?)`,
  ).run(workdir, now, now);
  const runLoop = async ({ db: runDb, loopRunId, loopName }) => {
    runDb.prepare("UPDATE loop_runs SET status = 'running', started_at = ? WHERE id = ?").run(utcNow(), loopRunId);
    runDb.prepare("UPDATE loop_runs SET status = 'gate_passed', finished_at = ? WHERE id = ?").run(utcNow(), loopRunId);
    return { loopRunId, status: "gate_passed", iterations: [], gateChecks: [] };
  };
  const { text } = await captureStdout(() =>
    tick({
      db,
      config: {
        caps: { iteration_cap: 4, retry_cap: 2 },
        loops: { "company-research": { outputs: ["research/RESEARCH.json"] } },
        edges: [],
      },
      repoRoot: tmp,
      runLoop,
      absorbResearch: async () => {},
      processApprovals: async () => {},
    }),
  );
  assert.match(text, /\binfo tick start\b/);
  assert.match(text, /\binfo loop start\b/);
  assert.match(text, /\binfo loop end\b.*status=gate_passed/);
  assert.match(text, /\binfo tick end\b/);
  assert.doesNotMatch(text, /SITE_API_TOKEN=/);
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
