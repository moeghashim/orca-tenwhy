import { renderComparison } from "../app.js";
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

export function renderLoading({ events = [], loop_runs = [], engagement = null, rebuilding = false } = {}) {
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
  let idx = prog.activeIndex < 0 ? 4 : prog.activeIndex;
  if (rebuilding && prog.completed < 4) idx = 3;
  const ph = rebuilding
    ? { title: "Rebuilding with your notes", sub: "rebuilding with your notes" }
    : PHASES[idx] || PHASES[0];
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

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url || "").replace(/^https?:\/\//, "");
  }
}

function pricingShown(comp) {
  const products = comp.products || [];
  const priced = products.filter((p) => typeof p.price === "number");
  if (priced.length) return String(priced[0].price);
  return "hidden";
}

export function renderResults({
  engagement,
  research,
  comparison,
  pages = [],
  tab = "research",
  onTab,
  onApprove,
  onRequest,
  busy = false,
  error = "",
  liveUrl = null,
  launching = false,
  showNotes = false,
} = {}) {
  const isRes = tab !== "design";
  const title = isRes ? "Your research is ready" : "Your website draft";
  const sub = isRes
    ? "Everything below was gathered and verified by tenwhy."
    : "Drafted, reviewed, and checked — nothing goes live until you approve.";
  const company = research?.company || {};
  const competitors = research?.competitors || [];
  const ideas = research?.enhancement_ideas || [];
  const learned = competitors.map((c) => c.summary).filter(Boolean);
  const body = [];
  if (isRes) {
    const about = el("div", { class: "r-card", "data-card": "about" }, el("div", { class: "r-h" }, "About your business"), el("div", { class: "r-body" }, company.summary || ""));
    const learn = el("div", { class: "r-card" }, el("div", { class: "r-h" }, "What we learned"), el("div", { class: "r-list", "data-card": "learned" }, ...learned.map((s) => el("span", {}, `✓ ${s}`))));
    const win = el(
      "div",
      { class: "r-card" },
      el("div", { class: "r-h" }, "How your site will win"),
      el("div", { class: "r-list", "data-card": "win" }, ...ideas.map((it, i) => el("span", {}, `${i + 1}. ${it.idea}`))),
    );
    const table = el("div", { class: "comp-table", "data-card": "competitors" });
    for (const h of ["competitor", "pricing shown", "what they do well", "website"]) table.append(el("span", { class: "h" }, h));
    for (const c of competitors) {
      const href = c.url || "";
      table.append(
        href ? el("a", { href, class: "mono" }, `${c.name} ↗`) : el("span", { style: { fontWeight: "500" } }, c.name || ""),
        el("span", {}, pricingShown(c)),
        el("span", {}, c.summary || ""),
        el("span", {}, hostOf(href)),
      );
    }
    const wrap = el("div", { class: "research", "data-tab": "research" }, about, el("div", { class: "r-grid" }, learn, win), el("div", { class: "r-card" }, el("div", { class: "r-h" }, "Your competitors"), table));
    if (comparison) wrap.append(renderComparison(comparison));
    body.push(wrap);
  } else {
    const id = engagement?.id || "";
    const checklist = el("div", { class: "r-list", "data-pages": "1" }, ...pages.map((p) => el("span", {}, `✓ ${p.title || p.path}`)));
    body.push(
      el(
        "div",
        { class: "design", "data-tab": "design" },
        el(
          "div",
          { class: "browser" },
          el(
            "div",
            { class: "chrome" },
            el("span", { class: "dot" }),
            el("span", { class: "dot" }),
            el("span", { class: "dot" }),
            el("span", { class: "addr" }, `${id} — draft`),
          ),
          el("iframe", { sandbox: "allow-scripts", src: `/preview/${id}/`, title: "preview" }),
        ),
        el(
          "div",
          { class: "side" },
          el("div", { class: "r-card" }, el("div", { class: "r-h" }, `Your ${pages.length} pages`), checklist),
          el("div", { class: "r-card" }, el("div", { class: "r-h" }, "Built from your research"), el("div", { class: "r-body" }, "built from your research — nothing invented")),
        ),
      ),
    );
  }
  const approveLabel = launching ? "launching…" : liveUrl ? "live" : "Approve & launch";
  const actions = el("div", { class: "actions" });
  if (liveUrl) {
    actions.append(el("a", { class: "btn btn-dark", href: liveUrl, "data-live-url": "1" }, liveUrl));
  } else {
    actions.append(
      el("button", { class: "btn btn-dark", type: "button", "data-approve": "1", disabled: busy || launching, onClick: () => onApprove && onApprove() }, approveLabel),
      el("button", { class: "btn btn-light", type: "button", "data-request": "1", disabled: busy, onClick: () => onRequest && onRequest() }, "Request changes"),
    );
  }
  return el(
    "div",
    { class: "stage", "data-screen": "results" },
    el("div", { class: "results" },
      mascot("xs"),
      el("div", { class: "result-title" }, title),
      el("div", { class: "result-sub" }, sub),
      el(
        "div",
        { class: "pills" },
        el("button", { class: "pill" + (isRes ? " on" : ""), type: "button", "data-tab-btn": "research", onClick: () => onTab && onTab("research") }, "Research"),
        el("button", { class: "pill" + (!isRes ? " on" : ""), type: "button", "data-tab-btn": "design", onClick: () => onTab && onTab("design") }, "Website design"),
      ),
      ...body,
      showNotes
        ? el("div", { class: "notes" }, el("textarea", { "data-notes": "1", placeholder: "What should we change?" }))
        : null,
      actions,
      error ? el("div", { class: "err", "data-error": "1" }, error) : null,
    ),
  );
}

export function renderCustomerApp(root, {
  hash,
  engagement = null,
  events = [],
  loop_runs = [],
  research = null,
  comparison = null,
  pages = [],
  tab = "research",
  onCreate,
  onTab,
  onApprove,
  onRequest,
  busy = false,
  error = "",
  liveUrl = null,
  launching = false,
  showNotes = false,
  rebuilding = false,
} = {}) {
  const route = parseCustomerHash(hash);
  root.replaceChildren();
  if (route.view === "results") {
    root.append(renderResults({ engagement, research, comparison, pages, tab, onTab, onApprove, onRequest, busy, error, liveUrl, launching, showNotes }));
    return root;
  }
  if (route.view === "loading" || (route.view === "start" && engagement)) {
    root.append(renderLoading({ events, loop_runs, engagement, rebuilding }));
    return root;
  }
  root.append(renderStart(onCreate || (() => {})));
  return root;
}
