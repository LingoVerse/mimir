import { type SummaryCommentStore, getSummaryCommentStore } from './dedup.ts';
import { client } from './github.ts';
import type { Finding, ReviewResult, Severity } from './review.ts';

// PR coordinates needed to post. `headSha` is the commit inline comments attach to.
export interface ReviewTarget {
  owner: string;
  repo: string;
  number: number;
  headSha: string;
}

export interface PostMeta {
  escalated: boolean;
  reasons: string[];
  // Number of files dropped by the diff token budget, if any.
  truncatedOmitted?: number;
}

// Hidden marker on our summary comment (fallback identity if the stored id is lost).
const MARKER = '<!-- mimir-summary -->';

const VERDICT_LABEL: Record<ReviewResult['verdict'], string> = {
  request_changes: '🔴 Changes requested',
  comment: '🟡 Comments',
  approve_suggestion: '🟢 No blocking issues',
};

function postNitsEnabled(): boolean {
  return process.env.POST_NITS === 'true';
}

// Findings worth surfacing: nits are suppressed unless POST_NITS=true.
export function visibleFindings(findings: Finding[], postNits = postNitsEnabled()): Finding[] {
  return findings.filter((f) => postNits || f.severity !== 'nit');
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
): string {
  const counts = countBySeverity(review.findings);
  const nitNote = !postNits && counts.nit > 0 ? ' _(suppressed)_' : '';
  const countLine = `**Findings:** ${counts.critical} critical · ${counts.major} major · ${counts.minor} minor · ${counts.nit} nit${nitNote}`;

  const lines = [MARKER, `## Mimir review — ${VERDICT_LABEL[review.verdict]}`, '', review.summary, '', countLine];

  if (meta.escalated) {
    lines.push(`> Escalated to the stronger model (${meta.reasons.join(', ')}).`);
  }
  if (meta.truncatedOmitted && meta.truncatedOmitted > 0) {
    lines.push(`> Diff truncated to fit the token budget; ${meta.truncatedOmitted} file(s) not reviewed.`);
  }

  // File-level findings (no line) can't be inline — list them here.
  const general = visibleFindings(review.findings, postNits).filter((f) => f.line === undefined);
  if (general.length > 0) {
    lines.push('', '### General findings');
    for (const f of general) {
      lines.push(`- **[${f.severity}] ${f.title}** (\`${f.file}\`) — ${f.body}`);
    }
  }

  return lines.join('\n');
}

function inlineCommentBody(f: Finding): string {
  const parts = [`**[${f.severity}] ${f.title}**`, '', f.body];
  if (f.suggestion) parts.push('', `**Suggestion:** ${f.suggestion}`);
  return parts.join('\n');
}

export interface PostResult {
  summaryCommentId: number;
  summaryUpdated: boolean;
  inlinePosted: number;
}

// Post the review: one summary comment (created once, updated on re-review) plus
// inline comments for findings that carry a line. Keeps the issue-comment and
// review-comment API paths distinct (§6).
export async function postReview(
  target: ReviewTarget,
  review: ReviewResult,
  meta: PostMeta,
  injectedClient = client,
  injectedStore: SummaryCommentStore = getSummaryCommentStore(),
): Promise<PostResult> {
  const { owner, repo, number } = target;
  const postNits = postNitsEnabled();
  const prKey = `${owner}/${repo}#${number}`;
  const body = buildSummaryBody(review, meta, postNits);

  // Summary comment: update the prior one (idempotent on synchronize) or create.
  const existing = injectedStore.getSummaryCommentId(prKey);
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
      injectedStore.setSummaryCommentId(prKey, summaryCommentId);
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
    injectedStore.setSummaryCommentId(prKey, summaryCommentId);
  }

  // Inline comments: findings that carry a diff line, via the PR review API.
  const inline = visibleFindings(review.findings, postNits).filter((f) => f.line !== undefined);
  let inlinePosted = 0;
  if (inline.length > 0) {
    try {
      await injectedClient.rest.pulls.createReview({
        owner,
        repo,
        pull_number: number,
        commit_id: target.headSha,
        event: 'COMMENT',
        comments: inline.map((f) => ({
          path: f.file,
          line: f.line as number,
          side: 'RIGHT',
          body: inlineCommentBody(f),
        })),
      });
      inlinePosted = inline.length;
    } catch (err) {
      // GitHub 422s the whole review if a line isn't in the diff; the summary
      // (with counts) still posts, so degrade rather than fail the run.
      console.warn('[mimir] inline review failed; findings remain in summary:', String(err));
    }
  }

  return { summaryCommentId, summaryUpdated, inlinePosted };
}
