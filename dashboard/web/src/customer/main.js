import { parseCustomerHash, renderCustomerApp } from "./app.js";
import "./style.css";

const root = document.getElementById("app");
const state = { engagement: null, events: [], loop_runs: [], gate_checks: [] };

function go(hash) {
  if (window.location.hash !== hash) window.location.hash = hash;
  else paint();
}

function paint() {
  const route = parseCustomerHash(window.location.hash);
  renderCustomerApp(root, {
    hash: window.location.hash || "#/",
    engagement: state.engagement,
    events: state.events,
    loop_runs: state.loop_runs,
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
  });
  if (route.view === "loading" && route.id && !state.engagement) {
    fetch(`/api/engagements/${route.id}`)
      .then((r) => r.json())
      .then((bundle) => {
        state.engagement = bundle.engagement;
        state.events = bundle.events || [];
        state.loop_runs = bundle.loop_runs || [];
        paint();
      });
  }
}

window.addEventListener("hashchange", paint);
paint();
