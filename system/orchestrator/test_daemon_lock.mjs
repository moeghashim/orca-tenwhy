import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
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

function sqliteHeader(lockPath) {
  return fs.readFileSync(lockPath).subarray(0, 15).toString();
}

function spawnScript(src) {
  return spawn(process.execPath, ["--input-type=module", "-e", src], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function plantDeadLock(lockPath) {
  const src = `
    import { acquireDaemonLock } from ${JSON.stringify(LOCK_MOD)};
    const got = acquireDaemonLock(${JSON.stringify(lockPath)});
    if (!got.ok) process.exit(4);
    process.exit(0);
  `;
  const child = spawnScript(src);
  const { code } = await waitExit(child);
  assert.equal(code, 0);
  return child.pid;
}

function racerSrc(lockPath, goPath, holdMs = 1500) {
  return `
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
    await new Promise((r) => setTimeout(r, ${holdMs}));
    process.exit(0);
  `;
}

test("daemon lock refuses a live pid", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tenwhy-lock-"));
  const lockPath = path.join(dir, "daemon.lock");
  const first = acquireDaemonLock(lockPath);
  assert.equal(first.ok, true);
  const got = acquireDaemonLock(lockPath, { pid: 4242 });
  assert.equal(got.ok, false);
  assert.equal(got.pid, process.pid);
  assert.equal(sqliteHeader(lockPath), "SQLite format 3");
  releaseDaemonLock(lockPath);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("daemon lock replaces a dead pid", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tenwhy-lock-"));
  const lockPath = path.join(dir, "daemon.lock");
  await plantDeadLock(lockPath);
  const got = acquireDaemonLock(lockPath, { pid: 4242 });
  assert.equal(got.ok, true);
  assert.equal(got.pid, 4242);
  assert.equal(sqliteHeader(lockPath), "SQLite format 3");
  releaseDaemonLock(lockPath, { pid: 4242 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("runDaemon exits 3 when another daemon holds the lock", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tenwhy-lock-"));
  const lockPath = path.join(dir, "daemon.lock");
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"]);
  const holderExit = waitExit(holder);
  const planted = acquireDaemonLock(lockPath, { pid: holder.pid });
  assert.equal(planted.ok, true);
  await assert.rejects(
    () =>
      runDaemon({
        intervalMs: 10,
        dbPath: path.join(dir, "t.db"),
        lockPath,
        tickOpts: { runLoop: async () => ({}), config: { loops: {} } },
      }),
    (err) => err.exitCode === 3 && err.message === `daemon already running (pid ${holder.pid})`,
  );
  process.kill(holder.pid, "SIGKILL");
  await holderExit;
  releaseDaemonLock(lockPath, { pid: holder.pid });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("two acquirers racing: exactly one succeeds, the other exits 3", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tenwhy-lock-"));
  const lockPath = path.join(dir, "daemon.lock");
  const goPath = path.join(dir, "go");
  const src = racerSrc(lockPath, goPath);
  const a = spawnScript(src);
  const b = spawnScript(src);
  await new Promise((r) => setTimeout(r, 40));
  fs.writeFileSync(goPath, "1");
  const [ea, eb] = await Promise.all([waitExit(a), waitExit(b)]);
  const codes = [ea.code, eb.code].sort((x, y) => x - y);
  assert.deepEqual(codes, [0, 3], JSON.stringify({ ea, eb }));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("two children racing a dead-pid lock: exactly one acquires", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tenwhy-lock-"));
  const lockPath = path.join(dir, "daemon.lock");
  const goPath = path.join(dir, "go");
  await plantDeadLock(lockPath);
  const src = racerSrc(lockPath, goPath);
  const a = spawnScript(src);
  const b = spawnScript(src);
  await new Promise((r) => setTimeout(r, 40));
  fs.writeFileSync(goPath, "1");
  const [ea, eb] = await Promise.all([waitExit(a), waitExit(b)]);
  const codes = [ea.code, eb.code].sort((x, y) => x - y);
  assert.deepEqual(codes, [0, 3], JSON.stringify({ ea, eb }));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("SIGINT to a holder removes its lock; foreign pid is left untouched", async (t) => {
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
  const child = spawnScript(src);
  t.after(() => {
    try {
      process.kill(child.pid, "SIGKILL");
    } catch {
      /* */
    }
  });
  const exited = waitExit(child);
  await waitFor(() => fs.existsSync(lockPath));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sqliteHeader(lockPath), "SQLite format 3");
  process.kill(child.pid, "SIGINT");
  const { code, signal } = await exited;
  assert.equal(signal, null);
  assert.equal(code, 0);
  const after = acquireDaemonLock(lockPath, { pid: 4242 });
  assert.equal(after.ok, true);
  releaseDaemonLock(lockPath, { pid: 4242 });

  const held = acquireDaemonLock(lockPath);
  assert.equal(held.ok, true);
  releaseDaemonLock(lockPath, { pid: 4242 });
  const steal = acquireDaemonLock(lockPath, { pid: 4242 });
  assert.equal(steal.ok, false);
  assert.equal(steal.pid, process.pid);
  releaseDaemonLock(lockPath);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("SIGINT mid-tick keeps the lock until the tick finishes", async (t) => {
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
  const child = spawnScript(src);
  t.after(() => {
    try {
      process.kill(child.pid, "SIGKILL");
    } catch {
      /* */
    }
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
  const probe = spawnScript(probeSrc);
  const probed = await waitExit(probe);
  assert.equal(probed.code, 3, "second acquire must see the lock held during the in-flight tick");
  assert.equal(fs.existsSync(lockPath), true);
  const { code, signal } = await exited;
  assert.equal(signal, null);
  assert.equal(code, 0);
  const after = acquireDaemonLock(lockPath, { pid: 4242 });
  assert.equal(after.ok, true);
  releaseDaemonLock(lockPath, { pid: 4242 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("six children racing a dead-pid lock: exactly one acquires", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tenwhy-lock-"));
  const lockPath = path.join(dir, "daemon.lock");
  const goPath = path.join(dir, "go");
  await plantDeadLock(lockPath);
  const src = racerSrc(lockPath, goPath);
  const kids = Array.from({ length: 6 }, () => spawnScript(src));
  await new Promise((r) => setTimeout(r, 40));
  fs.writeFileSync(goPath, "1");
  const exits = await Promise.all(kids.map(waitExit));
  const codes = exits.map((e) => e.code).sort((x, y) => x - y);
  assert.deepEqual(codes, [0, 3, 3, 3, 3, 3], JSON.stringify(exits));
  assert.equal(sqliteHeader(lockPath), "SQLite format 3");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("holder SIGKILLed mid-hold: next acquirer takes over", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tenwhy-lock-"));
  const lockPath = path.join(dir, "daemon.lock");
  const heldPath = path.join(dir, "held");
  const src = `
    import fs from "node:fs";
    import { acquireDaemonLock } from ${JSON.stringify(LOCK_MOD)};
    const got = acquireDaemonLock(${JSON.stringify(lockPath)});
    if (!got.ok) process.exit(4);
    fs.writeFileSync(${JSON.stringify(heldPath)}, String(process.pid));
    setInterval(() => {}, 10000);
  `;
  const child = spawnScript(src);
  t.after(() => {
    try {
      process.kill(child.pid, "SIGKILL");
    } catch {
      /* */
    }
  });
  const exited = waitExit(child);
  await waitFor(() => fs.existsSync(heldPath));
  process.kill(child.pid, "SIGKILL");
  const { signal } = await exited;
  assert.equal(signal, "SIGKILL");
  const got = acquireDaemonLock(lockPath);
  assert.equal(got.ok, true);
  assert.equal(got.pid, process.pid);
  assert.equal(sqliteHeader(lockPath), "SQLite format 3");
  releaseDaemonLock(lockPath);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("legacy text lock with a dead pid is replaced", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tenwhy-lock-"));
  const lockPath = path.join(dir, "daemon.lock");
  const dead = await plantDeadLock(path.join(dir, "planter.lock"));
  fs.writeFileSync(lockPath, `${dead}\n`);
  const got = acquireDaemonLock(lockPath, { pid: 4242 });
  assert.equal(got.ok, true);
  assert.equal(got.pid, 4242);
  assert.equal(sqliteHeader(lockPath), "SQLite format 3");
  releaseDaemonLock(lockPath, { pid: 4242 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("legacy text lock with a live pid is refused", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tenwhy-lock-"));
  const lockPath = path.join(dir, "daemon.lock");
  fs.writeFileSync(lockPath, `${process.pid}\n`);
  const got = acquireDaemonLock(lockPath, { pid: 4242 });
  assert.equal(got.ok, false);
  assert.equal(got.pid, process.pid);
  assert.equal(fs.readFileSync(lockPath, "utf8").trim(), String(process.pid));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("six children racing a legacy text lock: exactly one acquires", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tenwhy-lock-"));
  const lockPath = path.join(dir, "daemon.lock");
  const goPath = path.join(dir, "go");
  const dead = await plantDeadLock(path.join(dir, "planter.lock"));
  fs.writeFileSync(lockPath, `${dead}\n`);
  const src = racerSrc(lockPath, goPath);
  const kids = Array.from({ length: 6 }, () => spawnScript(src));
  await new Promise((r) => setTimeout(r, 40));
  fs.writeFileSync(goPath, "1");
  const exits = await Promise.all(kids.map(async (c) => ({ pid: c.pid, ...(await waitExit(c)) })));
  const codes = exits.map((e) => e.code).sort((x, y) => x - y);
  assert.deepEqual(codes, [0, 3, 3, 3, 3, 3], JSON.stringify(exits));
  const winner = exits.find((e) => e.code === 0);
  assert.equal(sqliteHeader(lockPath), "SQLite format 3");
  const db = new DatabaseSync(lockPath);
  try {
    const row = db.prepare("SELECT pid FROM holder WHERE id = 1").get();
    assert.equal(row.pid, winner.pid);
  } finally {
    db.close();
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("held migration lock blocks legacy unlink until released", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tenwhy-lock-"));
  const lockPath = path.join(dir, "daemon.lock");
  const migratePath = `${lockPath}.migrate`;
  const heldPath = path.join(dir, "held");
  const dead = await plantDeadLock(path.join(dir, "planter.lock"));
  fs.writeFileSync(lockPath, `${dead}\n`);
  const src = `
    import fs from "node:fs";
    import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync(${JSON.stringify(migratePath)}, { timeout: 5000 });
    db.exec("BEGIN IMMEDIATE");
    db.exec("CREATE TABLE IF NOT EXISTS migrate (id INTEGER PRIMARY KEY CHECK (id = 1))");
    fs.writeFileSync(${JSON.stringify(heldPath)}, "1");
    await new Promise((r) => setTimeout(r, 1000));
    db.exec("COMMIT");
    db.close();
  `;
  const child = spawnScript(src);
  t.after(() => {
    try {
      process.kill(child.pid, "SIGKILL");
    } catch {
      /* */
    }
  });
  const childExit = waitExit(child);
  await waitFor(() => fs.existsSync(heldPath));
  const acquirer = spawnScript(`
    import { acquireDaemonLock } from ${JSON.stringify(LOCK_MOD)};
    const got = acquireDaemonLock(${JSON.stringify(lockPath)});
    if (!got.ok) process.exit(3);
    process.exit(0);
  `);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(fs.readFileSync(lockPath, "utf8").trim(), String(dead));
  const { code: holderCode } = await childExit;
  assert.equal(holderCode, 0);
  const { code } = await waitExit(acquirer);
  assert.equal(code, 0);
  assert.equal(sqliteHeader(lockPath), "SQLite format 3");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("empty lock file is treated as SQLite, not legacy", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tenwhy-lock-"));
  const lockPath = path.join(dir, "daemon.lock");
  fs.writeFileSync(lockPath, "");
  assert.equal(fs.statSync(lockPath).size, 0);
  const got = acquireDaemonLock(lockPath);
  assert.equal(got.ok, true);
  assert.equal(fs.existsSync(lockPath), true);
  assert.equal(sqliteHeader(lockPath), "SQLite format 3");
  releaseDaemonLock(lockPath);
  fs.rmSync(dir, { recursive: true, force: true });
});
