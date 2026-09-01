# tenwhy — graph-of-loops system

System repo for the tenwhy graph-of-loops runtime. The orchestrator mediates a graph of Pi loops (`company-research` → `website`); SQLite in `state/` is the runtime index; per-customer markdown knowledge bases live in generated customer repos.

This repo **is** the system repo (SOP `loop-graph/`). There is no nested `loop-graph/` directory.

## Roster

**Build**

| Role | Agent | Model / effort |
|---|---|---|
| Orchestrator | Claude Code | `claude-fable-5` |
| Executor | Grok | `grok-4.6`, `--effort high` |
| Reviewer | Codex | `gpt-5.6-sol`, `model_reasoning_effort=medium` |

**Runtime (the system being built)**

| Role | Agent | Model / effort / auth |
|---|---|---|
| Orchestrator | Claude CLI | `claude-fable-5`, `--effort high`, OAuth |
| Reviewer | Pi (`openai-codex`) | `gpt-5.6-luna`, `--thinking high`, OAuth |
| Executor | Pi (`xai`) | `grok-4.6` (Pi xai catalog id TBD after `/login xai`), `--thinking high`, OAuth |
| Harness | Pi | `@earendil-works/pi-coding-agent@0.84.1` |

Verified values: `system/config/environment.md`. Loop caps and wiring: `system/config/loops.yaml`.

## Layout

- `system/` — orchestrator, loops, tools, gates, DB schema, config
- `state/` — `orchestrator.db` (gitignored)
- `dashboard/` — ops + customer surfaces (`design/` is authoritative for appearance)
- `templates/customer-repo/` — seed for per-engagement customer repos
- `bin/loopctl` — engagement CLI (`new`, `update`, `approve`)

## Verify

Requires Node ≥ 20, the `sqlite3` CLI, and (for the research grid) bash ≥ 4 plus `jq` to build the `dashboard/vendor/tengrids` submodule. `make verify` runs `make vendor-tengrids` first; that target is a no-op when `packages/core/dist/esm/index.js` is already newer than the submodule HEAD commit.

```bash
make verify
```

`make verify` runs every test that exists so far and must exit 0.
