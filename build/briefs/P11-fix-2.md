# P11-fix-2 — URI cells only for http(s) (Codex #r19 item 1)

Executor: Grok CLI. Reviewer: Codex. Orchestrator: Claude Code. Read this file as it is now.

`dashboard/web/src/research-grid/model.js:29` emits `GridCellKind.Uri` for any string in a link column.
Research data comes from scraped pages and model output, so a value can be empty, relative, or an
unsafe scheme (`javascript:`, `data:`, `file:`). Required change (one commit, subject `P11-fix-2:`):

1. A helper `safeHttpUrl(value)` → returns the trimmed string only when it parses with `new URL()` and the
   protocol is `http:` or `https:`; otherwise `null`. Use it everywhere a Uri cell is built (competitor
   website, product url, match source_url). Non-http values render as plain **Text** cells showing the raw
   value (or "—" when empty) — never a Uri cell.
2. Tests in `dashboard/web/model.test.mjs`: `""`, `null`, `"myjam.co.uk/products/x"` (no scheme),
   `"javascript:alert(1)"`, `"data:text/html,…"`, `"ftp://x"` → Text cells; `"https://…"` and `"http://…"`
   → Uri cells; the verified flag logic unchanged.
3. `make verify` exit 0; paste the summary lines and `git log -1 --format=%h` in DONE.

Rules: only `model.js` and `model.test.mjs` change. Commit as `Moe Ghashim <mohanadgh@gmail.com>`; push to `origin main`.
The orchestrator already fixed the two `cdp_render.mjs` items from the same review.
