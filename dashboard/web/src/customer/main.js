import { parseCustomerHash, renderCustomerApp } from "./app.js";
import "./style.css";

const root = document.getElementById("app");
const state = {
  engagement: null,
  events: [],
  loop_runs: [],
  research: null,
  comparison: null,
  pages: [],
  tab: "research",
  busy: false,
  error: "",
  liveUrl: null,
  launching: false,
  showNotes: false,
  rebuilding: false,
  lastEventId: 0,
};
let es = null;

function clientHeaders() {
  return { "content-type": "application/json", "X-Tenwhy-Client": "customer-ui" };
}

function go(hash) {
  if (window.location.hash !== hash) window.location.hash = hash;
  else paint();
}

function mergeRuns(rows) {
  if (!Array.isArray(rows)) return;
  const byId = new Map(state.loop_runs.map((r) => [r.id, r]));
  for (const r of rows) byId.set(r.id, { ...byId.get(r.id), ...r });
  state.loop_runs = [...byId.values()];
}

function applyPatch(p) {
  if (p.kind) {
    state.events = [...state.events, { id: p.id, kind: p.kind, loop_run_id: p.loop_run_id, payload: p.payload || {} }];
  }
  if (p.id) state.lastEventId = Math.max(state.lastEventId, Number(p.id) || 0);
  if (p.entities?.loop_runs) mergeRuns(p.entities.loop_runs);
  if (p.entities?.engagements?.[0]) {
    state.engagement = { ...state.engagement, ...p.entities.engagements[0] };
  }
  if (p.kind === "engagement.complete") {
    state.liveUrl = p.payload?.liveUrl || p.payload?.live_url || state.liveUrl;
    state.launching = false;
  }
  if (p.kind === "engagement.awaiting_approval" && state.engagement?.id) {
    state.rebuilding = false;
    go(`#/e/${state.engagement.id}/results`);
    return;
  }
  paint();
}

function connectEvents(id) {
  if (es) {
    try { es.close(); } catch { /* */ }
  }
  const url = `/api/events?engagement=${encodeURIComponent(id)}&since=${state.lastEventId || 0}`;
  es = new EventSource(url);
  es.addEventListener("patch", (ev) => {
    try {
      applyPatch(JSON.parse(ev.data));
    } catch {
      /* */
    }
  });
}

async function loadEngagement(id) {
  const res = await fetch(`/api/engagements/${id}`);
  if (!res.ok) return;
  const bundle = await res.json();
  state.engagement = bundle.engagement;
  state.events = bundle.events || [];
  state.loop_runs = bundle.loop_runs || [];
  state.lastEventId = bundle.lastEventId || 0;
  connectEvents(id);
  if (bundle.engagement?.status === "awaiting_approval") {
    await loadResults(id);
    go(`#/e/${id}/results`);
    return;
  }
  if (bundle.engagement?.status === "complete") {
    state.liveUrl = bundle.engagement.live_url;
    await loadResults(id);
    go(`#/e/${id}/results`);
    return;
  }
  paint();
}

async function loadResults(id) {
  const [research, manifest] = await Promise.all([
    fetch(`/api/engagements/${id}/research`).then((r) => (r.ok ? r.json() : null)),
    fetch(`/api/engagements/${id}/preview-manifest`).then((r) => (r.ok ? r.json() : { pages: [] })),
  ]);
  if (research) {
    state.research = research.research;
    state.comparison = research.comparison;
  }
  state.pages = manifest?.pages || [];
}

function paint() {
  const route = parseCustomerHash(window.location.hash);
  renderCustomerApp(root, {
    hash: window.location.hash || "#/",
    engagement: state.engagement,
    events: state.events,
    loop_runs: state.loop_runs,
    research: state.research,
    comparison: state.comparison,
    pages: state.pages,
    tab: state.tab,
    busy: state.busy,
    error: state.error,
    liveUrl: state.liveUrl,
    launching: state.launching,
    showNotes: state.showNotes,
    rebuilding: state.rebuilding,
    onTab: (tab) => {
      state.tab = tab;
      paint();
    },
    onCreate: ({ idea, site_url }) => {
      fetch("/api/engagements", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idea, site_url }),
      })
        .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
        .then(({ ok, j }) => {
          if (!ok || !j.id) return;
          go(`#/e/${j.id}`);
        });
    },
    onApprove: async () => {
      if (!state.engagement?.id || state.busy) return;
      state.busy = true;
      state.error = "";
      state.launching = true;
      paint();
      const res = await fetch(`/api/engagements/${state.engagement.id}/approve`, {
        method: "POST",
        headers: clientHeaders(),
        body: "{}",
      });
      state.busy = false;
      if (res.status === 409) {
        state.launching = false;
        state.error = "this project isn't waiting for approval right now";
      } else if (!res.ok) {
        state.launching = false;
        state.error = "approve failed";
      }
      paint();
    },
    onRequest: async () => {
      if (!state.showNotes) {
        state.showNotes = true;
        paint();
        return;
      }
      const notes = root.querySelector("[data-notes]")?.value?.trim() || "";
      if (!notes) {
        state.error = "notes required";
        paint();
        return;
      }
      state.busy = true;
      state.error = "";
      paint();
      const res = await fetch(`/api/engagements/${state.engagement.id}/request-changes`, {
        method: "POST",
        headers: clientHeaders(),
        body: JSON.stringify({ notes }),
      });
      state.busy = false;
      if (res.status === 409) {
        state.error = "this project isn't waiting for approval right now";
        paint();
        return;
      }
      if (res.status === 400) {
        state.error = "notes required";
        paint();
        return;
      }
      state.showNotes = false;
      state.rebuilding = true;
      go(`#/e/${state.engagement.id}`);
    },
  });
  if ((route.view === "loading" || route.view === "results") && route.id && !state.engagement) {
    loadEngagement(route.id);
  }
}

window.addEventListener("hashchange", paint);
paint();
