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

function renderLoop(store, route, now, go) {
  const snap = store.snapshot;
  if (!snap) return loadingBlock();
  const eng = snap.engagements.find((e) => e.id === route.engId);
  const run = snap.loop_runs.find((r) => r.id === route.runId);
  if (!eng || !run) return [emptyBlock("○", "run not found", "This loop run is not in the current snapshot.")];
  const st = statusOf("run", run.status);
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
    { class: "loop-head" },
    el("div", { class: "h1" }, eng.customer_name),
    badge("run", run.status),
  );
  const meta = el(
    "div",
    { class: "loop-meta" },
    `loop: ${run.loop_name}    iteration ${run.iteration_count}/4    attempt ${run.attempt}/2    last event ${rel(run.last_event_at, now)}`,
  );
  const pipe = el("div", { class: "pipeline" });
  for (const [seq, name] of [
    ["01", "company-research"],
    ["02", "website"],
  ]) {
    const lr = runsFor(snap, eng.id).find((r) => r.loop_name === name);
    const ps = statusOf("run", lr?.status || "queued");
    const active = run.loop_name === name;
    const chip = el(
      "div",
      { class: "pipe-chip", style: { borderColor: active ? ps.border : tokens.color.border.default, background: active ? ps.bg : "#ffffff" } },
      el("span", { class: "faint" }, seq),
      el("span", { class: "mono" }, name),
      el("span", { style: { color: ps.fg } }, `${ps.glyph} ${lr?.status || "queued"}`),
      active ? el("span", { class: "faint" }, "active") : null,
    );
    pipe.append(chip);
    if (seq === "01") pipe.append(el("span", { class: "faint" }, "→"));
  }
  const kids = [crumb, head, meta, pipe];
  if (run.attempt > 0 || run.change_request_id) {
    kids.push(
      el(
        "div",
        { class: "adjusted", "data-adjusted": "1" },
        el("div", { class: "adjusted-h" }, `⟳ attempt ${run.attempt} — orchestrator adjusted instructions`),
        el("pre", { class: "adjusted-body" }, run.adjusted_instructions || ""),
      ),
    );
  }
  const timeline = el("div", { class: "card timeline" }, el("div", { class: "card-h" }, "iterations — executor ↔ reviewer"));
  for (const it of iters) {
    const vs = statusOf("verdict", it.reviewer_verdict || "revise");
    timeline.append(
      el(
        "div",
        { class: "it-row" },
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
          it.pi_trace_ref
            ? el("a", { href: it.pi_trace_ref, class: "trace" }, `${it.pi_trace_ref} ↗`)
            : null,
        ),
      ),
    );
  }
  if (run.status === "running" && iters.length < 4) {
    timeline.append(
      el(
        "div",
        { class: "it-row pending" },
        el("div", { class: "it-node dashed" }, String(iters.length + 1)),
        el("span", { class: "faint mono" }, `iteration ${iters.length + 1} in progress — executor working`),
      ),
    );
  }
  const passed = gates.filter((g) => g.passed === 1 || g.passed === true).length;
  const gateCard = el("div", { class: "card", "data-gate-card": "1" }, el("div", { class: "card-h" }, "gate checks"));
  for (const g of gates) {
    gateCard.append(makeGateRow(g));
  }
  gateCard.append(el("div", { class: "faint mono gate-sum" }, `${passed}/${gates.length} passed · gate runs after reviewer approval`));
  const scrapeCard = el("div", { class: "card" }, el("div", { class: "card-h" }, "scrape provenance"));
  for (const s of scrapes) {
    const codeFg = s.http_status === 200 ? tokens.color.status.passed.fg : tokens.color.status.failed.fg;
    scrapeCard.append(
      el(
        "div",
        { class: "scrape-row" },
        el("span", { class: "mono", style: { color: codeFg } }, String(s.http_status ?? "—")),
        el("span", { class: "mono scrape-url" }, s.url),
        el("span", { class: "faint mono" }, rel(s.created_at, now)),
      ),
    );
  }
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
      kids.push(el("div", { class: "card cmp-superseded" }, `comparison superseded by ${latest}`));
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
  const files = el("div", { class: "kb-list" });
  for (const f of eng.kb_files || []) {
    files.append(
      el(
        "div",
        { class: "kb-row", "data-kb-file": f.path },
        el("span", { class: "faint" }, "▤"),
        el("span", {}, f.path),
        el("span", { class: "faint mono" }, rel(f.updated, now)),
      ),
    );
  }
  card.append(files);
  const links = el("div", { class: "cust-links" });
  if (eng.repo_url) links.append(el("a", { href: eng.repo_url }, "repo ↗"));
  if (eng.live_url) links.append(el("a", { href: eng.live_url }, "live ↗"));
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
  if (!run) return false;
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
