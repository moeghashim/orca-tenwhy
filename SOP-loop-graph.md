# SOP — Graph-of-Loops System (tenwhy)

**Owner:** Moe Ghashim · **Version:** 1.1 · **Date:** 2026-08-30
**v1.1 changes:** reviewer verdict enum; Lighthouse gate check; deploy moved behind customer approval; new Phase 7 (customer flow + approval state machine); dashboard phase rebound to the delivered design files; comparison-table API shape; `loopctl` accepts idea and/or existing site URL.

**Build roster:** Claude Code (Claude Fable) = build orchestrator · Codex (GPT-5.6 SOL, medium effort) = build reviewer · Grok (latest) = build executor.
**Runtime roster (the system being built):** Claude Fable 5 = loop orchestrator · GPT-5.6 Luna (high effort) = loop reviewer · Grok latest (high effort) = loop executor · Pi = harness for every loop.

---

## 0. Governing principles (non-negotiable)

1. **Mechanical truth.** A task is complete only when its verify command exits 0. Agent self-report is never evidence. No checkmark in PROGRESS.md without pasted verify output.
2. **Orchestrator is the sole writer of loop state.** Loops return results to the orchestrator; only the orchestrator writes loop/engagement rows. The ops dashboard is strictly read-only. The customer flow owns exactly two writes: approve and request-changes (Phase 7).
3. **Pi owns all tools.** Models request tool calls (scrape, file write, deploy); Pi executes them and records provenance. Models never get raw shell access inside loops.
4. **Traceability.** Every loop run stores its Pi trace reference in SQLite. Every markdown knowledge file carries frontmatter with `updated` date and `trace` ref.
5. **Do not invent CLI names, model strings, or flags.** Phase 0 discovers and records the real values. If a value cannot be verified, halt and ask Moe.
6. **Git identity.** All commits/pushes use: `Moe Ghashim <mohanadgh@gmail.com>`.
7. **Design files are authoritative for UI.** `Loop Graph.dc.html`, `Customer Start.dc.html`, `Loop Graph Specs.dc.html`, and `tokens.json` (provided by Moe) define layout, palette, type, status glyphs, and states. Do not restyle. Where a design file and this SOP conflict on *behavior*, this SOP wins; on *appearance*, the design files win.

---

## 1. Architecture summary

- **Graph of loops.** Nodes = loops (Pi processes). The orchestrator (Fable 5) mediates all edges: loops never talk to each other directly. Edge in v1: `company-research → website`. Loops may run in parallel when their inputs are satisfied.
- **Trigger.** A human runs `loopctl new "<idea>" [--url <existing-site>]`. Idea, URL, or both — the start screen and CLI accept either. The orchestrator creates an engagement, provisions a customer repo, and schedules loops.
- **State.** Local SQLite DB (`state/orchestrator.db`) in the system repo. The DB is the runtime index; per-customer markdown knowledge bases are the durable brain.
- **Loop protocol.** Executor (Grok) produces → Reviewer (Luna) issues a verdict `revise | approve | reject | escalate` with notes → up to **4 executor↔reviewer iterations**. Gate script runs only after `approve`. On failure, the loop fails upward; the orchestrator retries with adjusted instructions up to **2 times**, then `needs_human`.
- **Exit gates are structural, not opinions.** Reviewer approval is advisory; the gate script is the exit.
- **Approval before publish.** When the website gate passes, the engagement enters `awaiting_approval`. Deployment to Cloudflare happens **only after** the customer approves (Phase 7). `Request changes` feeds customer notes back as adjusted instructions; customer change requests do **not** consume the 2 orchestrator retries (tracked separately).
- **Repos.** One **system repo** (this build: `orca-tenwhy` conventions apply). One **repo per customer engagement**, created from a template.
- **Cost caps.** None. Effort settings are config values per loop/role, all `high` in v1.
- **Email notification** ("we'll email you" in the mock): out of scope for v1. Omit or feature-flag that copy; never fake it.

---

## 2. Phase 0 — Environment discovery & verification

Record real values into `system/config/environment.md` before any build work. Never guess.

