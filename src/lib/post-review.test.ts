import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSummaryBody, visibleFindings } from './post-review.ts';
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
