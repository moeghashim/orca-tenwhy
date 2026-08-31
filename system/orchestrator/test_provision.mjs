import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { ROOT } from "./util.mjs";

const PROVISION = path.join(ROOT, "system/tools/provision.sh");

function run(args, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  if (!Object.prototype.hasOwnProperty.call(extraEnv, "TENWHY_PROVISION_DIR")) {
    delete env.TENWHY_PROVISION_DIR;
  }
  return spawnSync("bash", [PROVISION, ...args], { encoding: "utf8", env });
}

test("provision.sh refuses ../x, /tmp/x, and TENWHY_PROVISION_DIR=/tmp (exit 2)", () => {
  const cases = [
    { args: ["../x", "ok-slug"], env: {} },
    { args: ["/tmp/x", "ok-slug"], env: {} },
    { args: ["ok_id", "ok-slug"], env: { TENWHY_PROVISION_DIR: "/tmp" } },
  ];
  for (const c of cases) {
    const r = run(c.args, c.env);
    assert.equal(r.status, 2, `${c.args.join(" ")} env=${JSON.stringify(c.env)}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
  }
});
