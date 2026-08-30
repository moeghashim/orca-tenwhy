PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS engagements (
  id TEXT PRIMARY KEY, customer_name TEXT, idea TEXT, site_url TEXT,
  repo_url TEXT, status TEXT CHECK(status IN
    ('new','running','needs_human','awaiting_approval','complete','failed')),
  created_at TEXT, updated_at TEXT);

CREATE TABLE IF NOT EXISTS loop_runs (
  id TEXT PRIMARY KEY, engagement_id TEXT REFERENCES engagements(id),
  loop_name TEXT, attempt INTEGER,             -- orchestrator retry #: 0..2
  change_request_id TEXT,                      -- set when spawned by a customer request
  status TEXT CHECK(status IN
    ('queued','running','gate_passed','gate_failed','needs_human')),
  pi_trace_ref TEXT, adjusted_instructions TEXT,
  started_at TEXT, finished_at TEXT);

CREATE TABLE IF NOT EXISTS iterations (
  id TEXT PRIMARY KEY, loop_run_id TEXT REFERENCES loop_runs(id),
  n INTEGER,                                    -- 1..4
  executor_output_path TEXT,
  reviewer_verdict TEXT CHECK(reviewer_verdict IN
    ('revise','approve','reject','escalate')),
  reviewer_notes TEXT, pi_trace_ref TEXT, created_at TEXT);

CREATE TABLE IF NOT EXISTS gate_checks (
  id TEXT PRIMARY KEY, loop_run_id TEXT REFERENCES loop_runs(id),
  check_name TEXT, passed INTEGER, detail TEXT, created_at TEXT);

CREATE TABLE IF NOT EXISTS scrapes (
  id TEXT PRIMARY KEY, loop_run_id TEXT, url TEXT,
  http_status INTEGER, content_path TEXT, created_at TEXT);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, engagement_id TEXT REFERENCES engagements(id),
  action TEXT CHECK(action IN ('approve','request_changes')),
  notes TEXT, created_at TEXT);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, engagement_id TEXT,
  loop_run_id TEXT, kind TEXT, payload TEXT, created_at TEXT);
