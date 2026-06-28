// Types shared between the eval runner, judge, and report formatter.

export interface FixtureFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string;
}

export interface ExpectedFinding {
  // At least one keyword must appear (case-insensitive) in the finding's title or body.
  mustMatchKeywords: string[];
  severity: "critical" | "major" | "minor" | "nit";
  description: string;
}

export interface EvalFixture {
  id: string;
  name: string;
  files: FixtureFile[];
  changedLines: number;
  securitySensitive: boolean;
  expectedFindings: ExpectedFinding[];
}

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
