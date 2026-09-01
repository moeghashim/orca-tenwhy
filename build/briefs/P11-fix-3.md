# P11-fix-3 — make the research grid Node-loadable without a custom JSX loader (Codex #r20)

Executor: Grok CLI. Reviewer: Codex. Orchestrator: Claude Code. Read this file as it is now.

Codex: `node --test "dashboard/web/*.test.mjs"` exits 1 because `mount.js` imports `ResearchGrid.jsx`,
which Node cannot load without `--import ./dashboard/web/jsx-register.mjs`. A test command that only
works with a hidden flag is a footgun. Fix by removing the need for JSX at runtime and in tests.

Required change (one commit, subject starting `P11-fix-3:`):
1. Rewrite `dashboard/web/src/research-grid/ResearchGrid.jsx` as `ResearchGrid.js` using
   `React.createElement` / a tiny `h = createElement` helper — no JSX anywhere under `dashboard/web/src`.
   Same behaviour, same `data-*` attributes and class names (tests and the render check rely on them).
2. Delete `dashboard/web/jsx-loader.mjs` and `dashboard/web/jsx-register.mjs`; drop the `esbuild` and
   `@vitejs/plugin-react` devDependencies (Vite needs no React plugin without JSX; keep
   `resolve.dedupe` + the react aliases exactly as they are). Update `package-lock.json` via `npm install`.
3. Every documented test command becomes plain `node --test …` — update `Makefile`, `README.md`,
   `PROGRESS.md` P11 rows if they cite the `--import` form, and `system/config/environment.md`.
   `node --test "dashboard/server/*.test.mjs" "dashboard/web/*.test.mjs"` must exit 0 with no flags.
4. `make verify` exit 0 (including `grid-render-check`); paste the summary lines and
   `git log -1 --format=%h` in DONE.

Rules: commit as `Moe Ghashim <mohanadgh@gmail.com>`; push to `origin main`; do not touch the submodule,
`system/loops/`, or `system/gates/`.
