import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { renderApp } from "./src/app.js";
import { connectSse } from "./src/sse.js";
import { createStore } from "./src/store.js";

function mount({ hash = "#/runs", snap = null, sse } = {}) {
  const dom = new JSDOM("<!DOCTYPE html><div id='app'></div>", { url: "http://127.0.0.1:4310/" });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const store = createStore(snap);
  if (sse) store.setSse(sse);
  const root = document.getElementById("app");
  const paint = () => renderApp(root, { store, hash, now: Date.parse("2026-08-30T22:00:00Z"), go() {} });
  store.subscribe(paint);
  paint();
  return { root, store, document: dom.window.document };
}

test("applyPatch changes a cell in place with the row order unchanged and the row marked flashed", () => {
  const snap = {
    serverTime: "2026-08-30T22:00:00Z",
    snapshotAt: "2026-08-30T22:00:00Z",
    lastEventId: 1,
    engagements: [
      { id: "eng_a", customer_name: "Alpha", status: "running", active_loop: "company-research", last_event_at: "2026-08-30T21:59:00Z", last_note: "old note", kb_files: [], live_url: null, repo_url: null },
      { id: "eng_b", customer_name: "Beta", status: "new", active_loop: "company-research", last_event_at: "2026-08-30T21:00:00Z", last_note: "queued", kb_files: [], live_url: null, repo_url: null },
    ],
    loop_runs: [
      { id: "run_a", engagement_id: "eng_a", loop_name: "company-research", attempt: 0, status: "running", iteration_count: 1, last_note: "", last_event_at: "2026-08-30T21:59:00Z", adjusted_instructions: null, change_request_id: null },
    ],
    iterations: [],
    gate_checks: [],
    scrapes: [],
    approvals: [],
    comparisons: {},
  };
  const { root, store } = mount({ snap });
  const beforeNodes = [...root.querySelectorAll("[data-row]")];
  const before = beforeNodes.map((n) => n.getAttribute("data-row"));
  assert.deepEqual(before, ["eng_a", "eng_b"]);
  assert.equal(root.querySelectorAll("[data-row]").length, 2);
  store.applyPatch({
    entities: {
      engagements: [
        { ...snap.engagements[0], last_note: "patched note", status: "running" },
      ],
    },
  });
  const afterNodes = [...root.querySelectorAll("[data-row]")];
  const after = afterNodes.map((n) => n.getAttribute("data-row"));
  assert.deepEqual(after, ["eng_a", "eng_b"]);
  assert.equal(afterNodes.length, beforeNodes.length);
  assert.equal(afterNodes.length, 2);
  assert.ok(beforeNodes[0].isSameNode(afterNodes[0]));
  assert.ok(beforeNodes[1].isSameNode(afterNodes[1]));
  assert.match(root.querySelector("[data-run-row='eng_a']").textContent, /patched note/);
  assert.ok(store.flashed.has("eng_a"));
});

