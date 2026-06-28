import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

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
  logReviewRun(record: Omit<ReviewRunRecord, "id" | "createdAt">): void;
  getRecentRuns(limit?: number): ReviewRunRecord[];
  getStats(): { totalRuns: number; totalCost: number; avgCost: number };
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

  logReviewRun(record: Omit<ReviewRunRecord, "id" | "createdAt">): void {
    this.#db
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
