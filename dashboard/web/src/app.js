import { applyStatusVars, statusOf, tokens } from "./status.js";
import { clockTime, isRecent, rel, serverNow } from "./time.js";

const ROW_H = `${tokens.space.tableRowHeight}px`;
const FLASH = tokens.color.liveFlash;
const LINK = tokens.color.accent.link;

export function parseHash(hash) {
  const h = String(hash || "#/runs").replace(/^#/, "") || "/runs";
  const parts = h.split("/").filter(Boolean);
  if (parts[0] === "failures") return { view: "failures" };
  if (parts[0] === "customers") return { view: "customers" };
  if (parts[0] === "runs" && parts[1] && parts[2]) {
    return { view: "loop", engId: parts[1], runId: parts[2] };
  }
  return { view: "runs" };
}

function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "dataset") Object.assign(node.dataset, v);
    else node.setAttribute(k, String(v));
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

function badge(kind, value) {
  const s = statusOf(kind, value);
  return el(
    "span",
    {
      class: "badge",
      "data-badge": value,
      style: { background: s.bg, borderColor: s.border, color: s.fg },
    },
    `${s.glyph} ${s.label}`,
  );
}

function iterSegs(n, fg) {
  const wrap = el("span", { class: "iter-segs", "data-iter": `${n}/4` });
  for (let i = 0; i < 4; i++) {
    wrap.append(
      el("span", {
        class: "iter-seg",
        style: { background: i < n ? fg : tokens.color.border.default },
        "data-filled": i < n ? "1" : "0",
      }),
    );
  }
  wrap.append(el("span", { class: "frac" }, `${n}/4`));
  return wrap;
}

function attDots(attempt) {
  const wrap = el("span", { class: "att-dots", "data-attempt": `${attempt}/2` });
  const amber = attempt > 0;
  for (let i = 0; i < 3; i++) {
    wrap.append(
      el("span", {
        class: "att-dot",
        style: {
          background: i < attempt ? (amber ? tokens.color.status.needs_human.fg : tokens.color.status.running.fg) : "transparent",
          borderColor: "#a1a1aa",
        },
        "data-on": i < attempt ? "1" : "0",
        "data-amber": amber && i < attempt ? "1" : "0",
      }),
    );
  }
  wrap.append(el("span", { class: "frac" }, `${attempt}/2`));
  return wrap;
}

function orderedEngagements(store) {
  const snap = store.snapshot;
  if (!snap) return [];
  const byId = new Map(snap.engagements.map((e) => [e.id, e]));
  const out = [];
  for (const id of store.engagementOrder) if (byId.has(id)) out.push(byId.get(id));
  for (const e of snap.engagements) if (!store.engagementOrder.includes(e.id)) out.push(e);
  return out;
}

function runsFor(snap, engId) {
  return (snap.loop_runs || []).filter((r) => r.engagement_id === engId);
}

/** Current run of a loop for an engagement: the queued/running one if any (only one can be live per
 *  loop), otherwise the most recently started. This follows change-request chains correctly — a new
 *  chain restarts at attempt 0, so "highest attempt" would wrongly pick the old chain (Codex #r16). */
function latestRunFor(snap, engId, loopName) {
  const runs = runsFor(snap, engId).filter((r) => r.loop_name === loopName);
  if (!runs.length) return null;
  const live = runs.filter((r) => r.status === "running" || r.status === "queued");
  if (live.length) return live[live.length - 1];
  return runs.reduce((best, r) => (String(r.started_at || "") >= String(best.started_at || "") ? r : best));
}

function activeRun(snap, eng) {
  const runs = runsFor(snap, eng.id);
  return (
    runs.find((r) => r.loop_name === eng.active_loop && ["running", "queued", "needs_human"].includes(r.status)) ||
    runs.find((r) => ["running", "queued", "needs_human"].includes(r.status)) ||
    runs.at(-1) ||
    null
  );
}

function needsCount(snap) {
  return (snap?.loop_runs || []).filter((r) => r.status === "needs_human").length;
}

function activeEngagements(snap) {
  return new Set(
    (snap?.loop_runs || []).filter((r) => r.status === "running" || r.status === "queued").map((r) => r.engagement_id),
  ).size;
}

export function connLabel(sse, now) {
  if (sse.state === "live") {
    return { label: "live", sub: "SSE /api/events", fg: tokens.color.status.passed.fg, dot: tokens.color.status.passed.fg, anim: "lgPulse 1.6s ease-in-out infinite" };
  }
  if (sse.state === "reconnecting") {
    return {
      label: `reconnecting · retry ${sse.retry}/5 in ${sse.retryIn}s`,
      sub: "SSE /api/events",
      fg: tokens.color.status.needs_human.fg,
      dot: tokens.color.status.needs_human.fg,
      anim: "lgPulse 1.6s ease-in-out infinite",
    };
  }
  return {
    label: "disconnected",
    sub: sse.closedAt ? rel(sse.closedAt, now) : "—",
    fg: tokens.color.status.failed.fg,
    dot: tokens.color.status.failed.fg,
    anim: "none",
  };
}

function loadingBlock() {
  const box = el("div", { class: "empty-card skel-wrap", "data-state": "loading" });
  for (let i = 0; i < 6; i++) {
    box.append(el("div", { class: "skel-row", style: { height: ROW_H } }));
  }
  return [box, el("div", { class: "footer-req" }, "GET /api/snapshot …")];
}

function emptyBlock(glyph, title, sentence) {
  return el(
    "div",
    { class: "empty-card", "data-state": "empty" },
    el("span", { class: "empty-glyph" }, `${glyph} ${title}`),
    el("span", { class: "empty-copy" }, sentence),
  );
}

