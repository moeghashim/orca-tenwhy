import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createOrchestratorModelFixture } from "./adapters/fixture.mjs";
import { generateCustomerRepo, lintFrontmatter, publishCustomerRepo } from "./customer_repo.mjs";
import { absorbResearch, historyEntries } from "./knowledge.mjs";
import { utcNow } from "./util.mjs";

const RESEARCH = {
  company: {
    name: "Acme Dental",
    summary: "Clinic in Amman",
    customer_products: [{ id: "p1", name: "Whitening" }],
  },
  competitors: [{ name: "BrightSmile", url: "https://bright.example", summary: "rival" }],
};

function writeEmptyHistory(dir, now) {
  for (const [rel, title] of [
    ["company/OVERVIEW.md", "Overview"],
    ["company/POSITIONING.md", "Positioning"],
    ["company/FINDINGS.md", "Findings"],
  ]) {
    fs.writeFileSync(
      path.join(dir, rel),
      `---\nupdated: ${now}\ntrace: none\n---\n\n# ${title}\n\noriginal ${title} body\n\n## History\n`,
      "utf8",
    );
  }
}

test("absorb rewrites synthesis, appends History, never rewrites prior lines", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tenwhy-kb-"));
  const dir = path.join(tmp, "acme");
  const remotesDir = path.join(tmp, "remotes");
  const t0 = utcNow();
  generateCustomerRepo({
    slug: "acme",
    customerName: "Acme Dental",
    idea: "clinic",
    siteUrl: "https://example.com",
    targetDir: dir,
    now: t0,
  });
  publishCustomerRepo({ dir, slug: "acme", backend: "local", remotesDir });
  writeEmptyHistory(dir, t0);

  const model = createOrchestratorModelFixture({
    synthesis: ({ targetRel, researchJson }) =>
      `SYNTH-1 ${targetRel} for ${researchJson.company.name}`,
  });
  const t1 = "2026-08-30T22:00:00Z";
  await absorbResearch({
    repoDir: dir,
    researchJson: RESEARCH,
    traceRef: "fixture://absorb/1",
    model,
    now: t1,
    loopRunId: "run_abs1",
  });

  const overview1 = fs.readFileSync(path.join(dir, "company/OVERVIEW.md"), "utf8");
  assert.match(overview1, /updated: 2026-08-30T22:00:00Z/);
  assert.match(overview1, /trace: fixture:\/\/absorb\/1/);
  assert.match(overview1, /SYNTH-1 company\/OVERVIEW.md for Acme Dental/);
  assert.doesNotMatch(overview1, /original Overview body/);
  const hist1 = historyEntries(overview1);
  assert.equal(hist1.length, 1);
  assert.match(hist1[0], /fixture:\/\/absorb\/1/);
  assert.ok(fs.existsSync(path.join(dir, "company/competitors/brightsmile.md")));
  assert.ok(fs.existsSync(path.join(dir, "company/products/whitening.md")));
  assert.deepEqual(lintFrontmatter(dir), []);

  const model2 = createOrchestratorModelFixture({
    synthesis: ({ targetRel }) => `SYNTH-2 ${targetRel}`,
  });
  const t2 = "2026-08-30T23:00:00Z";
  await absorbResearch({
    repoDir: dir,
    researchJson: RESEARCH,
    traceRef: "fixture://absorb/2",
    model: model2,
    now: t2,
    loopRunId: "run_abs2",
  });

  const overview2 = fs.readFileSync(path.join(dir, "company/OVERVIEW.md"), "utf8");
  assert.match(overview2, /SYNTH-2 company\/OVERVIEW.md/);
  assert.doesNotMatch(overview2, /SYNTH-1 /);
  const hist2 = historyEntries(overview2);
  assert.equal(hist2.length, 2);
  assert.equal(hist2[0], hist1[0]);
  assert.match(hist2[1], /fixture:\/\/absorb\/2/);
  assert.deepEqual(lintFrontmatter(dir), []);
  fs.rmSync(tmp, { recursive: true, force: true });
});
