import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { materialize } from "./materialize.mjs";

function fencedPayload() {
  const payload = {
    RESEARCH: {
      company: { name: "Acme", summary: "x", customer_products: [{ id: "cp_01", name: "W", price: null, url: "" }] },
      competitors: [],
      product_matches: [],
      enhancement_ideas: [],
    },
    SOURCES_MD: "| url | http_status | note |\n",
  };
  return `\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`\n`;
}

test("refuse to write when research/ symlink points outside workdir", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tenwhy-escape-"));
  const workdir = path.join(tmp, "work");
  const outside = path.join(tmp, "outside");
  fs.mkdirSync(workdir);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(workdir, "research"));
  const outputPath = path.join(workdir, "out.txt");
  fs.writeFileSync(outputPath, fencedPayload());
  const mat = await materialize({ outputPath, workdir, traceRef: "fixture://t" });
  assert.equal(mat.ok, false);
  assert.match(mat.error, /escapes workdir/);
  assert.equal(fs.existsSync(path.join(outside, "RESEARCH.json")), false);
  fs.rmSync(tmp, { recursive: true, force: true });
});