function applyRunRowFlash(row, eng, run, store) {
  const flashed = store.flashed.has(eng.id) || (run && store.flashed.has(run.id));
  row.classList.toggle("is-flash", flashed);
  if (flashed) row.style.background = FLASH;
  else if (eng.status === "needs_human") row.style.background = "var(--status-needs_human-row)";
  else row.style.background = "";
}

function paintBadge(node, kind, value) {
  const s = statusOf(kind, value);
  node.dataset.badge = value;
  node.textContent = `${s.glyph} ${s.label}`;
  node.style.background = s.bg;
  node.style.borderColor = s.border;
  node.style.color = s.fg;
  return s;
}

function paintIterSegs(wrap, n, fg) {
  wrap.dataset.iter = `${n}/4`;
  const segs = wrap.querySelectorAll(".iter-seg");
  segs.forEach((seg, i) => {
    seg.style.background = i < n ? fg : tokens.color.border.default;
    seg.dataset.filled = i < n ? "1" : "0";
  });
  const frac = wrap.querySelector(".frac");
  if (frac) frac.textContent = `${n}/4`;
}

function paintAttDots(wrap, attempt) {
  wrap.dataset.attempt = `${attempt}/2`;
  const amber = attempt > 0;
  const dots = wrap.querySelectorAll(".att-dot");
  dots.forEach((dot, i) => {
    const on = i < attempt;
    dot.style.background = on ? (amber ? tokens.color.status.needs_human.fg : tokens.color.status.running.fg) : "transparent";
    dot.dataset.on = on ? "1" : "0";
    dot.dataset.amber = amber && on ? "1" : "0";
  });
  const frac = wrap.querySelector(".frac");
  if (frac) frac.textContent = `${attempt}/2`;
}

function fillRunRow(row, eng, store, now) {
  const run = activeRun(store.snapshot, eng);
  row._run = run;
  const st = statusOf("engagement", eng.status);
  const n = run?.iteration_count ?? 0;
  const attempt = run?.attempt ?? 0;
  row.style.height = ROW_H;
  applyRunRowFlash(row, eng, run, store);
  if (!row.querySelector("[data-note]")) {
    row.append(
      el(
        "span",
        { class: "eng-cell" },
        el("span", { class: "eng-name" }, eng.customer_name || ""),
        el("span", { class: "mono faint", "data-eng-id": "1" }, eng.id),
      ),
      badge("engagement", eng.status),
      el("span", { class: "mono loop" }, eng.active_loop || "—"),
      iterSegs(n, st.fg),
      attDots(attempt),
      el(
        "span",
        {
          class: "mono",
          "data-last-event": "1",
          style: { color: isRecent(eng.last_event_at, now) ? LINK : tokens.color.text.muted },
        },
        rel(eng.last_event_at, now),
      ),
      el("span", { class: "note", "data-note": "1" }, eng.last_note || ""),
    );
    return;
  }
  const name = row.querySelector(".eng-name");
  const id = row.querySelector("[data-eng-id]");
  const badgeEl = row.querySelector("[data-badge]");
  const loop = row.querySelector(".loop");
  const segs = row.querySelector("[data-iter]");
  const dots = row.querySelector("[data-attempt]");
  const time = row.querySelector("[data-last-event]");
  const note = row.querySelector("[data-note]");
  if (name) name.textContent = eng.customer_name || "";
  if (id) id.textContent = eng.id;
  if (badgeEl) paintBadge(badgeEl, "engagement", eng.status);
  if (loop) loop.textContent = eng.active_loop || "—";
  if (segs) paintIterSegs(segs, n, st.fg);
  if (dots) paintAttDots(dots, attempt);
  if (time) {
    time.textContent = rel(eng.last_event_at, now);
    time.style.color = isRecent(eng.last_event_at, now) ? LINK : tokens.color.text.muted;
  }
  if (note) note.textContent = eng.last_note || "";
}

function makeRunRow(eng, store, now, go) {
  const row = el("div", {
    class: "runs-row",
    "data-row": eng.id,
    "data-run-row": eng.id,
    onClick: () => {
      const run = row._run;
      if (run) go(`#/runs/${eng.id}/${run.id}`);
    },
  });
  fillRunRow(row, eng, store, now);
  return row;
}

function syncRunsTable(table, store, now, go) {
  const engs = orderedEngagements(store);
  const existing = [...table.querySelectorAll("[data-row]")];
  const byId = new Map(existing.map((n) => [n.getAttribute("data-row"), n]));
  const keep = new Set(engs.map((e) => e.id));
  for (const eng of engs) {
    let row = byId.get(eng.id);
    if (row) fillRunRow(row, eng, store, now);
    else row = makeRunRow(eng, store, now, go);
    table.append(row);
  }
  for (const row of existing) {
    if (!keep.has(row.getAttribute("data-row"))) row.remove();
  }
}

