import type { Octokit } from '@octokit/rest';

export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

export interface FileDiff {
  filename: string;
  previousFilename?: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  // Unified diff hunks. Absent for binary files or patches GitHub omits as too large.
  patch?: string;
}

export interface PrDiff {
  // Reviewable files within the token budget (generated/vendored + truncated removed).
  files: FileDiff[];
  // Changed lines across all reviewable files (pre-truncation) — feeds escalation (§5.1).
  totalChangedLines: number;
  // Generated/vendored paths filtered out before review.
  skipped: string[];
  // Set when the diff exceeded the token budget and was capped to top files.
  truncated: { omitted: string[]; reviewedFiles: number } | null;
}

function readMaxTokens(): number {
  const n = Number(process.env.DIFF_MAX_TOKENS);
  return Number.isFinite(n) && n > 0 ? n : 60_000;
}

const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'Cargo.lock',
  'composer.lock',
  'Gemfile.lock',
  'poetry.lock',
  'go.sum',
]);

// Generated/vendored paths that add noise without review value (§7 step 2).
export function isSkippablePath(path: string): boolean {
  if (path.includes('node_modules/')) return true;
  if (path === 'dist' || path.startsWith('dist/') || path.includes('/dist/')) return true;
  if (/\.min\.[^/.]+$/.test(path)) return true; // *.min.js, *.min.css, ...
  return LOCKFILES.has(path.slice(path.lastIndexOf('/') + 1));
}

// Rough token estimate (~4 chars/token) for budgeting the diff.
function estimateTokens(file: FileDiff): number {
  return Math.ceil(((file.patch?.length ?? 0) + file.filename.length) / 4);
}

// Keep the most significant files (largest change count first) within the token
// budget so a huge diff still gets a useful review; report what was dropped.
export function chunkFiles(
  files: FileDiff[],
  maxTokens = readMaxTokens(),
): Pick<PrDiff, 'files' | 'truncated'> {
  let total = 0;
  for (const file of files) total += estimateTokens(file);
  if (total <= maxTokens) return { files, truncated: null };

  const ranked = [...files].sort((a, b) => b.changes - a.changes);
  const kept = new Set<string>();
  const omitted: string[] = [];
  let budget = 0;
  for (const file of ranked) {
    const cost = estimateTokens(file);
    if (budget + cost <= maxTokens) {
      kept.add(file.filename);
      budget += cost;
    } else {
      omitted.push(file.filename);
    }
  }

  return {
    // Preserve original file order for the kept subset.
    files: files.filter((file) => kept.has(file.filename)),
    truncated: { omitted, reviewedFiles: kept.size },
  };
}

// Fetch a PR's per-file diff via octokit, drop generated/vendored paths, and
// cap to a token budget. The caller passes the channel-owned Octokit client.
export async function fetchPrDiff(
  client: Octokit,
  ref: PrRef,
  maxTokens = readMaxTokens(),
): Promise<PrDiff> {
  const raw = await client.paginate(client.rest.pulls.listFiles, {
    owner: ref.owner,
    repo: ref.repo,
    pull_number: ref.number,
    per_page: 100,
  });

  const skipped: string[] = [];
  const reviewable: FileDiff[] = [];
  let totalChangedLines = 0;

  for (const f of raw) {
    if (isSkippablePath(f.filename)) {
      skipped.push(f.filename);
      continue;
    }
    totalChangedLines += f.additions + f.deletions;
    reviewable.push({
      filename: f.filename,
      previousFilename: f.previous_filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.changes,
      patch: f.patch,
    });
  }

  const { files, truncated } = chunkFiles(reviewable, maxTokens);
  return { files, totalChangedLines, skipped, truncated };
}
