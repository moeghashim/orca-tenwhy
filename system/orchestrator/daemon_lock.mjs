import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

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

function isBusy(err) {
  if (!err || err.code !== "ERR_SQLITE_ERROR") return false;
  if (err.errcode === 5) return true;
  return /busy|database is locked/i.test(`${err.message || ""} ${err.errstr || ""}`);
}

function isNotADb(err) {
  if (!err || err.code !== "ERR_SQLITE_ERROR") return false;
  if (err.errcode === 26) return true;
  return /not a database/i.test(`${err.message || ""} ${err.errstr || ""}`);
}

function holderPid(row) {
  if (!row) return null;
  const n = Number(row.pid);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function openLockDb(lockPath) {
  return new DatabaseSync(lockPath, { timeout: 5000 });
}

function bestEffortPid(lockPath) {
  try {
    const db = openLockDb(lockPath);
    try {
      const row = db.prepare("SELECT pid FROM holder WHERE id = 1").get();
      return holderPid(row);
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function acquireSqlite(lockPath, pid, kill) {
  const db = openLockDb(lockPath);
  let begun = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    begun = true;
    db.exec(`CREATE TABLE IF NOT EXISTS holder (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      pid INTEGER NOT NULL,
      acquired_at TEXT NOT NULL
    )`);
    const row = db.prepare("SELECT pid FROM holder WHERE id = 1").get();
    const existing = holderPid(row);
    if (existing && existing !== pid && isAlive(existing, kill)) {
      db.exec("ROLLBACK");
      begun = false;
      return { ok: false, pid: existing };
    }
    db.prepare("INSERT OR REPLACE INTO holder (id, pid, acquired_at) VALUES (1, ?, ?)").run(
      pid,
      new Date().toISOString(),
    );
    db.exec("COMMIT");
    begun = false;
    return { ok: true, pid };
  } catch (err) {
    if (begun) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* */
      }
    }
    throw err;
  } finally {
    try {
      db.close();
    } catch {
      /* */
    }
  }
}

function readableLegacyPid(lockPath) {
  try {
    const str = fs.readFileSync(lockPath, "utf8");
    if (/^\d+\s*$/.test(str)) return parsePid(str);
  } catch {
    /* */
  }
  return null;
}

function migrateLegacyTextLock(lockPath, pid, kill) {
  // One-time path for plain-text pid locks written before this SQLite-backed lock.
  // Serialized by ${lockPath}.migrate (stable SQLite file, never unlinked).
  const migratePath = `${lockPath}.migrate`;
  const db = openLockDb(migratePath);
  let begun = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    begun = true;
    db.exec("CREATE TABLE IF NOT EXISTS migrate (id INTEGER PRIMARY KEY CHECK (id = 1))");
    let raw;
    try {
      raw = fs.readFileSync(lockPath);
    } catch {
      db.exec("ROLLBACK");
      begun = false;
      return { ok: false, pid: null };
    }
    if (raw.length === 0 || raw.subarray(0, 15).toString() === "SQLite format 3") {
      db.exec("ROLLBACK");
      begun = false;
      return { ok: false, pid: null };
    }
    const str = raw.toString("utf8");
    if (!/^\d+\s*$/.test(str)) {
      db.exec("ROLLBACK");
      begun = false;
      return { ok: false, pid: null };
    }
    const textPid = parsePid(str);
    if (textPid && isAlive(textPid, kill)) {
      db.exec("ROLLBACK");
      begun = false;
      return { ok: false, pid: textPid };
    }
    fs.unlinkSync(lockPath);
    db.exec("COMMIT");
    begun = false;
  } catch (err) {
    if (begun) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* */
      }
    }
    if (isBusy(err)) return { ok: false, pid: readableLegacyPid(lockPath) };
    throw err;
  } finally {
    try {
      db.close();
    } catch {
      /* */
    }
  }
  try {
    return acquireSqlite(lockPath, pid, kill);
  } catch {
    return { ok: false, pid: null };
  }
}

export function acquireDaemonLock(
  lockPath,
  { pid = process.pid, kill = process.kill.bind(process) } = {},
) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  try {
    return acquireSqlite(lockPath, pid, kill);
  } catch (err) {
    if (isBusy(err)) return { ok: false, pid: bestEffortPid(lockPath) };
    if (isNotADb(err)) return migrateLegacyTextLock(lockPath, pid, kill);
    throw err;
  }
}

export function releaseDaemonLock(lockPath, { pid = process.pid } = {}) {
  try {
    const db = openLockDb(lockPath);
    try {
      db.exec("BEGIN IMMEDIATE");
      db.prepare("DELETE FROM holder WHERE pid = ?").run(pid);
      db.exec("COMMIT");
    } finally {
      try {
        db.close();
      } catch {
        /* */
      }
    }
  } catch {
    /* */
  }
}
