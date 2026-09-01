import { mountResearchGrid } from "./research-grid/mount.js";
import { myjamComparison, myjamResearch } from "./research-grid/fixture.js";
import "./customer/style.css";
import "./style.css";

const research = myjamResearch();
const comparison = myjamComparison();
const root = document.getElementById("app");

for (const tab of ["competitors", "prices", "ideas"]) {
  const host = document.createElement("div");
  host.dataset.check = `customer-${tab}`;
  root.append(host);
  mountResearchGrid(host, { research, comparison, variant: "customer", initialTab: tab });
}

const card = document.createElement("div");
card.className = "card";
card.dataset.check = "dashboard";
card.innerHTML = '<div class="card-h">research grid</div><div data-research-grid="1"></div>';
root.append(card);
mountResearchGrid(card.querySelector("[data-research-grid]"), {
  research,
  comparison,
  variant: "dashboard",
  initialTab: "competitors",
});