test("in-place patching keeps Runs cell, Failures card, Customers card, and Loop gate row identity", () => {
  const snap = {
    serverTime: "2026-08-30T22:00:00Z",
    snapshotAt: "2026-08-30T22:00:00Z",
    lastEventId: 1,
    engagements: [
      { id: "eng_a", customer_name: "Alpha", status: "needs_human", active_loop: "website", last_event_at: "2026-08-30T21:59:00Z", last_note: "old note", kb_files: [{ path: "BRIEF.md", updated: "2026-08-30T20:00:00Z" }], live_url: null, repo_url: null },
    ],
    loop_runs: [
      { id: "run_a", engagement_id: "eng_a", loop_name: "company-research", attempt: 0, status: "gate_passed", iteration_count: 1, last_note: "", last_event_at: "2026-08-30T21:50:00Z", adjusted_instructions: null, change_request_id: null },
      { id: "run_web", engagement_id: "eng_a", loop_name: "website", attempt: 1, status: "needs_human", iteration_count: 1, last_note: "", last_event_at: "2026-08-30T21:59:00Z", adjusted_instructions: "old adj", change_request_id: null },
    ],
    iterations: [],
    gate_checks: [
      { id: "g1", loop_run_id: "run_a", check_name: "schema_valid", passed: 0, detail: "no", created_at: "2026-08-30T21:50:00Z" },
    ],
    scrapes: [],
    approvals: [],
    comparisons: {},
  };

  const runs = mount({ hash: "#/runs", snap });
  const note = runs.root.querySelector("[data-note]");
  assert.ok(note);
  runs.store.applyPatch({
    entities: { engagements: [{ ...snap.engagements[0], last_note: "cell patched" }] },
  });
  assert.ok(note.isSameNode(runs.root.querySelector("[data-run-row='eng_a'] [data-note]")));
  assert.equal(note.textContent, "cell patched");

  const fail = mount({ hash: "#/failures", snap });
  const failCard = fail.root.querySelector("[data-row='run_web']");
  assert.ok(failCard);
  fail.store.applyPatch({
    entities: { loop_runs: [{ ...snap.loop_runs[1], adjusted_instructions: "drop video" }] },
  });
  assert.ok(failCard.isSameNode(fail.root.querySelector("[data-row='run_web']")));
  assert.match(failCard.textContent, /drop video/);

  const cust = mount({ hash: "#/customers", snap });
  const custCard = cust.root.querySelector("[data-customer='eng_a']");
  assert.ok(custCard);
  cust.store.applyPatch({
    entities: { engagements: [{ ...snap.engagements[0], customer_name: "Alpha Prime" }] },
  });
  assert.ok(custCard.isSameNode(cust.root.querySelector("[data-customer='eng_a']")));
  assert.match(custCard.textContent, /Alpha Prime/);

  const loop = mount({ hash: "#/runs/eng_a/run_a", snap });
  const gateRow = loop.root.querySelector("[data-gate='g1']");
  assert.ok(gateRow);
  loop.store.applyPatch({
    entities: { gate_checks: [{ ...snap.gate_checks[0], passed: 1 }] },
  });
  assert.ok(gateRow.isSameNode(loop.root.querySelector("[data-gate='g1']")));
  assert.match(gateRow.textContent, /pass/);
});

