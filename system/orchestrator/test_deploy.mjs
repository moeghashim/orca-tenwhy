import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deploy, DeployRefused } from "./deploy.mjs";
import { generateCustomerRepo } from "./customer_repo.mjs";
import { ROOT, openDb, prefixedId, utcNow } from "./util.mjs";

const DEPLOY_SH = path.join(ROOT, "system/tools/deploy.sh");

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tenwhy-deploy-"));
  const dbPath = path.join(tmp, "t.db");
  const db = openDb(dbPath);
  const now = utcNow();
  const id = prefixedId("eng");
  const workdir = path.join(tmp, "state/customers/acme");
  generateCustomerRepo({
    slug: "acme",
    customerName: "Acme",
    idea: "clinic",
    siteUrl: "",
    targetDir: workdir,
  });
  db.prepare(
    `INSERT INTO engagements (id, customer_name, idea, site_url, repo_url, status, created_at, updated_at)
     VALUES (?, 'Acme', 'clinic', NULL, ?, 'running', ?, ?)`,
  ).run(id, workdir, now, now);
  db.prepare(
    "INSERT INTO events (engagement_id, loop_run_id, kind, payload, created_at) VALUES (?, NULL, 'engagement.created', ?, ?)",
  ).run(id, JSON.stringify({ slug: "acme" }), now);
  return { tmp, db, dbPath, id, workdir };
}

test("deploy.sh refuses without a matching approve row (exit 5)", () => {
  const { tmp, db, dbPath, id } = setup();
  const missing = spawnSync("bash", [DEPLOY_SH, id, "apr_missing"], {
    encoding: "utf8",
    env: { ...process.env, TENWHY_DB: dbPath, TENWHY_SLUG: "acme", TENWHY_REPO_DIR: path.join(tmp, "state/customers/acme") },
  });
  assert.equal(missing.status, 5, missing.stdout + missing.stderr);
  const body = JSON.parse(missing.stdout.trim().split("\n").at(-1));
  assert.equal(body.refused, true);
  assert.ok(body.reason);

  const apr = prefixedId("apr");
  db.prepare(
    "INSERT INTO approvals (id, engagement_id, action, notes, created_at) VALUES (?, ?, 'approve', NULL, ?)",
  ).run(apr, id, utcNow());
  const running = spawnSync("bash", [DEPLOY_SH, id, apr], {
    encoding: "utf8",
    env: { ...process.env, TENWHY_DB: dbPath, TENWHY_SLUG: "acme", TENWHY_REPO_DIR: path.join(tmp, "state/customers/acme") },
  });
  assert.equal(running.status, 5, running.stdout + running.stderr);
  const body2 = JSON.parse(running.stdout.trim().split("\n").at(-1));
  assert.equal(body2.refused, true);
  assert.match(body2.reason, /awaiting_approval/);
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("deploy.mjs records deploy.refused on a temp DB", async () => {
  const { tmp, db, dbPath, id, workdir } = setup();
  await assert.rejects(
    () =>
      deploy({
        engagementId: id,
        approvalId: "apr_none",
        repoDir: workdir,
        db,
        dbPath,
        repoRoot: tmp,
        provision: false,
        slug: "acme",
      }),
    (err) => err instanceof DeployRefused,
  );
  const ev = db.prepare("SELECT kind, payload FROM events WHERE kind = 'deploy.refused'").get();
  assert.ok(ev);
  const payload = JSON.parse(ev.payload);
  assert.equal(payload.refused, true);
  assert.equal(payload.approvalId, "apr_none");
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
