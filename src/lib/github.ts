import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";

// Application-owned GitHub API client for outbound calls (diff fetch in
// lib/diff.ts, posting in lib/post-review.ts, memory commits in lib/memory.ts).
// Webhook verification is separate (GITHUB_WEBHOOK_SECRET). Two auth modes:
//
//   - GitHub App (recommended): GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY. Comments
//     are authored by "<AppName>[bot]". One App serves every org/account it is
//     installed on: the installation id comes from each webhook payload
//     (installation.id), so pass it to githubClient(). GITHUB_APP_INSTALLATION_ID
//     is an optional fallback (e.g. plain repo webhooks that omit installation).
//   - Personal access token: GITHUB_TOKEN. Comments authored by the token's user;
//     the installation id is ignored.
//
// validateEnv() guarantees one of the two is configured.

function appCreds(): { appId: number; privateKey: string } | null {
  const appId = process.env.GITHUB_APP_ID;
  // Secret stores (Cloudflare, CI) may hold the PEM with escaped newlines.
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n");
  return appId && privateKey ? { appId: Number(appId), privateKey } : null;
}

const patClient = new Octokit({ auth: process.env.GITHUB_TOKEN });
// One installation-scoped client per installation id (stable within an isolate).
const installationClients = new Map<number, Octokit>();

// Returns a GitHub client authorized for `installationId` (App mode) or the PAT
// (PAT mode). Cross-org: pass `delivery.payload.installation?.id` so the App
// authenticates as the correct installation for each event.
export function githubClient(installationId?: number): Octokit {
  const creds = appCreds();
  if (!creds) return patClient;

  const fallback = process.env.GITHUB_APP_INSTALLATION_ID;
  const id = installationId ?? (fallback ? Number(fallback) : undefined);
  if (id === undefined) {
    throw new Error(
      "GitHub App auth needs an installation id — from the webhook payload " +
        "(installation.id) or the GITHUB_APP_INSTALLATION_ID fallback.",
    );
  }

  let existing = installationClients.get(id);
  if (!existing) {
    existing = new Octokit({ authStrategy: createAppAuth, auth: { ...creds, installationId: id } });
    installationClients.set(id, existing);
  }
  return existing;
}
