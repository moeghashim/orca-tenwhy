import fs from "node:fs";
import path from "node:path";
import { slugify } from "./customer_repo.mjs";
import { info } from "./log.mjs";
import { runGit, utcNow } from "./util.mjs";

export function splitMarkdown(text) {
  const src = String(text ?? "");
  const fmMatch = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const body = fmMatch ? src.slice(fmMatch[0].length) : src;
  const histMatch = body.match(/^## History\s*$/m);
  let title = "";
  let synthesis = body.trim();
  let historyTail = "";
  if (histMatch) {
    const before = body.slice(0, histMatch.index);
    historyTail = body.slice(histMatch.index + histMatch[0].length);
    const titleMatch = before.match(/^#\s+(.+)$/m);
    title = titleMatch ? titleMatch[1].trim() : "";
    synthesis = before.replace(/^#\s+.+$/m, "").trim();
  } else {
    const titleMatch = body.match(/^#\s+(.+)$/m);
    title = titleMatch ? titleMatch[1].trim() : "";
    synthesis = body.replace(/^#\s+.+$/m, "").trim();
  }
  return { title, synthesis, historyTail };
}

function renderMarkdown({ updated, trace, title, synthesis, historyTail, historyLine }) {
  let tail = historyTail ?? "";
  if (tail && !tail.startsWith("\n") && !tail.startsWith("\r")) tail = `\n${tail}`;
  if (tail && !tail.endsWith("\n")) tail += "\n";
  if (!tail) tail = "\n";
  tail += `${historyLine}\n`;
  return `---\nupdated: ${updated}\ntrace: ${trace}\n---\n\n# ${title}\n\n${synthesis.trim()}\n\n## History${tail}`;
}

function minimal(title, now) {
  return `---\nupdated: ${now}\ntrace: none\n---\n\n# ${title}\n\n\n\n## History\n`;
}

export function historyEntries(text) {
  const { historyTail } = splitMarkdown(text);
  return historyTail
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.startsWith("- "));
}

export async function absorbResearch({
  repoDir,
  researchJson,
  traceRef,
  model,
  now = utcNow(),
  loopRunId = "unknown",
}) {
  if (!model || typeof model.rewriteSynthesis !== "function") {
    throw new Error("absorbResearch requires a model adapter with rewriteSynthesis");
  }
  const targets = [
    { rel: "company/OVERVIEW.md", title: "Overview", kind: "overview" },
    { rel: "company/POSITIONING.md", title: "Positioning", kind: "positioning" },
    { rel: "company/FINDINGS.md", title: "Findings", kind: "findings" },
  ];
  for (const c of researchJson?.competitors || []) {
    const name = c.name || "competitor";
    targets.push({
      rel: `company/competitors/${slugify(name)}.md`,
      title: name,
      kind: "competitor",
      record: c,
    });
  }
  for (const p of researchJson?.company?.customer_products || []) {
    const name = p.name || p.id || "product";
    targets.push({
      rel: `company/products/${slugify(name)}.md`,
      title: name,
      kind: "product",
      record: p,
    });
  }

  const note = `absorbed research`;
  const historyLine = `- ${now} — ${note} (trace: ${traceRef})`;

  const prepared = targets.map((t) => {
    const abs = path.join(repoDir, t.rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const current = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : minimal(t.title, now);
    const parsed = splitMarkdown(current);
    return { ...t, abs, parsed };
  });

  let batch = null;
  if (typeof model.rewriteAllSynthesis === "function") {
    try {
      batch = await model.rewriteAllSynthesis({
        targets: prepared.map((t) => ({
          rel: t.rel,
          kind: t.kind,
          record: t.record,
          currentBody: t.parsed.synthesis,
        })),
        researchJson,
      });
    } catch {
      batch = null;
    }
    if (!batch || typeof batch !== "object" || Array.isArray(batch)) batch = null;
  }

  for (const t of prepared) {
    let synthesis = null;
    let source = "fallback";
    const batched = batch && typeof batch[t.rel] === "string" ? batch[t.rel].trim() : "";
    if (batched) {
      synthesis = batched;
      source = "batch";
    } else {
      synthesis = await model.rewriteSynthesis({
        targetRel: t.rel,
        kind: t.kind,
        record: t.record,
        researchJson,
        currentBody: t.parsed.synthesis,
      });
    }
    info("absorb", "file", { rel: t.rel, source });
    const out = renderMarkdown({
      updated: now,
      trace: traceRef,
      title: t.parsed.title || t.title,
      synthesis: String(synthesis ?? "").trim() || t.parsed.synthesis,
      historyTail: t.parsed.historyTail,
      historyLine,
    });
    fs.writeFileSync(t.abs, out, "utf8");
  }

  runGit(repoDir, ["add", "-A"]);
  runGit(repoDir, ["commit", "-m", `research: absorb ${loopRunId}`]);
  const remotes = runGit(repoDir, ["remote"], { check: false }).stdout.split(/\s+/).filter(Boolean);
  if (remotes.includes("origin")) {
    runGit(repoDir, ["push", "origin", "HEAD"]);
  }
}
