import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { parseCustomerHash, renderCustomerApp } from "./src/customer/app.js";
import { deriveStaleWebsiteRunIds, loadingProgress } from "./src/customer/progress.js";
import { installGridTestStubs } from "./src/research-grid/canvas-stub.js";
import { createCustomerSession } from "./src/customer/session.js";

function fixtureEvents() {
  const loop_runs = [
    { id: "run_res", loop_name: "company-research" },
    { id: "run_web", loop_name: "website" },
  ];
  const events = [
    { kind: "loop_run.started", loop_run_id: "run_res", payload: { loopName: "company-research" } },
    { kind: "gate.checked", loop_run_id: "run_res", payload: { passed: true } },
    { kind: "loop_run.prepared", loop_run_id: "run_web", payload: { traceRef: "pi://session/x" } },
    { kind: "iteration.recorded", loop_run_id: "run_web", payload: { n: 1, verdict: "approve" } },
    { kind: "gate.checked", loop_run_id: "run_web", payload: { passed: true } },
  ];
  return { loop_runs, events };
}

test("loading steps advance in order when fixture events 1–5 are applied, and never regress", () => {
  const { loop_runs, events } = fixtureEvents();
  const applied = [];
  const seen = [];
  for (const ev of events) {
    applied.push(ev);
    const p = loadingProgress({ events: applied, loop_runs });
    seen.push(p.completed);
  }
  assert.deepEqual(seen, [1, 2, 3, 4, 5]);
  applied.push(events[0]);
  assert.equal(loadingProgress({ events: applied, loop_runs }).completed, 5);
  const failOnly = events.slice(0, 4).concat([{ kind: "gate.checked", loop_run_id: "run_web", payload: { passed: false } }]);
  const heldNoApprove = loadingProgress({
    events: events.slice(0, 3).concat([
      { kind: "iteration.recorded", loop_run_id: "run_web", payload: { n: 1, verdict: "revise" } },
    ]),
    loop_runs,
  });
  assert.equal(heldNoApprove.completed, 3, "a revise verdict keeps 'building' active");
  const held = loadingProgress({ events: failOnly, loop_runs });
  assert.equal(held.completed, 4);
  assert.equal(held.activeIndex, 4);
  assert.equal(held.hold, true);
});

test("research iterations, a failed research gate and an orchestrator retry keep step 2 active (live myjam.co.uk shape)", () => {
  const loop_runs = [
    { id: "run_a0", loop_name: "company-research", attempt: 0 },
    { id: "run_a1", loop_name: "company-research", attempt: 1 },
  ];
  const events = [
    { kind: "loop_run.started", loop_run_id: "run_a0", payload: { loopName: "company-research", attempt: 0 } },
    { kind: "iteration.recorded", loop_run_id: "run_a0", payload: { n: 1, verdict: "revise" } },
    { kind: "iteration.recorded", loop_run_id: "run_a0", payload: { n: 2, verdict: "approve" } },
    { kind: "gate.checked", loop_run_id: "run_a0", payload: { passed: false, checks: [] } },
    { kind: "loop_run.finished", loop_run_id: "run_a0", payload: { status: "gate_failed" } },
    { kind: "loop_run.retry", loop_run_id: "run_a1", payload: { previousRunId: "run_a0", attempt: 1, loop: "company-research" } },
    { kind: "loop_run.started", loop_run_id: "run_a1", payload: { loopName: "company-research", attempt: 1 } },
    { kind: "iteration.recorded", loop_run_id: "run_a1", payload: { n: 1, verdict: "approve" } },
  ];
  const seen = [];
  const applied = [];
  for (const ev of events) {
    applied.push(ev);
    seen.push(loadingProgress({ events: applied, loop_runs }).completed);
  }
  assert.deepEqual(seen, [1, 1, 1, 1, 1, 1, 1, 1]);
  const p = loadingProgress({ events, loop_runs });
  assert.equal(p.activeIndex, 1, "'researching the market' stays the active step");
  assert.equal(p.hold, false);
  applied.push({ kind: "gate.checked", loop_run_id: "run_a1", payload: { passed: true, checks: [] } });
  assert.equal(loadingProgress({ events: applied, loop_runs }).completed, 2, "research gate pass → planning active");
});

