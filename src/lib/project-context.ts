import type { Octokit } from "@octokit/rest";
import type { RepoRef } from "./repo-tools.ts";

// Agent-guidance files projects commonly already maintain. Read from the PR's
// BASE branch (trusted) and injected as review context — so Mimir honours the
// project's own conventions (and, later, its `.mimir/memory`).
const GUIDANCE_PATHS = ["CLAUDE.md", "AGENTS.md", ".github/copilot-instructions.md"];
const MEMORY_DIR = ".mimir/memory";

const DEFAULT_MAX_CHARS = 20_000;
const MAX_PER_FILE = 6_000;

export interface ContextFile {
  path: string;
  text: string;
}

// Pure: assemble fetched guidance files into one capped context block.
export function buildContextBlock(files: ContextFile[], maxChars = DEFAULT_MAX_CHARS): string {
  const parts: string[] = [];
  let total = 0;
  for (const file of files) {
    const body =
      file.text.length > MAX_PER_FILE
        ? `${file.text.slice(0, MAX_PER_FILE)}\n… [truncated]`
        : file.text;
    const block = `### ${file.path}\n${body}`;
    if (total + block.length > maxChars) break;
    parts.push(block);
    total += block.length;
  }
  return parts.join("\n\n");
}

// Fetch the full recursive git tree (all files + dirs) for a given ref, and return
// it formatted as an indented tree. Used to orient the model on project structure.
export async function fetchProjectTree(client: Octokit, ref: RepoRef): Promise<string> {
  try {
    const { data } = await client.rest.git.getTree({
      owner: ref.owner,
      repo: ref.repo,
      tree_sha: ref.ref,
      recursive: "1",
    });
    const lines: string[] = [];
    // Sort: dirs first, then alphabetical
    const sorted = [...data.tree].sort((a, b) => {
      if (a.type !== b.type) return a.type === "tree" ? -1 : 1;
      return (a.path ?? "").localeCompare(b.path ?? "");
    });
    for (const entry of sorted) {
      if (!entry.path) continue;
      const depth = entry.path.split("/").length - 1;
      const indent = "  ".repeat(depth);
      const name = entry.path.split("/").pop() ?? entry.path;
      const suffix = entry.type === "tree" ? "/" : "";
      lines.push(`${indent}${name}${suffix}`);
    }
    return lines.join("\n");
  } catch {
    return "(unavailable)";
  }
}

async function readFile(client: Octokit, ref: RepoRef, path: string): Promise<ContextFile | null> {
  try {
    const { data } = await client.rest.repos.getContent({
      owner: ref.owner,
      repo: ref.repo,
      path,
      ref: ref.ref,
    });
    if (Array.isArray(data) || data.type !== "file" || !data.content) return null;
    return { path, text: Buffer.from(data.content, "base64").toString("utf8") };
  } catch {
    return null; // file absent — fine
  }
}

// Fetch known agent-guidance files + `.mimir/memory/*.md` from the base ref and
// return one capped context block (empty string when the project has none).
export async function fetchProjectContext(
  client: Octokit,
  ref: RepoRef,
  maxChars = DEFAULT_MAX_CHARS,
): Promise<string> {
  const files: ContextFile[] = [];

  for (const path of GUIDANCE_PATHS) {
    const file = await readFile(client, ref, path);
    if (file) files.push(file);
  }

  try {
    const { data } = await client.rest.repos.getContent({
      owner: ref.owner,
      repo: ref.repo,
      path: MEMORY_DIR,
      ref: ref.ref,
    });
    if (Array.isArray(data)) {
      for (const entry of data) {
        if (entry.type === "file" && entry.name.endsWith(".md")) {
          const file = await readFile(client, ref, entry.path);
          if (file) files.push(file);
        }
      }
    }
  } catch {
    // no .mimir/memory yet
  }

  return buildContextBlock(files, maxChars);
}