test("loop-detail full live sync updates each region in place", () => {
  const snap = {
    serverTime: "2026-08-30T22:00:00Z",
    snapshotAt: "2026-08-30T22:00:00Z",
    lastEventId: 1,
    engagements: [
      { id: "eng_a", customer_name: "Alpha", status: "running", active_loop: "company-research", last_event_at: "2026-08-30T21:59:00Z", last_note: "", kb_files: [], live_url: null, repo_url: null },
    ],
    loop_runs: [
      {
        id: "run_a",
        engagement_id: "eng_a",
        loop_name: "company-research",
        attempt: 0,
        status: "running",
        iteration_count: 1,
        last_note: "",
        last_event_at: "2026-08-30T21:50:00Z",
        adjusted_instructions: null,
        change_request_id: null,
      },
      {
        id: "run_web",
        engagement_id: "eng_a",
        loop_name: "website",
        attempt: 0,
        status: "queued",
        iteration_count: 0,
        last_note: "",
        last_event_at: "2026-08-30T21:00:00Z",
        adjusted_instructions: null,
        change_request_id: null,
      },
    ],
    iterations: [
      {
        id: "it_1",
        loop_run_id: "run_a",
        n: 1,
        reviewer_verdict: "revise",
        reviewer_notes: "old notes",
        executor_summary: "first draft",
        pi_trace_ref: "pi://trace/aaa",
        created_at: "2026-08-30T21:50:00Z",
      },
    ],
    gate_checks: [{ id: "g1", loop_run_id: "run_a", check_name: "schema_valid", passed: 0, detail: "no", created_at: "2026-08-30T21:50:00Z" }],
    scrapes: [{ id: "sc1", loop_run_id: "run_a", url: "https://alpha.example", http_status: 200, created_at: "2026-08-30T21:40:00Z" }],
    approvals: [],
    comparisons: {
      run_a: {
        columns: [{ label: "customer product" }, { label: "competitor" }],
        rows: [{ cells: [{ value: "old", state: "valid" }, { value: "rival", state: "flagged" }] }],
      },
    },
  };
  const { root, store } = mount({ hash: "#/runs/eng_a/run_a", snap });
  const shell = root.querySelector(".shell");
  const head = root.querySelector("[data-loop-head]");
  const meta = root.querySelector("[data-loop-meta]");
  const pipe = root.querySelector("[data-pipeline]");
  const chip = root.querySelector('[data-pipe="company-research"]');
  const iter = root.querySelector('[data-iter-n="1"]');
  const pending = root.querySelector("[data-iter-pending]");
  const scrape = root.querySelector('[data-scrape="sc1"]');
  const gate = root.querySelector("[data-gate='g1']");
  const cmp = root.querySelector("[data-comparison]");
  assert.ok(shell && head && meta && pipe && chip && iter && pending && scrape && gate && cmp);
  assert.match(meta.textContent, /iteration 1\/4/);
  assert.match(iter.textContent, /old notes/);
  assert.match(pending.textContent, /iteration 2 in progress/);

  store.applyPatch({
    entities: {
      loop_runs: [{ ...snap.loop_runs[0], status: "gate_passed", iteration_count: 2, last_event_at: "2026-08-30T21:59:00Z" }],
      iterations: [
        { ...snap.iterations[0], reviewer_verdict: "approve", reviewer_notes: "looks good", pi_trace_ref: "pi://trace/bbb" },
        {
          id: "it_2",
          loop_run_id: "run_a",
          n: 2,
          reviewer_verdict: "approve",
          reviewer_notes: "second",
          executor_summary: "round 2",
          created_at: "2026-08-30T21:55:00Z",
        },
      ],
      gate_checks: [{ ...snap.gate_checks[0], passed: 1 }, { id: "g2", loop_run_id: "run_a", check_name: "competitors≥5", passed: 1, detail: "ok", created_at: "2026-08-30T21:59:00Z" }],
      scrapes: [
        { ...snap.scrapes[0], http_status: 404 },
        { id: "sc2", loop_run_id: "run_a", url: "https://beta.example", http_status: 200, created_at: "2026-08-30T21:58:00Z" },
      ],
      comparisons: {
        run_a: {
          columns: [{ label: "customer product" }, { label: "competitor" }],
          rows: [{ cells: [{ value: "new", state: "valid" }, { value: "rival", state: "valid" }] }],
        },
      },
    },
  });
  assert.ok(shell.isSameNode(root.querySelector(".shell")));
  assert.ok(head.isSameNode(root.querySelector("[data-loop-head]")));
  assert.ok(meta.isSameNode(root.querySelector("[data-loop-meta]")));
  assert.ok(pipe.isSameNode(root.querySelector("[data-pipeline]")));
  assert.ok(chip.isSameNode(root.querySelector('[data-pipe="company-research"]')));
  assert.ok(iter.isSameNode(root.querySelector('[data-iter-n="1"]')));
  assert.ok(scrape.isSameNode(root.querySelector('[data-scrape="sc1"]')));
  assert.ok(gate.isSameNode(root.querySelector("[data-gate='g1']")));
  assert.ok(cmp.isSameNode(root.querySelector("[data-comparison]")));
  assert.match(head.textContent, /gate_passed|passed/);
  assert.match(meta.textContent, /iteration 2\/4/);
  assert.match(iter.textContent, /looks good/);
  assert.match(iter.textContent, /pi:\/\/trace\/bbb/);
  assert.ok(root.querySelector('[data-iter-n="2"]'));
  assert.equal(root.querySelector("[data-iter-pending]"), null);
  assert.match(scrape.textContent, /404/);
  assert.ok(root.querySelector('[data-scrape="sc2"]'));
  assert.match(gate.textContent, /pass/);
  assert.match(root.querySelector("[data-gate='g2']").textContent, /competitors/);
  assert.match(cmp.textContent, /new/);
});

