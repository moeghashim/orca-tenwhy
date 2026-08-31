import fs from "node:fs";
import path from "node:path";

const REAP_STALE_MS = 30_000;

function parsePid(raw) {
  const n = Number(String(raw || "").trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

function isAlive(pid, killFn) {
  if (!pid) return false;
  try {
    killFn(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(filePath) {
  try {
    return parsePid(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function unlinkOwn(tmpPath) {
  try {
    fs.unlinkSync(tmpPath);
  } catch {
    /* */
  }
}

function acquireReaperLock(reapPath, pid, kill) {
  const create = () => {
    const fd = fs.openSync(reapPath, "wx");
    try {
      fs.writeSync(fd, `${pid}\n`);
    } finally {
      fs.closeSync(fd);
    }
  };
  try {
    create();
    return true;
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  }
  let reapPid = null;
  let mtimeMs = NaN;
  try {
    reapPid = parsePid(fs.readFileSync(reapPath, "utf8"));
    mtimeMs = fs.statSync(reapPath).mtimeMs;
  } catch {
    return false;
  }
  const stale =
    Number.isFinite(mtimeMs) &&
    Date.now() - mtimeMs > REAP_STALE_MS &&
    !isAlive(reapPid, kill);
  if (!stale) return false;
  try {
    fs.unlinkSync(reapPath);
  } catch {
    /* */
  }
  try {
    create();
    return true;
  } catch (err) {
    if (err.code === "EEXIST") return false;
    throw err;
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

  const existing = readPid(lockPath);
  if (existing && isAlive(existing, kill)) {
    unlinkOwn(tmpPath);
    return { ok: false, pid: existing };
  }

  const failExist = () => {
    unlinkOwn(tmpPath);
    return { ok: false, pid: readPid(lockPath) };
  };

  const reapPath = `${lockPath}.reap`;
  let reaperHeld = false;
  try {
    if (!acquireReaperLock(reapPath, pid, kill)) {
      unlinkOwn(tmpPath);
      return { ok: false, pid: readPid(lockPath) };
    }
    reaperHeld = true;

    const again = readPid(lockPath);
    if (again !== existing || isAlive(again, kill)) {
      unlinkOwn(tmpPath);
      return { ok: false, pid: again };
    }

    const stalePath = path.join(dir, `${base}.stale.${Date.now()}.${pid}`);
    try {
      fs.renameSync(lockPath, stalePath);
    } catch (err) {
      if (err.code !== "ENOENT") {
        unlinkOwn(tmpPath);
        throw err;
      }
      try {
        return tryLink();
      } catch (e2) {
        if (e2.code === "EEXIST") return failExist();
        unlinkOwn(tmpPath);
        throw e2;
      }
    }

    try {
      return tryLink();
    } catch (err) {
      if (err.code === "EEXIST") return failExist();
      unlinkOwn(tmpPath);
      throw err;
    }
  } finally {
    if (reaperHeld) unlinkOwn(reapPath);
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
