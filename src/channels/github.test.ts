import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReviewPayload } from '../workflows/review-pr.ts';

// github.ts validates required env at module load (and process.exit(1) on
// failure). Set throwaway values BEFORE importing it so the import succeeds in
// the test process; these are placeholders, not real secrets.
process.env.OPENROUTER_API_KEY ??= 'test';
process.env.GITHUB_WEBHOOK_SECRET ??= 'test';
process.env.GITHUB_TOKEN ??= 'test';

const { handlePullRequestDelivery } = await import('./github.ts');

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
