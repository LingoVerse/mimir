import { type ToolDefinition, defineTool } from "@flue/runtime";
import type { Octokit } from "@octokit/rest";
import { repoSandboxNeedsArchive, runRepoSandboxCommand } from "#repo-sandbox";
import * as v from "valibot";

export interface RepoRef {
  owner: string;
  repo: string;
  ref: string; // commit SHA or branch
}

const MAX_SEARCH_RESULTS = 15;
const MAX_COMMAND_OUTPUT_CHARS = 20_000;

const READ_ONLY_COMMANDS = new Set(["awk", "find", "grep", "head", "jq", "ls", "rg", "tail", "wc"]);
const EXEC_COMMANDS = new Set([
  "bun",
  "cargo",
  "deno",
  "go",
  "node",
  "npm",
  "pnpm",
  "pytest",
  "sed", // its w/W/e commands and -i flag write files and run shell commands
  "yarn",
]);

export interface RepoToolOptions {
  sandboxId?: string;
  baseRef?: string;
}

export function repoSandboxId(owner: string, repo: string, prNumber: number): string {
  return `${owner}/${repo}#${prNumber}`;
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

// find's -exec/-ok family spawns arbitrary programs and -delete/-fprint* write
// to the filesystem; none of them require a blocked shell metacharacter to use,
// so they must be rejected on find's own arguments.
const FIND_UNSAFE_FLAGS = /(?:^|\s)-(exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls)\b/;

// ripgrep's --pre/--pre-glob run an arbitrary command against every searched
// file, turning a "read-only" search into command execution.
const RG_UNSAFE_FLAGS = /(?:^|\s)--pre(?:\s|=|-glob\b|-glob=)/;

// Keep read-only commands scoped to repo-relative paths. This is intentionally
// conservative: a false positive costs a tool call; a false negative leaks host
// files on the Node backend.
const UNSAFE_PATH_ARGS = /(?:^|\s)\/|(?:^|\s)\.\.(?:\/|\s|$)|\/\.\.(?:\/|\s|$)/;

function isSafeCommandArgs(name: string, command: string): boolean {
  if (name === "find") return !FIND_UNSAFE_FLAGS.test(command);
  if (name === "rg") return !RG_UNSAFE_FLAGS.test(command);
  return true;
}

export function isSafeSandboxCommand(command: string): boolean {
  if (/[;&|><`$()\\\n\r]/.test(command)) return false;
  if (UNSAFE_PATH_ARGS.test(command)) return false;
  const name = commandName(command);
  if (!name) return false;
  if (READ_ONLY_COMMANDS.has(name)) return isSafeCommandArgs(name, command);
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
  if (data.length > MAX_SEARCH_RESULTS)
    lines.push(`... [${data.length - MAX_SEARCH_RESULTS} more]`);
  return lines.join("\n");
}

// Repo tools scoped to one repo + ref. General repository exploration happens
// only through the persistent checkout: exposing GitHub file/list/search tools
// alongside it caused reviewers to clone once, then abandon the checkout for
// slower, fragmented API reads.
export function repoContextTools(
  client: Octokit,
  { owner, repo, ref }: RepoRef,
  options: RepoToolOptions = {},
): ToolDefinition[] {
  const sandboxId = options.sandboxId ?? `${owner}-${repo}-${ref}`;

  const runRepoCommand = defineTool({
    name: "run_repo_command",
    description:
      'The general-purpose repository exploration tool. It runs commands in a persistent sandbox checkout of the full PR head, so call it repeatedly to search symbols and callers, inspect any files or snippets, and validate findings across the repository. Prefer targeted rg/grep/head/tail/jq/find/ls/awk/wc commands; read long files in chunks when needed. Examples: `rg -n -C 4 "Button" packages/design-system`, `head -n 120 packages/design-system/index.tsx`, `grep -n "" packages/design-system/package.json`. Build/test commands require REPO_SANDBOX_ALLOW_EXEC=1 because they execute untrusted repo code on the runner.',
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
          "Allowed by default: awk, find, grep, head, jq, ls, rg, tail, wc. " +
          "Shell control operators are blocked. Set REPO_SANDBOX_ALLOW_EXEC=1 for build/test commands."
        );
      }

      console.log("[mimir] repo-sandbox command", { command });
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
    },
  });

  const tools: ToolDefinition[] = [runRepoCommand];

  if (options.baseRef) {
    tools.push(
      defineTool({
        name: "dependency_review",
        description:
          "Summarize dependency changes and known vulnerabilities between the PR base ref and head ref using GitHub Dependency Graph. Use when manifests or lockfiles changed.",
        input: v.object({}),
        run: async () => {
          const basehead = `${options.baseRef}...${ref}`;
          console.log("[mimir] dependency review", { basehead });
          try {
            const { data } = await client.request(
              "GET /repos/{owner}/{repo}/dependency-graph/compare/{basehead}",
              { owner, repo, basehead },
            );
            return formatDependencyReview(data);
          } catch (err) {
            return `Dependency review unavailable: ${errMessage(err)}`;
          }
        },
      }),
    );
  }

  return tools;
}
