# P11-fix-5 — dedupe_react.mjs must never delete outside the submodule (Codex #r22)

Executor: Grok CLI. Reviewer: Codex. Orchestrator: Claude Code. Read this file as it is now.

Codex: `dashboard/tools/dedupe_react.mjs:35` confines removals lexically (string prefix). If
`dashboard/vendor/tengrids/node_modules` — or any parent segment — is a symlink pointing elsewhere, the
`postinstall` hook would `rm -rf` a React directory outside the submodule. Required change (one commit,
subject `P11-fix-5:`):

1. Before removing a candidate directory: (a) walk every path segment from the repo root down to the
   candidate and **refuse if any segment is a symlink** (`fs.lstatSync(...).isSymbolicLink()`);
   (b) compute `fs.realpathSync` of the candidate and of the allowed roots
   (`dashboard/vendor/tengrids/node_modules`, `dashboard/vendor/tengrids/packages/*/node_modules`) and
   **refuse unless the real path is strictly inside a real allowed root** (use `path.relative` and check it
   does not start with `..` and is not absolute — no string-prefix checks). Refusals print a one-line
   warning and are skipped; the script still exits 0 for other candidates.
2. Regression tests in `dashboard/web/dedupe-react.test.mjs` using temp dirs (node:test):
   - a fake vendor tree with nested `react`/`react-dom` → removed, others untouched;
   - `node_modules` replaced by a **symlink** to an outside dir containing `react` → nothing removed,
     warning printed, outside dir intact;
   - a nested `react` that is itself a symlink to an outside dir → the link is removed but the target is
     intact (removal must use `rmSync` on the link only, never follow it);
   - the script accepts a `--root <dir>` (or env `DEDUPE_ROOT`) so tests can point it at the temp tree.
3. `make verify` exit 0; `node --test "dashboard/server/*.test.mjs" "dashboard/web/*.test.mjs"` exit 0
   with no flags. Paste the summary lines and `git log -1 --format=%h` in DONE.

Rules: commit as `Moe Ghashim <mohanadgh@gmail.com>`; push to `origin main`; do not touch the submodule's
tracked files, `system/loops/`, or `system/gates/`.
