import { type FlueContext, type WorkflowRouteHandler, createAgent } from '@flue/runtime';
import { type PrDiff, fetchPrDiff } from '../lib/diff.ts';
import { client } from '../lib/github.ts';
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
}

// Primary reviewer. Model is env-configured (OpenRouter slug) so swapping it is
// a config change. Both skills are registered; the security one is applied only
// when the diff touches a sensitive surface.
const reviewer = createAgent(() => ({
  model: process.env.MODEL_PRIMARY ?? 'openrouter/z-ai/glm-5.2',
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

export async function run({ init, payload }: FlueContext<ReviewPayload>) {
  // 1. Fetch + chunk the diff (generated/vendored paths already filtered).
  const diff = await fetchPrDiff(client, payload);
  const securitySensitive = touchesSensitivePath(diff.files.map((f) => f.filename));

  // 2. Primary pass: apply review-rubric (+ security-check when sensitive) over
  //    the diff and return findings validated against the review schema.
  const harness = await init(reviewer);
  const session = await harness.session();

  const instruction = [
    'Review this pull-request diff. Apply the `review-rubric` skill to produce your findings.',
    securitySensitive
      ? 'This diff changes security-sensitive paths — also apply the `security-check` skill and merge its findings.'
      : null,
    `Pull request: ${payload.owner}/${payload.repo}#${payload.number} @ ${payload.headSha}`,
    '',
    renderDiff(diff),
  ]
    .filter((line): line is string => line !== null)
    .join('\n');

  const response = await session.prompt(instruction, { result: ReviewResultSchema });

  return {
    pr: payload,
    securitySensitive,
    stats: {
      reviewedFiles: diff.files.length,
      skipped: diff.skipped.length,
      totalChangedLines: diff.totalChangedLines,
      truncated: diff.truncated,
    },
    review: response.data,
  };
}

// Expose POST /workflows/review-pr — the admission boundary the channel calls
// to start a durable run (returns 202 { runId, ... }).
export const route: WorkflowRouteHandler = async (_c, next) => next();
