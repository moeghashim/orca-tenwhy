import { isoFromMs, serverNow } from "./time.js";

export function connectSse({
  url = "/api/events",
  store,
  fetchSnapshot,
  maxRetry = 5,
  EventSourceImpl = globalThis.EventSource,
} = {}) {
  let n = 0;
  let es = null;
  let timer = null;
  let stopped = false;

  function open() {
    if (stopped) return;
    const since = store.snapshot?.lastEventId ?? 0;
    es = new EventSourceImpl(`${url}?since=${since}`);
    es.addEventListener("patch", (ev) => {
      n = 0;
      store.setSse({ state: "live", retry: 0, retryIn: 0, closedAt: null });
      try {
        store.applyPatch(JSON.parse(ev.data));
      } catch {
        /* ignore */
      }
    });
    es.onopen = () => {
      n = 0;
      store.setSse({ state: "live", retry: 0, retryIn: 0, closedAt: null });
    };
    es.onerror = () => {
      try {
        es.close();
      } catch {
        /* */
      }
      n += 1;
      const closedAt = isoFromMs(serverNow(store.snapshot));
      if (n > maxRetry) {
        store.setSse({ state: "disconnected", retry: n, retryIn: 0, closedAt });
        return;
      }
      const wait = n;
      store.setSse({ state: "reconnecting", retry: n, retryIn: wait, closedAt });
      timer = setTimeout(async () => {
        if (typeof fetchSnapshot === "function") {
          const snap = await fetchSnapshot();
          store.setSnapshot(snap, { resort: true });
        }
        open();
      }, wait * 1000);
    };
  }

  open();
  return {
    kill() {
      stopped = true;
      clearTimeout(timer);
      try {
        es?.close();
      } catch {
        /* */
      }
      store.setSse({ state: "disconnected", closedAt: isoFromMs(serverNow(store.snapshot)) });
    },
  };
}
