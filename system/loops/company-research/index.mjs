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
const PASS_FAIL = /(?:^|[^A-Za-z])(?:pass|fail|passes|fails)(?:[^A-Za-z]|$)|[✓✕]/i;

function isUrlToken(tok) {
  const t = String(tok).replace(/^[("'<[.]+|[)"'>],.]+$/g, "");
  return /^https?:\/\//i.test(t) || /^www\./i.test(t);
}

function nonUrlWords(text) {
  return String(text)
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => {
      if (isUrlToken(w)) return false;
      const core = w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
      return core.length > 0;
    });
}

function checkLineOk(n, line) {
  if (!CHECK_LINE(n).test(line)) return false;
  const rest = line.replace(CHECK_LINE(n), "").trim();
  if (!PASS_FAIL.test(` ${rest} `)) return false;
  if (nonUrlWords(rest).length < 3) return false;
  return true;
}

/** Post-parse check: approve notes must enumerate 1.–5. with pass/fail + reason. */
export function validateVerdict(parsed) {
  const notes = String(parsed?.notes ?? "");
  if (parsed?.verdict !== "approve") return parsed;
  if (notes.startsWith("FORMAT:")) {
    return { verdict: "revise", notes: ENUMERATE_FORMAT };
  }
  const lines = notes.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const ok = [1, 2, 3, 4, 5].every((n) => lines.some((l) => checkLineOk(n, l)));
  if (ok) return parsed;
  return { verdict: "revise", notes: ENUMERATE_FORMAT };
}
