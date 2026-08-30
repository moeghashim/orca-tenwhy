import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createPiAdapter } from "./adapters/pi.mjs";

const VALID_VERDICTS = new Set(["revise", "approve", "reject", "escalate"]);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function utcNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function lastJsonObject(text) {
  const src = String(text ?? "");
  const found = [];
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== "{") continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < src.length; j++) {
      const c = src[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === "\"") inStr = false;
        continue;
      }
      if (c === "\"") inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          try {
            found.push(JSON.parse(src.slice(i, j + 1)));
          } catch {
            /* not JSON */
          }
          i = j;
          break;
        }
      }
    }
  }
  return found.length ? found[found.length - 1] : null;
}

export function parseReviewerVerdict(text) {
  const obj = lastJsonObject(text);
  const verdict = obj && typeof obj === "object" ? obj.verdict : undefined;
  const notes = obj && typeof obj === "object" ? obj.notes : undefined;
  if (typeof verdict === "string" && VALID_VERDICTS.has(verdict) && typeof notes === "string") {
    return { verdict, notes };
  }
  return {
    verdict: "revise",
    notes: `FORMAT: reviewer output did not contain {verdict, notes} with a valid verdict; original: ${String(text ?? "").slice(0, 500)}`,
  };
}

function loadPrompt(loopName, role) {
  const p = path.join(ROOT, "system/loops", loopName, "prompts", `${role}.md`);
  if (fs.existsSync(p)) return fs.readFileSync(p, "utf8");
  return null;
}

function buildExecutorPrompt({ loopName, n, adjustedInstructions, previousNotes, workdir }) {
  const base =
    loadPrompt(loopName, "executor") ??
    `You are the executor for the ${loopName} loop. Write outputs under ${workdir}.`;
  const parts = [base];
  if (adjustedInstructions) {
    parts.push("", "Adjusted instructions:", adjustedInstructions);
  }
  if (n > 1 && previousNotes) {
    parts.push("", "Previous reviewer notes:", previousNotes);
  }
  parts.push("", `Iteration ${n}.`);
  return parts.join("\n");
}

function buildReviewerPrompt({ loopName, n, executorOutputPath, workdir }) {
  const base =
    loadPrompt(loopName, "reviewer") ??
    `You are the reviewer for the ${loopName} loop. Reply with a JSON object {"verdict":"revise|approve|reject|escalate","notes":"..."}.`;
  return [
    base,
    "",
    `Iteration ${n}.`,
    `Executor output: ${executorOutputPath}`,
    `Workdir: ${workdir}`,
  ].join("\n");
}

