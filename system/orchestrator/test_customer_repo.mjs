import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { generateCustomerRepo, lintFrontmatter, publishCustomerRepo } from "./customer_repo.mjs";
import { utcNow } from "./util.mjs";

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
  assert.ok(fs.existsSync(repo_url));
  const ls = spawnSync("git", ["ls-remote", "origin"], { cwd: targetDir, encoding: "utf8" });
  assert.equal(ls.status, 0, ls.stderr);
  assert.match(ls.stdout, /HEAD/);
  const name = spawnSync("git", ["config", "user.name"], { cwd: targetDir, encoding: "utf8" });
  const email = spawnSync("git", ["config", "user.email"], { cwd: targetDir, encoding: "utf8" });
  assert.equal(name.stdout.trim(), "Moe Ghashim");
  assert.equal(email.stdout.trim(), "mohanadgh@gmail.com");
  fs.rmSync(tmp, { recursive: true, force: true });
});
