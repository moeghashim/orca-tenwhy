import { queueLoopRun } from "./orchestrator.mjs";
import { insertEvent, openDb, utcNow } from "./util.mjs";

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
