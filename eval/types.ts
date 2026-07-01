// Types shared between the eval runner, judge, and report formatter.

import * as v from "valibot";

const FixtureFileSchema = v.object({
  filename: v.string(),
  status: v.string(),
  additions: v.number(),
  deletions: v.number(),
  patch: v.string(),
});

const ExpectedFindingSchema = v.object({
  // At least one keyword must appear (case-insensitive) in the finding's title or body.
  mustMatchKeywords: v.array(v.string()),
  severity: v.picklist(["critical", "major", "minor", "nit"]),
  description: v.string(),
});

export const EvalFixtureSchema = v.object({
  id: v.string(),
  name: v.string(),
  files: v.array(FixtureFileSchema),
  changedLines: v.number(),
  securitySensitive: v.boolean(),
  expectedFindings: v.array(ExpectedFindingSchema),
});

export type FixtureFile = v.InferOutput<typeof FixtureFileSchema>;
export type ExpectedFinding = v.InferOutput<typeof ExpectedFindingSchema>;
export type EvalFixture = v.InferOutput<typeof EvalFixtureSchema>;

export interface JudgeScore {
  findingIndex: number;
  score: number; // 1-5
  reason: string;
}

export interface EvalResult {
  fixtureId: string;
  fixtureName: string;
  model: string;
  escalated: boolean;
  precision: number; // judge-approved / total generated
  recall: number; // expected caught / total expected
  avgRelevance: number; // mean judge score across all findings
  findingCount: number;
  durationMs: number;
  judgeScores: JudgeScore[];
}
