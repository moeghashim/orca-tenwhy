import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildTickOpts, spawnGate } from "./wiring.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("buildTickOpts resolves every tick dependency to a function", async () => {
  const opts = await buildTickOpts({ repoRoot: ROOT, dbPath: "/tmp/tenwhy-wire.db" });
  assert.equal(typeof opts.runLoop, "function");
  assert.equal(typeof opts.adapters.loop.run, "function");
  assert.equal(typeof opts.adapters.orchestrator.composeAdjustedInstructions, "function");
  assert.equal(typeof opts.adapters.orchestrator.rewriteSynthesis, "function");
  assert.equal(typeof opts.adapters.gateRunner, "function");
  assert.equal(typeof opts.absorbResearch, "function");
  assert.equal(typeof opts.deploy, "function");
  assert.ok(opts.config?.loops?.["company-research"]?.gate);
});

test("gateRunner on a fixture gate script returns parsed checks", () => {
  const script = path.join(ROOT, "system/orchestrator/fixtures/fake_gate.py");
  const checks = spawnGate({
    script,
    workdir: ROOT,
    dbPath: "/tmp/unused.db",
    loopRunId: "run_fixture",
  });
  assert.equal(checks.length, 1);
  assert.equal(checks[0].check_name, "ok");
  assert.equal(checks[0].passed, true);
  assert.equal(checks[0].detail, "fixture");
});

test("spawnGate does not forward WEBSITE_GATE_SKIP_LIGHTHOUSE or TENWHY_DEV", () => {
  const script = path.join(ROOT, "system/orchestrator/fixtures/echo_env_gate.py");
  const prevSkip = process.env.WEBSITE_GATE_SKIP_LIGHTHOUSE;
  const prevDev = process.env.TENWHY_DEV;
  process.env.WEBSITE_GATE_SKIP_LIGHTHOUSE = "1";
  process.env.TENWHY_DEV = "1";
  try {
    const checks = spawnGate({
      script,
      workdir: ROOT,
      dbPath: "/tmp/unused.db",
      loopRunId: "run_env",
      env: process.env,
    });
    assert.equal(checks[0].detail, "[]");
  } finally {
    if (prevSkip === undefined) delete process.env.WEBSITE_GATE_SKIP_LIGHTHOUSE;
    else process.env.WEBSITE_GATE_SKIP_LIGHTHOUSE = prevSkip;
    if (prevDev === undefined) delete process.env.TENWHY_DEV;
    else process.env.TENWHY_DEV = prevDev;
  }
});
