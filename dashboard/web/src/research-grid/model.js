export const KIND = { Text: "text", Number: "number", Uri: "uri" };

function textCell(value) {
  const data = value == null || value === "" ? "—" : String(value);
  return { kind: KIND.Text, allowOverlay: false, readonly: true, displayData: data, data };
}

function numberCell(value, { display } = {}) {
  if (value == null || value === "" || Number.isNaN(Number(value))) {
    return {
      kind: KIND.Number,
      allowOverlay: false,
      readonly: true,
      displayData: "—",
      data: undefined,
      missing: true,
    };
  }
  const n = Number(value);
  return {
    kind: KIND.Number,
    allowOverlay: false,
    readonly: true,
    displayData: display != null ? String(display) : String(n),
    data: n,
  };
}

export function safeHttpUrl(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol === "http:" || u.protocol === "https:") return s;
  } catch {
    /* not an absolute URL */
  }
  return null;
}

function uriCell(url) {
  const safe = safeHttpUrl(url);
  if (!safe) return textCell(url);
  return {
    kind: KIND.Uri,
    allowOverlay: false,
    readonly: true,
    data: safe,
    displayData: safe,
  };
}

function col(title, kind, width) {
  return { title, width, kind };
}

function measure(title, rows, colIndex, min = 72, max = 360) {
  let longest = String(title || "").length;
  for (const row of rows) {
    const cell = row[colIndex];
    const s = cell?.displayData ?? cell?.data ?? "";
    longest = Math.max(longest, String(s).length);
  }
  return Math.min(max, Math.max(min, longest * 8 + 28));
}

function withWidths(columns, rows) {
  return columns.map((c, i) => ({ ...c, width: measure(c.title, rows, i) }));
}

function deltaPct(yours, theirs) {
  if (yours == null || theirs == null) return null;
  const y = Number(yours);
  const t = Number(theirs);
  if (!Number.isFinite(y) || !Number.isFinite(t) || y === 0) return null;
  return Math.round(((t - y) / y) * 1000) / 10;
}

function verifiedFlag(match, yourName, comparison) {
  if (!comparison?.rows) return "–";
  for (const row of comparison.rows) {
    const cells = row.cells || [];
    if (
      (cells[0]?.value ?? "") === (yourName || match.customer_product_id || "") &&
      (cells[1]?.value ?? "") === (match.competitor ?? "") &&
      (cells[2]?.value ?? "") === (match.competitor_product ?? "")
    ) {
      const state = cells[3]?.state || cells[4]?.state;
      return state === "valid" ? "✓" : "–";
    }
  }
  return "–";
}

function competitorsTab(research) {
  const competitors = research?.competitors || [];
  const rows = competitors.map((c) => [
    textCell(c.name),
    uriCell(c.url),
    textCell(c.summary),
    numberCell((c.products || []).length),
  ]);
  const columns = withWidths(
    [
      col("name", KIND.Text),
      col("website", KIND.Uri),
      col("what they do well", KIND.Text),
      col("products found", KIND.Number),
    ],
    rows,
  );
  return { id: "competitors", label: "competitors", columns, rows };
}

function pricesTab(research, comparison) {
  const products = new Map(
    ((research?.company || {}).customer_products || []).map((p) => [p.id, p]),
  );
  const matches = [...(research?.product_matches || [])];
  const priced = [];
  const missing = [];
  for (const m of matches) {
    const yours = products.get(m.customer_product_id);
    const yourPrice = yours?.price;
    const theirPrice = m.competitor_price;
    const hasBoth = yourPrice != null && theirPrice != null && Number.isFinite(Number(yourPrice)) && Number.isFinite(Number(theirPrice));
    (hasBoth ? priced : missing).push({ m, yours, yourPrice, theirPrice });
  }
  const ordered = priced.concat(missing);
  const rows = ordered.map(({ m, yours, yourPrice, theirPrice }) => {
    const yourName = yours?.name || m.customer_product_id || "";
    const delta = deltaPct(yourPrice, theirPrice);
    return [
      textCell(yourName),
      numberCell(yourPrice),
      textCell(m.competitor),
      textCell(m.competitor_product),
      numberCell(theirPrice),
      numberCell(delta, { display: delta == null ? "—" : `${delta}` }),
      uriCell(m.source_url),
      textCell(verifiedFlag(m, yourName, comparison)),
    ];
  });
  const columns = withWidths(
    [
      col("your product", KIND.Text),
      col("your price", KIND.Number),
      col("competitor", KIND.Text),
      col("their product", KIND.Text),
      col("their price", KIND.Number),
      col("delta %", KIND.Number),
      col("source", KIND.Uri),
      col("verified", KIND.Text),
    ],
    rows,
  );
  return { id: "prices", label: "prices", columns, rows };
}

function ideasTab(research) {
  const ideas = research?.enhancement_ideas || [];
  const rows = ideas.map((it, i) => [
    numberCell(i + 1),
    textCell(it.idea),
    textCell(it.rationale),
  ]);
  const columns = withWidths(
    [col("#", KIND.Number), col("idea", KIND.Text), col("rationale", KIND.Text)],
    rows,
  );
  return { id: "ideas", label: "ideas", columns, rows };
}

export function researchToGridModel(research, comparison) {
  return {
    tabs: [competitorsTab(research), pricesTab(research, comparison), ideasTab(research)],
  };
}

export { deltaPct };
