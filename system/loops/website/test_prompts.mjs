import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseReviewerVerdict } from "../../orchestrator/loop_runner.mjs";
import { historyEntries } from "../../orchestrator/knowledge.mjs";
import { guardToolCall } from "./path-guard.mjs";
import {
  designPrompt,
  executorPrompt,
  reviewerPrompt,
  renderManifest,
  materializeDesign,
} from "./index.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const PYTHON = path.join(ROOT, "system/tools/.venv/bin/python");
const SCHEMA = path.join(ROOT, "system/gates/brand_tokens_schema.json");

const SOP_CHECKS = [
  "tokens.json validates; logo.svg parses as valid SVG.",
  "`npm run build` exits 0.",
  "0 broken internal links in `dist/`; every IMAGE_BRIEF asset has a placeholder wired at the declared path.",
  "Copy grounded in research: company name + ≥ 3 product names from RESEARCH.json present in `dist/`.",
  "**Lighthouse ≥ 85** (performance + accessibility categories) against `vite preview` of `dist/`.",
];

const RESEARCH = {
  company: {
    name: "Acme Dental",
    summary: "Boutique dental clinic in Amman",
    customer_products: [
      { id: "cp_01", name: "Teeth whitening", price: 80, url: "" },
      { id: "cp_02", name: "Clear aligners", price: 1200, url: "" },
      { id: "cp_03", name: "Hygiene checkup", price: 40, url: "" },
    ],
  },
};

const TOKENS = {
  color: { bg: "#f6f1ea", surface: "#fffaf4", text: "#2a241c", accent: "#1a6b63" },
  type: { family: { ui: "Source Serif 4, Georgia, serif", mono: "IBM Plex Mono, ui-monospace, monospace" } },
  space: { unit: 8 },
  radius: 12,
};

const LOGO =
  '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="48" viewBox="0 0 240 48"><text x="8" y="32" font-family="Georgia" font-size="24" fill="#1a6b63">Acme Dental</text></svg>';

const BRIEF = `| asset | path | description | size |
| --- | --- | --- | --- |
| hero | /images/hero.svg | Clinic reception in warm light | 1200x600 |
| whitening | /images/whitening.svg | Whitening tray close-up | 800x600 |
`;

const VARS = {
  idea: "Boutique dental clinic in Amman",
  site_url: "https://example.com",
  customer_name: "Acme Dental",
  company_name: "Acme Dental",
  products: "Teeth whitening, Clear aligners, Hygiene checkup",
  adjusted_instructions: "Use a calmer teal; avoid stock-photo smiles",
  previous_reviewer_notes: "3. unwired /images/hero.svg",
  previous_gate: "links_ok: fail unwired /images/hero.svg",
  research_json: JSON.stringify(RESEARCH),
  workdir: "/tmp/customer",
  manifest: "### website/package.json\n{}",
};

function designerReply() {
  const payload = {
    tokens: TOKENS,
    BRAND_MD: "Voice: calm, clinical, never salesy.\n\nDo: name treatments verbatim.\nDon't: invent prices.",
    logo_svg: LOGO,
    IMAGE_BRIEF_MD: BRIEF,
  };
  return `Designer notes.\n\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`\n`;
}

function validateTokens(file) {
  const result = spawnSync(
    PYTHON,
    [
      "-c",
      "import json, jsonschema, sys; jsonschema.validate(json.load(open(sys.argv[2])), json.load(open(sys.argv[1]))); print('ok')",
      SCHEMA,
      file,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /ok/);
}

function parseSvgRoot(file) {
  const result = spawnSync(
    PYTHON,
    [
      "-c",
      "import sys, xml.etree.ElementTree as ET; r=ET.parse(sys.argv[1]).getroot(); tag=r.tag.split('}')[-1]; assert tag=='svg', tag; print(tag)",
      file,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout.trim(), "svg");
}

test("design, executor, and reviewer templates render all variables", () => {
  const design = designPrompt(VARS);
  assert.match(design, /Acme Dental/);
  assert.match(design, /Boutique dental clinic in Amman/);
  assert.match(design, /Use a calmer teal/);
  assert.match(design, /Teeth whitening/);
  assert.match(design, /not from tenwhy/);
  const exec = executorPrompt(VARS);
  assert.match(exec, /Boutique dental clinic in Amman/);
  assert.match(exec, /https:\/\/example.com/);
  assert.match(exec, /Acme Dental/);
  assert.match(exec, /Use a calmer teal/);
  assert.match(exec, /3\. unwired \/images\/hero.svg/);
  assert.match(exec, /read.*write.*edit.*ls.*grep.*find/s);
  assert.match(exec, /no shell/);
  const rev = reviewerPrompt(VARS);
  assert.match(rev, /Acme Dental/);
  assert.match(rev, /website\/package\.json/);
  assert.match(rev, /links_ok: fail/);
});

test("reviewerPrompt contains the five SOP §7 check strings", () => {
  const rev = reviewerPrompt(VARS);
  for (const check of SOP_CHECKS) {
    assert.ok(rev.includes(check), `missing check string: ${check}`);
  }
});

test("fixture reviewer reply parses to a valid verdict and notes reference 1.–5.", () => {
  const reply = `Check-by-check:
1. tokens and logo look valid.
2. package.json has a build script.
3. IMAGE_BRIEF paths are listed.
4. company and product names appear.
5. pages are small enough for Lighthouse.

\`\`\`json
{"verdict": "approve", "notes": "1. tokens valid. 2. build script present. 3. placeholders listed. 4. copy grounded. 5. lighthouse likely ≥85."}
\`\`\`
`;
  const parsed = parseReviewerVerdict(reply);
  assert.equal(parsed.verdict, "approve");
  assert.match(parsed.notes, /1\./);
  assert.match(parsed.notes, /2\./);
  assert.match(parsed.notes, /3\./);
  assert.match(parsed.notes, /4\./);
  assert.match(parsed.notes, /5\./);
});

