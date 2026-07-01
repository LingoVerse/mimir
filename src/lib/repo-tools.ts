import { type ToolDefinition, defineTool } from "@flue/runtime";
import type { Octokit } from "@octokit/rest";
import * as v from "valibot";

export interface RepoRef {
  owner: string;
  repo: string;
  ref: string; // commit SHA or branch
}

const MAX_FILE_CHARS = 20_000;
const MAX_SEARCH_RESULTS = 15;
const MIN_TOOL_BUDGET = 8;
const MAX_TOOL_BUDGET = 40;

// Per-pass repo-tool-call budget. An explicit REPO_TOOL_CALL_BUDGET pins it (escape
// hatch / tests); otherwise it scales with the reviewed-file count — roughly one
// context read per file — so a 20-file PR isn't starved by the small-PR floor,
// bounded to [MIN_TOOL_BUDGET, REPO_TOOL_CALL_BUDGET_MAX].
export function resolveToolBudget(fileCount: number): number {
  const fixed = process.env.REPO_TOOL_CALL_BUDGET;
  if (fixed !== undefined) return parseInt(fixed, 10);
  const maxRaw = Number(process.env.REPO_TOOL_CALL_BUDGET_MAX);
  const max = Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : MAX_TOOL_BUDGET;
  return Math.min(max, Math.max(MIN_TOOL_BUDGET, fileCount));
}

// Reject absolute paths and traversal — the model only addresses paths within
// the fixed {owner, repo, ref}, never escapes the repo.
export function isSafeRepoPath(path: string): boolean {
  if (path.startsWith("/")) return false;
  return !path.split("/").includes("..");
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Read-only tools scoped to one repo + ref, so the reviewer can pull context the
// diff doesn't show (callers, schemas, related modules). The scope is fixed by
// the closure — tool parameters only choose paths/queries, never the repo/ref
// (parameters are not an authorization boundary).
export function repoContextTools(
  client: Octokit,
  { owner, repo, ref }: RepoRef,
  fileCount = 0,
): ToolDefinition[] {
  const budget = resolveToolBudget(fileCount);
  let callCount = 0;
  // Cached tree entries for search_repo (fetched once from the head ref).
  let repoTree: string[] | null = null;

  function guardedExecute(
    toolName: string,
    arg: string,
    fn: () => Promise<string>,
  ): Promise<string> {
    callCount += 1;
    console.log(`[mimir] repo-tool call ${callCount}/${budget}`, { tool: toolName, arg });
    if (callCount > budget) {
      console.warn(`[mimir] repo-tool budget exhausted`, {
        tool: toolName,
        arg,
        callCount,
        budget,
      });
      return Promise.resolve(
        `Tool-call budget exhausted (${budget} calls); rely on the diff and findings already gathered.`,
      );
    }
    return fn();
  }

  const readRepoFile = defineTool({
    name: "read_repo_file",
    description:
      "Read a file from the repository at the PR head to get context the diff omits (a caller, a schema, a related module). Returns the file text.",
    input: v.object({
      path: v.pipe(v.string(), v.description('Repo-relative path, e.g. "src/auth/login.ts"')),
    }),
    run: async ({ input: { path } }) => {
      if (!isSafeRepoPath(path)) return `Invalid path: ${path}`;
      return guardedExecute("read_repo_file", path, async () => {
        try {
          const { data } = await client.rest.repos.getContent({ owner, repo, path, ref });
          if (Array.isArray(data) || data.type !== "file" || !data.content) {
            return `Not a readable file: ${path}`;
          }
          const text = Buffer.from(data.content, "base64").toString("utf8");
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
    name: "list_repo_dir",
    description: "List the entries of a directory in the repository at the PR head.",
    input: v.object({
      path: v.optional(
        v.pipe(v.string(), v.description('Repo-relative directory, "" for the root')),
      ),
    }),
    run: async ({ input: { path } }) => {
      const dir = path ?? "";
      if (!isSafeRepoPath(dir)) return `Invalid path: ${dir}`;
      return guardedExecute("list_repo_dir", dir, async () => {
        try {
          const { data } = await client.rest.repos.getContent({ owner, repo, path: dir, ref });
          if (!Array.isArray(data)) return `Not a directory: ${dir}`;
          return data.map((e) => `${e.type === "dir" ? "dir " : "file"} ${e.path}`).join("\n");
        } catch (err) {
          return `Could not list ${dir}: ${errMessage(err)}`;
        }
      });
    },
  });

  const searchRepo = defineTool({
    name: "search_repo",
    description:
      "Search this repository (PR head ref) by file path for a symbol or string. Returns matching file paths to read — use to locate definitions/usages related to the diff. Searches the PR head so new code is visible.",
    input: v.object({
      query: v.pipe(v.string(), v.description("Search terms, e.g. a function or class name")),
    }),
    run: async ({ input: { query } }) => {
      return guardedExecute("search_repo", query, async () => {
        try {
          if (repoTree === null) {
            const { data } = await client.rest.git.getTree({
              owner,
              repo,
              tree_sha: ref,
              recursive: "1",
            });
            repoTree = data.tree.filter((e) => e.path && e.type === "blob").map((e) => e.path!);
          }
          const q = query.toLowerCase();
          const matches = repoTree.filter((p) => p.toLowerCase().includes(q));
          if (matches.length === 0) return `No matches for: ${query}`;
          return matches.slice(0, MAX_SEARCH_RESULTS).join("\n");
        } catch (err) {
          return `Search unavailable for "${query}": ${errMessage(err)}`;
        }
      });
    },
  });

  return [readRepoFile, listRepoDir, searchRepo];
}
