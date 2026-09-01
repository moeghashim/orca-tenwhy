/** myjam-shaped research: 6 competitors, 14 product matches, 4 ideas. */
export function myjamResearch() {
  const customer_products = [
    { id: "cp_jam", name: "Strawberry jam", price: 4.5, url: "https://myjam.example/jam" },
    { id: "cp_marm", name: "Marmalade", price: 4.2, url: "https://myjam.example/marmalade" },
    { id: "cp_honey", name: "Honey", price: 6, url: "https://myjam.example/honey" },
    { id: "cp_chut", name: "Chutney", price: null, url: "https://myjam.example/chutney" },
  ];
  const competitors = [
    { name: "Preserve Co", url: "https://preserve.example", summary: "Small-batch jars", products: [{ name: "Strawberry", price: 5, url: "https://preserve.example/s" }, { name: "Marmalade", price: 4.8, url: "https://preserve.example/m" }] },
    { name: "Orchard Pantry", url: "https://orchard.example", summary: "Farm-shop spreads", products: [{ name: "Berry jam", price: 3.9, url: "https://orchard.example/b" }] },
    { name: "Harbour Kitchen", url: "https://harbour.example", summary: "Coastal breakfasts", products: [{ name: "Honey", price: 7.5, url: "https://harbour.example/h" }, { name: "Jam", price: 4.6, url: "https://harbour.example/j" }] },
    { name: "Green Lane Deli", url: "https://greenlane.example", summary: "Deli counter preserves", products: [{ name: "Chutney", price: 3.2, url: "https://greenlane.example/c" }] },
    { name: "Bee & Bramble", url: "https://beebramble.example", summary: "Honey-led range", products: [{ name: "Wild honey", price: 8, url: "https://beebramble.example/w" }, { name: "Strawberry", price: 5.2, url: "https://beebramble.example/s" }] },
    { name: "Sunday Table", url: "https://sunday.example", summary: "Brunch pantry", products: [{ name: "Marmalade", price: null, url: "https://sunday.example/m" }] },
  ];
  const product_matches = [
    { customer_product_id: "cp_jam", competitor: "Preserve Co", competitor_product: "Strawberry", competitor_price: 5, source_url: "https://preserve.example/s" },
    { customer_product_id: "cp_marm", competitor: "Preserve Co", competitor_product: "Marmalade", competitor_price: 4.8, source_url: "https://preserve.example/m" },
    { customer_product_id: "cp_jam", competitor: "Orchard Pantry", competitor_product: "Berry jam", competitor_price: 3.9, source_url: "https://orchard.example/b" },
    { customer_product_id: "cp_honey", competitor: "Harbour Kitchen", competitor_product: "Honey", competitor_price: 7.5, source_url: "https://harbour.example/h" },
    { customer_product_id: "cp_jam", competitor: "Harbour Kitchen", competitor_product: "Jam", competitor_price: 4.6, source_url: "https://harbour.example/j" },
    { customer_product_id: "cp_chut", competitor: "Green Lane Deli", competitor_product: "Chutney", competitor_price: 3.2, source_url: "https://greenlane.example/c" },
    { customer_product_id: "cp_honey", competitor: "Bee & Bramble", competitor_product: "Wild honey", competitor_price: 8, source_url: "https://beebramble.example/w" },
    { customer_product_id: "cp_jam", competitor: "Bee & Bramble", competitor_product: "Strawberry", competitor_price: 5.2, source_url: "https://beebramble.example/s" },
    { customer_product_id: "cp_marm", competitor: "Sunday Table", competitor_product: "Marmalade", competitor_price: null, source_url: "https://sunday.example/m" },
    { customer_product_id: "cp_jam", competitor: "Sunday Table", competitor_product: "Jam", competitor_price: 4.1, source_url: "https://sunday.example/j" },
    { customer_product_id: "cp_honey", competitor: "Orchard Pantry", competitor_product: "Honey", competitor_price: 5.5, source_url: "https://orchard.example/h" },
    { customer_product_id: "cp_marm", competitor: "Harbour Kitchen", competitor_product: "Marmalade", competitor_price: 4.4, source_url: "https://harbour.example/m" },
    { customer_product_id: "cp_jam", competitor: "Green Lane Deli", competitor_product: "Strawberry jam", competitor_price: 4.9, source_url: "https://greenlane.example/s" },
    { customer_product_id: "cp_honey", competitor: "Preserve Co", competitor_product: "Honey", competitor_price: 6.8, source_url: "https://preserve.example/h" },
  ];
  const enhancement_ideas = [
    { idea: "Lead with tasting notes", rationale: "Rivals list origin but not flavour." },
    { idea: "Show jar sizes side by side", rationale: "Price comparison is opaque without volume." },
    { idea: "Gift boxes on the home page", rationale: "Harbour Kitchen converts brunch traffic with sets." },
    { idea: "Local delivery cutoff clock", rationale: "Same-day is a gap in all six competitors." },
  ];
  return {
    company: { name: "myjam", summary: "Small-batch jam from a UK kitchen.", customer_products },
    competitors,
    product_matches,
    enhancement_ideas,
  };
}

export function myjamComparison() {
  const research = myjamResearch();
  const products = new Map(research.company.customer_products.map((p) => [p.id, p.name]));
  const ok = new Set([
    "https://preserve.example/s",
    "https://preserve.example/m",
    "https://orchard.example/b",
    "https://harbour.example/h",
  ]);
  const rows = research.product_matches.map((m) => {
    const valid = m.competitor_price != null && Boolean(m.source_url) && ok.has(m.source_url);
    const state = valid ? "valid" : "flagged";
    return {
      cells: [
        { value: products.get(m.customer_product_id) || m.customer_product_id },
        { value: m.competitor },
        { value: m.competitor_product },
        { value: m.competitor_price, state },
        { value: m.source_url, state, href: m.source_url },
      ],
    };
  });
  return { columns: [], rows };
}
