.PHONY: verify

# Runs every test that exists so far. Must exit 0.
verify:
	bash system/db/test_schema.sh
	node system/config/lint_loops.js
	system/tools/.venv/bin/python system/tools/test_scrape.py
	system/tools/.venv/bin/python -m unittest system/gates/test_research_gate.py
	node --test "system/orchestrator/test_*.mjs" "system/loops/*/test_*.mjs"
