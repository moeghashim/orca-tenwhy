import path from "node:path";
import { spawnSync } from "node:child_process";
import { localRepoUrl, verifyGithubUrl } from "./customer_repo.mjs";
import { queueLoopRun } from "./orchestrator.mjs";
import { ROOT, insertEvent, openDb, prefixedId, utcNow } from "./util.mjs";

export function cmdStatus({ engagementId, dbPath }) {
  const db = openDb(dbPath);
  try {
    const rows = engagementId
      ? db.prepare("SELECT * FROM engagements WHERE id = ?").all(engagementId)
      : db.prepare("SELECT * FROM engagements ORDER BY created_at").all();
    for (const r of rows) {
      process.stdout.write(
        `${r.id}\t${r.status}\t${r.customer_name ?? ""}\t${r.idea ?? ""}\t${r.site_url ?? ""}\t${r.repo_url ?? ""}\n`,
      );
    }
    if (engagementId && rows.length === 0) {
      throw Object.assign(new Error(`engagement not found: ${engagementId}`), { exitCode: 1 });
    }
  } finally {
    db.close();
  }
}

export function cmdUpdate({ engagementId, dbPath }) {
  if (!engagementId) {
    throw Object.assign(new Error("update requires <engagement-id>"), { exitCode: 1 });
  }
  const db = openDb(dbPath);
  try {
    const eng = db.prepare("SELECT * FROM engagements WHERE id = ?").get(engagementId);
    if (!eng) throw Object.assign(new Error(`engagement not found: ${engagementId}`), { exitCode: 1 });
    const allowed = new Set(["complete", "awaiting_approval", "needs_human"]);
    if (!allowed.has(eng.status)) {
      throw Object.assign(new Error(`update not allowed while status is ${eng.status}`), {
        exitCode: 1,
      });
    }
    const runId = queueLoopRun(db, {
      engagementId: eng.id,
      loopName: "company-research",
      attempt: 0,
    });
    insertEvent(db, {
      engagementId: eng.id,
      loopRunId: runId,
      kind: "engagement.update_requested",
      payload: { runId },
    });
    db.prepare("UPDATE engagements SET updated_at = ? WHERE id = ?").run(utcNow(), eng.id);
    process.stdout.write(`${runId}\n`);
    return { runId };
  } finally {
    db.close();
  }
}

function insertApproval(db, { engagementId, action, notes }) {
  const id = prefixedId("apr");
  db.prepare(
    `INSERT INTO approvals (id, engagement_id, action, notes, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, engagementId, action, notes ?? null, utcNow());
  return id;
}

function requireAwaiting(eng, cmd) {
  if (!eng) throw Object.assign(new Error("engagement not found"), { exitCode: 1 });
  if (eng.status !== "awaiting_approval") {
    throw Object.assign(new Error(`${cmd} requires status awaiting_approval (have ${eng.status})`), {
      exitCode: 1,
    });
  }
}

export function cmdApprove({ engagementId, dbPath }) {
  if (!engagementId) throw Object.assign(new Error("approve requires <engagement-id>"), { exitCode: 1 });
  const db = openDb(dbPath);
  try {
    const eng = db.prepare("SELECT * FROM engagements WHERE id = ?").get(engagementId);
    requireAwaiting(eng, "approve");
    const id = insertApproval(db, { engagementId, action: "approve", notes: null });
    process.stdout.write(`${id}\n`);
    return { id };
  } finally {
    db.close();
  }
}

export function cmdRepairRepoUrl({
  engagementId,
  dbPath,
  repoRoot = ROOT,
  backend = process.env.TENWHY_REPO_BACKEND || "github",
  spawn = spawnSync,
}) {
  if (!engagementId) {
    throw Object.assign(new Error("repair-repo-url requires <engagement-id>"), { exitCode: 1 });
  }
  const db = openDb(dbPath);
  try {
    const eng = db.prepare("SELECT * FROM engagements WHERE id = ?").get(engagementId);
    if (!eng) throw Object.assign(new Error(`engagement not found: ${engagementId}`), { exitCode: 1 });
    const created = db
      .prepare(
        "SELECT payload FROM events WHERE engagement_id = ? AND kind = 'engagement.created' ORDER BY id LIMIT 1",
      )
      .get(engagementId);
    let slug = null;
    try {
      slug = created?.payload ? JSON.parse(created.payload).slug : null;
    } catch {
      slug = null;
    }
    if (!slug) {
      throw Object.assign(new Error("engagement has no slug in engagement.created"), { exitCode: 1 });
    }
    const remotesDir = path.join(repoRoot, "state/remotes");
    const url =
      backend === "local"
        ? localRepoUrl(slug, remotesDir)
        : verifyGithubUrl(slug, spawn);
    const previous = eng.repo_url;
    db.prepare("UPDATE engagements SET repo_url = ?, updated_at = ? WHERE id = ?").run(
      url,
      utcNow(),
      engagementId,
    );
    insertEvent(db, {
      engagementId,
      kind: "engagement.repo_url_repaired",
      payload: { previous, repo_url: url, slug },
    });
    process.stdout.write(`${url}\n`);
    return { repo_url: url, previous };
  } finally {
    db.close();
  }
}

export function cmdRequestChanges({ engagementId, notes, dbPath }) {
  if (!engagementId) {
    throw Object.assign(new Error("request-changes requires <engagement-id>"), { exitCode: 1 });
  }
  if (!notes) {
    throw Object.assign(new Error("request-changes requires --notes"), { exitCode: 1 });
  }
  const db = openDb(dbPath);
  try {
    const eng = db.prepare("SELECT * FROM engagements WHERE id = ?").get(engagementId);
    requireAwaiting(eng, "request-changes");
    const id = insertApproval(db, { engagementId, action: "request_changes", notes });
    process.stdout.write(`${id}\n`);
    return { id };
  } finally {
    db.close();
  }
}
