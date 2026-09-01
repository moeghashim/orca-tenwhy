# P11-fix — research grid: three defects found in the live render (orchestrator, 2026-09-01)

Executor: Grok CLI. Reviewer: Codex. Orchestrator: Claude Code. Read this file as it is now.

The orchestrator rendered both surfaces with `dashboard/tools/cdp_render.mjs` against the live
myjam.co.uk engagement (`eng_85db6740`). The grid mounts on both (5 canvases, no page error) and the
customer "Your competitors" grid looks right. Three defects:

## 1. Dashboard: the tab strip is invisible
`dashboard/web/src/style.css:141` has `button { display: none !important; }` (the console is read-only
by design). The grid's tab buttons are hidden by that rule, leaving an empty `.pills` container (renders
as a small empty circle above the grid). Fix: scope the rule so view-only controls survive —
`button:not([data-grid-tab]) { display: none !important; }` — and add a comment saying why. Add a test in
`dashboard/web/live.test.mjs` that the three `[data-grid-tab]` buttons exist inside the research grid card
on a company-research run page and that clicking `[data-grid-tab="prices"]` switches the rendered tab
(assert on the column header text of the model, not on canvas pixels).

## 2. Dashboard: the grid card is buried
It is appended after the timeline + scrape-provenance columns (`cols`), i.e. below ~100 scrape rows.
Move the `data-research-grid-card` card to sit **directly after the pipeline chips / adjusted-instructions
block and before `cols`** on company-research runs, in both `renderRunDetail` and the patch path (the
patch path must keep updating the same island via `update()`, never remount). Card title stays "research grid".

## 3. Customer page: an unstyled "competitor comparison" text block below the grid
`renderComparison(comparison)` has been appended on the customer results since P10.2 (`105d32f`), but the
`.cmp-table` styles only exist in the dashboard CSS, so it renders as raw text. The new **prices** tab shows
the same data with verified-source flags, so remove the comparison block from the customer results
(keep `renderComparison` for the dashboard). Remove/adjust any customer test that expected it.

## 4. Render check covers every tab and both surfaces
`dashboard/web/render-check.html` (item 9 of P11) must mount **three** grids — one per tab, via an
`initialTab` prop on `mountResearchGrid`/`ResearchGrid` — for the customer variant, and one grid for the
dashboard variant inside a `.card` with the dashboard stylesheet loaded, so the `button` rule is exercised.
`make verify` fails if any page error is captured or fewer than 4 grids (≥ 4 × canvases) render.

## Rules
One or more commits, subjects starting `P11-fix:`; `make verify` exit 0; paste the summary lines and
`git log -1 --format=%h` in DONE. Commit as `Moe Ghashim <mohanadgh@gmail.com>`; push to `origin main`.
Do not touch `system/loops/`, `system/gates/`, or the submodule.
