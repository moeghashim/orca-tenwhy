import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { cmdRepairRepoUrl } from "./commands.mjs";
import {
  generateCustomerRepo,
  githubHttpsUrl,
  lintFrontmatter,
  publishCustomerRepo,
} from "./customer_repo.mjs";
import { insertEvent, openDb, utcNow } from "./util.mjs";

const REQUIRED = [
  "BRIEF.md",
  "company/OVERVIEW.md",
  "company/POSITIONING.md",
  "company/FINDINGS.md",
  "company/competitors/.gitkeep",
  "company/products/.gitkeep",
  "research/.gitkeep",
  "brand/.gitkeep",
  "website/.gitkeep",
];

test("generated repo matches §8 tree, lints, and local origin ls-remote exits 0", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tenwhy-cust-"));
  const targetDir = path.join(tmp, "acme");
  const remotesDir = path.join(tmp, "remotes");
  const now = utcNow();
  generateCustomerRepo({
    slug: "acme",
    customerName: "Acme Dental",
    idea: "Boutique dental clinic in Amman",
    siteUrl: "https://example.com",
    targetDir,
    now,
  });
  for (const rel of REQUIRED) {
    assert.ok(fs.existsSync(path.join(targetDir, rel)), `missing ${rel}`);
  }
  const brief = fs.readFileSync(path.join(targetDir, "BRIEF.md"), "utf8");
  assert.match(brief, /Acme Dental/);
  assert.match(brief, /Boutique dental clinic in Amman/);
  assert.match(brief, /https:\/\/example.com/);
  assert.match(brief, new RegExp(`updated: ${now}`));
  const problems = lintFrontmatter(targetDir);
  assert.deepEqual(problems, []);
  const { repo_url } = publishCustomerRepo({
    dir: targetDir,
    slug: "acme",
    backend: "local",
    remotesDir,
  });
  assert.match(repo_url, /^file:\/\//);
  assert.ok(repo_url.includes("/state/remotes/acme.git") || repo_url.endsWith("/remotes/acme.git"));
  assert.ok(fs.existsSync(fileURLToPath(repo_url)));
  const ls = spawnSync("git", ["ls-remote", "origin"], { cwd: targetDir, encoding: "utf8" });
  assert.equal(ls.status, 0, ls.stderr);
  assert.match(ls.stdout, /HEAD/);
  const name = spawnSync("git", ["config", "user.name"], { cwd: targetDir, encoding: "utf8" });
  const email = spawnSync("git", ["config", "user.email"], { cwd: targetDir, encoding: "utf8" });
  assert.equal(name.stdout.trim(), "Moe Ghashim");
  assert.equal(email.stdout.trim(), "mohanadgh@gmail.com");
  fs.rmSync(tmp, { recursive: true, force: true });
});

function stubGh({ createOut, viewUrl }) {
  return (cmd, args, opts) => {
    if (cmd !== "gh") return spawnSync(cmd, args, opts);
    if (args[0] === "repo" && args[1] === "create") {
      return { status: 0, stdout: createOut, stderr: "", error: undefined };
    }
    if (args[0] === "repo" && args[1] === "view") {
      return { status: 0, stdout: `${viewUrl}\n`, stderr: "", error: undefined };
    }
    return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
  };
}

const GH_CREATE_OUT = `https://github.com/moeghashim/tenwhy-acme
https://github.com/moeghashim/tenwhy-acme.git
Created repository moeghashim/tenwhy-acme on github.com
  git clone git@github.com:moeghashim/tenwhy-acme.git
origin/main.
`;

test("github backend records the https URL, not a fragment of gh output", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tenwhy-gh-"));
  const targetDir = path.join(tmp, "acme");
  generateCustomerRepo({
    slug: "acme",
    customerName: "Acme",
    idea: "clinic",
    siteUrl: "",
    targetDir,
  });
  const { repo_url } = publishCustomerRepo({
    dir: targetDir,
    slug: "acme",
    backend: "github",
    spawn: stubGh({
      createOut: GH_CREATE_OUT,
      viewUrl: "https://github.com/moeghashim/tenwhy-acme",
    }),
  });
  assert.equal(repo_url, "https://github.com/moeghashim/tenwhy-acme");
  assert.equal(repo_url, githubHttpsUrl("acme"));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("github backend fails loudly when gh repo view disagrees", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tenwhy-gh-"));
  const targetDir = path.join(tmp, "acme");
  generateCustomerRepo({
    slug: "acme",
    customerName: "Acme",
    idea: "clinic",
    siteUrl: "",
    targetDir,
  });
  assert.throws(
    () =>
      publishCustomerRepo({
        dir: targetDir,
        slug: "acme",
        backend: "github",
        spawn: stubGh({
          createOut: GH_CREATE_OUT,
          viewUrl: "https://github.com/other/tenwhy-acme",
        }),
      }),
    /github url mismatch/,
  );
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("repair-repo-url updates the row and emits engagement.repo_url_repaired", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tenwhy-repair-"));
  const dbPath = path.join(tmp, "t.db");
  const db = openDb(dbPath);
  const now = utcNow();
  db.prepare(
    `INSERT INTO engagements (id, customer_name, idea, site_url, repo_url, status, created_at, updated_at)
     VALUES ('eng_e15d4850', 'Tenwhy', 'idea', NULL, 'origin/main.', 'new', ?, ?)`,
  ).run(now, now);
  insertEvent(db, {
    engagementId: "eng_e15d4850",
    kind: "engagement.created",
    payload: { slug: "tenwhy", customerName: "Tenwhy" },
  });
  db.close();
  const { repo_url, previous } = cmdRepairRepoUrl({
    engagementId: "eng_e15d4850",
    dbPath,
    repoRoot: tmp,
    backend: "github",
    spawn: stubGh({
      createOut: "",
      viewUrl: "https://github.com/moeghashim/tenwhy-tenwhy",
    }),
  });
  assert.equal(previous, "origin/main.");
  assert.equal(repo_url, "https://github.com/moeghashim/tenwhy-tenwhy");
  const db2 = openDb(dbPath);
  const row = db2.prepare("SELECT repo_url FROM engagements WHERE id = ?").get("eng_e15d4850");
  assert.equal(row.repo_url, "https://github.com/moeghashim/tenwhy-tenwhy");
  const ev = db2.prepare("SELECT kind, payload FROM events WHERE kind = 'engagement.repo_url_repaired'").get();
  assert.ok(ev);
  const payload = JSON.parse(ev.payload);
  assert.equal(payload.previous, "origin/main.");
  assert.equal(payload.repo_url, "https://github.com/moeghashim/tenwhy-tenwhy");
  assert.equal(payload.slug, "tenwhy");
  db2.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
