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

/** Website runs whose started_at precedes the latest change-request cutoff. */
export function deriveStaleWebsiteRunIds({ events = [], loop_runs = [], approvals = [] } = {}) {
  const changeEvents = (events || []).filter((e) => e.kind === "engagement.change_requested");
  const reqs = (approvals || []).filter((a) => a.action === "request_changes");
  if (!changeEvents.length && !reqs.length) return new Set();

  let keepId = null;
  let cutoff = null;
  if (changeEvents.length) {
    const latest = changeEvents.reduce((a, b) => ((Number(a.id) || 0) >= (Number(b.id) || 0) ? a : b));
    keepId = latest.loop_run_id || latest.payload?.runId || null;
    cutoff = latest.created_at || null;
  }
  if (reqs.length) {
    const latestA = reqs.reduce((a, b) => (String(a.created_at || "") > String(b.created_at || "") ? a : b));
    if (!cutoff || String(latestA.created_at || "") >= String(cutoff)) {
      cutoff = latestA.created_at || cutoff;
      if (!changeEvents.length) keepId = null;
    }
  }

  const ids = new Set();
  for (const r of loop_runs || []) {
    if (r.loop_name !== "website") continue;
    if (keepId && r.id === keepId) continue;
    if (keepId) {
      ids.add(r.id);
      continue;
    }
    if (!r.started_at || !cutoff || r.started_at <= cutoff) ids.add(r.id);
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
  if (list.some((e) => e.kind === "loop_run.started" && loopNameOf(e, runsById) === "company-research")) {
    completed = 1;
  }
  if (list.some((e) => e.kind === "iteration.recorded" && loopNameOf(e, runsById) === "company-research")) {
    completed = 2;
  }
  const researchPlanned = list.some((e) => {
    if (e.kind === "handoff") return true;
    return e.kind === "gate.checked" && loopNameOf(e, runsById) === "company-research" && payloadPassed(e.payload);
  });
  if (researchPlanned) completed = 3;
  if (list.some((e) => e.kind === "iteration.recorded" && loopNameOf(e, runsById) === "website")) {
    completed = 4;
  }
  const webChecks = list.filter((e) => e.kind === "gate.checked" && loopNameOf(e, runsById) === "website");
  const webPass = webChecks.some((e) => payloadPassed(e.payload));
  const webFail = webChecks.length > 0 && !webPass;
  if (webPass) completed = 5;
  return {
    completed,
    activeIndex: completed >= 5 ? -1 : completed,
    hold: webFail && !webPass,
  };
}
