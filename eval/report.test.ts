import assert from "node:assert/strict";
import { test } from "node:test";
import type { EvalResult } from "./types.ts";

function makeResult(overrides: Partial<EvalResult> = {}): EvalResult {
  return {
    fixtureId: "001",
    fixtureName: "Null dereference",
    model: "openrouter/google/gemini-3-flash-preview",
    escalated: false,
    precision: 1,
    recall: 1,
    avgRelevance: 4.5,
    findingCount: 2,
    durationMs: 12345,
    judgeScores: [
      { findingIndex: 0, score: 4, reason: "good" },
      { findingIndex: 1, score: 5, reason: "excellent" },
    ],
    ...overrides,
  };
}

test("renderReport: single result", async () => {
  const { renderReport } = await import("./report.ts");
  const result = makeResult();
  const output = renderReport([result]);
  assert.ok(output.includes("001 Null dereference"));
  assert.ok(output.includes("gemini-3-flash-preview"));
  assert.ok(output.includes("100%")); // precision + recall
  assert.ok(output.includes("4.5")); // avg relevance
  assert.ok(output.includes("12345")); // duration
});

test("renderReport: multiple results with averages", async () => {
  const { renderReport } = await import("./report.ts");
  const results = [
    makeResult({
      fixtureId: "001",
      fixtureName: "Null",
      precision: 1,
      recall: 0.5,
      avgRelevance: 4,
    }),
    makeResult({
      fixtureId: "002",
      fixtureName: "Missing await",
      precision: 0.75,
      recall: 1,
      avgRelevance: 3,
    }),
  ];
  const output = renderReport(results);
  assert.ok(output.includes("001 Null"));
  assert.ok(output.includes("002 Missing await"));
  assert.ok(output.includes("Averages across 2 fixtures"));
  assert.ok(output.includes("88%")); // avg precision (1 + 0.75) / 2 = 0.875 → 88%
});

test("renderReport: noJudge run (NaN values)", async () => {
  const { renderReport } = await import("./report.ts");
  const result = makeResult({ precision: NaN, avgRelevance: NaN, judgeScores: [] });
  const output = renderReport([result]);
  assert.ok(output.includes("—")); // NaN displayed as em dash
});

test("renderReport: empty results", async () => {
  const { renderReport } = await import("./report.ts");
  assert.equal(renderReport([]), "No results.");
});

test("renderReport: modelShort strips prefix correctly", async () => {
  const { renderReport } = await import("./report.ts");
  const withPrefix = makeResult({ model: "openrouter/anthropic/claude-4" });
  const output = renderReport([withPrefix]);
  // Should strip both "openrouter/" and org prefix → just "claude-4"
  assert.ok(output.includes("claude-4"));
  assert.ok(!output.includes("openrouter/"));
  assert.ok(!output.includes("anthropic/"));
});

test("renderReport: model without prefix", async () => {
  const { renderReport } = await import("./report.ts");
  const noPrefix = makeResult({ model: "gpt-4o" });
  const output = renderReport([noPrefix]);
  assert.ok(output.includes("gpt-4o"));
});
