import fs from "node:fs";
import path from "node:path";

export function parseLastFencedJson(text) {
  const src = String(text ?? "");
  const fence = /```(?:json)?[ \t]*\r?\n([\s\S]*?)```/gi;
  let lastRaw = null;
  for (const m of src.matchAll(fence)) lastRaw = m[1];
  if (lastRaw == null) {
    return { ok: false, error: "executor output has no fenced JSON block" };
  }
  try {
    return { ok: true, value: JSON.parse(lastRaw) };
  } catch (err) {
    return { ok: false, error: `JSON parse error: ${err.message}` };
  }
}

export async function materialize({ outputPath, workdir }) {
  if (!outputPath || !fs.existsSync(outputPath)) {
    return { ok: false, error: "executor output file missing" };
  }
  const parsed = parseLastFencedJson(fs.readFileSync(outputPath, "utf8"));
  if (!parsed.ok) return parsed;
  const value = parsed.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "fenced JSON is not an object" };
  }
  if (!value.RESEARCH || typeof value.RESEARCH !== "object" || Array.isArray(value.RESEARCH)) {
    return { ok: false, error: "missing RESEARCH object" };
  }
  if (typeof value.SOURCES_MD !== "string") {
    return { ok: false, error: "missing SOURCES_MD string" };
  }
  const researchDir = path.join(workdir, "research");
  fs.mkdirSync(researchDir, { recursive: true });
  const researchPath = path.join(researchDir, "RESEARCH.json");
  const sourcesPath = path.join(researchDir, "SOURCES.md");
  fs.writeFileSync(researchPath, `${JSON.stringify(value.RESEARCH, null, 2)}\n`, "utf8");
  fs.writeFileSync(sourcesPath, value.SOURCES_MD, "utf8");
  return { ok: true, files: [researchPath, sourcesPath] };
}
