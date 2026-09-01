# Environment — Phase 0 discovery record

**Verified:** 2026-08-30 on `Moes-Mac-mini` (Darwin 25.4.0, zsh) by Claude Code (build orchestrator).
**Rule (Moe, 2026-08-30):** every provider is authenticated with a **subscription OAuth login only — never an API key**.
Nothing below is guessed; each value has the command that produced it. Items marked **PENDING** need Moe.

## P0.1 Pi harness

| Field | Value |
|---|---|
| Binary | `/opt/homebrew/bin/pi` (npm `@earendil-works/pi-coding-agent@0.84.4`) |
| Version | `pi --version` → `0.84.4` (exit 0). **Note:** first check at 16:2x read `0.84.1`; pi self-updated to `0.84.4` during Phase 0 (startup network ops). Loop runs must pass `--offline` (or `PI_OFFLINE=1`) so the harness version cannot change mid-engagement; re-record on deliberate upgrades. |
| Non-interactive invocation | `pi -p --mode json --provider <provider> --model <model> --thinking high --no-extensions --no-skills --no-prompt-templates --no-context-files --session-dir <dir> --session-id <uuid> "<prompt>"` |
| Tool control | custom tools via extension file (`pi -e <ext.ts>`, `pi.registerTool({...})`); allowlist with `--tools <names>`; `--no-builtin-tools` keeps only extension tools (this is how `scrape` is exposed to the research loop only) |
| Session / trace | JSONL at `<session-dir>/<cwd-slug>/<ISO-ts>_<session-id>.jsonl`. First line: `{"type":"session","version":3,"id":"<uuid>",...}`. `--session-id` lets the orchestrator pre-assign the id, so **trace ref = `pi://session/<session-id>`** and the file path is stored alongside it in `events.payload`. |
| Tested run | `pi -p --provider openai-codex --model gpt-5.6-luna --thinking high --no-tools --no-extensions --no-skills --no-prompt-templates --no-context-files --session-dir $S/pi-sessions --mode json "Reply with exactly the single word OK and nothing else."` → session file `2026-08-30T21-32-17-794Z_01a05496-6602-7bb8-85fb-8d3835cc3318.jsonl` created; model call failed: `OAuth refresh failed for openai-codex ... "code": "refresh_token_reused"` |
| Credentials (`pi auth check --provider X --json --no-refresh`) | `openai-codex` → `{"status":"ready","authType":"oauth"}` but refresh is broken (above) · `xai` → `credentials_not_configured` · `anthropic` → `credentials_not_configured` (not needed; orchestrator uses the claude CLI, see P0.4) |
| Pi providers for the runtime roster | reviewer Luna → provider `openai-codex`, model `gpt-5.6-luna` (in catalog) · executor Grok → provider `xai` via **subscription OAuth** (`pi` → `/login xai` → *Use a subscription*; docs/providers.md §xAI) — model id in Pi's xai catalog to be read with `pi --list-models grok` after login |
| xai (verified 2026-08-31 03:2x) | `/login xai` done by Moe; `pi --list-models grok` → `xai grok-4.3 / grok-4.5 / grok-4.6 / grok-build-0.1`; **runtime executor id = `grok-4.6`** (matches loops.yaml). Smoke: `pi -p --offline --mode json --provider xai --model grok-4.6 --thinking high --no-tools … --session-dir <dir> --session-id 01a05500-0000-7000-8000-000000000001 "Reply … OK"` → `"stopReason":"stop"`, `"text":"OK"`, `"model":"grok-4.6"` (exit 0). |
| openai-codex (verified 2026-08-31 03:36) | Moe redid `/login openai-codex`; token now expires 2026-09-10; live Luna call → `stopReason: stop`, `text: OK`. (Earlier note: the first attempt did not take: `~/.pi/agent/auth.json` still holds the June token (`expires` 2026-06-04) and a live Luna call returns `refresh_token_reused`. Redo in `pi`: `/login openai-codex` → *ChatGPT Plus/Pro (Codex)* → complete the browser flow; confirm with a live call, not `pi auth check` (which only reports credential presence). |

Risk note: Pi and Codex CLI each hold their own ChatGPT OAuth grant (`~/.pi/agent/auth.json` vs `~/.codex/auth.json`). `refresh_token_reused` means Pi's refresh token was consumed elsewhere (e.g. two Pi processes refreshing at once). The loop runner must serialize Pi starts per provider, or re-login will recur.

## P0.2 Grok CLI (build executor; runtime executor model)

| Field | Value |
|---|---|
| Binary / version | `/Users/moeghashim/.grok/bin/grok`; `grok --version` → `grok 1.0.13 (5e9a58528b76) [stable]` |
| Auth | `grok models` → `You are logged in with grok.com.` (exit 0) — OAuth |
| Models | `grok models` (exit 0) prints `Default model: grok-4.6` and lists `grok-4.6 (default)`, `grok-4.5`. **SOP "latest" = `grok-4.6`**: the CLI default per that command and the model exercised by the smoke below. Usage JSON reports the wire name `grok-4.6-build`. The Pi-side executor model id (runtime) is recorded under P0.1 after `/login xai`. |
| Effort flag | `--reasoning-effort <EFFORT>` (alias `--effort`); `high` accepted |
| Headless invocation | `grok -p "<prompt>" -m grok-4.6 --effort high --output-format json [--json-schema '<schema>'] [--disable-web-search] [--tools <list>] [--permission-mode bypassPermissions] [--cwd <dir>]`; multi-turn via `--resume <sessionId>` |
| Trace | JSON output carries `sessionId` + `requestId`; `grok trace <sessionId> --local --json` exports `$GROK_HOME/trace-exports/<id>.tar.gz` |
| Smoke | `grok -p "Reply with exactly the single word OK and nothing else." -m grok-4.6 --effort high --output-format json --disable-web-search` → `{"text":"OK","stopReason":"end_turn","sessionId":"01a05496-4c80-7dc3-b4f9-e078f4149026",...,"modelUsage":{"grok-4.6-build":{...}}}` (exit 0) |

## P0.3 Codex CLI (build reviewer SOL; runtime reviewer Luna runs inside Pi)

| Field | Value |
|---|---|
| Binary / version | `/opt/homebrew/bin/codex`; `codex --version` → `codex-cli 0.144.1` |
| Auth | `codex login status` → `Logged in using ChatGPT` (OAuth) |
| Model strings | **`gpt-5.6-sol`** (build reviewer), **`gpt-5.6-luna`** (runtime reviewer). Same ids appear in Pi's `openai-codex` catalog (`pi --list-models` → `gpt-5.6-luna`, `gpt-5.6-sol`, also `gpt-5.6-terra`, `gpt-5.5`, `gpt-5.4`). |
| Effort syntax | `-c model_reasoning_effort=<low\|medium\|high\|xhigh>` |
| Non-interactive | `codex exec -m gpt-5.6-sol -c model_reasoning_effort=medium -s read-only [--ephemeral] [-C <dir>] [--skip-git-repo-check] -o <last-message-file> "<prompt>"` |
| Smoke | both models with `--ephemeral -s read-only` → last message `OK`, exit 0 (SOL 16,789 tokens; Luna 6,638 tokens) |
| Caveat | `~/.codex/config.toml` defaults to `model = "gpt-5.3-codex-spark"`, `model_reasoning_effort = "xhigh"` — always pass `-m` and `-c model_reasoning_effort` explicitly. |

## P0.4 Claude CLI (build + runtime orchestrator)

| Field | Value |
|---|---|
| Binary / version | `/Users/moeghashim/.local/bin/claude`; `claude --version` → `2.1.251 (Claude Code)` |
| Model string | **`claude-fable-5`** |
| Effort flag | `--effort <low\|medium\|high\|xhigh\|max>` |
| Non-interactive | `claude -p --model claude-fable-5 --effort high --output-format json "<prompt>"` |
| Smoke | `claude --model claude-fable-5 -p "Reply with exactly the single word OK and nothing else." --output-format json` → `"is_error":false,"subtype":"success","session_id":"9def0b90-ec28-422d-9aeb-ea1782312dde"`, `modelUsage.claude-fable-5.canonicalModel = "claude-fable-5"` (exit 0) |

## P0.5 Scrapling (Pi's Python env)

| Field | Value |
|---|---|
| Env | `system/tools/.venv` (gitignored), created with `uv venv --python 3.12 .venv` (uv 0.10.1; system python is 3.9.6 — not used) |
| Install | `uv pip install --python .venv/bin/python "scrapling[fetchers]"` then `.venv/bin/scrapling install` (browser deps) → exit 0 |
| Verify | `system/tools/.venv/bin/python -c "import scrapling; print(scrapling.__version__)"` → `0.4.15` (exit 0) |
| robots.txt parser | `protego` 0.6.2 (Scrapling dependency; `python -c "import importlib.metadata as m; print(m.version('protego'))"` → `0.6.2`). Chosen over `urllib.robotparser`, which drops every rule after a blank line following `User-agent: *` and ignores `*`/`$` wildcards — verified 2026-08-30 against github.com/robots.txt (`/copilot/` wrongly allowed). |

## P0.6 Stripe Projects

| Field | Value |
|---|---|
| CLI | `stripe version` → `1.42.13` |
| Auth | `stripe whoami` → `Account: 10claws, Inc. (acct_1TJah50q5LIoKwph)`, `Test mode key: available (expires 2026-11-28)` (exit 0) — Moe re-ran `stripe login` 2026-08-30 |
| Plugin | `stripe plugin install projects` → `v0.36.0`; `stripe projects list` → 3 projects (exit 0) |
| Scripting flags (**from `stripe projects add --help` only — not executed yet**; first real run is P5.1 against a throwaway project) | `stripe projects add <provider/service> --json --non-interactive --accept-tos [--name <n>] [--config '<json>'] [--confirm-paid-service]`; env via `stripe projects env ...` / `stripe projects pull <projectId>` |

## P0.7 Cloudflare deploy path

| Field | Value |
|---|---|
| Wrangler | `wrangler --version` → `4.127.1` (global npm) |
| Stripe Projects catalog | `stripe projects catalog cloudflare` → services: browser-run, containers, d1, hyperdrive, kv, queues, r2:bucket, registrar:domain, **workers** (free tier), workers-ai. **No `pages` service exists.** |
| Chosen path (**proposed — unexecuted until P5.1/P5.2**, where real output gets pasted) | Stripe Projects provisions **`cloudflare/workers`** (`stripe projects add cloudflare/workers --json --non-interactive --accept-tos`), credentials land in the project env; `wrangler deploy` publishes `website/dist/` as **Workers static assets** (`wrangler.toml` `[assets] directory = "dist"`). Exact env var names get recorded at P5.1 with the throwaway project. |
| **P5.1 throwaway (2026-08-31)** | `system/tools/provision.sh eng_p51_throwaway p51-throwaway` → exit 0. Record `state/provision/eng_p51_throwaway.json` (names only). Stripe project `tenwhy-p51-throwaway` (`project_61VJoniI5q2pVSTXd16USyeR0wSQFQxSjdH6rCSY4GpE`). Init flags from `stripe projects init --help`: `--json --yes --accept-tos --skip-skills --mode manual --non-interactive`. CLI add preflight required `stripe projects link cloudflare` (returned `already_linked`) then `stripe projects add cloudflare/workers:free` (PLAN_REQUIRED remedy) then `stripe projects add cloudflare/workers --json --non-interactive --accept-tos --name site`. `stripe projects env show --json` → active env `default`, output `.env`. **Env var names (never values):** `CLOUDFLARE_PLAN_ACCOUNT_ID`, `CLOUDFLARE_PLAN_API_TOKEN`, `SITE_ACCOUNT_ID`, `SITE_API_BASE_URL`, `SITE_API_TOKEN`, `SITE_DASHBOARD_URL`, `SITE_PLAN_SERVICE_ID`, `SITE_WORKERS_DEV_SUBDOMAIN`. Wrangler consumes `SITE_API_TOKEN` as `CLOUDFLARE_API_TOKEN` and `SITE_ACCOUNT_ID` as `CLOUDFLARE_ACCOUNT_ID` via the child environment only. |
| **Decision (Moe, 2026-08-31)** | **Option A — Cloudflare Workers static assets provisioned via Stripe Projects** (`stripe projects add cloudflare/workers` → `wrangler deploy --assets dist`). Option B (Pages via `wrangler login` OAuth to Moe's own Cloudflare account) stays documented as the fallback. |
| Options (verified against `wrangler deploy --help` / `wrangler --help`, 4.127.1) | **A — Workers static assets via Stripe Projects** (SOP §7 literal "Stripe Projects provisioning"): `stripe projects add cloudflare/workers` → credentials in the project env → `wrangler deploy --assets dist --name tenwhy-<slug>`. **B — Cloudflare Pages via Moe's own Cloudflare account**: `wrangler login` (browser OAuth — no API key, consistent with the OAuth-only rule) → `wrangler pages deploy dist --project-name tenwhy-<slug>`; matches the SOP's "Pages" wording but bypasses Stripe Projects provisioning (P5.1 would record the Cloudflare account instead). Either way `deploy.sh` still refuses without an `approvals.approve` row. |

## P0.8 Git identity ✓

`git config user.name` → `Moe Ghashim` · `git config user.email` → `mohanadgh@gmail.com`. GitHub: `gh auth status` → logged in as `moeghashim`; `origin` = `https://github.com/moeghashim/orca-tenwhy`.

## P0.9 Node / SQLite / Lighthouse ✓

`node --version` → `v24.15.0` · `sqlite3 --version` → `3.51.0` · `lighthouse --version` → `13.4.1` (global npm; Chrome present at `/Applications/Google Chrome.app`).

## Other

- Stripe agent skills installed at Moe's request: `npx skills add https://docs.stripe.com -y` → `.agents/skills/{stripe-projects,stripe-docs,stripe-directory,stripe-best-practices,stripe-apps,upgrade-stripe,connect-*}` with per-agent symlink dirs (`.claude/`, `.grok/`, `.pi/`, `skills/`, …) and `skills-lock.json`.
- Design files moved from `ClaudeCodeDesign/` to `dashboard/design/` (SOP §3.1).

## Addendum (2026-08-30) — build sandbox for the website gate

`/usr/bin/sandbox-exec` (macOS, present). Verified deny-list profile shape: `(allow default)` + `(deny file-write*)` with `(allow file-write* (subpath "<temp>") …)` + `(deny file-read* (subpath "/Users/moeghashim"))` + `(deny network*)`; a loopback-only variant adds `(allow network* (local ip "localhost:*"))` `(allow network* (remote ip "localhost:*"))`. Tested: write inside temp → ok; write `/tmp/x` → `Operation not permitted`; `head ~/.gitconfig` → denied; Node `readFileSync(~/.gitconfig)` → `EPERM`; `curl https://example.com` → exit 6 (no network); loopback variant → `127.0.0.1` 200, external 000; `node -e` runs (v24.15.0). The sandboxed process must `cd` into the temp tree first (cwd under `$HOME` triggers a harmless `getcwd` warning). Used by P5-fix item 2e.

**Lighthouse under sandbox-exec (verified 2026-08-30):** `system/gates/sandbox/lighthouse.verified-example.sb` — Chrome + Lighthouse run and score (`performance 1.0`, `accessibility 0.93`) with writes confined to the temp tree + realpath user temp dir + Chrome's Crashpad dir, `$HOME` reads denied except `Library/Preferences` and the Crashpad dir, and network denied except local Unix sockets and the two loopback ports. A page fetching another loopback port produced no request on that port.

## Addendum 2026-09-01 — tengrids (research grid)

Decision (Moe): render the research output as a data grid using his fork **tengrids** (`https://github.com/moeghashim/tengrids`, a fork of Glide Data Grid, packages still named `@glideapps/glide-data-grid` 6.0.4-alpha25), on both the customer results tab and the dashboard run page; packaged as a **git submodule** `dashboard/vendor/tengrids` pinned to `bdec072` with a build step.

Verified on this machine:
- `brew install bash` → `/opt/homebrew/bin/bash --version` → `GNU bash, version 5.3.15(1)-release` (tengrids' `build.sh` needs bash ≥4; macOS ships 3.2). `jq --version` → `jq-1.8.1`.
- In the submodule: `npm ci` → 5 s (469 MB node_modules, gitignored there); `npm run build -w packages/core` → 4 s → `packages/core/dist/{esm,cjs,dts}/` + `dist/index.css`. Submodule working tree stays clean after build.
- Resolution spike: root `npm install --no-save react@19 react-dom@19 lodash@4 marked@16 react-responsive-carousel@3 file:dashboard/vendor/tengrids/packages/core` symlinks `node_modules/@glideapps/glide-data-grid` to the submodule package; a Vite entry importing `DataEditor`, `GridCellKind` and `dist/index.css` builds (`✓ built in 179ms`, main chunk 498 kB / 159 kB gzip). Spike removed; P11 wires these as real dependencies and `make vendor-tengrids` (skipped when `packages/core/dist/esm/index.js` is newer than the submodule HEAD commit).
- Tests in tengrids use `vitest-canvas-mock`; our dashboard tests are plain `node --test` + jsdom (no canvas, no JSX loader) → grid *model* is unit-tested; mounting is smoke-tested with a stubbed `HTMLCanvasElement.prototype.getContext` + `ResizeObserver`. `ResearchGrid.js` uses `createElement` (no JSX). Nested React copies under the submodule are removed by `dashboard/tools/dedupe_react.mjs` (root `postinstall` after `npm ci`/`npm install`, and `make vendor-tengrids` after the submodule build) so Node resolves the root `react` / `react-dom`.
- Vite **must** `resolve.dedupe` `react` and `react-dom`: the submodule's `npm ci` installs React 19.1.1 under `dashboard/vendor/tengrids/node_modules`, and without dedupe the linked package resolves that copy while the app uses root React → `TypeError: Cannot read properties of null (reading 'useMemo')` and an empty grid (0 canvases). With dedupe the grid paints.
- `make verify` / `make verify-fast` depend on `vendor-tengrids`, the dashboard `vite build` (includes fixture `dashboard/web/render-check.html`, not linked from production nav), and `grid-render-check` (node:http serves `dist/` then `dashboard/tools/cdp_render.mjs` against four grids — competitors/prices/ideas customer + dashboard `.card`; Chrome at `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`). Tengrids `build.sh` needs `/opt/homebrew/bin/bash` (5.3) on PATH ahead of macOS 3.2.
