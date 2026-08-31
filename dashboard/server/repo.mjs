import fs from "node:fs";
import path from "node:path";

export function slugify(name) {
  const slug = String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "customer";
}

/** Slug from engagement.created payload — never re-derived from customer_name when present. */
export function customerRepoDir(eng, repoRoot, db) {
  const base = path.join(repoRoot, "state/customers");
  let slug = null;
  if (db && eng?.id) {
    const row = db
      .prepare(
        `SELECT json_extract(payload, '$.slug') AS slug
         FROM events WHERE engagement_id = ? AND kind = 'engagement.created'
         ORDER BY id LIMIT 1`,
      )
      .get(eng.id);
    if (row?.slug) slug = row.slug;
  }
  if (slug) return path.join(base, slug);
  return path.join(base, slugify(eng?.customer_name));
}

export function walkMarkdown(dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === "dist" || e.name === ".git") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkMarkdown(p, out);
    else if (e.isFile() && e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

function frontmatterUpdated(text) {
  const m = String(text ?? "").match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const um = m[1].match(/^updated:\s*(.+)$/m);
  return um ? um[1].trim() : null;
}

export function kbFiles(repoDir) {
  if (!repoDir || !fs.existsSync(repoDir)) return [];
  const files = walkMarkdown(repoDir).sort();
  return files.map((abs) => {
    let updated = null;
    try {
      updated = frontmatterUpdated(fs.readFileSync(abs, "utf8"));
    } catch {
      updated = null;
    }
    if (!updated) {
      try {
        updated = fs.statSync(abs).mtime.toISOString().replace(/\.\d{3}Z$/, "Z");
      } catch {
        updated = null;
      }
    }
    return { path: path.relative(repoDir, abs).split(path.sep).join("/"), updated };
  });
}
