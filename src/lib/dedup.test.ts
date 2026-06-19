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
