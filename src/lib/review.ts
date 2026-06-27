import * as v from "valibot";

// Structured output of a review pass. The shape is defined by the review-rubric
// skill (summary / verdict / confidence / findings); Flue validates the model's
// response against this valibot schema before the workflow receives it.
const SeveritySchema = v.picklist(["critical", "major", "minor", "nit"]);

export const ReviewResultSchema = v.object({
  // 1-3 sentence verdict, headline first.
  summary: v.string(),
  // Advisory only — the agent never approves/merges.
  verdict: v.picklist(["request_changes", "comment", "approve_suggestion"]),
  // Overall confidence; `low` triggers escalation (§5.3).
  confidence: v.picklist(["low", "medium", "high"]),
  findings: v.array(
    v.object({
      file: v.string(),
      // A line present in the diff; omitted for file-level findings.
      line: v.optional(v.number()),
      severity: SeveritySchema,
      title: v.string(),
      body: v.string(),
      suggestion: v.optional(v.string()),
    }),
  ),
});

export type ReviewResult = v.InferOutput<typeof ReviewResultSchema>;
export type Finding = ReviewResult["findings"][number];
export type Severity = Finding["severity"];
