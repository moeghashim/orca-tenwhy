# PROGRESS — tenwhy graph-of-loops build

Contract (SOP §0.1, §11): a task is ✅ only with pasted verify output that exits 0, a commit hash, and `REVIEWED: <id> ok` from Codex (gpt-5.6-sol, medium). Self-report is never evidence.

Legend: ✅ verified + committed + `REVIEWED ok` · 🟡 verified/committed, review pending or blocker noted · ⛔ blocked on Moe · ⬜ not started

## Blockers for Moe

1. **Pi OAuth logins (P0.1/P0.2 runtime):** run `pi` interactively, then `/login openai-codex` (current token: `refresh_token_reused`) and `/login xai` → *Use a subscription*. No API keys.
2. **P0.7 deviation:** Stripe Projects has no Cloudflare *Pages* service; plan is `cloudflare/workers` static assets via `wrangler deploy`. Confirm.
3. **P4.3 test business:** "Tenwhy" — confirm the site URL to scrape (or idea-only).

## Orchestrator findings queued for Grok (fix in the next dispatch)

Consolidated with Codex's P3 review in `build/briefs/P3-followup.md` (5 items: daemon wiring, inputs→prompts, distinct adjusted instructions per attempt, claim approval before deploy, deterministic repo dir).

- **P3.2 daemon wiring:** `loopctl daemon` → `runDaemon({ intervalMs })` passes no `tickOpts`, so `tick` runs with `runLoop`/`adapters` undefined and would crash on the first queued run. Wire the real `runLoop`, `createPiAdapter`, `createClaudeAdapter`, per-loop `gateRunner` (spawn the gate script from `loops.yaml`), and `absorbResearch` with the Claude model; add a test that `runDaemon` (or its wiring function) resolves every dependency.
- **P3.1 repo dir lookup:** `customerRepoDir` guesses `state/customers/<slugify(customer_name)>` with prefix matching; use the slug recorded in the `engagement.created` event payload (or persist the slug) so collisions (`<slug>-<id>`) resolve deterministically.

## Phase 0 — Environment discovery

Executed directly by the build orchestrator (Claude Code) because the executor/reviewer CLIs had to be verified before they could be dispatched to. Full record: `system/config/environment.md`.

