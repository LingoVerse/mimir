// flue-blueprint: channel/github@1
import { createGitHubChannel } from '@flue/github';
import { getDedupStore } from '../lib/dedup.ts';
import { validateEnv } from '../lib/env.ts';
import type { ReviewPayload } from '../workflows/review-pr.ts';

// Fail fast at startup: Flue loads channels on boot (and for `flue run`), so a
// missing secret surfaces here with a clear message instead of crashing
// mid-review. `flue build` only bundles, so it does not run this.
try {
  validateEnv();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

// PR actions that trigger a review. Subscribe to `pull_request` (these actions)
// in the GitHub webhook config; content type must be application/json.
const REVIEW_ACTIONS = new Set(['opened', 'synchronize', 'reopened']);

// Admit a durable `review-pr` workflow run via its mounted route, then return.
// Flue has no programmatic workflow-admit API, so we POST the mounted route
// (the doc-endorsed handoff). No `?wait`, so it returns 202 immediately and the
// run proceeds durably — the response never blocks on the diff fetch or LLM.
// INTERNAL_BASE_URL pins the self-call to a loopback in prod (behind a proxy);
// otherwise the inbound request's own origin is used.
async function admitReview(requestUrl: string, pr: ReviewPayload): Promise<void> {
  const base = process.env.INTERNAL_BASE_URL ?? new URL(requestUrl).origin;
  const res = await fetch(`${base}/workflows/review-pr`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(pr),
  });
  const body = (await res.json().catch(() => ({}))) as { runId?: string };
  console.log('[mimir] review admitted', { ...pr, status: res.status, runId: body.runId });
}

export const channel = createGitHubChannel({
  webhookSecret: process.env.GITHUB_WEBHOOK_SECRET!,

  // Mounted at POST /channels/github/webhook. GitHub expects a 2xx within ~10s
  // and does not auto-retry, so verify, admit durable work, and return fast —
  // never block the response on diff fetching or LLM calls.
  async webhook({ c, delivery }) {
    if (delivery.name === 'pull_request' && REVIEW_ACTIONS.has(delivery.payload.action)) {
      // Idempotency: claim the delivery before any work; skip replays/redeliveries.
      // (A distinct `synchronize` push has its own deliveryId and is not skipped.)
      if (!getDedupStore().claim(delivery.deliveryId)) {
        console.log('[mimir] duplicate delivery skipped', delivery.deliveryId);
        return;
      }

      const { repository, pull_request } = delivery.payload;
      await admitReview(c.req.url, {
        owner: repository.owner.login,
        repo: repository.name,
        number: pull_request.number,
        headSha: pull_request.head.sha,
        baseRef: pull_request.base.ref,
      });
      return;
    }

    // `ping` and all other deliveries fall through to the channel's empty 200.
  },
});
