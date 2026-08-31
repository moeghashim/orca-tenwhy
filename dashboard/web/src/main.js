import { renderApp } from "./app.js";
import { connectSse } from "./sse.js";
import { createStore } from "./store.js";
import "./style.css";

const store = createStore(null);
const root = document.getElementById("app");
let now = Date.now();

function go(hash) {
  if (window.location.hash !== hash) window.location.hash = hash;
  else paint();
}

function paint() {
  renderApp(root, { store, hash: window.location.hash || "#/runs", now, go });
}

async function fetchSnapshot() {
  const res = await fetch("/api/snapshot");
  return res.json();
}

store.subscribe(paint);
window.addEventListener("hashchange", paint);
setInterval(() => {
  now = Date.now();
  paint();
}, 10_000);

store.setSse({ state: "live" });
paint();

fetchSnapshot()
  .then((snap) => {
    store.setSnapshot(snap, { resort: true });
    connectSse({ store, fetchSnapshot });
  })
  .catch(() => {
    store.setSse({ state: "disconnected", closedAt: new Date().toISOString() });
  });
