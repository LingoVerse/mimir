import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSafeRepoPath, repoContextTools } from './repo-tools.ts';

test('isSafeRepoPath rejects absolute paths and traversal', () => {
  for (const ok of ['src/index.ts', 'a/b/c.ts', 'README.md', '']) {
    assert.equal(isSafeRepoPath(ok), true, ok);
  }
  for (const bad of ['/etc/passwd', '../secret', 'a/../../b', '../../x']) {
    assert.equal(isSafeRepoPath(bad), false, bad);
  }
});

test('repoContextTools returns the three read-only tools', () => {
  // octokit client is unused until a tool executes; identity is enough here.
  const tools = repoContextTools({} as never, { owner: 'o', repo: 'r', ref: 'sha' });
  assert.deepEqual(
    tools.map((t) => t.name),
    ['read_repo_file', 'list_repo_dir', 'search_repo'],
  );
});
