# Follow-up brief — Phase 5 review fixes (do after Phase 6; commits `P5-fix: …`, each with a failing-then-passing test)

Source: orchestrator spot-check + Codex `REVIEWED: P5 … #r1` (items appended below when the verdict lands).

1. **Lighthouse skip is dev-only** (`system/gates/website_gate.py` `lighthouse_check`): `WEBSITE_GATE_SKIP_LIGHTHOUSE=1` currently yields `passed: true`. Honour it **only** when `TENWHY_DEV=1` is also set; otherwise ignore the variable and run Lighthouse. `make verify-fast` sets both. The runner's `gateRunner` (`system/orchestrator/wiring.mjs spawnGate`) must spawn gate scripts with a **scrubbed environment** that never forwards `WEBSITE_GATE_SKIP_LIGHTHOUSE` / `TENWHY_DEV` (test: set both in `process.env`, call `spawnGate` on a stub gate that echoes its env, assert neither key is present).

Finish with `DONE P5-fix <hash…>` — only hashes in `git log`.