test("scrape provenance keeps two rows with the same URL and different ids", () => {
  const snap = {
    serverTime: "2026-08-30T22:00:00Z",
    snapshotAt: "2026-08-30T22:00:00Z",
    lastEventId: 1,
    engagements: [
      { id: "eng_a", customer_name: "Alpha", status: "running", active_loop: "company-research", last_event_at: "2026-08-30T21:59:00Z", last_note: "", kb_files: [], live_url: null, repo_url: null },
    ],
    loop_runs: [
      {
        id: "run_a",
        engagement_id: "eng_a",
        loop_name: "company-research",
        attempt: 0,
        status: "running",
        iteration_count: 1,
        last_note: "",
        last_event_at: "2026-08-30T21:59:00Z",
        adjusted_instructions: null,
        change_request_id: null,
      },
    ],
    iterations: [],
    gate_checks: [],
    scrapes: [],
    approvals: [],
    comparisons: {},
  };
  const { root, store } = mount({ hash: "#/runs/eng_a/run_a", snap });
  store.applyPatch({
    entities: {
      scrapes: [{ id: "sc_ok", loop_run_id: "run_a", url: "https://same.example", http_status: 200, created_at: "2026-08-30T21:40:00Z" }],
    },
  });
  store.applyPatch({
    entities: {
      scrapes: [{ id: "sc_no", loop_run_id: "run_a", url: "https://same.example", http_status: 403, created_at: "2026-08-30T21:41:00Z" }],
    },
  });
  const rows = [...root.querySelectorAll("[data-scrape]")];
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((n) => n.getAttribute("data-scrape")),
    ["sc_ok", "sc_no"],
  );
  assert.match(rows[0].textContent, /200/);
  assert.match(rows[1].textContent, /403/);
  assert.ok(rows[0].textContent.includes("https://same.example"));
  assert.ok(rows[1].textContent.includes("https://same.example"));
});

test("customers full live sync adds live link and kb file in place", () => {
  const snap = {
    serverTime: "2026-08-30T22:00:00Z",
    snapshotAt: "2026-08-30T22:00:00Z",
    lastEventId: 1,
    engagements: [
      {
        id: "eng_a",
        customer_name: "Alpha",
        status: "awaiting_approval",
        active_loop: "website",
        last_event_at: "2026-08-30T21:59:00Z",
        last_note: "",
        kb_files: [{ path: "BRIEF.md", updated: "2026-08-30T20:00:00Z" }],
        live_url: null,
        repo_url: "https://git.example/alpha",
      },
    ],
    loop_runs: [],
    iterations: [],
    gate_checks: [],
    scrapes: [],
    approvals: [],
    comparisons: {},
  };
  const { root, store } = mount({ hash: "#/customers", snap });
  const card = root.querySelector("[data-customer='eng_a']");
  const kb = root.querySelector('[data-kb-file="BRIEF.md"]');
  assert.ok(card);
  assert.ok(kb);
  assert.equal(root.querySelector("[data-live-link]"), null);
  store.applyPatch({
    entities: {
      engagements: [
        {
          ...snap.engagements[0],
          live_url: "https://alpha.example.workers.dev",
          kb_files: [
            { path: "BRIEF.md", updated: "2026-08-30T21:00:00Z" },
            { path: "company/OVERVIEW.md", updated: "2026-08-30T21:30:00Z" },
          ],
        },
      ],
    },
  });
  assert.ok(card.isSameNode(root.querySelector("[data-customer='eng_a']")));
  assert.ok(kb.isSameNode(root.querySelector('[data-kb-file="BRIEF.md"]')));
  const live = root.querySelector("[data-live-link]");
  assert.ok(live);
  assert.equal(live.getAttribute("href"), "https://alpha.example.workers.dev");
  assert.match(live.textContent, /live/);
  assert.ok(root.querySelector('[data-kb-file="company/OVERVIEW.md"]'));
});

