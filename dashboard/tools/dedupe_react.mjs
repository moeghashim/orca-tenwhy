#!/usr/bin/env node
// Remove nested React copies under the tengrids submodule so Node resolves
// the root react / react-dom. Idempotent. Never follows or deletes through
// symlinked path segments; never rm -rf a real path outside the allowed roots.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function parseRoot() {
  const args = process.argv.slice(2);
  let root = process.env.DEDUPE_ROOT;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--root" && args[i + 1]) {
      root = args[++i];
    }
  }
  if (root) return path.resolve(root);
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

const repo = parseRoot();
const tengrids = path.join(repo, "dashboard/vendor/tengrids");

function isReactCopy(name) {
  return (
    name === "react" ||
    name === "react-dom" ||
    name === "scheduler" ||
    name === "react-is" ||
    name === "react-refresh" ||
    name === "react-test-renderer" ||
    name.startsWith("react-dom.")
  );
}

function strictlyInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** True if any path segment from `from` down to (but not including) `to` is a symlink. */
function parentHasSymlink(from, to) {
  const rel = path.relative(from, to);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return true;
  const parts = rel.split(path.sep).filter(Boolean);
  let cur = from;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = path.join(cur, parts[i]);
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch {
      return true;
    }
    if (st.isSymbolicLink()) return true;
  }
  return false;
}

function allowedNodeModulesDirs() {
  const dirs = [path.join(tengrids, "node_modules")];
  const packages = path.join(tengrids, "packages");
  if (!fs.existsSync(packages)) return dirs;
  let entries;
  try {
    entries = fs.readdirSync(packages, { withFileTypes: true });
  } catch {
    return dirs;
  }
  for (const ent of entries) {
    if (ent.isDirectory() || ent.isSymbolicLink()) {
      dirs.push(path.join(packages, ent.name, "node_modules"));
    }
  }
  return dirs;
}

function realAllowedRoots() {
  const roots = [];
  for (const dir of allowedNodeModulesDirs()) {
    if (!fs.existsSync(dir)) continue;
    if (parentHasSymlink(repo, path.join(dir, "_"))) {
      console.warn(`dedupe_react: skip ${path.relative(repo, dir) || dir}: symlink segment`);
      continue;
    }
    try {
      roots.push(fs.realpathSync(dir));
    } catch {
      console.warn(`dedupe_react: skip ${path.relative(repo, dir) || dir}: cannot realpath`);
    }
  }
  return roots;
}

const removed = [];
const allowedReals = realAllowedRoots();

for (const dir of allowedNodeModulesDirs()) {
  if (!fs.existsSync(dir)) continue;
  if (parentHasSymlink(repo, path.join(dir, "_"))) continue;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    continue;
  }
  for (const ent of entries) {
    if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
    if (!isReactCopy(ent.name)) continue;
    const full = path.join(dir, ent.name);
    if (parentHasSymlink(repo, full)) {
      console.warn(`dedupe_react: skip ${path.relative(repo, full)}: symlink segment`);
      continue;
    }
    let st;
    try {
      st = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      fs.rmSync(full, { force: true });
      removed.push(path.relative(repo, full));
      continue;
    }
    let real;
    try {
      real = fs.realpathSync(full);
    } catch {
      console.warn(`dedupe_react: skip ${path.relative(repo, full)}: cannot realpath`);
      continue;
    }
    if (!allowedReals.some((root) => strictlyInside(real, root))) {
      console.warn(`dedupe_react: skip ${path.relative(repo, full)}: real path outside allowed roots`);
      continue;
    }
    fs.rmSync(full, { recursive: true, force: true });
    removed.push(path.relative(repo, full));
  }
}

if (removed.length === 0) {
  console.log("dedupe_react: nothing to do");
} else {
  console.log(`dedupe_react: removed ${removed.length}`);
  for (const p of removed) console.log(`  ${p}`);
}
