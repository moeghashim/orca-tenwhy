import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { materialize } from "./materialize.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const EXECUTOR_MD = fs.readFileSync(path.join(DIR, "executor.md"), "utf8");
const REVIEWER_MD = fs.readFileSync(path.join(DIR, "reviewer.md"), "utf8");

export const name = "company-research";
export const gate = "system/gates/research_gate.py";
export { materialize };

export function renderTemplate(template, vars = {}) {
  return String(template).replace(/\{\{(\w+)\}\}/g, (_, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key] ?? "") : "",
  );
}

export function executorPrompt(vars = {}) {
  return renderTemplate(EXECUTOR_MD, vars);
}

export function reviewerPrompt(vars = {}) {
  return renderTemplate(REVIEWER_MD, vars);
}