function patchRunsShell(shell, table, { store, hash, now, go }, route) {
  const snap = store.snapshot;
  const sse = store.sse;
  const conn = connLabel(sse, now);
  const nNeeds = needsCount(snap);
  const nEng = snap?.engagements?.length ?? 0;
  const nActive = activeEngagements(snap);
  const box = shell.querySelector(".conn");
  if (box) {
    box.dataset.conn = sse.state;
    const dot = box.querySelector(".conn-dot");
    if (dot) {
      dot.style.background = conn.dot;
      dot.style.animation = conn.anim;
    }
    const label = box.querySelector("[data-conn-label]");
    if (label) {
      label.textContent = conn.label;
      label.style.color = conn.fg;
    }
    const sub = box.querySelector("[data-conn-sub]");
    if (sub) sub.textContent = conn.sub;
  }
  const clock = shell.querySelector("[data-snapshot-clock]");
  if (clock) clock.textContent = `snapshot ${clockTime(snap?.serverTime)} · v0.1.0`;
  const runsCount = shell.querySelector('.nav-item[href="#/runs"] .nav-count');
  if (runsCount) {
    const activeNav = (snap?.engagements || []).filter((e) =>
      ["running", "needs_human", "new", "awaiting_approval"].includes(e.status),
    ).length;
    runsCount.textContent = String(activeNav);
  }
  const failNav = shell.querySelector('.nav-item[href="#/failures"] .nav-count');
  if (failNav) failNav.textContent = String(nNeeds);
  const sum = shell.querySelector("[data-runs-summary]");
  if (sum) sum.textContent = `${nEng} engagements · ${nActive} active · sorted by last event`;
  const main = shell.querySelector(".main");
  const content = shell.querySelector(".content");
  const banner = main?.querySelector(":scope > .banner");
  if (sse.state === "disconnected") {
    const html = el(
      "div",
      { class: "banner disc", "data-banner": "disconnected" },
      el("span", { class: "mono" }, "✕ stream disconnected"),
      el("span", {}, `showing snapshot from ${snap?.snapshotAt ? rel(snap.snapshotAt, now) : "—"} — snapshot`),
    );
    if (banner) banner.replaceWith(html);
    else if (content) main.insertBefore(html, content);
  } else if (nNeeds > 0 && route.view !== "failures") {
    const html = el(
      "a",
      { class: "banner needs", href: "#/failures", "data-banner": "needs_human" },
      el(
        "span",
        { class: "banner-left" },
        el("span", { class: "mono" }, `⚑ ${nNeeds} runs need human input`),
        el("span", {}, "every other loop is proceeding without you"),
      ),
      el("span", { class: "mono banner-right" }, "open failures →"),
    );
    if (banner) banner.replaceWith(html);
    else if (content) main.insertBefore(html, content);
  } else if (banner) banner.remove();
  if (table) syncRunsTable(table, store, now, go);
}

function renderRuns(store, now, go) {
  const snap = store.snapshot;
  if (!snap) return loadingBlock();
  const engs = orderedEngagements(store);
  if (!engs.length) {
    return [
      emptyBlock("○", "no engagements", "The orchestrator hasn't started any engagements yet. Rows will appear here the moment the first loop is queued."),
    ];
  }
  const table = el("div", { class: "runs-table" });
  table.append(
    el(
      "div",
      { class: "runs-head" },
      ...["engagement", "status", "active loop", "iteration", "attempt", "last event", "last note"].map((t) => el("span", {}, t)),
    ),
  );
  for (const eng of engs) table.append(makeRunRow(eng, store, now, go));
  const legend = el(
    "div",
    { class: "legend" },
    el("span", {}, "iteration = executor↔reviewer round (max 4)"),
    el("span", {}, "attempt = orchestrator retry (max 2)"),
    el("span", {}, "rows update in place via SSE — no reordering while connected"),
  );
  return [table, legend];
}

function fillGateRow(row, g) {
  const ok = g.passed === 1 || g.passed === true;
  const gs = statusOf("gate", ok ? "pass" : "fail");
  row.style.background = ok ? "transparent" : "var(--status-failed-tint)";
  const glyph = row.querySelector("[data-gate-glyph]");
  const name = row.querySelector("[data-gate-name]");
  const state = row.querySelector("[data-gate-state]");
  if (glyph) {
    glyph.textContent = gs.glyph;
    glyph.style.color = gs.fg;
  }
  if (name) name.textContent = g.check_name;
  if (state) {
    state.textContent = ok ? "pass" : "fail";
    state.style.color = gs.fg;
  }
}

function makeGateRow(g) {
  const ok = g.passed === 1 || g.passed === true;
  const gs = statusOf("gate", ok ? "pass" : "fail");
  const row = el(
    "div",
    {
      class: "gate-row",
      "data-gate": g.id,
      "data-row": g.id,
      style: { background: ok ? "transparent" : "var(--status-failed-tint)" },
    },
    el("span", { "data-gate-glyph": "1", style: { color: gs.fg } }, gs.glyph),
    el("span", { class: "mono", "data-gate-name": "1" }, g.check_name),
    el("span", { class: "mono", "data-gate-state": "1", style: { color: gs.fg } }, ok ? "pass" : "fail"),
  );
  return row;
}

function loopMetaText(run, now) {
  return `loop: ${run.loop_name}    iteration ${run.iteration_count}/4    attempt ${run.attempt}/2    last event ${rel(run.last_event_at, now)}`;
}

function fillPipeChip(chip, lr, active) {
  const ps = statusOf("run", lr?.status || "queued");
  chip.style.borderColor = active ? ps.border : tokens.color.border.default;
  chip.style.background = active ? ps.bg : "#ffffff";
  const state = chip.querySelector("[data-pipe-state]");
  if (state) {
    state.style.color = ps.fg;
    state.textContent = `${ps.glyph} ${lr?.status || "not started"}`;
  }
  let mark = chip.querySelector("[data-pipe-active]");
  if (active && !mark) chip.append(el("span", { class: "faint", "data-pipe-active": "1" }, "active"));
  else if (!active && mark) mark.remove();
}

function makePipeChip(seq, name, lr, active) {
  const ps = statusOf("run", lr?.status || "queued");
  return el(
    "div",
    {
      class: "pipe-chip",
      "data-pipe": name,
      style: { borderColor: active ? ps.border : tokens.color.border.default, background: active ? ps.bg : "#ffffff" },
    },
    el("span", { class: "faint" }, seq),
    el("span", { class: "mono" }, name),
    el("span", { "data-pipe-state": "1", style: { color: ps.fg } }, `${ps.glyph} ${lr?.status || "not started"}`),
    active ? el("span", { class: "faint", "data-pipe-active": "1" }, "active") : null,
  );
}

