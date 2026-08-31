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

test("deploy.sh redacts wrangler credentials from DEPLOY.md, stdout, and events", async () => {
  const { tmp, db, dbPath, id, workdir } = setup();
  db.prepare("UPDATE engagements SET status = 'awaiting_approval' WHERE id = ?").run(id);
  const apr = prefixedId("apr");
  db.prepare(
    "INSERT INTO approvals (id, engagement_id, action, notes, created_at) VALUES (?, ?, 'approve', NULL, ?)",
  ).run(apr, id, utcNow());
  fs.mkdirSync(path.join(workdir, "website/dist"), { recursive: true });
  fs.writeFileSync(path.join(workdir, "website/dist/index.html"), "<html>ok</html>");

  const token = "tok_live_fake_secret_99";
  const account = "acct_fake_account_99";
  const planToken = "cfplan_token_value_16";
  const provisionDir = path.join(tmp, "state/provision");
  fs.mkdirSync(provisionDir, { recursive: true });
  const envFile = path.join(provisionDir, ".env");
  fs.writeFileSync(
    envFile,
    `SITE_API_TOKEN=${token}\nSITE_ACCOUNT_ID=${account}\nCLOUDFLARE_PLAN_API_TOKEN=${planToken}\n`,
  );
  fs.writeFileSync(
    path.join(provisionDir, `${id}.json`),
    JSON.stringify({
      engagement_id: id,
      slug: "acme",
      env_var_names: ["SITE_API_TOKEN", "SITE_ACCOUNT_ID", "CLOUDFLARE_PLAN_API_TOKEN"],
      env_file: envFile,
    }),
  );

  const bin = path.join(tmp, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "wrangler"),
    `#!/bin/bash
echo "Deployed tenwhy-acme"
echo "  https://tenwhy-acme.example.workers.dev"
echo "Current Version ID: 01234567-89ab-cdef-0123-456789abcdef"
echo "Using token ${token} and account ${account} plan ${planToken}"
exit 0
`,
  );
  fs.writeFileSync(
    path.join(bin, "curl"),
    `#!/bin/bash
echo -n 200
exit 0
`,
  );
  fs.chmodSync(path.join(bin, "wrangler"), 0o755);
  fs.chmodSync(path.join(bin, "curl"), 0o755);

  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    TENWHY_DB: dbPath,
    TENWHY_SLUG: "acme",
    TENWHY_REPO_DIR: workdir,
    TENWHY_ENV_FILE: envFile,
    SITE_API_TOKEN: token,
    SITE_ACCOUNT_ID: account,
  };
  const spawned = spawnSync("bash", [DEPLOY_SH, id, apr], { encoding: "utf8", env });
  assert.equal(spawned.status, 0, `${spawned.stdout}\n${spawned.stderr}`);
  const deployMd = fs.readFileSync(path.join(workdir, "website/DEPLOY.md"), "utf8");
  const secrets = [token, account, planToken];
  for (const secret of secrets) {
    assert.equal(deployMd.includes(secret), false, `DEPLOY.md leaked ${secret}`);
    assert.equal(spawned.stdout.includes(secret), false, `stdout leaked ${secret}`);
    assert.equal(spawned.stderr.includes(secret), false, `stderr leaked ${secret}`);
  }
  assert.match(deployMd, /https:\/\/tenwhy-acme\.example\.workers\.dev/);
  assert.match(deployMd, /01234567-89ab-cdef-0123-456789abcdef/);
  assert.match(deployMd, /\[redacted\]/);

  const prevPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${prevPath}`;
  try {
    await deploy({
      engagementId: id,
      approvalId: apr,
      repoDir: workdir,
      db,
      dbPath,
      repoRoot: tmp,
      provision: false,
      slug: "acme",
    });
  } finally {
    process.env.PATH = prevPath;
  }
  const events = db.prepare("SELECT kind, payload FROM events").all();
  for (const ev of events) {
    for (const secret of secrets) {
      assert.equal(String(ev.payload).includes(secret), false, `${ev.kind} leaked ${secret}`);
    }
  }
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
