import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { customerRepoDir } from "./repo.mjs";
import { buildComparison, latestPassedResearchRun } from "./snapshot.mjs";

const LOOPCTL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../bin/loopctl");

export function parseJsonBody(raw) {
  if (!raw || !String(raw).trim()) return {};
  return JSON.parse(raw);
}

export function spawnLoopctlNew({
  idea,
  site_url,
  customer_name,
  dbPath,
  repoRoot,
  timeoutMs = 60_000,
  env = process.env,
} = {}) {
  const args = [LOOPCTL, "new"];
  if (idea) args.push(String(idea));
  if (site_url) args.push("--url", String(site_url));
  if (customer_name) args.push("--name", String(customer_name));
  const childEnv = {
    ...env,
    TENWHY_DB: dbPath,
  };
  if (env.TENWHY_REPO_BACKEND) childEnv.TENWHY_REPO_BACKEND = env.TENWHY_REPO_BACKEND;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env: childEnv,
      timeout: timeoutMs,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c) => {
      stderr += c.toString("utf8");
    });
    child.on("error", (err) => {
      resolve({ ok: false, status: 502, error: err.message, stdout, stderr });
    });
    child.on("close", (code, signal) => {
      if (signal === "SIGTERM" || code === null) {
        resolve({ ok: false, status: 502, error: stderr.trim() || "loopctl new timed out", stdout, stderr });
        return;
      }
      if (code !== 0) {
        const summary = (stderr || stdout || `exit ${code}`).trim().split("\n").slice(-8).join("\n");
        resolve({ ok: false, status: 502, error: summary, stdout, stderr, code });
        return;
      }
      const id = stdout.trim().split("\n").filter(Boolean).at(-1);
      resolve({ ok: true, id, stdout, stderr });
    });
  });
}

export function websiteGatePassed(db, engagementId) {
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM loop_runs
         WHERE engagement_id = ? AND loop_name = 'website' AND status = 'gate_passed'
         LIMIT 1`,
      )
      .get(engagementId),
  );
}

export function engagementBundle(db, engagementId, repoRoot) {
  const eng = db.prepare("SELECT * FROM engagements WHERE id = ?").get(engagementId);
  if (!eng) return null;
  const loop_runs = db.prepare("SELECT * FROM loop_runs WHERE engagement_id = ? ORDER BY started_at, id").all(engagementId);
  const runIds = loop_runs.map((r) => r.id);
  let iterations = [];
  let gate_checks = [];
  if (runIds.length) {
    const ph = runIds.map(() => "?").join(",");
    iterations = db
      .prepare(`SELECT * FROM iterations WHERE loop_run_id IN (${ph}) ORDER BY created_at, n`)
      .all(...runIds);
    gate_checks = db
      .prepare(`SELECT * FROM gate_checks WHERE loop_run_id IN (${ph}) ORDER BY created_at, id`)
      .all(...runIds);
  }
  const events = db
    .prepare(
      `SELECT id, kind, loop_run_id, payload, created_at FROM events
       WHERE engagement_id = ? ORDER BY id`,
    )
    .all(engagementId)
    .map((e) => {
      let payload = {};
      try {
        payload = e.payload ? JSON.parse(e.payload) : {};
      } catch {
        payload = {};
      }
      return { id: e.id, kind: e.kind, loop_run_id: e.loop_run_id, payload, created_at: e.created_at };
    });
  const last = db.prepare("SELECT MAX(id) AS id FROM events WHERE engagement_id = ?").get(engagementId);
  return {
    engagement: eng,
    loop_runs,
    iterations,
    gate_checks,
    events,
    lastEventId: last?.id ?? 0,
    repo_dir: customerRepoDir(eng, repoRoot, db),
  };
}

export function researchPayload(db, engagementId, repoRoot) {
  const run = latestPassedResearchRun(db, engagementId);
  if (!run) return null;
  const eng = db.prepare("SELECT * FROM engagements WHERE id = ?").get(engagementId);
  const dir = customerRepoDir(eng, repoRoot, db);
  const researchPath = path.join(dir, "research/RESEARCH.json");
  let research;
  try {
    research = JSON.parse(fs.readFileSync(researchPath, "utf8"));
  } catch {
    return null;
  }
  return { research, comparison: buildComparison(db, run, repoRoot) };
}

export function previewDist(db, engagementId, repoRoot) {
  if (!websiteGatePassed(db, engagementId)) return null;
  const eng = db.prepare("SELECT * FROM engagements WHERE id = ?").get(engagementId);
  if (!eng) return null;
  const dir = customerRepoDir(eng, repoRoot, db);
  const dist = path.join(dir, "website/dist");
  if (!fs.existsSync(dist) || !fs.statSync(dist).isDirectory()) return null;
  return dist;
}

export function previewManifest(distDir) {
  const pages = [];
  function walk(dir, rel = "") {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, r);
      else if (e.isFile() && e.name.endsWith(".html")) {
        let title = path.basename(e.name, ".html");
        try {
          const html = fs.readFileSync(p, "utf8");
          const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
          if (m) title = m[1].trim() || title;
        } catch {
          /* */
        }
        pages.push({ path: "/" + r.replace(/\\/g, "/"), title });
      }
    }
  }
  walk(distDir);
  pages.sort((a, b) => a.path.localeCompare(b.path));
  return { pages };
}

export function ownOrigin(req) {
  const host = req.headers.host;
  if (!host) return null;
  const proto = req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
  return `${proto}://${host}`;
}

export function writeClientAllowed(req) {
  if (req.headers["x-tenwhy-client"] !== "customer-ui") return false;
  const origin = req.headers.origin;
  const expected = ownOrigin(req);
  return Boolean(origin && expected && origin === expected);
}

export function hasUnprocessedApproval(db, engagementId) {
  const row = db
    .prepare(
      `SELECT a.id FROM approvals a
       WHERE a.engagement_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM events e
           WHERE e.kind = 'approval.processed'
             AND json_extract(e.payload, '$.approvalId') = a.id
         )
       LIMIT 1`,
    )
    .get(engagementId);
  return Boolean(row);
}
