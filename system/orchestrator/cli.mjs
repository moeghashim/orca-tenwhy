import fs from "node:fs";
import path from "node:path";
import { generateCustomerRepo, publishCustomerRepo, slugify } from "./customer_repo.mjs";
import { ROOT, insertEvent, openDb, prefixedId, utcNow } from "./util.mjs";

function usage() {
  return `usage: loopctl <new|update|approve|request-changes|repair-repo-url|daemon|status> [args]
  loopctl new "<idea>" [--url <site>] [--name <customer>]
  loopctl update <engagement-id>
  loopctl approve <engagement-id>
  loopctl request-changes <engagement-id> --notes "<text>"
  loopctl repair-repo-url <engagement-id>
  loopctl daemon [--interval-ms 2000]
  loopctl status [<engagement-id>]`;
}

export function parseArgv(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url" || a === "--name" || a === "--notes" || a === "--interval-ms") {
      flags[a.slice(2)] = argv[++i];
      continue;
    }
    if (a.startsWith("--")) {
      throw new Error(`unknown flag ${a}`);
    }
    positional.push(a);
  }
  return { positional, flags };
}

export function deriveCustomerName({ name, url, idea }) {
  if (name && name.trim()) return name.trim();
  if (url) {
    try {
      const href = /:\/\//.test(url) ? url : `https://${url}`;
      return new URL(href).hostname;
    } catch {
      return url;
    }
  }
  const words = String(idea || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return words.slice(0, 4).join(" ") || "customer";
}

function dbPath() {
  return process.env.TENWHY_DB || path.join(ROOT, "state/orchestrator.db");
}

export function cmdNew({ idea, url, name, repoRoot = ROOT, backend = process.env.TENWHY_REPO_BACKEND || "github" }) {
  if (!idea && !url) {
    throw Object.assign(new Error("new requires an idea and/or --url"), { exitCode: 1 });
  }
  const customerName = deriveCustomerName({ name, url, idea });
  let slug = slugify(customerName);
  const customersDir = path.join(repoRoot, "state/customers");
  fs.mkdirSync(customersDir, { recursive: true });
  const id = prefixedId("eng");
  if (fs.existsSync(path.join(customersDir, slug))) {
    slug = `${slug}-${id.slice(-8)}`;
  }
  const now = utcNow();
  const db = openDb(dbPath());
  try {
    db.prepare(
      `INSERT INTO engagements (id, customer_name, idea, site_url, repo_url, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, 'new', ?, ?)`,
    ).run(id, customerName, idea || null, url || null, now, now);
    const targetDir = path.join(customersDir, slug);
    generateCustomerRepo({
      slug,
      customerName,
      idea: idea || "",
      siteUrl: url || "",
      targetDir,
      now,
    });
    const published = publishCustomerRepo({
      dir: targetDir,
      slug,
      backend,
      remotesDir: path.join(repoRoot, "state/remotes"),
    });
    db.prepare("UPDATE engagements SET repo_url = ?, updated_at = ? WHERE id = ?").run(
      published.repo_url,
      utcNow(),
      id,
    );
    insertEvent(db, {
      engagementId: id,
      kind: "engagement.created",
      payload: { slug, customerName, idea: idea || null, site_url: url || null, repo_url: published.repo_url },
    });
    return { id, slug, repo_url: published.repo_url, customerName };
  } finally {
    db.close();
  }
}

export async function main(argv = process.argv.slice(2)) {
  if (!argv.length || argv[0] === "-h" || argv[0] === "--help") {
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  let parsed;
  try {
    parsed = parseArgv(argv);
  } catch (err) {
    console.error(err.message);
    console.error(usage());
    process.exitCode = 1;
    return;
  }
  const [cmd, ...rest] = parsed.positional;
  try {
    if (cmd === "new") {
      const idea = rest.join(" ").trim() || "";
      const result = cmdNew({
        idea,
        url: parsed.flags.url,
        name: parsed.flags.name,
      });
      process.stdout.write(`${result.id}\n`);
      return;
    }
    if (cmd === "status") {
      const { cmdStatus } = await import("./commands.mjs");
      cmdStatus({ engagementId: rest[0], dbPath: dbPath() });
      return;
    }
    if (cmd === "update") {
      const { cmdUpdate } = await import("./commands.mjs");
      cmdUpdate({ engagementId: rest[0], dbPath: dbPath() });
      return;
    }
    if (cmd === "approve") {
      const { cmdApprove } = await import("./commands.mjs");
      cmdApprove({ engagementId: rest[0], dbPath: dbPath() });
      return;
    }
    if (cmd === "request-changes") {
      const { cmdRequestChanges } = await import("./commands.mjs");
      cmdRequestChanges({ engagementId: rest[0], notes: parsed.flags.notes, dbPath: dbPath() });
      return;
    }
    if (cmd === "repair-repo-url") {
      const { cmdRepairRepoUrl } = await import("./commands.mjs");
      cmdRepairRepoUrl({ engagementId: rest[0], dbPath: dbPath() });
      return;
    }
    if (cmd === "daemon") {
      const { runDaemon } = await import("./orchestrator.mjs");
      const { buildTickOpts } = await import("./wiring.mjs");
      const interval = Number(parsed.flags["interval-ms"] || 2000);
      const pathDb = dbPath();
      const tickOpts = await buildTickOpts({ repoRoot: ROOT, dbPath: pathDb });
      await runDaemon({ intervalMs: interval, dbPath: pathDb, tickOpts });
      return;
    }
    console.error(usage());
    process.exitCode = 2;
  } catch (err) {
    console.error(err.message || err);
    process.exitCode = err.exitCode ?? 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
