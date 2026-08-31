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

const CHECK_LINE = (n) => new RegExp(`^${n}\\.(?!\\d)`);
const ENUMERATE_FORMAT = "FORMAT: reviewer notes must enumerate checks 1–5";

/** Post-parse check: notes must contain five lines starting with 1. … 5. */
export function validateVerdict(parsed) {
  const notes = String(parsed?.notes ?? "");
  if (notes.startsWith("FORMAT:")) return parsed;
  const lines = notes.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const ok = [1, 2, 3, 4, 5].every((n) => lines.some((l) => CHECK_LINE(n).test(l)));
  if (ok) return parsed;
  return { verdict: "revise", notes: ENUMERATE_FORMAT };
}
