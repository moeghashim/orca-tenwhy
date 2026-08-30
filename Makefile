.PHONY: verify

# Runs every test that exists so far. Must exit 0.
verify:
	bash system/db/test_schema.sh