function fillIterRow(row, it, now) {
  const vs = statusOf("verdict", it.reviewer_verdict || "revise");
  const node = row.querySelector(".it-node");
  if (node) {
    node.textContent = String(it.n);
    node.style.background = vs.bg;
    node.style.borderColor = vs.border;
    node.style.color = vs.fg;
  }
  const badgeEl = row.querySelector("[data-badge]");
  if (badgeEl) paintBadge(badgeEl, "verdict", it.reviewer_verdict);
  const when = row.querySelector(".it-when");
  if (when) when.textContent = rel(it.created_at, now);
  const exec = row.querySelector(".it-exec");
  if (exec) exec.textContent = it.executor_summary || "";
  const rev = row.querySelector(".it-rev");
  if (rev) rev.textContent = `reviewer: ${it.reviewer_notes || ""}`;
  let trace = row.querySelector(".trace");
  if (it.pi_trace_ref) {
    if (!trace) {
      row.querySelector(".it-body")?.append(el("a", { href: it.pi_trace_ref, class: "trace" }, `${it.pi_trace_ref} ↗`));
    } else {
      trace.setAttribute("href", it.pi_trace_ref);
      trace.textContent = `${it.pi_trace_ref} ↗`;
    }
  } else if (trace) {
    trace.remove();
  }
}

function makeIterRow(it, now) {
  const vs = statusOf("verdict", it.reviewer_verdict || "revise");
  return el(
    "div",
    { class: "it-row", "data-iter-n": String(it.n) },
    el("div", { class: "it-node", style: { background: vs.bg, borderColor: vs.border, color: vs.fg } }, String(it.n)),
    el(
      "div",
      { class: "it-body" },
      el(
        "div",
        { class: "it-top" },
        el("span", {}, `iteration ${it.n}`),
        badge("verdict", it.reviewer_verdict),
        el("span", { class: "faint mono it-when" }, rel(it.created_at, now)),
      ),
      el("div", { class: "it-exec" }, it.executor_summary || ""),
      el("div", { class: "it-rev" }, `reviewer: ${it.reviewer_notes || ""}`),
      it.pi_trace_ref ? el("a", { href: it.pi_trace_ref, class: "trace" }, `${it.pi_trace_ref} ↗`) : null,
    ),
  );
}

function makePendingIter(n) {
  return el(
    "div",
    { class: "it-row pending", "data-iter-pending": "1" },
    el("div", { class: "it-node dashed" }, String(n)),
    el("span", { class: "faint mono" }, `iteration ${n} in progress — executor working`),
  );
}

function makeScrapeRow(s, now) {
  const codeFg = s.http_status === 200 ? tokens.color.status.passed.fg : tokens.color.status.failed.fg;
  return el(
    "div",
    { class: "scrape-row", "data-scrape": s.id },
    el("span", { class: "mono", "data-scrape-status": "1", style: { color: codeFg } }, String(s.http_status ?? "—")),
    el("span", { class: "mono scrape-url" }, s.url),
    el("span", { class: "faint mono", "data-scrape-when": "1" }, rel(s.created_at, now)),
  );
}

function fillScrapeRow(row, s, now) {
  const codeFg = s.http_status === 200 ? tokens.color.status.passed.fg : tokens.color.status.failed.fg;
  const st = row.querySelector("[data-scrape-status]");
  if (st) {
    st.textContent = String(s.http_status ?? "—");
    st.style.color = codeFg;
  }
  const url = row.querySelector(".scrape-url");
  if (url) url.textContent = s.url;
  const when = row.querySelector("[data-scrape-when]");
  if (when) when.textContent = rel(s.created_at, now);
}

function fillComparisonCard(wrap, cmp) {
  const next = renderComparison(cmp);
  wrap.replaceChildren(...[...next.childNodes]);
}

function renderLoop(store, route, now, go) {
  const snap = store.snapshot;
  if (!snap) return loadingBlock();
  const eng = snap.engagements.find((e) => e.id === route.engId);
  const run = snap.loop_runs.find((r) => r.id === route.runId);
  if (!eng || !run) return [emptyBlock("○", "run not found", "This loop run is not in the current snapshot.")];
  const iters = (snap.iterations || []).filter((i) => i.loop_run_id === run.id).sort((a, b) => a.n - b.n);
  const gates = (snap.gate_checks || []).filter((g) => g.loop_run_id === run.id);
  const scrapes = (snap.scrapes || []).filter((s) => s.loop_run_id === run.id);
  const crumb = el(
    "div",
    { class: "crumb" },
    el("a", { href: "#/runs", onClick: (e) => { e.preventDefault(); go("#/runs"); } }, "runs"),
    " / ",
    eng.id,
    " / ",
    run.id,
  );
  const head = el(
    "div",
    { class: "loop-head", "data-loop-head": "1" },
    el("div", { class: "h1", "data-loop-name": "1" }, eng.customer_name),
    badge("run", run.status),
  );
  const meta = el("div", { class: "loop-meta", "data-loop-meta": "1" }, loopMetaText(run, now));
  const pipe = el("div", { class: "pipeline", "data-pipeline": "1" });
  for (const [seq, name] of [
    ["01", "company-research"],
    ["02", "website"],
  ]) {
    const lr = latestRunFor(snap, eng.id, name);
    pipe.append(makePipeChip(seq, name, lr, run.loop_name === name));
    if (seq === "01") pipe.append(el("span", { class: "faint" }, "→"));
  }
  const kids = [crumb, head, meta, pipe];
  if (run.attempt > 0 || run.change_request_id) {
    kids.push(
      el(
        "div",
        { class: "adjusted", "data-adjusted": "1" },
        el("div", { class: "adjusted-h", "data-adjusted-h": "1" }, `⟳ attempt ${run.attempt} — orchestrator adjusted instructions`),
        el("pre", { class: "adjusted-body" }, run.adjusted_instructions || ""),
      ),
    );
  }
  const timeline = el(
    "div",
    { class: "card timeline", "data-timeline": "1" },
    el("div", { class: "card-h" }, "iterations — executor ↔ reviewer"),
  );
  for (const it of iters) timeline.append(makeIterRow(it, now));
  if (run.status === "running" && iters.length < 4) timeline.append(makePendingIter(iters.length + 1));
  const passed = gates.filter((g) => g.passed === 1 || g.passed === true).length;
  const gateCard = el("div", { class: "card", "data-gate-card": "1" }, el("div", { class: "card-h" }, "gate checks"));
  for (const g of gates) gateCard.append(makeGateRow(g));
  gateCard.append(el("div", { class: "faint mono gate-sum" }, `${passed}/${gates.length} passed · gate runs after reviewer approval`));
  const scrapeCard = el("div", { class: "card", "data-scrape-card": "1" }, el("div", { class: "card-h" }, "scrape provenance"));
  for (const s of scrapes) scrapeCard.append(makeScrapeRow(s, now));
  const cols = el("div", { class: "loop-cols" }, timeline, el("div", { class: "loop-side" }, gateCard, scrapeCard));
  kids.push(cols);
  const latest = Object.keys(snap.comparisons || {}).find((id) => {
    const r = snap.loop_runs.find((x) => x.id === id);
    return r && r.engagement_id === eng.id && r.loop_name === "company-research";
  });
  if (run.loop_name === "company-research") {
    if (snap.comparisons?.[run.id]) {
      kids.push(renderComparison(snap.comparisons[run.id]));
    } else if (latest && latest !== run.id) {
      kids.push(el("div", { class: "card cmp-superseded", "data-cmp-superseded": "1" }, `comparison superseded by ${latest}`));
    }
  }
  return kids;
}

