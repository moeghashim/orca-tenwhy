import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const providerLocks = new Map();

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

function runPiScript({ script, args, env, cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(script, args, {
      cwd,
      env: { ...process.env, ...env },
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
      const script =
        role === "reviewer"
          ? path.join(repoRoot, "system/loops/_shared/run-pi-reviewer.sh")
          : path.join(repoRoot, "system/loops", loopName, "run-pi.sh");
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
        const err = new Error(
          `pi ${role} run failed (exit ${result.code})` +
            (streamError ? `: ${streamError}` : !text ? ": no assistant text in output" : "") +
            (result.stderr.trim() ? `\nstderr: ${result.stderr.trim().slice(-2000)}` : ""),
        );
        err.code = "PI_RUN_FAILED";
        err.traceRef = traceRef;
        err.exitCode = result.code;
        throw err;
      }
      const outputPath = path.join(workdir, `${role}-${n}.txt`);
      await fs.writeFile(outputPath, text, "utf8");
      return {
        text,
        outputPath,
        traceRef,
      };
    },
  };
}
