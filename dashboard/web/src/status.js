import tokens from "../../design/tokens.json" with { type: "json" };

const STATUS = tokens.color.status;

const ALIAS = {
  "engagement.new": "queued",
  "engagement.complete": "passed",
  "engagement.awaiting_approval": "queued",
  "run.gate_passed": "passed",
  "run.gate_failed": "failed",
  "gate.pending": "queued",
  "gate.pass": "passed",
  "gate.fail": "failed",
  "verdict.approve": "passed",
  "verdict.reject": "failed",
  "verdict.escalate": "needs_human",
};

const GLYPH_OVERRIDE = {
  "verdict.revise": "↺",
};

export const ENUMS = {
  engagement: ["new", "running", "needs_human", "awaiting_approval", "complete", "failed"],
  run: ["queued", "running", "gate_passed", "gate_failed", "needs_human"],
  gate: ["pending", "pass", "fail"],
  verdict: ["revise", "approve", "reject", "escalate"],
};

export function tokenColors() {
  const set = new Set();
  for (const s of Object.values(STATUS)) {
    set.add(s.fg);
    set.add(s.bg);
    set.add(s.border);
  }
  return set;
}

export function statusOf(kind, value) {
  const key = `${kind}.${value}`;
  let name = ALIAS[key];
  if (!name && STATUS[value]) name = value;
  if (key === "verdict.revise") name = "running";
  if (!name) {
    console.warn(`unknown status ${key}`);
    name = "queued";
  }
  const base = STATUS[name];
  return {
    fg: base.fg,
    bg: base.bg,
    border: base.border,
    glyph: GLYPH_OVERRIDE[key] || base.glyph,
    label: String(value),
  };
}

export { tokens };
