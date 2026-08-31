let origin = null;

function monoNow() {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return 0;
}

export function resetClock() {
  origin = null;
}

export function captureServerTime(iso) {
  if (!iso) return false;
  const serverMs = Date.parse(iso);
  if (Number.isNaN(serverMs)) return false;
  origin = { serverMs, mono: monoNow() };
  return true;
}

export function serverNow(snap) {
  const iso = snap?.serverTime ?? snap?.created_at;
  if (!origin && iso) captureServerTime(iso);
  if (!origin) return null;
  return origin.serverMs + (monoNow() - origin.mono);
}

export function isoFromMs(ms) {
  if (ms == null || Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

export function clockTime(iso) {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "—";
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function rel(iso, now) {
  if (now == null || !iso) return "—";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "—";
  const sec = Math.max(0, (now - ms) / 1000);
  if (sec < 5) return "now";
  if (sec < 60) return `${Math.floor(sec)}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

export function isRecent(iso, now, windowMs = 2 * 60 * 1000) {
  if (now == null || !iso) return false;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return false;
  return now - ms >= 0 && now - ms < windowMs;
}
