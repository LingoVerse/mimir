-- Mimir application storage on Cloudflare D1 (dedup, summary-comment ids, review
-- stats + findings). Mirrors the tables the Node backend creates in code
-- (src/lib/dedup.node.ts). Apply with `wrangler d1 migrations apply mimir`.

CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  claimed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pr_summaries (
  pr_key TEXT PRIMARY KEY,
  comment_id INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS review_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_key TEXT NOT NULL,
  primary_model TEXT NOT NULL,
  primary_tokens INTEGER NOT NULL,
  primary_cost_usd REAL NOT NULL,
  escalation_model TEXT,
  escalation_tokens INTEGER,
  escalation_cost_usd REAL,
  file_count INTEGER NOT NULL,
  changed_lines INTEGER NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0,
  security_sensitive INTEGER NOT NULL DEFAULT 0,
  escalated INTEGER NOT NULL DEFAULT 0,
  escalation_reasons TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS review_findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  file TEXT NOT NULL,
  line INTEGER,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  suggestion TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_review_findings_run_id ON review_findings (run_id);
