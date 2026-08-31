import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { countToolCalls, createPiAdapter, piScriptForRole } from "./adapters/pi.mjs";

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

const CONFIG = {
  roles: {
    executor: { provider: "xai", model: "grok-4.6" },
    reviewer: { provider: "openai-codex", model: "gpt-5.6-luna" },
  },
};

function makeStubPi(tmp, { withToolCall }) {
  // Fake `pi`: emits one assistant text line on stdout and writes a session JSONL
  // under SESSION_DIR/<slug>/<ts>_<SESSION_ID>.jsonl, like the real harness.
  const stub = path.join(tmp, "bin", "pi");
  fs.mkdirSync(path.dirname(stub), { recursive: true });
  const toolLine = withToolCall
    ? `{"type":"message","id":"t1","message":{"role":"assistant","content":[{"type":"toolCall","id":"call_1","name":"scrape","arguments":{"url":"https://x"}}]}}`
    : "";
  fs.writeFileSync(
    stub,
    `#!/bin/sh
sid=""
dir=""
while [ $# -gt 0 ]; do
  case "$1" in
    --session-id) sid="$2"; shift ;;
    --session-dir) dir="$2"; shift ;;
  esac
  shift
done
mkdir -p "$dir/slug"
{
  echo '{"type":"session","version":3,"id":"'"$sid"'"}'
  ${toolLine ? `echo '${toolLine}'` : "true"}
  echo '{"type":"message","id":"a1","message":{"role":"assistant","content":[{"type":"text","text":"{\\"verdict\\":\\"approve\\",\\"notes\\":\\"ok\\"}"}]}}'
} > "$dir/slug/2026-08-30T00-00-00-000Z_$sid.jsonl"
echo '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"{\\"verdict\\":\\"approve\\",\\"notes\\":\\"ok\\"}"}],"stopReason":"stop"}}'
`,
  );
  fs.chmodSync(stub, 0o755);
  return path.dirname(stub);
}

test("countToolCalls counts assistant toolCall blocks and toolResult messages", () => {
  const jsonl = [
    JSON.stringify({ type: "session", id: "s" }),
    JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } }),
    JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "scrape", arguments: {} }] } }),
    JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "c1", toolName: "scrape", content: [] } }),
  ].join("\n");
  assert.equal(countToolCalls(jsonl), 2);
  assert.equal(countToolCalls(JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "x" }] } })), 0);
});

test("reviewer run whose session JSONL contains a toolCall fails with REVIEWER_USED_TOOLS; executor is unaffected", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tenwhy-pi-guard-"));
  const binDir = makeStubPi(tmp, { withToolCall: true });
  const origPath = process.env.PATH;
  process.env.PATH = `${binDir}:${origPath}`;
  try {
    const adapter = createPiAdapter({ repoRoot: tmp, dbPath: path.join(tmp, "t.db") });
    // scripts live in the real repo; point the adapter's repoRoot at a copy of just what it needs
    fs.mkdirSync(path.join(tmp, "system/loops/_shared"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "system/loops/company-research"), { recursive: true });
    fs.copyFileSync(path.join(ROOT, "system/loops/_shared/run-pi-reviewer.sh"), path.join(tmp, "system/loops/_shared/run-pi-reviewer.sh"));
    fs.copyFileSync(path.join(ROOT, "system/loops/company-research/run-pi.sh"), path.join(tmp, "system/loops/company-research/run-pi.sh"));
    fs.mkdirSync(path.join(tmp, "system/tools"), { recursive: true });
    const common = { loopName: "company-research", n: 1, prompt: "p", workdir: path.join(tmp, "work"), engagementId: "e", loopRunId: "r", config: CONFIG };
    await assert.rejects(
      adapter.run({ ...common, role: "reviewer", sessionId: "rev-1" }),
      (err) => err.code === "REVIEWER_USED_TOOLS" && err.toolCalls === 1,
    );
    const ok = await adapter.run({ ...common, role: "executor", sessionId: "exec-1" });
    assert.match(ok.text, /approve/);
  } finally {
    process.env.PATH = origPath;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("reviewer run with a clean session JSONL succeeds", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tenwhy-pi-guard-ok-"));
  const binDir = makeStubPi(tmp, { withToolCall: false });
  const origPath = process.env.PATH;
  process.env.PATH = `${binDir}:${origPath}`;
  try {
    fs.mkdirSync(path.join(tmp, "system/loops/_shared"), { recursive: true });
    fs.copyFileSync(path.join(ROOT, "system/loops/_shared/run-pi-reviewer.sh"), path.join(tmp, "system/loops/_shared/run-pi-reviewer.sh"));
    const adapter = createPiAdapter({ repoRoot: tmp, dbPath: path.join(tmp, "t.db") });
    const res = await adapter.run({ role: "reviewer", loopName: "company-research", n: 1, prompt: "p", sessionId: "rev-ok", workdir: path.join(tmp, "work"), engagementId: "e", loopRunId: "r", config: CONFIG });
    assert.equal(res.traceRef, "pi://session/rev-ok");
  } finally {
    process.env.PATH = origPath;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("adapter closes stdin: a pi that reads stdin to EOF before answering still completes", async () => {
  // Regression for the live-run hang: with a piped, never-closed stdin, `pi -p` blocks forever.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tenwhy-pi-stdin-"));
  const bin = path.join(tmp, "bin"); fs.mkdirSync(bin, { recursive: true });
  const stub = path.join(bin, "pi");
  fs.writeFileSync(stub, `#!/bin/sh
sid=""; dir=""
while [ $# -gt 0 ]; do case "$1" in --session-id) sid="$2"; shift ;; --session-dir) dir="$2"; shift ;; esac; shift; done
cat >/dev/null            # block until stdin EOF (hangs if the parent leaves stdin open)
mkdir -p "$dir/slug"
echo '{"type":"session","version":3,"id":"'"$sid"'"}' > "$dir/slug/2026-08-31T00-00-00-000Z_$sid.jsonl"
echo '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"{\\"verdict\\":\\"approve\\",\\"notes\\":\\"ok\\"}"}],"stopReason":"stop"}}'
`);
  fs.chmodSync(stub, 0o755);
  fs.mkdirSync(path.join(tmp, "system/loops/_shared"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "system/loops/_shared/run-pi-reviewer.sh"), path.join(tmp, "system/loops/_shared/run-pi-reviewer.sh"));
  const origPath = process.env.PATH; process.env.PATH = `${bin}:${origPath}`;
  try {
    const adapter = createPiAdapter({ repoRoot: tmp, dbPath: path.join(tmp, "t.db") });
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("adapter hung: stdin left open")), 8000));
    const res = await Promise.race([
      adapter.run({ role: "reviewer", loopName: "company-research", n: 1, prompt: "p", sessionId: "stdin-1", workdir: path.join(tmp, "work"), engagementId: "e", loopRunId: "r", config: CONFIG }),
      timeout,
    ]);
    assert.match(res.text, /approve/);
  } finally {
    process.env.PATH = origPath; fs.rmSync(tmp, { recursive: true, force: true });
  }
});
