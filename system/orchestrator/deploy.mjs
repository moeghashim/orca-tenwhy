import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ROOT, insertEvent } from "./util.mjs";

const PROVISION = path.join(ROOT, "system/tools/provision.sh");
const DEPLOY = path.join(ROOT, "system/tools/deploy.sh");

export class DeployRefused extends Error {
  constructor(reason, body) {
    super(reason || "deploy refused");
    this.name = "DeployRefused";
    this.reason = reason;
    this.body = body;
  }
}

function readProvisionRecord(engagementId, repoRoot = ROOT) {
  const p = path.join(repoRoot, "state/provision", `${engagementId}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function parseEnvFile(filePath, allowedNames) {
  const out = {};
  if (!filePath || !fs.existsSync(filePath)) return out;
  const allow = allowedNames ? new Set(allowedNames) : null;
  const text = fs.readFileSync(filePath, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq);
    if (allow && !allow.has(key)) continue;
    let val = line.slice(eq + 1);
    if (
      (val.startsWith("\"") && val.endsWith("\"")) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function childEnv(record) {
  const names = record?.env_var_names || [];
  const loaded = parseEnvFile(record?.env_file, names);
  const env = { ...process.env, ...loaded };
  if (loaded.SITE_API_TOKEN && !env.CLOUDFLARE_API_TOKEN) {
    env.CLOUDFLARE_API_TOKEN = loaded.SITE_API_TOKEN;
  }
  if (loaded.SITE_ACCOUNT_ID && !env.CLOUDFLARE_ACCOUNT_ID) {
    env.CLOUDFLARE_ACCOUNT_ID = loaded.SITE_ACCOUNT_ID;
  }
  if (record?.slug) env.TENWHY_SLUG = record.slug;
  return env;
}

function lastJson(stdout) {
  const lines = String(stdout || "")
    .trim()
    .split("\n")
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      /* keep looking */
    }
  }
  return null;
}

export function runProvision({ engagementId, slug, repoRoot = ROOT, env = process.env }) {
  const result = spawnSync("bash", [PROVISION, engagementId, slug], {
    encoding: "utf8",
    cwd: repoRoot,
    env,
  });
  if (result.status !== 0) {
    throw new Error(`provision.sh failed (exit ${result.status}): ${(result.stderr || result.stdout || "").trim()}`);
  }
  return readProvisionRecord(engagementId, repoRoot);
}

export async function deploy({
  engagementId,
  approvalId = null,
  repoDir = null,
  db = null,
  dbPath = process.env.TENWHY_DB || path.join(ROOT, "state/orchestrator.db"),
  repoRoot = ROOT,
  provision = true,
  slug = null,
} = {}) {
  if (!engagementId) throw new Error("deploy requires engagementId");
  let record = readProvisionRecord(engagementId, repoRoot);
  if (!slug && db) {
    const row = db
      .prepare(
        "SELECT json_extract(payload, '$.slug') AS slug FROM events WHERE engagement_id = ? AND kind = 'engagement.created' ORDER BY id LIMIT 1",
      )
      .get(engagementId);
    if (row?.slug) slug = row.slug;
  }
  if (provision && !record) {
    if (!slug) throw new Error("provision requires slug");
    record = runProvision({ engagementId, slug, repoRoot });
  }
  const env = childEnv(record || {});
  env.TENWHY_DB = dbPath;
  if (repoDir) env.TENWHY_REPO_DIR = repoDir;
  if (record?.slug) env.TENWHY_SLUG = record.slug;
  else if (slug) env.TENWHY_SLUG = slug;

  const result = spawnSync("bash", [DEPLOY, engagementId, approvalId || ""], {
    encoding: "utf8",
    cwd: repoRoot,
    env,
  });
  const parsed = lastJson(result.stdout);
  if (result.status === 5 || parsed?.refused) {
    const reason = parsed?.reason || (result.stdout || result.stderr || "refused").trim();
    if (db) {
      insertEvent(db, {
        engagementId,
        kind: "deploy.refused",
        payload: { approvalId, refused: true, reason },
      });
    }
    throw new DeployRefused(reason, parsed);
  }
  if (result.status !== 0) {
    throw new Error(`deploy.sh failed (exit ${result.status}): ${(result.stderr || result.stdout || "").trim()}`);
  }
  const liveUrl = parsed?.live_url || parsed?.liveUrl || null;
  if (!liveUrl) {
    throw new Error("deploy.sh did not print live_url");
  }
  return { liveUrl };
}