test("start and loading markup include mascot and five steps", () => {
  const dom = new JSDOM("<!DOCTYPE html><div id='app'></div><div id='portal'></div>", { url: "http://127.0.0.1:4310/customer.html" });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLCanvasElement = dom.window.HTMLCanvasElement;
  globalThis.Image = dom.window.Image;
  installGridTestStubs();
  const root = document.getElementById("app");
  renderCustomerApp(root, { hash: "#/", onCreate() {} });
  assert.ok(root.querySelector("[data-mascot]"));
  assert.match(root.textContent, /Meet tenwhy/);
  assert.ok(root.querySelector("[data-idea]"));
  assert.ok(root.querySelector("[data-url]"));
  assert.equal(parseCustomerHash("#/e/eng_x").view, "loading");

  const { loop_runs, events } = fixtureEvents();
  renderCustomerApp(root, {
    hash: "#/e/eng_x",
    engagement: { id: "eng_x", status: "running" },
    events: events.slice(0, 2),
    loop_runs,
  });
  assert.ok(root.querySelector("[data-mascot]"));
  assert.equal(root.querySelectorAll("[data-step]").length, 5);
  assert.equal(root.querySelector("[data-step='1']").classList.contains("done"), true);
  assert.equal(root.querySelector("[data-step='2']").classList.contains("done"), true);
  assert.equal(root.querySelector("[data-step='3']").classList.contains("active"), true);
  assert.match(root.textContent, /you can keep this page open/);
});

test("results tabs render research, website preview, and both action controls", () => {
  const dom = new JSDOM("<!DOCTYPE html><div id='app'></div><div id='portal'></div>", { url: "http://127.0.0.1:4310/customer.html" });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLCanvasElement = dom.window.HTMLCanvasElement;
  globalThis.Image = dom.window.Image;
  installGridTestStubs();
  const root = document.getElementById("app");
  const research = {
    company: { summary: "Neighborhood cafe" },
    competitors: [{ name: "Nord Kaffe", url: "https://nordkaffe.example/menu", summary: "Filter coffee rival", products: [{ name: "Filter", price: 4.5 }] }],
    enhancement_ideas: [{ idea: "Calm weekday lunches", rationale: "observed" }],
  };
  const comparison = {
    columns: [{ label: "customer product" }, { label: "competitor" }],
    rows: [{ cells: [{ value: "Drip coffee", state: "valid" }, { value: "Nord", state: "flagged" }] }],
  };
  renderCustomerApp(root, {
    hash: "#/e/eng_0143/results",
    engagement: { id: "eng_0143", status: "awaiting_approval" },
    research,
    comparison,
    pages: [{ path: "/index.html", title: "Harbor & Finch" }, { path: "/contact.html", title: "Contact" }],
    tab: "research",
  });
  assert.match(root.textContent, /Neighborhood cafe/);
  assert.equal(root.querySelectorAll("[data-card='research-grid']").length, 1);
  assert.ok(root.querySelector("[data-approve]"));
  assert.ok(root.querySelector("[data-request]"));
  assert.equal(root.querySelector("[data-approve]").textContent, "Approve & launch");
  renderCustomerApp(root, {
    hash: "#/e/eng_0143/results",
    engagement: { id: "eng_0143", status: "awaiting_approval" },
    research,
    comparison,
    pages: [{ path: "/index.html", title: "Harbor & Finch" }],
    tab: "design",
  });
  const iframe = root.querySelector("iframe");
  assert.ok(iframe);
  assert.equal(iframe.getAttribute("sandbox"), "allow-scripts");
  assert.equal(iframe.getAttribute("src"), "/preview/eng_0143/");
  assert.match(root.textContent, /Harbor & Finch/);
  assert.ok(root.querySelector("[data-approve]"));
  assert.ok(root.querySelector("[data-request]"));
});

