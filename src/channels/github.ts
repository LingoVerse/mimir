// flue-blueprint: channel/github@1
import { createGitHubChannel } from "@flue/github";
import { invoke } from "@flue/runtime";
import { getDedupStore } from "../lib/dedup.ts";
import { validateEnv } from "../lib/env.ts";
import { client } from "../lib/github.ts";
import {
  hasSkipLabel,
  hasSkipMarker,
  isLikelyFeedback,
  isMaintainer,
  parseRememberCommand,
  parseReviewCommand,
} from "../lib/memory.ts";
import feedbackPr, { type FeedbackPayload } from "../workflows/feedback-pr.ts";
import rememberPr, { type RememberPayload } from "../workflows/remember-pr.ts";
import reviewPr, { type ReviewPayload } from "../workflows/review-pr.ts";
import { handlePullRequestDelivery } from "../lib/handle-delivery.ts";

// Fail fast at startup: Flue loads channels on boot (and for `flue run`), so a
// missing secret surfaces here with a clear message instead of crashing
// mid-review. `flue build` only bundles, so it does not run this. We `throw`
// (not process.exit): on Cloudflare there is no process to exit — throwing at
// module load fails the isolate closed, the Node-equivalent of refusing to boot.
try {
  validateEnv();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  throw err;
}

// PR actions that trigger a review. Subscribe to `pull_request` (these actions)
// in the GitHub webhook config; content type must be application/json.
const REVIEW_ACTIONS = new Set(["opened", "synchronize", "reopened"]);

// Admit durable workflow runs via ambient `invoke()` — Flue's cross-target
// admission path (Node and Cloudflare). It returns { runId } immediately and the
// run proceeds durably, so the webhook response never blocks on the diff fetch
// or the LLM. No HTTP self-call, so there is no loopback origin to resolve and
// the workflows expose no public POST route (only the verified webhook triggers
// work).
async function admitReview(pr: ReviewPayload): Promise<void> {
  const { runId } = await invoke(reviewPr, { input: pr });
  console.log("[mimir] review admitted", { ...pr, runId });
}

// Admit a durable `remember-pr` run (mirrors admitReview).
async function admitRemember(payload: RememberPayload): Promise<void> {
  const { runId } = await invoke(rememberPr, { input: payload });
  console.log("[mimir] remember admitted", {
    owner: payload.owner,
    repo: payload.repo,
    prNumber: payload.prNumber,
    runId,
  });
}

// Admit an auto-detected feedback curation run (same pattern as admitRemember).
async function admitFeedback(payload: FeedbackPayload): Promise<void> {
  const { runId } = await invoke(feedbackPr, { input: payload });
  console.log("[mimir] feedback admitted", {
    owner: payload.owner,
    repo: payload.repo,
    prNumber: payload.prNumber,
    runId,
  });
}

