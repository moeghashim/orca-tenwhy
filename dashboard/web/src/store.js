export function createStore(initial = null) {
  let snapshot = initial;
  let engagementOrder = initial?.engagements?.map((e) => e.id) ?? [];
  let flashed = new Set();
  let sse = { state: "live", retry: 0, retryIn: 0, closedAt: null };
  const listeners = new Set();

  function emit() {
    for (const fn of listeners) fn();
  }

  function replaceById(list, row, flash = true) {
    const i = list.findIndex((r) => r.id === row.id);
    if (i >= 0) list[i] = row;
    else list.push(row);
    if (flash) flashed.add(row.id);
  }

  return {
    get snapshot() {
      return snapshot;
    },
    get flashed() {
      return flashed;
    },
    get sse() {
      return sse;
    },
    get engagementOrder() {
      return engagementOrder;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    setSnapshot(s, { resort = false } = {}) {
      snapshot = s;
      if (resort || engagementOrder.length === 0) {
        engagementOrder = (s?.engagements ?? []).map((e) => e.id);
      }
      emit();
    },
    applyPatch(event) {
      if (!snapshot) return;
      const ents = event.entities || {};
      for (const table of ["engagements", "loop_runs", "iterations", "gate_checks", "scrapes", "approvals"]) {
        if (!Array.isArray(ents[table])) continue;
        if (!Array.isArray(snapshot[table])) snapshot[table] = [];
        for (const row of ents[table]) replaceById(snapshot[table], row);
      }
      if (ents.comparisons && typeof ents.comparisons === "object") {
        snapshot.comparisons = { ...(snapshot.comparisons || {}), ...ents.comparisons };
      }
      emit();
    },
    clearFlashed() {
      flashed = new Set();
      emit();
    },
    setSse(next) {
      sse = { ...sse, ...next };
      emit();
    },
  };
}
