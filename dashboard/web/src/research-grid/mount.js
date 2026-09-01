import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createElement } from "react";
import { ResearchGrid } from "./ResearchGrid.jsx";
import "@glideapps/glide-data-grid/dist/index.css";

export function mountResearchGrid(el, { research, comparison, variant, initialTab } = {}) {
  if (!el) throw new Error("mountResearchGrid requires an element");
  const root = createRoot(el);
  let props = { research, comparison, variant, initialTab };
  function paint() {
    flushSync(() => {
      root.render(createElement(ResearchGrid, props));
    });
  }
  paint();
  return {
    update(next) {
      props = { ...props, ...next };
      paint();
    },
    unmount() {
      root.unmount();
    },
  };
}

export function unmountResearchGrid(el) {
  if (el?._tenwhyGrid) {
    try {
      el._tenwhyGrid.unmount();
    } catch {
      /* */
    }
    el._tenwhyGrid = null;
  }
}

export function attachResearchGrid(el, opts) {
  if (!el) return null;
  if (el._tenwhyGrid) {
    el._tenwhyGrid.update(opts);
    return el._tenwhyGrid;
  }
  el._tenwhyGrid = mountResearchGrid(el, opts);
  return el._tenwhyGrid;
}
