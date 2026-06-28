import assert from "node:assert/strict";
import { test } from "node:test";
import { SqliteDedupStore } from "./dedup.ts";

test("claim is idempotent: first wins, replay is rejected", () => {
  const store = new SqliteDedupStore(":memory:");
  assert.equal(store.claim("delivery-1"), true);
  assert.equal(store.claim("delivery-1"), false); // replay
  assert.equal(store.claim("delivery-2"), true); // distinct id
});

test("rejects non-sqlite DATABASE_URL schemes", () => {
  assert.throws(() => new SqliteDedupStore("postgres://localhost/db"), /sqlite only/);
  assert.throws(() => new SqliteDedupStore("redis://localhost:6379"), /sqlite only/);
});

test("release: claim → release → claim again returns true", () => {
  const store = new SqliteDedupStore(":memory:");
  assert.equal(store.claim("delivery-r1"), true);
  store.release("delivery-r1");
  assert.equal(store.claim("delivery-r1"), true); // re-claimable after release
});

test("release: no-op when id was never claimed", () => {
  const store = new SqliteDedupStore(":memory:");
  assert.doesNotThrow(() => store.release("never-claimed"));
});

test("logReviewRun returns a run id and stores findings", () => {
  const store = new SqliteDedupStore(":memory:");
  const base = {
    prKey: "org/repo#1",
    primaryModel: "gemini-flash",
    primaryTokens: 1000,
    primaryCostUsd: 0.001,
    escalationModel: null,
    escalationTokens: null,
    escalationCostUsd: null,
    fileCount: 2,
    changedLines: 50,
    truncated: 0,
    securitySensitive: 0,
    escalated: 0,
    escalationReasons: "",
  };
  const findings = [
    { file: "src/a.ts", line: 10, severity: "critical" as const, title: "Null deref", body: "user could be null", suggestion: "Add null check" },
    { file: "src/b.ts", line: undefined, severity: "minor" as const, title: "Missing await", body: "Promise not awaited", suggestion: undefined },
  ];
  const runId = store.logReviewRun(base, findings);
  assert.ok(typeof runId === "number" && runId > 0);
  const stored = store.getRunFindings(runId);
  assert.equal(stored.length, 2);
  assert.equal(stored[0]?.title, "Null deref");
  assert.equal(stored[0]?.line, 10);
  assert.equal(stored[1]?.line, null);
  assert.equal(stored[1]?.suggestion, null);
});

test("logReviewRun without findings stores run but no findings", () => {
  const store = new SqliteDedupStore(":memory:");
  const runId = store.logReviewRun({
    prKey: "org/repo#2",
    primaryModel: "gemini-flash",
    primaryTokens: 500,
    primaryCostUsd: 0.0005,
    escalationModel: null,
    escalationTokens: null,
    escalationCostUsd: null,
    fileCount: 1,
    changedLines: 20,
    truncated: 0,
    securitySensitive: 0,
    escalated: 0,
    escalationReasons: "",
  });
  assert.ok(runId > 0);
  assert.deepEqual(store.getRunFindings(runId), []);
});

test("summary comment id: absent, then create-once, then update", () => {
  const store = new SqliteDedupStore(":memory:");
  const pr = "octo/repo#7";
  assert.equal(store.getSummaryCommentId(pr), undefined); // first review -> create
  store.setSummaryCommentId(pr, 111);
  assert.equal(store.getSummaryCommentId(pr), 111); // synchronize -> update this id
  store.setSummaryCommentId(pr, 222); // upsert overwrites
  assert.equal(store.getSummaryCommentId(pr), 222);
  assert.equal(store.getSummaryCommentId("octo/repo#8"), undefined); // distinct PR
});