export function renderComparison(cmp) {
  const wrap = el("div", { class: "card cmp-card", "data-comparison": "1" });
  wrap.append(el("div", { class: "card-h" }, "competitor comparison"));
  const table = el("div", { class: "cmp-table" });
  const head = el("div", { class: "cmp-head" });
  for (const c of cmp.columns) head.append(el("span", {}, c.label));
  table.append(head);
  for (const row of cmp.rows) {
    const r = el("div", { class: "cmp-row" });
    for (const cell of row.cells) {
      let text = cell.value ?? "";
      if (cell.state === "valid") text = `✓ ${text}`;
      if (cell.state === "flagged") text = `⚑ ${text}`;
      const node = cell.href
        ? el("a", { href: cell.href, class: "mono", "data-cmp-cell": cell.state || "" }, `${text} ↗`)
        : el("span", { class: "mono", "data-cmp-cell": cell.state || "" }, String(text));
      r.append(node);
    }
    table.append(r);
  }
  wrap.append(table);
  return wrap;
}

function orderedFailures(store) {
  const snap = store.snapshot;
  if (!snap) return [];
  const fails = (snap.loop_runs || []).filter((r) => r.status === "needs_human" || r.status === "gate_failed");
  const byId = new Map(fails.map((r) => [r.id, r]));
  const out = [];
  for (const id of store.failureOrder) if (byId.has(id)) out.push(byId.get(id));
  for (const r of fails) if (!out.includes(r)) out.push(r);
  return out;
}

function fillFailCard(card, run, store, now) {
  const snap = store.snapshot;
  const eng = snap.engagements.find((e) => e.id === run.engagement_id);
  const st = statusOf("run", run.status);
  const failed = (snap.gate_checks || []).find((g) => g.loop_run_id === run.id && !g.passed);
  const last = (snap.iterations || []).filter((i) => i.loop_run_id === run.id).at(-1);
  const accent = run.status === "needs_human" ? tokens.color.status.needs_human.fg : tokens.color.status.failed.fg;
  card.style.borderLeftColor = accent;
  card._run = run;
  card._eng = eng;
  const badgeEl = card.querySelector("[data-badge]");
  if (badgeEl) paintBadge(badgeEl, "run", run.status);
  const name = card.querySelector(".eng-name");
  if (name) name.textContent = eng?.customer_name || "";
  const ids = card.querySelector("[data-fail-ids]");
  if (ids) ids.textContent = `${eng?.id} / ${run.id}`;
  const when = card.querySelector("[data-fail-when]");
  if (when) when.textContent = rel(run.last_event_at, now);
  const chip = card.querySelector(".fail-chip");
  if (chip) chip.textContent = `✕ ${failed?.check_name || "—"}`;
  const notes = card.querySelector("[data-fail-notes]");
  if (notes) notes.textContent = `“${last?.reviewer_notes || ""}”`;
  const adj = card.querySelector("[data-fail-adj]");
  if (adj) {
    adj.textContent = run.adjusted_instructions || "";
    adj.style.color = run.status === "needs_human" ? st.fg : tokens.color.text.secondary;
  }
}

function makeFailCard(run, store, now, go) {
  const snap = store.snapshot;
  const eng = snap.engagements.find((e) => e.id === run.engagement_id);
  const card = el("div", {
    class: "fail-card",
    "data-row": run.id,
    onClick: () => {
      const e = card._eng;
      const r = card._run;
      if (e && r) go(`#/runs/${e.id}/${r.id}`);
    },
  });
  card.append(
    el(
      "div",
      { class: "fail-top" },
      badge("run", run.status),
      el("span", { class: "eng-name" }, ""),
      el("span", { class: "mono faint", "data-fail-ids": "1" }, ""),
      el("span", { class: "mono faint", "data-fail-when": "1" }, ""),
    ),
    el(
      "div",
      { class: "fail-grid" },
      el("span", { class: "faint mono" }, "failed check"),
      el("span", { class: "fail-chip" }, ""),
      el("span", { class: "faint mono" }, "reviewer objection"),
      el("span", { "data-fail-notes": "1" }, ""),
      el("span", { class: "faint mono" }, "orchestrator adjustment"),
      el("span", { class: "mono", "data-fail-adj": "1" }, ""),
    ),
  );
  fillFailCard(card, run, store, now);
  return card;
}

