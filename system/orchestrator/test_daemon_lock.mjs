import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { acquireDaemonLock, releaseDaemonLock } from "./daemon_lock.mjs";
import { runDaemon } from "./orchestrator.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOCK_MOD = pathToFileURL(path.join(HERE, "daemon_lock.mjs")).href;
const ORCH_MOD = pathToFileURL(path.join(HERE, "orchestrator.mjs")).href;

function waitExit(child) {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function waitFor(predicate, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error("timeout waiting for condition");
}

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
  const stale = fs.readdirSync(dir).filter((n) => n.startsWith("daemon.lock.stale."));
  assert.equal(stale.length, 1);
  assert.match(stale[0], /^daemon\.lock\.stale\.\d+\.4242$/);
  assert.equal(fs.readFileSync(path.join(dir, stale[0]), "utf8").trim(), String(dead));
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

test("two acquirers racing: exactly one succeeds, the other exits 3", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tenwhy-lock-"));
  const lockPath = path.join(dir, "daemon.lock");
  const goPath = path.join(dir, "go");
  const src = `
    import fs from "node:fs";
    import { acquireDaemonLock } from ${JSON.stringify(LOCK_MOD)};
    const go = ${JSON.stringify(goPath)};
    const lock = ${JSON.stringify(lockPath)};
    const start = Date.now();
    while (!fs.existsSync(go)) {
      if (Date.now() - start > 5000) process.exit(99);
      await new Promise((r) => setTimeout(r, 1));
    }
    const got = acquireDaemonLock(lock);
    if (!got.ok) process.exit(3);
    await new Promise((r) => setTimeout(r, 1500));
    process.exit(0);
  `;
  const spawnRacer = () =>
    spawn(process.execPath, ["--input-type=module", "-e", src], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  const a = spawnRacer();
  const b = spawnRacer();
  await new Promise((r) => setTimeout(r, 40));
  fs.writeFileSync(goPath, "1");
  const [ea, eb] = await Promise.all([waitExit(a), waitExit(b)]);
  const codes = [ea.code, eb.code].sort((x, y) => x - y);
  assert.deepEqual(codes, [0, 3], JSON.stringify({ ea, eb, out: a.stderr?.toString?.() }));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("two children racing a dead-pid stale lock: exactly one acquires", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tenwhy-lock-"));
  const lockPath = path.join(dir, "daemon.lock");
  const goPath = path.join(dir, "go");
  fs.writeFileSync(lockPath, "2147483646\n");
  const src = `
    import fs from "node:fs";
    import { acquireDaemonLock } from ${JSON.stringify(LOCK_MOD)};
    const go = ${JSON.stringify(goPath)};
    const lock = ${JSON.stringify(lockPath)};
    const start = Date.now();
    while (!fs.existsSync(go)) {
      if (Date.now() - start > 5000) process.exit(99);
      await new Promise((r) => setTimeout(r, 1));
    }
    const got = acquireDaemonLock(lock);
    if (!got.ok) process.exit(3);
    await new Promise((r) => setTimeout(r, 1500));
    process.exit(0);
  `;
  const spawnRacer = () =>
    spawn(process.execPath, ["--input-type=module", "-e", src], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  const a = spawnRacer();
  const b = spawnRacer();
  await new Promise((r) => setTimeout(r, 40));
  fs.writeFileSync(goPath, "1");
  const [ea, eb] = await Promise.all([waitExit(a), waitExit(b)]);
  const codes = [ea.code, eb.code].sort((x, y) => x - y);
  assert.deepEqual(codes, [0, 3], JSON.stringify({ ea, eb }));
  const stale = fs.readdirSync(dir).filter((n) => n.startsWith("daemon.lock.stale."));
  assert.ok(stale.length >= 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("SIGINT to a holder removes its lock; foreign pid is left untouched", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tenwhy-lock-"));
  const lockPath = path.join(dir, "daemon.lock");
  const dbPath = path.join(dir, "t.db");
  const src = `
    import { runDaemon } from ${JSON.stringify(ORCH_MOD)};
    await runDaemon({
      intervalMs: 5000,
      dbPath: ${JSON.stringify(dbPath)},
      lockPath: ${JSON.stringify(lockPath)},
      tickOpts: {
        runLoop: async () => ({}),
        config: { loops: {} },
        processApprovals: async () => {},
      },
    });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", src], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = waitExit(child);
  await waitFor(() => fs.existsSync(lockPath));
  assert.equal(fs.readFileSync(lockPath, "utf8").trim(), String(child.pid));
  process.kill(child.pid, "SIGINT");
  const { code, signal } = await exited;
  assert.equal(signal, null);
  assert.equal(code, 0);
  assert.equal(fs.existsSync(lockPath), false);

  fs.writeFileSync(lockPath, `${process.pid}\n`);
  releaseDaemonLock(lockPath, { pid: 4242 });
  assert.equal(fs.existsSync(lockPath), true);
  assert.equal(fs.readFileSync(lockPath, "utf8").trim(), String(process.pid));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("SIGINT mid-tick keeps the lock until the tick finishes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tenwhy-lock-"));
  const lockPath = path.join(dir, "daemon.lock");
  const dbPath = path.join(dir, "t.db");
  const tickingPath = path.join(dir, "ticking");
  const src = `
    import fs from "node:fs";
    import { runDaemon } from ${JSON.stringify(ORCH_MOD)};
    await runDaemon({
      intervalMs: 8000,
      dbPath: ${JSON.stringify(dbPath)},
      lockPath: ${JSON.stringify(lockPath)},
      tickOpts: {
        runLoop: async () => ({}),
        config: { loops: {} },
        processApprovals: async () => {
          fs.writeFileSync(${JSON.stringify(tickingPath)}, "1");
          await new Promise((r) => setTimeout(r, 1200));
        },
      },
    });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", src], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = waitExit(child);
  await waitFor(() => fs.existsSync(tickingPath));
  process.kill(child.pid, "SIGINT");
  await new Promise((r) => setTimeout(r, 80));
  const probeSrc = `
    import { acquireDaemonLock } from ${JSON.stringify(LOCK_MOD)};
    const got = acquireDaemonLock(${JSON.stringify(lockPath)});
    process.exit(got.ok ? 0 : 3);
  `;
  const probe = spawn(process.execPath, ["--input-type=module", "-e", probeSrc], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const probed = await waitExit(probe);
  assert.equal(probed.code, 3, "second acquire must see the lock held during the in-flight tick");
  assert.equal(fs.existsSync(lockPath), true);
  const { code, signal } = await exited;
  assert.equal(signal, null);
  assert.equal(code, 0);
  assert.equal(fs.existsSync(lockPath), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
