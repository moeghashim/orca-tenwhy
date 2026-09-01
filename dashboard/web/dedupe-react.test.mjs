import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../tools/dedupe_react.mjs");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dedupe-react-"));
}

function nm(root) {
  return path.join(root, "dashboard/vendor/tengrids/node_modules");
}

function writeTree(dir, files) {
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
}

function run(root) {
  return spawnSync(process.execPath, [script, "--root", root], { encoding: "utf8" });
}

test("fake vendor tree: nested react/react-dom removed, others untouched", () => {
  const root = tmp();
  writeTree(root, {
    "dashboard/vendor/tengrids/node_modules/react/package.json": "{}",
    "dashboard/vendor/tengrids/node_modules/react-dom/package.json": "{}",
    "dashboard/vendor/tengrids/node_modules/lodash/package.json": "{\"name\":\"lodash\"}",
    "dashboard/vendor/tengrids/packages/core/node_modules/react/index.js": "module.exports=1",
    "dashboard/vendor/tengrids/packages/core/node_modules/canvas-hypertxt/keep.txt": "keep",
  });
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /removed 3/);
  assert.equal(fs.existsSync(path.join(nm(root), "react")), false);
  assert.equal(fs.existsSync(path.join(nm(root), "react-dom")), false);
  assert.equal(fs.existsSync(path.join(nm(root), "lodash/package.json")), true);
  assert.equal(fs.existsSync(path.join(root, "dashboard/vendor/tengrids/packages/core/node_modules/react")), false);
  assert.equal(
    fs.readFileSync(path.join(root, "dashboard/vendor/tengrids/packages/core/node_modules/canvas-hypertxt/keep.txt"), "utf8"),
    "keep",
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test("node_modules symlink to an outside dir: nothing removed, warning, outside intact", () => {
  const root = tmp();
  const outside = tmp();
  writeTree(outside, { "react/package.json": "{\"name\":\"outside-react\"}" });
  fs.mkdirSync(path.join(root, "dashboard/vendor/tengrids"), { recursive: true });
  fs.symlinkSync(outside, nm(root));
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /symlink segment/);
  assert.match(result.stdout, /nothing to do/);
  assert.equal(fs.existsSync(path.join(outside, "react/package.json")), true);
  assert.equal(fs.readFileSync(path.join(outside, "react/package.json"), "utf8"), "{\"name\":\"outside-react\"}");
  assert.equal(fs.lstatSync(nm(root)).isSymbolicLink(), true);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test("nested react symlink: link removed, outside target intact", () => {
  const root = tmp();
  const outside = tmp();
  writeTree(outside, { "package.json": "{\"name\":\"linked-react\"}" });
  writeTree(root, {
    "dashboard/vendor/tengrids/node_modules/lodash/keep.txt": "keep",
  });
  fs.symlinkSync(outside, path.join(nm(root), "react"));
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /removed 1/);
  assert.equal(fs.existsSync(path.join(nm(root), "react")), false);
  assert.equal(fs.existsSync(path.join(outside, "package.json")), true);
  assert.equal(fs.readFileSync(path.join(outside, "package.json"), "utf8"), "{\"name\":\"linked-react\"}");
  assert.equal(fs.readFileSync(path.join(nm(root), "lodash/keep.txt"), "utf8"), "keep");
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});