test("results launching, 409 copy, and rebuilding loading copy", () => {
  const dom = new JSDOM("<!DOCTYPE html><div id='app'></div><div id='portal'></div>", { url: "http://127.0.0.1:4310/customer.html" });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLCanvasElement = dom.window.HTMLCanvasElement;
  globalThis.Image = dom.window.Image;
  installGridTestStubs();
  const root = document.getElementById("app");
  renderCustomerApp(root, {
    hash: "#/e/eng_0143/results",
    engagement: { id: "eng_0143", status: "awaiting_approval" },
    launching: true,
    busy: true,
  });
  assert.equal(root.querySelector("[data-approve]").textContent, "launching…");
  assert.equal(root.querySelector("[data-approve]").disabled, true);
  assert.equal(root.querySelector("[data-request]").disabled, true);
  renderCustomerApp(root, {
    hash: "#/e/eng_0143/results",
    engagement: { id: "eng_0143", status: "awaiting_approval" },
    error: "this project isn't waiting for approval right now",
  });
  assert.equal(root.querySelector("[data-error]").textContent, "this project isn't waiting for approval right now");
  renderCustomerApp(root, {
    hash: "#/e/eng_x",
    engagement: { id: "eng_x", status: "running" },
    rebuilding: true,
    events: [],
    loop_runs: [],
  });
  assert.match(root.textContent, /Rebuilding with your notes/);
  assert.match(root.textContent, /rebuilding with your notes/);
});

class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.listeners = {};
    FakeEventSource.last = this;
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  close() {}
  emit(data) {
    const ev = { data: JSON.stringify(data) };
    return Promise.all((this.listeners.patch || []).map((fn) => Promise.resolve(fn(ev))));
  }
}

function jsonRes(body, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
  };
}

test("loading EventSource patches advance steps and navigate on awaiting_approval", async () => {
  const dom = new JSDOM("<!DOCTYPE html><div id='app'></div><div id='portal'></div>", { url: "http://127.0.0.1:4310/customer.html" });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLCanvasElement = dom.window.HTMLCanvasElement;
  globalThis.Image = dom.window.Image;
  installGridTestStubs();
  const root = document.getElementById("app");
  let hash = "#/e/eng_x";
  const loop_runs = [
    { id: "run_res", loop_name: "company-research" },
    { id: "run_web", loop_name: "website" },
  ];
  const session = createCustomerSession({
    EventSource: FakeEventSource,
    getHash: () => hash,
    setHash: (h) => {
      hash = h;
    },
    fetch: async (url) => {
      if (String(url).includes("/research")) {
        return jsonRes({ research: { company: { summary: "x" } }, comparison: { columns: [], rows: [] } });
      }
      if (String(url).includes("preview-manifest")) return jsonRes({ pages: [] });
      return jsonRes({
        engagement: { id: "eng_x", status: "running" },
        events: [],
        loop_runs,
        lastEventId: 0,
      });
    },
    render: (state) => {
      renderCustomerApp(root, {
        hash,
        engagement: state.engagement,
        events: state.events,
        loop_runs: state.loop_runs,
      });
    },
  });
  await session.paint();
  assert.match(FakeEventSource.last.url, /engagement=eng_x/);
  const events = [
    { id: 1, kind: "loop_run.started", loop_run_id: "run_res", payload: { loopName: "company-research" } },
    { id: 2, kind: "iteration.recorded", loop_run_id: "run_res", payload: { n: 1 } },
    { id: 3, kind: "gate.checked", loop_run_id: "run_res", payload: { passed: true } },
    { id: 4, kind: "iteration.recorded", loop_run_id: "run_web", payload: { n: 1 } },
    { id: 5, kind: "gate.checked", loop_run_id: "run_web", payload: { passed: true } },
  ];
  for (const ev of events) await FakeEventSource.last.emit(ev);
  assert.equal(loadingProgress({ events: session.state.events, loop_runs }).completed, 5);
  assert.equal(root.querySelectorAll("[data-step].done").length, 5);
  await FakeEventSource.last.emit({
    id: 6,
    kind: "engagement.awaiting_approval",
    entities: { engagements: [{ id: "eng_x", status: "awaiting_approval" }] },
  });
  assert.equal(hash, "#/e/eng_x/results");
});

