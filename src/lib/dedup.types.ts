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
// skip replays. The methods are async so one interface fits both backends: the
// Node backend (node:sqlite, synchronous under the hood) and the Cloudflare
// backend (D1, genuinely async).
export interface DedupStore {
  // Returns true if this deliveryId was newly claimed, false if already seen.
  claim(deliveryId: string): Promise<boolean>;
  // Releases a previously claimed deliveryId so it can be re-claimed (e.g. on
  // admit failure). No-op if the id was never claimed.
  release(deliveryId: string): Promise<void>;
}

// Tracks the per-PR summary comment id so re-reviews (on `synchronize`) update
// the prior comment instead of stacking new ones (§7 step 6).
export interface SummaryCommentStore {
  getSummaryCommentId(prKey: string): Promise<number | undefined>;
  setSummaryCommentId(prKey: string, commentId: number): Promise<void>;
}

export interface ReviewRunStore {
  // Returns the new run's ID so callers can associate findings with it.
  logReviewRun(
    record: Omit<ReviewRunRecord, "id" | "createdAt">,
    findings?: Finding[],
  ): Promise<number>;
  getRecentRuns(limit?: number): Promise<ReviewRunRecord[]>;
  getStats(): Promise<{ totalRuns: number; totalCost: number; avgCost: number }>;
  getRunFindings(runId: number): Promise<FindingRecord[]>;
  exportRunsWithFindings(limit?: number): Promise<RunWithFindings[]>;
}

// Convenience: the concrete backends implement all three facets.
export type Store = DedupStore & SummaryCommentStore & ReviewRunStore;
