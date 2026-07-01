import assert from "node:assert/strict";
import { test } from "node:test";
import { SqliteDedupStore } from "./dedup.node.ts";

test("claim is idempotent: first wins, replay is rejected", async () => {
  const store = new SqliteDedupStore(":memory:");
  assert.equal(await store.claim("delivery-1"), true);
  assert.equal(await store.claim("delivery-1"), false); // replay
  assert.equal(await store.claim("delivery-2"), true); // distinct id
});

test("rejects non-sqlite DATABASE_URL schemes", () => {
  assert.throws(() => new SqliteDedupStore("postgres://localhost/db"), /sqlite only/);
  assert.throws(() => new SqliteDedupStore("redis://localhost:6379"), /sqlite only/);
});

test("release: claim → release → claim again returns true", async () => {
  const store = new SqliteDedupStore(":memory:");
  assert.equal(await store.claim("delivery-r1"), true);
  await store.release("delivery-r1");
  assert.equal(await store.claim("delivery-r1"), true); // re-claimable after release
});

test("release: no-op when id was never claimed", async () => {
  const store = new SqliteDedupStore(":memory:");
  await assert.doesNotReject(() => store.release("never-claimed"));
});

test("logReviewRun returns a run id and stores findings", async () => {
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
    {
      file: "src/a.ts",
      line: 10,
      severity: "critical" as const,
      title: "Null deref",
      body: "user could be null",
      suggestion: "Add null check",
    },
    {
      file: "src/b.ts",
      line: undefined,
      severity: "minor" as const,
      title: "Missing await",
      body: "Promise not awaited",
      suggestion: undefined,
    },
  ];
  const runId = await store.logReviewRun(base, findings);
  assert.ok(typeof runId === "number" && runId > 0);
  const stored = await store.getRunFindings(runId);
  assert.equal(stored.length, 2);
  assert.equal(stored[0]?.title, "Null deref");
  assert.equal(stored[0]?.line, 10);
  assert.equal(stored[1]?.line, null);
  assert.equal(stored[1]?.suggestion, null);
});

test("logReviewRun without findings stores run but no findings", async () => {
  const store = new SqliteDedupStore(":memory:");
  const runId = await store.logReviewRun({
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
  assert.deepEqual(await store.getRunFindings(runId), []);
});

test("summary comment id: absent, then create-once, then update", async () => {
  const store = new SqliteDedupStore(":memory:");
  const pr = "octo/repo#7";
  assert.equal(await store.getSummaryCommentId(pr), undefined); // first review -> create
  await store.setSummaryCommentId(pr, 111);
  assert.equal(await store.getSummaryCommentId(pr), 111); // synchronize -> update this id
  await store.setSummaryCommentId(pr, 222); // upsert overwrites
  assert.equal(await store.getSummaryCommentId(pr), 222);
  assert.equal(await store.getSummaryCommentId("octo/repo#8"), undefined); // distinct PR
});
