// flue-blueprint: channel/github@1
import { createGitHubChannel } from "@flue/github";
import { getDedupStore } from "../lib/dedup.ts";
import { validateEnv } from "../lib/env.ts";
import { client } from "../lib/github.ts";
import {
  hasSkipLabel,
  hasSkipMarker,
  isMaintainer,
  parseRememberCommand,
  parseReviewCommand,
} from "../lib/memory.ts";
import type { RememberPayload } from "../workflows/remember-pr.ts";
import type { ReviewPayload } from "../workflows/review-pr.ts";

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
const REVIEW_ACTIONS = new Set(["opened", "synchronize", "reopened"]);

// Admit a durable `review-pr` workflow run via its mounted route, then return.
// Flue has no programmatic workflow-admit API, so we POST the mounted route
// (the doc-endorsed handoff). No `?wait`, so it returns 202 immediately and the
// run proceeds durably — the response never blocks on the diff fetch or LLM.
// INTERNAL_BASE_URL pins the self-call to a loopback in prod (behind a proxy);
// otherwise the inbound request's own origin is used.
// Exported for unit testing. Returns a trusted base URL for the internal admit
// POST. If INTERNAL_BASE_URL is set, it is used verbatim. Otherwise the fallback
// must be loopback — a non-loopback origin indicates a misconfigured or spoofed
// Host header and is rejected.
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function resolveAdmitBase(internalBaseUrl: string | undefined, requestUrl: string): string {
  if (internalBaseUrl) return internalBaseUrl;
  const { origin, hostname } = new URL(requestUrl);
  if (LOOPBACK_HOSTNAMES.has(hostname.toLowerCase())) return origin;
  throw new Error(
    `INTERNAL_BASE_URL is not set and the inbound request origin "${origin}" is not loopback. ` +
      `Set INTERNAL_BASE_URL=http://127.0.0.1:<port> to fix this.`,
  );
}

async function admitReview(requestUrl: string, pr: ReviewPayload): Promise<void> {
  const base = resolveAdmitBase(process.env.INTERNAL_BASE_URL, requestUrl);
  const res = await fetch(`${base}/workflows/review-pr`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(pr),
  });
  const body = (await res.json().catch(() => ({}))) as { runId?: string };
  if (!res.ok) {
    throw new Error(`[mimir] admit failed with status ${res.status}`);
  }
  console.log("[mimir] review admitted", { ...pr, status: res.status, runId: body.runId });
}

// Admit a durable `remember-pr` run, mirroring admitReview: POST the mounted
// route (no `?wait`) so the webhook returns fast and curation runs durably.
async function admitRemember(requestUrl: string, payload: RememberPayload): Promise<void> {
  const base = resolveAdmitBase(process.env.INTERNAL_BASE_URL, requestUrl);
  const res = await fetch(`${base}/workflows/remember-pr`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = (await res.json().catch(() => ({}))) as { runId?: string };
  if (!res.ok) {
    throw new Error(`[mimir] remember admit failed with status ${res.status}`);
  }
  console.log("[mimir] remember admitted", {
    owner: payload.owner,
    repo: payload.repo,
    prNumber: payload.prNumber,
    status: res.status,
    runId: body.runId,
  });
}

// Exported for testing only. Handles one pull_request delivery end-to-end:
// claims, admits, and releases on failure.
export async function handlePullRequestDelivery(
  deps: {
    claim: (id: string) => boolean;
    release: (id: string) => void;
    admit: (requestUrl: string, pr: ReviewPayload) => Promise<void>;
  },
  requestUrl: string,
  deliveryId: string,
  pr: ReviewPayload,
): Promise<boolean> {
  if (!deps.claim(deliveryId)) {
    console.log("[mimir] duplicate delivery skipped", deliveryId);
    return false;
  }
  try {
    await deps.admit(requestUrl, pr);
    return true;
  } catch (err) {
    deps.release(deliveryId);
    console.log("[mimir] admit failed; released claim for retry", deliveryId);
    throw err;
  }
}

export const channel = createGitHubChannel({
  webhookSecret: process.env.GITHUB_WEBHOOK_SECRET!,

  // Mounted at POST /channels/github/webhook. GitHub expects a 2xx within ~10s
  // and does not auto-retry, so verify, admit durable work, and return fast —
  // never block the response on diff fetching or LLM calls.
  async webhook({ c, delivery }) {
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
        c.req.url,
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
        await admitReview(c.req.url, {
          owner,
          repo,
          number: prNumber,
          headSha: pr.head.sha,
          baseRef: pr.base.ref,
        });
        return;
      }

      // /remember — maintainer commits project memory.
      const fact = parseRememberCommand(comment.body);
      if (!fact) return;
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
      await admitRemember(c.req.url, { owner, repo, prNumber, headRef: pr.head.ref, fact, source });
      return;
    }

    // `ping` and all other deliveries fall through to the channel's empty 200.
  },
});
