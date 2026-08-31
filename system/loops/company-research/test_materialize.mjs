import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { historyEntries } from "../../orchestrator/knowledge.mjs";
import { materialize } from "./materialize.mjs";

function fencedPayload() {
  const payload = {
    RESEARCH: {
      company: { name: "Acme", summary: "x", customer_products: [{ id: "cp_01", name: "W", price: null, url: "" }] },
      competitors: [],
      product_matches: [],
      enhancement_ideas: [],
    },
    SOURCES_MD: "| url | http_status | note |\n| https://example.com | 200 | ok |\n",
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

test("two materializations append two History lines; first line unchanged", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tenwhy-hist-"));
  const workdir = path.join(tmp, "work");
  fs.mkdirSync(workdir);
  const outputPath = path.join(workdir, "out.txt");
  fs.writeFileSync(outputPath, fencedPayload());
  const first = await materialize({
    outputPath,
    workdir,
    traceRef: "pi://session/one",
    now: "2026-08-30T22:00:00Z",
  });
  assert.equal(first.ok, true);
  const sources1 = fs.readFileSync(path.join(workdir, "research/SOURCES.md"), "utf8");
  const hist1 = historyEntries(sources1);
  assert.equal(hist1.length, 1);
  const second = await materialize({
    outputPath,
    workdir,
    traceRef: "pi://session/two",
    now: "2026-08-30T23:00:00Z",
  });
  assert.equal(second.ok, true);
  const sources2 = fs.readFileSync(path.join(workdir, "research/SOURCES.md"), "utf8");
  assert.match(sources2, /^---\nupdated: 2026-08-30T23:00:00Z\ntrace: pi:\/\/session\/two\n/m);
  const hist2 = historyEntries(sources2);
  assert.equal(hist2.length, 2);
  assert.equal(hist2[0], hist1[0]);
  assert.match(hist2[1], /pi:\/\/session\/two/);
  fs.rmSync(tmp, { recursive: true, force: true });
});
