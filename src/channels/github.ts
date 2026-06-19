// flue-blueprint: channel/github@1
import { createGitHubChannel } from '@flue/github';
import { Octokit } from '@octokit/rest';

// Outbound GitHub API client. Used by lib/diff.ts (fetch diff) and
// lib/post-review.ts (post summary + inline comments) in later phases.
export const client = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

// PR actions that trigger a review. Subscribe to `pull_request` (these actions)
// in the GitHub webhook config; content type must be application/json.
const REVIEW_ACTIONS = new Set(['opened', 'synchronize', 'reopened']);

export const channel = createGitHubChannel({
  webhookSecret: process.env.GITHUB_WEBHOOK_SECRET!,

  // Mounted at POST /channels/github/webhook. GitHub expects a 2xx within ~10s
  // and does not auto-retry, so verify, admit durable work, and return fast —
  // never block the response on diff fetching or LLM calls.
  async webhook({ delivery }) {
    if (delivery.name === 'pull_request' && REVIEW_ACTIONS.has(delivery.payload.action)) {
      const { repository, pull_request } = delivery.payload;
      const pr = {
        owner: repository.owner.login,
        repo: repository.name,
        number: pull_request.number,
        headSha: pull_request.head.sha,
      };

      // Phase 2: claim `delivery.deliveryId` for idempotency (skip if already seen).
      // Phase 3: admit a durable `review-pr` workflow run for `pr`, then return.
      console.log('[mimir] review requested', { deliveryId: delivery.deliveryId, ...pr });
      return;
    }

    // `ping` and all other deliveries fall through to the channel's empty 200.
  },
});
