import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function utcNow(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function isIsoTimestamp(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return false;
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value);
}

export function slugify(name) {
  const slug = String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "customer";
}

export function prefixedId(prefix) {
  return `${prefix}_${randomBytes(4).toString("hex")}`;
}

export function runGit(cwd, args, { check = true } = {}) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (check && result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (cwd=${cwd}): ${result.stderr || result.stdout}`);
  }
  return result;
}

export function insertEvent(db, { engagementId = null, loopRunId = null, kind, payload = {} }) {
  db.prepare(
    "INSERT INTO events (engagement_id, loop_run_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(engagementId, loopRunId, kind, JSON.stringify(payload), utcNow());
}

export function migrateDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const result = spawnSync("bash", [path.join(ROOT, "system/db/migrate.sh"), dbPath], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`migrate.sh failed: ${result.stderr || result.stdout}`);
  }
}

export function openDb(dbPath) {
  migrateDb(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

export async function loadLoopsConfig() {
  const { default: yaml } = await import("yaml");
  const text = fs.readFileSync(path.join(ROOT, "system/config/loops.yaml"), "utf8");
  return yaml.parse(text);
}
