import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Finding } from "./review.ts";

export interface ReviewRunRecord {
  id: number;
  prKey: string;
  primaryModel: string;
  primaryTokens: number;
  primaryCostUsd: number;
  escalationModel: string | null;
  escalationTokens: number | null;
  escalationCostUsd: number | null;
  fileCount: number;
  changedLines: number;
  truncated: number;
  securitySensitive: number;
  escalated: number;
  escalationReasons: string;
  createdAt: number;
}

export interface FindingRecord {
  id: number;
  runId: number;
  file: string;
  line: number | null;
  severity: string;
  title: string;
  body: string;
  suggestion: string | null;
  createdAt: number;
}

export interface RunWithFindings extends ReviewRunRecord {
  findings: FindingRecord[];
}

// Idempotency guard. GitHub does not dedupe delivery IDs and the channel is
// stateless, so we claim `delivery.deliveryId` BEFORE doing any review work and
// skip replays. node:sqlite is a built-in (no native deps); the Flue node
// target always runs under Node, so it is available at runtime.
export interface DedupStore {
  // Returns true if this deliveryId was newly claimed, false if already seen.
  claim(deliveryId: string): boolean;
  // Releases a previously claimed deliveryId so it can be re-claimed (e.g. on
  // admit failure). No-op if the id was never claimed.
  release(deliveryId: string): void;
}

// Tracks the per-PR summary comment id so re-reviews (on `synchronize`) update
// the prior comment instead of stacking new ones (§7 step 6). Same SQLite DB.
export interface SummaryCommentStore {
  getSummaryCommentId(prKey: string): number | undefined;
  setSummaryCommentId(prKey: string, commentId: number): void;
}

export interface ReviewRunStore {
  // Returns the new run's ID so callers can associate findings with it.
  logReviewRun(record: Omit<ReviewRunRecord, "id" | "createdAt">, findings?: Finding[]): number;
  getRecentRuns(limit?: number): ReviewRunRecord[];
  getStats(): { totalRuns: number; totalCost: number; avgCost: number };
  getRunFindings(runId: number): FindingRecord[];
  exportRunsWithFindings(limit?: number): RunWithFindings[];
}

// Accept `sqlite:./path.db`, `sqlite:///abs/path.db`, a bare path, or default.
// Only sqlite is implemented; a postgres/redis URL is rejected loudly rather
// than silently mis-handled.
function resolveDbPath(databaseUrl: string | undefined): string {
  if (!databaseUrl) return "./data/mimir.db";
  if (databaseUrl.startsWith("sqlite:")) {
    return databaseUrl.replace(/^sqlite:(\/\/)?/, "") || "./data/mimir.db";
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(databaseUrl)) {
    throw new Error(
      `DATABASE_URL scheme not supported (sqlite only): ${databaseUrl.split(":")[0]}:`,
    );
  }
  return databaseUrl;
}

export class SqliteDedupStore implements DedupStore, SummaryCommentStore, ReviewRunStore {
  #db: DatabaseSync;

