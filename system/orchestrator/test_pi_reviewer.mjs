import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { piScriptForRole } from "./adapters/pi.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("adapter selects run-pi-reviewer.sh for reviewer and loop run-pi.sh for executor", () => {
  const reviewer = piScriptForRole("reviewer", "company-research", ROOT);
  const executor = piScriptForRole("executor", "company-research", ROOT);
  assert.equal(reviewer, path.join(ROOT, "system/loops/_shared/run-pi-reviewer.sh"));
  assert.equal(executor, path.join(ROOT, "system/loops/company-research/run-pi.sh"));
  assert.notEqual(reviewer, executor);
});

test("run-pi-reviewer.sh invokes pi with --no-tools and without -e/--tools", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tenwhy-pi-stub-"));
  const stubOut = path.join(tmp, "argv.txt");
  const stub = path.join(tmp, "pi");
  fs.writeFileSync(
    stub,
    `#!/bin/sh
printf '%s\\n' "$@" > "${stubOut}"
echo '{"type":"session","id":"stub"}'
`,
  );
  fs.chmodSync(stub, 0o755);
  const script = path.join(ROOT, "system/loops/_shared/run-pi-reviewer.sh");
  const result = spawnSync("bash", [script, "hello"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${tmp}:${process.env.PATH}`,
      PROVIDER: "openai-codex",
      MODEL: "gpt-5.6-luna",
      SESSION_DIR: path.join(tmp, "sessions"),
      SESSION_ID: "smoke-reviewer",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const argv = fs.readFileSync(stubOut, "utf8").trim().split(/\n/);
  assert.ok(argv.includes("--no-tools"), argv.join(" "));
  assert.ok(!argv.includes("-e"), argv.join(" "));
  assert.ok(!argv.includes("--tools"), argv.join(" "));
  fs.rmSync(tmp, { recursive: true, force: true });
});