| ID | Status | Verify command → pasted output | Commit | Review |
|---|---|---|---|---|
| P0.1 | 🟡 | `pi --version` → `0.84.4` (exit 0; first read `0.84.1`, pi self-updated during Phase 0 — see environment.md note; loops will run `--offline`). Tested tracing invocation recorded; session file created (`…_01a05496-6602-7bb8-85fb-8d3835cc3318.jsonl`). Model call failed: `OAuth refresh failed for openai-codex … refresh_token_reused` → **blocker 1** | `815fda9`, `28e6e37` | `REVIEWED: P0 ok` (Codex, 2026-08-30, after 28e6e37) |
| P0.2 | 🟡 | `grok models` → `You are logged in with grok.com.` · smoke `grok -p … -m grok-4.6 --effort high --output-format json` → `{"text":"OK","stopReason":"end_turn","sessionId":"01a05496-4c80-7dc3-b4f9-e078f4149026"…}` (exit 0). Grok **inside Pi** (xai subscription OAuth) not yet logged in → **blocker 1** | `815fda9`, `28e6e37` | `REVIEWED: P0 ok` (Codex, 2026-08-30, after 28e6e37) |
| P0.3 | ✅ | `codex login status` → `Logged in using ChatGPT` · `codex exec -m gpt-5.6-sol -c model_reasoning_effort=medium --ephemeral -s read-only -o out.txt "…OK…"` → `OK` (exit 0) · same for `gpt-5.6-luna` → `OK` (exit 0) | `815fda9`, `28e6e37` | `REVIEWED: P0 ok` (Codex, 2026-08-30, after 28e6e37) |
| P0.4 | ✅ | `claude --model claude-fable-5 -p "…OK…" --output-format json` → `"is_error":false,"subtype":"success","canonicalModel":"claude-fable-5"` (exit 0) | `815fda9`, `28e6e37` | `REVIEWED: P0 ok` (Codex, 2026-08-30, after 28e6e37) |
| P0.5 | ✅ | `system/tools/.venv/bin/python -c "import scrapling; print(scrapling.__version__)"` → `0.4.15` (exit 0); `.venv/bin/scrapling install` → exit 0 | `815fda9`, `28e6e37` | `REVIEWED: P0 ok` (Codex, 2026-08-30, after 28e6e37) |
| P0.6 | ✅ | `stripe whoami` → `Account: 10claws, Inc. (acct_1TJah50q5LIoKwph)` (exit 0) · `stripe projects list` → `Projects (3)` (exit 0), plugin v0.36.0 | `815fda9`, `28e6e37` | `REVIEWED: P0 ok` (Codex, 2026-08-30, after 28e6e37) |
| P0.7 | 🟡 | `wrangler --version` → `4.127.1` (exit 0). Deploy path recorded (Workers static assets via Stripe Projects `cloudflare/workers`) → **blocker 2** | `815fda9`, `28e6e37` | `REVIEWED: P0 ok` (Codex, 2026-08-30, after 28e6e37) |
| P0.8 | ✅ | `git config user.name` → `Moe Ghashim` · `git config user.email` → `mohanadgh@gmail.com` | `815fda9`, `28e6e37` | `REVIEWED: P0 ok` (Codex, 2026-08-30, after 28e6e37) |
| P0.9 | ✅ | `node --version` → `v24.15.0` · `sqlite3 --version` → `3.51.0 2025-06-12` · `lighthouse --version` → `13.4.1` (all exit 0) | `815fda9`, `28e6e37` | `REVIEWED: P0 ok` (Codex, 2026-08-30, after 28e6e37) |

## Phase 1 — System repo scaffold & state schema

| ID | Status | Verify command → pasted output | Commit | Review |
|---|---|---|---|---|
| P1.1 | ✅ | `git ls-remote origin; echo exit=$?` → `815fda9056185f5d9de8a5ffd46e11407523be94	HEAD` / `815fda9056185f5d9de8a5ffd46e11407523be94	refs/heads/main` `exit=0`. `find . -path ./node_modules -prune -o -path ./.git -prune -o -type d -print \| sort` includes `./bin` `./dashboard` `./dashboard/design` `./dashboard/server` `./dashboard/web` `./state` `./system` `./system/config` `./system/db` `./system/gates` `./system/loops` `./system/loops/company-research` `./system/loops/website` `./system/orchestrator` `./system/tools` `./templates` `./templates/customer-repo` | `0784e91` | `REVIEWED: P1 ok` (Codex, 2026-08-30, after f8932f8) |
| P1.2 | ✅ | `bash system/db/test_schema.sh; echo exit=$?` → `PASS 1` `PASS 2` `PASS 3` `PASS 4` `PASS 5` `PASS 6` `PASS 7` `exit=0`. `make verify; echo exit=$?` → same 7 PASS, `exit=0`. | `cdd3d69` | `REVIEWED: P1 ok` (Codex, 2026-08-30, after f8932f8) |
| P1.3 | ✅ | `node system/config/lint_loops.js; echo exit=$?` → `loops.yaml ok` `exit=0`. `make verify; echo exit=$?` → `PASS 1`–`PASS 7` then `loops.yaml ok` `exit=0`. | `b2157f9` | `REVIEWED: P1 ok`; executor Pi/xai model id re-verify tracked under P0.1 (Codex, 2026-08-30, after f8932f8) |

## Phase 2 — Pi harness integration & tools

