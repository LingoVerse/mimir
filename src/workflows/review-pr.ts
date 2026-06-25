import { type FlueContext, type WorkflowRouteHandler, createAgent } from '@flue/runtime';
import { type PrDiff, fetchPrDiff } from '../lib/diff.ts';
import { decideEscalation } from '../lib/escalation.ts';
import { client } from '../lib/github.ts';
import { postReview } from '../lib/post-review.ts';
import { fetchProjectContext } from '../lib/project-context.ts';
import { repoContextTools } from '../lib/repo-tools.ts';
import { ReviewResultSchema } from '../lib/review.ts';
import { touchesSensitivePath } from '../lib/security-paths.ts';
import reviewRubric from '../skills/review-rubric/SKILL.md' with { type: 'skill' };
import securityCheck from '../skills/security-check/SKILL.md' with { type: 'skill' };

// PR coordinates passed by the GitHub channel when it admits a review run
// (resolved from the webhook payload, not re-fetched).
export interface ReviewPayload {
  owner: string;
  repo: string;
  number: number;
  headSha: string;
  // Base branch — project context (conventions/memory) is read from here (trusted).
  baseRef: string;
}

// Env-configured model tiers (OpenRouter slugs) so swapping is a config change.
const PRIMARY_MODEL = process.env.MODEL_PRIMARY ?? 'openrouter/z-ai/glm-5.2';
const ESCALATION_MODEL = process.env.MODEL_ESCALATION ?? 'openrouter/google/gemini-flash-3';

// Primary reviewer. Both skills are registered; the security one is applied only
// when the diff touches a sensitive surface.
const reviewer = createAgent(() => ({
  model: PRIMARY_MODEL,
  skills: [reviewRubric, securityCheck],
}));

// Render the chunked diff as a single text block for the model.
function renderDiff(diff: PrDiff): string {
  const parts = diff.files.map((f) => {
    const rename = f.previousFilename ? ` (was ${f.previousFilename})` : '';
    const header = `### ${f.filename}${rename} — ${f.status}, +${f.additions} -${f.deletions}`;
    return f.patch ? `${header}\n\n${f.patch}` : `${header}\n\n(no textual patch: binary or too large)`;
  });
  if (diff.truncated) {
    parts.push(
      `\n_Diff truncated to fit the token budget; ${diff.truncated.omitted.length} lower-impact file(s) omitted: ${diff.truncated.omitted.join(', ')}._`,
    );
  }
  return parts.join('\n\n');
}

// Shared instruction for both the primary and escalation passes (same rubric,
// different model). The skills enforce restraint, so the prompt only frames it.
function buildInstruction(
  payload: ReviewPayload,
  diff: PrDiff,
  securitySensitive: boolean,
  projectContext: string,
): string {
  return [
    'Review this pull-request diff. Apply the `review-rubric` skill to produce your findings.',
    securitySensitive
      ? 'This diff changes security-sensitive paths — also apply the `security-check` skill and merge its findings.'
      : null,
    'You may call `read_repo_file`, `list_repo_dir`, and `search_repo` to pull in code the diff does not show (callers, schemas, related modules) — use them only when a finding depends on context outside the diff.',
    projectContext
      ? `\n## Project context — the project's own conventions/memory; honour these\n${projectContext}`
      : null,
    `\nPull request: ${payload.owner}/${payload.repo}#${payload.number} @ ${payload.headSha}`,
    '',
    renderDiff(diff),
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

export async function run({ init, log, payload }: FlueContext<ReviewPayload>) {
  // 1. Fetch the diff + the project's own conventions/memory (from the base ref).
  const diff = await fetchPrDiff(client, payload);
  const securitySensitive = touchesSensitivePath(diff.files.map((f) => f.filename));
  const projectContext = await fetchProjectContext(client, {
    owner: payload.owner,
    repo: payload.repo,
    ref: payload.baseRef,
  });
  const instruction = buildInstruction(payload, diff, securitySensitive, projectContext);

  // Read-only repo tools scoped to the PR head, so the model can pull related
  // code the diff omits. Available to both passes.
  const tools = repoContextTools(client, {
    owner: payload.owner,
    repo: payload.repo,
    ref: payload.headSha,
  });

  // 2. Primary pass on MODEL_PRIMARY.
  const harness = await init(reviewer);
  const primaryResult = await (await harness.session()).prompt(instruction, { result: ReviewResultSchema, tools });
  const primary = primaryResult.data;

  // 3. Escalation decision (§5). Logged for cost/escalation-rate observability.
  const decision = decideEscalation({
    totalChangedLines: diff.totalChangedLines,
    securitySensitive,
    review: primary,
  });
  log.info('escalation decision', {
    escalate: decision.escalate,
    reasons: decision.reasons,
    model: decision.escalate ? ESCALATION_MODEL : PRIMARY_MODEL,
    totalChangedLines: diff.totalChangedLines,
    confidence: primary.confidence,
    criticalFindings: primary.findings.filter((f) => f.severity === 'critical').length,
  });

  // 4. If escalating, re-review the whole diff on MODEL_ESCALATION (independent
  //    session) and let the stronger result replace the primary one — this also
  //    double-checks critical claims to cut false positives (§5.4).
  let review = primary;
  let escalationResult: typeof primaryResult | null = null;
  if (decision.escalate) {
    const escalationSession = await harness.session('escalation');
    escalationResult = await escalationSession.prompt(instruction, {
      result: ReviewResultSchema,
      model: ESCALATION_MODEL,
      tools,
    });
    review = escalationResult.data;
  }

  // 5. Post: one summary comment (updated on re-review) + inline comments.
  const posted = await postReview(payload, review, {
    escalated: decision.escalate,
    reasons: decision.reasons,
    truncatedOmitted: diff.truncated?.omitted.length,
  });
  log.info('review cost', {
    primaryModel: primaryResult.model.id,
    primaryInputTokens: primaryResult.usage.input,
    primaryOutputTokens: primaryResult.usage.output,
    primaryCostUsd: primaryResult.usage.cost.total,
    escalated: decision.escalate,
    escalationModel: escalationResult?.model.id ?? null,
    escalationInputTokens: escalationResult?.usage.input ?? null,
    escalationOutputTokens: escalationResult?.usage.output ?? null,
    escalationCostUsd: escalationResult?.usage.cost.total ?? null,
    totalTokens: primaryResult.usage.totalTokens + (escalationResult?.usage.totalTokens ?? 0),
    totalCostUsd: primaryResult.usage.cost.total + (escalationResult?.usage.cost.total ?? 0),
  });
  log.info('review posted', {
    summaryCommentId: posted.summaryCommentId,
    summaryUpdated: posted.summaryUpdated,
    inlinePosted: posted.inlinePosted,
  });

  return {
    pr: payload,
    securitySensitive,
    escalation: { escalated: decision.escalate, reasons: decision.reasons },
    stats: {
      reviewedFiles: diff.files.length,
      skipped: diff.skipped.length,
      totalChangedLines: diff.totalChangedLines,
      truncated: diff.truncated,
    },
    posted,
    review,
  };
}

// Expose POST /workflows/review-pr — the admission boundary the channel calls
// to start a durable run (returns 202 { runId, ... }).
export const route: WorkflowRouteHandler = async (_c, next) => next();
