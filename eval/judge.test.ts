import assert from "node:assert/strict";
import { test } from "node:test";

test("computePrecision: all approved", async () => {
  const { computePrecision } = await import("./judge.ts");
  const scores = [
    { findingIndex: 0, score: 4, reason: "good" },
    { findingIndex: 1, score: 5, reason: "excellent" },
  ];
  assert.equal(computePrecision(scores, 2), 1);
});

test("computePrecision: some rejected", async () => {
  const { computePrecision } = await import("./judge.ts");
  const scores = [
    { findingIndex: 0, score: 5, reason: "good" },
    { findingIndex: 1, score: 1, reason: "wrong" },
    { findingIndex: 2, score: 3, reason: "ok" },
  ];
  assert.equal(computePrecision(scores, 3), 2 / 3);
});

test("computePrecision: no findings returns 1", async () => {
  const { computePrecision } = await import("./judge.ts");
  assert.equal(computePrecision([], 0), 1);
});

test("computePrecision: unscored findings returns NaN", async () => {
  const { computePrecision } = await import("./judge.ts");
  assert.ok(Number.isNaN(computePrecision([], 5)));
});

test("computePrecision: score threshold boundary (3 = approved)", async () => {
  const { computePrecision } = await import("./judge.ts");
  const scores = [
    { findingIndex: 0, score: 3, reason: "ok" },
    { findingIndex: 1, score: 2, reason: "vague" },
  ];
  assert.equal(computePrecision(scores, 2), 0.5);
});