test("flashed row ids clear after 800ms and CSS eases the background out", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"], now: 0 });
  const snap = {
    serverTime: "2026-08-30T22:00:00Z",
    snapshotAt: "2026-08-30T22:00:00Z",
    lastEventId: 1,
    engagements: [
      { id: "eng_a", customer_name: "Alpha", status: "running", active_loop: "company-research", last_event_at: "2026-08-30T21:59:00Z", last_note: "old", kb_files: [], live_url: null, repo_url: null },
    ],
    loop_runs: [],
    iterations: [],
    gate_checks: [],
    scrapes: [],
    approvals: [],
    comparisons: {},
  };
  const store = createStore(snap);
  store.applyPatch({
    entities: { engagements: [{ ...snap.engagements[0], last_note: "next" }] },
  });
  assert.ok(store.flashed.has("eng_a"));
  t.mock.timers.tick(799);
  assert.ok(store.flashed.has("eng_a"));
  t.mock.timers.tick(1);
  assert.equal(store.flashed.has("eng_a"), false);
  const css = fs.readFileSync(new URL("./src/style.css", import.meta.url), "utf8");
  assert.match(css, /transition:\s*background-color\s+800ms\s+ease-out/);
});

test("flash background restores after 800ms", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"], now: 0 });
  const snap = {
    serverTime: "2026-08-30T22:00:00Z",
    snapshotAt: "2026-08-30T22:00:00Z",
    lastEventId: 1,
    engagements: [
      { id: "eng_a", customer_name: "Alpha", status: "running", active_loop: "company-research", last_event_at: "2026-08-30T21:59:00Z", last_note: "old", kb_files: [], live_url: null, repo_url: null },
    ],
    loop_runs: [
      { id: "run_a", engagement_id: "eng_a", loop_name: "company-research", attempt: 0, status: "running", iteration_count: 1, last_note: "", last_event_at: "2026-08-30T21:59:00Z" },
    ],
    iterations: [],
    gate_checks: [],
    scrapes: [],
    approvals: [],
    comparisons: {},
  };
  const { root, store } = mount({ snap });
  store.applyPatch({
    entities: { engagements: [{ ...snap.engagements[0], last_note: "next" }] },
  });
  const row = root.querySelector("[data-run-row='eng_a']");
  assert.ok(row.classList.contains("is-flash"));
  assert.notEqual(row.style.background, "");
  t.mock.timers.tick(800);
  assert.equal(store.flashed.has("eng_a"), false);
  assert.equal(row.classList.contains("is-flash"), false);
  assert.equal(row.style.background, "");
});

test("failures keep card order across patches and re-sort after reconnect snapshot", () => {
  const run = (id, eng, status) => ({
    id,
    engagement_id: eng,
    loop_name: "website",
    attempt: 0,
    status,
    iteration_count: 1,
    last_note: "",
    last_event_at: "2026-08-30T21:00:00Z",
    adjusted_instructions: null,
    change_request_id: null,
  });
  const eng = (id, name) => ({
    id,
    customer_name: name,
    status: "needs_human",
    active_loop: "website",
    last_event_at: "2026-08-30T21:00:00Z",
    last_note: "",
    kb_files: [],
    live_url: null,
    repo_url: null,
  });
  const snap = {
    serverTime: "2026-08-30T22:00:00Z",
    snapshotAt: "2026-08-30T22:00:00Z",
    lastEventId: 1,
    engagements: [eng("eng_a", "Alpha"), eng("eng_b", "Beta"), eng("eng_c", "Gamma")],
    loop_runs: [run("run_a", "eng_a", "gate_failed"), run("run_b", "eng_b", "gate_failed"), run("run_c", "eng_c", "needs_human")],
    iterations: [],
    gate_checks: [],
    scrapes: [],
    approvals: [],
    comparisons: {},
  };
  const { root, store } = mount({ hash: "#/failures", snap });
  const ids = () => [...root.querySelectorAll("[data-row]")].map((n) => n.getAttribute("data-row"));
  assert.deepEqual(ids(), ["run_a", "run_b", "run_c"]);
  store.applyPatch({
    entities: { loop_runs: [{ ...snap.loop_runs[0], status: "needs_human" }] },
  });
  assert.deepEqual(ids(), ["run_a", "run_b", "run_c"]);
  const next = {
    ...store.snapshot,
    loop_runs: store.snapshot.loop_runs.map((r) => ({ ...r })),
  };
  store.setSnapshot(next, { resort: true });
  assert.deepEqual(ids(), ["run_a", "run_c", "run_b"]);
});