| ID | Task | Verify |
|----|------|--------|
| P0.1 | Pi harness: binary, version, tracing invocation, trace-ref retrieval. | `<pi-binary> --version` exits 0; environment.md contains the tested tracing invocation. |
| P0.2 | Grok CLI (OAuth): binary, "latest" model string, effort flag. | Auth/status exits 0; 1-line smoke prompt returns output. |
| P0.3 | Codex/GPT CLI (OAuth): model strings for **GPT-5.6 Luna** (runtime reviewer) and **GPT-5.6 SOL** (build reviewer), effort flag syntax. | Same as P0.2. |
| P0.4 | Claude CLI (OAuth): model string for **Claude Fable 5**. | Same as P0.2. |
| P0.5 | Scrapling in Pi's Python env incl. browser deps. | `python -c "import scrapling; print(scrapling.__version__)"` exits 0. |
| P0.6 | Stripe Projects CLI plugin authenticated. | Status/whoami exits 0. |
| P0.7 | Cloudflare Pages deploy path (Wrangler or Stripe-Projects-provisioned); record command. | Version command exits 0. |
| P0.8 | Git identity set. | `git config user.name` = `Moe Ghashim`; `git config user.email` = `mohanadgh@gmail.com`. |
| P0.9 | Node ≥ 20, SQLite3 CLI, Lighthouse CLI (`lhci` or `lighthouse`). | All version commands exit 0. |

**Halt rule:** any P0 failure → write the blocker in PROGRESS.md and stop for Moe. Do not stub.

---

## 3. Phase 1 — System repo scaffold & state schema

### 3.1 System repo layout

```
loop-graph/
  README.md
  PROGRESS.md
  system/
    config/ (environment.md, loops.yaml)
    orchestrator/
    loops/ (company-research/, website/)
    tools/ (scrape.py, provision.sh, deploy.sh)
    gates/ (research_gate.py, website_gate.py)
    db/ (schema.sql, migrate.sh)
  state/orchestrator.db          # gitignored
  dashboard/
    server/                      # Node: snapshot + SSE + 2 customer-flow writes
    web/                         # Vite SPA: ops surface + customer surface
    design/                      # the .dc.html mocks + tokens.json (from Moe)
  templates/customer-repo/
  bin/loopctl
```

### 3.2 SQLite schema (minimum tables)

```sql
CREATE TABLE engagements (
  id TEXT PRIMARY KEY, customer_name TEXT, idea TEXT, site_url TEXT,
  repo_url TEXT, status TEXT CHECK(status IN
    ('new','running','needs_human','awaiting_approval','complete','failed')),
  created_at TEXT, updated_at TEXT);

CREATE TABLE loop_runs (
  id TEXT PRIMARY KEY, engagement_id TEXT REFERENCES engagements(id),
  loop_name TEXT, attempt INTEGER,             -- orchestrator retry #: 0..2
  change_request_id TEXT,                      -- set when spawned by a customer request
  status TEXT CHECK(status IN
    ('queued','running','gate_passed','gate_failed','needs_human')),
  pi_trace_ref TEXT, adjusted_instructions TEXT,
  started_at TEXT, finished_at TEXT);

CREATE TABLE iterations (
  id TEXT PRIMARY KEY, loop_run_id TEXT REFERENCES loop_runs(id),
  n INTEGER,                                    -- 1..4
  executor_output_path TEXT,
  reviewer_verdict TEXT CHECK(reviewer_verdict IN
    ('revise','approve','reject','escalate')),
  reviewer_notes TEXT, pi_trace_ref TEXT, created_at TEXT);

CREATE TABLE gate_checks (
  id TEXT PRIMARY KEY, loop_run_id TEXT REFERENCES loop_runs(id),
  check_name TEXT, passed INTEGER, detail TEXT, created_at TEXT);

CREATE TABLE scrapes (
  id TEXT PRIMARY KEY, loop_run_id TEXT, url TEXT,
  http_status INTEGER, content_path TEXT, created_at TEXT);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY, engagement_id TEXT REFERENCES engagements(id),
  action TEXT CHECK(action IN ('approve','request_changes')),
  notes TEXT, created_at TEXT);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, engagement_id TEXT,
  loop_run_id TEXT, kind TEXT, payload TEXT, created_at TEXT);
```

