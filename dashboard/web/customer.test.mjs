import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { parseCustomerHash, renderCustomerApp } from "./src/customer/app.js";
import { loadingProgress } from "./src/customer/progress.js";

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
