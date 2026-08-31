import fs from "node:fs";
import path from "node:path";
import { generateCustomerRepo, slugify } from "./customer_repo.mjs";
import { deploy as defaultDeploy } from "./deploy.mjs";
import { handleGateFailed as defaultHandleGateFailed } from "./failure.mjs";
import { acquireDaemonLock, releaseDaemonLock } from "./daemon_lock.mjs";
import { error as logError, info } from "./log.mjs";
import {
  ROOT,
  insertEvent,
  loadLoopsConfig,
  openDb,
  prefixedId,
  utcNow,
} from "./util.mjs";

export function loopNames(config) {
  return Object.keys(config.loops || {});
}

export function incomingEdges(config, name) {
  return (config.edges || []).filter((e) => e.to === name);
}

export function outgoingEdges(config, name) {
  return (config.edges || []).filter((e) => e.from === name);
}

export function customerRepoDir(eng, repoRoot = ROOT, db = null) {
  const base = path.join(repoRoot, "state/customers");
  let slug = null;
  if (db && eng?.id) {
    const row = db
      .prepare(
        `SELECT json_extract(payload, '$.slug') AS slug
         FROM events WHERE engagement_id = ? AND kind = 'engagement.created'
         ORDER BY id LIMIT 1`,
      )
      .get(eng.id);
    if (row?.slug) slug = row.slug;
  }
  if (slug) return path.join(base, slug);
  const exact = path.join(base, slugify(eng.customer_name));
  if (fs.existsSync(exact)) return exact;
  return exact;
}

function hasStatus(db, engagementId, loopName, statuses) {
  const placeholders = statuses.map(() => "?").join(",");
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM loop_runs WHERE engagement_id = ? AND loop_name = ? AND status IN (${placeholders}) LIMIT 1`,
      )
      .get(engagementId, loopName, ...statuses),
  );
}

export function computeHandoff(repoDir, eng) {
  const researchJsonPath = path.join(repoDir, "research/RESEARCH.json");
  const sourcesPath = path.join(repoDir, "research/SOURCES.md");
  let companyName = eng.customer_name;
  let productCount = 0;
  let competitorCount = 0;
  if (fs.existsSync(researchJsonPath)) {
    const json = JSON.parse(fs.readFileSync(researchJsonPath, "utf8"));
    companyName = json.company?.name || companyName;
    productCount = Array.isArray(json.company?.customer_products)
      ? json.company.customer_products.length
      : 0;
    competitorCount = Array.isArray(json.competitors) ? json.competitors.length : 0;
  }
  return { researchJsonPath, sourcesPath, companyName, productCount, competitorCount };
}

export function queueLoopRun(
  db,
  {
    engagementId,
    loopName,
    attempt = 0,
    changeRequestId = null,
    adjustedInstructions = null,
  },
) {
  const id = prefixedId("run");
  db.prepare(
    `INSERT INTO loop_runs (
      id, engagement_id, loop_name, attempt, change_request_id, status,
      pi_trace_ref, adjusted_instructions, started_at, finished_at
    ) VALUES (?, ?, ?, ?, ?, 'queued', NULL, ?, NULL, NULL)`,
  ).run(id, engagementId, loopName, attempt, changeRequestId, adjustedInstructions);
  return id;
}

export function queueReadyLoops(db, config, eng) {
  const queued = [];
  for (const name of loopNames(config)) {
    const unmet = incomingEdges(config, name).some(
      (e) => !hasStatus(db, eng.id, e.from, ["gate_passed"]),
    );
    if (unmet) continue;
    if (hasStatus(db, eng.id, name, ["queued", "running", "gate_passed"])) continue;
    queued.push(queueLoopRun(db, { engagementId: eng.id, loopName: name, attempt: 0 }));
  }
  return queued;
}

function setEngagementStatus(db, id, status) {
  db.prepare("UPDATE engagements SET status = ?, updated_at = ? WHERE id = ?").run(
    status,
    utcNow(),
    id,
  );
}

async function handleRunResult(
  db,
  config,
  eng,
  run,
  result,
  { absorbResearch, repoRoot, handleGateFailed, model },
) {
  if (result.status === "needs_human") {
    setEngagementStatus(db, eng.id, "needs_human");
    insertEvent(db, {
      engagementId: eng.id,
      loopRunId: run.id,
      kind: "engagement.needs_human",
      payload: { loop: run.loop_name, lastRunId: run.id },
    });
    return;
  }
  if (result.status === "gate_failed") {
    if (typeof handleGateFailed === "function") {
      await handleGateFailed({ db, config, eng, run, result, model });
    }
    return;
  }
  if (result.status !== "gate_passed") return;

  const repoDir = customerRepoDir(eng, repoRoot, db);
  const outputs = config.loops?.[run.loop_name]?.outputs || [];
  const isResearch = outputs.some((o) => String(o).includes("RESEARCH.json"));
  if (isResearch && typeof absorbResearch === "function") {
    const researchJsonPath = path.join(repoDir, "research/RESEARCH.json");
    const researchJson = fs.existsSync(researchJsonPath)
      ? JSON.parse(fs.readFileSync(researchJsonPath, "utf8"))
      : {};
    info("absorb", "start", { run: run.id });
    await absorbResearch({
      repoDir,
      researchJson,
      traceRef: result.iterations?.at?.(-1)?.executorTrace || `run://${run.id}`,
      now: utcNow(),
      loopRunId: run.id,
    });
    info("absorb", "end", { run: run.id });
  }

  const outgoing = outgoingEdges(config, run.loop_name);
  if (outgoing.length === 0) {
    setEngagementStatus(db, eng.id, "awaiting_approval");
    insertEvent(db, {
      engagementId: eng.id,
      loopRunId: run.id,
      kind: "engagement.awaiting_approval",
      payload: { loop: run.loop_name },
    });
    return;
  }

  const alreadyHasDownstream = outgoing.some((e) =>
    hasStatus(db, eng.id, e.to, ["queued", "running", "gate_passed", "gate_failed", "needs_human"]),
  );
  if (alreadyHasDownstream) {
    insertEvent(db, {
      engagementId: eng.id,
      loopRunId: run.id,
      kind: "update.absorbed",
      payload: { loop: run.loop_name },
    });
    return;
  }

  const handoff = computeHandoff(repoDir, eng);
  for (const edge of outgoing) {
    const unmet = incomingEdges(config, edge.to).some(
      (e) => e.from !== run.loop_name && !hasStatus(db, eng.id, e.from, ["gate_passed"]),
    );
    if (unmet) continue;
    const nextId = queueLoopRun(db, { engagementId: eng.id, loopName: edge.to, attempt: 0 });
    insertEvent(db, {
      engagementId: eng.id,
      loopRunId: nextId,
      kind: "handoff",
      payload: { from: run.loop_name, to: edge.to, ...handoff },
    });
  }
}

