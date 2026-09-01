# P11-fix-4 — one React for Node too (Codex #r21)

Executor: Grok CLI. Reviewer: Codex. Orchestrator: Claude Code. Read this file as it is now.

Codex ran the documented sequence `npm ci` → `node --test "dashboard/web/*.test.mjs"` and got nested-React
"invalid hook call" failures (58/62). Cause: the submodule's own `dashboard/vendor/tengrids/node_modules/react`
(19.1.1) is what Node resolves for the linked `@glideapps/glide-data-grid` package, while the tests use the
root React. Vite's `resolve.dedupe` hides this in the bundle, and the React cleanup you added runs only inside
`make vendor-tengrids`, so a plain `npm ci` leaves two Reacts. Required change (one commit, `P11-fix-4:`):

1. Extract the cleanup into `dashboard/tools/dedupe_react.mjs` (Node, no deps): remove `react`, `react-dom`
   (and any `react*`/`scheduler` copies) under `dashboard/vendor/tengrids/node_modules` and
   `dashboard/vendor/tengrids/packages/*/node_modules`, so resolution from the linked package climbs to the
   root `node_modules`. Idempotent; prints what it removed; exits 0 when nothing to do; never touches
   anything outside those paths.
2. Call it from **both** places: root `package.json` `"postinstall": "node dashboard/tools/dedupe_react.mjs"`
   (runs after `npm ci`/`npm install` in the root) and the Makefile `vendor-tengrids` target (after the
   submodule's `npm ci`, before its build — the build must still pass without a nested React; if the
   submodule build needs React present, run the build first and dedupe after, and say so in DONE).
3. A test `dashboard/web/react-instance.test.mjs`: `createRequire` from
   `dashboard/vendor/tengrids/packages/core/package.json` and from the root `package.json` must resolve
   `react` and `react-dom` to the **same** absolute paths.
4. Prove the exact Codex sequence in a fresh clone or worktree: `git submodule update --init`, `npm ci`,
   then `node --test "dashboard/server/*.test.mjs" "dashboard/web/*.test.mjs"` with no flags → all pass.
   Paste those lines, the `make verify` summary, and `git log -1 --format=%h` in DONE.

Rules: commit as `Moe Ghashim <mohanadgh@gmail.com>`; push to `origin main`; do not modify the submodule's
tracked files (removing files under its gitignored node_modules is fine).
