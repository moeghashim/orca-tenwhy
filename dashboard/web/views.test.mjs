import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { renderApp } from "./src/app.js";
import { createStore } from "./src/store.js";
import { statusOf } from "./src/status.js";

function fixtureSnapshot() {
  return {
    serverTime: "2026-08-30T22:00:00Z",
    snapshotAt: "2026-08-30T22:00:00Z",
    lastEventId: 9,
    engagements: [
      {
        id: "eng_0141",
        customer_name: "Cobalt Legal",
        status: "running",
        active_loop: "company-research",
        last_event_at: "2026-08-30T21:59:22Z",
        last_note: "deeper competitor pricing",
        kb_files: [{ path: "research.md", updated: "2026-08-30T21:00:00Z" }],
        live_url: null,
        repo_url: "https://git.example/cobalt",
      },
      {
        id: "eng_0142",
        customer_name: "Meridian Dental",
        status: "needs_human",
        active_loop: "website",
        last_event_at: "2026-08-30T21:46:00Z",
        last_note: "lighthouse≥85 failed",
        kb_files: [
          { path: "company/OVERVIEW.md", updated: "2026-08-30T20:00:00Z" },
          { path: "BRIEF.md", updated: "2026-08-30T20:00:00Z" },
        ],
        live_url: null,
        repo_url: "https://git.example/meridian",
      },
      {
        id: "eng_0143",
        customer_name: "Harbor & Finch",
        status: "awaiting_approval",
        active_loop: "website",
        last_event_at: "2026-08-30T21:00:00Z",
        last_note: "",
        kb_files: [
          { path: "company/OVERVIEW.md", updated: "2026-08-30T18:00:00Z" },
          { path: "company/POSITIONING.md", updated: "2026-08-30T18:00:00Z" },
          { path: "BRIEF.md", updated: "2026-08-30T18:00:00Z" },
        ],
        live_url: null,
        repo_url: "/tmp/harbor",
      },
    ],
    loop_runs: [
      {
        id: "run_res_0141",
        engagement_id: "eng_0141",
        loop_name: "company-research",
        attempt: 0,
        status: "running",
        iteration_count: 2,
        last_verdict: "revise",
        last_note: "deeper competitor pricing",
        last_event_at: "2026-08-30T21:59:22Z",
        adjusted_instructions: null,
        change_request_id: null,
      },
      {
        id: "run_web_0142",
        engagement_id: "eng_0142",
        loop_name: "website",
        attempt: 1,
        status: "needs_human",
        iteration_count: 3,
        last_verdict: "escalate",
        last_note: "escalating",
        last_event_at: "2026-08-30T21:46:00Z",
        adjusted_instructions: "drop hero video",
        change_request_id: null,
      },
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
    iterations: [
      {
        id: "it_1",
        loop_run_id: "run_res_0141",
        n: 1,
        executor_summary: "Compiled firm profile.",
        reviewer_verdict: "revise",
        reviewer_notes: "get published rates",
        pi_trace_ref: "pi://trace/2b9e11f0",
        created_at: "2026-08-30T21:40:00Z",
      },
    ],
    gate_checks: [
      { id: "g1", loop_run_id: "run_web_0142", check_name: "lighthouse≥85", passed: 0, detail: "78", created_at: "2026-08-30T21:46:00Z" },
    ],
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
          { cells: [{ value: "Drip coffee" }, { value: "Nord Kaffe" }, { value: "Filter coffee" }, { value: 4.5, state: "valid" }, { value: "https://nord.example", state: "valid", href: "https://nord.example" }] },
          { cells: [{ value: "Pastry box" }, { value: "Bloom" }, { value: "Morning box" }, { value: null, state: "flagged" }, { value: "https://bloom.example", state: "flagged", href: "https://bloom.example" }] },
        ],
      },
    },
  };
}

function mount(hash, snap = fixtureSnapshot(), sse) {
  const dom = new JSDOM("<!DOCTYPE html><html><body><div id='app'></div></body></html>", {
    url: "http://127.0.0.1:4310/",
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const store = createStore(snap);
  if (sse) store.setSse(sse);
  const root = document.getElementById("app");
  renderApp(root, { store, hash, now: Date.parse("2026-08-30T22:00:00Z"), go() {} });
  return { root, store, document: dom.window.document };
}

test("runs view: row count, 41px row height, verbatim badge, iteration 2/4 + 2 filled segments, amber attempt dots, needs_human banner", () => {
  const { root } = mount("#/runs");
  const rows = root.querySelectorAll("[data-run-row]");
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.style.height, "41px");
  }
  const cobalt = root.querySelector("[data-run-row='eng_0141']");
  const badge = cobalt.querySelector("[data-badge]");
  const st = statusOf("engagement", "running");
  assert.equal(badge.textContent.trim(), `${st.glyph} running`);
  const iter = cobalt.querySelector("[data-iter]");
  assert.equal(iter.getAttribute("data-iter"), "2/4");
  assert.equal(iter.querySelectorAll("[data-filled='1']").length, 2);
  assert.match(iter.textContent, /2\/4/);
  const meridian = root.querySelector("[data-run-row='eng_0142']");
  const att = meridian.querySelector("[data-attempt]");
  assert.equal(att.getAttribute("data-attempt"), "1/2");
  assert.ok(att.querySelector("[data-amber='1']"));
  const banner = root.querySelector("[data-banner='needs_human']");
  assert.match(banner.textContent, /⚑ 1 runs need human input/);
});

test("loop detail, failures, and customers views render from the snapshot fixture", () => {
  const loop = mount("#/runs/eng_0143/run_res_0143");
  assert.match(loop.root.textContent, /Harbor & Finch/);
  assert.match(loop.root.textContent, /runs \/ eng_0143 \/ run_res_0143/);
  const cells = [...loop.root.querySelectorAll("[data-cmp-cell]")];
  assert.ok(cells.some((c) => c.textContent.includes("✓")));
  assert.ok(cells.some((c) => c.textContent.includes("⚑")));

  const fail = mount("#/failures");
  assert.match(fail.root.textContent, /Meridian Dental/);
  assert.match(fail.root.textContent, /lighthouse≥85/);
  assert.equal(fail.root.querySelector("[data-banner='needs_human']"), null);

  const cust = mount("#/customers");
  const names = [...cust.root.querySelectorAll("[data-kb-file]")].map((n) => n.getAttribute("data-kb-file"));
  assert.ok(names.includes("company/OVERVIEW.md"), names);
  assert.ok(names.includes("company/POSITIONING.md"), names);
  assert.ok(names.includes("BRIEF.md"), names);
  assert.ok(names.includes("research.md"), names);
});
