import { loadingProgress, PHASES, STEP_LABELS } from "./progress.js";

function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "dataset") Object.assign(node.dataset, v);
    else node.setAttribute(k, String(v));
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

function mascot(size = "") {
  const wrap = el("div", { class: "mascot" + (size ? ` ${size}` : ""), "data-mascot": "1" });
  wrap.append(el("span", { class: "eye l" }), el("span", { class: "eye r" }));
  return wrap;
}

export function parseCustomerHash(hash) {
  const h = String(hash || "#/").replace(/^#/, "") || "/";
  const parts = h.split("/").filter(Boolean);
  if (parts[0] === "e" && parts[1] && parts[2] === "results") return { view: "results", id: parts[1] };
  if (parts[0] === "e" && parts[1]) return { view: "loading", id: parts[1] };
  return { view: "start" };
}

export function renderStart(onSubmit) {
  const idea = el("input", { type: "text", placeholder: "What's your business or idea?", "data-idea": "1" });
  const url = el("input", { type: "text", placeholder: "yourcompany.com", "data-url": "1" });
  const submit = el("button", { class: "submit", type: "button", "data-submit": "1", disabled: true }, "↑");
  function sync() {
    submit.disabled = !(idea.value.trim() || url.value.trim());
  }
  idea.addEventListener("input", sync);
  url.addEventListener("input", sync);
  function go() {
    const i = idea.value.trim();
    const u = url.value.trim();
    if (!i && !u) return;
    onSubmit({ idea: i, site_url: u });
  }
  idea.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  url.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  submit.addEventListener("click", go);
  return el(
    "div",
    { class: "stage", "data-screen": "start" },
    el("div", { class: "meet-title" }, "Meet tenwhy"),
    el("div", { class: "meet-promise" }, "It researches your business and your competitors, then builds and launches your website. You only approve."),
    mascot(),
    el(
      "div",
      { class: "card-input" },
      idea,
      url,
      el("div", { class: "card-row" }, el("span", { class: "helper" }, "Start with your current site or just your company name"), submit),
    ),
    el(
      "div",
      { class: "foot" },
      el("span", {}, "research → review → build → launch"),
      el("span", {}, "~20 minutes"),
      el("span", {}, "nothing published without your ok"),
    ),
  );
}

export function renderLoading({ events = [], loop_runs = [], engagement = null } = {}) {
  if (engagement?.status === "needs_human") {
    return el(
      "div",
      { class: "stage", "data-screen": "paused" },
      mascot("sm"),
      el("div", { class: "phase-title" }, "We've paused"),
      el("div", { class: "pause" }, "we've paused to check something — we'll pick this up"),
    );
  }
  const prog = loadingProgress({ events, loop_runs });
  const idx = prog.activeIndex < 0 ? 4 : prog.activeIndex;
  const ph = PHASES[idx] || PHASES[0];
  const steps = el("div", { class: "steps", "data-steps": "1" });
  for (let i = 0; i < 5; i++) {
    const done = i < prog.completed;
    const active = i === prog.activeIndex;
    const row = el(
      "div",
      { class: "step" + (done ? " done" : active ? " active" : " upcoming"), "data-step": String(i + 1) },
      el("span", { class: "step-mark" }, done ? "✓" : ""),
      el("span", { class: "step-label" }, STEP_LABELS[i]),
      el("span", { class: "step-meta" }, done ? "done" : active ? "in progress" : ""),
    );
    steps.append(row);
  }
  const pct = prog.completed >= 5 ? 100 : Math.round(8 + prog.completed * 22);
  const n = prog.completed >= 5 ? 5 : prog.completed + 1;
  return el(
    "div",
    { class: "stage", "data-screen": "loading" },
    el(
      "div",
      { class: "load-wrap" },
      el("div", { class: "orbit" }, el("span", { class: "orbit-ring" }), mascot("sm")),
      el("div", { class: "phase-title" }, ph.title),
      el("div", { class: "phase-sub" }, ph.sub),
      steps,
      el("div", { class: "bar" }, el("span", { class: "bar-fill", style: { width: `${pct}%` } }), el("span", { class: "bar-sweep" })),
      el("div", { class: "keep", "data-progress-label": "1" }, `step ${n} of 5 · you can keep this page open — nothing is published without your ok`),
    ),
  );
}

export function renderCustomerApp(root, { hash, engagement = null, events = [], loop_runs = [], onCreate } = {}) {
  const route = parseCustomerHash(hash);
  root.replaceChildren();
  if (route.view === "loading" || (route.view === "start" && engagement)) {
    root.append(renderLoading({ events, loop_runs, engagement }));
    return root;
  }
  root.append(renderStart(onCreate || (() => {})));
  return root;
}
