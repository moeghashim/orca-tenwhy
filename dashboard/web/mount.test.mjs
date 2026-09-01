import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { renderCustomerApp } from "./src/customer/app.js";
import { installGridTestStubs } from "./src/research-grid/canvas-stub.js";
import { myjamResearch } from "./src/research-grid/fixture.js";
import { mountResearchGrid } from "./src/research-grid/mount.js";

function setupDom() {
  const dom = new JSDOM("<!DOCTYPE html><html><body><div id='app'></div><div id='portal'></div></body></html>", {
    url: "http://127.0.0.1:4310/customer.html",
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLCanvasElement = dom.window.HTMLCanvasElement;
  globalThis.Image = dom.window.Image;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  installGridTestStubs();
  return dom;
}

test("mountResearchGrid renders one root, update keeps it, unmount removes it", () => {
  setupDom();
  const host = document.createElement("div");
  document.body.append(host);
  const handle = mountResearchGrid(host, { research: myjamResearch(), variant: "customer" });
  assert.equal(host.querySelectorAll(".research-grid").length, 1);
  assert.equal(document.querySelectorAll("#portal").length, 1);
  handle.update({ research: myjamResearch() });
  assert.equal(host.querySelectorAll(".research-grid").length, 1);
  handle.unmount();
  assert.equal(host.querySelectorAll(".research-grid").length, 0);
});

test("customer results mounts exactly one grid; re-render does not create a second #portal", () => {
  setupDom();
  const root = document.getElementById("app");
  const research = myjamResearch();
  renderCustomerApp(root, {
    hash: "#/e/eng_0143/results",
    engagement: { id: "eng_0143", status: "awaiting_approval" },
    research,
    tab: "research",
  });
  assert.equal(root.querySelectorAll("[data-card='research-grid']").length, 1);
  assert.equal(root.querySelectorAll("[data-card='research-grid'] .research-grid").length, 1);
  assert.equal(document.querySelectorAll("#portal").length, 1);
  renderCustomerApp(root, {
    hash: "#/e/eng_0143/results",
    engagement: { id: "eng_0143", status: "awaiting_approval" },
    research,
    tab: "research",
  });
  assert.equal(root.querySelectorAll("[data-card='research-grid']").length, 1);
  assert.equal(root.querySelectorAll("[data-card='research-grid'] .research-grid").length, 1);
  assert.equal(document.querySelectorAll("#portal").length, 1);
});
