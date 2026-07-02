import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSummaryBody, postReview, postReviewFailure, visibleFindings } from "./post-review.ts";
import { SqliteDedupStore } from "./dedup.node.ts";
import { findingMarker } from "./pr-discussion.ts";
import type { Finding, ReviewResult } from "./review.ts";

const findings: Finding[] = [
  { file: "a.ts", line: 10, severity: "critical", title: "C", body: "bc" },
  { file: "b.ts", line: 20, severity: "major", title: "M", body: "bm" },
  { file: "c.ts", severity: "minor", title: "General", body: "bg" }, // no line
  { file: "d.ts", line: 5, severity: "nit", title: "N", body: "bn" },
];

function review(over: Partial<ReviewResult> = {}): ReviewResult {
  return { summary: "s", verdict: "comment", confidence: "high", findings, ...over };
}

test("visibleFindings suppresses nits by default, keeps them when enabled", () => {
  assert.deepEqual(
    visibleFindings(findings, false).map((f) => f.severity),
    ["critical", "major", "minor"],
  );
  assert.equal(visibleFindings(findings, true).length, 4);
});

test("summary body: counts, marker, suppressed-nit note, general findings", () => {
  const body = buildSummaryBody(review(), { escalated: false, reasons: [] }, false);
  assert.match(body, /<!-- mimir-summary -->/);
  assert.match(body, /1 critical · 1 major · 1 minor · 1 nit _\(suppressed\)_/);
  // line-less finding is listed under General findings; inline ones are not.
  assert.match(body, /### General findings/);
  assert.match(body, /\*\*\[minor\] General\*\* \(`c\.ts`\)/);
  assert.doesNotMatch(body, /\[critical\] C/); // inline finding stays inline
});

test("summary body: escalation + truncation notes", () => {
  const body = buildSummaryBody(
    review({ verdict: "request_changes" }),
    { escalated: true, reasons: ["critical-finding"], truncatedOmitted: 2 },
    false,
  );
  assert.match(body, /Changes requested/);
  assert.match(body, /Escalated to the stronger model \(critical-finding\)/);
  assert.match(body, /2 file\(s\) not reviewed/);
});

test("summary body: cost footer with escalation", () => {
  const body = buildSummaryBody(
    review(),
    {
      escalated: true,
      reasons: ["security"],
      cost: {
        totalUsd: 0.25,
        primaryModel: "google/gemini-3-flash-preview",
        primaryUsd: 0.01,
        escalationModel: "z-ai/glm-5.2",
        escalationUsd: 0.24,
      },
    },
    false,
  );
  assert.match(body, /💰 Review cost: \*\*\$0\.2500\*\*/);
  assert.match(body, /primary `google\/gemini-3-flash-preview` \$0\.0100/);
  assert.match(body, /escalation `z-ai\/glm-5\.2` \$0\.2400/);
});

test("summary body: cost footer omits escalation segment when not escalated", () => {
  const body = buildSummaryBody(
    review(),
    {
      escalated: false,
      reasons: [],
      cost: {
        totalUsd: 0.01,
        primaryModel: "google/gemini-3-flash-preview",
        primaryUsd: 0.01,
        escalationModel: null,
        escalationUsd: null,
      },
    },
    false,
  );
  assert.match(body, /💰 Review cost: \*\*\$0\.0100\*\*/);
  assert.doesNotMatch(body, /escalation/);
});

function makeReview(): import("./review.ts").ReviewResult {
  return { summary: "s", verdict: "comment", confidence: "high", findings: [] };
}
const target: import("./post-review.ts").ReviewTarget = {
  owner: "o",
  repo: "r",
  number: 1,
  headSha: "sha1",
};
const meta: import("./post-review.ts").PostMeta = { escalated: false, reasons: [] };

test("postReview: no existing id — creates comment and stores id", async () => {
  const store = new SqliteDedupStore(":memory:");
  const fakeClient = {
    rest: {
      issues: { createComment: async () => ({ data: { id: 42 } }) },
      pulls: { createReview: async () => ({}) },
    },
  } as never;
  const result = await postReview(target, makeReview(), meta, fakeClient, store);
  assert.equal(result.summaryCommentId, 42);
  assert.equal(result.summaryUpdated, false);
  assert.equal(await store.getSummaryCommentId("o/r#1"), 42);
});

test("postReview: existing id, update succeeds — summaryUpdated true", async () => {
  const store = new SqliteDedupStore(":memory:");
  await store.setSummaryCommentId("o/r#1", 99);
  let updatedId: number | undefined;
  const fakeClient = {
    rest: {
      issues: {
        updateComment: async ({ comment_id }: { comment_id: number }) => {
          updatedId = comment_id;
        },
      },
      pulls: { createReview: async () => ({}) },
    },
  } as never;
  const result = await postReview(target, makeReview(), meta, fakeClient, store);
  assert.equal(result.summaryCommentId, 99);
  assert.equal(result.summaryUpdated, true);
  assert.equal(updatedId, 99);
});

test("postReview: existing id, update throws 404 — falls back to create, new id stored", async () => {
  const store = new SqliteDedupStore(":memory:");
  await store.setSummaryCommentId("o/r#1", 99);
  const fakeClient = {
    rest: {
      issues: {
        updateComment: async () => {
          const e = new Error("Not Found") as Error & { status: number };
          e.status = 404;
          throw e;
        },
        createComment: async () => ({ data: { id: 77 } }),
      },
      pulls: { createReview: async () => ({}) },
    },
  } as never;
  const result = await postReview(target, makeReview(), meta, fakeClient, store);
  assert.equal(result.summaryCommentId, 77);
  assert.equal(result.summaryUpdated, false);
  assert.equal(await store.getSummaryCommentId("o/r#1"), 77);
});

test("postReview: existing id, update throws 500 — error is re-thrown", async () => {
  const store = new SqliteDedupStore(":memory:");
  await store.setSummaryCommentId("o/r#1", 99);
  const fakeClient = {
    rest: {
      issues: {
        updateComment: async () => {
          const e = new Error("Server Error") as Error & { status: number };
          e.status = 500;
          throw e;
        },
      },
      pulls: { createReview: async () => ({}) },
    },
  } as never;
  await assert.rejects(
    () => postReview(target, makeReview(), meta, fakeClient, store),
    (err: unknown) => (err as { status?: number }).status === 500,
  );
});

test("buildSummaryBody: no fallback section when inlineFallback is empty", () => {
  const body = buildSummaryBody(review(), { escalated: false, reasons: [] }, false, []);
  assert.doesNotMatch(body, /couldn't be posted inline/);
});

test("buildSummaryBody: fallback section lists inline findings when provided", () => {
  const inlineFallback: Finding[] = [
    { file: "a.ts", line: 10, severity: "critical", title: "C", body: "bc" },
  ];
  const body = buildSummaryBody(review(), { escalated: false, reasons: [] }, false, inlineFallback);
  assert.match(body, /### Findings that couldn't be posted inline/);
  assert.match(body, /\*\*\[critical\] C\*\* \(`a\.ts`, line 10\)/);
});

test("postReview: suppresses duplicate inline comments by fingerprint", async () => {
  const store = new SqliteDedupStore(":memory:");
  const postedComments: { path: string; line: number; body: string }[] = [];
  const existing = findings[0]!;
  const fakeClient = {
    rest: {
      pulls: {
        listReviewComments: async () => ({
          data: [
            {
              id: 1,
              path: existing.file,
              line: existing.line,
              body: `${findingMarker(existing)}\n**[critical] C**\n\nbc`,
              user: { login: "mimir[bot]", type: "Bot" },
            },
          ],
        }),
        createReview: async ({ comments }: { comments: typeof postedComments }) => {
          postedComments.push(...comments);
          return {};
        },
      },
      issues: {
        listComments: async () => ({ data: [] }),
        createComment: async () => ({ data: { id: 42 } }),
      },
    },
  } as never;

  const result = await postReview(target, review(), meta, fakeClient, store);
  assert.equal(result.inlineSuppressed, 1);
  assert.equal(result.inlinePosted, 1);
  assert.equal(postedComments.length, 1);
  assert.equal(postedComments[0]!.path, "b.ts");
});

test("postReviewFailure: no existing id — creates notice with marker, stores under ::failed key", async () => {
  const store = new SqliteDedupStore(":memory:");
  let created: { issue_number: number; body: string } | undefined;
  const fakeClient = {
    rest: {
      issues: {
        createComment: async (args: { issue_number: number; body: string }) => {
          created = args;
          return { data: { id: 55 } };
        },
      },
    },
  } as never;
  await postReviewFailure(target, new Error("boom overflow"), fakeClient, store);
  assert.equal(created?.issue_number, 1);
  assert.match(created!.body, /<!-- mimir-review-failed -->/);
  assert.match(created!.body, /Mimir review failed/);
  assert.match(created!.body, /boom overflow/);
  assert.equal(await store.getSummaryCommentId("o/r#1::failed"), 55);
  // The summary key is untouched — a failure never clobbers a good review.
  assert.equal(await store.getSummaryCommentId("o/r#1"), undefined);
});

test("postReviewFailure: existing id — updates that notice, does not create", async () => {
  const store = new SqliteDedupStore(":memory:");
  await store.setSummaryCommentId("o/r#1::failed", 88);
  let updatedId: number | undefined;
  let created = false;
  const fakeClient = {
    rest: {
      issues: {
        updateComment: async ({ comment_id }: { comment_id: number }) => {
          updatedId = comment_id;
        },
        createComment: async () => {
          created = true;
          return { data: { id: 999 } };
        },
      },
    },
  } as never;
  await postReviewFailure(target, new Error("boom"), fakeClient, store);
  assert.equal(updatedId, 88);
  assert.equal(created, false);
});

test("postReviewFailure: existing id, update 404 — falls back to create, new id stored", async () => {
  const store = new SqliteDedupStore(":memory:");
  await store.setSummaryCommentId("o/r#1::failed", 88);
  const fakeClient = {
    rest: {
      issues: {
        updateComment: async () => {
          const e = new Error("Not Found") as Error & { status: number };
          e.status = 404;
          throw e;
        },
        createComment: async () => ({ data: { id: 91 } }),
      },
    },
  } as never;
  await postReviewFailure(target, new Error("boom"), fakeClient, store);
  assert.equal(await store.getSummaryCommentId("o/r#1::failed"), 91);
});

test("postReviewFailure: non-Error throw is stringified into the body", async () => {
  const store = new SqliteDedupStore(":memory:");
  let body = "";
  const fakeClient = {
    rest: {
      issues: {
        createComment: async (a: { body: string }) => {
          body = a.body;
          return { data: { id: 1 } };
        },
      },
    },
  } as never;
  await postReviewFailure(target, "plain string failure", fakeClient, store);
  assert.match(body, /plain string failure/);
});

test("postReviewFailure: sanitizes ``` in the reason so it can't break the fenced block", async () => {
  const store = new SqliteDedupStore(":memory:");
  let body = "";
  const fakeClient = {
    rest: {
      issues: {
        createComment: async (a: { body: string }) => {
          body = a.body;
          return { data: { id: 1 } };
        },
      },
    },
  } as never;
  await postReviewFailure(target, new Error("bad ``` inside"), fakeClient, store);
  assert.ok(!body.includes("bad ``` inside"));
  assert.match(body, /bad ` ` ` inside/);
});

test("postReview: a successful review retracts a stored failure notice", async () => {
  const store = new SqliteDedupStore(":memory:");
  await store.setSummaryCommentId("o/r#1::failed", 70);
  let deletedId: number | undefined;
  const fakeClient = {
    rest: {
      issues: {
        createComment: async () => ({ data: { id: 42 } }),
        deleteComment: async ({ comment_id }: { comment_id: number }) => {
          deletedId = comment_id;
        },
      },
      pulls: { createReview: async () => ({}) },
    },
  } as never;
  await postReview(target, makeReview(), meta, fakeClient, store);
  assert.equal(deletedId, 70);
});

test("postReview: retract swallows a failed delete (already gone / missing perms)", async () => {
  const store = new SqliteDedupStore(":memory:");
  await store.setSummaryCommentId("o/r#1::failed", 70);
  const fakeClient = {
    rest: {
      issues: {
        createComment: async () => ({ data: { id: 42 } }),
        deleteComment: async () => {
          throw new Error("gone");
        },
      },
      pulls: { createReview: async () => ({}) },
    },
  } as never;
  const result = await postReview(target, makeReview(), meta, fakeClient, store);
  assert.equal(result.summaryCommentId, 42);
});