function syncFailures(list, store, now, go) {
  const fails = orderedFailures(store);
  const existing = [...list.querySelectorAll("[data-row]")];
  const byId = new Map(existing.map((n) => [n.getAttribute("data-row"), n]));
  const keep = new Set(fails.map((r) => r.id));
  for (const run of fails) {
    const card = byId.get(run.id);
    if (card) fillFailCard(card, run, store, now);
    else list.append(makeFailCard(run, store, now, go));
  }
  for (const card of existing) {
    if (!keep.has(card.getAttribute("data-row"))) card.remove();
  }
  for (const run of fails) {
    const card = list.querySelector(`[data-row="${run.id}"]`);
    if (card) list.append(card);
  }
}

function renderFailures(store, now, go) {
  const snap = store.snapshot;
  if (!snap) return loadingBlock();
  const fails = orderedFailures(store);
  if (!fails.length) {
    return [emptyBlock("✓", "nothing blocked", "No gate_failed or needs_human runs. Loops are handling it.")];
  }
  const list = el("div", { class: "fail-list" });
  for (const run of fails) list.append(makeFailCard(run, store, now, go));
  return [list];
}

function makeKbRow(f, now) {
  return el(
    "div",
    { class: "kb-row", "data-kb-file": f.path },
    el("span", { class: "faint" }, "▤"),
    el("span", {}, f.path),
    el("span", { class: "faint mono", "data-kb-when": "1" }, rel(f.updated, now)),
  );
}

function fillCustomerCard(card, eng, now) {
  const st = statusOf("engagement", eng.status);
  const dot = card.querySelector(".dot");
  if (dot) dot.style.background = st.fg;
  const name = card.querySelector(".eng-name");
  if (name) name.textContent = eng.customer_name || "";
  const id = card.querySelector("[data-cust-id]");
  if (id) id.textContent = eng.id;
  const label = card.querySelector("[data-cust-status]");
  if (label) {
    label.textContent = st.label;
    label.style.color = st.fg;
  }
  const files = card.querySelector("[data-kb-list]");
  if (files) {
    const existing = [...files.querySelectorAll("[data-kb-file]")];
    const byPath = new Map(existing.map((n) => [n.getAttribute("data-kb-file"), n]));
    const list = eng.kb_files || [];
    const keep = new Set(list.map((f) => f.path));
    for (const f of list) {
      const row = byPath.get(f.path);
      if (row) {
        const when = row.querySelector("[data-kb-when]");
        if (when) when.textContent = rel(f.updated, now);
      } else {
        files.append(makeKbRow(f, now));
      }
    }
    for (const row of existing) {
      if (!keep.has(row.getAttribute("data-kb-file"))) row.remove();
    }
  }
  const links = card.querySelector("[data-cust-links]");
  if (links) {
    let repo = links.querySelector("[data-repo-link]");
    if (eng.repo_url) {
      if (!repo) {
        repo = el("a", { href: eng.repo_url, "data-repo-link": "1" }, "repo ↗");
        links.prepend(repo);
      } else {
        repo.setAttribute("href", eng.repo_url);
      }
    } else if (repo) {
      repo.remove();
    }
    let live = links.querySelector("[data-live-link]");
    if (eng.live_url) {
      if (!live) {
        links.append(el("a", { href: eng.live_url, "data-live-link": "1" }, "live ↗"));
      } else {
        live.setAttribute("href", eng.live_url);
      }
    } else if (live) {
      live.remove();
    }
  }
}

function makeCustomerCard(eng, now) {
  const card = el("div", { class: "cust-card", "data-customer": eng.id, "data-row": eng.id });
  card.append(
    el(
      "div",
      { class: "cust-top" },
      el("span", { class: "dot" }),
      el("span", { class: "eng-name" }, ""),
      el("span", { class: "mono faint", "data-cust-id": "1" }, ""),
      el("span", { class: "mono", "data-cust-status": "1", style: { marginLeft: "auto" } }, ""),
    ),
  );
  const files = el("div", { class: "kb-list", "data-kb-list": "1" });
  for (const f of eng.kb_files || []) files.append(makeKbRow(f, now));
  card.append(files);
  const links = el("div", { class: "cust-links", "data-cust-links": "1" });
  if (eng.repo_url) links.append(el("a", { href: eng.repo_url, "data-repo-link": "1" }, "repo ↗"));
  if (eng.live_url) links.append(el("a", { href: eng.live_url, "data-live-link": "1" }, "live ↗"));
  card.append(links);
  fillCustomerCard(card, eng, now);
  return card;
}

function syncCustomers(grid, store, now) {
  const engs = orderedEngagements(store);
  const existing = [...grid.querySelectorAll("[data-customer]")];
  const byId = new Map(existing.map((n) => [n.getAttribute("data-customer"), n]));
  const keep = new Set(engs.map((e) => e.id));
  for (const eng of engs) {
    const card = byId.get(eng.id);
    if (card) fillCustomerCard(card, eng, now);
    else grid.append(makeCustomerCard(eng, now));
  }
  for (const card of existing) {
    if (!keep.has(card.getAttribute("data-customer"))) card.remove();
  }
}

function renderCustomers(store, now) {
  const snap = store.snapshot;
  if (!snap) return loadingBlock();
  const engs = orderedEngagements(store);
  if (!engs.length) {
    return [emptyBlock("○", "no customers", "Engagements will appear here once the orchestrator creates them.")];
  }
  const grid = el("div", { class: "cust-grid" });
  for (const eng of engs) grid.append(makeCustomerCard(eng, now));
  return [grid];
}