test("materialize_design writes four brand artifacts; tokens schema-valid; logo svg root", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tenwhy-design-"));
  const workdir = path.join(tmp, "work");
  fs.mkdirSync(workdir);
  const outputPath = path.join(workdir, "designer-0.txt");
  fs.writeFileSync(outputPath, designerReply());
  const mat = await materializeDesign({
    outputPath,
    workdir,
    traceRef: "pi://session/design-1",
    now: "2026-08-30T22:00:00Z",
  });
  assert.equal(mat.ok, true, mat.error);
  const tokensPath = path.join(workdir, "brand/tokens.json");
  const logoPath = path.join(workdir, "brand/logo.svg");
  const brandPath = path.join(workdir, "brand/BRAND.md");
  const briefPath = path.join(workdir, "brand/IMAGE_BRIEF.md");
  for (const p of [tokensPath, logoPath, brandPath, briefPath]) {
    assert.equal(fs.existsSync(p), true, p);
  }
  validateTokens(tokensPath);
  parseSvgRoot(logoPath);
  const brand = fs.readFileSync(brandPath, "utf8");
  assert.match(brand, /^---\nupdated: 2026-08-30T22:00:00Z\ntrace: pi:\/\/session\/design-1\n/);
  assert.match(brand, /## History/);
  assert.match(brand, /calm, clinical/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("second materialize_design appends History; first line unchanged", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tenwhy-design-hist-"));
  const workdir = path.join(tmp, "work");
  fs.mkdirSync(workdir);
  const outputPath = path.join(workdir, "out.txt");
  fs.writeFileSync(outputPath, designerReply());
  const first = await materializeDesign({
    outputPath,
    workdir,
    traceRef: "pi://session/one",
    now: "2026-08-30T22:00:00Z",
  });
  assert.equal(first.ok, true);
  const brand1 = fs.readFileSync(path.join(workdir, "brand/BRAND.md"), "utf8");
  const hist1 = historyEntries(brand1);
  assert.equal(hist1.length, 1);
  const second = await materializeDesign({
    outputPath,
    workdir,
    traceRef: "pi://session/two",
    now: "2026-08-30T23:00:00Z",
  });
  assert.equal(second.ok, true);
  const brand2 = fs.readFileSync(path.join(workdir, "brand/BRAND.md"), "utf8");
  assert.match(brand2, /^---\nupdated: 2026-08-30T23:00:00Z\ntrace: pi:\/\/session\/two\n/m);
  const hist2 = historyEntries(brand2);
  assert.equal(hist2.length, 2);
  assert.equal(hist2[0], hist1[0]);
  assert.match(hist2[1], /pi:\/\/session\/two/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("path-guard blocks ../../etc/passwd, symlink write-escape, and /Users read; allows website write and brand read", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tenwhy-guard-"));
  const repo = path.join(tmp, "customer");
  const outside = path.join(tmp, "outside");
  fs.mkdirSync(path.join(repo, "website/src"), { recursive: true });
  fs.mkdirSync(path.join(repo, "brand"));
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(repo, "website/src/main.js"), "console.log(1)\n");
  fs.writeFileSync(path.join(repo, "brand/tokens.json"), "{}\n");
  fs.symlinkSync(outside, path.join(repo, "website/escape"));

  const passwd = guardToolCall({
    toolName: "write",
    input: { path: "../../etc/passwd" },
    cwd: repo,
  });
  assert.equal(passwd?.block, true);
  assert.match(String(passwd.reason), /escapes website/);

  const viaLink = guardToolCall({
    toolName: "write",
    input: { path: "website/escape/secret.txt" },
    cwd: repo,
  });
  assert.equal(viaLink?.block, true);
  assert.match(String(viaLink.reason), /escapes/);

  const users = guardToolCall({
    toolName: "read",
    input: { path: "/Users" },
    cwd: repo,
  });
  assert.equal(users?.block, true);
  assert.match(String(users.reason), /escapes customer repo/);

  const allowWrite = guardToolCall({
    toolName: "write",
    input: { path: "website/src/main.js" },
    cwd: repo,
  });
  assert.equal(allowWrite, undefined);

  const allowRead = guardToolCall({
    toolName: "read",
    input: { path: "brand/tokens.json" },
    cwd: repo,
  });
  assert.equal(allowRead, undefined);

  const brandWrite = guardToolCall({
    toolName: "write",
    input: { path: "brand/tokens.json" },
    cwd: repo,
  });
  assert.equal(brandWrite?.block, true);

  const cfg = guardToolCall({
    toolName: "write",
    input: { path: "website/vite.config.js" },
    cwd: repo,
  });
  assert.equal(cfg?.block, true);
  assert.match(String(cfg.reason), /forbidden/);

  const lock = guardToolCall({
    toolName: "write",
    input: { path: "website/package-lock.json" },
    cwd: repo,
  });
  assert.equal(lock?.block, true);

  const envf = guardToolCall({
    toolName: "write",
    input: { path: "website/.env" },
    cwd: repo,
  });
  assert.equal(envf?.block, true);

  const ln = guardToolCall({
    toolName: "write",
    input: { path: "website/src/x.js", symlink: true },
    cwd: repo,
  });
  assert.equal(ln?.block, true);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test("renderManifest lists sorted paths, truncates, and drops largest over 120 kB", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tenwhy-manifest-"));
  const workdir = path.join(tmp, "work");
  fs.mkdirSync(path.join(workdir, "website/src"), { recursive: true });
  fs.mkdirSync(path.join(workdir, "website/public/images"), { recursive: true });
  fs.mkdirSync(path.join(workdir, "brand"));
  fs.mkdirSync(path.join(workdir, "research"));
  fs.writeFileSync(path.join(workdir, "website/package.json"), '{"name":"site","devDependencies":{"vite":"6.0.0"}}\n');
  fs.writeFileSync(path.join(workdir, "website/src/main.js"), "console.log('ok')\n");
  fs.writeFileSync(path.join(workdir, "website/public/images/hero.svg"), LOGO);
  fs.writeFileSync(path.join(workdir, "brand/tokens.json"), `${JSON.stringify(TOKENS)}\n`);
  fs.writeFileSync(path.join(workdir, "research/RESEARCH.json"), `${JSON.stringify(RESEARCH)}\n`);
  for (let i = 0; i < 20; i++) {
    const pad = String(i).padStart(2, "0");
    fs.writeFileSync(path.join(workdir, `website/src/blob-${pad}.css`), `${"x".repeat(9 * 1024)}\n`);
  }

  const manifest = renderManifest({ workdir, previous_gate: "build_ok: fail syntax" });
  assert.match(manifest, /company: Acme Dental/);
  assert.match(manifest, /Teeth whitening/);
  assert.match(manifest, /website\/package\.json/);
  assert.match(manifest, /brand\/tokens\.json/);
  assert.match(manifest, /hero\.svg \(\d+ bytes\)/);
  assert.doesNotMatch(manifest, /<svg xmlns/);
  assert.match(manifest, /build_ok: fail syntax/);
  const pkgIdx = manifest.indexOf("website/package.json");
  const mainIdx = manifest.indexOf("website/src/main.js");
  assert.ok(pkgIdx >= 0 && mainIdx > pkgIdx);
  assert.match(manifest, /Omitted \(over 120 kB cap\)/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("website run-pi.sh enables guarded file tools and does not pass --no-builtin-tools", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tenwhy-web-pi-"));
  const stubOut = path.join(tmp, "argv.txt");
  const stub = path.join(tmp, "pi");
  fs.writeFileSync(
    stub,
    `#!/bin/sh
printf '%s\\n' "$@" > "${stubOut}"
echo '{"type":"session","id":"stub"}'
`,
  );
  fs.chmodSync(stub, 0o755);
  const script = path.join(ROOT, "system/loops/website/run-pi.sh");
  const result = spawnSync("bash", [script, "hello"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${tmp}:${process.env.PATH}`,
      PROVIDER: "xai",
      MODEL: "grok-4.6",
      SESSION_DIR: path.join(tmp, "sessions"),
      SESSION_ID: "smoke-web-exec",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const argv = fs.readFileSync(stubOut, "utf8").trim().split(/\n/);
  assert.ok(!argv.includes("--no-builtin-tools"), argv.join(" "));
  assert.ok(argv.includes("-e"), argv.join(" "));
  assert.ok(argv.some((a) => a.endsWith("system/loops/website/pi-guard.ts")), argv.join(" "));
  const toolsIdx = argv.indexOf("--tools");
  assert.ok(toolsIdx >= 0);
  assert.equal(argv[toolsIdx + 1], "read,write,edit,ls,grep,find");
  fs.rmSync(tmp, { recursive: true, force: true });
});
