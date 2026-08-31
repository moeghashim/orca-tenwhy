import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireDaemonLock, releaseDaemonLock } from "./daemon_lock.mjs";
import { runDaemon } from "./orchestrator.mjs";

test("daemon lock refuses a live pid", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tenwhy-lock-"));
  const lockPath = path.join(dir, "daemon.lock");
  fs.writeFileSync(lockPath, `${process.pid}\n`);
  const got = acquireDaemonLock(lockPath, { pid: 4242 });
  assert.equal(got.ok, false);
  assert.equal(got.pid, process.pid);
  assert.equal(fs.readFileSync(lockPath, "utf8").trim(), String(process.pid));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("daemon lock replaces a dead pid", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tenwhy-lock-"));
  const lockPath = path.join(dir, "daemon.lock");
  const dead = 2147483646;
  fs.writeFileSync(lockPath, `${dead}\n`);
  const kill = (pid, sig) => {
    if (pid === dead) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    return process.kill(pid, sig);
  };
  const got = acquireDaemonLock(lockPath, { pid: 4242, kill });
  assert.equal(got.ok, true);
  assert.equal(fs.readFileSync(lockPath, "utf8").trim(), "4242");
  releaseDaemonLock(lockPath, { pid: 4242 });
  assert.equal(fs.existsSync(lockPath), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("runDaemon exits 3 when another daemon holds the lock", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tenwhy-lock-"));
  const lockPath = path.join(dir, "daemon.lock");
  fs.writeFileSync(lockPath, `${process.pid}\n`);
  await assert.rejects(
    () =>
      runDaemon({
        intervalMs: 10,
        dbPath: path.join(dir, "t.db"),
        lockPath,
        tickOpts: { runLoop: async () => ({}), config: { loops: {} } },
      }),
    (err) => err.exitCode === 3 && err.message === `daemon already running (pid ${process.pid})`,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});