function syncLoop(shell, route, store, now) {
  const snap = store.snapshot;
  const run = snap?.loop_runs?.find((r) => r.id === route.runId);
  const eng = snap?.engagements?.find((e) => e.id === route.engId);
  if (!run || !eng) return false;
  const head = shell.querySelector("[data-loop-head]");
  if (!head) return false;
  const name = head.querySelector("[data-loop-name]");
  if (name) name.textContent = eng.customer_name || "";
  const badgeEl = head.querySelector("[data-badge]");
  if (badgeEl) paintBadge(badgeEl, "run", run.status);
  const meta = shell.querySelector("[data-loop-meta]");
  if (meta) meta.textContent = loopMetaText(run, now);
  const pipe = shell.querySelector("[data-pipeline]");
  if (pipe) {
    for (const name of ["company-research", "website"]) {
      const chip = pipe.querySelector(`[data-pipe="${name}"]`);
      if (!chip) continue;
      const lr = latestRunFor(snap, eng.id, name);
      fillPipeChip(chip, lr, run.loop_name === name);
    }
  }
  const adj = shell.querySelector("[data-adjusted]");
  if (run.attempt > 0 || run.change_request_id) {
    if (adj) {
      const h = adj.querySelector("[data-adjusted-h]");
      if (h) h.textContent = `⟳ attempt ${run.attempt} — orchestrator adjusted instructions`;
      const body = adj.querySelector(".adjusted-body");
      if (body) body.textContent = run.adjusted_instructions || "";
    }
  } else if (adj) {
    adj.remove();
  }
  const timeline = shell.querySelector("[data-timeline]");
  const iters = (snap.iterations || []).filter((i) => i.loop_run_id === run.id).sort((a, b) => a.n - b.n);
  if (timeline) {
    const existing = [...timeline.querySelectorAll("[data-iter-n]")];
    const byN = new Map(existing.map((n) => [n.getAttribute("data-iter-n"), n]));
    const keep = new Set(iters.map((i) => String(i.n)));
    const pending = timeline.querySelector("[data-iter-pending]");
    for (const it of iters) {
      const row = byN.get(String(it.n));
      if (row) fillIterRow(row, it, now);
      else timeline.insertBefore(makeIterRow(it, now), pending);
    }
    for (const row of existing) {
      if (!keep.has(row.getAttribute("data-iter-n"))) row.remove();
    }
    const wantPending = run.status === "running" && iters.length < 4;
    if (wantPending) {
      const n = iters.length + 1;
      if (pending) {
        const node = pending.querySelector(".it-node");
        if (node) node.textContent = String(n);
        const label = pending.querySelector(".faint");
        if (label) label.textContent = `iteration ${n} in progress — executor working`;
      } else {
        timeline.append(makePendingIter(n));
      }
    } else if (pending) {
      pending.remove();
    }
  }
  const gates = (snap.gate_checks || []).filter((g) => g.loop_run_id === run.id);
  const card = shell.querySelector("[data-gate-card]");
  if (!card) return false;
  const existing = [...card.querySelectorAll("[data-gate]")];
  const byId = new Map(existing.map((n) => [n.getAttribute("data-gate"), n]));
  const keep = new Set(gates.map((g) => g.id));
  const sum = card.querySelector(".gate-sum");
  for (const g of gates) {
    const row = byId.get(g.id);
    if (row) fillGateRow(row, g);
    else card.insertBefore(makeGateRow(g), sum);
  }
  for (const row of existing) {
    if (!keep.has(row.getAttribute("data-gate"))) row.remove();
  }
  const passed = gates.filter((g) => g.passed === 1 || g.passed === true).length;
  if (sum) sum.textContent = `${passed}/${gates.length} passed · gate runs after reviewer approval`;
  const scrapeCard = shell.querySelector("[data-scrape-card]");
  const scrapes = (snap.scrapes || []).filter((s) => s.loop_run_id === run.id);
  if (scrapeCard) {
    const existingS = [...scrapeCard.querySelectorAll("[data-scrape]")];
    const byId = new Map(existingS.map((n) => [n.getAttribute("data-scrape"), n]));
    const keepS = new Set(scrapes.map((s) => s.id));
    for (const s of scrapes) {
      let row = byId.get(s.id);
      if (row) fillScrapeRow(row, s, now);
      else {
        row = makeScrapeRow(s, now);
        scrapeCard.append(row);
        byId.set(s.id, row);
      }
    }
    for (const row of existingS) {
      if (!keepS.has(row.getAttribute("data-scrape"))) row.remove();
    }
    for (const s of scrapes) {
      const row = byId.get(s.id);
      if (row) scrapeCard.append(row);
    }
  }
  const latest = Object.keys(snap.comparisons || {}).find((id) => {
    const r = snap.loop_runs.find((x) => x.id === id);
    return r && r.engagement_id === eng.id && r.loop_name === "company-research";
  });
  if (run.loop_name === "company-research") {
    const main = shell.querySelector("main") || shell;
    let cmpCard = shell.querySelector("[data-comparison]");
    const superseded = shell.querySelector("[data-cmp-superseded]");
    if (snap.comparisons?.[run.id]) {
      if (superseded) superseded.remove();
      if (cmpCard) fillComparisonCard(cmpCard, snap.comparisons[run.id]);
      else main.append(renderComparison(snap.comparisons[run.id]));
    } else if (latest && latest !== run.id) {
      if (cmpCard) cmpCard.remove();
      const msg = `comparison superseded by ${latest}`;
      if (superseded) superseded.textContent = msg;
      else main.append(el("div", { class: "card cmp-superseded", "data-cmp-superseded": "1" }, msg));
    }
  }
  return true;
}

