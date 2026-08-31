import assert from "node:assert/strict";
import test from "node:test";
import { ENUMS, statusOf, tokenColors, tokens } from "./src/status.js";

test("every enum value resolves and unknown cannot introduce a colour outside tokens.json", () => {
  const allowed = tokenColors();
  const orig = console.warn;
  const warns = [];
  console.warn = (...a) => warns.push(a.join(" "));
  try {
    for (const [kind, values] of Object.entries(ENUMS)) {
      for (const value of values) {
        const s = statusOf(kind, value);
        assert.equal(s.label, value);
        assert.ok(s.glyph);
        assert.ok(allowed.has(s.fg), `${kind}.${value} fg ${s.fg}`);
        assert.ok(allowed.has(s.bg), `${kind}.${value} bg`);
        assert.ok(allowed.has(s.border), `${kind}.${value} border`);
      }
    }
    const awaiting = statusOf("engagement", "awaiting_approval");
    assert.equal(awaiting.glyph, tokens.color.status.queued.glyph);
    assert.equal(awaiting.label, "awaiting_approval");
    const revise = statusOf("verdict", "revise");
    assert.equal(revise.glyph, "↺");
    const unknown = statusOf("run", "not_a_real_status");
    assert.equal(unknown.label, "not_a_real_status");
    assert.equal(unknown.fg, tokens.color.status.queued.fg);
    assert.ok(allowed.has(unknown.fg));
    assert.ok(warns.some((w) => w.includes("not_a_real_status")));
  } finally {
    console.warn = orig;
  }
});
