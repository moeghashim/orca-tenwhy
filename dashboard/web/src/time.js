export function rel(iso, now = Date.now()) {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "—";
  const sec = Math.max(0, (now - ms) / 1000);
  if (sec < 5) return "now";
  if (sec < 60) return `${Math.floor(sec)}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

export function isRecent(iso, now = Date.now(), windowMs = 2 * 60 * 1000) {
  if (!iso) return false;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return false;
  return now - ms >= 0 && now - ms < windowMs;
}