test("direct results route fetches research and preview-manifest before render", async () => {
  const dom = new JSDOM("<!DOCTYPE html><div id='app'></div><div id='portal'></div>", { url: "http://127.0.0.1:4310/customer.html" });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLCanvasElement = dom.window.HTMLCanvasElement;
  globalThis.Image = dom.window.Image;
  installGridTestStubs();
  const root = document.getElementById("app");
  let hash = "#/e/eng_0143/results";
  const fetched = [];
  const session = createCustomerSession({
    EventSource: FakeEventSource,
    getHash: () => hash,
    setHash: (h) => {
      hash = h;
    },
    fetch: async (url) => {
      fetched.push(String(url));
      if (String(url).includes("/research")) {
        return jsonRes({
          research: {
            company: { summary: "Neighborhood cafe" },
            competitors: [{ name: "Nord", url: "https://nord.example", summary: "rival", products: [] }],
            enhancement_ideas: [{ idea: "Calm lunches" }],
          },
          comparison: { columns: [{ label: "customer product" }], rows: [{ cells: [{ value: "Drip", state: "valid" }] }] },
        });
      }
      if (String(url).includes("preview-manifest")) {
        return jsonRes({ pages: [{ path: "/index.html", title: "Harbor & Finch" }] });
      }
      return jsonRes({
        engagement: { id: "eng_0143", status: "awaiting_approval" },
        events: [],
        loop_runs: [],
        lastEventId: 0,
      });
    },
    render: (state) => {
      renderCustomerApp(root, {
        hash,
        engagement: state.engagement,
        research: state.research,
        comparison: state.comparison,
        pages: state.pages,
        tab: "research",
      });
    },
  });
  await session.paint();
  assert.ok(fetched.some((u) => u.includes("/api/engagements/eng_0143/research")));
  assert.ok(fetched.some((u) => u.includes("/preview-manifest")));
  assert.match(root.textContent, /Neighborhood cafe/);
  assert.equal(root.querySelectorAll("[data-card='research-grid']").length, 1);
  assert.ok(root.querySelector("[data-approve]"));
  session.state.tab = "design";
  hash = "#/e/eng_0143/results";
  await session.paint();
  renderCustomerApp(root, {
    hash,
    engagement: session.state.engagement,
    research: session.state.research,
    comparison: session.state.comparison,
    pages: session.state.pages,
    tab: "design",
  });
  assert.match(root.textContent, /Harbor & Finch/);
});