| ID | Task | Verify |
|----|------|--------|
| P1.1 | Scaffold layout; init git; push to GitHub under `moeghashim`. | `git ls-remote origin` exits 0. |
| P1.2 | Schema + `migrate.sh`. | Migration lists all 7 tables; inserting an invalid verdict or status fails the CHECK. |
| P1.3 | `loops.yaml`: model strings from environment.md, effort=high, iteration cap=4, retry cap=2. | Lint/load script exits 0 and asserts caps. |

---

## 4. Phase 2 — Pi harness integration & tools

| ID | Task | Verify |
|----|------|--------|
| P2.1 | `tools/scrape.py`: URL → Scrapling → `{url, http_status, content_path}` + `scrapes` row. Guardrails: 1 req/2s per domain, 30s timeout, robots.txt honored, optional allowlist. | Known-good URL yields a row with 200; robots-blocked URL is refused with a recorded refusal. |
| P2.2 | Register `scrape` as a Pi tool for the research loop only. | Pi smoke run shows model requesting `scrape`, structured content returned, trace ref captured. |
| P2.3 | Generic loop runner: executor→reviewer iterations (≤4), reviewer must emit one of the 4 verdicts (non-conforming output = automatic `revise` with a format note), persists iterations + trace refs, runs gate on `approve`, persists gate_checks. | Stub loop completes with all rows present; a malformed-verdict fixture is coerced to `revise`. |

---

## 5. Phase 3 — Orchestrator (Claude Fable 5)

| ID | Task | Verify |
|----|------|--------|
| P3.1 | `loopctl new "<idea>" [--url <site>]` creates engagement (idea and/or site_url), generates customer repo from template, pushes. | Row exists with the given fields; `git ls-remote` on new repo exits 0. |
| P3.2 | Scheduler: research first; on `gate_passed`, hand research outputs to website loop. Parallelism for loops with no unmet edges. | Stub integration test shows ordering + recorded handoff payload. |
| P3.3 | Failure policy: `gate_failed` after 4 iterations → adjusted instructions (must cite failed gate_checks + last reviewer notes) → retry; after attempt 2 → `needs_human` + event. | Forced-failure test: attempts 0,1,2 with distinct non-empty instructions, then `needs_human`. |
| P3.4 | Knowledge-base absorption after research `gate_passed` (§8 rules: synthesis rewritten, History appended, frontmatter updated). | Assert frontmatter + appended History; second run appends, never overwrites. |
| P3.5 | `loopctl update <engagement-id>` re-runs research as an update pass. | Two runs yield two dated History entries per touched file. |
| P3.6 | Approval state machine: website `gate_passed` → engagement `awaiting_approval` (no deploy). On `approve` → run deploy step (§7 D-tasks) → `complete`. On `request_changes` → new website loop run with customer notes as adjusted instructions, `change_request_id` set, attempt counter reset (does not consume the 2 orchestrator retries). | State-machine test drives all transitions; deploy step demonstrably not invoked before an `approvals.approve` row exists. |

---

## 6. Phase 4 — Loop 1: Company Research

**Executor:** Grok (high). **Reviewer:** Luna (high) — verdict enum enforced. **Tools:** `scrape` via Pi.

**Inputs:** idea and/or existing site URL; if URL given, the site and product catalog are scraped first.

**Outputs (customer repo):** `research/RESEARCH.json`, `research/SOURCES.md`, `company/` files per §8.

**RESEARCH.json minimum schema:** unchanged from v1.0 —
```json
{
  "company": {"name": "", "summary": "", "customer_products": [{"id": "", "name": "", "price": null, "url": ""}]},
  "competitors": [{"name": "", "url": "", "summary": "", "products": [{"name": "", "price": null, "url": ""}]}],
  "product_matches": [{"customer_product_id": "", "competitor": "", "competitor_product": "", "competitor_price": null, "source_url": ""}],
  "enhancement_ideas": [{"idea": "", "rationale": ""}]
}
```