test("Runs rows keep order while connected and physically reorder on reconnect", () => {
  const snap = {
    serverTime: "2026-08-30T22:00:00Z",
    snapshotAt: "2026-08-30T22:00:00Z",
    lastEventId: 1,
    engagements: [
      { id: "eng_a", customer_name: "Alpha", status: "running", active_loop: "company-research", last_event_at: "2026-08-30T21:59:00Z", last_note: "a", kb_files: [], live_url: null, repo_url: null },
      { id: "eng_b", customer_name: "Beta", status: "new", active_loop: "company-research", last_event_at: "2026-08-30T21:00:00Z", last_note: "b", kb_files: [], live_url: null, repo_url: null },
    ],
    loop_runs: [
      { id: "run_a", engagement_id: "eng_a", loop_name: "company-research", attempt: 0, status: "running", iteration_count: 1, last_note: "", last_event_at: "2026-08-30T21:59:00Z" },
    ],
    iterations: [],
    gate_checks: [],
    scrapes: [],
    approvals: [],
    comparisons: {},
  };
  const { root, store } = mount({ snap });
  const before = [...root.querySelectorAll("[data-row]")];
  assert.deepEqual(before.map((n) => n.getAttribute("data-row")), ["eng_a", "eng_b"]);
  store.applyPatch({
    entities: {
      engagements: [{ ...snap.engagements[0], last_event_at: "2026-08-30T22:00:00Z", last_note: "newer" }],
    },
  });
  const patched = [...root.querySelectorAll("[data-row]")];
  assert.deepEqual(patched.map((n) => n.getAttribute("data-row")), ["eng_a", "eng_b"]);
  assert.ok(before[0].isSameNode(patched[0]));
  assert.ok(before[1].isSameNode(patched[1]));

  function reconnect() {
    const resorted = {
      ...store.snapshot,
      engagements: [store.snapshot.engagements[1], store.snapshot.engagements[0]],
    };
    store.setSnapshot(resorted, { resort: true });
  }
  reconnect();
  const after = [...root.querySelectorAll("[data-row]")];
  assert.deepEqual(after.map((n) => n.getAttribute("data-row")), ["eng_b", "eng_a"]);
  assert.ok(before[0].isSameNode(after[1]));
  assert.ok(before[1].isSameNode(after[0]));
});

test("loading/empty/disconnected states render the exact copy", () => {
  const loading = mount({ snap: null });
  assert.equal(loading.root.querySelector("[data-state='loading']").tagName, "DIV");
  assert.match(loading.root.textContent, /GET \/api\/snapshot …/);

  const emptySnap = {
    serverTime: "2026-08-30T22:00:00Z",
    snapshotAt: "2026-08-30T22:00:00Z",
    lastEventId: 0,
    engagements: [],
    loop_runs: [],
    iterations: [],
    gate_checks: [],
    scrapes: [],
    approvals: [],
    comparisons: {},
  };
  const empty = mount({ snap: emptySnap });
  assert.match(empty.root.textContent, /○ no engagements/);
  assert.match(
    empty.root.textContent,
    /The orchestrator hasn't started any engagements yet. Rows will appear here the moment the first loop is queued./,
  );

  const failEmpty = mount({ hash: "#/failures", snap: emptySnap });
  assert.match(failEmpty.root.textContent, /✓ nothing blocked/);

  const disc = mount({
    snap: {
      ...emptySnap,
      engagements: [
        { id: "eng_a", customer_name: "Alpha", status: "running", active_loop: "company-research", last_event_at: "2026-08-30T21:59:00Z", last_note: "held", kb_files: [], live_url: null, repo_url: null },
      ],
      loop_runs: [
        { id: "run_a", engagement_id: "eng_a", loop_name: "company-research", attempt: 0, status: "running", iteration_count: 1, last_note: "", last_event_at: "2026-08-30T21:59:00Z" },
      ],
    },
    sse: { state: "disconnected", closedAt: "2026-08-30T21:58:00Z", retry: 5, retryIn: 0 },
  });
  const banner = disc.root.querySelector("[data-banner='disconnected']");
  assert.ok(banner);
  assert.match(banner.textContent, /✕ stream disconnected/);
  assert.match(banner.textContent, /snapshot/);
  assert.match(disc.root.textContent, /Alpha/);
});