test("awaiting_approval SSE patch loads research before rendering results", async () => {
  const dom = new JSDOM("<!DOCTYPE html><div id='app'></div><div id='portal'></div>", { url: "http://127.0.0.1:4310/customer.html" });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLCanvasElement = dom.window.HTMLCanvasElement;
  globalThis.Image = dom.window.Image;
  installGridTestStubs();
  const root = document.getElementById("app");
  let hash = "#/e/eng_x";
  const calls = [];
  let status = "running";
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const session = createCustomerSession({
    EventSource: FakeEventSource,
    getHash: () => hash,
    setHash: (h) => {
      hash = h;
    },
    fetch: async (url) => {
      const path = String(url);
      calls.push(path);
      if (path.includes("/research")) {
        await gate;
        return jsonRes({
          research: { company: { summary: "Neighborhood cafe" }, competitors: [], enhancement_ideas: [] },
          comparison: { columns: [{ label: "customer product" }], rows: [{ cells: [{ value: "Drip", state: "valid" }] }] },
        });
      }
      if (path.includes("preview-manifest")) {
        await gate;
        return jsonRes({ pages: [{ path: "/index.html", title: "Harbor & Finch" }] });
      }
      return jsonRes({
        engagement: { id: "eng_x", status },
        events: [],
        loop_runs: [],
        lastEventId: 0,
      });
    },
    render: (state) => {
      renderCustomerApp(root, {
        hash,
        engagement: state.engagement,
        research: state.research,
        comparison: state.comparison,
        pages: state.pages,
        events: state.events,
        loop_runs: state.loop_runs,
      });
    },
  });
  await session.paint();
  assert.equal(hash, "#/e/eng_x");
  assert.equal(root.querySelector("[data-approve]"), null);
  assert.doesNotMatch(root.textContent, /Neighborhood cafe/);
  const before = calls.length;
  status = "awaiting_approval";
  const pending = FakeEventSource.last.emit({
    id: 1,
    kind: "engagement.awaiting_approval",
    entities: { engagements: [{ id: "eng_x", status: "awaiting_approval" }] },
  });
  await Promise.resolve();
  await Promise.resolve();
  const afterPatch = calls.slice(before);
  assert.ok(afterPatch.some((u) => u.includes("/research")), afterPatch);
  assert.ok(afterPatch.some((u) => u.includes("preview-manifest")), afterPatch);
  assert.equal(root.querySelector("[data-approve]"), null);
  assert.doesNotMatch(root.textContent, /Neighborhood cafe/);
  release();
  await pending;
  await session.paint();
  assert.equal(hash, "#/e/eng_x/results");
  assert.match(root.textContent, /Neighborhood cafe/);
  assert.ok(root.querySelector("[data-approve]"));
  assert.equal(session.state.research?.company?.summary, "Neighborhood cafe");
});

test("request-changes clears website step events until the new run's gate passes", async () => {
  const dom = new JSDOM("<!DOCTYPE html><div id='app'></div><div id='portal'></div>", { url: "http://127.0.0.1:4310/customer.html" });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLCanvasElement = dom.window.HTMLCanvasElement;
  globalThis.Image = dom.window.Image;
  installGridTestStubs();
  const root = document.getElementById("app");
  let hash = "#/e/eng_x/results";
  const loop_runs = [
    { id: "run_res", loop_name: "company-research" },
    { id: "run_web", loop_name: "website" },
  ];
  const events = [
    { id: 1, kind: "loop_run.started", loop_run_id: "run_res", payload: { loopName: "company-research" } },
    { id: 2, kind: "iteration.recorded", loop_run_id: "run_res", payload: { n: 1 } },
    { id: 3, kind: "gate.checked", loop_run_id: "run_res", payload: { passed: true } },
    { id: 4, kind: "iteration.recorded", loop_run_id: "run_web", payload: { n: 1 } },
    { id: 5, kind: "gate.checked", loop_run_id: "run_web", payload: { passed: true } },
  ];
  const session = createCustomerSession({
    EventSource: FakeEventSource,
    getHash: () => hash,
    setHash: (h) => {
      hash = h;
    },
    fetch: async (url, opts) => {
      if (opts?.method === "POST") return jsonRes({ ok: true, id: "apr_1" }, true, 200);
      if (String(url).includes("/research")) {
        return jsonRes({ research: { company: { summary: "x" } }, comparison: null });
      }
      if (String(url).includes("preview-manifest")) return jsonRes({ pages: [] });
      return jsonRes({
        engagement: { id: "eng_x", status: "awaiting_approval" },
        events,
        loop_runs,
        lastEventId: 5,
      });
    },
    render: (state) => {
      renderCustomerApp(root, {
        hash,
        engagement: state.engagement,
        events: state.events,
        loop_runs: state.loop_runs,
        rebuilding: state.rebuilding,
        research: state.research,
        pages: state.pages,
      });
    },
  });
  await session.paint();
  session.state.showNotes = true;
  await session.onRequest("darker green");
  assert.equal(hash, "#/e/eng_x");
  assert.equal(session.state.rebuilding, true);
  const after = loadingProgress({ events: session.state.events, loop_runs: session.state.loop_runs });
  assert.ok(after.completed < 5, after);
  assert.equal(after.completed, 2); // research passed, website events cleared → planning active
  await session.paint();
  assert.equal(root.querySelector("[data-step='5']").classList.contains("done"), false);
  assert.match(root.textContent, /[Rr]ebuilding with your notes/);
  session.state.loop_runs = [...session.state.loop_runs, { id: "run_web2", loop_name: "website" }];
  await FakeEventSource.last.emit({
    id: 10,
    kind: "iteration.recorded",
    loop_run_id: "run_web2",
    payload: { n: 1 },
    entities: { loop_runs: [{ id: "run_web2", loop_name: "website" }] },
  });
  assert.equal(loadingProgress({ events: session.state.events, loop_runs: session.state.loop_runs }).completed, 3); // new website iteration → building active
  await FakeEventSource.last.emit({
    id: 11,
    kind: "gate.checked",
    loop_run_id: "run_web2",
    payload: { passed: true },
  });
  assert.equal(loadingProgress({ events: session.state.events, loop_runs: session.state.loop_runs }).completed, 5);
});

