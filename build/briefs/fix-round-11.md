# Fix round 11 — P3 daemon lock: serialize the legacy migration (Codex #r14)

Executor: Grok CLI. Reviewer: Codex. Orchestrator: Claude Code. Read this file as it is now.

## Finding (Codex `REVIEWED: P3 issues #r14`)
`system/orchestrator/daemon_lock.mjs:109` — the one-time migration of a legacy *text* lock
(read pid → dead → `unlinkSync(lockPath)` → retry) is still a name-based unlink/create step: two
contenders that both saw the legacy file can have one of them unlink the other's **fresh SQLite
lock** after the first migrated. Everything else in `c99a77e` is accepted.

## Required change (one commit, subject starts with `P3-fix11:`)
1. Serialize the migration behind a **stable SQLite migration lock** `${lockPath}.migrate`
   (a second tiny `DatabaseSync` with `{ timeout: 5000 }`, rollback journal, one dummy table so
   `BEGIN IMMEDIATE` has something to lock). The whole legacy path runs inside
   `BEGIN IMMEDIATE … COMMIT` on that DB:
   - inside the transaction, **re-read `lockPath`** and treat it as legacy **only if** the whole
     content matches `/^\d+\s*$/` (a pid line). A file that is empty, starts with
     `SQLite format 3`, or has any other content is *not* legacy → `ROLLBACK`, return
     `{ ok: false, pid: null }` (the normal SQLite path will be used on the next attempt).
     Note: a freshly created SQLite DB can be 0 bytes for an instant — that is why "empty" must
     not count as legacy.
   - legacy + pid alive → `ROLLBACK`, return `{ ok: false, pid }`.
   - legacy + pid dead → `unlinkSync(lockPath)` **inside** the transaction, `COMMIT`, then fall
     through to the normal SQLite acquisition exactly once.
   - busy on the migration lock → return `{ ok: false, pid: <legacy pid if readable, else null> }`.
   - always close the migration DB in `finally`. The `.migrate` file may stay on disk (it is a
     zero-cost, stable lock, never unlinked — that is what makes it race-free).
2. `releaseDaemonLock` unchanged. `acquireDaemonLock` signature/returns unchanged.
3. Tests in `system/orchestrator/test_daemon_lock.mjs` (real child processes as today):
   - **concurrent legacy-text**: write a legacy text lock with a dead pid, start six children that
     all call `acquireDaemonLock` at once → exactly one `ok:true`, five exit 3, and afterwards
     `lockPath` is one SQLite DB (`SQLite format 3` header) whose holder row is the winner's pid.
   - migration lock held by another process (child holds `BEGIN IMMEDIATE` on `${lockPath}.migrate`
     for 1 s) → a legacy dead-pid lock is *not* unlinked while it is held; after the child releases,
     acquisition succeeds.
   - an empty 0-byte `lockPath` is treated as a SQLite DB, not legacy (acquire succeeds, no unlink).
   - keep all existing tests.
4. `node --test system/orchestrator/test_daemon_lock.mjs` and `make verify` must exit 0. Paste the
   final `node --test` summary lines in your DONE message with the commit hash from
   `git log -1 --format=%h`.

## Rules
- Commit as `Moe Ghashim <mohanadgh@gmail.com>` (repo config; do not change identity).
- Node 24 built-ins only. Do not touch other files. Push to `origin main` when done.