**Exit gate — `research_gate.py` (ALL must pass):**
1. RESEARCH.json validates against schema.
2. ≥ 5 competitors, each with a source URL that returned HTTP 200 **per the `scrapes` table**.
3. **Product coverage ≥ 25%** of `customer_products` matched, every match with price + 200-verified source URL.
4. ≥ 3 enhancement_ideas with non-empty rationale.
5. SOURCES.md lists every `scrapes` row for this run.

| ID | Task | Verify |
|----|------|--------|
| P4.1 | Executor + reviewer prompts; reviewer critiques against the 5 checks and emits exactly one verdict from the enum. | Dry run: verdict parses; notes reference check numbers. |
| P4.2 | `research_gate.py`. | Fixtures: pass case passes; one fixture per check fails with the right `check_name`. |
| P4.3 | End-to-end research on a real test business (Moe supplies). | `gate_passed` in DB; 5/5 checks; trace refs non-empty. |

---

## 7. Phase 5 — Loop 2: Website (build gate) + Deploy step (post-approval)

**Designer/Reviewer:** Luna (high). **Executor:** Grok. **Stack:** Vite static site. **Deploy:** Cloudflare Pages via Stripe Projects provisioning — **after customer approval only**.

**Outputs (customer repo):** `brand/tokens.json`, `brand/logo.svg`, `brand/BRAND.md`, `brand/IMAGE_BRIEF.md` (assets Moe generates manually; site ships with wired placeholders), `website/` (Vite project), `website/DEPLOY.md` (written by the deploy step).

**Build gate — `website_gate.py` (ALL must pass; runs pre-approval):**
1. tokens.json validates; logo.svg parses as valid SVG.
2. `npm run build` exits 0.
3. 0 broken internal links in `dist/`; every IMAGE_BRIEF asset has a placeholder wired at the declared path.
4. Copy grounded in research: company name + ≥ 3 product names from RESEARCH.json present in `dist/`.
5. **Lighthouse ≥ 85** (performance + accessibility categories) against `vite preview` of `dist/`.

**Deploy step (orchestrator-invoked after `approve`; not part of the loop):**
- D1: `tools/provision.sh` — Stripe Projects provisions hosting for the engagement; credentials synced to Pi env; provisioning record captured.
- D2: `tools/deploy.sh` — publish `dist/` to Cloudflare Pages; write DEPLOY.md; verify live URL returns 200; engagement → `complete`.

| ID | Task | Verify |
|----|------|--------|
| P5.1 | provision.sh. | Throwaway project: record file exists; credentials usable. |
| P5.2 | deploy.sh. | `curl -s -o /dev/null -w "%{http_code}" <url>` prints 200; runs refuse to execute without an `approvals.approve` row. |
| P5.3 | Luna design-spec prompt (tokens + layout + SVG logo + image brief) and Grok build prompt. | Dry run yields all four brand artifacts, schema-valid. |
| P5.4 | `website_gate.py` incl. Lighthouse check. | Fixture per check; a deliberately slow fixture page fails check 5. |
| P5.5 | End-to-end: website build gate passes for the Phase 4 test business; engagement reaches `awaiting_approval`. | DB shows `awaiting_approval`; no DEPLOY.md yet. |
| P5.6 | Approve via customer flow (or `loopctl approve` fallback) → deploy runs → live URL 200 → `complete`. | Status `complete`; curl 200. |

---

## 8. Customer repo template (the "brain")

Unchanged from v1.0:

```
<customer-slug>/
  BRIEF.md
  company/ (OVERVIEW.md, POSITIONING.md, FINDINGS.md, competitors/<slug>.md, products/<slug>.md)
  research/ (RESEARCH.json, SOURCES.md)
  brand/ (tokens.json, logo.svg, BRAND.md, IMAGE_BRIEF.md)
  website/ (Vite project, DEPLOY.md)
```

Frontmatter (`updated`, `trace`) + rewritten synthesis + append-only `## History` on every markdown file. **Note for the dashboard:** the Customers view lists the *actual* filenames present in the repo (do not hardcode names from mocks).

