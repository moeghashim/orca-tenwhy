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
| **PENDING Moe** | run `pi` interactively: `/login openai-codex` (re-auth, fixes refresh_token_reused) and `/login xai` → *Use a subscription*. Then re-run the tested run above and record `stopReason":"stop"`. |

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
| **Deviation to confirm** | SOP says "Cloudflare Pages"; Workers static assets is Cloudflare's successor to Pages and the only hosting service Stripe Projects offers for Cloudflare. **PENDING Moe: confirm.** |

## P0.8 Git identity ✓

`git config user.name` → `Moe Ghashim` · `git config user.email` → `mohanadgh@gmail.com`. GitHub: `gh auth status` → logged in as `moeghashim`; `origin` = `https://github.com/moeghashim/orca-tenwhy`.

## P0.9 Node / SQLite / Lighthouse ✓

`node --version` → `v24.15.0` · `sqlite3 --version` → `3.51.0` · `lighthouse --version` → `13.4.1` (global npm; Chrome present at `/Applications/Google Chrome.app`).

## Other

- Stripe agent skills installed at Moe's request: `npx skills add https://docs.stripe.com -y` → `.agents/skills/{stripe-projects,stripe-docs,stripe-directory,stripe-best-practices,stripe-apps,upgrade-stripe,connect-*}` with per-agent symlink dirs (`.claude/`, `.grok/`, `.pi/`, `skills/`, …) and `skills-lock.json`.
- Design files moved from `ClaudeCodeDesign/` to `dashboard/design/` (SOP §3.1).
