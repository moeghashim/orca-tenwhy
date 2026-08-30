# tenwhy — build prompt for the implementing agent

Build two front-end surfaces for tenwhy, a local AI-agent orchestration system, as a Vite SPA (framework-agnostic components, no UI library). Data comes from `GET /api/snapshot` (REST, full state) plus `SSE /api/events` (patches keyed by entity id). Reference mocks: `Loop Graph.dc.html` (ops dashboard), `Customer Start.dc.html` (customer flow), `Loop Graph Specs.dc.html` (component specs), `tokens.json` (all values below live there — use it verbatim).

## Domain model
- **Engagement**: customer project. Status: `new | running | needs_human | complete | failed`.
- **Loop run**: one loop (`company-research` or `website`) inside an engagement. Attempt 0–2 (orchestrator retries). Status: `queued | running | gate_passed | gate_failed | needs_human`. Every engagement has the two loops in sequence: research → website.
- **Iteration**: one executor↔reviewer round in a loop run, numbered 1–4. Carries reviewer verdict (`revise | approve | reject | escalate`) + notes + a Pi trace link (`pi://trace/<hash>`).
- **Gate check**: named pass/fail checks per loop run (e.g. `competitors≥5`, `product_coverage≥25%`, `deploy_200`, `lighthouse≥85`). Runs after reviewer approval.
- **Scrape**: URL + HTTP status + timestamp provenance rows.
- **Comparison**: research loops that compare items carry a comparison table (columns + rows, e.g. competitor pricing).

## Surface 1 — Loop Graph (ops dashboard, strictly read-only)
Desktop 1440px, **light theme**. Fixed 220px sidebar + scrolling content. Fonts: Geist (UI), Geist Mono (all data: ids, statuses, timestamps, URLs, checks). Tabular numerals everywhere.

**Read-only contract: zero buttons.** Interactions are navigation (row/card click, breadcrumb) and external links (suffix `↗`). Sidebar footer states the contract.

### Palette (light)
Canvas `#f4f4f5`, cards/sidebar `#ffffff`, surface `#fafafa`, borders `#e4e4e7` / `#d4d4d8`, text `#18181b` / `#3f3f46` / `#52525b` / `#71717a` (muted) / `#a1a1aa` (faint). Link `#2563eb`.

### Status system (used identically everywhere: badge, timeline node, gate row, dot)
Color is never alone — always glyph + verbatim lowercase enum label in Geist Mono.
- running `#2563eb` `◔` · passed/complete/gate_passed `#059669` `✓` · failed/gate_failed `#dc2626` `✕` · needs_human `#b45309` `⚑` · queued/new/pending `#71717a` `○` · verdict revise `↺` (blue) · verdict escalate `⚑` (amber)
- Badge: mono 11px, radius 4, tinted bg ≈10% alpha of fg, border ≈28% alpha (needs_human 12%/35%).
- needs_human is the loudest thing on any screen: 4%-alpha amber row tint + a global amber banner ("⚑ N runs need human input → open failures") on every view except Failures. No colored left-edge bars on table rows.

### Navigation
Sidebar: Runs (count of active), Failures (amber count), Customers. Loop detail is a drill-in from any run reference (Runs row, Failures card), breadcrumb back — never a nav item. Banner stack above content: disconnected (red) outranks needs_human (amber).

### Views
1. **Runs (home)**: CSS-grid table, fixed 41px rows, columns: engagement (name + mono id), status badge, active loop, iteration (4 segments 14×4px + `n/4`), attempt (3 dots 6px + `n/2`, amber fill when attempt>0), last event (relative), last note. Row click → loop detail.
2. **Loop detail**: breadcrumb `runs / eng_x / run_x`; header name + badge + meta line (loop, iteration, attempt, last event); loop pipeline strip `01 company-research → 02 website` each with own status, active one highlighted; amber "orchestrator adjusted instructions" callout when attempt>0 (mono, pre-wrap); left card = iteration timeline (numbered 22px node in verdict color, 1px rail, executor summary → "reviewer:" quoted note → Pi trace link, dashed node for in-progress iteration); right cards = gate checklist (glyph + mono name + state, failed rows 6% red tint, `x/n passed` summary) and scrape provenance (mono: status code colored, URL, relative time). Research loops with a comparison render a full-width comparison table card below (30px header row, 33px rows, mono cells, ✓ valid green / ⚑ flagged amber).
3. **Failures**: cards ordered needs_human first, colored left accent, rows: failed check (red chip), reviewer objection (quoted), orchestrator adjustment (mono, amber for needs_human). Card click → loop detail. Empty state is celebratory: `✓ nothing blocked`.
4. **Customers**: 2-col grid of engagement cards: status dot + name + mono id + status, markdown kb file list (`research.md` etc. + relative updated), external links to repo + live site.

### Live behavior (SSE)
- Fixed row heights and fixed column templates; patches change cell content in place — **nothing reflows or reorders while connected** (re-sort only on reconnect/refresh).
- On patch: row bg flashes `rgba(37,99,235,0.09)` easing out ~800ms; last-event timestamp renders link-blue for 2 minutes.
- Relative timestamps (`4s ago`, `14m ago`, `3h ago`, `2d ago`) re-render every 10s.
- Sidebar connection card: green pulsing dot `live · SSE /api/events`; amber `reconnecting · retry n/5 in Ns`; red `disconnected` + close timestamp.
- Every view has loading (skeleton rows at final height, `GET /api/snapshot …` footer), empty (dashed border, gray glyph, one sentence), and disconnected (red global banner, data stays visible labeled as snapshot) states.

## Surface 2 — Customer flow (minimal, friendly, light `#fafafa`)
Centered single column, big Geist headlines, black pill buttons, mascot = black circle with two white rounded-bar eyes (float 4s + blink 5s keyframes).

1. **Start**: "Meet tenwhy" + one-line promise; mascot; white rounded-24 input card (`yourcompany.com`, helper line, black ↑ circle submit; Enter also submits); mono footer `research → review → build → launch · ~20 minutes · nothing published without your ok`.
2. **Loading**: mascot with spinning ring; cycling phase title/sub (reading site → researching market → planning → building → final checks); 5-step checklist (done = filled black ✓ circle, active = spinning border-top circle + "in progress", upcoming at 45% opacity); progress bar with sweep shimmer + `step n of 5`; "you can close this page — we'll email you". Steps track real loop events in production; auto-advances to results.
3. **Results** (two tabs in a pill segmented control, each with actions "Looks right — continue"/"Approve & launch" + "Request changes"):
   - **Research**: plain-language cards — about your business, what we learned (✓ bullets), how your site will win (numbered), competitor table (practice / pricing shown / what they do well / online booking).
   - **Website design**: drafted homepage inside a neutral browser frame (site uses its own brand colors, not tenwhy's), sidebar cards: page checklist + "built from your research — nothing invented" note.

## Build notes
- Components framework-agnostic; render purely from snapshot+SSE state. Ops dashboard dispatches no writes; customer flow's approve/request-changes are its only write actions.
- Inline the status system as one shared module; never derive a second color set.
- Timestamps from server time, not client clock skew.
