import { renderApp } from "./app.js";
import { connectSse } from "./sse.js";
import { applyStatusVars } from "./status.js";
import { createStore } from "./store.js";
import { captureServerTime, isoFromMs, serverNow } from "./time.js";
import "./style.css";

applyStatusVars();

const store = createStore(null);
const root = document.getElementById("app");

function go(hash) {
  if (window.location.hash !== hash) window.location.hash = hash;
  else paint();
}

function paint() {
  renderApp(root, { store, hash: window.location.hash || "#/runs", now: serverNow(store.snapshot), go });
}

async function fetchSnapshot() {
  const res = await fetch("/api/snapshot");
  return res.json();
}

store.subscribe(paint);
window.addEventListener("hashchange", paint);
setInterval(paint, 10_000);

store.setSse({ state: "live" });
paint();

fetchSnapshot()
  .then((snap) => {
    captureServerTime(snap.serverTime);
    store.setSnapshot(snap, { resort: true });
    connectSse({ store, fetchSnapshot });
  })
  .catch(() => {
    store.setSse({ state: "disconnected", closedAt: isoFromMs(serverNow(store.snapshot)) });
  });
