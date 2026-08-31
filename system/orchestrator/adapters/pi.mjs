import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { debug, error as logError, preview } from "../log.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const providerLocks = new Map();

export function piScriptForRole(role, loopName, repoRoot = ROOT) {
  if (role === "reviewer") return path.join(repoRoot, "system/loops/_shared/run-pi-reviewer.sh");
  return path.join(repoRoot, "system/loops", loopName, "run-pi.sh");
}

function withProviderLock(provider, fn) {
  const key = provider || "default";
  const prev = providerLocks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  providerLocks.set(
    key,
    run.then(
      () => {},
      () => {},
    ),
  );
  return run;
}

function extractAssistantText(stdout) {
  let text = "";
  for (const line of String(stdout).split(/\n+/)) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = ev.message ?? (ev.role ? ev : null);
    if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    const parts = msg.content
      .filter((p) => p && p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("");
    if (parts) text = parts;
  }
  return text;
}

function extractStreamError(stdout) {
  // pi --mode json emits assistant messages with stopReason "error" + errorMessage
  // (e.g. OAuth refresh failures) while still exiting 0 — treat those as failures.
  let error = null;
  for (const line of String(stdout).split(/\n+/)) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = ev.message ?? null;
    if (msg && msg.role === "assistant" && msg.stopReason === "error") {
      error = msg.errorMessage || "assistant stopReason=error";
    }
  }
  return error;
}

function walkFiles(dir, out = []) {
  let entries = [];
  try {
    entries = fsSync.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, out);
    else out.push(p);
  }
  return out;
}

/** Pi stores sessions as <sessionDir>/<cwd-slug>/<ISO-ts>_<sessionId>.jsonl */
export function findSessionFile(sessionDir, sessionId) {
  const hit = walkFiles(sessionDir).find((p) => p.endsWith(`_${sessionId}.jsonl`));
  return hit ?? null;
}

/** Count tool calls in a Pi session JSONL (assistant `toolCall` blocks + `toolResult` messages). */
export function countToolCalls(jsonlText) {
  let count = 0;
  for (const line of String(jsonlText).split(/\n+/)) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = entry?.message ?? (entry?.role ? entry : null);
    if (!msg) continue;
    if (msg.role === "toolResult") count++;
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) if (block?.type === "toolCall") count++;
    }
  }
  return count;
}

/** SOP §0.3 / §7: the reviewer runs with no tools. Verify it mechanically from the trace. */
export function assertReviewerUsedNoTools({ sessionDir, sessionId, traceRef }) {
  const file = findSessionFile(sessionDir, sessionId);
  if (!file) {
    const err = new Error(`reviewer session file not found for ${sessionId} under ${sessionDir}`);
    err.code = "PI_SESSION_MISSING";
    err.traceRef = traceRef;
    throw err;
  }
  const calls = countToolCalls(fsSync.readFileSync(file, "utf8"));
  if (calls > 0) {
    const err = new Error(`reviewer session ${sessionId} contains ${calls} tool call(s); reviewer must run with no tools`);
    err.code = "REVIEWER_USED_TOOLS";
    err.traceRef = traceRef;
    err.toolCalls = calls;
    throw err;
  }
  return file;
}

function runPiScript({ script, args, env, cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(script, args, {
      cwd,
      env: { ...process.env, ...env },
      // stdin must be closed: `pi -p` waits for EOF on a piped stdin and never
      // starts the model turn (found in the first real engagement, 2026-08-31).
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c) => {
      stderr += c.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

export function createPiAdapter({ repoRoot = ROOT, dbPath = null } = {}) {
  return {
    async run({
      role,
      loopName,
      n,
      prompt,
      sessionId,
      workdir,
      engagementId,
      loopRunId,
      dbPath: runDbPath,
      config,
    }) {
      const roleCfg = config?.roles?.[role];
      if (!roleCfg) throw new Error(`loops.yaml missing roles.${role}`);
      const provider = roleCfg.provider;
      const model = roleCfg.model;
      if (!provider || !model) {
        throw new Error(`roles.${role} needs provider and model from loops.yaml`);
      }
      const session = sessionId || randomUUID();
      const sessionDir = path.join(
        repoRoot,
        "state/pi-sessions",
        engagementId || "unknown",
        loopRunId || "unknown",
      );
      await fs.mkdir(sessionDir, { recursive: true });
      await fs.mkdir(workdir, { recursive: true });
      const script = piScriptForRole(role, loopName, repoRoot);
      debug("pi", "prompt", { role, session, preview: preview(prompt) });
      const result = await withProviderLock(provider, () =>
        runPiScript({
          script,
          args: [prompt],
          cwd: workdir,
          env: {
            PROVIDER: provider,
            MODEL: model,
            SESSION_DIR: sessionDir,
            SESSION_ID: session,
            TENWHY_LOOP_RUN_ID: loopRunId || "",
            TENWHY_DB: runDbPath || dbPath || process.env.TENWHY_DB || "",
          },
        }),
      );
      const traceRef = `pi://session/${session}`;
      const streamError = extractStreamError(result.stdout);
      const text = extractAssistantText(result.stdout);
      if (result.code !== 0 || streamError || !text) {
        logError("pi", "adapter error", {
          role,
          session,
          exit: result.code,
          stderr: preview(result.stderr, 200),
        });
        const err = new Error(
          `pi ${role} run failed (exit ${result.code})` +
            (streamError ? `: ${streamError}` : !text ? ": no assistant text in output" : "") +
            (result.stderr.trim() ? `\nstderr: ${result.stderr.trim().slice(-2000)}` : ""),
        );
        err.code = "PI_RUN_FAILED";
        err.traceRef = traceRef;
        err.exitCode = result.code;
        err.stderr = result.stderr;
        throw err;
      }
      if (role === "reviewer") {
        assertReviewerUsedNoTools({ sessionDir, sessionId: session, traceRef });
      }
      const outputPath = path.join(workdir, `${role}-${n}.txt`);
      await fs.writeFile(outputPath, text, "utf8");
      let toolCalls = 0;
      try {
        const sessionFile = findSessionFile(sessionDir, session);
        if (sessionFile) toolCalls = countToolCalls(fsSync.readFileSync(sessionFile, "utf8"));
      } catch {
        /* */
      }
      return {
        text,
        outputPath,
        traceRef,
        exitCode: result.code,
        toolCalls,
      };
    },
  };
}
