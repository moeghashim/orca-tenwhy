import assert from "node:assert/strict";
import test from "node:test";
import { myjamComparison, myjamResearch } from "./src/research-grid/fixture.js";
import { deltaPct, KIND, researchToGridModel, safeHttpUrl } from "./src/research-grid/model.js";

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

test("Uri cells are only http(s); empty, relative, and unsafe schemes are Text", () => {
  assert.equal(safeHttpUrl(""), null);
  assert.equal(safeHttpUrl(null), null);
  assert.equal(safeHttpUrl("myjam.co.uk/products/x"), null);
  assert.equal(safeHttpUrl("javascript:alert(1)"), null);
  assert.equal(safeHttpUrl("data:text/html,<h1>x</h1>"), null);
  assert.equal(safeHttpUrl("ftp://x"), null);
  assert.equal(safeHttpUrl("https://preserve.example/s"), "https://preserve.example/s");
  assert.equal(safeHttpUrl("http://harbour.example/h"), "http://harbour.example/h");

  const research = {
    company: {
      name: "myjam",
      summary: "",
      customer_products: [{ id: "p", name: "Jam", price: 4.5, url: "javascript:alert(1)" }],
    },
    competitors: [
      { name: "Empty", url: "", summary: "", products: [] },
      { name: "Null", url: null, summary: "", products: [] },
      { name: "Relative", url: "myjam.co.uk/products/x", summary: "", products: [] },
      { name: "Js", url: "javascript:alert(1)", summary: "", products: [] },
      { name: "Data", url: "data:text/html,<h1>x</h1>", summary: "", products: [] },
      { name: "Ftp", url: "ftp://x", summary: "", products: [] },
      { name: "Https", url: "https://ok.example", summary: "", products: [] },
      { name: "Http", url: "http://ok.example", summary: "", products: [] },
    ],
    product_matches: [
      { customer_product_id: "p", competitor: "Empty", competitor_product: "a", competitor_price: 1, source_url: "" },
      { customer_product_id: "p", competitor: "Null", competitor_product: "a", competitor_price: 1, source_url: null },
      { customer_product_id: "p", competitor: "Relative", competitor_product: "a", competitor_price: 1, source_url: "myjam.co.uk/products/x" },
      { customer_product_id: "p", competitor: "Js", competitor_product: "a", competitor_price: 1, source_url: "javascript:alert(1)" },
      { customer_product_id: "p", competitor: "Data", competitor_product: "a", competitor_price: 1, source_url: "data:text/html,<h1>x</h1>" },
      { customer_product_id: "p", competitor: "Ftp", competitor_product: "a", competitor_price: 1, source_url: "ftp://x" },
      { customer_product_id: "p", competitor: "Https", competitor_product: "a", competitor_price: 1, source_url: "https://ok.example/s" },
      { customer_product_id: "p", competitor: "Http", competitor_product: "a", competitor_price: 1, source_url: "http://ok.example/s" },
    ],
    enhancement_ideas: [],
  };
  const comparison = {
    columns: [],
    rows: [
      {
        cells: [
          { value: "Jam" },
          { value: "Https" },
          { value: "a" },
          { value: 1, state: "valid" },
          { value: "https://ok.example/s", state: "valid", href: "https://ok.example/s" },
        ],
      },
    ],
  };
  const model = researchToGridModel(research, comparison);
  const websites = Object.fromEntries(model.tabs[0].rows.map((r) => [r[0].data, r[1]]));
  const sources = Object.fromEntries(model.tabs[1].rows.map((r) => [r[2].data, r[6]]));

  for (const name of ["Empty", "Null"]) {
    assert.equal(websites[name].kind, KIND.Text);
    assert.equal(websites[name].displayData, "—");
    assert.equal(sources[name].kind, KIND.Text);
    assert.equal(sources[name].displayData, "—");
  }
  assert.equal(websites.Relative.kind, KIND.Text);
  assert.equal(websites.Relative.data, "myjam.co.uk/products/x");
  assert.equal(sources.Relative.kind, KIND.Text);
  assert.equal(sources.Relative.data, "myjam.co.uk/products/x");
  assert.equal(websites.Js.kind, KIND.Text);
  assert.equal(websites.Js.data, "javascript:alert(1)");
  assert.equal(sources.Js.kind, KIND.Text);
  assert.equal(sources.Js.data, "javascript:alert(1)");
  assert.equal(websites.Data.kind, KIND.Text);
  assert.equal(websites.Data.data, "data:text/html,<h1>x</h1>");
  assert.equal(sources.Data.kind, KIND.Text);
  assert.equal(sources.Data.data, "data:text/html,<h1>x</h1>");
  assert.equal(websites.Ftp.kind, KIND.Text);
  assert.equal(websites.Ftp.data, "ftp://x");
  assert.equal(sources.Ftp.kind, KIND.Text);
  assert.equal(sources.Ftp.data, "ftp://x");
  assert.equal(websites.Https.kind, KIND.Uri);
  assert.equal(websites.Https.data, "https://ok.example");
  assert.equal(sources.Https.kind, KIND.Uri);
  assert.equal(sources.Https.data, "https://ok.example/s");
  assert.equal(websites.Http.kind, KIND.Uri);
  assert.equal(websites.Http.data, "http://ok.example");
  assert.equal(sources.Http.kind, KIND.Uri);
  assert.equal(sources.Http.data, "http://ok.example/s");

  const verified = model.tabs[1].rows.find((r) => r[2].data === "Https");
  const unverified = model.tabs[1].rows.find((r) => r[2].data === "Http");
  assert.equal(verified[7].data, "✓");
  assert.equal(unverified[7].data, "–");
});
