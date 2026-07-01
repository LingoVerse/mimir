import assert from "node:assert/strict";
import { test } from "node:test";
import { ReviewResultSchema } from "../src/lib/review.ts";
import * as v from "valibot";

function makeReview(
  findings: v.InferOutput<typeof ReviewResultSchema>["findings"],
): v.InferOutput<typeof ReviewResultSchema> {
  return { summary: "test", verdict: "comment", confidence: "high", findings };
}

function makeFixture(
  overrides: Partial<{
    expectedFindings: Array<{
      mustMatchKeywords: string[];
      severity: "critical" | "major" | "minor" | "nit";
      description: string;
    }>;
    securitySensitive: boolean;
  }> = {},
): Parameters<typeof import("./runner.ts").computeRecall>[0] {
  return {
    id: "test",
    name: "test",
    files: [],
    changedLines: 0,
    securitySensitive: overrides.securitySensitive ?? false,
    expectedFindings: overrides.expectedFindings ?? [],
  } as Parameters<typeof import("./runner.ts").computeRecall>[0];
}

test("computeRecall: all expected findings caught", async () => {
  const { computeRecall } = await import("./runner.ts");
  const fixture = makeFixture({
    expectedFindings: [
      { mustMatchKeywords: ["null", "undefined"], severity: "critical", description: "null deref" },
      { mustMatchKeywords: ["await", "promise"], severity: "minor", description: "missing await" },
    ],
  });
  const review = makeReview([
    {
      file: "a.ts",
      line: 10,
      severity: "critical",
      title: "Null dereference",
      body: "user could be null here",
    },
    { file: "b.ts", severity: "minor", title: "Missing await", body: "promise not awaited" },
  ]);
  assert.equal(computeRecall(fixture, review), 1);
});

test("computeRecall: partial catch", async () => {
  const { computeRecall } = await import("./runner.ts");
  const fixture = makeFixture({
    expectedFindings: [
      { mustMatchKeywords: ["null", "undefined"], severity: "critical", description: "null" },
      {
        mustMatchKeywords: ["sql", "injection"],
        severity: "critical",
        description: "sql injection",
      },
      { mustMatchKeywords: ["secret", "hardcoded"], severity: "critical", description: "secret" },
    ],
  });
  const review = makeReview([
    {
      file: "a.ts",
      line: 10,
      severity: "critical",
      title: "Null dereference",
      body: "possible null",
    },
    { file: "b.ts", severity: "major", title: "Hardcoded secret", body: "key is in plaintext" },
  ]);
  // Caught: null, secret (2/3)
  assert.equal(computeRecall(fixture, review), 2 / 3);
});

test("computeRecall: no expected findings returns 1", async () => {
  const { computeRecall } = await import("./runner.ts");
  const fixture = makeFixture({ expectedFindings: [] });
  const review = makeReview([]);
  assert.equal(computeRecall(fixture, review), 1);
});

test("computeRecall: no generated findings returns 0", async () => {
  const { computeRecall } = await import("./runner.ts");
  const fixture = makeFixture({
    expectedFindings: [{ mustMatchKeywords: ["null"], severity: "critical", description: "null" }],
  });
  const review = makeReview([]);
  assert.equal(computeRecall(fixture, review), 0);
});

test("computeRecall: negation doesn't fool keyword match (documented caveat)", async () => {
  const { computeRecall } = await import("./runner.ts");
  const fixture = makeFixture({
    expectedFindings: [{ mustMatchKeywords: ["null"], severity: "critical", description: "null" }],
  });
  // Model says "not a null issue" — keyword matcher still counts it as caught.
  const review = makeReview([
    {
      file: "a.ts",
      line: 10,
      severity: "nit",
      title: "Not a null problem",
      body: "this is not null related",
    },
  ]);
  assert.equal(computeRecall(fixture, review), 1);
});
