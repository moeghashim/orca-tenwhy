.PHONY: verify verify-fast verify-gates-nosandbox vendor-tengrids grid-render-check

TENGRIDS := dashboard/vendor/tengrids
TENGRIDS_DIST := $(TENGRIDS)/packages/core/dist/esm/index.js

# Build tengrids (Glide Data Grid fork) unless dist is already newer than the
# submodule HEAD commit. Needs bash ≥4 (Homebrew) and jq; see environment.md.
vendor-tengrids:
	git submodule update --init dashboard/vendor/tengrids
	@dist="$(TENGRIDS_DIST)"; \
	if [ -f "$$dist" ]; then \
	  commit_ts=$$(git -C dashboard/vendor/tengrids log -1 --format=%ct); \
	  dist_ts=$$(stat -f %m "$$dist" 2>/dev/null || stat -c %Y "$$dist"); \
	  if [ "$$dist_ts" -ge "$$commit_ts" ]; then echo "vendor-tengrids: dist up to date, skip"; exit 0; fi; \
	fi; \
	cd dashboard/vendor/tengrids && \
	  PATH="/opt/homebrew/bin:$$PATH" npm ci && \
	  PATH="/opt/homebrew/bin:$$PATH" npm run build -w packages/core

# Runs every test that exists so far. Must exit 0.
verify: vendor-tengrids
	bash system/tools/check_commit_identity.sh
	bash system/db/test_schema.sh
	node system/config/lint_loops.js
	system/tools/.venv/bin/python system/tools/test_scrape.py
	system/tools/.venv/bin/python -m unittest system/gates/test_research_gate.py
	system/tools/.venv/bin/python -m unittest system/gates/test_website_gate.py
	node --import ./dashboard/web/jsx-register.mjs --test "system/orchestrator/test_*.mjs" "system/loops/*/test_*.mjs" "dashboard/server/*.test.mjs" "dashboard/web/*.test.mjs"
	$(MAKE) grid-render-check

# Same as verify, but skip website Lighthouse (gate check 5). The fail_lighthouse
# fixture still runs under `make verify`.
verify-fast: vendor-tengrids
	bash system/db/test_schema.sh
	node system/config/lint_loops.js
	system/tools/.venv/bin/python system/tools/test_scrape.py
	system/tools/.venv/bin/python -m unittest system/gates/test_research_gate.py
	WEBSITE_GATE_SKIP_LIGHTHOUSE=1 TENWHY_DEV=1 system/tools/.venv/bin/python -m unittest system/gates/test_website_gate.py
	node --import ./dashboard/web/jsx-register.mjs --test "system/orchestrator/test_*.mjs" "system/loops/*/test_*.mjs" "dashboard/server/*.test.mjs" "dashboard/web/*.test.mjs"
	$(MAKE) grid-render-check

# Headless Chrome proof that the research grid paints. vite-builds the
# render-check fixture (not linked from production nav), serves dist/ on a
# free localhost port, then probes canvases via cdp_render.mjs.
grid-render-check:
	npx vite build --config dashboard/web/vite.config.js
	node dashboard/tools/grid_render_check.mjs

# Codex cannot run sandbox-exec. Dev-only: TENWHY_GATE_NO_SANDBOX is ignored
# unless TENWHY_DEV=1. Orchestrator acceptance remains sandboxed `make verify`.
verify-gates-nosandbox:
	TENWHY_GATE_NO_SANDBOX=1 TENWHY_DEV=1 WEBSITE_GATE_SKIP_LIGHTHOUSE=1 system/tools/.venv/bin/python -m unittest system/gates/test_website_gate.py
