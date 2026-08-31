import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { renderApp } from "./src/app.js";
import { createStore } from "./src/store.js";

test("comparison table renders ✓/⚑", () => {
  const snap = {
    serverTime: "2026-08-30T22:00:00Z",
    snapshotAt: "2026-08-30T22:00:00Z",
    lastEventId: 1,
    engagements: [
      {
        id: "eng_0143",
        customer_name: "Harbor & Finch",
        status: "awaiting_approval",
        active_loop: "website",
        last_event_at: "2026-08-30T21:00:00Z",
        last_note: "",
        kb_files: [{ path: "company/OVERVIEW.md", updated: "2026-08-30T18:00:00Z" }],
        live_url: null,
        repo_url: null,
      },
    ],
    loop_runs: [
      {
        id: "run_res_0143",
        engagement_id: "eng_0143",
        loop_name: "company-research",
        attempt: 0,
        status: "gate_passed",
        iteration_count: 1,
        last_verdict: "approve",
        last_note: "ok",
        last_event_at: "2026-08-30T21:00:00Z",
        adjusted_instructions: null,
        change_request_id: null,
      },
    ],
    iterations: [],
    gate_checks: [],
    scrapes: [],
    approvals: [],
    comparisons: {
      run_res_0143: {
        columns: [
          { key: "customer_product", label: "customer product" },
          { key: "competitor", label: "competitor" },
          { key: "competitor_product", label: "competitor product" },
          { key: "price", label: "price" },
          { key: "source", label: "source" },
        ],
        rows: [
          { cells: [{ value: "Drip coffee" }, { value: "Nord" }, { value: "Filter" }, { value: 4.5, state: "valid" }, { value: "https://n.example", state: "valid", href: "https://n.example" }] },
          { cells: [{ value: "Pastry box" }, { value: "Bloom" }, { value: "Box" }, { value: null, state: "flagged" }, { value: "https://b.example", state: "flagged", href: "https://b.example" }] },
        ],
      },
    },
  };
  const dom = new JSDOM("<!DOCTYPE html><div id='app'></div>", { url: "http://127.0.0.1:4310/" });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const store = createStore(snap);
  const root = document.getElementById("app");
  renderApp(root, { store, hash: "#/runs/eng_0143/run_res_0143", now: Date.parse("2026-08-30T22:00:00Z"), go() {} });
  const table = root.querySelector("[data-comparison]");
  assert.ok(table);
  const cells = [...table.querySelectorAll("[data-cmp-cell]")];
  assert.ok(cells.some((c) => c.getAttribute("data-cmp-cell") === "valid" && c.textContent.includes("✓")));
  assert.ok(cells.some((c) => c.getAttribute("data-cmp-cell") === "flagged" && c.textContent.includes("⚑")));
});

test("newer gate_passed research comparison drops the older key and renders superseded", () => {
  const snap = {
    serverTime: "2026-08-30T22:00:00Z",
    snapshotAt: "2026-08-30T22:00:00Z",
    lastEventId: 2,
    engagements: [
      {
        id: "eng_e",
        customer_name: "Echo",
        status: "running",
        active_loop: "company-research",
        last_event_at: "2026-08-30T21:00:00Z",
        last_note: "",
        kb_files: [],
        live_url: null,
        repo_url: null,
      },
    ],
    loop_runs: [
      {
        id: "run_old",
        engagement_id: "eng_e",
        loop_name: "company-research",
        attempt: 0,
        status: "gate_passed",
        iteration_count: 1,
        last_note: "old",
        last_event_at: "2026-08-30T20:00:00Z",
        adjusted_instructions: null,
        change_request_id: null,
      },
      {
        id: "run_new",
        engagement_id: "eng_e",
        loop_name: "company-research",
        attempt: 1,
        status: "running",
        iteration_count: 1,
        last_note: "retry",
        last_event_at: "2026-08-30T21:00:00Z",
        adjusted_instructions: null,
        change_request_id: null,
      },
    ],
    iterations: [],
    gate_checks: [],
    scrapes: [],
    approvals: [],
    comparisons: {
      run_old: {
        columns: [{ key: "customer_product", label: "customer product" }],
        rows: [{ cells: [{ value: "old" }] }],
      },
    },
  };
  const store = createStore(snap);
  store.applyPatch({
    entities: {
      loop_runs: [{ ...snap.loop_runs[1], status: "gate_passed" }],
      comparisons: {
        run_new: {
          columns: [{ key: "customer_product", label: "customer product" }],
          rows: [{ cells: [{ value: "new" }] }],
        },
      },
    },
  });
  assert.equal(store.snapshot.comparisons.run_old, undefined);
  assert.ok(store.snapshot.comparisons.run_new);

  const dom = new JSDOM("<!DOCTYPE html><div id='app'></div>", { url: "http://127.0.0.1:4310/" });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const root = document.getElementById("app");
  renderApp(root, { store, hash: "#/runs/eng_e/run_old", now: Date.parse("2026-08-30T22:00:00Z"), go() {} });
  assert.match(root.textContent, /comparison superseded by run_new/);
  assert.equal(root.querySelector("[data-comparison]"), null);
});
