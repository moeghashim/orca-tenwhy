.PHONY: verify verify-fast

# Runs every test that exists so far. Must exit 0.
verify:
	bash system/db/test_schema.sh
	node system/config/lint_loops.js
	system/tools/.venv/bin/python system/tools/test_scrape.py
	system/tools/.venv/bin/python -m unittest system/gates/test_research_gate.py
	system/tools/.venv/bin/python -m unittest system/gates/test_website_gate.py
	node --test "system/orchestrator/test_*.mjs" "system/loops/*/test_*.mjs" "dashboard/server/*.test.mjs"

# Same as verify, but skip website Lighthouse (gate check 5). The fail_lighthouse
# fixture still runs under `make verify`.
verify-fast:
	bash system/db/test_schema.sh
	node system/config/lint_loops.js
	system/tools/.venv/bin/python system/tools/test_scrape.py
	system/tools/.venv/bin/python -m unittest system/gates/test_research_gate.py
	WEBSITE_GATE_SKIP_LIGHTHOUSE=1 system/tools/.venv/bin/python -m unittest system/gates/test_website_gate.py
	node --test "system/orchestrator/test_*.mjs" "system/loops/*/test_*.mjs" "dashboard/server/*.test.mjs"
