.PHONY: verify verify-fast verify-gates-nosandbox

# Runs every test that exists so far. Must exit 0.
verify:
	bash system/db/test_schema.sh
	node system/config/lint_loops.js
	system/tools/.venv/bin/python system/tools/test_scrape.py
	system/tools/.venv/bin/python -m unittest system/gates/test_research_gate.py
	system/tools/.venv/bin/python -m unittest system/gates/test_website_gate.py
	node --test "system/orchestrator/test_*.mjs" "system/loops/*/test_*.mjs" "dashboard/server/*.test.mjs" "dashboard/web/*.test.mjs"
	npx vite build --config dashboard/web/vite.config.js

# Same as verify, but skip website Lighthouse (gate check 5). The fail_lighthouse
# fixture still runs under `make verify`.
verify-fast:
	bash system/db/test_schema.sh
	node system/config/lint_loops.js
	system/tools/.venv/bin/python system/tools/test_scrape.py
	system/tools/.venv/bin/python -m unittest system/gates/test_research_gate.py
	WEBSITE_GATE_SKIP_LIGHTHOUSE=1 TENWHY_DEV=1 system/tools/.venv/bin/python -m unittest system/gates/test_website_gate.py
	node --test "system/orchestrator/test_*.mjs" "system/loops/*/test_*.mjs" "dashboard/server/*.test.mjs" "dashboard/web/*.test.mjs"
	npx vite build --config dashboard/web/vite.config.js

# Codex cannot run sandbox-exec. Dev-only: TENWHY_GATE_NO_SANDBOX is ignored
# unless TENWHY_DEV=1. Orchestrator acceptance remains sandboxed `make verify`.
verify-gates-nosandbox:
	TENWHY_GATE_NO_SANDBOX=1 TENWHY_DEV=1 WEBSITE_GATE_SKIP_LIGHTHOUSE=1 system/tools/.venv/bin/python -m unittest system/gates/test_website_gate.py
