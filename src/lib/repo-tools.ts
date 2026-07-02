import { type ToolDefinition, defineTool } from "@flue/runtime";
import type { Octokit } from "@octokit/rest";
import { repoSandboxNeedsArchive, runRepoSandboxCommand } from "#repo-sandbox";
import * as v from "valibot";

export interface RepoRef {
  owner: string;
  repo: string;
  ref: string; // commit SHA or branch
}

const MAX_FILE_CHARS = 20_000;
const MAX_SEARCH_RESULTS = 15;
const MAX_COMMAND_OUTPUT_CHARS = 20_000;
const MIN_TOOL_BUDGET = 8;
const MAX_TOOL_BUDGET = 40;

const READ_ONLY_COMMANDS = new Set([
  "awk",
  "find",
  "grep",
  "jq",
  "ls",
  "rg",
  "sed",
  "wc",
]);
const EXEC_COMMANDS = new Set([
  "bun",
  "cargo",
  "deno",
  "go",
  "node",
  "npm",
  "pnpm",
  "pytest",
  "yarn",
]);

export interface RepoToolOptions {
  sandboxId?: string;
  baseRef?: string;
}

export function repoSandboxId(owner: string, repo: string, prNumber: number): string {
  return `${owner}/${repo}#${prNumber}`;
}

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

function commandName(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  const match = /^[A-Za-z0-9_./-]+/.exec(trimmed);
  if (!match) return null;
  return match[0].split("/").pop() ?? null;
}

export function isSafeSandboxCommand(command: string): boolean {
  if (/[;&|><`$()\\\n\r]/.test(command)) return false;
  const name = commandName(command);
  if (!name) return false;
  if (READ_ONLY_COMMANDS.has(name)) return true;
  return process.env.REPO_SANDBOX_ALLOW_EXEC === "1" && EXEC_COMMANDS.has(name);
}

function truncateOutput(text: string): string {
  return text.length > MAX_COMMAND_OUTPUT_CHARS
    ? `${text.slice(0, MAX_COMMAND_OUTPUT_CHARS)}\n... [truncated ${text.length - MAX_COMMAND_OUTPUT_CHARS} chars]`
    : text;
}

function tarballBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (typeof data === "string") return Buffer.from(data, "binary");
  throw new Error(`Unsupported tarball response: ${typeof data}`);
}

function formatDependencyReview(data: unknown): string {
  if (!Array.isArray(data)) return "Dependency review returned an unexpected response.";
  if (data.length === 0) return "No dependency changes detected.";
  const lines = data.slice(0, MAX_SEARCH_RESULTS).map((item) => {
    const dep = item as Record<string, unknown>;
    const vulns = Array.isArray(dep.vulnerabilities) ? dep.vulnerabilities : [];
    const vulnText = vulns.length
      ? ` vulnerabilities=${vulns
          .map((v) => {
            const vuln = v as Record<string, unknown>;
            return `${String(vuln.severity ?? "unknown")}:${String(vuln.advisory_ghsa_id ?? "?")}`;
          })
          .join(",")}`
      : "";
    return [
      String(dep.change_type ?? "changed"),
      String(dep.ecosystem ?? "unknown"),
      String(dep.name ?? "unknown"),
      String(dep.version ?? "unknown"),
      `manifest=${String(dep.manifest ?? "unknown")}`,
      `scope=${String(dep.scope ?? "unknown")}`,
      vulnText,
    ]
      .filter(Boolean)
      .join(" ");
  });
  if (data.length > MAX_SEARCH_RESULTS) lines.push(`... [${data.length - MAX_SEARCH_RESULTS} more]`);
  return lines.join("\n");
}

// Read-only tools scoped to one repo + ref, so the reviewer can pull context the
// diff doesn't show (callers, schemas, related modules). The scope is fixed by
// the closure — tool parameters only choose paths/queries, never the repo/ref
// (parameters are not an authorization boundary).
export function repoContextTools(
  client: Octokit,
  { owner, repo, ref }: RepoRef,
  fileCount = 0,
  options: RepoToolOptions = {},
): ToolDefinition[] {
  const budget = resolveToolBudget(fileCount);
  let callCount = 0;
  // Cached tree entries for search_repo (fetched once from the head ref).
  let repoTree: string[] | null = null;
  const sandboxId = options.sandboxId ?? `${owner}-${repo}-${ref}`;

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

  const runRepoCommand = defineTool({
    name: "run_repo_command",
    description:
      "Run a bounded shell command in a persistent sandbox checkout of the PR head ref. Prefer rg/grep/sed/jq/find for targeted code review context. The checkout is reused until the PR closes or local TTL cleanup removes it. Build/test commands require REPO_SANDBOX_ALLOW_EXEC=1 because they execute untrusted repo code on the runner.",
    input: v.object({
      command: v.pipe(
        v.string(),
        v.description('Command to run from repo root, e.g. rg "createUser" src'),
      ),
      timeoutMs: v.optional(
        v.pipe(v.number(), v.description("Timeout in milliseconds, capped at 60000")),
      ),
    }),
    run: async ({ input: { command, timeoutMs } }) => {
      if (!isSafeSandboxCommand(command)) {
        return (
          `Command not allowed: ${commandName(command) ?? "<empty>"}. ` +
          "Allowed by default: awk, find, grep, jq, ls, rg, sed, wc. " +
          "Shell control operators are blocked. Set REPO_SANDBOX_ALLOW_EXEC=1 for build/test commands."
        );
      }

      return guardedExecute("run_repo_command", command, async () => {
        try {
          let archive: Uint8Array | undefined;
          if (await repoSandboxNeedsArchive({ checkoutKey: ref, sandboxId })) {
            const { data } = await client.request("GET /repos/{owner}/{repo}/tarball/{ref}", {
              owner,
              repo,
              ref,
            });
            archive = tarballBuffer(data);
          }
          const boundedTimeout = Math.max(1_000, Math.min(timeoutMs ?? 15_000, 60_000));
          const result = await runRepoSandboxCommand({
            archive,
            checkoutKey: ref,
            command,
            timeoutMs: boundedTimeout,
            maxOutputChars: MAX_COMMAND_OUTPUT_CHARS,
            sandboxId,
          });
          return truncateOutput(result.output);
        } catch (err) {
          return `Command failed: ${errMessage(err)}`;
        }
      });
    },
  });

  const tools: ToolDefinition[] = [readRepoFile, listRepoDir, searchRepo, runRepoCommand];

  if (options.baseRef) {
    tools.push(
      defineTool({
        name: "dependency_review",
        description:
          "Summarize dependency changes and known vulnerabilities between the PR base ref and head ref using GitHub Dependency Graph. Use when manifests or lockfiles changed.",
        input: v.object({}),
        run: async () => {
          const basehead = `${options.baseRef}...${ref}`;
          return guardedExecute("dependency_review", basehead, async () => {
            try {
              const { data } = await client.request(
                "GET /repos/{owner}/{repo}/dependency-graph/compare/{basehead}",
                { owner, repo, basehead },
              );
              return formatDependencyReview(data);
            } catch (err) {
              return `Dependency review unavailable: ${errMessage(err)}`;
            }
          });
        },
      }),
    );
  }

  return tools;
}
