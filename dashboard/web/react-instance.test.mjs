import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fromCore = createRequire(path.join(repo, "dashboard/vendor/tengrids/packages/core/package.json"));
const fromRoot = createRequire(path.join(repo, "package.json"));

test("tengrids core and the root package resolve the same react and react-dom", () => {
  assert.equal(fromCore.resolve("react"), fromRoot.resolve("react"));
  assert.equal(fromCore.resolve("react-dom"), fromRoot.resolve("react-dom"));
});
