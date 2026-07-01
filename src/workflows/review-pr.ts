import { type ActionContext, defineAgent, defineWorkflow } from "@flue/runtime";
import { fetchPrDiff } from "../lib/diff.ts";
import { decideEscalation } from "../lib/escalation.ts";
import { client } from "../lib/github.ts";
import { fetchIgnoreMatcher } from "../lib/ignore.ts";
import { ReviewPayloadSchema, buildInstruction } from "../lib/instruction.ts";
import { getReviewRunStore } from "../lib/dedup.ts";
import { logEvent } from "../lib/log.ts";
import { postReview } from "../lib/post-review.ts";
import { fetchProjectContext, fetchProjectTree } from "../lib/project-context.ts";
import { repoContextTools } from "../lib/repo-tools.ts";
import { withRetry } from "../lib/retry.ts";
import { ReviewResultSchema } from "../lib/review.ts";
import { listSensitiveFiles, touchesSensitivePath } from "../lib/security-paths.ts";
import reviewRubric from "../skills/review-rubric/SKILL.md" with { type: "skill" };
import securityCheck from "../skills/security-check/SKILL.md" with { type: "skill" };

// PR coordinates passed by the GitHub channel when it admits a review run.
// Defined in ../lib/instruction.ts (with buildInstruction); re-exported here for
// existing importers (the github channel).
export type { ReviewPayload } from "../lib/instruction.ts";

// Env-configured model tiers (OpenRouter slugs) so swapping is a config change.
const PRIMARY_MODEL = process.env.MODEL_PRIMARY ?? "openrouter/google/gemini-3-flash-preview";
const ESCALATION_MODEL = process.env.MODEL_ESCALATION ?? "openrouter/z-ai/glm-5.2";

// Primary reviewer. Both skills are registered; the security one is applied only
// when the diff touches a sensitive surface.
const reviewer = defineAgent(() => ({
  model: PRIMARY_MODEL,
  skills: [reviewRubric, securityCheck],
}));

