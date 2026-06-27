import type { Octokit } from "@octokit/rest";
import type { RepoRef } from "./repo-tools.ts";

// `.mimirignore` lets a project declare paths the reviewer should not fetch or
// read — generated artefacts that add noise and burn the token budget (e.g. a
// 3k-line Drizzle `migrations/meta/*_snapshot.json`). Same gitignore glob
// semantics, so a project's existing mental model carries over.

const IGNORE_FILE = ".mimirignore";

function escapeRegExp(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

// Convert one gitignore-style glob to an anchored RegExp over repo-relative
// paths. `*`/`?` stay within a segment, `**` crosses segments, a trailing `/`
// matches a directory and everything under it, and a pattern with an internal
// `/` is anchored to the repo root (otherwise it matches by basename anywhere).
function patternToRegExp(pattern: string): RegExp {
  let p = pattern;
  const dirOnly = p.endsWith("/");
  if (dirOnly) p = p.slice(0, -1);
  const anchored = p.includes("/");
  if (p.startsWith("/")) p = p.slice(1);

  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p.charAt(i);
    if (c === "*") {
      if (p[i + 1] === "*") {
        if (p[i + 2] === "/") {
          re += "(?:.*/)?"; // `**/` — any number of leading dirs, including none
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += escapeRegExp(c);
    }
  }

  const prefix = anchored ? "^" : "(?:^|.*/)";
  const suffix = dirOnly ? "(?:/.*)?$" : "$";
  return new RegExp(prefix + re + suffix);
}

// Parse `.mimirignore` text into globs. Blank lines and `#` comments are
// dropped; `!` negation is not supported and is ignored.
export function parseIgnore(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#") && !l.startsWith("!"));
}

// Build a path predicate from ignore globs (false for an empty set).
export function makeIgnoreMatcher(patterns: string[]): (path: string) => boolean {
  if (patterns.length === 0) return () => false;
  const regexps = patterns.map(patternToRegExp);
  return (path) => regexps.some((re) => re.test(path));
}

// Read `.mimirignore` from the trusted base ref and return a path predicate. Read
// from base (not head) so a PR cannot exclude its own files from review; a new
// `.mimirignore` takes effect once merged to the base branch.
export async function fetchIgnoreMatcher(
  client: Octokit,
  ref: RepoRef,
): Promise<(path: string) => boolean> {
  try {
    const { data } = await client.rest.repos.getContent({
      owner: ref.owner,
      repo: ref.repo,
      path: IGNORE_FILE,
      ref: ref.ref,
    });
    if (Array.isArray(data) || data.type !== "file" || !data.content) return () => false;
    const text = Buffer.from(data.content, "base64").toString("utf8");
    return makeIgnoreMatcher(parseIgnore(text));
  } catch {
    return () => false; // no .mimirignore — fine
  }
}
