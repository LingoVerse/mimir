import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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

// Accept `sqlite:./path.db`, `sqlite:///abs/path.db`, a bare path, or default.
// Only sqlite is implemented; a postgres/redis URL is rejected loudly rather
// than silently mis-handled.
function resolveDbPath(databaseUrl: string | undefined): string {
  if (!databaseUrl) return './data/mimir.db';
  if (databaseUrl.startsWith('sqlite:')) {
    return databaseUrl.replace(/^sqlite:(\/\/)?/, '') || './data/mimir.db';
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(databaseUrl)) {
    throw new Error(
      `DATABASE_URL scheme not supported (sqlite only): ${databaseUrl.split(':')[0]}:`,
    );
  }
  return databaseUrl;
}

export class SqliteDedupStore implements DedupStore, SummaryCommentStore {
  #db: DatabaseSync;

  constructor(databaseUrl = process.env.DATABASE_URL) {
    const path = resolveDbPath(databaseUrl);
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec(
      'CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, claimed_at INTEGER NOT NULL)',
    );
    this.#db.exec(
      'CREATE TABLE IF NOT EXISTS pr_summaries (pr_key TEXT PRIMARY KEY, comment_id INTEGER NOT NULL, updated_at INTEGER NOT NULL)',
    );
  }

  claim(deliveryId: string): boolean {
    const result = this.#db
      .prepare('INSERT OR IGNORE INTO deliveries (id, claimed_at) VALUES (?, ?)')
      .run(deliveryId, Date.now());
    return result.changes === 1;
  }

  release(deliveryId: string): void {
    this.#db
      .prepare('DELETE FROM deliveries WHERE id = ?')
      .run(deliveryId);
  }

  getSummaryCommentId(prKey: string): number | undefined {
    const row = this.#db
      .prepare('SELECT comment_id FROM pr_summaries WHERE pr_key = ?')
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
