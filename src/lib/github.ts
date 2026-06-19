import { Octokit } from '@octokit/rest';

// Application-owned GitHub API client for outbound calls (diff fetch in
// lib/diff.ts, posting in lib/post-review.ts). Auth is the PAT / GitHub App
// installation token; webhook verification is separate (GITHUB_WEBHOOK_SECRET).
export const client = new Octokit({ auth: process.env.GITHUB_TOKEN });