export async function processApprovals({ db, deploy = defaultDeploy, repoRoot = ROOT, dbPath = null }) {
  const pending = db
    .prepare(
      `SELECT a.* FROM approvals a
       WHERE NOT EXISTS (
         SELECT 1 FROM events e
         WHERE e.kind = 'approval.processed'
           AND json_extract(e.payload, '$.approvalId') = a.id
       )
       ORDER BY a.id`,
    )
    .all();
  for (const approval of pending) {
    const eng = db.prepare("SELECT * FROM engagements WHERE id = ?").get(approval.engagement_id);
    if (!eng) continue;
    if (eng.status !== "awaiting_approval") {
      insertEvent(db, {
        engagementId: eng.id,
        kind: "approval.rejected_state",
        payload: { approvalId: approval.id, action: approval.action, status: eng.status },
      });
      insertEvent(db, {
        engagementId: eng.id,
        kind: "approval.processed",
        payload: { approvalId: approval.id, action: approval.action },
      });
      continue;
    }
    if (approval.action === "approve") {
      info("approvals", "processed", { approval: approval.id, action: approval.action, engagement: eng.id });
      insertEvent(db, {
        engagementId: eng.id,
        kind: "approval.processed",
        payload: { approvalId: approval.id, action: approval.action },
      });
      try {
        info("deploy", "start", { engagement: eng.id, approval: approval.id });
        const result = await deploy({
          engagementId: eng.id,
          approvalId: approval.id,
          repoDir: customerRepoDir(eng, repoRoot, db),
          db,
          dbPath: dbPath || process.env.TENWHY_DB || path.join(repoRoot, "state/orchestrator.db"),
          repoRoot,
        });
        const liveUrl = result?.liveUrl ?? result?.url ?? null;
        db.prepare("UPDATE engagements SET status = ?, updated_at = ? WHERE id = ?").run(
          "complete",
          utcNow(),
          eng.id,
        );
        insertEvent(db, {
          engagementId: eng.id,
          kind: "engagement.complete",
          payload: { liveUrl },
        });
        info("deploy", "end", { engagement: eng.id, status: "ok" });
      } catch (err) {
        logError("deploy", "end", { engagement: eng.id, status: "failed", err: String(err?.message || err).slice(0, 200) });
        db.prepare("UPDATE engagements SET status = ?, updated_at = ? WHERE id = ?").run(
          "needs_human",
          utcNow(),
          eng.id,
        );
        insertEvent(db, {
          engagementId: eng.id,
          kind: "engagement.needs_human",
          payload: { reason: "deploy_failed", approvalId: approval.id },
        });
      }
      continue;
    } else if (approval.action === "request_changes") {
      info("approvals", "processed", { approval: approval.id, action: approval.action, engagement: eng.id });
      const notes = approval.notes || "";
      const runId = queueLoopRun(db, {
        engagementId: eng.id,
        loopName: "website",
        attempt: 0,
        changeRequestId: approval.id,
        adjustedInstructions: `Customer change request:\n${notes}`,
      });
      db.prepare("UPDATE engagements SET status = ?, updated_at = ? WHERE id = ?").run(
        "running",
        utcNow(),
        eng.id,
      );
      insertEvent(db, {
        engagementId: eng.id,
        loopRunId: runId,
        kind: "engagement.change_requested",
        payload: { approvalId: approval.id, runId },
      });
    }
    insertEvent(db, {
      engagementId: eng.id,
      kind: "approval.processed",
      payload: { approvalId: approval.id, action: approval.action },
    });
  }
}

