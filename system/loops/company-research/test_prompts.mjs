import assert from "node:assert/strict";
import test from "node:test";
import { parseReviewerVerdict } from "../../orchestrator/loop_runner.mjs";
import { executorPrompt, reviewerPrompt } from "./index.mjs";

const SOP_CHECKS = [
  "RESEARCH.json validates against schema.",
  "≥ 5 competitors, each with a source URL that returned HTTP 200 **per the `scrapes` table**.",
  "**Product coverage ≥ 25%** of `customer_products` matched, every match with price + 200-verified source URL.",
  "≥ 3 enhancement_ideas with non-empty rationale.",
  "SOURCES.md lists every `scrapes` row for this run.",
];

const VARS = {
  idea: "Boutique dental clinic in Amman",
  site_url: "https://example.com",
  customer_name: "Acme Dental",
  adjusted_instructions: "Cite failed check competitors≥5",
  previous_reviewer_notes: "1. schema ok but 2. only four competitors",
  research_json: '{"company":{"name":"Acme Dental"}}',
  sources_md: "| url | http_status | note |\n",
  scrapes_table: "| url | http_status |\n| https://example.com | 200 |",
};

test("executor and reviewer templates render all variables", () => {
  const exec = executorPrompt(VARS);
  assert.match(exec, /Boutique dental clinic in Amman/);
  assert.match(exec, /https:\/\/example.com/);
  assert.match(exec, /Acme Dental/);
  assert.match(exec, /Cite failed check competitors≥5/);
  assert.match(exec, /1\. schema ok but 2\. only four competitors/);
  assert.match(exec, /scrape/);
  const rev = reviewerPrompt(VARS);
  assert.match(rev, /Acme Dental/);
  assert.match(rev, /Boutique dental clinic in Amman/);
  assert.match(rev, /https:\/\/example.com/);
  assert.match(rev, /\{"company":\{"name":"Acme Dental"\}\}/);
  assert.match(rev, /https:\/\/example.com \| 200/);
});

test("reviewerPrompt contains the five SOP §6 check strings", () => {
  const rev = reviewerPrompt(VARS);
  for (const check of SOP_CHECKS) {
    assert.ok(rev.includes(check), `missing check string: ${check}`);
  }
});

test("fixture reviewer reply parses to a valid verdict and notes reference 1.–5.", () => {
  const reply = `Check-by-check:
1. schema is valid.
2. five competitors each have a 200 scrape.
3. coverage is 50% with priced 200 sources.
4. three enhancement ideas have rationale.
5. SOURCES.md lists every scrapes row.

\`\`\`json
{"verdict": "approve", "notes": "1. schema valid. 2. five 200 competitors. 3. coverage 50%. 4. three ideas. 5. sources complete."}
\`\`\`
`;
  const parsed = parseReviewerVerdict(reply);
  assert.equal(parsed.verdict, "approve");
  assert.match(parsed.notes, /1\./);
  assert.match(parsed.notes, /2\./);
  assert.match(parsed.notes, /3\./);
  assert.match(parsed.notes, /4\./);
  assert.match(parsed.notes, /5\./);
});
