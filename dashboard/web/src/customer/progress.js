export const STEP_LABELS = [
  "reading your site / brief",
  "researching the market",
  "planning",
  "building your site",
  "final checks",
];

export const PHASES = [
  { title: "Reading your website", sub: "Learning what you do, who you serve, and how you talk about it." },
  { title: "Researching your market", sub: "Profiling competitors and comparing offers, pricing, and positioning." },
  { title: "Planning your site", sub: "Turning the research into a sitemap and page briefs." },
  { title: "Writing and building", sub: "Drafting copy and assembling pages. A reviewer checks every draft." },
  { title: "Final checks", sub: "Speed, links, and deploy checks before anything goes live." },
];

function loopNameOf(ev, runsById) {
  const run = runsById.get(ev.loop_run_id);
  if (run?.loop_name) return run.loop_name;
  const p = ev.payload || {};
  return p.loopName || p.loop || p.to || null;
}

function payloadPassed(p) {
  if (!p || typeof p !== "object") return false;
  return p.passed === true || p.passed === 1 || p.allPassed === true;
}

function changeRequestCutoff(events = [], approvals = []) {
  const cuts = [];
  for (const e of events || []) {
    if (e.kind === "engagement.change_requested") {
      cuts.push({ at: e.created_at || "", id: Number(e.id) || 0 });
    } else if (e.kind === "approval.processed" && e.payload?.action === "request_changes") {
      cuts.push({ at: e.created_at || "", id: Number(e.id) || 0 });
    }
  }
  for (const a of approvals || []) {
    if (a.action === "request_changes") cuts.push({ at: a.created_at || "", id: 0 });
  }
  if (!cuts.length) return null;
  return cuts.reduce((a, b) => {
    const cmp = String(a.at).localeCompare(String(b.at));
    if (cmp !== 0) return cmp > 0 ? a : b;
    return a.id >= b.id ? a : b;
  });
}

function websiteRunStart(run, events) {
  if (run?.started_at) return { at: run.started_at, id: Infinity };
  let at = null;
  let id = Infinity;
  for (const e of events || []) {
    if (e.loop_run_id !== run.id) continue;
    if (e.created_at && (at == null || String(e.created_at) < String(at))) at = e.created_at;
    const eid = Number(e.id) || 0;
    if (eid && eid < id) id = eid;
  }
  return { at, id: id === Infinity ? 0 : id };
}

/** Website runs whose started_at (or first event) precedes the latest change-request cutoff. */
export function deriveStaleWebsiteRunIds({ events = [], loop_runs = [], approvals = [] } = {}) {
  const cutoff = changeRequestCutoff(events, approvals);
  if (!cutoff) return new Set();
  const ids = new Set();
  for (const r of loop_runs || []) {
    if (r.loop_name !== "website") continue;
    const start = websiteRunStart(r, events);
    if (start.at && cutoff.at) {
      if (String(start.at) < String(cutoff.at)) ids.add(r.id);
      continue;
    }
    if (!start.at && cutoff.id && start.id && start.id < cutoff.id) ids.add(r.id);
  }
  return ids;
}

export function loadingProgress({ events = [], loop_runs = [], approvals = [], staleWebsiteRunIds } = {}) {
  const stale = new Set([
    ...(staleWebsiteRunIds || []),
    ...deriveStaleWebsiteRunIds({ events, loop_runs, approvals }),
  ]);
  const runsById = new Map((loop_runs || []).map((r) => [r.id, r]));
  const list = (events || []).filter((e) => !(e.loop_run_id && stale.has(e.loop_run_id)));
  let completed = 0;
  const isLoop = (e, name) => loopNameOf(e, runsById) === name;
  // Step semantics (index → label): 0 reading, 1 researching, 2 planning, 3 building, 4 final checks.
  // A step is "done" only on the structural signal that ends it — never on an intermediate
  // iteration, so a failed gate + orchestrator retry keeps the customer on the same step.
  if (list.some((e) => e.kind === "loop_run.started" && isLoop(e, "company-research"))) {
    completed = 1; // reading done → researching active
  }
  const researchPassed = list.some((e) => {
    if (e.kind === "handoff") return true;
    return e.kind === "gate.checked" && isLoop(e, "company-research") && payloadPassed(e.payload);
  });
  if (researchPassed) completed = 2; // researching done → planning (designer) active
  const planned = list.some(
    (e) => (e.kind === "loop_run.prepared" || e.kind === "iteration.recorded") && isLoop(e, "website"),
  );
  if (researchPassed && planned) completed = 3; // planning done → building active
  const reviewerApproved = list.some(
    (e) => e.kind === "iteration.recorded" && isLoop(e, "website") && String(e.payload?.verdict || "") === "approve",
  );
  const webChecks = list.filter((e) => e.kind === "gate.checked" && loopNameOf(e, runsById) === "website");
  const webPass = webChecks.some((e) => payloadPassed(e.payload));
  const webFail = webChecks.length > 0 && !webPass;
  if (researchPassed && planned && (reviewerApproved || webChecks.length > 0)) completed = 4; // building done → final checks active
  if (webPass) completed = 5;
  return {
    completed,
    activeIndex: completed >= 5 ? -1 : completed,
    hold: webFail && !webPass,
  };
}
