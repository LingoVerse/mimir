import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReviewPayload } from '../workflows/review-pr.ts';

// github.ts validates required env at module load (and process.exit(1) on
// failure). Set throwaway values BEFORE importing it so the import succeeds in
// the test process; these are placeholders, not real secrets.
process.env.OPENROUTER_API_KEY ??= 'test';
process.env.GITHUB_WEBHOOK_SECRET ??= 'test';
process.env.GITHUB_TOKEN ??= 'test';

const { handlePullRequestDelivery, resolveAdmitBase } = await import('./github.ts');

const PR: ReviewPayload = {
  owner: 'test-owner',
  repo: 'test-repo',
  number: 42,
  headSha: 'abc1234',
  baseRef: 'main',
};

test('admit succeeds: claim kept, admit called once, returns true', async () => {
  let claimCalls = 0;
  let releaseCalls = 0;
  let admitCalls = 0;
  const deps = {
    claim: (_id: string) => { claimCalls++; return true; },
    release: (_id: string) => { releaseCalls++; },
    admit: async (_url: string, _pr: ReviewPayload) => { admitCalls++; },
  };
  const result = await handlePullRequestDelivery(deps, 'http://localhost', 'del-1', PR);
  assert.equal(result, true);
  assert.equal(claimCalls, 1);
  assert.equal(admitCalls, 1);
  assert.equal(releaseCalls, 0);
});

test('admit throws: claim released and error re-thrown', async () => {
  let releaseCalls = 0;
  let releasedId = '';
  const deps = {
    claim: (_id: string) => true,
    release: (id: string) => { releaseCalls++; releasedId = id; },
    admit: async (_url: string, _pr: ReviewPayload) => {
      throw new Error('admit failed with status 503');
    },
  };
  await assert.rejects(
    () => handlePullRequestDelivery(deps, 'http://localhost', 'del-2', PR),
    /admit failed/,
  );
  assert.equal(releaseCalls, 1);
  assert.equal(releasedId, 'del-2');
});

test('duplicate delivery: admit NOT called, returns false', async () => {
  let admitCalls = 0;
  const deps = {
    claim: (_id: string) => false,
    release: (_id: string) => {},
    admit: async (_url: string, _pr: ReviewPayload) => { admitCalls++; },
  };
  const result = await handlePullRequestDelivery(deps, 'http://localhost', 'del-3', PR);
  assert.equal(result, false);
  assert.equal(admitCalls, 0);
});

test('returns INTERNAL_BASE_URL verbatim when set', () => {
  assert.strictEqual(
    resolveAdmitBase('http://127.0.0.1:3000', 'http://example.com/channels/github/webhook'),
    'http://127.0.0.1:3000',
  );
});
test('loopback origin when unset and request is 127.0.0.1', () => {
  assert.strictEqual(
    resolveAdmitBase(undefined, 'http://127.0.0.1:3000/channels/github/webhook'),
    'http://127.0.0.1:3000',
  );
});
test('loopback origin when unset and request is localhost', () => {
  assert.strictEqual(
    resolveAdmitBase(undefined, 'http://localhost:3000/channels/github/webhook'),
    'http://localhost:3000',
  );
});
test('loopback origin when unset and request is [::1]', () => {
  assert.strictEqual(
    resolveAdmitBase(undefined, 'http://[::1]:3000/channels/github/webhook'),
    'http://[::1]:3000',
  );
});
test('throws when unset and origin is a public host', () => {
  assert.throws(
    () => resolveAdmitBase(undefined, 'https://mimir.example.com/channels/github/webhook'),
    /INTERNAL_BASE_URL is not set.*not loopback/,
  );
});
test('throws when unset and origin is an arbitrary private IP', () => {
  assert.throws(
    () => resolveAdmitBase(undefined, 'http://10.0.0.1:3000/channels/github/webhook'),
    /INTERNAL_BASE_URL is not set.*not loopback/,
  );
});