export const channel = createGitHubChannel({
  webhookSecret: process.env.GITHUB_WEBHOOK_SECRET!,

  // Mounted at POST /channels/github/webhook. GitHub expects a 2xx within ~10s
  // and does not auto-retry, so verify, admit durable work, and return fast —
  // never block the response on diff fetching or LLM calls.
  async webhook({ delivery }) {
    if (delivery.name === "pull_request" && REVIEW_ACTIONS.has(delivery.payload.action)) {
      // Opt-out lever: a skip label on the PR excludes it from review entirely
      // (persists across every push, unlike the per-commit marker). Checked from
      // the payload, so no API call when we're going to skip.
      const labelNames = delivery.payload.pull_request.labels?.map((l) => l.name) ?? [];
      if (hasSkipLabel(labelNames)) {
        console.log("[mimir] skip-label present, not reviewing", {
          number: delivery.payload.pull_request.number,
          labels: labelNames,
        });
        return;
      }
      // Loop guard: skip review if the head commit carries a skip marker (e.g. a
      // memory write-back the bot just pushed, or a human opt-out).
      const headSha = delivery.payload.pull_request.head.sha;
      const { data: commit } = await client.rest.repos.getCommit({
        owner: delivery.payload.repository.owner.login,
        repo: delivery.payload.repository.name,
        ref: headSha,
      });
      if (hasSkipMarker(commit.commit.message)) {
        console.log("[mimir] skip-marker detected, not reviewing", headSha);
        return;
      }
      // Idempotency: claim the delivery before any work; skip replays/redeliveries.
      // (A distinct `synchronize` push has its own deliveryId and is not skipped.)
      const { repository, pull_request } = delivery.payload;
      const pr: ReviewPayload = {
        owner: repository.owner.login,
        repo: repository.name,
        number: pull_request.number,
        headSha: pull_request.head.sha,
        baseRef: pull_request.base.ref,
      };
      const store = getDedupStore();
      await handlePullRequestDelivery(
        { claim: store.claim.bind(store), release: store.release.bind(store), admit: admitReview },
        delivery.deliveryId,
        pr,
      );
      return;
    }

    if (delivery.name === "issue_comment" && delivery.payload.action === "created") {
      const { repository, issue, comment } = delivery.payload;
      if (!issue.pull_request) return; // PR-only
      if (!isMaintainer(comment.author_association)) return; // both commands are maintainer-only
      const owner = repository.owner.login;
      const repo = repository.name;
      const prNumber = issue.number;

      // /review — maintainer re-triggers a (read-only) review.
      if (parseReviewCommand(comment.body)) {
        if (!getDedupStore().claim(delivery.deliveryId)) {
          console.log("[mimir] duplicate /review delivery skipped", delivery.deliveryId);
          return;
        }
        const { data: pr } = await client.rest.pulls.get({ owner, repo, pull_number: prNumber });
        console.log("[mimir] /review command from", comment.user?.login ?? "unknown");
        await admitReview({
          owner,
          repo,
          number: prNumber,
          headSha: pr.head.sha,
          baseRef: pr.base.ref,
        });
        return;
      }

      // /remember or /feedback — maintainer commits project memory.
      const fact = parseRememberCommand(comment.body);
      if (fact) {
        if (!getDedupStore().claim(delivery.deliveryId)) {
          console.log("[mimir] duplicate remember delivery skipped", delivery.deliveryId);
          return;
        }
        // issue_comment lacks PR head info; fetch it to get the head ref + fork status.
        const { data: pr } = await client.rest.pulls.get({ owner, repo, pull_number: prNumber });
        if (pr.head.repo?.full_name !== `${owner}/${repo}`) {
          await client.rest.issues.createComment({
            owner,
            repo,
            issue_number: prNumber,
            body: "[mimir] `/remember` is not supported for PRs from forks. Memory files must be committed to the base repository.",
          });
          return;
        }
        const source = `pr#${prNumber} by ${comment.user?.login ?? "unknown"}`;
        await admitRemember({
          owner,
          repo,
          prNumber,
          headRef: pr.head.ref,
          fact,
          source,
        });
        return;
      }

      // Auto-detect maintainer feedback worth remembering (no explicit command).
      if (isLikelyFeedback(comment.body)) {
        const { data: pr } = await client.rest.pulls.get({ owner, repo, pull_number: prNumber });
        if (pr.head.repo?.full_name !== `${owner}/${repo}`) return; // fork — can't push memory
        if (!getDedupStore().claim(delivery.deliveryId)) {
          console.log("[mimir] duplicate feedback delivery skipped", delivery.deliveryId);
          return;
        }
        await admitFeedback({
          owner,
          repo,
          prNumber,
          headRef: pr.head.ref,
          commentBody: comment.body,
          commentAuthor: comment.user?.login ?? "unknown",
        });
        return;
      }
    }

    // `ping` and all other deliveries fall through to the channel's empty 200.
  },
});
