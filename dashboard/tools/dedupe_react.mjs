#!/usr/bin/env node
// Remove nested React copies under the tengrids submodule so Node resolves
// the root react / react-dom. Idempotent. Never touches paths outside
// dashboard/vendor/tengrids/{node_modules,packages/*/node_modules}.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tengrids = path.join(repo, "dashboard/vendor/tengrids");
const allowedPrefix = tengrids + path.sep;

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

function nodeModulesDirs() {
  const dirs = [path.join(tengrids, "node_modules")];
  const packages = path.join(tengrids, "packages");
  if (!fs.existsSync(packages)) return dirs;
  for (const ent of fs.readdirSync(packages, { withFileTypes: true })) {
    if (ent.isDirectory()) dirs.push(path.join(packages, ent.name, "node_modules"));
  }
  return dirs;
}

function confined(p) {
  const resolved = path.resolve(p);
  return resolved.startsWith(allowedPrefix);
}

const removed = [];
for (const dir of nodeModulesDirs()) {
  if (!fs.existsSync(dir) || !confined(dir)) continue;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    continue;
  }
  for (const ent of entries) {
    if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
    if (!isReactCopy(ent.name)) continue;
    const full = path.resolve(dir, ent.name);
    if (!confined(full)) continue;
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
