# Deploying Mimir

Mimir is a small Node service (one Docker image) that receives GitHub webhooks and posts PR
reviews. This covers the GitHub setup — the part that's easy to get wrong — and the deploy.

## 1. Prerequisites

- A Docker host reachable over **HTTPS** (Dokploy, Fly, Railway, or any VM with a
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
  `DIFF_MAX_TOKENS`, `POST_NITS`, `DATABASE_URL` (see the README table)

In the Docker image, `DATABASE_URL=sqlite:/data/mimir.db` is preset. **Mount a volume at
`/data`** so dedup + comment-id state survives restarts.

## 4. Deploy

### Docker Compose

```bash
cp .env.example .env        # fill the three required secrets
docker compose up -d --build
```

The image is Node-based, runs non-root, listens on `:3000` (binds `0.0.0.0`), has a
`HEALTHCHECK`, and keeps SQLite on the `mimir-data` volume.

### Dokploy

1. New app → from this repo (or push the prebuilt image).
2. Build: **Dockerfile** (default).
3. Env: add the required vars (and any overrides) in the UI.
4. Storage: mount a volume at **`/data`**.
5. Domain: assign one with HTTPS — that host is your webhook **Payload URL** base.

### Cloudflare Workers (alternative)

Mimir also builds for **Cloudflare Workers** via [Flue](https://flueframework.com): each
workflow becomes a Durable Object, and application storage (dedup, comment-id tracking,
review stats) moves from `node:sqlite` to **Cloudflare D1**. The storage backend is chosen
automatically at build time — no code changes. The Docker / Node deploy above remains the
recommended path; this is a fully-supported alternative.

**Prerequisites:**

- A Cloudflare account with the **Workers Paid plan** (Durable Objects require it).
- `wrangler` is a dev dependency, so `bunx wrangler …` / `npx wrangler …` work without a
  global install.

**1. Create the D1 database** and paste the returned `database_id` into
[`wrangler.jsonc`](wrangler.jsonc) (`d1_databases[0].database_id`):

```bash
bunx wrangler d1 create mimir
```

**2. Apply the schema** (creates the tables in `migrations/`):

```bash
bun run d1:migrate            # remote (production D1)
# bun run d1:migrate:local    # local dev D1 for `flue dev --target cloudflare`
```

**3. Set secrets** (do NOT rely on `.env`/`.dev.vars` for production):

```bash
bunx wrangler secret put OPENROUTER_API_KEY
bunx wrangler secret put GITHUB_WEBHOOK_SECRET
bunx wrangler secret put GITHUB_TOKEN
# optional: MODEL_PRIMARY, MODEL_ESCALATION, POST_NITS, ADMIN_TOKEN, …
```

For local Cloudflare dev, put the same vars in `.dev.vars` (see
[`.dev.vars.example`](.dev.vars.example)) and run `bun run dev:cf`.

**4. Build & deploy:**

```bash
bun run build:cf
bun run cf:dry-run            # optional: validate the generated config
bun run deploy:cf
```

Your webhook **Payload URL** is then
`https://mimir.<your-subdomain>.workers.dev/channels/github/webhook`.

**Notes:**

- **Durable Object migrations** for the generated classes live in
  [`wrangler.jsonc`](wrangler.jsonc). Adding a workflow later means appending a new
  migration `tag` — never rewrite a deployed entry.
- **`DATABASE_URL` is Node/Docker-only.** On Cloudflare, storage is the D1 binding `DB`.
- **`/admin` is public** on a Workers URL. Set `ADMIN_TOKEN` to require
  `Authorization: Bearer <token>` (or put Cloudflare Access in front of it).

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