async function run({ harness, log, input: payload }: ActionContext<typeof ReviewPayloadSchema>) {
  // 1. Fetch the diff + the project's own conventions/memory (from the base ref).
  //    `.mimirignore` (read from the trusted base ref) drops project-declared
  //    generated paths from the diff before review.
  const ignore = await fetchIgnoreMatcher(client, {
    owner: payload.owner,
    repo: payload.repo,
    ref: payload.baseRef,
  });
  const diff = await fetchPrDiff(client, payload, { ignore });
  const filenames = diff.files.map((f) => f.filename);
  const securitySensitive = touchesSensitivePath(filenames);
  const sensitiveFiles = listSensitiveFiles(filenames);
  // Read-only repo tools scoped to the PR head, so the model can pull related
  // code the diff omits. Each pass gets its OWN instance: the call budget lives
  // in the closure (repo-tools.ts), so a shared instance would let the primary
  // pass starve the escalation pass of context reads. The escalation tools are
  // built lazily below, only when we actually escalate.
  const toolRef = { owner: payload.owner, repo: payload.repo, ref: payload.headSha };

  const projectContext = await fetchProjectContext(client, {
    owner: payload.owner,
    repo: payload.repo,
    ref: payload.baseRef,
  });
  const projectTree = await fetchProjectTree(client, toolRef);
  const instruction = buildInstruction(payload, diff, securitySensitive, projectContext, {
    projectTree,
  });
  const tools = repoContextTools(client, toolRef, diff.files.length);

  // 2. Primary pass on MODEL_PRIMARY.
  const session = await harness.session();
  const primaryResult = await withRetry(() =>
    session.prompt(instruction, { result: ReviewResultSchema, tools }),
  );
  const primary = primaryResult.data;

  // 3. Escalation decision (§5). Logged for cost/escalation-rate observability.
  const decision = decideEscalation({
    totalChangedLines: diff.totalChangedLines,
    securitySensitive,
    review: primary,
    sensitiveFiles,
  });
  logEvent(log, "escalation decision", {
    escalate: decision.escalate,
    reasons: decision.reasons,
    model: decision.escalate ? ESCALATION_MODEL : PRIMARY_MODEL,
    totalChangedLines: diff.totalChangedLines,
    confidence: primary.confidence,
    criticalFindings: primary.findings.filter((f) => f.severity === "critical").length,
  });

  // 4. If escalating, re-review the whole diff on MODEL_ESCALATION (independent
  //    session) and let the stronger result replace the primary one — this also
  //    double-checks critical claims to cut false positives (§5.4).
  let review = primary;
  let escalationResult: typeof primaryResult | null = null;
  if (decision.escalate) {
    const escalationInstruction = buildInstruction(
      payload,
      diff,
      securitySensitive,
      projectContext,
      {
        projectTree,
        scopeFiles: decision.scopeFiles,
        priorReview: {
          summary: primary.summary,
          findings: primary.findings,
        },
      },
    );
    const escalationSession = await harness.session("escalation");
    escalationResult = await withRetry(() =>
      escalationSession.prompt(escalationInstruction, {
        result: ReviewResultSchema,
        model: ESCALATION_MODEL,
        tools: repoContextTools(client, toolRef, diff.files.length),
      }),
    );
    review = escalationResult.data;
  }

  // 5. Post: one summary comment (updated on re-review) + inline comments.
  //    The cost summary is rendered as a footer so spend is visible on the PR.
  const cost = {
    totalUsd: primaryResult.usage.cost.total + (escalationResult?.usage.cost.total ?? 0),
    primaryModel: primaryResult.model.id,
    primaryUsd: primaryResult.usage.cost.total,
    escalationModel: escalationResult?.model.id ?? null,
    escalationUsd: escalationResult?.usage.cost.total ?? null,
  };
  const posted = await postReview(payload, review, {
    escalated: decision.escalate,
    reasons: decision.reasons,
    truncatedOmitted: diff.truncated?.omitted.length,
    cost,
  });
  logEvent(log, "review cost", {
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
  logEvent(log, "review posted", {
    summaryCommentId: posted.summaryCommentId,
    summaryUpdated: posted.summaryUpdated,
    inlinePosted: posted.inlinePosted,
  });

  // Store review run stats for the admin endpoint.
  // When escalated, `review` comes from the escalation model; log that model as
  // primary so the recorded tokens/cost match the origin of the stored findings.
  // The `escalated` flag still records that secondary review happened.
  try {
    const finalModel = decision.escalate ? escalationResult!.model.id : primaryResult.model.id;
    const finalTokens = decision.escalate
      ? escalationResult!.usage.input + escalationResult!.usage.output
      : primaryResult.usage.input + primaryResult.usage.output;
    const finalCostUsd = decision.escalate
      ? escalationResult!.usage.cost.total
      : primaryResult.usage.cost.total;
    const discardModel = decision.escalate ? primaryResult.model.id : null;
    const discardTokens = decision.escalate
      ? primaryResult.usage.input + primaryResult.usage.output
      : null;
    const discardCostUsd = decision.escalate ? primaryResult.usage.cost.total : null;

    getReviewRunStore().logReviewRun(
      {
        prKey: `${payload.owner}/${payload.repo}#${payload.number}`,
        primaryModel: finalModel,
        primaryTokens: finalTokens,
        primaryCostUsd: finalCostUsd,
        escalationModel: discardModel,
        escalationTokens: discardTokens,
        escalationCostUsd: discardCostUsd,
        fileCount: diff.files.length,
        changedLines: diff.totalChangedLines,
        truncated: diff.truncated?.omitted.length ?? 0,
        securitySensitive: securitySensitive ? 1 : 0,
        escalated: decision.escalate ? 1 : 0,
        escalationReasons: decision.reasons.join(", "),
      },
      review.findings,
    );
  } catch (err) {
    logEvent(log, "logReviewRun failed", { error: String(err) });
  }

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

// No `route` export: the workflow is admitted only via ambient `invoke()` from
// the GitHub channel (no public POST endpoint).
export default defineWorkflow({
  agent: reviewer,
  input: ReviewPayloadSchema,
  run,
});