| ID | Status | Verify command → pasted output | Commit | Review |
|---|---|---|---|---|
| P2.1 | ✅ | `system/tools/.venv/bin/python system/tools/test_scrape.py` → `Ran 5 tests in 5.095s` `OK` (exit 0). `make verify; echo exit=$?` → schema PASS 1–7, `loops.yaml ok`, scrape tests `OK`, `make_exit=0`. Real fetch: `system/tools/.venv/bin/python system/tools/scrape.py --url https://example.com --loop-run-id smoke --db /tmp/tenwhy-smoke.db` → `{"url": "https://example.com", "http_status": 200, "content_path": "/Users/moeghashim/orca/projects/orca-tenwhy/state/scrapes/smoke/327c3fda87ce286848a574982ddd0b7c7487f816.json"}` (exit 0). `sqlite3 /tmp/tenwhy-smoke.db "select url,http_status from scrapes"` → `https://example.com\|200`. | `0be304d` | **orchestrator fixes** (Codex P2 review + spot-check): robots 401/403/5xx → refuse `robots_unavailable`; redirects walked hop-by-hop with allowlist/robots/rate-limit re-applied (`redirect_chain` recorded, loop cap 5); robots.txt fetch now inside the per-host rate limit (Codex item 1); `test_scrape.py` → `Ran 11 tests OK`; real `http://github.com/moeghashim/orca-tenwhy` → 200 via 1 hop, `github.com/copilot/` → refused. (robots): `urllib.robotparser` dropped all `User-agent: *` rules after a blank line and ignored `*`/`$` → switched to `protego`; real check `github.com/copilot/` → `refused: robots`, exit 3; `test_scrape.py` → `Ran 6 tests OK`. orchestrator re-ran `make verify` → exit 0; real `scrape.py --url https://example.com` → `{"http_status": 200}` row (2026-08-30); `REVIEWED: P2 ok` (Codex, 2026-08-30, after a0a5cb4 — it ran test_scrape 11/11, node --test 10/10, make verify exit 0 itself) |
| P2.2 | 🟡 | `pi --list-models -e system/loops/company-research/pi-tools.ts --offline` → lists openai-codex models including `gpt-5.6-luna` (exit 0). `pi -e system/loops/company-research/pi-tools.ts --offline -p --no-session --mode json --no-builtin-tools --tools scrape "x"` loaded the extension then failed at the model call: `stopReason":"error"` `refresh_token_reused` (blocker 1). **Pending after Pi logins:** `TENWHY_LOOP_RUN_ID=smoke TENWHY_DB=/tmp/tenwhy-smoke.db PROVIDER=openai-codex MODEL=gpt-5.6-luna SESSION_DIR=/tmp/tenwhy-pi-sessions SESSION_ID=smoke-p22 bash system/loops/company-research/run-pi.sh "Use the scrape tool on https://example.com and reply with the page title only."` Expected: session JSONL has `toolCall` named `scrape`, `toolResult` with title, DB row for example.com. | `0a7f8df` | orchestrator re-ran `make verify` → exit 0; real `scrape.py --url https://example.com` → `{"http_status": 200}` row (2026-08-30); `REVIEWED: P2 ok` (Codex, 2026-08-30) — stays 🟡 until the Pi model call succeeds after Moe's logins |
| P2.3 | ✅ | `node --test system/orchestrator/test_loop_runner.mjs` → 5 pass (A–E), `fail 0` (exit 0). `make verify; echo exit=$?` → schema PASS 1–7, `loops.yaml ok`, scrape tests `OK`, loop-runner 5 pass, `make_exit=0`. | `b16704c` | **orchestrator fixes** (Codex P2 re-review items 2–3): reviewer prompt inlines executor output verbatim (60 kB cap); adapter errors (pi exit≠0 / stream `stopReason: error` / no text) → `loop_run.error` + `needs_human`, never a fake iteration; tests F, G added (`node --test` → 10 pass). orchestrator re-ran `make verify` → exit 0; real `scrape.py --url https://example.com` → `{"http_status": 200}` row (2026-08-30); `REVIEWED: P2 ok` (Codex, 2026-08-30, after a0a5cb4 — it ran test_scrape 11/11, node --test 10/10, make verify exit 0 itself) |

