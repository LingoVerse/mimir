import type { Octokit } from "@octokit/rest";
import { type SummaryCommentStore, getSummaryCommentStore } from "./dedup.ts";
import {
  existingFindingFingerprints,
  fetchExistingReviewDiscussion,
  findingFingerprint,
  findingMarker,
} from "./pr-discussion.ts";
import type { Finding, ReviewResult, Severity } from "./review.ts";

// PR coordinates needed to post. `headSha` is the commit inline comments attach to.
export interface ReviewTarget {
  owner: string;
  repo: string;
  number: number;
  headSha: string;
}

// Per-review spend, rendered as a small footer on the summary comment so the
// cost is visible on the PR without digging into the run logs.
export interface CostSummary {
  totalUsd: number;
  primaryModel: string;
  primaryUsd: number;
  escalationModel: string | null;
  escalationUsd: number | null;
}

export interface PostMeta {
  escalated: boolean;
  reasons: string[];
  // Number of files dropped by the diff token budget, if any.
  truncatedOmitted?: number;
  cost?: CostSummary;
}

// Hidden marker on our summary comment (fallback identity if the stored id is lost).
const MARKER = "<!-- mimir-summary -->";
// Marker on the failure notice (kept distinct from the summary so a failed run
// never overwrites a good review).
const FAIL_MARKER = "<!-- mimir-review-failed -->";

const VERDICT_LABEL: Record<ReviewResult["verdict"], string> = {
  request_changes: "🔴 Changes requested",
  comment: "🟡 Comments",
  approve_suggestion: "🟢 No blocking issues",
};

function postNitsEnabled(): boolean {
  return process.env.POST_NITS === "true";
}

// Findings worth surfacing: nits are suppressed unless POST_NITS=true.
export function visibleFindings(findings: Finding[], postNits = postNitsEnabled()): Finding[] {
  return findings.filter((f) => postNits || f.severity !== "nit");
}

function countBySeverity(findings: Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { critical: 0, major: 0, minor: 0, nit: 0 };
  for (const f of findings) counts[f.severity]++;
  return counts;
}

// Build the issue-level summary comment (verdict + counts + line-less findings).
export function buildSummaryBody(
  review: ReviewResult,
  meta: PostMeta,
  postNits = postNitsEnabled(),
  inlineFallback: Finding[] = [],
): string {
  const counts = countBySeverity(review.findings);
  const nitNote = !postNits && counts.nit > 0 ? " _(suppressed)_" : "";
  const countLine = `**Findings:** ${counts.critical} critical · ${counts.major} major · ${counts.minor} minor · ${counts.nit} nit${nitNote}`;

  const lines = [
    MARKER,
    `## Mimir review — ${VERDICT_LABEL[review.verdict]}`,
    "",
    review.summary,
    "",
    countLine,
  ];

  if (meta.escalated) {
    lines.push(`> Escalated to the stronger model (${meta.reasons.join(", ")}).`);
  }
  if (meta.truncatedOmitted && meta.truncatedOmitted > 0) {
    lines.push(
      `> Diff truncated to fit the token budget; ${meta.truncatedOmitted} file(s) not reviewed.`,
    );
  }

  // File-level findings (no line) can't be inline — list them here.
  const general = visibleFindings(review.findings, postNits).filter((f) => f.line === undefined);
  if (general.length > 0) {
    lines.push("", "### General findings");
    for (const f of general) {
      lines.push(`- **[${f.severity}] ${f.title}** (\`${f.file}\`) — ${f.body}`);
    }
  }

  if (inlineFallback.length > 0) {
    lines.push("", "### Findings that couldn't be posted inline");
    for (const f of inlineFallback) {
      lines.push(`- **[${f.severity}] ${f.title}** (\`${f.file}\`, line ${f.line}) — ${f.body}`);
    }
  }

  if (meta.cost) {
    const c = meta.cost;
    const segments = [`primary \`${c.primaryModel}\` $${c.primaryUsd.toFixed(4)}`];
    if (c.escalationModel !== null) {
      segments.push(`escalation \`${c.escalationModel}\` $${(c.escalationUsd ?? 0).toFixed(4)}`);
    }
    lines.push(
      "",
      `<sub>💰 Review cost: **$${c.totalUsd.toFixed(4)}** — ${segments.join(" · ")}</sub>`,
    );
  }

  return lines.join("\n");
}

function inlineCommentBody(f: Finding): string {
  const parts = [findingMarker(f), `**[${f.severity}] ${f.title}**`, "", f.body];
  if (f.suggestion) parts.push("", `**Suggestion:** ${f.suggestion}`);
  return parts.join("\n");
}

export type PostResult = {
  summaryCommentId: number;
  summaryUpdated: boolean;
  inlinePosted: number;
  inlineSuppressed: number;
};