test("SSE-kill test → red banner + snapshot label", () => {
  const snap = {
    serverTime: "2026-08-30T22:00:00Z",
    snapshotAt: "2026-08-30T22:00:00Z",
    lastEventId: 1,
    engagements: [
      { id: "eng_a", customer_name: "Alpha", status: "running", active_loop: "company-research", last_event_at: "2026-08-30T21:59:00Z", last_note: "live", kb_files: [], live_url: null, repo_url: null },
    ],
    loop_runs: [
      { id: "run_a", engagement_id: "eng_a", loop_name: "company-research", attempt: 0, status: "running", iteration_count: 1, last_note: "", last_event_at: "2026-08-30T21:59:00Z" },
    ],
    iterations: [],
    gate_checks: [],
    scrapes: [],
    approvals: [],
    comparisons: {},
  };
  const { root, store } = mount({ snap });
  class FakeES {
    constructor() {
      this.listeners = {};
    }
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    }
    close() {}
  }
  FakeES.prototype.onerror = null;
  FakeES.prototype.onopen = null;
  const sse = connectSse({
    store,
    EventSourceImpl: FakeES,
    fetchSnapshot: async () => snap,
  });
  sse.kill();
  const banner = root.querySelector("[data-banner='disconnected']");
  assert.ok(banner);
  assert.match(banner.textContent, /✕ stream disconnected/);
  assert.match(banner.textContent, /snapshot/);
  assert.equal(store.sse.state, "disconnected");
});

test("loop chain shows the latest attempt per loop and 'not started' for loops without a run (live myjam.co.uk shape)", () => {
  const snap = {
    serverTime: "2026-09-01T08:05:00Z",
    snapshotAt: "2026-09-01T08:05:00Z",
    lastEventId: 9,
    engagements: [
      { id: "eng_r", customer_name: "myjam.co.uk", status: "running", active_loop: "company-research", last_event_at: "2026-09-01T08:00:22Z", last_note: "", kb_files: [], live_url: null, repo_url: null },
    ],
    loop_runs: [
      { id: "run_a0", engagement_id: "eng_r", loop_name: "company-research", attempt: 0, status: "gate_failed", iteration_count: 2, last_event_at: "2026-09-01T07:59:55Z", started_at: "2026-09-01T07:50:31Z" },
      { id: "run_a1", engagement_id: "eng_r", loop_name: "company-research", attempt: 1, status: "running", iteration_count: 0, last_event_at: "2026-09-01T08:00:22Z", started_at: "2026-09-01T08:00:22Z" },
    ],
    iterations: [],
    gate_checks: [],
    scrapes: [],
    approvals: [],
    comparisons: [],
  };
  for (const hash of ["#/runs/eng_r/run_a1", "#/runs/eng_r/run_a0"]) {
    const { root } = mount({ hash, snap });
    const research = root.querySelector('[data-pipe="company-research"] [data-pipe-state]');
    const website = root.querySelector('[data-pipe="website"] [data-pipe-state]');
    assert.ok(research && website, `both chain chips render for ${hash}`);
    assert.match(research.textContent, /running/, `${hash}: chip reflects attempt 1 (running), not attempt 0 (gate_failed)`);
    assert.doesNotMatch(research.textContent, /gate_failed/);
    assert.match(website.textContent, /not started/);
    assert.doesNotMatch(website.textContent, /queued/);
  }
});
