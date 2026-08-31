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

export function acquireDaemonLock(
  lockPath,
  { pid = process.pid, kill = process.kill.bind(process) } = {},
) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY;
  const tryCreate = () => {
    const fd = fs.openSync(lockPath, flags);
    try {
      fs.writeSync(fd, `${pid}\n`);
    } finally {
      fs.closeSync(fd);
    }
    return { ok: true, pid };
  };
  try {
    return tryCreate();
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  }
  let existing = null;
  try {
    existing = parsePid(fs.readFileSync(lockPath, "utf8"));
  } catch {
    existing = null;
  }
  if (existing && isAlive(existing, kill)) {
    return { ok: false, pid: existing };
  }
  try {
    fs.unlinkSync(lockPath);
  } catch {
    /* */
  }
  try {
    return tryCreate();
  } catch (err) {
    if (err.code === "EEXIST") {
      const again = parsePid(fs.readFileSync(lockPath, "utf8"));
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
