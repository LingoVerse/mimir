import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideEscalation } from './escalation.ts';
import type { ReviewResult } from './review.ts';

function review(over: Partial<ReviewResult> = {}): ReviewResult {
  return {
    summary: 'ok',
    verdict: 'comment',
    confidence: 'high',
    findings: [],
    ...over,
  };
}

test('no triggers -> no escalation', () => {
  const d = decideEscalation({ totalChangedLines: 10, securitySensitive: false, review: review() });
  assert.equal(d.escalate, false);
  assert.deepEqual(d.reasons, []);
});

test('large diff escalates', () => {
  const d = decideEscalation({ totalChangedLines: 401, securitySensitive: false, review: review() });
  assert.equal(d.escalate, true);
  assert.match(d.reasons[0] ?? '', /diff-size/);
});

test('security-sensitive path escalates', () => {
  const d = decideEscalation({ totalChangedLines: 5, securitySensitive: true, review: review() });
  assert.deepEqual(d.reasons, ['security-sensitive-path']);
});

test('low confidence escalates', () => {
  const d = decideEscalation({
    totalChangedLines: 5,
    securitySensitive: false,
    review: review({ confidence: 'low' }),
  });
  assert.deepEqual(d.reasons, ['low-confidence']);
});

test('critical finding escalates', () => {
  const d = decideEscalation({
    totalChangedLines: 5,
    securitySensitive: false,
    review: review({
      findings: [{ file: 'a.ts', severity: 'critical', title: 't', body: 'b' }],
    }),
  });
  assert.deepEqual(d.reasons, ['critical-finding']);
});

test('multiple triggers accumulate', () => {
  const d = decideEscalation({
    totalChangedLines: 500,
    securitySensitive: true,
    review: review({ confidence: 'low' }),
  });
  assert.equal(d.escalate, true);
  assert.equal(d.reasons.length, 3);
});
