# Fix round 9 — P3 daemon lock: serialize stale reclamation (Codex #r12)

Executor: Grok CLI. Reviewer: Codex. Orchestrator: Claude Code. Read this file as it is now.

## Finding (Codex `REVIEWED: P3 issues #r12`)
`system/orchestrator/daemon_lock.mjs:75` — two acquirers that both observed a **dead** pid in
`lockPath` race the takeover: A renames the stale lock away and links its own fresh lock; B,
a moment later, executes the same `fs.renameSync(lockPath, stalePath)` and renames **A's
freshly linked lock** away, then links its own → two daemons hold "the" lock.

## Required change (one commit, subject starts with `P3-fix9:`)
1. Serialize stale reclamation with a **separate atomic reaper lock** `${lockPath}.reap`:
   - acquire it with `fs.openSync(reapPath, "wx")` (O_EXCL; write `${pid}\n`), release with
     `unlink` in a `finally`.
   - `EEXIST` on the reaper lock → another process is reclaiming right now → do **not** rename
     anything; return `{ ok: false, pid: <pid currently in lockPath or null> }` (the daemon exits 3
     as today).
   - A reaper lock older than 30 s whose pid is not alive is itself stale: unlink it and retry the
     `wx` open once (bounded — no loops).
2. Inside the reaper critical section, **re-read `lockPath`** and only rename it to the stale
   path if it still holds the *same dead pid* observed before; if it now holds a live pid (or
   a different pid), release the reaper lock and return `{ ok: false, pid }`.
3. Keep everything else as is: link-based acquisition via the pid-scoped tmp file, `failExist`,
   `releaseDaemonLock` only unlinking the caller's own pid, error propagation for non-EEXIST/ENOENT.
4. Tests in `system/orchestrator/test_daemon_lock.mjs` (node:test, real child processes like the
   existing ones):
   - "two children racing a dead-pid stale lock: exactly one acquires" must still pass, and add
     a **deterministic** variant: child A holds the reaper lock (open with `wx`, keep it) while
     child B tries to take over a dead-pid lock → B returns `ok:false` and `lockPath` is untouched;
     after A releases and acquires, exactly one holder exists and it is A.
   - a reaper lock file older than 30 s with a dead pid is removed and the takeover proceeds
     (use `fs.utimesSync` to age it).
   - a stale reaper lock with a **live** pid (use `process.pid`) blocks the takeover (`ok:false`).
5. `node --test system/orchestrator/test_daemon_lock.mjs` and `make verify` must exit 0. Paste the
   final `node --test` summary lines in your DONE message together with the commit hash from
   `git log -1 --format=%h`.

## Rules
- Commit as `Moe Ghashim <mohanadgh@gmail.com>` (repo config; do not change identity).
- No new dependencies; Node 24 built-ins only. Do not touch other files.
- Push to `origin main` when done.
