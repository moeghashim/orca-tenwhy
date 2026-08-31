import { insertEvent, prefixedId, utcNow } from "./util.mjs";

function queueRetry(db, { engagementId, loopName, attempt, changeRequestId, adjustedInstructions }) {
  const id = prefixedId("run");
  db.prepare(
    `INSERT INTO loop_runs (
      id, engagement_id, loop_name, attempt, change_request_id, status,
      pi_trace_ref, adjusted_instructions, started_at, finished_at
    ) VALUES (?, ?, ?, ?, ?, 'queued', NULL, ?, NULL, NULL)`,
  ).run(id, engagementId, loopName, attempt, changeRequestId, adjustedInstructions);
  return id;
}

const RESEARCH_CHECK_NAMES = [
  "schema_valid",
  "competitors≥5",
  "product_coverage≥25%",
  "enhancement_ideas≥3",
  "sources_complete",
];

export function failedChecksFromReviewerNotes(notes) {
  const failed = [];
  for (const line of String(notes ?? "").split(/\r?\n/)) {
    const t = line.trim();
    const m = t.match(/^(\d+)\.(?!\d)\s*(.*)$/);
    if (!m) continue;
    const rest = m[2] || "";
    if (!/(?:^|[^A-Za-z])(?:fail|fails|failed)(?:[^A-Za-z]|$)|[✕]/.test(rest)) continue;
    const n = Number(m[1]);
    failed.push({
      check_name: RESEARCH_CHECK_NAMES[n - 1] || `check ${n}`,
      detail: t,
    });
  }
  return failed;
}

export function ensureAdjustedInstructions(text, failedChecks, reviewerNotes) {
  let out = String(text ?? "").trim();
  const notes = String(reviewerNotes ?? "");
  const missingCheck = (failedChecks || []).some((c) => !out.includes(c.check_name));
  const missingNotes = notes.length > 0 && !out.includes(notes);
  if (!out || missingCheck || missingNotes) {
    const lines = ["Failed checks:"];
    for (const c of failedChecks || []) {
      lines.push(`- ${c.check_name}: ${c.detail ?? ""}`);
    }
    lines.push("", "Reviewer notes:", notes);
    out = `${out}${out ? "\n\n" : ""}${lines.join("\n")}`;
  }
  return out;
}

export async function handleGateFailed({ db, config, eng, run, model }) {
  const retryCap = config?.caps?.retry_cap ?? 2;
  let failedChecks = db
    .prepare("SELECT check_name, detail, passed FROM gate_checks WHERE loop_run_id = ?")
    .all(run.id)
    .filter((c) => !c.passed);
  const lastIter = db
    .prepare(
      "SELECT reviewer_notes FROM iterations WHERE loop_run_id = ? ORDER BY n DESC LIMIT 1",
    )
    .get(run.id);
  const reviewerNotes = lastIter?.reviewer_notes ?? "";
  if (!failedChecks.length) {
    failedChecks = failedChecksFromReviewerNotes(reviewerNotes);
  }

  if (run.attempt < retryCap) {
    const nextAttempt = run.attempt + 1;
    const checkNames = failedChecks.map((c) => c.check_name).join(", ");
    const previous = run.adjusted_instructions || "";
    const prefix = `Attempt ${nextAttempt}/${retryCap} — previous adjusted instructions did not resolve: ${checkNames}`;
    let raw = "";
    if (model && typeof model.composeAdjustedInstructions === "function") {
      raw = await model.composeAdjustedInstructions({
        loopName: run.loop_name,
        failedChecks,
        reviewerNotes,
        attempt: nextAttempt,
        previousInstructions: previous,
      });
    }
    const guaranteed = ensureAdjustedInstructions(raw, failedChecks, reviewerNotes);
    const adjusted = [prefix, previous ? `Previous:\n${previous}` : "", guaranteed]
      .filter(Boolean)
      .join("\n\n");
    const nextId = queueRetry(db, {
      engagementId: eng.id,
      loopName: run.loop_name,
      attempt: run.attempt + 1,
      changeRequestId: run.change_request_id ?? null,
      adjustedInstructions: adjusted,
    });
    insertEvent(db, {
      engagementId: eng.id,
      loopRunId: nextId,
      kind: "loop_run.retry",
      payload: {
        previousRunId: run.id,
        attempt: run.attempt + 1,
        loop: run.loop_name,
      },
    });
    return { action: "retry", nextId, adjusted };
  }

  db.prepare("UPDATE engagements SET status = ?, updated_at = ? WHERE id = ?").run(
    "needs_human",
    utcNow(),
    eng.id,
  );
  insertEvent(db, {
    engagementId: eng.id,
    loopRunId: run.id,
    kind: "engagement.needs_human",
    payload: {
      loop: run.loop_name,
      lastRunId: run.id,
      failedChecks: failedChecks.map((c) => c.check_name),
    },
  });
  return { action: "needs_human" };
}
