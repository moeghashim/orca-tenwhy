import fs from "node:fs";
import path from "node:path";
import { customerRepoDir, kbFiles } from "./repo.mjs";

const EXECUTOR_SUMMARY_MAX = 240;

const COMPARISON_COLUMNS = [
  { key: "customer_product", label: "customer product" },
  { key: "competitor", label: "competitor" },
  { key: "competitor_product", label: "competitor product" },
  { key: "price", label: "price" },
  { key: "source", label: "source" },
];

function parsePayload(raw) {
  if (raw == null || raw === "") return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function executorSummary(filePath) {
  if (!filePath) return "";
  try {
    const text = fs.readFileSync(filePath, "utf8");
    return text.length <= EXECUTOR_SUMMARY_MAX ? text : text.slice(0, EXECUTOR_SUMMARY_MAX);
  } catch {
    return "";
  }
}

function liveUrlFor(db, engagementId) {
  const row = db
    .prepare(
      `SELECT payload FROM events
       WHERE engagement_id = ? AND kind = 'engagement.complete'
       ORDER BY id DESC LIMIT 1`,
    )
    .get(engagementId);
  if (!row) return null;
  const p = parsePayload(row.payload);
  return p.live_url ?? p.liveUrl ?? null;
}

function lastEvent(db, engagementId, loopRunId = null) {
  const row = loopRunId
    ? db
        .prepare(
          `SELECT created_at, kind, payload FROM events
           WHERE loop_run_id = ? ORDER BY id DESC LIMIT 1`,
        )
        .get(loopRunId)
    : db
        .prepare(
          `SELECT created_at, kind, payload FROM events
           WHERE engagement_id = ? ORDER BY id DESC LIMIT 1`,
        )
        .get(engagementId);
  return row ?? null;
}

function urls200(db, loopRunId) {
  return new Set(
    db
      .prepare("SELECT url FROM scrapes WHERE loop_run_id = ? AND http_status = 200")
      .all(loopRunId)
      .map((r) => r.url),
  );
}

export function buildComparison(db, loopRun, repoRoot) {
  const eng = db.prepare("SELECT * FROM engagements WHERE id = ?").get(loopRun.engagement_id);
  const dir = customerRepoDir(eng, repoRoot, db);
  const researchPath = path.join(dir, "research/RESEARCH.json");
  let data;
  try {
    data = JSON.parse(fs.readFileSync(researchPath, "utf8"));
  } catch {
    return null;
  }
  const products = new Map(
    ((data.company || {}).customer_products || []).map((p) => [p.id, p.name || p.id]),
  );
  const ok = urls200(db, loopRun.id);
  const rows = (data.product_matches || []).map((m) => {
    const valid = isNumber(m.competitor_price) && Boolean(m.source_url) && ok.has(m.source_url);
    const state = valid ? "valid" : "flagged";
    return {
      cells: [
        { value: products.get(m.customer_product_id) || m.customer_product_id || "" },
        { value: m.competitor ?? "" },
        { value: m.competitor_product ?? "" },
        { value: m.competitor_price ?? null, state },
        { value: m.source_url ?? "", state, href: m.source_url || undefined },
      ],
    };
  });
  return { columns: COMPARISON_COLUMNS, rows };
}

export function latestPassedResearchRun(db, engagementId) {
  return (
    db
      .prepare(
        `SELECT * FROM loop_runs
         WHERE engagement_id = ? AND loop_name = 'company-research' AND status = 'gate_passed'
         ORDER BY finished_at DESC, rowid DESC LIMIT 1`,
      )
      .get(engagementId) ?? null
  );
}

function shapeEngagement(db, eng, repoRoot) {
  const dir = customerRepoDir(eng, repoRoot, db);
  const active = db
    .prepare(
      `SELECT loop_name FROM loop_runs
       WHERE engagement_id = ? AND status IN ('running','queued','needs_human')
       ORDER BY started_at DESC, rowid DESC LIMIT 1`,
    )
    .get(eng.id);
  const lastLoop = db
    .prepare(
      `SELECT loop_name FROM loop_runs WHERE engagement_id = ?
       ORDER BY started_at DESC, rowid DESC LIMIT 1`,
    )
    .get(eng.id);
  const ev = lastEvent(db, eng.id);
  const lastIter = db
    .prepare(
      `SELECT reviewer_notes FROM iterations
       WHERE loop_run_id IN (SELECT id FROM loop_runs WHERE engagement_id = ?)
       ORDER BY created_at DESC, n DESC LIMIT 1`,
    )
    .get(eng.id);
  return {
    id: eng.id,
    customer_name: eng.customer_name,
    idea: eng.idea,
    site_url: eng.site_url,
    repo_url: eng.repo_url,
    status: eng.status,
    created_at: eng.created_at,
    updated_at: eng.updated_at,
    live_url: liveUrlFor(db, eng.id),
    kb_files: kbFiles(dir),
    active_loop: active?.loop_name ?? lastLoop?.loop_name ?? null,
    last_event_at: ev?.created_at ?? eng.updated_at,
    last_note: lastIter?.reviewer_notes || ev?.kind || "",
  };
}

function shapeLoopRun(db, run) {
  const iters = db
    .prepare("SELECT n, reviewer_verdict, reviewer_notes FROM iterations WHERE loop_run_id = ? ORDER BY n")
    .all(run.id);
  const last = iters.at(-1);
  const ev = lastEvent(db, run.engagement_id, run.id);
  return {
    id: run.id,
    engagement_id: run.engagement_id,
    loop_name: run.loop_name,
    attempt: run.attempt,
    change_request_id: run.change_request_id,
    status: run.status,
    pi_trace_ref: run.pi_trace_ref,
    adjusted_instructions: run.adjusted_instructions,
    started_at: run.started_at,
    finished_at: run.finished_at,
    iteration_count: iters.length,
    last_verdict: last?.reviewer_verdict ?? null,
    last_note: last?.reviewer_notes ?? "",
    last_event_at: ev?.created_at ?? run.started_at,
  };
}

function shapeIteration(row) {
  return {
    id: row.id,
    loop_run_id: row.loop_run_id,
    n: row.n,
    executor_output_path: row.executor_output_path,
    executor_summary: executorSummary(row.executor_output_path),
    reviewer_verdict: row.reviewer_verdict,
    reviewer_notes: row.reviewer_notes,
    pi_trace_ref: row.pi_trace_ref,
    created_at: row.created_at,
  };
}

function shapeGate(row) {
  return {
    id: row.id,
    loop_run_id: row.loop_run_id,
    check_name: row.check_name,
    passed: row.passed,
    detail: row.detail,
    created_at: row.created_at,
  };
}

function shapeScrape(row) {
  return {
    id: row.id,
    loop_run_id: row.loop_run_id,
    url: row.url,
    http_status: row.http_status,
    created_at: row.created_at,
  };
}

function shapeApproval(row) {
  return {
    id: row.id,
    engagement_id: row.engagement_id,
    action: row.action,
    notes: row.notes,
    created_at: row.created_at,
  };
}

export function buildComparisons(db, repoRoot) {
  const out = {};
  const engs = db.prepare("SELECT id FROM engagements").all();
  for (const eng of engs) {
    const run = latestPassedResearchRun(db, eng.id);
    if (!run) continue;
    const cmp = buildComparison(db, run, repoRoot);
    if (cmp) out[run.id] = cmp;
  }
  return out;
}

export function buildSnapshot(db, { repoRoot, now } = {}) {
  const serverTime = now || new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const last = db.prepare("SELECT MAX(id) AS id FROM events").get();
  return {
    serverTime,
    snapshotAt: serverTime,
    lastEventId: last?.id ?? 0,
    engagements: db.prepare("SELECT * FROM engagements ORDER BY created_at, id").all().map((e) => shapeEngagement(db, e, repoRoot)),
    loop_runs: db.prepare("SELECT * FROM loop_runs ORDER BY started_at, id").all().map((r) => shapeLoopRun(db, r)),
    iterations: db.prepare("SELECT * FROM iterations ORDER BY created_at, n").all().map(shapeIteration),
    gate_checks: db.prepare("SELECT * FROM gate_checks ORDER BY created_at, id").all().map(shapeGate),
    scrapes: db.prepare("SELECT id, loop_run_id, url, http_status, created_at FROM scrapes ORDER BY created_at, id").all().map(shapeScrape),
    approvals: db.prepare("SELECT * FROM approvals ORDER BY created_at, id").all().map(shapeApproval),
    comparisons: buildComparisons(db, repoRoot),
  };
}

function comparisonForRun(db, run, repoRoot) {
  if (!run || run.loop_name !== "company-research") return {};
  const latest = latestPassedResearchRun(db, run.engagement_id);
  if (!latest || latest.id !== run.id) return {};
  const cmp = buildComparison(db, run, repoRoot);
  return cmp ? { [run.id]: cmp } : {};
}

export function entitiesForEvent(db, event, repoRoot) {
  const entities = {
    engagements: [],
    loop_runs: [],
    iterations: [],
    gate_checks: [],
    scrapes: [],
    comparisons: {},
  };
  if (event.engagement_id) {
    const eng = db.prepare("SELECT * FROM engagements WHERE id = ?").get(event.engagement_id);
    if (eng) entities.engagements.push(shapeEngagement(db, eng, repoRoot));
  }
  if (event.loop_run_id) {
    const run = db.prepare("SELECT * FROM loop_runs WHERE id = ?").get(event.loop_run_id);
    if (run) {
      entities.loop_runs.push(shapeLoopRun(db, run));
      entities.iterations = db
        .prepare("SELECT * FROM iterations WHERE loop_run_id = ? ORDER BY n")
        .all(run.id)
        .map(shapeIteration);
      entities.gate_checks = db
        .prepare("SELECT * FROM gate_checks WHERE loop_run_id = ? ORDER BY created_at, id")
        .all(run.id)
        .map(shapeGate);
      entities.scrapes = db
        .prepare("SELECT id, loop_run_id, url, http_status, created_at FROM scrapes WHERE loop_run_id = ? ORDER BY created_at, id")
        .all(run.id)
        .map(shapeScrape);
      Object.assign(entities.comparisons, comparisonForRun(db, run, repoRoot));
    }
  }
  return entities;
}

export function formatSsePatch(eventRow, entities) {
  const payload = parsePayload(eventRow.payload);
  return {
    id: eventRow.id,
    kind: eventRow.kind,
    engagement_id: eventRow.engagement_id,
    loop_run_id: eventRow.loop_run_id,
    payload,
    created_at: eventRow.created_at,
    entities,
  };
}