test("reload mid-rebuild does not mark step 5 done until the new website run's gate passes", async () => {
  const dom = new JSDOM("<!DOCTYPE html><div id='app'></div><div id='portal'></div>", { url: "http://127.0.0.1:4310/customer.html" });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLCanvasElement = dom.window.HTMLCanvasElement;
  globalThis.Image = dom.window.Image;
  installGridTestStubs();
  const root = document.getElementById("app");
  let hash = "#/e/eng_x";
  const loop_runs = [
    { id: "run_res", loop_name: "company-research", started_at: "2026-08-30T20:00:00Z" },
    { id: "run_web", loop_name: "website", started_at: "2026-08-30T20:10:00Z" },
    { id: "run_web2", loop_name: "website", started_at: "2026-08-30T21:00:00Z" },
  ];
  const events = [
    { id: 1, kind: "loop_run.started", loop_run_id: "run_res", payload: { loopName: "company-research" }, created_at: "2026-08-30T20:00:00Z" },
    { id: 2, kind: "iteration.recorded", loop_run_id: "run_res", payload: { n: 1 }, created_at: "2026-08-30T20:05:00Z" },
    { id: 3, kind: "gate.checked", loop_run_id: "run_res", payload: { passed: true }, created_at: "2026-08-30T20:06:00Z" },
    { id: 4, kind: "iteration.recorded", loop_run_id: "run_web", payload: { n: 1 }, created_at: "2026-08-30T20:15:00Z" },
    { id: 5, kind: "gate.checked", loop_run_id: "run_web", payload: { passed: true }, created_at: "2026-08-30T20:20:00Z" },
    { id: 6, kind: "engagement.change_requested", loop_run_id: "run_web2", payload: { runId: "run_web2" }, created_at: "2026-08-30T21:00:00Z" },
    { id: 7, kind: "iteration.recorded", loop_run_id: "run_web2", payload: { n: 1 }, created_at: "2026-08-30T21:01:00Z" },
  ];
  const approvals = [{ id: "apr_1", action: "request_changes", created_at: "2026-08-30T20:59:00Z" }];
  const session = createCustomerSession({
    EventSource: FakeEventSource,
    getHash: () => hash,
    setHash: (h) => {
      hash = h;
    },
    fetch: async (url) => {
      if (String(url).includes("/research") || String(url).includes("preview-manifest")) {
        return jsonRes({ research: null, comparison: null, pages: [] });
      }
      return jsonRes({
        engagement: { id: "eng_x", status: "running" },
        events,
        loop_runs,
        approvals,
        lastEventId: 7,
      });
    },
    render: (state) => {
      renderCustomerApp(root, {
        hash,
        engagement: state.engagement,
        events: state.events,
        loop_runs: state.loop_runs,
        approvals: state.approvals,
        staleWebsiteRunIds: state.staleWebsiteRunIds,
        rebuilding: state.rebuilding,
      });
    },
  });
  await session.paint();
  assert.equal(hash, "#/e/eng_x");
  assert.equal(session.state.rebuilding, true);
  assert.ok(session.state.staleWebsiteRunIds.has("run_web"));
  assert.equal(session.state.staleWebsiteRunIds.has("run_web2"), false);
  const mid = loadingProgress({
    events: session.state.events,
    loop_runs: session.state.loop_runs,
    approvals: session.state.approvals,
  });
  assert.equal(mid.completed, 3, mid); // rebuilding: building active until the new run's gate passes
  assert.equal(root.querySelector("[data-step='5']").classList.contains("done"), false);
  await FakeEventSource.last.emit({
    id: 11,
    kind: "gate.checked",
    loop_run_id: "run_web2",
    payload: { passed: true },
  });
  assert.equal(
    loadingProgress({
      events: session.state.events,
      loop_runs: session.state.loop_runs,
      approvals: session.state.approvals,
    }).completed,
    5,
  );
  await session.paint();
  assert.equal(root.querySelector("[data-step='5']").classList.contains("done"), true);
});

