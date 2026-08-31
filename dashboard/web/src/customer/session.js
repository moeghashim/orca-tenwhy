import { parseCustomerHash } from "./app.js";

export function createCustomerState() {
  return {
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
    resultsLoaded: false,
    navigateTo: null,
    staleWebsiteRunIds: new Set(),
  };
}

export function is2xx(status) {
  return status >= 200 && status < 300;
}

export function resetWebsiteProgress(state) {
  const stale = new Set(
    (state.loop_runs || []).filter((r) => r.loop_name === "website").map((r) => r.id),
  );
  state.staleWebsiteRunIds = new Set([...(state.staleWebsiteRunIds || []), ...stale]);
  state.events = (state.events || []).filter((e) => !stale.has(e.loop_run_id));
  state.rebuilding = true;
  state.resultsLoaded = false;
}

export function clientHeaders() {
  return { "content-type": "application/json", "X-Tenwhy-Client": "customer-ui" };
}

function mergeRuns(state, rows) {
  if (!Array.isArray(rows)) return;
  const byId = new Map(state.loop_runs.map((r) => [r.id, r]));
  for (const r of rows) byId.set(r.id, { ...byId.get(r.id), ...r });
  state.loop_runs = [...byId.values()];
}

export function applyPatch(state, p) {
  if (!p) return state;
  const stale = state.staleWebsiteRunIds || new Set();
  if (p.kind) {
    if (!(p.loop_run_id && stale.has(p.loop_run_id))) {
      state.events = [...state.events, { id: p.id, kind: p.kind, loop_run_id: p.loop_run_id, payload: p.payload || {} }];
    }
  }
  if (p.id) state.lastEventId = Math.max(state.lastEventId, Number(p.id) || 0);
  if (p.entities?.loop_runs) mergeRuns(state, p.entities.loop_runs);
  if (p.entities?.engagements?.[0]) {
    state.engagement = { ...state.engagement, ...p.entities.engagements[0] };
  }
  if (p.kind === "engagement.complete") {
    state.liveUrl = p.payload?.liveUrl || p.payload?.live_url || state.liveUrl;
    state.launching = false;
  }
  if (p.kind === "engagement.awaiting_approval" && state.engagement?.id) {
    state.rebuilding = false;
    state.navigateTo = `#/e/${state.engagement.id}/results`;
  }
  if (state.engagement?.status === "needs_human") {
    state.navigateTo = state.navigateTo || null;
  }
  return state;
}

