import type { FlueContext, WorkflowRouteHandler } from '@flue/runtime';

// PR coordinates passed by the GitHub channel when it admits a review run.
export interface ReviewPayload {
  owner: string;
  repo: string;
  number: number;
  headSha: string;
}

// Phase 3 implements the full deterministic pipeline here:
// resolve PR → fetch + chunk diff (lib/diff.ts) → load skills → primary pass
// (MODEL_PRIMARY) → escalation decision (lib/escalation.ts) → post review
// (lib/post-review.ts). Skeleton kept minimal so the app builds and the channel
// has a durable admission target.
export async function run({ payload }: FlueContext<ReviewPayload>) {
  return { status: 'not-implemented', pr: payload };
}

// Expose POST /workflows/review-pr — the admission boundary the channel calls
// to start a durable run (returns 202 { runId, ... }).
export const route: WorkflowRouteHandler = async (_c, next) => next();
