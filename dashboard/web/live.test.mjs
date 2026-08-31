import assert from "node:assert/strict";
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