## Phase 3 — Orchestrator

| ID | Status | Verify command → pasted output | Commit | Review |
|---|---|---|---|---|
| P3.1 | 🟡 | `TENWHY_REPO_BACKEND=local TENWHY_DB=/tmp/t.db bin/loopctl new "Boutique dental clinic in Amman" --url https://example.com` → `eng_d106615e` (exit 0). `sqlite3 /tmp/t.db "select id,customer_name,idea,site_url,status,repo_url from engagements"` → `eng_d106615e\|example.com\|Boutique dental clinic in Amman\|https://example.com\|new\|/Users/moeghashim/orca/projects/orca-tenwhy/state/remotes/example-com.git`. `git -C state/customers/example-com ls-remote origin` → `b997c8f70be7f0b595c225bd46594998597ba06e	HEAD` / `refs/heads/main` (exit 0). | `876cd5f` | orchestrator re-ran `make verify` → 16 orchestrator tests + 11 scrape + schema, exit 0; real `TENWHY_REPO_BACKEND=local bin/loopctl new "Boutique dental clinic in Amman" --url https://example.com` → `eng_c9caa361`, row + §8 tree + frontmatter, `git ls-remote origin` exit 0 (2026-08-30). `REVIEWED: P3 issues #r1` (Codex, 2026-08-30): 5 items → `build/briefs/P3-followup.md`; fixes landed `58d3f18` `9db4144` `73ad477` `309e4a4` `81fbc6e` (`make verify` 26 node tests, exit 0); `REVIEWED: P3 issues #r2` (Codex): the five fixes accepted; remaining = tests for d7f20ef items → `P4-fix.md` items 7–9 |
| P3.2 | 🟡 | `node --test system/orchestrator/test_scheduler.mjs` → `✔ research runs first; website queued only after gate_passed; handoff payload matches outputs` · `✔ two root loops from edges run concurrently` `pass 2` `fail 0` (exit 0). | `38b24ec` | orchestrator re-ran `make verify` → 16 orchestrator tests + 11 scrape + schema, exit 0; real `TENWHY_REPO_BACKEND=local bin/loopctl new "Boutique dental clinic in Amman" --url https://example.com` → `eng_c9caa361`, row + §8 tree + frontmatter, `git ls-remote origin` exit 0 (2026-08-30). `REVIEWED: P3 issues #r1` (Codex, 2026-08-30): 5 items → `build/briefs/P3-followup.md`; fixes landed `58d3f18` `9db4144` `73ad477` `309e4a4` `81fbc6e` (`make verify` 26 node tests, exit 0); `REVIEWED: P3 issues #r2` (Codex): the five fixes accepted; remaining = tests for d7f20ef items → `P4-fix.md` items 7–9 |
| P3.3 | 🟡 | `node --test system/orchestrator/test_failure_policy.mjs` → `✔ forced failure: attempts 0,1,2 then needs_human; retries cite checks and notes` `pass 1` `fail 0` (exit 0). | `3c36fbd` | orchestrator re-ran `make verify` → 16 orchestrator tests + 11 scrape + schema, exit 0; real `TENWHY_REPO_BACKEND=local bin/loopctl new "Boutique dental clinic in Amman" --url https://example.com` → `eng_c9caa361`, row + §8 tree + frontmatter, `git ls-remote origin` exit 0 (2026-08-30). `REVIEWED: P3 issues #r1` (Codex, 2026-08-30): 5 items → `build/briefs/P3-followup.md`; fixes landed `58d3f18` `9db4144` `73ad477` `309e4a4` `81fbc6e` (`make verify` 26 node tests, exit 0); `REVIEWED: P3 issues #r2` (Codex): the five fixes accepted; remaining = tests for d7f20ef items → `P4-fix.md` items 7–9 |
| P3.4 | 🟡 | `node --test system/orchestrator/test_knowledge.mjs` → `✔ absorb rewrites synthesis, appends History, never rewrites prior lines` `pass 1` `fail 0` (exit 0). | `5fa8aa9` | orchestrator re-ran `make verify` → 16 orchestrator tests + 11 scrape + schema, exit 0; real `TENWHY_REPO_BACKEND=local bin/loopctl new "Boutique dental clinic in Amman" --url https://example.com` → `eng_c9caa361`, row + §8 tree + frontmatter, `git ls-remote origin` exit 0 (2026-08-30). `REVIEWED: P3 issues #r1` (Codex, 2026-08-30): 5 items → `build/briefs/P3-followup.md`; fixes landed `58d3f18` `9db4144` `73ad477` `309e4a4` `81fbc6e` (`make verify` 26 node tests, exit 0); `REVIEWED: P3 issues #r2` (Codex): the five fixes accepted; remaining = tests for d7f20ef items → `P4-fix.md` items 7–9 |
| P3.5 | 🟡 | `node --test system/orchestrator/test_update.mjs` → `✔ two research passes leave two dated History entries on company/*.md` `pass 1` `fail 0` (exit 0). | `7769c18` | orchestrator re-ran `make verify` → 16 orchestrator tests + 11 scrape + schema, exit 0; real `TENWHY_REPO_BACKEND=local bin/loopctl new "Boutique dental clinic in Amman" --url https://example.com` → `eng_c9caa361`, row + §8 tree + frontmatter, `git ls-remote origin` exit 0 (2026-08-30). `REVIEWED: P3 issues #r1` (Codex, 2026-08-30): 5 items → `build/briefs/P3-followup.md`; fixes landed `58d3f18` `9db4144` `73ad477` `309e4a4` `81fbc6e` (`make verify` 26 node tests, exit 0); `REVIEWED: P3 issues #r2` (Codex): the five fixes accepted; remaining = tests for d7f20ef items → `P4-fix.md` items 7–9 |
| P3.6 | 🟡 | `node --test system/orchestrator/test_approval.mjs` → 3 pass (`awaiting_approval does not deploy; approve deploys once then complete`; `request_changes spawns website run at attempt 0 with change_request_id`; `approve while running → approval.rejected_state, no deploy`) `fail 0` (exit 0). | `b7342c9` | orchestrator re-ran `make verify` → 16 orchestrator tests + 11 scrape + schema, exit 0; real `TENWHY_REPO_BACKEND=local bin/loopctl new "Boutique dental clinic in Amman" --url https://example.com` → `eng_c9caa361`, row + §8 tree + frontmatter, `git ls-remote origin` exit 0 (2026-08-30). `REVIEWED: P3 issues #r1` (Codex, 2026-08-30): 5 items → `build/briefs/P3-followup.md`; fixes landed `58d3f18` `9db4144` `73ad477` `309e4a4` `81fbc6e` (`make verify` 26 node tests, exit 0); `REVIEWED: P3 issues #r2` (Codex): the five fixes accepted; remaining = tests for d7f20ef items → `P4-fix.md` items 7–9 |
## Phase 4 — Loop 1: Company Research

