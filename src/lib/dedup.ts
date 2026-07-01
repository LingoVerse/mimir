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

// Process-wide store, created lazily on first use (no backend connection until a
// real event). The concrete backend is chosen at runtime by the "#app-store"
// subpath import (see package.json "imports"): node:sqlite (dedup.node.ts) on
// Node, D1 (dedup.d1.ts) on Cloudflare via the `workerd` condition.
let store: Store | undefined;

function getStore(): Store {
  store ??= createStore();
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
