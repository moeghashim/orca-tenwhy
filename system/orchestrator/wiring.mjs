import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createClaudeAdapter } from "./adapters/claude.mjs";
import { createPiAdapter } from "./adapters/pi.mjs";
import { deploy } from "./deploy.mjs";
import { absorbResearch as absorb } from "./knowledge.mjs";
import { runLoop } from "./loop_runner.mjs";
import { ROOT, loadLoopsConfig } from "./util.mjs";

const SCRUBBED_GATE_KEYS = ["WEBSITE_GATE_SKIP_LIGHTHOUSE", "TENWHY_DEV"];

export function scrubGateEnv(env = process.env) {
  const out = { ...env };
  for (const key of SCRUBBED_GATE_KEYS) delete out[key];
  return out;
}

export function spawnGate({
  script,
  workdir,
  dbPath,
  loopRunId,
  python = path.join(ROOT, "system/tools/.venv/bin/python"),
  env = process.env,
}) {
  if (!script || !fs.existsSync(script)) {
    throw new Error(`gate script missing: ${script}`);
  }
  const result = spawnSync(
    python,
    [script, "--workdir", workdir, "--db", dbPath, "--loop-run-id", loopRunId],
    { encoding: "utf8", env: scrubGateEnv(env) },
  );
  const stdout = (result.stdout || "").trim();
  if (!stdout) {
    throw new Error(`gate ${script} produced no stdout (exit ${result.status}): ${result.stderr}`);
  }
  return JSON.parse(stdout.split(/\n/).pop());
}

export function createYamlGateRunner({ repoRoot = ROOT, config }) {
  const python = path.join(repoRoot, "system/tools/.venv/bin/python");
  return async ({ loopName, workdir, loopRunId, dbPath }) => {
    const rel = config?.loops?.[loopName]?.gate;
    if (!rel) return [];
    const script = path.isAbsolute(rel) ? rel : path.join(repoRoot, rel);
    if (!fs.existsSync(script)) return [];
    return spawnGate({ script, workdir, dbPath, loopRunId, python });
  };
}

export async function buildTickOpts({ repoRoot = ROOT, dbPath, config } = {}) {
  const cfg = config || (await loadLoopsConfig());
  const orchestrator = createClaudeAdapter();
  const loop = createPiAdapter({ repoRoot, dbPath });
  const gateRunner = createYamlGateRunner({ repoRoot, config: cfg });
  return {
    config: cfg,
    runLoop,
    adapters: {
      loop,
      orchestrator,
      gateRunner,
    },
    absorbResearch: (opts) => absorb({ ...opts, model: orchestrator }),
    deploy,
    repoRoot,
    dbPath,
  };
}
