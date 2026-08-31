import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { customerRepoDir } from "./orchestrator.mjs";
import { insertEvent, openDb, utcNow } from "./util.mjs";

test("two engagements with the same customer name resolve to two different dirs", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tenwhy-dirs-"));
  const db = openDb(path.join(tmp, "t.db"));
  const now = utcNow();
  const a = "eng_aaaaaaa";
  const b = "eng_bbbbbbb";
  for (const id of [a, b]) {
    db.prepare(
      `INSERT INTO engagements (id, customer_name, idea, site_url, repo_url, status, created_at, updated_at)
       VALUES (?, 'Acme Dental', 'clinic', NULL, NULL, 'new', ?, ?)`,
    ).run(id, now, now);
  }
  insertEvent(db, {
    engagementId: a,
    kind: "engagement.created",
    payload: { slug: "acme-dental" },
  });
  insertEvent(db, {
    engagementId: b,
    kind: "engagement.created",
    payload: { slug: "acme-dental-eng_bbbb" },
  });
  const dirA = customerRepoDir({ id: a, customer_name: "Acme Dental" }, tmp, db);
  const dirB = customerRepoDir({ id: b, customer_name: "Acme Dental" }, tmp, db);
  assert.equal(dirA, path.join(tmp, "state/customers/acme-dental"));
  assert.equal(dirB, path.join(tmp, "state/customers/acme-dental-eng_bbbb"));
  assert.notEqual(dirA, dirB);
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