function insertEvent(db, { engagementId, loopRunId, kind, payload }) {
  db.prepare(
    "INSERT INTO events (engagement_id, loop_run_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(engagementId, loopRunId, kind, JSON.stringify(payload ?? {}), utcNow());
}

function finishRun(db, { loopRunId, status, traceRef }) {
  db.prepare(
    "UPDATE loop_runs SET status = ?, finished_at = ?, pi_trace_ref = ? WHERE id = ?",
  ).run(status, utcNow(), traceRef ?? null, loopRunId);
}

export async function runLoop({
  db,
  dbPath = null,
  loopName,
  engagementId,
  attempt = 0,
  changeRequestId = null,
  adjustedInstructions = null,
  workdir,
  config,
  adapter,
  gateRunner,
}) {
  db.exec("PRAGMA foreign_keys = ON");
  const cap = config?.caps?.iteration_cap ?? 4;
  const loopRunId = randomUUID();
  const startedAt = utcNow();
  db.prepare(
    `INSERT INTO loop_runs (
      id, engagement_id, loop_name, attempt, change_request_id, status,
      pi_trace_ref, adjusted_instructions, started_at, finished_at
    ) VALUES (?, ?, ?, ?, ?, 'running', NULL, ?, ?, NULL)`,
  ).run(
    loopRunId,
    engagementId,
    loopName,
    attempt,
    changeRequestId,
    adjustedInstructions,
    startedAt,
  );
  insertEvent(db, {
    engagementId,
    loopRunId,
    kind: "loop_run.started",
    payload: { loopName, attempt },
  });

  const iterations = [];
  let lastExecutorTrace = null;
  let previousNotes = null;
  let terminal = null;

  for (let n = 1; n <= cap; n++) {
    const execSessionId = randomUUID();
    const execPrompt = buildExecutorPrompt({
      loopName,
      n,
      adjustedInstructions,
      previousNotes,
      workdir,
    });
    const execResult = await adapter.run({
      role: "executor",
      loopName,
      n,
      prompt: execPrompt,
      sessionId: execSessionId,
      workdir,
      engagementId,
      loopRunId,
      dbPath,
      config,
    });
    lastExecutorTrace = execResult.traceRef;
    const outputPath = execResult.outputPath;

    const revSessionId = randomUUID();
    const revPrompt = buildReviewerPrompt({
      loopName,
      n,
      executorOutputPath: outputPath,
      workdir,
    });
    const revResult = await adapter.run({
      role: "reviewer",
      loopName,
      n,
      prompt: revPrompt,
      sessionId: revSessionId,
      workdir,
      engagementId,
      loopRunId,
      dbPath,
      config,
    });
    const parsed = parseReviewerVerdict(revResult.text);
    const iterationId = randomUUID();
    db.prepare(
      `INSERT INTO iterations (
        id, loop_run_id, n, executor_output_path, reviewer_verdict, reviewer_notes, pi_trace_ref, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      iterationId,
      loopRunId,
      n,
      outputPath ?? null,
      parsed.verdict,
      parsed.notes,
      execResult.traceRef ?? null,
      utcNow(),
    );
    insertEvent(db, {
      engagementId,
      loopRunId,
      kind: "iteration.recorded",
      payload: {
        n,
        verdict: parsed.verdict,
        executorTrace: execResult.traceRef,
        reviewerTrace: revResult.traceRef,
      },
    });
    iterations.push({
      n,
      verdict: parsed.verdict,
      notes: parsed.notes,
      executorTrace: execResult.traceRef,
      reviewerTrace: revResult.traceRef,
    });
    previousNotes = parsed.notes;

    if (parsed.verdict === "approve") {
      terminal = "gate";
      break;
    }
    if (parsed.verdict === "escalate") {
      finishRun(db, { loopRunId, status: "needs_human", traceRef: lastExecutorTrace });
      insertEvent(db, {
        engagementId,
        loopRunId,
        kind: "loop_run.needs_human",
        payload: { n, notes: parsed.notes },
      });
      return { loopRunId, status: "needs_human", iterations, gateChecks: [] };
    }
    if (parsed.verdict === "reject") {
      finishRun(db, { loopRunId, status: "gate_failed", traceRef: lastExecutorTrace });
      insertEvent(db, {
        engagementId,
        loopRunId,
        kind: "loop_run.finished",
        payload: { status: "gate_failed", reason: "reject" },
      });
      return { loopRunId, status: "gate_failed", iterations, gateChecks: [] };
    }
  }

  if (terminal !== "gate") {
    finishRun(db, { loopRunId, status: "gate_failed", traceRef: lastExecutorTrace });
    insertEvent(db, {
      engagementId,
      loopRunId,
      kind: "loop_run.finished",
      payload: { status: "gate_failed", reason: "iteration_cap" },
    });
    return { loopRunId, status: "gate_failed", iterations, gateChecks: [] };
  }

  const rawChecks = (await gateRunner({ loopName, workdir, db, loopRunId })) ?? [];
  const gateChecks = rawChecks.map((c) => ({
    check_name: c.check_name,
    passed: c.passed ? 1 : 0,
    detail: c.detail ?? "",
  }));
  for (const check of gateChecks) {
    db.prepare(
      "INSERT INTO gate_checks (id, loop_run_id, check_name, passed, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(randomUUID(), loopRunId, check.check_name, check.passed, check.detail, utcNow());
  }
  const allPassed = gateChecks.length > 0 && gateChecks.every((c) => c.passed === 1);
  const status = allPassed ? "gate_passed" : "gate_failed";
  insertEvent(db, {
    engagementId,
    loopRunId,
    kind: "gate.checked",
    payload: { checks: gateChecks, passed: allPassed },
  });
  finishRun(db, { loopRunId, status, traceRef: lastExecutorTrace });
  insertEvent(db, {
    engagementId,
    loopRunId,
    kind: "loop_run.finished",
    payload: { status },
  });
  return { loopRunId, status, iterations, gateChecks };
}

function isMain() {
  const entry = process.argv[1] && path.resolve(process.argv[1]);
  return entry === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const { parseArgs } = await import("node:util");
  const yaml = (await import("yaml")).default;
  const { values } = parseArgs({
    options: {
      db: { type: "string" },
      loop: { type: "string" },
      engagement: { type: "string" },
      attempt: { type: "string", default: "0" },
      workdir: { type: "string" },
      "change-request-id": { type: "string" },
      "adjusted-instructions": { type: "string" },
    },
  });
  const dbPath = values.db || process.env.TENWHY_DB || path.join(ROOT, "state/orchestrator.db");
  const config = yaml.parse(fs.readFileSync(path.join(ROOT, "system/config/loops.yaml"), "utf8"));
  const db = new DatabaseSync(dbPath);
  try {
    const result = await runLoop({
      db,
      dbPath,
      loopName: values.loop,
      engagementId: values.engagement,
      attempt: Number(values.attempt ?? 0),
      changeRequestId: values["change-request-id"] ?? null,
      adjustedInstructions: values["adjusted-instructions"] ?? null,
      workdir: values.workdir,
      config,
      adapter: createPiAdapter({ repoRoot: ROOT, dbPath }),
      gateRunner: async () => {
        throw new Error("CLI gateRunner is not implemented until a loop-specific gate is wired");
      },
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    db.close();
  }
}