export function renderApp(root, { store, hash, now, go = (h) => { window.location.hash = h; } }) {
  applyStatusVars();
  if (now == null) now = serverNow(store.snapshot);
  const route = parseHash(hash);
  const existing = root.querySelector(":scope > .shell");
  if (existing && existing.getAttribute("data-view") === route.view) {
    if (route.view === "runs") {
      const table = existing.querySelector(".runs-table");
      if (table) {
        patchRunsShell(existing, table, { store, hash, now, go }, route);
        return root;
      }
    } else if (route.view === "failures") {
      const list = existing.querySelector(".fail-list");
      if (list) {
        patchRunsShell(existing, null, { store, hash, now, go }, route);
        syncFailures(list, store, now, go);
        return root;
      }
    } else if (route.view === "customers") {
      const grid = existing.querySelector(".cust-grid");
      if (grid) {
        patchRunsShell(existing, null, { store, hash, now, go }, route);
        syncCustomers(grid, store, now);
        return root;
      }
    } else if (route.view === "loop") {
      if (existing.dataset.engId === route.engId && existing.dataset.runId === route.runId) {
        patchRunsShell(existing, null, { store, hash, now, go }, route);
        if (syncLoop(existing, route, store, now)) return root;
      }
    }
  }
  root.replaceChildren();
  const snap = store.snapshot;
  const sse = store.sse;
  const conn = connLabel(sse, now);
  const nNeeds = needsCount(snap);
  const active = (snap?.engagements || []).filter((e) => ["running", "needs_human", "new", "awaiting_approval"].includes(e.status)).length;

  const shell = el("div", { class: "shell", "data-view": route.view });
  if (route.view === "loop") {
    shell.dataset.engId = route.engId;
    shell.dataset.runId = route.runId;
  }
  const nav = [
    { href: "#/runs", glyph: "▤", label: "Runs", count: active, show: true },
    { href: "#/failures", glyph: "⚑", label: "Failures", count: nNeeds, show: nNeeds > 0, amber: true },
    { href: "#/customers", glyph: "▦", label: "Customers", count: "", show: false },
    { href: "graph.html", glyph: "◎", label: "How it works", count: "", show: false },
  ];
  const side = el(
    "aside",
    { class: "sidebar" },
    el("div", { class: "brand" }, el("div", { class: "wordmark" }, "tenwhy / loop graph"), el("div", { class: "sub" }, "operations console")),
    el(
      "div",
      { class: "conn", "data-conn": sse.state },
      el("span", { class: "conn-dot", style: { background: conn.dot, animation: conn.anim } }),
      el(
        "div",
        { class: "conn-text" },
        el("div", { class: "mono", "data-conn-label": "1", style: { color: conn.fg } }, conn.label),
        el("div", { class: "faint", "data-conn-sub": "1" }, conn.sub),
      ),
    ),
    el(
      "nav",
      { class: "nav" },
      ...nav.map((n) =>
        el(
          "a",
          { href: n.href, class: "nav-item" + (hash?.startsWith(n.href) || (n.href === "#/runs" && route.view === "loop") ? " on" : "") },
          el("span", { class: "mono" }, n.glyph),
          el("span", {}, n.label),
          n.show ? el("span", { class: "nav-count" + (n.amber ? " amber" : "") }, String(n.count)) : null,
        ),
      ),
    ),
    el("div", { class: "grow" }),
    el(
      "div",
      { class: "side-foot" },
      el("div", { class: "mono faint" }, "read-only console"),
      el("div", { class: "faint" }, "Loops act autonomously. This surface observes; it never writes."),
      el("div", { class: "mono faint", "data-snapshot-clock": "1" }, `snapshot ${clockTime(snap?.serverTime)} · v0.1.0`),
    ),
  );
  const main = el("main", { class: "main" });
  if (sse.state === "disconnected") {
    main.append(
      el(
        "div",
        { class: "banner disc", "data-banner": "disconnected" },
        el("span", { class: "mono" }, "✕ stream disconnected"),
        el("span", {}, `showing snapshot from ${snap?.snapshotAt ? rel(snap.snapshotAt, now) : "—"} — snapshot`),
      ),
    );
  } else if (nNeeds > 0 && route.view !== "failures") {
    main.append(
      el(
        "a",
        { class: "banner needs", href: "#/failures", "data-banner": "needs_human" },
        el(
          "span",
          { class: "banner-left" },
          el("span", { class: "mono" }, `⚑ ${nNeeds} runs need human input`),
          el("span", {}, "every other loop is proceeding without you"),
        ),
        el("span", { class: "mono banner-right" }, "open failures →"),
      ),
    );
  }
  const content = el("div", { class: "content" });
  if (route.view === "runs") {
    const nEng = snap?.engagements?.length ?? 0;
    const nActive = activeEngagements(snap);
    content.append(
      el(
        "div",
        { class: "page-head" },
        el("div", { class: "h1" }, "Runs"),
        el("div", { class: "page-sum", "data-runs-summary": "1" }, `${nEng} engagements · ${nActive} active · sorted by last event`),
      ),
    );
  } else if (route.view === "failures") {
    content.append(el("div", { class: "h1" }, "Failures"));
  } else if (route.view === "customers") {
    content.append(el("div", { class: "h1" }, "Customers"));
  }
  let body;
  if (route.view === "runs") body = renderRuns(store, now, go);
  else if (route.view === "loop") body = renderLoop(store, route, now, go);
  else if (route.view === "failures") body = renderFailures(store, now, go);
  else body = renderCustomers(store, now);
  for (const n of body) content.append(n);
  main.append(content);
  shell.append(side, main);
  root.append(shell);
  return root;
}
