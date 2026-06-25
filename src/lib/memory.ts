import { Buffer } from 'node:buffer';
import type { Octokit } from '@octokit/rest';
import * as v from 'valibot';

// Structured output of the memory-curator skill.
export const MemoryEntrySchema = v.object({
  action: v.picklist(['create', 'update', 'skip']),
  slug: v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]*$/, 'slug must be kebab-case')),
  title: v.string(),
  scope: v.string(),
  source: v.string(),
  confidence: v.picklist(['high', 'medium']),
  body: v.string(),
  reason: v.string(),
});
export type MemoryEntry = v.InferOutput<typeof MemoryEntrySchema>;

export type RememberSource = 'command' | 'observed';

const MEMORY_DIR = '.mimir/memory';
// Marker on memory commits so the resulting `synchronize` is not re-reviewed
// (and a manual human opt-out lever on any push).
export const SKIP_MARKERS = ['[skip review]', '[mimir skip]'];

const MAINTAINER_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export function isMaintainer(association: string | undefined): boolean {
  return association !== undefined && MAINTAINER_ASSOCIATIONS.has(association);
}

export function hasSkipMarker(commitMessage: string): boolean {
  const lower = commitMessage.toLowerCase();
  return SKIP_MARKERS.some((m) => lower.includes(m));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Parse `/remember <fact>` or `@<handle> remember <fact>` (handle configurable,
// since the bot's GitHub login may not be "mimir"). Returns the fact, or null.
export function parseRememberCommand(
  body: string,
  handle = process.env.MIMIR_HANDLE ?? 'mimir',
): string | null {
  const h = escapeRegExp(handle.replace(/^@/, ''));
  const re = new RegExp(`(?:^|\\s)(?:/remember|@${h}\\s+remember)\\s+(.+)`, 'is');
  const fact = body.match(re)?.[1]?.trim();
  return fact || null;
}

export function memoryPath(slug: string): string {
  return `${MEMORY_DIR}/${slug}.md`;
}

// Render the entry file: frontmatter + body.
export function renderEntry(entry: MemoryEntry, date = new Date()): string {
  const created = date.toISOString().slice(0, 10);
  return `---
title: ${entry.title}
scope: ${entry.scope}
source: ${entry.source}
confidence: ${entry.confidence}
created: ${created}
---

${entry.body.trim()}
`;
}

// Commit the entry to the PR head branch with the skip-review marker. Upserts:
// looks up the existing file SHA so create and update both work. Only valid for
// same-repo branches (fork heads can't be pushed to — caller must guard).
export async function commitMemoryEntry(
  client: Octokit,
  target: { owner: string; repo: string; headRef: string },
  entry: MemoryEntry,
): Promise<{ path: string; commitUrl: string | undefined }> {
  const path = memoryPath(entry.slug);

  let sha: string | undefined;
  try {
    const { data } = await client.rest.repos.getContent({
      owner: target.owner,
      repo: target.repo,
      path,
      ref: target.headRef,
    });
    if (!Array.isArray(data) && data.type === 'file') sha = data.sha;
  } catch {
    // new file
  }

  const res = await client.rest.repos.createOrUpdateFileContents({
    owner: target.owner,
    repo: target.repo,
    path,
    branch: target.headRef,
    message: `chore(mimir): remember ${entry.title} ${SKIP_MARKERS[0]}`,
    content: Buffer.from(renderEntry(entry), 'utf8').toString('base64'),
    sha,
  });
  return { path, commitUrl: res.data.commit.html_url };
}