test("retry website run after a change-request is live and advances steps", () => {
  const loop_runs = [
    { id: "run_res", loop_name: "company-research", started_at: "2026-08-30T20:00:00Z" },
    { id: "run_web", loop_name: "website", started_at: "2026-08-30T20:10:00Z" },
    { id: "run_web2", loop_name: "website", started_at: "2026-08-30T21:00:00Z", attempt: 0 },
    { id: "run_web3", loop_name: "website", started_at: "2026-08-30T21:10:00Z", attempt: 1 },
  ];
  const events = [
    { id: 1, kind: "loop_run.started", loop_run_id: "run_res", payload: { loopName: "company-research" }, created_at: "2026-08-30T20:00:00Z" },
    { id: 2, kind: "iteration.recorded", loop_run_id: "run_res", payload: { n: 1 }, created_at: "2026-08-30T20:05:00Z" },
    { id: 3, kind: "gate.checked", loop_run_id: "run_res", payload: { passed: true }, created_at: "2026-08-30T20:06:00Z" },
    { id: 4, kind: "iteration.recorded", loop_run_id: "run_web", payload: { n: 1 }, created_at: "2026-08-30T20:15:00Z" },
    { id: 5, kind: "gate.checked", loop_run_id: "run_web", payload: { passed: true }, created_at: "2026-08-30T20:20:00Z" },
    { id: 6, kind: "engagement.change_requested", loop_run_id: "run_web2", payload: { runId: "run_web2" }, created_at: "2026-08-30T21:00:00Z" },
    { id: 7, kind: "approval.processed", payload: { action: "request_changes" }, created_at: "2026-08-30T21:00:00Z" },
    { id: 8, kind: "iteration.recorded", loop_run_id: "run_web2", payload: { n: 1 }, created_at: "2026-08-30T21:01:00Z" },
    { id: 9, kind: "gate.checked", loop_run_id: "run_web2", payload: { passed: false }, created_at: "2026-08-30T21:02:00Z" },
  ];
  const stale = deriveStaleWebsiteRunIds({ events, loop_runs });
  assert.ok(stale.has("run_web"));
  assert.equal(stale.has("run_web2"), false);
  assert.equal(stale.has("run_web3"), false);
  const afterFail = loadingProgress({ events, loop_runs });
  assert.equal(afterFail.completed, 4, afterFail);
  assert.equal(afterFail.hold, true);
  events.push({
    id: 10,
    kind: "iteration.recorded",
    loop_run_id: "run_web3",
    payload: { n: 1 },
    created_at: "2026-08-30T21:11:00Z",
  });
  assert.equal(loadingProgress({ events, loop_runs }).completed, 4);
  events.push({
    id: 11,
    kind: "gate.checked",
    loop_run_id: "run_web3",
    payload: { passed: true },
    created_at: "2026-08-30T21:12:00Z",
  });
  const afterRetry = loadingProgress({ events, loop_runs });
  assert.equal(afterRetry.completed, 5, afterRetry);
  assert.equal(afterRetry.hold, false);
});