  constructor(databaseUrl = process.env.DATABASE_URL) {
    const path = resolveDbPath(databaseUrl);
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec(
      "CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, claimed_at INTEGER NOT NULL)",
    );
    this.#db.exec(
      "CREATE TABLE IF NOT EXISTS pr_summaries (pr_key TEXT PRIMARY KEY, comment_id INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
    );
    this.#db.exec(
      `CREATE TABLE IF NOT EXISTS review_runs (
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
      )`,
    );
    this.#db.exec(
      `CREATE TABLE IF NOT EXISTS review_findings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL,
        file TEXT NOT NULL,
        line INTEGER,
        severity TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        suggestion TEXT,
        created_at INTEGER NOT NULL
      )`,
    );
    this.#db.exec(
      "CREATE INDEX IF NOT EXISTS idx_review_findings_run_id ON review_findings (run_id)",
    );
  }

  claim(deliveryId: string): boolean {
    const result = this.#db
      .prepare("INSERT OR IGNORE INTO deliveries (id, claimed_at) VALUES (?, ?)")
      .run(deliveryId, Date.now());
    return result.changes === 1;
  }

  release(deliveryId: string): void {
    this.#db.prepare("DELETE FROM deliveries WHERE id = ?").run(deliveryId);
  }

  getSummaryCommentId(prKey: string): number | undefined {
    const row = this.#db
      .prepare("SELECT comment_id FROM pr_summaries WHERE pr_key = ?")
      .get(prKey) as { comment_id: number | bigint } | undefined;
    return row ? Number(row.comment_id) : undefined;
  }

  setSummaryCommentId(prKey: string, commentId: number): void {
    this.#db
      .prepare(
        `INSERT INTO pr_summaries (pr_key, comment_id, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(pr_key) DO UPDATE SET comment_id = excluded.comment_id, updated_at = excluded.updated_at`,
      )
      .run(prKey, commentId, Date.now());
  }

  logReviewRun(record: Omit<ReviewRunRecord, "id" | "createdAt">, findings?: Finding[]): number {
    this.#db.exec("BEGIN");
    try {
      const result = this.#db
        .prepare(
          `INSERT INTO review_runs
            (pr_key, primary_model, primary_tokens, primary_cost_usd,
             escalation_model, escalation_tokens, escalation_cost_usd,
             file_count, changed_lines, truncated, security_sensitive,
             escalated, escalation_reasons, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.prKey,
          record.primaryModel,
          record.primaryTokens,
          record.primaryCostUsd,
          record.escalationModel,
          record.escalationTokens,
          record.escalationCostUsd,
          record.fileCount,
          record.changedLines,
          record.truncated,
          record.securitySensitive,
          record.escalated,
          record.escalationReasons,
          Date.now(),
        );
      const runId = Number(result.lastInsertRowid);
      if (findings?.length) {
        const now = Date.now();
        // Multi-row INSERT: build VALUES placeholders once, flatten params.
        const placeholders = findings
          .map(() => "(?, ?, ?, ?, ?, ?, ?, ?)")
          .join(", ");
        const params: (null | number | bigint | string)[] = [];
        for (const f of findings) {
          params.push(
            runId, f.file, f.line ?? null, f.severity,
            f.title, f.body, f.suggestion ?? null, now,
          );
        }
        this.#db
          .prepare(
            `INSERT INTO review_findings (run_id, file, line, severity, title, body, suggestion, created_at)
             VALUES ${placeholders}`,
          )
          .run(...params);
      }
      this.#db.exec("COMMIT");
      return runId;
    } catch (e) {
      this.#db.exec("ROLLBACK");
      throw e;
    }
  }

  getRunFindings(runId: number): FindingRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT id, run_id, file, line, severity, title, body, suggestion, created_at
         FROM review_findings WHERE run_id = ? ORDER BY id`,
      )
      .all(runId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r.id),
      runId: Number(r.run_id),
      file: String(r.file),
      line: r.line != null ? Number(r.line) : null,
      severity: String(r.severity),
      title: String(r.title),
      body: String(r.body),
      suggestion: r.suggestion != null ? String(r.suggestion) : null,
      createdAt: Number(r.created_at),
    }));
  }

  exportRunsWithFindings(limit = 100): RunWithFindings[] {
    const rows = this.#db
      .prepare(
        `SELECT
          r.id, r.pr_key, r.primary_model, r.primary_tokens, r.primary_cost_usd,
          r.escalation_model, r.escalation_tokens, r.escalation_cost_usd,
          r.file_count, r.changed_lines, r.truncated, r.security_sensitive,
          r.escalated, r.escalation_reasons, r.created_at,
          rf.id as finding_id, rf.run_id, rf.file as finding_file, rf.line as finding_line,
          rf.severity as finding_severity, rf.title as finding_title,
          rf.body as finding_body, rf.suggestion as finding_suggestion,
          rf.created_at as finding_created_at
         FROM review_runs r
         LEFT JOIN review_findings rf ON rf.run_id = r.id
         ORDER BY r.created_at DESC, rf.id
         LIMIT ?`,
      )
      .all(limit) as Record<string, unknown>[];
    // Group by run_id in a single pass.
    const runMap = new Map<number, RunWithFindings>();
    for (const row of rows) {
      const runId = Number(row.id);
      let entry = runMap.get(runId);
      if (!entry) {
        entry = {
          id: runId,
          prKey: String(row.pr_key),
          primaryModel: String(row.primary_model),
          primaryTokens: Number(row.primary_tokens),
          primaryCostUsd: Number(row.primary_cost_usd),
          escalationModel: row.escalation_model as string | null,
          escalationTokens: row.escalation_tokens != null ? Number(row.escalation_tokens) : null,
          escalationCostUsd: row.escalation_cost_usd != null ? Number(row.escalation_cost_usd) : null,
          fileCount: Number(row.file_count),
          changedLines: Number(row.changed_lines),
          truncated: Number(row.truncated),
          securitySensitive: Number(row.security_sensitive),
          escalated: Number(row.escalated),
          escalationReasons: String(row.escalation_reasons),
          createdAt: Number(row.created_at),
          findings: [],
        };
        runMap.set(runId, entry);
      }
      if (row.finding_id != null) {
        entry.findings.push({
          id: Number(row.finding_id),
          runId: Number(row.run_id),
          file: String(row.finding_file),
          line: row.finding_line != null ? Number(row.finding_line) : null,
          severity: String(row.finding_severity),
          title: String(row.finding_title),
          body: String(row.finding_body),
          suggestion: row.finding_suggestion != null ? String(row.finding_suggestion) : null,
          createdAt: Number(row.finding_created_at),
        });
      }
    }
    return [...runMap.values()];
  }

  getRecentRuns(limit = 20): ReviewRunRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT id, pr_key, primary_model, primary_tokens, primary_cost_usd,
                escalation_model, escalation_tokens, escalation_cost_usd,
                file_count, changed_lines, truncated, security_sensitive,
                escalated, escalation_reasons, created_at
         FROM review_runs ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r.id),
      prKey: String(r.pr_key),
      primaryModel: String(r.primary_model),
      primaryTokens: Number(r.primary_tokens),
      primaryCostUsd: Number(r.primary_cost_usd),
      escalationModel: r.escalation_model as string | null,
      escalationTokens: r.escalation_tokens != null ? Number(r.escalation_tokens) : null,
      escalationCostUsd: r.escalation_cost_usd != null ? Number(r.escalation_cost_usd) : null,
      fileCount: Number(r.file_count),
      changedLines: Number(r.changed_lines),
      truncated: Number(r.truncated),
      securitySensitive: Number(r.security_sensitive),
      escalated: Number(r.escalated),
      escalationReasons: String(r.escalation_reasons),
      createdAt: Number(r.created_at),
    }));
  }

  getStats(): { totalRuns: number; totalCost: number; avgCost: number } {
    const row = this.#db
      .prepare(
        `SELECT COUNT(*) as total,
                COALESCE(SUM(primary_cost_usd + COALESCE(escalation_cost_usd, 0)), 0) as total_cost
         FROM review_runs`,
      )
      .get() as { total: number; total_cost: number };
    return {
      totalRuns: Number(row.total),
      totalCost: Number(row.total_cost),
      avgCost: row.total > 0 ? Number(row.total_cost) / Number(row.total) : 0,
    };
  }
}

let store: SqliteDedupStore | undefined;

function getStore(): SqliteDedupStore {
  // Process-wide store, created lazily on first use (no DB file until a real event).
  store ??= new SqliteDedupStore();
  return store;
}

export function getDedupStore(): DedupStore {
  return getStore();
}

export function getSummaryCommentStore(): SummaryCommentStore {
  return getStore();
}

export function getReviewRunStore(): ReviewRunStore {
  return getStore();
}
