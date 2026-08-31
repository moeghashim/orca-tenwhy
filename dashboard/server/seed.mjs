import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function utcNow(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function migrate(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const result = spawnSync("bash", [path.join(ROOT, "system/db/migrate.sh"), dbPath], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`migrate.sh failed: ${result.stderr || result.stdout}`);
  }
}

function writeMd(file, title, body, now) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `---\nupdated: ${now}\ntrace: fixture://seed\n---\n\n# ${title}\n\n${body}\n\n## History\n- ${now} — seeded (trace: fixture://seed)\n`,
    "utf8",
  );
}

function insertEvent(db, { engagementId, loopRunId = null, kind, payload, createdAt }) {
  db.prepare(
    "INSERT INTO events (engagement_id, loop_run_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(engagementId, loopRunId, kind, JSON.stringify(payload ?? {}), createdAt);
}

export function seedDemo({ dbPath, repoRoot = ROOT, now = utcNow() } = {}) {
  migrate(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");

  const work = path.join(repoRoot, "state/seed-outputs");
  fs.mkdirSync(work, { recursive: true });
  const writeOut = (name, text) => {
    const p = path.join(work, name);
    fs.writeFileSync(p, text, "utf8");
    return p;
  };

  // Cobalt Legal — running, research iteration 2/4, attempt 0
  db.prepare(
    `INSERT INTO engagements (id, customer_name, idea, site_url, repo_url, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "eng_0141",
    "Cobalt Legal",
    "Boutique law firm in Portland",
    "https://cobaltlegal.example",
    "/tmp/repos/cobalt-legal.git",
    "running",
    now,
    now,
  );
  insertEvent(db, {
    engagementId: "eng_0141",
    kind: "engagement.created",
    payload: { slug: "cobalt-legal" },
    createdAt: now,
  });
  db.prepare(
    `INSERT INTO loop_runs (id, engagement_id, loop_name, attempt, change_request_id, status, pi_trace_ref, adjusted_instructions, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "run_res_0141",
    "eng_0141",
    "company-research",
    0,
    null,
    "running",
    "pi://session/cobalt-res",
    null,
    now,
    null,
  );
  db.prepare(
    `INSERT INTO iterations (id, loop_run_id, n, executor_output_path, reviewer_verdict, reviewer_notes, pi_trace_ref, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "it_0141_1",
    "run_res_0141",
    1,
    writeOut("cobalt-exec-1.txt", "Compiled firm profile: 4 practice areas, 7 attorneys. Found 6 competitors."),
    "revise",
    "iteration 2 running — reviewer requested deeper competitor pricing",
    "pi://trace/2b9e11f0",
    now,
  );
  db.prepare(
    `INSERT INTO scrapes (id, loop_run_id, url, http_status, content_path, created_at)
     VALUES (?, ?, ?, ?, NULL, ?)`,
  ).run("sc_0141_1", "run_res_0141", "https://cobaltlegal.example", 200, now);
  insertEvent(db, {
    engagementId: "eng_0141",
    loopRunId: "run_res_0141",
    kind: "loop_run.started",
    payload: { loopName: "company-research" },
    createdAt: now,
  });
  insertEvent(db, {
    engagementId: "eng_0141",
    loopRunId: "run_res_0141",
    kind: "iteration.recorded",
    payload: { n: 1, verdict: "revise" },
    createdAt: now,
  });

  // Meridian Dental — needs_human, website 3/4, attempt 1, failed lighthouse≥85
  db.prepare(
    `INSERT INTO engagements (id, customer_name, idea, site_url, repo_url, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "eng_0142",
    "Meridian Dental",
    "Family dental clinic in Portland",
    "https://meridiandental.example",
    "/tmp/repos/meridian-dental.git",
    "needs_human",
    now,
    now,
  );
  insertEvent(db, {
    engagementId: "eng_0142",
    kind: "engagement.created",
    payload: { slug: "meridian-dental" },
    createdAt: now,
  });
  db.prepare(
    `INSERT INTO loop_runs (id, engagement_id, loop_name, attempt, change_request_id, status, pi_trace_ref, adjusted_instructions, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "run_web_0142",
    "eng_0142",
    "website",
    1,
    null,
    "needs_human",
    "pi://session/meridian-web",
    "attempt 0 failed gate lighthouse≥85 (78).\nadjustment: drop hero video, inline critical CSS, lazy-load gallery, self-host fonts.",
    now,
    now,
  );
  for (const [id, n, verdict, notes] of [
    ["it_0142_1", 1, "revise", "Hero overclaims — no source in kb."],
    ["it_0142_2", 2, "revise", "Copy fixed. Remaining LCP cost is the booking widget."],
    ["it_0142_3", 3, "escalate", "Gate lighthouse≥85 failed at check time. Not fixable by the loop — escalating."],
  ]) {
    db.prepare(
      `INSERT INTO iterations (id, loop_run_id, n, executor_output_path, reviewer_verdict, reviewer_notes, pi_trace_ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, "run_web_0142", n, writeOut(`${id}.txt`, `Meridian website iteration ${n}.`), verdict, notes, `pi://trace/${id}`, now);
  }
  for (const [id, name, passed, detail] of [
    ["gc_0142_1", "brand_assets_valid", 1, "ok"],
    ["gc_0142_2", "build_ok", 1, "ok"],
    ["gc_0142_3", "links_ok", 1, "ok"],
    ["gc_0142_4", "copy_grounded", 1, "ok"],
    ["gc_0142_5", "lighthouse≥85", 0, "performance=78 accessibility=90"],
  ]) {
    db.prepare(
      `INSERT INTO gate_checks (id, loop_run_id, check_name, passed, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, "run_web_0142", name, passed, detail, now);
  }
  insertEvent(db, {
    engagementId: "eng_0142",
    loopRunId: "run_web_0142",
    kind: "gate.checked",
    payload: { passed: false },
    createdAt: now,
  });
  insertEvent(db, {
    engagementId: "eng_0142",
    loopRunId: "run_web_0142",
    kind: "loop_run.needs_human",
    payload: { n: 3 },
    createdAt: now,
  });

  // Harbor & Finch — awaiting_approval, research gate_passed with product_matches
  const harborSlug = "harbor-finch";
  const harborDir = path.join(repoRoot, "state/customers", harborSlug);
  fs.mkdirSync(path.join(harborDir, "research"), { recursive: true });
  fs.mkdirSync(path.join(harborDir, "company"), { recursive: true });
  const research = {
    company: {
      name: "Harbor & Finch",
      summary: "Neighborhood cafe",
      customer_products: [
        { id: "cp_01", name: "Drip coffee", price: 4, url: "https://harbor.example/coffee" },
        { id: "cp_02", name: "Pastry box", price: 18, url: "https://harbor.example/pastry" },
        { id: "cp_03", name: "Lunch board", price: 16, url: "https://harbor.example/lunch" },
      ],
    },
    competitors: [],
    product_matches: [
      {
        customer_product_id: "cp_01",
        competitor: "Nord Kaffe",
        competitor_product: "Filter coffee",
        competitor_price: 4.5,
        source_url: "https://nordkaffe.example/menu",
      },
      {
        customer_product_id: "cp_02",
        competitor: "Bloom Bakery",
        competitor_product: "Morning box",
        competitor_price: null,
        source_url: "https://bloom.example/box",
      },
      {
        customer_product_id: "cp_03",
        competitor: "Pinewood Cafe",
        competitor_product: "Board",
        competitor_price: 15,
        source_url: "https://pinewood.example/missing",
      },
    ],
    enhancement_ideas: [],
  };
  fs.writeFileSync(path.join(harborDir, "research/RESEARCH.json"), `${JSON.stringify(research, null, 2)}\n`);
  const harborDist = path.join(harborDir, "website/dist");
  fs.mkdirSync(path.join(harborDist, "images"), { recursive: true });
  fs.writeFileSync(
    path.join(harborDist, "index.html"),
    `<!DOCTYPE html><html><head><title>Harbor & Finch</title></head><body><h1>Harbor & Finch</h1><p>Neighborhood cafe</p></body></html>\n`,
  );
  fs.writeFileSync(
    path.join(harborDist, "contact.html"),
    `<!DOCTYPE html><html><head><title>Contact</title></head><body><h1>Contact</h1></body></html>\n`,
  );
  writeMd(path.join(harborDir, "company/OVERVIEW.md"), "Overview", "Harbor & Finch neighborhood cafe.", now);
  writeMd(path.join(harborDir, "company/POSITIONING.md"), "Positioning", "Calm weekday lunches.", now);
  writeMd(path.join(harborDir, "BRIEF.md"), "Brief", "Seeded engagement.", now);

  db.prepare(
    `INSERT INTO engagements (id, customer_name, idea, site_url, repo_url, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "eng_0143",
    "Harbor & Finch",
    "Neighborhood cafe",
    "https://harbor.example",
    path.join(harborDir),
    "awaiting_approval",
    now,
    now,
  );
  insertEvent(db, {
    engagementId: "eng_0143",
    kind: "engagement.created",
    payload: { slug: harborSlug },
    createdAt: now,
  });
  db.prepare(
    `INSERT INTO loop_runs (id, engagement_id, loop_name, attempt, change_request_id, status, pi_trace_ref, adjusted_instructions, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("run_res_0143", "eng_0143", "company-research", 0, null, "gate_passed", "pi://session/harbor-res", null, now, now);
  db.prepare(
    `INSERT INTO loop_runs (id, engagement_id, loop_name, attempt, change_request_id, status, pi_trace_ref, adjusted_instructions, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("run_web_0143", "eng_0143", "website", 0, null, "gate_passed", "pi://session/harbor-web", null, now, now);
  db.prepare(
    `INSERT INTO iterations (id, loop_run_id, n, executor_output_path, reviewer_verdict, reviewer_notes, pi_trace_ref, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "it_0143_1",
    "run_res_0143",
    1,
    writeOut("harbor-exec.txt", "Researched Harbor & Finch menu and three local cafes."),
    "approve",
    "1. schema valid. 2. competitors ok.",
    "pi://trace/harbor",
    now,
  );
  for (const [id, name] of [
    ["gc_0143_1", "schema_valid"],
    ["gc_0143_2", "competitors≥5"],
    ["gc_0143_3", "product_coverage≥25%"],
    ["gc_0143_4", "enhancement_ideas≥3"],
    ["gc_0143_5", "sources_complete"],
  ]) {
    db.prepare(
      `INSERT INTO gate_checks (id, loop_run_id, check_name, passed, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, "run_res_0143", name, 1, "ok", now);
  }
  db.prepare(
    `INSERT INTO scrapes (id, loop_run_id, url, http_status, content_path, created_at)
     VALUES (?, ?, ?, ?, NULL, ?)`,
  ).run("sc_0143_ok", "run_res_0143", "https://nordkaffe.example/menu", 200, now);
  db.prepare(
    `INSERT INTO scrapes (id, loop_run_id, url, http_status, content_path, created_at)
     VALUES (?, ?, ?, ?, NULL, ?)`,
  ).run("sc_0143_box", "run_res_0143", "https://bloom.example/box", 200, now);
  db.prepare(
    `INSERT INTO scrapes (id, loop_run_id, url, http_status, content_path, created_at)
     VALUES (?, ?, ?, ?, NULL, ?)`,
  ).run("sc_0143_miss", "run_res_0143", "https://pinewood.example/missing", 404, now);
  insertEvent(db, {
    engagementId: "eng_0143",
    loopRunId: "run_res_0143",
    kind: "gate.checked",
    payload: { passed: true },
    createdAt: now,
  });
  insertEvent(db, {
    engagementId: "eng_0143",
    loopRunId: "run_res_0143",
    kind: "loop_run.finished",
    payload: { status: "gate_passed" },
    createdAt: now,
  });
  insertEvent(db, {
    engagementId: "eng_0143",
    kind: "engagement.awaiting_approval",
    payload: {},
    createdAt: now,
  });

  // Bloom Floristry — complete with live_url
  db.prepare(
    `INSERT INTO engagements (id, customer_name, idea, site_url, repo_url, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "eng_0137",
    "Bloom Floristry",
    "Florist shop",
    "https://bloom.example",
    "/tmp/repos/bloom.git",
    "complete",
    now,
    now,
  );
  insertEvent(db, {
    engagementId: "eng_0137",
    kind: "engagement.created",
    payload: { slug: "bloom-floristry" },
    createdAt: now,
  });
  db.prepare(
    `INSERT INTO loop_runs (id, engagement_id, loop_name, attempt, change_request_id, status, pi_trace_ref, adjusted_instructions, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("run_res_0137", "eng_0137", "company-research", 0, null, "gate_passed", null, null, now, now);
  db.prepare(
    `INSERT INTO loop_runs (id, engagement_id, loop_name, attempt, change_request_id, status, pi_trace_ref, adjusted_instructions, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("run_web_0137", "eng_0137", "website", 0, null, "gate_passed", null, null, now, now);
  for (const [id, name] of [
    ["gc_0137_1", "brand_assets_valid"],
    ["gc_0137_2", "build_ok"],
    ["gc_0137_3", "links_ok"],
    ["gc_0137_4", "copy_grounded"],
    ["gc_0137_5", "lighthouse≥85"],
  ]) {
    db.prepare(
      `INSERT INTO gate_checks (id, loop_run_id, check_name, passed, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, "run_web_0137", name, 1, "ok", now);
  }
  insertEvent(db, {
    engagementId: "eng_0137",
    kind: "engagement.complete",
    payload: { live_url: "https://bloomfloristry.example" },
    createdAt: now,
  });

  // Pinewood Vets — new / queued
  db.prepare(
    `INSERT INTO engagements (id, customer_name, idea, site_url, repo_url, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "eng_0134",
    "Pinewood Vets",
    "Veterinary clinic",
    null,
    null,
    "new",
    now,
    now,
  );
  insertEvent(db, {
    engagementId: "eng_0134",
    kind: "engagement.created",
    payload: { slug: "pinewood-vets" },
    createdAt: now,
  });
  db.prepare(
    `INSERT INTO loop_runs (id, engagement_id, loop_name, attempt, change_request_id, status, pi_trace_ref, adjusted_instructions, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("run_res_0134", "eng_0134", "company-research", 0, null, "queued", null, null, now, null);

  db.close();
  return { dbPath, repoRoot };
}

function isMain() {
  const entry = process.argv[1] && path.resolve(process.argv[1]);
  return entry === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const dbPath =
    process.argv[2] || process.env.TENWHY_DB || path.join(ROOT, "state/orchestrator.db");
  seedDemo({ dbPath, repoRoot: ROOT });
  process.stdout.write(`seeded ${dbPath}\n`);
}
