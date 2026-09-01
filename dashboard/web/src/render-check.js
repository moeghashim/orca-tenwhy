import { renderCustomerApp } from "./customer/app.js";
import { myjamComparison, myjamResearch } from "./research-grid/fixture.js";
import "./customer/style.css";

const root = document.getElementById("app");
renderCustomerApp(root, {
  hash: "#/e/eng_render_check/results",
  engagement: { id: "eng_render_check", status: "awaiting_approval" },
  research: myjamResearch(),
  comparison: myjamComparison(),
  tab: "research",
});
