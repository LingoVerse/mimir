import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type MemoryEntry,
  hasSkipMarker,
  isMaintainer,
  memoryPath,
  parseRememberCommand,
  renderEntry,
} from './memory.ts';

test('parseRememberCommand matches both trigger forms', () => {
  assert.equal(parseRememberCommand('/remember legacy dir is intentional'), 'legacy dir is intentional');
  assert.equal(parseRememberCommand('@mimir remember use repos here', 'mimir'), 'use repos here');
  assert.equal(parseRememberCommand('please /remember X', 'mimir'), 'X');
  assert.equal(parseRememberCommand('hey @bot remember Y', 'bot'), 'Y');
});

test('parseRememberCommand ignores non-commands', () => {
  assert.equal(parseRememberCommand('I remember when this broke'), null);
  assert.equal(parseRememberCommand('/remember'), null); // no fact
  assert.equal(parseRememberCommand('just a normal comment'), null);
});

test('isMaintainer gates on association', () => {
  for (const a of ['OWNER', 'MEMBER', 'COLLABORATOR']) assert.equal(isMaintainer(a), true, a);
  for (const a of ['CONTRIBUTOR', 'NONE', 'FIRST_TIME_CONTRIBUTOR', undefined]) {
    assert.equal(isMaintainer(a), false, String(a));
  }
});

test('hasSkipMarker detects the loop-guard markers', () => {
  assert.equal(hasSkipMarker('chore(mimir): remember X [skip review]'), true);
  assert.equal(hasSkipMarker('whatever [mimir skip]'), true);
  assert.equal(hasSkipMarker('fix: a real change'), false);
});

test('renderEntry emits frontmatter + body', () => {
  const entry: MemoryEntry = {
    action: 'create',
    slug: 'legacy-data-layer',
    title: 'legacy/ stays on the old data layer',
    scope: 'src/legacy/**',
    source: 'pr#42 by alice',
    confidence: 'high',
    body: 'Intentional until the Q3 migration.',
    reason: 'cross-cutting decision',
  };
  const md = renderEntry(entry, new Date('2026-06-20T00:00:00Z'));
  assert.match(md, /title: legacy\/ stays on the old data layer/);
  assert.match(md, /scope: src\/legacy\/\*\*/);
  assert.match(md, /created: 2026-06-20/);
  assert.match(md, /Intentional until the Q3 migration\./);
  assert.equal(memoryPath('legacy-data-layer'), '.mimir/memory/legacy-data-layer.md');
});
