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

export function loadingProgress({ events = [], loop_runs = [] } = {}) {
  const runsById = new Map((loop_runs || []).map((r) => [r.id, r]));
  const list = events || [];
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
