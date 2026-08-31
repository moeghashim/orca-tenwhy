import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { materializeDesign } from "./materialize_design.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DESIGN_MD = fs.readFileSync(path.join(DIR, "design.md"), "utf8");
const EXECUTOR_MD = fs.readFileSync(path.join(DIR, "executor.md"), "utf8");
const REVIEWER_MD = fs.readFileSync(path.join(DIR, "reviewer.md"), "utf8");

const TEXT_MAX = 8 * 1024;
const TOTAL_MAX = 120 * 1024;
const SKIP_DIRS = new Set(["node_modules", "dist"]);
const TEXT_EXT = new Set([
  ".html",
  ".js",
  ".css",
  ".json",
  ".md",
  ".txt",
  ".mjs",
  ".cjs",
  ".ts",
  ".map",
  ".yml",
  ".yaml",
  ".toml",
]);

export const name = "website";
export const gate = "system/gates/website_gate.py";

export function renderTemplate(template, vars = {}) {
  return String(template).replace(/\{\{(\w+)\}\}/g, (_, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key] ?? "") : "",
  );
}

function readOptional(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function parseResearch(workdir) {
  try {
    return JSON.parse(readOptional(path.join(workdir, "research/RESEARCH.json")) || "{}");
  } catch {
    return {};
  }
}

function productNames(research) {
  return (research?.company?.customer_products ?? [])
    .map((p) => p?.name)
    .filter((n) => typeof n === "string" && n.trim());
}

function researchVars(vars = {}, workdir) {
  const researchJson =
    vars.research_json != null && vars.research_json !== ""
      ? String(vars.research_json)
      : readOptional(path.join(workdir || "", "research/RESEARCH.json"));
  let research = {};
  try {
    research = JSON.parse(researchJson || "{}");
  } catch {
    research = {};
  }
  return {
    research_json: researchJson,
    company_name: vars.company_name || research?.company?.name || vars.customer_name || "",
    products: vars.products || productNames(research).join(", "),
  };
}

export function designPrompt(vars = {}) {
  return renderTemplate(DESIGN_MD, vars);
}

export function executorPrompt(vars = {}) {
  return renderTemplate(EXECUTOR_MD, {
    ...vars,
    ...researchVars(vars, vars.workdir),
  });
}

export function reviewerPrompt(vars = {}) {
  return renderTemplate(REVIEWER_MD, vars);
}

function walkFiles(dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, out);
    else if (e.isFile() || e.isSymbolicLink()) out.push(p);
  }
  return out;
}

function isTextFile(rel, abs) {
  const ext = path.extname(rel).toLowerCase();
  // brand/*.svg (the designer's logo) is inlined so the reviewer can judge check 1;
  // other SVGs (generated placeholders under public/) stay path + size only.
  if (ext === ".svg") return rel.startsWith("brand/");
  if (TEXT_EXT.has(ext)) return true;
  try {
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) return false;
    return true;
  } catch {
    return false;
  }
}

function fileEntry(workdir, abs) {
  const rel = path.relative(workdir, abs).split(path.sep).join("/");
  let size = 0;
  try {
    size = fs.statSync(abs).size;
  } catch {
    size = 0;
  }
  if (!isTextFile(rel, abs)) {
    return { rel, size, kind: "meta", body: `${rel} (${size} bytes)` };
  }
  let text = "";
  try {
    text = fs.readFileSync(abs, "utf8");
  } catch {
    return { rel, size, kind: "meta", body: `${rel} (${size} bytes)` };
  }
  let body = text;
  if (Buffer.byteLength(body, "utf8") > TEXT_MAX) {
    const sliced = Buffer.from(body, "utf8").subarray(0, TEXT_MAX).toString("utf8");
    body = `${sliced}\n…[truncated]`;
  }
  return { rel, size, kind: "text", body };
}

function renderSection(entry) {
  if (entry.kind === "meta") return `### ${entry.rel}\n${entry.body}\n`;
  return `### ${entry.rel}\n\`\`\`\n${entry.body}\n\`\`\`\n`;
}

export function renderManifest({ workdir, previous_gate = "" } = {}) {
  const files = [];
  const seen = new Set();
  const add = (abs) => {
    if (!abs || !fs.existsSync(abs)) return;
    let real;
    try {
      real = fs.realpathSync(abs);
    } catch {
      return;
    }
    if (seen.has(real)) return;
    seen.add(real);
    files.push(fileEntry(workdir, abs));
  };

  add(path.join(workdir, "website/package.json"));
  const websiteDir = path.join(workdir, "website");
  if (fs.existsSync(websiteDir)) {
    for (const abs of walkFiles(websiteDir).sort()) add(abs);
  }
  const brandDir = path.join(workdir, "brand");
  if (fs.existsSync(brandDir)) {
    for (const abs of walkFiles(brandDir).sort()) add(abs);
  }

  files.sort((a, b) => a.rel.localeCompare(b.rel));

  const research = parseResearch(workdir);
  const names = productNames(research);
  const productBlock = [
    "## RESEARCH.json product names",
    `company: ${research?.company?.name || ""}`,
    names.length ? names.map((n) => `- ${n}`).join("\n") : "- (none)",
    "",
  ].join("\n");

  const gateBlock = previous_gate
    ? `## Previous gate output\n${previous_gate}\n`
    : "## Previous gate output\n(none)\n";

  let entries = files.slice();
  const dropped = [];
  const totalBytes = () => {
    const parts = [productBlock, gateBlock, ...entries.map(renderSection), ...dropped.map((d) => `- ${d.rel} (${d.size} bytes)`)];
    return Buffer.byteLength(parts.join("\n"), "utf8");
  };
  while (entries.length && totalBytes() > TOTAL_MAX) {
    let largest = 0;
    for (let i = 1; i < entries.length; i++) {
      if (entries[i].size > entries[largest].size) largest = i;
    }
    dropped.push(entries[largest]);
    entries.splice(largest, 1);
  }
  dropped.sort((a, b) => a.rel.localeCompare(b.rel));

  const lines = ["# Website review manifest", "", productBlock, gateBlock, "## Files", ""];
  for (const entry of entries) lines.push(renderSection(entry));
  if (dropped.length) {
    lines.push("## Omitted (over 120 kB cap)");
    for (const d of dropped) lines.push(`- ${d.rel} (${d.size} bytes)`);
    lines.push("");
  }
  return lines.join("\n");
}

export async function prepare({
  workdir,
  adapter,
  config,
  adjustedInstructions = "",
  vars = {},
  sessionId,
  engagementId,
  loopRunId,
  dbPath,
  now,
}) {
  const extra = researchVars({ ...vars, adjusted_instructions: adjustedInstructions ?? "" }, workdir);
  const prompt = designPrompt({
    ...vars,
    ...extra,
    adjusted_instructions: adjustedInstructions ?? "",
  });
  const result = await adapter.run({
    role: "reviewer",
    loopName: name,
    n: 0,
    prompt,
    sessionId,
    workdir,
    engagementId,
    loopRunId,
    dbPath,
    config,
  });
  const mat = await materializeDesign({
    outputPath: result.outputPath,
    workdir,
    traceRef: result.traceRef,
    now,
  });
  if (!mat.ok) {
    return { ok: false, error: mat.error, traceRef: result.traceRef };
  }
  return { ok: true, traceRef: result.traceRef, files: mat.files };
}

export { materializeDesign };
