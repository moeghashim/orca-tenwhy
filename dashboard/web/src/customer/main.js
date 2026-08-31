import { parseCustomerHash, renderCustomerApp } from "./app.js";
import { createCustomerSession } from "./session.js";
import "./style.css";

const root = document.getElementById("app");
let hash = window.location.hash || "#/";

const session = createCustomerSession({
  fetch: (...args) => fetch(...args),
  EventSource,
  getHash: () => hash,
  setHash: (next) => {
    hash = next;
    if (window.location.hash !== next) window.location.hash = next;
    else session.paint();
  },
  render: (state, route) => {
    const current = route || parseCustomerHash(hash);
    renderCustomerApp(root, {
      hash: current.view === "results" ? `#/e/${current.id}/results` : hash,
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
        session.paint();
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
            session.go(`#/e/${j.id}`);
          });
      },
      onApprove: () => session.onApprove(),
      onRequest: () => session.onRequest(root.querySelector("[data-notes]")?.value),
    });
  },
});

window.addEventListener("hashchange", () => {
  hash = window.location.hash || "#/";
  session.paint();
});
session.paint();