test("approve and request-changes treat only 2xx as success", async () => {
  const dom = new JSDOM("<!DOCTYPE html><div id='app'></div><div id='portal'></div>", { url: "http://127.0.0.1:4310/customer.html" });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLCanvasElement = dom.window.HTMLCanvasElement;
  globalThis.Image = dom.window.Image;
  installGridTestStubs();
  const root = document.getElementById("app");
  let hash = "#/e/eng_x/results";
  let next = { status: 200, ok: true, body: { ok: true, id: "apr_x" } };
  const session = createCustomerSession({
    EventSource: FakeEventSource,
    getHash: () => hash,
    setHash: (h) => {
      hash = h;
    },
    fetch: async (url, opts) => {
      if (opts?.method === "POST") {
        if (next.throw) throw new Error("network");
        return jsonRes(next.body || {}, next.ok, next.status);
      }
      return jsonRes({
        engagement: { id: "eng_x", status: "awaiting_approval" },
        events: [],
        loop_runs: [],
        lastEventId: 0,
      });
    },
    render: (state) => {
      renderCustomerApp(root, {
        hash,
        engagement: state.engagement,
        busy: state.busy,
        error: state.error,
        launching: state.launching,
        showNotes: state.showNotes,
      });
    },
  });
  await session.paint();

  next = { status: 409, ok: false, body: { error: "nope" } };
  await session.onApprove();
  assert.equal(session.state.error, "this project isn't waiting for approval right now");
  assert.equal(session.state.launching, false);
  assert.equal(session.state.busy, false);
  assert.equal(hash, "#/e/eng_x/results");

  next = { status: 403, ok: false, body: { error: "forbidden" } };
  await session.onApprove();
  assert.equal(session.state.error, "couldn't submit — try again");
  assert.equal(session.state.launching, false);
  assert.equal(root.querySelector("[data-approve]").disabled, false);

  next = { status: 500, ok: false, body: { error: "boom" } };
  await session.onApprove();
  assert.equal(session.state.error, "couldn't submit — try again");

  next = { throw: true };
  await session.onApprove();
  assert.equal(session.state.error, "couldn't submit — try again");
  assert.equal(hash, "#/e/eng_x/results");

  session.state.showNotes = true;
  next = { status: 400, ok: false, body: { error: "notes required" } };
  await session.onRequest("x");
  assert.equal(session.state.error, "notes required");
  assert.equal(hash, "#/e/eng_x/results");

  session.state.showNotes = true;
  next = { status: 403, ok: false, body: {} };
  await session.onRequest("please change the hero");
  assert.equal(session.state.error, "couldn't submit — try again");
  assert.equal(hash, "#/e/eng_x/results");
  assert.equal(session.state.rebuilding, false);

  session.state.showNotes = true;
  next = { status: 200, ok: true, body: { ok: true, id: "apr_ok" } };
  await session.onRequest("please change the hero");
  assert.equal(hash, "#/e/eng_x");
  assert.equal(session.state.rebuilding, true);
});
