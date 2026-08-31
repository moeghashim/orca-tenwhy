import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { parseCustomerHash, renderCustomerApp } from "./src/customer/app.js";
import { loadingProgress } from "./src/customer/progress.js";
import { createCustomerSession } from "./src/customer/session.js";

function fixtureEvents() {
  const loop_runs = [
    { id: "run_res", loop_name: "company-research" },
    { id: "run_web", loop_name: "website" },
  ];
  const events = [
    { kind: "loop_run.started", loop_run_id: "run_res", payload: { loopName: "company-research" } },
    { kind: "iteration.recorded", loop_run_id: "run_res", payload: { n: 1 } },
    { kind: "gate.checked", loop_run_id: "run_res", payload: { passed: true } },
    { kind: "iteration.recorded", loop_run_id: "run_web", payload: { n: 1 } },
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
  const held = loadingProgress({ events: failOnly, loop_runs });
  assert.equal(held.completed, 4);
  assert.equal(held.activeIndex, 4);
  assert.equal(held.hold, true);
});

test("start and loading markup include mascot and five steps", () => {
  const dom = new JSDOM("<!DOCTYPE html><div id='app'></div>", { url: "http://127.0.0.1:4310/customer.html" });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
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
  const dom = new JSDOM("<!DOCTYPE html><div id='app'></div>", { url: "http://127.0.0.1:4310/customer.html" });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
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
  assert.match(root.textContent, /Nord Kaffe/);
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
  const dom = new JSDOM("<!DOCTYPE html><div id='app'></div>", { url: "http://127.0.0.1:4310/customer.html" });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
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
    for (const fn of this.listeners.patch || []) fn({ data: JSON.stringify(data) });
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
  const dom = new JSDOM("<!DOCTYPE html><div id='app'></div>", { url: "http://127.0.0.1:4310/customer.html" });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
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
  for (const ev of events) FakeEventSource.last.emit(ev);
  assert.equal(loadingProgress({ events: session.state.events, loop_runs }).completed, 5);
  assert.equal(root.querySelectorAll("[data-step].done").length, 5);
  FakeEventSource.last.emit({
    id: 6,
    kind: "engagement.awaiting_approval",
    entities: { engagements: [{ id: "eng_x", status: "awaiting_approval" }] },
  });
  assert.equal(hash, "#/e/eng_x/results");
});

test("direct results route fetches research and preview-manifest before render", async () => {
  const dom = new JSDOM("<!DOCTYPE html><div id='app'></div>", { url: "http://127.0.0.1:4310/customer.html" });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
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
  assert.match(root.textContent, /Harbor & Finch|Nord/);
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
