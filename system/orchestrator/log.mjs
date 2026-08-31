import { redactText } from "./redact.mjs";
import { utcNow } from "./util.mjs";

const SECRET_KEY = /token|secret|password|passwd|authorization|api[_-]?key|credential/i;
const LEVELS = { debug: 10, info: 20, error: 40 };

function minLevel() {
  const raw = String(process.env.TENWHY_LOG_LEVEL || "info").toLowerCase();
  return LEVELS[raw] ?? LEVELS.info;
}

function fmtVal(value) {
  let s;
  if (value == null) s = "";
  else if (typeof value === "string") s = value;
  else if (typeof value === "number" || typeof value === "boolean") s = String(value);
  else s = JSON.stringify(value);
  s = redactText(s);
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > 240) s = `${s.slice(0, 200)}…`;
  if (/[\s="]/.test(s)) return `"${s.replace(/"/g, '\\"')}"`;
  return s;
}

export function log(level, component, msg, fields = {}) {
  if ((LEVELS[level] ?? 20) < minLevel()) return;
  const parts = [utcNow(), level, component, redactText(String(msg ?? ""))];
  for (const [k, v] of Object.entries(fields)) {
    if (v == null || v === "") continue;
    const val = SECRET_KEY.test(k) ? "[redacted]" : fmtVal(v);
    parts.push(`${k}=${val}`);
  }
  process.stdout.write(`${redactText(parts.join(" "))}\n`);
}

export function info(component, msg, fields) {
  log("info", component, msg, fields);
}

export function debug(component, msg, fields) {
  log("debug", component, msg, fields);
}

export function error(component, msg, fields) {
  log("error", component, msg, fields);
}

export function preview(text, n = 200) {
  return redactText(String(text ?? ""))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, n);
}
