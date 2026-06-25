import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SqliteDedupStore } from './dedup.ts';

test('claim is idempotent: first wins, replay is rejected', () => {
  const store = new SqliteDedupStore(':memory:');
  assert.equal(store.claim('delivery-1'), true);
  assert.equal(store.claim('delivery-1'), false); // replay
  assert.equal(store.claim('delivery-2'), true); // distinct id
});

test('rejects non-sqlite DATABASE_URL schemes', () => {
  assert.throws(() => new SqliteDedupStore('postgres://localhost/db'), /sqlite only/);
  assert.throws(() => new SqliteDedupStore('redis://localhost:6379'), /sqlite only/);
});

test('release: claim → release → claim again returns true', () => {
  const store = new SqliteDedupStore(':memory:');
  assert.equal(store.claim('delivery-r1'), true);
  store.release('delivery-r1');
  assert.equal(store.claim('delivery-r1'), true); // re-claimable after release
});

test('release: no-op when id was never claimed', () => {
  const store = new SqliteDedupStore(':memory:');
  assert.doesNotThrow(() => store.release('never-claimed'));
});

test('summary comment id: absent, then create-once, then update', () => {
  const store = new SqliteDedupStore(':memory:');
  const pr = 'octo/repo#7';
  assert.equal(store.getSummaryCommentId(pr), undefined); // first review -> create
  store.setSummaryCommentId(pr, 111);
  assert.equal(store.getSummaryCommentId(pr), 111); // synchronize -> update this id
  store.setSummaryCommentId(pr, 222); // upsert overwrites
  assert.equal(store.getSummaryCommentId(pr), 222);
  assert.equal(store.getSummaryCommentId('octo/repo#8'), undefined); // distinct PR
});
