# Deploying Mimir

Mimir is a small Node service (one Docker image) that receives GitHub webhooks and posts PR
reviews. This covers the GitHub setup — the part that's easy to get wrong — and the deploy.

## 1. Prerequisites

- A Docker host reachable over **HTTPS** (Hetzner + Dokploy, Fly, Railway, or any VM with a
  reverse proxy + TLS).
- An **OpenRouter** API key — <https://openrouter.ai/keys>.
- Admin on the GitHub repo or org you want reviewed.

## 2. GitHub setup

### 2a. Webhook + secret

The webhook secret is a value **you generate** and put in **two** places that must match: the
GitHub webhook config and the app's `GITHUB_WEBHOOK_SECRET`.

1. Generate one:
   ```bash
   openssl rand -hex 32
   ```
2. Repo → **Settings → Webhooks → Add webhook** (org-wide: Org **Settings → Webhooks**):
   - **Payload URL:** `https://<your-host>/channels/github/webhook`
   - **Content type:** `application/json` ← required (form-encoded is rejected with `415`)
   - **Secret:** the value from step 1
   - **Which events:** "Let me select individual events" → **Pull requests**
     (optionally **Issue comments** / **Pull request review comments** for future `/review`
     re-triggers)
   - **Active:** ✓
3. Set the same value as `GITHUB_WEBHOOK_SECRET` on the app.

After deploy, GitHub sends a **ping** — confirm **Recent Deliveries** shows `200`.

### 2b. `GITHUB_TOKEN` — what rights it needs

Used for outbound calls: read the PR and its changed files, and post the summary + inline
comments. The token's account is **who appears as the comment author** — use a dedicated bot
account if you want "Mimir" as the author. Pick one:

- **Fine-grained PAT** (recommended) — <https://github.com/settings/tokens?type=beta>
  - Repository access: the repos to review
  - Permissions:
    - **Contents:** Read-only
    - **Pull requests:** Read and write
    - _(Metadata: Read-only — granted automatically)_
- **Classic PAT** — <https://github.com/settings/tokens>
  - Scope **`repo`** (private repos) or **`public_repo`** (public only)
- **GitHub App** (best for orgs / many repos)
  - Permissions: **Contents: Read**, **Pull requests: Read & write**; subscribe to
    **Pull request** events
  - Use an **installation access token** as `GITHUB_TOKEN`

## 3. Environment

Set env **on the container** (Dokploy's env UI, or compose `env_file`). The built server does
**not** read a `.env` file — env must be supplied at runtime. Mimir **validates env at boot and
refuses to start** if a required var is missing or malformed (the error names which).

- **Required:** `OPENROUTER_API_KEY`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_TOKEN`
- **Optional:** `MODEL_PRIMARY`, `MODEL_ESCALATION`, `ESCALATION_DIFF_THRESHOLD`,
  `DIFF_MAX_TOKENS`, `POST_NITS`, `DATABASE_URL`, `INTERNAL_BASE_URL` (see the README table)

In the Docker image, `DATABASE_URL=sqlite:/data/mimir.db` and
`INTERNAL_BASE_URL=http://127.0.0.1:3000` are preset. **Mount a volume at `/data`** so dedup +
comment-id state survives restarts.

## 4. Deploy

### Docker Compose

```bash
cp .env.example .env        # fill the three required secrets
docker compose up -d --build
```

The image is Node-based, runs non-root, listens on `:3000` (binds `0.0.0.0`), has a
`HEALTHCHECK`, and keeps SQLite on the `mimir-data` volume.

### Dokploy (Hetzner)

1. New app → from this repo (or push the prebuilt image).
2. Build: **Dockerfile** (default).
3. Env: add the required vars (and any overrides) in the UI.
4. Storage: mount a volume at **`/data`**.
5. Domain: assign one with HTTPS — that host is your webhook **Payload URL** base.

### Cloudflare Workers (experimental)

Mimir is built on [Flue](https://flueframework.com) by the Astro team, which supports
Cloudflare Workers as a deployment target. Each agent becomes a Durable Object with
automatic scaling.

**Prerequisites:**

- A Cloudflare account with Workers Paid plan (Durable Objects required)
- `wrangler` CLI installed (`npm install -g wrangler`)

**Build & deploy:**

```bash
flue build --target cloudflare
npx wrangler deploy --secrets-file .env
```

**⚠️ Known limitation:** Mimir currently uses `node:sqlite` (Node built-in) for delivery
dedup, comment-ID tracking, and review stats. Cloudflare Workers does not support
`node:sqlite` — these features require adapting to **Cloudflare D1** or another KV store
before this deploy path is fully functional. PRs welcome.

The Docker / Node deploy is the current recommended production path.

## 5. Verify it works

- **Ping:** webhook **Recent Deliveries** → latest `ping` shows `200`.
- **Review:** open a PR on a reviewed repo → within ~1–2 min a summary comment + inline
  comments appear.
- **Re-push:** push another commit → the summary comment **updates** (no duplicate).
- **Replay:** redeliver the same delivery from GitHub → no second review (dedup).
- **Escalation:** a >400-line or auth/migration/CI diff → the run log shows escalation to
  `MODEL_ESCALATION`.

## Troubleshooting

| Symptom                             | Cause / fix                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------ |
| Boot fails: `Invalid environment …` | a required var is missing/empty — the message lists which                            |
| Webhook `401`                       | secret mismatch between GitHub and `GITHUB_WEBHOOK_SECRET`                           |
| Webhook `415`                       | content type isn't `application/json`                                                |
| No comments / `403` from GitHub     | `GITHUB_TOKEN` lacks **Pull requests: write** (or `repo`), or no access to that repo |
| Reviews never start behind a proxy  | set `INTERNAL_BASE_URL` to the container loopback, e.g. `http://127.0.0.1:3000`      |
