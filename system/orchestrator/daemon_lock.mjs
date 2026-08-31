import fs from "node:fs";
import path from "node:path";

function parsePid(raw) {
  const n = Number(String(raw || "").trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

function isAlive(pid, killFn) {
  try {
    killFn(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function unlinkOwn(tmpPath) {
  try {
    fs.unlinkSync(tmpPath);
  } catch {
    /* */
  }
}

export function acquireDaemonLock(
  lockPath,
  { pid = process.pid, kill = process.kill.bind(process) } = {},
) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const dir = path.dirname(lockPath);
  const base = path.basename(lockPath);
  const tmpPath = path.join(dir, `${base}.${pid}.tmp`);
  fs.writeFileSync(tmpPath, `${pid}\n`);

  const tryLink = () => {
    fs.linkSync(tmpPath, lockPath);
    unlinkOwn(tmpPath);
    return { ok: true, pid };
  };

  try {
    return tryLink();
  } catch (err) {
    if (err.code !== "EEXIST") {
      unlinkOwn(tmpPath);
      throw err;
    }
  }

  let existing = null;
  try {
    existing = parsePid(fs.readFileSync(lockPath, "utf8"));
  } catch {
    existing = null;
  }
  if (existing && isAlive(existing, kill)) {
    unlinkOwn(tmpPath);
    return { ok: false, pid: existing };
  }

  const stalePath = path.join(dir, `${base}.stale.${Date.now()}`);
  try {
    fs.renameSync(lockPath, stalePath);
  } catch (err) {
    if (err.code !== "ENOENT") {
      unlinkOwn(tmpPath);
      throw err;
    }
  }

  try {
    return tryLink();
  } catch (err) {
    unlinkOwn(tmpPath);
    if (err.code === "EEXIST") {
      let again = null;
      try {
        again = parsePid(fs.readFileSync(lockPath, "utf8"));
      } catch {
        again = null;
      }
      return { ok: false, pid: again };
    }
    throw err;
  }
}

export function releaseDaemonLock(lockPath, { pid = process.pid } = {}) {
  try {
    const existing = parsePid(fs.readFileSync(lockPath, "utf8"));
    if (existing === pid) fs.unlinkSync(lockPath);
  } catch {
    /* */
  }
}
