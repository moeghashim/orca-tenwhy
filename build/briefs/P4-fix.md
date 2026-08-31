# Follow-up brief — Phase 4 review fixes (Codex `REVIEWED: P4 issues #r1`, 2026-08-30)

Do after the P3-followup items. Same rules; commits prefixed `P4-fix:`; each fix needs a failing-then-passing test (gate fixtures under `system/gates/fixtures/research/`).

1. **Distinct competitors** (`research_gate.py` check 2): five copies of one verified competitor must not pass. Count competitors by distinct normalised `url` (scheme+host+path, trailing slash stripped) **and** distinct `name` (case-insensitive); duplicates are listed in `detail`. Fixture `fail_competitors_dup`.
2. **Unknown `customer_product_id`** (check 3): already specified as P3-followup item 10 — if not yet done, do it here (`fail_coverage_unknown_id`). Also require `customer_products[].id` to be unique (schema `uniqueItems` on ids or a check-3 detail).
3. **Every URL is verified** (new sub-rule of check 2/3, or a sixth detail line inside check 1? — keep the SOP's five checks): every **non-empty** `url` anywhere in `RESEARCH.json` (`company.customer_products[].url`, `competitors[].url`, `competitors[].products[].url`, `product_matches[].source_url`) must have a `scrapes` row for this run with `http_status = 200`; report violations under check 2 (`competitors≥5`) for competitor-side URLs and under check 3 for product-side URLs. Fixture `fail_fabricated_nested_url`.
4. **Finite numeric prices**: load JSON with `json.loads(..., parse_constant=<raise>)` so `NaN`/`Infinity` fail check 1 (`schema_valid`, detail `non-standard JSON constant`); `is_number` must also reject non-finite floats. Fixture `fail_schema_nan`.
5. **JSON fence must end the message** (`materialize.mjs`): after the last fenced JSON block only whitespace may follow; any trailing prose or another fence → `{ ok: false, error: "JSON fence must be the last content of the message" }` (runner then records `revise` + `FORMAT:`). Runner test in `test_loop_runner.mjs` or `test_prompts.mjs`.
6. **Realpath containment** (`materialize.mjs`): resolve `workdir` and the target `research/` dir with `fs.realpathSync` (creating `research/` first if absent); refuse to write when the realpath of `research/` is outside the realpath of `workdir` (symlink escape) → `{ ok: false, error }`. Test with a symlinked `research/` pointing outside the temp workdir.

Finish with `DONE P4-fix <hash…>` — only hashes in `git log`.
