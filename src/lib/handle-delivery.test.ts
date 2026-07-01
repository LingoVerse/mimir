import assert from "node:assert/strict";
import { test } from "node:test";
import { handlePullRequestDelivery } from "./handle-delivery.ts";
import type { ReviewPayload } from "./instruction.ts";

const PR: ReviewPayload = {
  owner: "test-owner",
  repo: "test-repo",
  number: 42,
  headSha: "abc1234",
  baseRef: "main",
};

test("admit succeeds: claim kept, admit called once, returns true", async () => {
  let claimCalls = 0;
  let releaseCalls = 0;
  let admitCalls = 0;
  const deps = {
    claim: async (_id: string) => {
      claimCalls++;
      return true;
    },
    release: async (_id: string) => {
      releaseCalls++;
    },
    admit: async (_pr: ReviewPayload) => {
      admitCalls++;
    },
  };
  const result = await handlePullRequestDelivery(deps, "del-1", PR);
  assert.equal(result, true);
  assert.equal(claimCalls, 1);
  assert.equal(admitCalls, 1);
  assert.equal(releaseCalls, 0);
});

test("admit throws: claim released and error re-thrown", async () => {
  let releaseCalls = 0;
  let releasedId = "";
  const deps = {
    claim: async (_id: string) => true,
    release: async (id: string) => {
      releaseCalls++;
      releasedId = id;
    },
    admit: async (_pr: ReviewPayload) => {
      throw new Error("admit failed");
    },
  };
  await assert.rejects(() => handlePullRequestDelivery(deps, "del-2", PR), /admit failed/);
  assert.equal(releaseCalls, 1);
  assert.equal(releasedId, "del-2");
});

test("duplicate delivery: admit NOT called, returns false", async () => {
  let admitCalls = 0;
  const deps = {
    claim: async (_id: string) => false,
    release: async (_id: string) => {},
    admit: async (_pr: ReviewPayload) => {
      admitCalls++;
    },
  };
  const result = await handlePullRequestDelivery(deps, "del-3", PR);
  assert.equal(result, false);
  assert.equal(admitCalls, 0);
});
