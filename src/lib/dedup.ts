import { createStore } from "#app-store";
import type { DedupStore, ReviewRunStore, Store, SummaryCommentStore } from "./dedup.types.ts";

// Re-export the store contract so callers keep importing types from "./dedup.ts".
export type {
  DedupStore,
  FindingRecord,
  ReviewRunRecord,
  ReviewRunStore,
  RunWithFindings,
  Store,
  SummaryCommentStore,
} from "./dedup.types.ts";

// Process-wide store singleton (no backend connection until a real event). The
// concrete backend is chosen at runtime by the "#app-store" subpath import (see
// package.json "imports"): node:sqlite (dedup.node.ts) on Node, D1 (dedup.d1.ts)
// on Cloudflare via the `workerd` condition.
let store: Store | undefined;

function getStore(): Store {
  store ??= createStore();
  return store;
}

// `binding` is passed by application-owned main-worker code on Cloudflare — the
// GitHub channel and app.ts routes — where getCloudflareContext() is NOT in
// scope, so the D1 binding must come from Hono's `c.env.DB`. Undefined (Node, or
// Flue's own DO-run workflow code where getCloudflareContext works) selects the
// singleton, which resolves its backend itself.
function resolve(binding: unknown): Store {
  return binding !== undefined ? createStore(binding) : getStore();
}

export function getDedupStore(binding?: unknown): DedupStore {
  return resolve(binding);
}

export function getSummaryCommentStore(binding?: unknown): SummaryCommentStore {
  return resolve(binding);
}

export function getReviewRunStore(binding?: unknown): ReviewRunStore {
  return resolve(binding);
}