export function createCustomerSession(deps) {
  const state = createCustomerState();
  let es = null;
  let gen = 0;

  function getHash() {
    return deps.getHash ? deps.getHash() : "#/";
  }

  function go(hash) {
    state.navigateTo = hash;
    if (deps.setHash) deps.setHash(hash);
  }

  function connectEvents(id) {
    if (es) {
      try {
        es.close();
      } catch {
        /* */
      }
    }
    const ES = deps.EventSource;
    if (!ES) return;
    const url = `/api/events?engagement=${encodeURIComponent(id)}&since=${state.lastEventId || 0}`;
    es = new ES(url);
    es.addEventListener("patch", (ev) => {
      const done = Promise.resolve()
        .then(async () => {
          applyPatch(state, JSON.parse(ev.data));
          const dest = state.navigateTo;
          if (dest && dest.includes("/results") && state.engagement?.id) {
            state.navigateTo = null;
            state.resultsLoaded = false;
            await loadResults(state.engagement.id);
            go(dest);
            return;
          }
          if (dest) {
            state.navigateTo = null;
            go(dest);
            return;
          }
          await paint();
        })
        .catch(() => {});
      return done;
    });
  }

  async function loadResults(id) {
    const fetchFn = deps.fetch;
    const [bundle, research, manifest] = await Promise.all([
      fetchFn(`/api/engagements/${id}`).then((r) => (r.ok ? r.json() : null)),
      fetchFn(`/api/engagements/${id}/research`).then((r) => (r.ok ? r.json() : null)),
      fetchFn(`/api/engagements/${id}/preview-manifest`).then((r) => (r.ok ? r.json() : { pages: [] })),
    ]);
    if (bundle?.engagement) {
      state.engagement = { ...state.engagement, ...bundle.engagement };
      if (bundle.loop_runs) mergeRuns(state, bundle.loop_runs);
    }
    if (research) {
      state.research = research.research;
      state.comparison = research.comparison;
    }
    state.pages = manifest?.pages || [];
    state.resultsLoaded = true;
  }

  async function loadEngagement(id) {
    const res = await deps.fetch(`/api/engagements/${id}`);
    if (!res.ok) return;
    const bundle = await res.json();
    state.engagement = bundle.engagement;
    state.events = bundle.events || [];
    state.loop_runs = bundle.loop_runs || [];
    state.lastEventId = bundle.lastEventId || 0;
    connectEvents(id);
    if (bundle.engagement?.status === "awaiting_approval" || bundle.engagement?.status === "complete") {
      if (bundle.engagement.status === "complete") {
        state.liveUrl = bundle.engagement.live_url;
      }
      await loadResults(id);
      go(`#/e/${id}/results`);
    }
  }

  async function paint() {
    const my = ++gen;
    const route = parseCustomerHash(getHash());
    if ((route.view === "loading" || route.view === "results") && route.id) {
      if (!state.engagement || state.engagement.id !== route.id) {
        await loadEngagement(route.id);
        if (my !== gen) return;
      }
      if (route.view === "results" && !state.resultsLoaded) {
        await loadResults(route.id);
        if (my !== gen) return;
      }
    }
    deps.render?.(state, parseCustomerHash(getHash()));
  }

  return {
    state,
    paint,
    go,
    applyPatch: (p) => applyPatch(state, p),
    connectEvents,
    loadEngagement,
    loadResults,
    onApprove: async () => {
      if (!state.engagement?.id || state.busy) return;
      state.busy = true;
      state.error = "";
      state.launching = true;
      deps.render?.(state, parseCustomerHash(getHash()));
      let res;
      try {
        res = await deps.fetch(`/api/engagements/${state.engagement.id}/approve`, {
          method: "POST",
          headers: clientHeaders(),
          body: "{}",
        });
      } catch {
        state.busy = false;
        state.launching = false;
        state.error = "couldn't submit — try again";
        deps.render?.(state, parseCustomerHash(getHash()));
        return;
      }
      state.busy = false;
      if (res.status === 409) {
        state.launching = false;
        state.error = "this project isn't waiting for approval right now";
      } else if (res.status === 400) {
        state.launching = false;
        state.error = "notes required";
      } else if (!is2xx(res.status)) {
        state.launching = false;
        state.error = "couldn't submit — try again";
      }
      deps.render?.(state, parseCustomerHash(getHash()));
    },
    onRequest: async (notes) => {
      if (!state.showNotes) {
        state.showNotes = true;
        deps.render?.(state, parseCustomerHash(getHash()));
        return;
      }
      const text = String(notes || "").trim();
      if (!text) {
        state.error = "notes required";
        deps.render?.(state, parseCustomerHash(getHash()));
        return;
      }
      const hashBefore = getHash();
      state.busy = true;
      state.error = "";
      deps.render?.(state, parseCustomerHash(hashBefore));
      let res;
      try {
        res = await deps.fetch(`/api/engagements/${state.engagement.id}/request-changes`, {
          method: "POST",
          headers: clientHeaders(),
          body: JSON.stringify({ notes: text }),
        });
      } catch {
        state.busy = false;
        state.error = "couldn't submit — try again";
        deps.render?.(state, parseCustomerHash(getHash()));
        return;
      }
      state.busy = false;
      if (res.status === 409) {
        state.error = "this project isn't waiting for approval right now";
        deps.render?.(state, parseCustomerHash(getHash()));
        return;
      }
      if (res.status === 400) {
        state.error = "notes required";
        deps.render?.(state, parseCustomerHash(getHash()));
        return;
      }
      if (!is2xx(res.status)) {
        state.error = "couldn't submit — try again";
        deps.render?.(state, parseCustomerHash(getHash()));
        return;
      }
      state.showNotes = false;
      resetWebsiteProgress(state);
      go(`#/e/${state.engagement.id}`);
    },
  };
}
