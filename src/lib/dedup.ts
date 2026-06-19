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

export class SqliteDedupStore implements DedupStore {
  #db: DatabaseSync;

  constructor(databaseUrl = process.env.DATABASE_URL) {
    const path = resolveDbPath(databaseUrl);
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec(
      'CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, claimed_at INTEGER NOT NULL)',
    );
  }

  claim(deliveryId: string): boolean {
    const result = this.#db
      .prepare('INSERT OR IGNORE INTO deliveries (id, claimed_at) VALUES (?, ?)')
      .run(deliveryId, Date.now());
    return result.changes === 1;
  }
}

let store: DedupStore | undefined;

// Process-wide store, created lazily on first use (no DB file until a real event).
export function getDedupStore(): DedupStore {
  store ??= new SqliteDedupStore();
  return store;
}
