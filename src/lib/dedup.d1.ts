import type { D1Database } from "@cloudflare/workers-types";
import { getCloudflareContext } from "@flue/runtime/cloudflare";
import type {
  DedupStore,
  FindingRecord,
  ReviewRunRecord,
  ReviewRunStore,
  RunWithFindings,
  Store,
  SummaryCommentStore,
} from "./dedup.types.ts";
import type { Finding } from "./review.ts";

function mapRun(r: Record<string, unknown>): ReviewRunRecord {
  return {
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
  };
}

function mapFinding(r: Record<string, unknown>): FindingRecord {
  return {
    id: Number(r.id),
    runId: Number(r.run_id),
    file: String(r.file),
    line: r.line != null ? Number(r.line) : null,
    severity: String(r.severity),
    title: String(r.title),
    body: String(r.body),
    suggestion: r.suggestion != null ? String(r.suggestion) : null,
    createdAt: Number(r.created_at),
  };
}

// Cloudflare backend. Same tables and SQL as the Node backend, but async D1
// prepared statements. The schema is created by D1 migrations (see migrations/),
// NOT in code — unlike Node, D1 has no per-request `CREATE TABLE IF NOT EXISTS`.
class D1Store implements DedupStore, SummaryCommentStore, ReviewRunStore {
  #db: D1Database;

  // The binding defaults to the request/DO context. getCloudflareContext() is
  // request-scoped, but the store is created lazily inside a request and the D1
  // binding is stable per isolate, so resolving once is safe. Tests inject a
  // binding directly (getCloudflareContext() is unavailable outside Flue's worker).
  constructor(db?: D1Database) {
    const resolved = db ?? (getCloudflareContext().env.DB as D1Database | undefined);
    if (!resolved) {
      throw new Error("D1 binding `DB` is not configured — see wrangler.jsonc `d1_databases`.");
    }
    this.#db = resolved;
  }

  async claim(deliveryId: string): Promise<boolean> {
    const res = await this.#db
      .prepare("INSERT OR IGNORE INTO deliveries (id, claimed_at) VALUES (?, ?)")
      .bind(deliveryId, Date.now())
      .run();
    // Atomic at the statement level on D1's single primary: exactly one racing
    // insert of the same id reports a change.
    return res.meta.changes === 1;
  }

  async release(deliveryId: string): Promise<void> {
    await this.#db.prepare("DELETE FROM deliveries WHERE id = ?").bind(deliveryId).run();
  }

  async getSummaryCommentId(prKey: string): Promise<number | undefined> {
    const row = await this.#db
      .prepare("SELECT comment_id FROM pr_summaries WHERE pr_key = ?")
      .bind(prKey)
      .first<{ comment_id: number }>();
    return row ? Number(row.comment_id) : undefined;
  }

  async setSummaryCommentId(prKey: string, commentId: number): Promise<void> {
    await this.#db
      .prepare(
        `INSERT INTO pr_summaries (pr_key, comment_id, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(pr_key) DO UPDATE SET comment_id = excluded.comment_id, updated_at = excluded.updated_at`,
      )
      .bind(prKey, commentId, Date.now())
      .run();
  }

  async logReviewRun(
    record: Omit<ReviewRunRecord, "id" | "createdAt">,
    findings?: Finding[],
  ): Promise<number> {
    const db = this.#db;
    const now = Date.now();
    // D1 cannot reference a generated id mid-batch, so insert the run (RETURNING
    // its id) then the findings. Best-effort: the caller treats logging as
    // non-critical, so a rare partial write (run without findings) is tolerable.
    const row = await db
      .prepare(
        `INSERT INTO review_runs
          (pr_key, primary_model, primary_tokens, primary_cost_usd,
           escalation_model, escalation_tokens, escalation_cost_usd,
           file_count, changed_lines, truncated, security_sensitive,
           escalated, escalation_reasons, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id`,
      )
      .bind(
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
        now,
      )
      .first<{ id: number }>();
    const runId = Number(row?.id);
    if (findings?.length) {
      const placeholders = findings.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
      const params: (null | number | string)[] = [];
      for (const f of findings) {
        params.push(
          runId,
          f.file,
          f.line ?? null,
          f.severity,
          f.title,
          f.body,
          f.suggestion ?? null,
          now,
        );
      }
      await db
        .prepare(
          `INSERT INTO review_findings (run_id, file, line, severity, title, body, suggestion, created_at)
           VALUES ${placeholders}`,
        )
        .bind(...params)
        .run();
    }
    return runId;
  }

  async getRunFindings(runId: number): Promise<FindingRecord[]> {
    const { results } = await this.#db
      .prepare(
        `SELECT id, run_id, file, line, severity, title, body, suggestion, created_at
         FROM review_findings WHERE run_id = ? ORDER BY id`,
      )
      .bind(runId)
      .all<Record<string, unknown>>();
    return results.map(mapFinding);
  }

  async exportRunsWithFindings(limit = 100): Promise<RunWithFindings[]> {
    const { results } = await this.#db
      .prepare(
        `SELECT
          r.id, r.pr_key, r.primary_model, r.primary_tokens, r.primary_cost_usd,
          r.escalation_model, r.escalation_tokens, r.escalation_cost_usd,
          r.file_count, r.changed_lines, r.truncated, r.security_sensitive,
          r.escalated, r.escalation_reasons, r.created_at,
          rf.id as finding_id, rf.run_id as finding_run_id, rf.file as finding_file,
          rf.line as finding_line, rf.severity as finding_severity, rf.title as finding_title,
          rf.body as finding_body, rf.suggestion as finding_suggestion,
          rf.created_at as finding_created_at
         FROM review_runs r
         LEFT JOIN review_findings rf ON rf.run_id = r.id
         ORDER BY r.created_at DESC, rf.id
         LIMIT ?`,
      )
      .bind(limit)
      .all<Record<string, unknown>>();
    const runMap = new Map<number, RunWithFindings>();
    for (const row of results) {
      const runId = Number(row.id);
      let entry = runMap.get(runId);
      if (!entry) {
        entry = { ...mapRun(row), findings: [] };
        runMap.set(runId, entry);
      }
      if (row.finding_id != null) {
        entry.findings.push({
          id: Number(row.finding_id),
          runId: Number(row.finding_run_id),
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

  async getRecentRuns(limit = 20): Promise<ReviewRunRecord[]> {
    const { results } = await this.#db
      .prepare(
        `SELECT id, pr_key, primary_model, primary_tokens, primary_cost_usd,
                escalation_model, escalation_tokens, escalation_cost_usd,
                file_count, changed_lines, truncated, security_sensitive,
                escalated, escalation_reasons, created_at
         FROM review_runs ORDER BY created_at DESC LIMIT ?`,
      )
      .bind(limit)
      .all<Record<string, unknown>>();
    return results.map(mapRun);
  }

  async getStats(): Promise<{ totalRuns: number; totalCost: number; avgCost: number }> {
    const row = await this.#db
      .prepare(
        `SELECT COUNT(*) as total,
                COALESCE(SUM(primary_cost_usd + COALESCE(escalation_cost_usd, 0)), 0) as total_cost
         FROM review_runs`,
      )
      .first<{ total: number; total_cost: number }>();
    const total = row ? Number(row.total) : 0;
    const totalCost = row ? Number(row.total_cost) : 0;
    return { totalRuns: total, totalCost, avgCost: total > 0 ? totalCost / total : 0 };
  }
}

// Backend factory. The facade (dedup.ts) selects this on Cloudflare via "#app-store".
export function createStore(db?: D1Database): Store {
  return new D1Store(db);
}