| ID | Task | Verify |
|----|------|--------|
| P8.1 | Template + generator used by P3.1. | Generated repo matches tree; frontmatter lints. |

---

## 9. Phase 6 — Ops dashboard (Surface 1: read-only, live)

Build exactly to the delivered design files (`Loop Graph.dc.html`, `Loop Graph Specs.dc.html`, `tokens.json`): light theme, Geist/Geist Mono, 220px sidebar, four views (Runs, Loop detail, Failures, Customers), the shared status system (glyph + verbatim enum label, one shared module, never a second color set), needs_human banner logic, and the SSE no-reflow contract (fixed row heights, in-place cell patches, flash highlight, re-sort only on reconnect).

**Server:** Node; SQLite opened **read-only for all dashboard endpoints**; `GET /api/snapshot` (full state, incl. comparison tables derived from `product_matches` in `{columns, rows}` shape) + `SSE /api/events` (patches keyed by entity id, driven by the `events` table). The only write endpoints are the two customer-flow actions (Phase 7), on a separate connection.

| ID | Task | Verify |
|----|------|--------|
| P9.1 | Snapshot + SSE server. | Insert an `events` row via sqlite3 → SSE client receives patch < 2s; dashboard connection is read-only (write attempt test fails). |
| P9.2 | Four views per design files; single command `npm run dashboard`. | UI smoke test renders all four views against a seeded DB; status glyphs/labels match the shared module. |
| P9.3 | Live-update + states. | Stub loop run appears without reload; loading/empty/disconnected states render (SSE kill test shows red banner, data labeled snapshot). |
| P9.4 | Comparison table card renders from snapshot `{columns, rows}` for a research run with product_matches. | Seeded fixture renders the table with ✓/⚑ cell states. |

---

## 10. Phase 7 — Customer flow (Surface 2) + approval writes

Build to `Customer Start.dc.html`: start (idea **and/or** site URL input — extend the mock's single URL field per §1), loading (5-step checklist tracking real loop events via SSE), results (Research tab, Website design tab in a neutral browser frame using the customer's brand colors).

**The only writes in the whole front end:**
- `POST /api/engagements/:id/approve` → `approvals` row (`approve`) → orchestrator runs deploy step.
- `POST /api/engagements/:id/request-changes` `{notes}` → `approvals` row → orchestrator spawns a change-request website run (P3.6).

Both endpoints validate that the engagement is `awaiting_approval`; anything else → 409. Email copy omitted (out of scope, §1).

| ID | Task | Verify |
|----|------|--------|
| P10.1 | Start + loading pages wired to `loopctl new` equivalent API + SSE events. | Creating an engagement from the UI produces the same DB rows as the CLI; loading steps advance on stub events. |
| P10.2 | Results tabs rendered from snapshot (research cards + comparison table; website preview served from the build artifact). | Seeded `awaiting_approval` engagement renders both tabs. |
| P10.3 | Approve + request-changes endpoints & buttons. | Approve on an `awaiting_approval` fixture → deploy invoked (stubbed) → `complete`. Request-changes → new loop_run with `change_request_id` + notes as adjusted instructions. Either action on a `running` engagement → 409. |

---

## 11. Progress-tracking contract (build agents)

Unchanged from v1.0, applied to the renumbered task IDs: PROGRESS.md lists every task with status, verify command, **pasted verify output**, commit hash, and `REVIEWED: <task-id> ok` from Codex (GPT-5.6 SOL, medium). Claude Code (Fable) spot-checks by re-running verify commands. Blockers halt work; never stub. Task-sized commits, pushed with the §0.6 identity.

## 12. Final acceptance

`make verify` runs: schema migration on temp DB (incl. CHECK-constraint tests), all gate fixtures, tool unit tests, stub-loop integration, approval state-machine test, dashboard SSE test, customer-flow endpoint tests. **Complete when `make verify` exits 0 AND one real engagement has passed research (P4.3), reached `awaiting_approval` (P5.5), been approved through the customer flow, and deployed with the live URL returning 200 (P5.6).**
