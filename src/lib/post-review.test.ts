import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSummaryBody, postReview, visibleFindings } from './post-review.ts';
import { SqliteDedupStore } from './dedup.ts';
import type { Finding, ReviewResult } from './review.ts';

const findings: Finding[] = [
  { file: 'a.ts', line: 10, severity: 'critical', title: 'C', body: 'bc' },
  { file: 'b.ts', line: 20, severity: 'major', title: 'M', body: 'bm' },
  { file: 'c.ts', severity: 'minor', title: 'General', body: 'bg' }, // no line
  { file: 'd.ts', line: 5, severity: 'nit', title: 'N', body: 'bn' },
];

function review(over: Partial<ReviewResult> = {}): ReviewResult {
  return { summary: 's', verdict: 'comment', confidence: 'high', findings, ...over };
}

test('visibleFindings suppresses nits by default, keeps them when enabled', () => {
  assert.deepEqual(
    visibleFindings(findings, false).map((f) => f.severity),
    ['critical', 'major', 'minor'],
  );
  assert.equal(visibleFindings(findings, true).length, 4);
});

test('summary body: counts, marker, suppressed-nit note, general findings', () => {
  const body = buildSummaryBody(review(), { escalated: false, reasons: [] }, false);
  assert.match(body, /<!-- mimir-summary -->/);
  assert.match(body, /1 critical · 1 major · 1 minor · 1 nit _\(suppressed\)_/);
  // line-less finding is listed under General findings; inline ones are not.
  assert.match(body, /### General findings/);
  assert.match(body, /\*\*\[minor\] General\*\* \(`c\.ts`\)/);
  assert.doesNotMatch(body, /\[critical\] C/); // inline finding stays inline
});

test('summary body: escalation + truncation notes', () => {
  const body = buildSummaryBody(
    review({ verdict: 'request_changes' }),
    { escalated: true, reasons: ['critical-finding'], truncatedOmitted: 2 },
    false,
  );
  assert.match(body, /Changes requested/);
  assert.match(body, /Escalated to the stronger model \(critical-finding\)/);
  assert.match(body, /2 file\(s\) not reviewed/);
});

function makeReview(): import('./review.ts').ReviewResult {
  return { summary: 's', verdict: 'comment', confidence: 'high', findings: [] };
}
const target: import('./post-review.ts').ReviewTarget = {
  owner: 'o', repo: 'r', number: 1, headSha: 'sha1',
};
const meta: import('./post-review.ts').PostMeta = { escalated: false, reasons: [] };

test('postReview: no existing id — creates comment and stores id', async () => {
  const store = new SqliteDedupStore(':memory:');
  const fakeClient = {
    rest: { issues: { createComment: async () => ({ data: { id: 42 } }) }, pulls: { createReview: async () => ({}) } },
  } as never;
  const result = await postReview(target, makeReview(), meta, fakeClient, store);
  assert.equal(result.summaryCommentId, 42);
  assert.equal(result.summaryUpdated, false);
  assert.equal(store.getSummaryCommentId('o/r#1'), 42);
});

test('postReview: existing id, update succeeds — summaryUpdated true', async () => {
  const store = new SqliteDedupStore(':memory:');
  store.setSummaryCommentId('o/r#1', 99);
  let updatedId: number | undefined;
  const fakeClient = {
    rest: { issues: { updateComment: async ({ comment_id }: { comment_id: number }) => { updatedId = comment_id; } }, pulls: { createReview: async () => ({}) } },
  } as never;
  const result = await postReview(target, makeReview(), meta, fakeClient, store);
  assert.equal(result.summaryCommentId, 99);
  assert.equal(result.summaryUpdated, true);
  assert.equal(updatedId, 99);
});

test('postReview: existing id, update throws 404 — falls back to create, new id stored', async () => {
  const store = new SqliteDedupStore(':memory:');
  store.setSummaryCommentId('o/r#1', 99);
  const fakeClient = {
    rest: { issues: {
      updateComment: async () => { const e = new Error('Not Found') as Error & { status: number }; e.status = 404; throw e; },
      createComment: async () => ({ data: { id: 77 } }),
    }, pulls: { createReview: async () => ({}) } },
  } as never;
  const result = await postReview(target, makeReview(), meta, fakeClient, store);
  assert.equal(result.summaryCommentId, 77);
  assert.equal(result.summaryUpdated, false);
  assert.equal(store.getSummaryCommentId('o/r#1'), 77);
});

test('postReview: existing id, update throws 500 — error is re-thrown', async () => {
  const store = new SqliteDedupStore(':memory:');
  store.setSummaryCommentId('o/r#1', 99);
  const fakeClient = {
    rest: { issues: { updateComment: async () => { const e = new Error('Server Error') as Error & { status: number }; e.status = 500; throw e; } }, pulls: { createReview: async () => ({}) } },
  } as never;
  await assert.rejects(
    () => postReview(target, makeReview(), meta, fakeClient, store),
    (err: unknown) => (err as { status?: number }).status === 500,
  );
});
