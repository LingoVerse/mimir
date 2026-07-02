# Deploying Mimir

Mimir receives GitHub webhooks and posts PR reviews. It deploys to **Docker/Node**
(recommended) or **Cloudflare Workers**. This covers the GitHub setup — the part that's easy
to get wrong — and both deploy paths.

## 1. Prerequisites

- A deploy target: a **Docker** host over HTTPS (Dokploy, Fly, Railway, or any VM with TLS),
  **or** a **Cloudflare** account with the **Workers Paid plan** (Durable Objects).
- An **OpenRouter** API key — <https://openrouter.ai/keys>.
- Admin on the GitHub repo/org to review, and a token with **`Pull requests: Read and write`**
  (§2b — this is the usual thing people get wrong).

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
   - **Which events:** "Let me select individual events" → **Pull requests** **+ Issue comments**
     (Issue comments powers the `/review`, `/remember`, and `/feedback` PR commands)
   - **Active:** ✓
3. Set the same value as `GITHUB_WEBHOOK_SECRET` on the app.

After deploy, GitHub sends a **ping** — confirm **Recent Deliveries** shows `200`.

### 2b. GitHub auth — App (recommended) or PAT

Mimir reads the PR/diff and posts the review. Pick how it authenticates:

- **GitHub App** — comments are authored by **`<AppName>[bot]`** with the bot badge, clearly
  not a person. Set `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` + `GITHUB_APP_INSTALLATION_ID`
  (installation tokens are minted/refreshed automatically).
- **Personal access token** — comments are authored by the token's user. Set `GITHUB_TOKEN`.

> ⚠️ Either way, **`Pull requests` must be `Read and write`.** With read-only the review runs
> but posting silently `403`s and **no comment appears** — the most common setup mistake.

**Set up the GitHub App** — one-time, ~5 minutes. Produces three values:
`GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY`.

1. **Create the App:** <https://github.com/settings/apps> → **New GitHub App**.
   - **GitHub App name:** what shows as the reviewer, e.g. `mimir-reviewer` (globally unique;
     becomes the `<name>[bot]` login).
   - **Homepage URL:** anything (e.g. your repo URL).
   - **Webhook → Active:** **uncheck it.** Events are already delivered by the repo webhook
     from §2a; the App is used only for the bot identity + write access. _(Advanced: instead
     point the App webhook at the same URL + secret and drop the repo webhook.)_
   - **Repository permissions:** **Contents → Read-only**, **Pull requests → Read and write**
     (leave everything else "No access").
   - **Where can this app be installed:** "Only on this account".
   - **Create GitHub App.**
2. On the App page, copy the **App ID** (near the top) → this is `GITHUB_APP_ID`.
3. Scroll to **Private keys → Generate a private key**. A `.pem` downloads — it is the App's
   credential, keep it safe.
4. Left sidebar **Install App → Install** on your account/org → **Only select repositories** →
   pick the repo(s) to review → **Install**. The resulting URL is
   `…/settings/installations/<NUMBER>` — that `<NUMBER>` is `GITHUB_APP_INSTALLATION_ID`.
5. Give the three values to Mimir as env/secrets (§3 Docker, or §4 Cloudflare
   `wrangler secret put`). For the private key, see the note below.

> 🔑 **Private-key format on Cloudflare.** GitHub issues the key as PKCS#1
> (`-----BEGIN RSA PRIVATE KEY-----`); Workers' Web Crypto wants PKCS#8. Convert once, then
> store the result:
>
> ```bash
> openssl pkcs8 -topk8 -nocrypt -in your-app.private-key.pem | \
>   bunx wrangler secret put GITHUB_APP_PRIVATE_KEY
> ```
>
> Node/Docker accepts the raw `.pem` unchanged. Multi-line values are fine; `\n`-escaped
> newlines are also accepted.

> 🔁 **Migrating an existing PR from PAT to App.** A summary comment first created by a PAT
> keeps its original author when the App later _updates_ it. Delete that one comment — the next
> review recreates it as `<name>[bot]`. New PRs are bot-authored from the start.

**Personal access token** (simpler; comments authored by you):

| Type                               | Where                                          | Grant                                                                              |
| ---------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| **Fine-grained PAT** (recommended) | <https://github.com/settings/tokens?type=beta> | Repo access = the repo(s) · **Contents: Read** · **Pull requests: Read and write** |
| **Classic PAT**                    | <https://github.com/settings/tokens>           | scope **`repo`** (private) or **`public_repo`** (public)                           |

Editing a fine-grained PAT's permissions keeps the **same token value** — no need to re-set the
secret afterward.

## 3. Environment

Set env **on the container** (Dokploy's env UI, or compose `env_file`). The built server does
**not** read a `.env` file — env must be supplied at runtime. Mimir **validates env at boot and
refuses to start** if a required var is missing or malformed (the error names which).

- **Required:** `OPENROUTER_API_KEY`, `GITHUB_WEBHOOK_SECRET`, and GitHub auth — either
  `GITHUB_TOKEN` **or** the App trio `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` +
  `GITHUB_APP_INSTALLATION_ID` (§2b)
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
# GitHub auth — a PAT:
bunx wrangler secret put GITHUB_TOKEN
# …or a GitHub App (bot identity, §2b):
# bunx wrangler secret put GITHUB_APP_ID
# bunx wrangler secret put GITHUB_APP_PRIVATE_KEY        # paste the full .pem contents
# bunx wrangler secret put GITHUB_APP_INSTALLATION_ID
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

| Symptom                                              | Cause / fix                                                                                                                                 |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Boot / deploy fails: `Invalid environment …`         | a required secret is missing — the message lists which. On Cloudflare, set secrets **before** `deploy:cf` (the upload runs a startup check) |
| Webhook `401`                                        | secret mismatch between GitHub and `GITHUB_WEBHOOK_SECRET`                                                                                  |
| Webhook `415`                                        | content type isn't `application/json`                                                                                                       |
| Webhook `200` but no comment appears (`403` in logs) | `GITHUB_TOKEN` has **Pull requests read-only** — set it to **Read and write** (§2b), or it has no access to that repo                       |

**See live logs** to diagnose a review that runs but posts nothing: Docker → container stdout;
Cloudflare → `bunx wrangler tail mimir`.
