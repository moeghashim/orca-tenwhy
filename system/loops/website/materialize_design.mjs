import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseLastFencedJson } from "../company-research/materialize.mjs";
import { splitMarkdown } from "../../orchestrator/knowledge.mjs";
import { utcNow } from "../../orchestrator/util.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SCHEMA_PATH = path.join(ROOT, "system/gates/brand_tokens_schema.json");
const HEX = /^#[0-9A-Fa-f]{6}$/;

function assertInside(targetDir, workdir) {
  let workReal;
  let targetReal;
  try {
    workReal = fs.realpathSync(workdir);
    targetReal = fs.realpathSync(targetDir);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const prefix = workReal.endsWith(path.sep) ? workReal : `${workReal}${path.sep}`;
  if (targetReal !== workReal && !targetReal.startsWith(prefix)) {
    return { ok: false, error: `brand dir escapes workdir (${targetReal})` };
  }
  return { ok: true };
}

function tokensShapeError(tokens) {
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) {
    return "tokens is not an object";
  }
  const color = tokens.color;
  if (!color || typeof color !== "object") return "tokens.color missing";
  for (const key of ["bg", "surface", "text", "accent"]) {
    if (!HEX.test(String(color[key] ?? ""))) return `tokens.color.${key} must be a 6-digit hex`;
  }
  const family = tokens.type?.family;
  if (typeof family?.ui !== "string" || !family.ui.trim()) return "tokens.type.family.ui missing";
  if (typeof family?.mono !== "string" || !family.mono.trim()) return "tokens.type.family.mono missing";
  if (typeof tokens.space?.unit !== "number" || !Number.isFinite(tokens.space.unit)) {
    return "tokens.space.unit must be a number";
  }
  if (typeof tokens.radius !== "number" || !Number.isFinite(tokens.radius)) {
    return "tokens.radius must be a number";
  }
  return null;
}

function svgRootOk(text) {
  const stripped = String(text ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/<\?xml[^?]*\?>/i, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();
  return /^<svg(\s|>)/i.test(stripped);
}

function writeHistoryMarkdown({ dest, body, fallbackTitle, traceRef, now }) {
  const existing = fs.existsSync(dest) ? fs.readFileSync(dest, "utf8") : "";
  const prev = splitMarkdown(existing);
  const incoming = splitMarkdown(String(body ?? ""));
  const title = incoming.title || prev.title || fallbackTitle;
  const synthesis = incoming.synthesis || String(body ?? "").trim();
  let tail = prev.historyTail ?? "";
  if (tail && !tail.startsWith("\n") && !tail.startsWith("\r")) tail = `\n${tail}`;
  if (tail && !tail.endsWith("\n")) tail += "\n";
  if (!tail) tail = "\n";
  tail += `- ${now} — materialized design (trace: ${traceRef || "none"})\n`;
  const out = `---\nupdated: ${now}\ntrace: ${traceRef || "none"}\n---\n\n# ${title}\n\n${synthesis.trim()}\n\n## History${tail}`;
  fs.writeFileSync(dest, out, "utf8");
}

export function loadBrandTokensSchema() {
  return JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));
}

export async function materializeDesign({
  outputPath,
  workdir,
  traceRef = "none",
  now = utcNow(),
}) {
  if (!outputPath || !fs.existsSync(outputPath)) {
    return { ok: false, error: "designer output file missing" };
  }
  const parsed = parseLastFencedJson(fs.readFileSync(outputPath, "utf8"));
  if (!parsed.ok) return parsed;
  const value = parsed.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "fenced JSON is not an object" };
  }
  const shape = tokensShapeError(value.tokens);
  if (shape) return { ok: false, error: shape };
  if (typeof value.BRAND_MD !== "string") return { ok: false, error: "missing BRAND_MD string" };
  if (typeof value.logo_svg !== "string") return { ok: false, error: "missing logo_svg string" };
  if (typeof value.IMAGE_BRIEF_MD !== "string") {
    return { ok: false, error: "missing IMAGE_BRIEF_MD string" };
  }
  if (Buffer.byteLength(value.logo_svg, "utf8") > 4 * 1024) {
    return { ok: false, error: "logo_svg exceeds 4 kB" };
  }
  if (!svgRootOk(value.logo_svg)) {
    return { ok: false, error: "logo_svg must be XML with root <svg>" };
  }

  const brandDir = path.join(workdir, "brand");
  fs.mkdirSync(brandDir, { recursive: true });
  const contained = assertInside(brandDir, workdir);
  if (!contained.ok) return contained;

  const tokensPath = path.join(brandDir, "tokens.json");
  const logoPath = path.join(brandDir, "logo.svg");
  const brandMdPath = path.join(brandDir, "BRAND.md");
  const briefPath = path.join(brandDir, "IMAGE_BRIEF.md");
  fs.writeFileSync(tokensPath, `${JSON.stringify(value.tokens, null, 2)}\n`, "utf8");
  fs.writeFileSync(logoPath, value.logo_svg.endsWith("\n") ? value.logo_svg : `${value.logo_svg}\n`, "utf8");
  writeHistoryMarkdown({
    dest: brandMdPath,
    body: value.BRAND_MD,
    fallbackTitle: "Brand",
    traceRef,
    now,
  });
  writeHistoryMarkdown({
    dest: briefPath,
    body: value.IMAGE_BRIEF_MD,
    fallbackTitle: "Image brief",
    traceRef,
    now,
  });
  return { ok: true, files: [tokensPath, brandMdPath, logoPath, briefPath] };
}
