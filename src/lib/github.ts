import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";

// Application-owned GitHub API client for outbound calls (diff fetch in
// lib/diff.ts, posting in lib/post-review.ts). Webhook verification is separate
// (GITHUB_WEBHOOK_SECRET). Two auth modes, selected by env:
//
//   - GitHub App (recommended): GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY +
//     GITHUB_APP_INSTALLATION_ID. Comments are authored by "<AppName>[bot]" with
//     the bot badge; installation tokens are minted and refreshed automatically.
//   - Personal access token: GITHUB_TOKEN. Comments are authored by the token's
//     user account.
//
// validateEnv() guarantees exactly one of the two is fully configured.
function makeClient(): Octokit {
  const appId = process.env.GITHUB_APP_ID;
  // Secret stores (Cloudflare, CI) may hold the PEM with escaped newlines.
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n");
  const installationId = process.env.GITHUB_APP_INSTALLATION_ID;
  if (appId && privateKey && installationId) {
    return new Octokit({
      authStrategy: createAppAuth,
      auth: { appId: Number(appId), privateKey, installationId: Number(installationId) },
    });
  }
  return new Octokit({ auth: process.env.GITHUB_TOKEN });
}

export const client = makeClient();
