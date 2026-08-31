import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, isIsoTimestamp, runGit, slugify, utcNow } from "./util.mjs";

export const GITHUB_OWNER = "moeghashim";

export function githubRepoName(slug) {
  return `tenwhy-${slug}`;
}

export function githubHttpsUrl(slug) {
  return `https://github.com/${GITHUB_OWNER}/${githubRepoName(slug)}`;
}

export function localRepoUrl(slug, remotesDir) {
  return pathToFileURL(path.resolve(remotesDir, `${slug}.git`)).href;
}

export function verifyGithubUrl(slug, spawn = spawnSync) {
  const expected = githubHttpsUrl(slug);
  const name = `${GITHUB_OWNER}/${githubRepoName(slug)}`;
  const view = spawn("gh", ["repo", "view", name, "--json", "url", "-q", ".url"], { encoding: "utf8" });
  if (view.error?.code === "ENOENT") return expected;
  if (view.status !== 0) {
    throw new Error(`gh repo view ${name} failed: ${(view.stderr || view.stdout || "").trim()}`);
  }
  const seen = (view.stdout || "").trim();
  if (seen && seen !== expected) {
    throw new Error(`github url mismatch for ${name}: expected ${expected}, gh says ${seen}`);
  }
  return expected;
}

const DEFAULT_TEMPLATE = path.join(ROOT, "templates/customer-repo");

function walkFiles(dir, acc = [], prefix = "") {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === ".git") continue;
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(full, acc, rel);
    else acc.push(rel);
  }
  return acc;
}

function fill(text, vars) {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key] ?? "") : `{{${key}}}`,
  );
}

function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return null;
  const fm = {};
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return fm;
}

export function lintFrontmatter(dir) {
  const problems = [];
  const files = walkFiles(dir).filter((f) => f.endsWith(".md"));
  if (files.length === 0) problems.push("no markdown files found");
  for (const rel of files) {
    const text = fs.readFileSync(path.join(dir, rel), "utf8");
    const fm = parseFrontmatter(text);
    if (!fm) {
      problems.push(`${rel}: missing frontmatter`);
      continue;
    }
    if (!isIsoTimestamp(fm.updated)) problems.push(`${rel}: invalid updated '${fm.updated ?? ""}'`);
    if (!fm.trace) problems.push(`${rel}: missing trace`);
    if (!/^## History\b/m.test(text)) problems.push(`${rel}: missing ## History section`);
  }
  return problems;
}

export function generateCustomerRepo({
  slug,
  customerName,
  idea = "",
  siteUrl = "",
  targetDir,
  now = utcNow(),
  templateDir = DEFAULT_TEMPLATE,
}) {
  if (!slug) throw new Error("slug is required");
  if (!targetDir) throw new Error("targetDir is required");
  fs.mkdirSync(targetDir, { recursive: true });
  const vars = {
    customer_name: customerName ?? slug,
    idea: idea || "(none)",
    site_url: siteUrl || "(none)",
    updated: now,
  };
  for (const rel of walkFiles(templateDir)) {
    const src = path.join(templateDir, rel);
    const dest = path.join(targetDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const raw = fs.readFileSync(src);
    if (rel.endsWith(".md") || rel.endsWith(".json") || rel.endsWith(".svg")) {
      fs.writeFileSync(dest, fill(raw.toString("utf8"), vars), "utf8");
    } else {
      fs.writeFileSync(dest, raw);
    }
  }
  runGit(targetDir, ["init", "-b", "main"]);
  runGit(targetDir, ["config", "user.name", "Moe Ghashim"]);
  runGit(targetDir, ["config", "user.email", "mohanadgh@gmail.com"]);
  runGit(targetDir, ["add", "-A"]);
  runGit(targetDir, ["commit", "-m", "init from template"]);
  return { dir: targetDir, slug };
}

export function publishCustomerRepo({
  dir,
  slug,
  backend = process.env.TENWHY_REPO_BACKEND || "github",
  remotesDir = path.join(ROOT, "state/remotes"),
  spawn = spawnSync,
}) {
  if (backend === "local") {
    fs.mkdirSync(remotesDir, { recursive: true });
    const bare = path.resolve(remotesDir, `${slug}.git`);
    if (!fs.existsSync(bare)) {
      const init = spawn("git", ["init", "--bare", "-b", "main", bare], { encoding: "utf8" });
      if (init.status !== 0) {
        throw new Error(`git init --bare failed: ${init.stderr || init.stdout}`);
      }
    }
    const remotes = runGit(dir, ["remote"], { check: false }).stdout.split(/\s+/).filter(Boolean);
    if (!remotes.includes("origin")) {
      runGit(dir, ["remote", "add", "origin", bare]);
    } else {
      runGit(dir, ["remote", "set-url", "origin", bare]);
    }
    runGit(dir, ["push", "-u", "origin", "HEAD"]);
    return { repo_url: localRepoUrl(slug, remotesDir), backend: "local" };
  }
  if (backend === "github") {
    const name = `${GITHUB_OWNER}/${githubRepoName(slug)}`;
    const result = spawn(
      "gh",
      ["repo", "create", name, "--private", "--source", dir, "--remote", "origin", "--push"],
      { encoding: "utf8" },
    );
    if (result.status !== 0) {
      throw new Error(`gh repo create failed: ${result.stderr || result.stdout}`);
    }
    return { repo_url: verifyGithubUrl(slug, spawn), backend: "github" };
  }
  throw new Error(`unknown TENWHY_REPO_BACKEND: ${backend}`);
}

export { slugify, walkFiles };
