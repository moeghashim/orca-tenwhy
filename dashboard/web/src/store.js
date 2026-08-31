const FLASH_MS = 800;

function isFailing(run) {
  return run?.status === "needs_human" || run?.status === "gate_failed";
}

function failingIds(s) {
  return (s?.loop_runs || []).filter(isFailing).map((r) => r.id);
}

function mergeOrder(prev, nextIds) {
  const keep = new Set(nextIds);
  const out = prev.filter((id) => keep.has(id));
  for (const id of nextIds) if (!out.includes(id)) out.push(id);
  return out;
}

function sortFailureIds(s) {
  const byId = new Map((s?.loop_runs || []).map((r) => [r.id, r]));
  const ids = failingIds(s);
  ids.sort((a, b) => {
    const sa = byId.get(a)?.status === "needs_human" ? 0 : 1;
    const sb = byId.get(b)?.status === "needs_human" ? 0 : 1;
    return sa - sb;
  });
  return ids;
}

export function createStore(initial = null) {
  let snapshot = initial;
  let engagementOrder = initial?.engagements?.map((e) => e.id) ?? [];
  let failureOrder = failingIds(initial);
  let flashed = new Set();
  const flashTimers = new Map();
  let sse = { state: "live", retry: 0, retryIn: 0, closedAt: null };
  const listeners = new Set();

  function emit() {
    for (const fn of listeners) fn();
  }

  function unflash(id) {
    flashTimers.delete(id);
    if (!flashed.has(id)) return;
    flashed.delete(id);
    emit();
  }

  function replaceById(list, row, flash = true) {
    const i = list.findIndex((r) => r.id === row.id);
    if (i >= 0) list[i] = row;
    else list.push(row);
    if (flash) {
      flashed.add(row.id);
      const prev = flashTimers.get(row.id);
      if (prev) clearTimeout(prev);
      flashTimers.set(
        row.id,
        setTimeout(() => unflash(row.id), FLASH_MS),
      );
    }
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
    get failureOrder() {
      return failureOrder;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    setSnapshot(s, { resort = false } = {}) {
      snapshot = s;
      if (resort || engagementOrder.length === 0) {
        engagementOrder = (s?.engagements ?? []).map((e) => e.id);
        failureOrder = sortFailureIds(s);
      } else {
        failureOrder = mergeOrder(failureOrder, failingIds(s));
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
        const next = { ...(snapshot.comparisons || {}), ...ents.comparisons };
        const runs = snapshot.loop_runs || [];
        for (const runId of Object.keys(ents.comparisons)) {
          const run = runs.find((r) => r.id === runId);
          if (!run || run.loop_name !== "company-research" || run.status !== "gate_passed") continue;
          for (const other of runs) {
            if (other.id === runId) continue;
            if (other.engagement_id !== run.engagement_id) continue;
            if (other.loop_name !== "company-research") continue;
            delete next[other.id];
          }
        }
        snapshot.comparisons = next;
      }
      engagementOrder = mergeOrder(engagementOrder, (snapshot.engagements || []).map((e) => e.id));
      failureOrder = mergeOrder(failureOrder, failingIds(snapshot));
      emit();
    },
    clearFlashed() {
      for (const t of flashTimers.values()) clearTimeout(t);
      flashTimers.clear();
      flashed = new Set();
      emit();
    },
    setSse(next) {
      sse = { ...sse, ...next };
      emit();
    },
  };
}