| ID | Status | Verify command → pasted output | Commit | Review |
|---|---|---|---|---|
| P4.1 | 🟡 | `node --test system/loops/company-research/test_prompts.mjs` → 3 pass (templates render; five SOP §6 check strings; fixture reviewer reply parses `approve` with notes referencing `1.`–`5.`) `fail 0` (exit 0). Extra runner test H: no fenced JSON → `revise` `FORMAT:`, reviewer never called. Real dry run blocked on Pi logins (blocker 1). **Pending after login:** `PROVIDER=openai-codex MODEL=gpt-5.6-luna SESSION_DIR=/tmp/tenwhy-pi-sessions SESSION_ID=smoke-p41 bash system/loops/_shared/run-pi-reviewer.sh "<rendered reviewerPrompt>"` against `system/gates/fixtures/research/pass/`; session JSONL must contain **no** `toolCall` entries. | `78e3b3d` | orchestrator: `make verify` at fa43385 (clean worktree) → 20 node + 6 gate + 11 scrape + schema, exit 0; `REVIEWED: P4 issues #r1` (Codex): 6 hardening items + 3 tests (Codex #r2) → `build/briefs/P4-fix.md`; items 1–5 landed `41026d8` `eca06bb` `56cbf09` `d879a0e` `dad5d6f` (`make verify` @dad5d6f in a clean worktree → 27 node + 10 gate, exit 0); 6–9 in progress |
| P4.2 | 🟡 | `system/tools/.venv/bin/python -m unittest system/gates/test_research_gate.py` → `Ran 6 tests in 0.364s` `OK` (exit 0). jsonschema `4.26.0` (`uv pip install --python system/tools/.venv/bin/python jsonschema`). `make verify; echo exit=$?` → schema PASS 1–7, `loops.yaml ok`, scrape 11 OK, research_gate 6 OK, 20 node tests pass, `make_exit=0`. | `fa43385` | orchestrator: `make verify` at fa43385 (clean worktree) → 20 node + 6 gate + 11 scrape + schema, exit 0; `REVIEWED: P4 issues #r1` (Codex): 6 hardening items + 3 tests (Codex #r2) → `build/briefs/P4-fix.md`; items 1–5 landed `41026d8` `eca06bb` `56cbf09` `d879a0e` `dad5d6f` (`make verify` @dad5d6f in a clean worktree → 27 node + 10 gate, exit 0); 6–9 in progress |
| P4.3 | ⬜ | | | |

## Phase 5 — Loop 2: Website + Deploy step

| ID | Status | Verify command → pasted output | Commit | Review |
|---|---|---|---|---|
| P5.1 | ⬜ | | | |
| P5.2 | ⬜ | | | |
| P5.3 | ⬜ | | | |
| P5.4 | ⬜ | | | |
| P5.5 | ⬜ | | | |
| P5.6 | ⬜ | | | |

## §8 — Customer repo template

| ID | Status | Verify command → pasted output | Commit | Review |
|---|---|---|---|---|
| P8.1 | 🟡 | `node --test system/orchestrator/test_customer_repo.mjs` → `✔ generated repo matches §8 tree, lints, and local origin ls-remote exits 0` `pass 1` `fail 0` (exit 0). | `3ee29a1` | orchestrator re-ran `make verify` → 16 orchestrator tests + 11 scrape + schema, exit 0; real `TENWHY_REPO_BACKEND=local bin/loopctl new "Boutique dental clinic in Amman" --url https://example.com` → `eng_c9caa361`, row + §8 tree + frontmatter, `git ls-remote origin` exit 0 (2026-08-30). `REVIEWED: P3 issues #r1` (Codex, 2026-08-30): 5 items → `build/briefs/P3-followup.md`; fixes landed `58d3f18` `9db4144` `73ad477` `309e4a4` `81fbc6e` (`make verify` 26 node tests, exit 0); `REVIEWED: P3 issues #r2` (Codex): the five fixes accepted; remaining = tests for d7f20ef items → `P4-fix.md` items 7–9 |
## Phase 6 — Ops dashboard

| ID | Status | Verify command → pasted output | Commit | Review |
|---|---|---|---|---|
| P9.1 | ⬜ | | | |
| P9.2 | ⬜ | | | |
| P9.3 | ⬜ | | | |
| P9.4 | ⬜ | | | |

## Phase 7 — Customer flow + approval writes

| ID | Status | Verify command → pasted output | Commit | Review |
|---|---|---|---|---|
| P10.1 | ⬜ | | | |
| P10.2 | ⬜ | | | |
| P10.3 | ⬜ | | | |

## Final acceptance (§12)

| Item | Status | Evidence |
|---|---|---|
| `make verify` exits 0 | ⬜ | |
| Real engagement: research gate passed (P4.3) | ⬜ | |
| Reached `awaiting_approval` (P5.5) | ⬜ | |
| Approved via customer flow + live URL 200 (P5.6) | ⬜ | |
