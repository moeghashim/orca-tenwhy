#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MIGRATE="$ROOT/system/db/migrate.sh"
pass_n=0

pass() {
  pass_n=$((pass_n + 1))
  echo "PASS $pass_n"
}

fail_msg() {
  echo "FAIL: $*" >&2
  exit 1
}

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT
DB="$TMPDIR/test.db"

"$MIGRATE" "$DB" >/dev/null

# 1. exactly these 7 tables
tables="$(sqlite3 "$DB" "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;")"
expected=$'approvals\nengagements\nevents\ngate_checks\niterations\nloop_runs\nscrapes'
if [[ "$tables" != "$expected" ]]; then
  fail_msg "expected 7 tables, got: $tables"
fi
pass

expect_check() {
  local sql="$1"
  local out rc
  set +e
  out="$(sqlite3 "$DB" "$sql" 2>&1)"
  rc=$?
  set -e
  if [[ $rc -eq 0 ]]; then
    fail_msg "expected CHECK failure, insert succeeded: $sql"
  fi
  if ! grep -qi 'CHECK constraint' <<<"$out"; then
    fail_msg "expected CHECK constraint error, got: $out"
  fi
  pass
}

# 2–5. invalid enum values fail CHECK
expect_check "INSERT INTO iterations (id, loop_run_id, n, reviewer_verdict) VALUES ('t1','r1',1,'maybe');"
expect_check "INSERT INTO engagements (id, status) VALUES ('e1','bogus');"
expect_check "INSERT INTO loop_runs (id, engagement_id, loop_name, attempt, status) VALUES ('r1','e1','company-research',0,'bogus');"
expect_check "INSERT INTO approvals (id, engagement_id, action) VALUES ('a1','e1','maybe');"

# 6. a valid row of each kind inserts successfully
sqlite3 "$DB" <<'SQL'
INSERT INTO engagements (id, customer_name, idea, site_url, repo_url, status, created_at, updated_at)
VALUES ('e1','Acme','idea','https://example.com','https://git.example/acme','new','2026-08-30','2026-08-30');
INSERT INTO loop_runs (id, engagement_id, loop_name, attempt, change_request_id, status, pi_trace_ref, adjusted_instructions, started_at, finished_at)
VALUES ('r1','e1','company-research',0,NULL,'queued','pi://session/x','','2026-08-30',NULL);
INSERT INTO iterations (id, loop_run_id, n, executor_output_path, reviewer_verdict, reviewer_notes, pi_trace_ref, created_at)
VALUES ('i1','r1',1,'/tmp/out','approve','ok','pi://session/x','2026-08-30');
INSERT INTO gate_checks (id, loop_run_id, check_name, passed, detail, created_at)
VALUES ('g1','r1','schema',1,'ok','2026-08-30');
INSERT INTO scrapes (id, loop_run_id, url, http_status, content_path, created_at)
VALUES ('s1','r1','https://example.com',200,'/tmp/page','2026-08-30');
INSERT INTO approvals (id, engagement_id, action, notes, created_at)
VALUES ('a1','e1','approve','ship it','2026-08-30');
INSERT INTO events (engagement_id, loop_run_id, kind, payload, created_at)
VALUES ('e1','r1','started','{}','2026-08-30');
SQL
pass

# 7. migrate.sh is idempotent
"$MIGRATE" "$DB" >/dev/null
pass

if [[ "$pass_n" -ne 7 ]]; then
  fail_msg "expected 7 PASS, got $pass_n"
fi
exit 0
