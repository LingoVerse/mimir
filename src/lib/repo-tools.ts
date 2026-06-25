import { defineTool } from '@flue/runtime';
import type { Octokit } from '@octokit/rest';
import * as v from 'valibot';

export interface RepoRef {
  owner: string;
  repo: string;
  ref: string; // commit SHA or branch
}

const MAX_FILE_CHARS = 20_000;
const MAX_SEARCH_RESULTS = 15;
const DEFAULT_TOOL_BUDGET = 8;

// Reject absolute paths and traversal — the model only addresses paths within
// the fixed {owner, repo, ref}, never escapes the repo.
export function isSafeRepoPath(path: string): boolean {
  if (path.startsWith('/')) return false;
  return !path.split('/').includes('..');
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Read-only tools scoped to one repo + ref, so the reviewer can pull context the
// diff doesn't show (callers, schemas, related modules). The scope is fixed by
// the closure — tool parameters only choose paths/queries, never the repo/ref
// (parameters are not an authorization boundary).
export function repoContextTools(client: Octokit, { owner, repo, ref }: RepoRef) {
  const budget =
    process.env.REPO_TOOL_CALL_BUDGET !== undefined
      ? parseInt(process.env.REPO_TOOL_CALL_BUDGET, 10)
      : DEFAULT_TOOL_BUDGET;
  let callCount = 0;

  function guardedExecute(toolName: string, arg: string, fn: () => Promise<string>): Promise<string> {
    callCount += 1;
    console.log(`[mimir] repo-tool call ${callCount}/${budget}`, { tool: toolName, arg });
    if (callCount > budget) {
      console.warn(`[mimir] repo-tool budget exhausted`, { tool: toolName, arg, callCount, budget });
      return Promise.resolve(
        `Tool-call budget exhausted (${budget} calls); rely on the diff and findings already gathered.`,
      );
    }
    return fn();
  }

  const readRepoFile = defineTool({
    name: 'read_repo_file',
    description:
      'Read a file from the repository at the PR head to get context the diff omits (a caller, a schema, a related module). Returns the file text.',
    parameters: v.object({
      path: v.pipe(v.string(), v.description('Repo-relative path, e.g. "src/auth/login.ts"')),
    }),
    execute: async ({ path }) => {
      if (!isSafeRepoPath(path)) return `Invalid path: ${path}`;
      return guardedExecute('read_repo_file', path, async () => {
        try {
          const { data } = await client.rest.repos.getContent({ owner, repo, path, ref });
          if (Array.isArray(data) || data.type !== 'file' || !data.content) {
            return `Not a readable file: ${path}`;
          }
          const text = Buffer.from(data.content, 'base64').toString('utf8');
          return text.length > MAX_FILE_CHARS
            ? `${text.slice(0, MAX_FILE_CHARS)}\n… [truncated ${text.length - MAX_FILE_CHARS} chars]`
            : text;
        } catch (err) {
          return `Could not read ${path}: ${errMessage(err)}`;
        }
      });
    },
  });

  const listRepoDir = defineTool({
    name: 'list_repo_dir',
    description: 'List the entries of a directory in the repository at the PR head.',
    parameters: v.object({
      path: v.optional(v.pipe(v.string(), v.description('Repo-relative directory, "" for the root'))),
    }),
    execute: async ({ path }) => {
      const dir = path ?? '';
      if (!isSafeRepoPath(dir)) return `Invalid path: ${dir}`;
      return guardedExecute('list_repo_dir', dir, async () => {
        try {
          const { data } = await client.rest.repos.getContent({ owner, repo, path: dir, ref });
          if (!Array.isArray(data)) return `Not a directory: ${dir}`;
          return data.map((e) => `${e.type === 'dir' ? 'dir ' : 'file'} ${e.path}`).join('\n');
        } catch (err) {
          return `Could not list ${dir}: ${errMessage(err)}`;
        }
      });
    },
  });

  const searchRepo = defineTool({
    name: 'search_repo',
    description:
      'Search this repository (default branch) for a symbol or string. Returns matching file paths to read — use to locate definitions/usages related to the diff.',
    parameters: v.object({
      query: v.pipe(v.string(), v.description('Code search terms, e.g. a function or class name')),
    }),
    execute: async ({ query }) => {
      return guardedExecute('search_repo', query, async () => {
        try {
          const { data } = await client.rest.search.code({
            q: `${query} repo:${owner}/${repo}`,
            per_page: MAX_SEARCH_RESULTS,
          });
          if (data.total_count === 0) return `No matches for: ${query}`;
          return data.items.map((i) => i.path).join('\n');
        } catch (err) {
          return `Search unavailable for "${query}": ${errMessage(err)}`;
        }
      });
    },
  });

  return [readRepoFile, listRepoDir, searchRepo];
}
