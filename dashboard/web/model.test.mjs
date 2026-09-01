import assert from "node:assert/strict";
import test from "node:test";
import { myjamComparison, myjamResearch } from "./src/research-grid/fixture.js";
import { deltaPct, KIND, researchToGridModel } from "./src/research-grid/model.js";

test("researchToGridModel builds three tabs from the myjam-shaped fixture", () => {
  const research = myjamResearch();
  const comparison = myjamComparison();
  const model = researchToGridModel(research, comparison);
  assert.deepEqual(
    model.tabs.map((t) => t.id),
    ["competitors", "prices", "ideas"],
  );
  const [competitors, prices, ideas] = model.tabs;
  assert.equal(competitors.rows.length, 6);
  assert.equal(prices.rows.length, 14);
  assert.equal(ideas.rows.length, 4);
  assert.equal(competitors.columns[0].title, "name");
  assert.equal(competitors.columns[1].kind, KIND.Uri);
  assert.equal(competitors.rows[0][0].data, "Preserve Co");
  assert.equal(competitors.rows[0][1].kind, KIND.Uri);
  assert.equal(competitors.rows[0][1].data, "https://preserve.example");
  assert.equal(competitors.rows[0][3].kind, KIND.Number);
  assert.equal(competitors.rows[0][3].data, 2);
  for (const row of prices.rows) {
    assert.equal(row[6].kind, KIND.Uri);
    assert.ok(row[6].data.startsWith("https://"), row[6].data);
  }
  assert.equal(ideas.rows[0][0].data, 1);
  assert.equal(ideas.rows[0][1].data, "Lead with tasting notes");
});

test("delta % is (theirs - yours) / yours * 100; missing prices are em dash and sort last", () => {
  assert.equal(deltaPct(4.5, 5), 11.1);
  assert.equal(deltaPct(4.5, 3.9), -13.3);
  assert.equal(deltaPct(null, 5), null);
  assert.equal(deltaPct(4.5, null), null);
  const model = researchToGridModel(myjamResearch(), myjamComparison());
  const prices = model.tabs[1];
  const last = prices.rows.at(-1);
  const lastYour = last[1];
  const lastTheir = last[4];
  assert.ok(lastYour.missing || lastTheir.missing, "rows missing a price sort last");
  assert.equal(lastYour.displayData === "—" || lastTheir.displayData === "—", true);
  const strawberryVsPreserve = prices.rows.find(
    (r) => r[0].data === "Strawberry jam" && r[2].data === "Preserve Co",
  );
  assert.ok(strawberryVsPreserve);
  assert.equal(strawberryVsPreserve[5].data, 11.1);
  assert.equal(strawberryVsPreserve[5].kind, KIND.Number);
});

test("verified flag comes from comparison state; uri cells cover every source", () => {
  const research = myjamResearch();
  const comparison = myjamComparison();
  const prices = researchToGridModel(research, comparison).tabs[1];
  const verified = prices.rows.find((r) => r[2].data === "Preserve Co" && r[3].data === "Strawberry");
  const flagged = prices.rows.find((r) => r[2].data === "Sunday Table" && r[3].data === "Jam");
  assert.equal(verified[7].data, "✓");
  assert.equal(flagged[7].data, "–");
  const sources = new Set(prices.rows.map((r) => r[6].data));
  for (const m of research.product_matches) {
    assert.ok(sources.has(m.source_url), m.source_url);
  }
  for (const cell of prices.rows.flat()) {
    assert.equal(cell.allowOverlay, false);
  }
});