export async function tick({
  db,
  config,
  adapters = {},
  runLoop,
  deploy = defaultDeploy,
  absorbResearch,
  handleGateFailed = defaultHandleGateFailed,
  processApprovals: processApprovalsFn = processApprovals,
  repoRoot = ROOT,
  dbPath = null,
}) {
  db.exec("PRAGMA foreign_keys = ON");
  const news = db.prepare("SELECT * FROM engagements WHERE status = 'new'").all();
  const queuedAtStart = db.prepare("SELECT COUNT(*) AS n FROM loop_runs WHERE status = 'queued'").get().n;
  info("tick", "start", { new: news.length, queued: queuedAtStart });
  let loopsStarted = 0;
  let loopsFinished = 0;
  for (const eng of news) {
    setEngagementStatus(db, eng.id, "running");
    insertEvent(db, {
      engagementId: eng.id,
      kind: "engagement.started",
      payload: {},
    });
    queueReadyLoops(db, config, eng);
  }

  while (true) {
    const queued = db.prepare("SELECT * FROM loop_runs WHERE status = 'queued'").all();
    if (queued.length === 0) break;
    await Promise.all(
      queued.map(async (run) => {
        const eng = db.prepare("SELECT * FROM engagements WHERE id = ?").get(run.engagement_id);
        const workdir = customerRepoDir(eng, repoRoot, db);
        loopsStarted += 1;
        info("loop", "start", { run: run.id, loop: run.loop_name, attempt: run.attempt, engagement: eng.id });
        const result = await runLoop({
          db,
          loopRunId: run.id,
          loopName: run.loop_name,
          engagementId: run.engagement_id,
          attempt: run.attempt,
          changeRequestId: run.change_request_id,
          adjustedInstructions: run.adjusted_instructions,
          workdir,
          config,
          adapter: adapters.loop,
          gateRunner: adapters.gateRunner,
          dbPath,
          inputs:
            run.loop_name === "company-research"
              ? { idea: eng.idea, site_url: eng.site_url }
              : computeHandoff(workdir, eng),
        });
        loopsFinished += 1;
        info("loop", "end", { run: run.id, loop: run.loop_name, status: result?.status });
        await handleRunResult(db, config, eng, run, result, {
          absorbResearch,
          repoRoot,
          handleGateFailed,
          model: adapters.orchestrator,
        });
      }),
    );
  }

  if (typeof processApprovalsFn === "function") {
    await processApprovalsFn({ db, deploy, repoRoot, config, dbPath });
  }
  info("tick", "end", { started: loopsStarted, finished: loopsFinished });
}

export async function runDaemon({
  intervalMs = 2000,
  dbPath = process.env.TENWHY_DB || path.join(ROOT, "state/orchestrator.db"),
  tickOpts = null,
  lockPath = path.join(ROOT, "state/daemon.lock"),
} = {}) {
  const got = acquireDaemonLock(lockPath);
  if (!got.ok) {
    const err = new Error(`daemon already running (pid ${got.pid})`);
    err.exitCode = 3;
    throw err;
  }
  try {
  const opts =
    tickOpts && typeof tickOpts.runLoop === "function"
      ? tickOpts
      : (await import("./wiring.mjs")).buildTickOpts({ repoRoot: ROOT, dbPath });
  const resolved = opts instanceof Promise ? await opts : opts;
  const config = resolved.config || (await loadLoopsConfig());
  let stopped = false;
  let wakeSleep = null;
  const stop = () => {
    stopped = true;
    if (wakeSleep) {
      const wake = wakeSleep;
      wakeSleep = null;
      wake();
    }
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    while (!stopped) {
      const db = openDb(dbPath);
      try {
        await tick({ db, dbPath, config, ...resolved });
      } finally {
        db.close();
      }
      if (stopped) break;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, intervalMs);
        wakeSleep = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wakeSleep = null;
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
  } finally {
    releaseDaemonLock(lockPath);
  }
}

export { generateCustomerRepo };
