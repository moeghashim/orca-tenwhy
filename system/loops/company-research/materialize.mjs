import fs from "node:fs";
import path from "node:path";
import { splitMarkdown } from "../../orchestrator/knowledge.mjs";
import { utcNow } from "../../orchestrator/util.mjs";

export function parseLastFencedJson(text) {
  const src = String(text ?? "");
  const fence = /```(?:json)?[ \t]*\r?\n([\s\S]*?)```/gi;
  let lastMatch = null;
  for (const m of src.matchAll(fence)) lastMatch = m;
  if (lastMatch == null) {
    return { ok: false, error: "executor output has no fenced JSON block" };
  }
  const after = src.slice(lastMatch.index + lastMatch[0].length);
  if (after.trim() !== "") {
    return { ok: false, error: "JSON fence must be the last content of the message" };
  }
  try {
    return { ok: true, value: JSON.parse(lastMatch[1]) };
  } catch (err) {
    return { ok: false, error: `JSON parse error: ${err.message}` };
  }
}

function writeSourcesMarkdown({ sourcesPath, table, traceRef, now }) {
  const existing = fs.existsSync(sourcesPath) ? fs.readFileSync(sourcesPath, "utf8") : "";
  const parsed = splitMarkdown(existing);
  let tail = parsed.historyTail ?? "";
  if (tail && !tail.startsWith("\n") && !tail.startsWith("\r")) tail = `\n${tail}`;
  if (tail && !tail.endsWith("\n")) tail += "\n";
  if (!tail) tail = "\n";
  tail += `- ${now} — materialized sources (trace: ${traceRef || "none"})\n`;
  const body = String(table ?? "").trim();
  const out = `---\nupdated: ${now}\ntrace: ${traceRef || "none"}\n---\n\n# Sources\n\n${body}\n\n## History${tail}`;
  fs.writeFileSync(sourcesPath, out, "utf8");
}

export async function materialize({ outputPath, workdir, traceRef = "none", now = utcNow() }) {
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
  let workReal;
  let researchReal;
  try {
    workReal = fs.realpathSync(workdir);
    researchReal = fs.realpathSync(researchDir);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const prefix = workReal.endsWith(path.sep) ? workReal : `${workReal}${path.sep}`;
  if (researchReal !== workReal && !researchReal.startsWith(prefix)) {
    return { ok: false, error: `research dir escapes workdir (${researchReal})` };
  }
  const researchPath = path.join(researchDir, "RESEARCH.json");
  const sourcesPath = path.join(researchDir, "SOURCES.md");
  fs.writeFileSync(researchPath, `${JSON.stringify(value.RESEARCH, null, 2)}\n`, "utf8");
  writeSourcesMarkdown({ sourcesPath, table: value.SOURCES_MD, traceRef, now });
  return { ok: true, files: [researchPath, sourcesPath] };
}
