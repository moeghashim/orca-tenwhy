import assert from "node:assert/strict";
import test from "node:test";
import { parseReviewerVerdict } from "../../orchestrator/loop_runner.mjs";
import { executorPrompt, reviewerPrompt, validateVerdict } from "./index.mjs";

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

test("validateVerdict coerces Luna's real dry-run notes that omit 1.–5.", () => {
  const rev = reviewerPrompt(VARS);
  assert.match(rev, /five lines/);
  assert.match(rev, /All five exit-gate checks pass/);
  const parsed = parseReviewerVerdict(
    `The research is complete.\n\n\`\`\`json\n{"verdict": "approve", "notes": "All five exit-gate checks pass."}\n\`\`\`\n`,
  );
  assert.equal(parsed.verdict, "approve");
  assert.equal(parsed.notes, "All five exit-gate checks pass.");
  const checked = validateVerdict(parsed);
  assert.equal(checked.verdict, "revise");
  assert.equal(checked.notes, "FORMAT: reviewer notes must enumerate checks 1–5");
});

test("validateVerdict accepts five check-numbered lines and leaves approve", () => {
  const notes = [
    "1. pass — RESEARCH.json matches the schema.",
    "2. pass — five competitors each have a 200 scrape URL.",
    "3. pass — product coverage is 50% with priced 200 sources.",
    "4. pass — three enhancement_ideas have rationale.",
    "5. pass — SOURCES.md lists every scrapes row.",
  ].join("\n");
  const checked = validateVerdict({ verdict: "approve", notes });
  assert.equal(checked.verdict, "approve");
  assert.equal(checked.notes, notes);
});

test("validateVerdict coerces FORMAT:-prefixed approve to revise", () => {
  const checked = validateVerdict({
    verdict: "approve",
    notes: "FORMAT: reviewer notes must enumerate checks 1–5",
  });
  assert.equal(checked.verdict, "revise");
  assert.equal(checked.notes, "FORMAT: reviewer notes must enumerate checks 1–5");
});

test("validateVerdict coerces approve whose numbered lines are only URLs", () => {
  const notes = [1, 2, 3, 4, 5].map((n) => `${n}. https://example.com/check-${n}`).join("\n");
  const checked = validateVerdict({ verdict: "approve", notes });
  assert.equal(checked.verdict, "revise");
  assert.equal(checked.notes, "FORMAT: reviewer notes must enumerate checks 1–5");
});

test("validateVerdict coerces numbered lines that lack a pass/fail token", () => {
  const notes = [1, 2, 3, 4, 5]
    .map((n) => `${n}. schema looks valid extra words here`)
    .join("\n");
  const checked = validateVerdict({ verdict: "approve", notes });
  assert.equal(checked.verdict, "revise");
  assert.equal(checked.notes, "FORMAT: reviewer notes must enumerate checks 1–5");
});

test("validateVerdict coerces numbered lines with fewer than three non-URL words", () => {
  const notes = [1, 2, 3, 4, 5].map((n) => `${n}. pass ok`).join("\n");
  const checked = validateVerdict({ verdict: "approve", notes });
  assert.equal(checked.verdict, "revise");
  assert.equal(checked.notes, "FORMAT: reviewer notes must enumerate checks 1–5");
});