// Post the review: one summary comment (created once, updated on re-review) plus
// inline comments for findings that carry a line. Keeps the issue-comment and
// review-comment API paths distinct (§6).
export async function postReview(
  target: ReviewTarget,
  review: ReviewResult,
  meta: PostMeta,
  injectedClient: Octokit,
  injectedStore: SummaryCommentStore = getSummaryCommentStore(),
): Promise<PostResult> {
  const { owner, repo, number } = target;
  const postNits = postNitsEnabled();
  const prKey = `${owner}/${repo}#${number}`;

  // Inline comments FIRST so we know whether they succeeded.
  const inlineCandidates = visibleFindings(review.findings, postNits).filter(
    (f) => f.line !== undefined,
  );
  let discussedFingerprints = new Set<string>();
  if (inlineCandidates.length > 0) {
    try {
      discussedFingerprints = existingFindingFingerprints(
        await fetchExistingReviewDiscussion(injectedClient, target),
      );
    } catch (err) {
      console.warn(
        "[mimir] failed to read existing review comments; duplicate suppression disabled:",
        String(err),
      );
    }
  }
  const inline = inlineCandidates.filter((f) => !discussedFingerprints.has(findingFingerprint(f)));
  const inlineSuppressed = inlineCandidates.length - inline.length;
  let inlinePosted = 0;
  let inlineFallback: Finding[] = [];
  if (inline.length > 0) {
    try {
      await injectedClient.rest.pulls.createReview({
        owner,
        repo,
        pull_number: number,
        commit_id: target.headSha,
        event: "COMMENT",
        comments: inline.map((f) => ({
          path: f.file,
          line: f.line as number,
          side: "RIGHT",
          body: inlineCommentBody(f),
        })),
      });
      inlinePosted = inline.length;
    } catch (err) {
      // GitHub 422s the whole review if a line isn't in the diff; forward the
      // findings into the summary so a critical one never silently vanishes.
      console.warn("[mimir] inline review failed; forwarding findings to summary:", String(err));
      inlineFallback = inline;
    }
  }

  const body = buildSummaryBody(review, meta, postNits, inlineFallback);

  // Summary comment: update the prior one (idempotent on synchronize) or create.
  const existing = await injectedStore.getSummaryCommentId(prKey);
  let summaryCommentId: number;
  let summaryUpdated = false;
  if (existing !== undefined) {
    try {
      await injectedClient.rest.issues.updateComment({ owner, repo, comment_id: existing, body });
      summaryCommentId = existing;
      summaryUpdated = true;
    } catch (err) {
      if ((err as { status?: number }).status !== 404) throw err;
      // Stored id is stale (comment was deleted); fall through to create a new one.
      const res = await injectedClient.rest.issues.createComment({
        owner,
        repo,
        issue_number: number,
        body,
      });
      summaryCommentId = res.data.id;
      await injectedStore.setSummaryCommentId(prKey, summaryCommentId);
      // summaryUpdated stays false: a new comment was created, not updated.
    }
  } else {
    const res = await injectedClient.rest.issues.createComment({
      owner,
      repo,
      issue_number: number,
      body,
    });
    summaryCommentId = res.data.id;
    await injectedStore.setSummaryCommentId(prKey, summaryCommentId);
  }

  return { summaryCommentId, summaryUpdated, inlinePosted, inlineSuppressed };
}

// Surface a review that threw before it could post. The primary/escalation pass
// can fail non-retryably (e.g. a model context-size overflow); without this the
// run dies after the webhook's 200 with nothing on the PR — a silent failure.
// Idempotent on its own `::failed` key so a re-run updates one notice, and stored
// separately from the summary so it never clobbers a prior good review.
export async function postReviewFailure(
  target: Pick<ReviewTarget, "owner" | "repo" | "number">,
  error: unknown,
  injectedClient: Octokit,
  injectedStore: SummaryCommentStore = getSummaryCommentStore(),
): Promise<void> {
  const { owner, repo, number } = target;
  const reason = (error instanceof Error ? error.message : String(error)).slice(0, 800);
  const body = [
    FAIL_MARKER,
    "## ⚠️ Mimir review failed",
    "",
    "The review didn't complete — usually a transient model/provider error or a context-size limit. Re-run with `/review`.",
    "",
    "<details><summary>Details</summary>",
    "",
    "```",
    reason,
    "```",
    "",
    "</details>",
  ].join("\n");

  const key = `${owner}/${repo}#${number}::failed`;
  const existing = await injectedStore.getSummaryCommentId(key);
  if (existing !== undefined) {
    try {
      await injectedClient.rest.issues.updateComment({ owner, repo, comment_id: existing, body });
      return;
    } catch (err) {
      if ((err as { status?: number }).status !== 404) throw err;
      // Stored id is stale (comment deleted); fall through to create a new one.
    }
  }
  const res = await injectedClient.rest.issues.createComment({ owner, repo, issue_number: number, body });
  await injectedStore.setSummaryCommentId(key, res.data.id);
}
