# Fix round 10 — P3 daemon lock: kernel-held ownership via SQLite (Codex #r13)

Executor: Grok CLI. Reviewer: Codex. Orchestrator: Claude Code. Read this file as it is now.

## Finding (Codex `REVIEWED: P3 issues #r13`)
`system/orchestrator/daemon_lock.mjs:66` — reclaiming an *aged* reaper lock by unlink + recreate
repeats the race one level up (a contender can unlink another contender's fresh reaper). Every
name-based file protocol (create/rename/unlink) has this TOCTOU somewhere; the reviewer asks for
a **kernel-held recovery lease or a non-racy ownership protocol**.

## Decision (orchestrator)
Replace the file/rename protocol entirely with a **SQLite-backed lock**: the lock file
`state/daemon.lock` *is* a SQLite database holding one row. Serialization comes from
`BEGIN IMMEDIATE`, which takes a kernel-held fcntl lock that is released automatically when the
process dies — no reaper, no rename, no temp files, nothing to age out. Verified on this machine
(Node v24.15.0): `new DatabaseSync(path, { timeout: 500 })` → a second `BEGIN IMMEDIATE` blocks and
fails with `ERR_SQLITE_ERROR` (busy) while the first holds it, and succeeds after `COMMIT`.

## Required change (one commit, subject starts with `P3-fix10:`)
1. `system/orchestrator/daemon_lock.mjs` — keep the exported API and return shapes exactly:
   `acquireDaemonLock(lockPath, { pid = process.pid, kill = process.kill.bind(process) })` →
   `{ ok: true, pid }` or `{ ok: false, pid: <holder pid or null> }`;
   `releaseDaemonLock(lockPath, { pid = process.pid })`.
   - `import { DatabaseSync } from "node:sqlite"`; `mkdirSync(dirname, { recursive: true })`;
     `const db = new DatabaseSync(lockPath, { timeout: 5000 })`; rollback journal (default) — do
     **not** enable WAL (no `-wal`/`-shm` side files).
   - `CREATE TABLE IF NOT EXISTS holder (id INTEGER PRIMARY KEY CHECK (id = 1), pid INTEGER NOT NULL,
     acquired_at TEXT NOT NULL)`.
   - acquire: `BEGIN IMMEDIATE`; read the row; if a row exists whose pid is alive (`kill(pid, 0)`
     succeeds) and is not ours → `ROLLBACK`, return `{ ok: false, pid }`; otherwise
     `INSERT OR REPLACE` our pid + ISO time, `COMMIT`, return `{ ok: true, pid }`. Always `db.close()`
     in `finally` — the *row* is the lock, not the connection.
   - busy (`ERR_SQLITE_ERROR` whose message/`errcode` is SQLITE_BUSY after the timeout) → return
     `{ ok: false, pid: <best-effort read of the row or null> }`; any other error propagates.
   - release: `BEGIN IMMEDIATE`; `DELETE FROM holder WHERE pid = ?` (our pid only); `COMMIT`;
     swallow errors as today.
   - **Legacy migration (bounded, one-time):** a pre-existing plain-text lock (old format, a pid
     line) makes `DatabaseSync` throw SQLITE_NOTADB. Handle it once: read the text pid; if alive →
     `{ ok: false, pid }`; if dead → `unlinkSync` that text file and retry the SQLite path **once**;
     if the retry fails again → `{ ok: false, pid: null }`. Document in a comment that this path
     exists only for locks written before this commit.
2. `system/orchestrator/test_daemon_lock.mjs` (node:test, real child processes as today):
   - keep: refuses a live pid; replaces a dead pid; `runDaemon` exits 3 when another daemon holds the
     lock; two acquirers racing → exactly one succeeds; two children racing a dead-pid lock → exactly
     one acquires; SIGINT holder removes its lock, foreign pid untouched; SIGINT mid-tick keeps the
     lock until the tick finishes. Seed "dead pid" locks through the API
     (`acquireDaemonLock(p, { pid: <exited child pid>, kill })`) rather than writing text.
   - remove the reaper tests (no reaper exists any more).
   - add: **six** children racing a dead-pid lock → exactly one acquires, the other five exit 3;
     holder SIGKILLed mid-hold (pid dead) → next acquirer takes over; legacy text lock with a dead
     pid is replaced, legacy text lock with a live pid (`process.pid`) is refused; the lock file is
     a SQLite database afterwards (`readFileSync(p).subarray(0,15).toString() === "SQLite format 3"`).
3. Nothing else changes: `orchestrator.mjs` keeps calling the same two functions at the same
   places; no schema change to `state/orchestrator.db`; no new dependencies.
4. `node --test system/orchestrator/test_daemon_lock.mjs` and `make verify` must exit 0. Paste the
   final `node --test` summary lines in your DONE message together with the commit hash from
   `git log -1 --format=%h`.

## Rules
- Commit as `Moe Ghashim <mohanadgh@gmail.com>` (repo config; do not change identity).
- Node 24 built-ins only. Do not touch other files. Push to `origin main` when done.
