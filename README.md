# Mimir

Self-hosted GitHub **pull-request reviewer**. On each PR, Mimir fetches the diff, reviews it
against a markdown rubric (with a deeper security pass on sensitive changes), escalates hard
diffs to a stronger model, and posts a **summary comment + inline comments**. Read-only on
code — it comments, humans decide. Model-agnostic via **OpenRouter**; a drop-in replacement
for the consumer Gemini Code Assist GitHub reviewer.

> *Mimir* — in Norse myth, the wise severed head Odin consults before every decision. A
> reviewer is the counsel you consult before merging; and a head with no body is *headless*,
> which is how Flue describes itself. The name is the architecture.

## How it works

```
GitHub webhook
  → verify signature + dedup delivery        (channels/github.ts)
  → fetch & chunk diff, skip generated/vendored   (lib/diff.ts)
  → primary review on a cheap model               (workflows/review-pr.ts + skills/)
      rubric always; security-check on sensitive paths
  → escalate to a stronger model when the diff is  (lib/escalation.ts)
      big / security-sensitive / low-confidence / has a critical finding
  → post summary + inline comments, idempotently   (lib/post-review.ts)
```

Built on **Flue** (Node runtime), **OpenRouter** (LLM gateway), **octokit** (GitHub API),
and **SQLite** (delivery dedup + summary-comment tracking).

## Quick start (local)

```bash
bun install
cp .env.example .env     # fill OPENROUTER_API_KEY, GITHUB_WEBHOOK_SECRET, GITHUB_TOKEN
bun run dev              # flue dev server on :3583
```

Expose it (e.g. an `ngrok`/`cloudflared` tunnel) and point a GitHub webhook at
`/channels/github/webhook`. Full setup — generating the webhook secret, token scopes, and
production deploy — is in **[DEPLOY.md](DEPLOY.md)**.

## Configuration

All model selection is env, so swapping models is a config change. The app **validates env at
startup** and refuses to boot if a required var is missing or malformed.

| Var | Required | Default | Purpose |
| --- | :---: | --- | --- |
| `OPENROUTER_API_KEY` | ✅ | — | LLM access (all models via OpenRouter) |
| `GITHUB_WEBHOOK_SECRET` | ✅ | — | verify inbound webhook signatures |
| `GITHUB_TOKEN` | ✅ | — | read the diff + post comments |
| `MODEL_PRIMARY` | | `openrouter/z-ai/glm-5.2` | cheap pass, runs on every PR |
| `MODEL_ESCALATION` | | `openrouter/google/gemini-flash-3` | stronger pass on hard diffs |
| `ESCALATION_DIFF_THRESHOLD` | | `400` | changed-lines trigger for escalation |
| `DIFF_MAX_TOKENS` | | `60000` | diff token budget (largest-change files kept) |
| `POST_NITS` | | `false` | also post `nit`-severity comments |
| `DATABASE_URL` | | `./data/mimir.db` | sqlite path (`sqlite:<path>` or a bare path) |
| `INTERNAL_BASE_URL` | | request origin | loopback used to admit review runs behind a proxy |

## Project layout

```
src/
  channels/github.ts      verified webhook ingress; dedup + admit a review run
  workflows/review-pr.ts  resolve PR → diff → skills → primary → escalate → post
  skills/                 review-rubric, security-check  (Agent Skills, bundled)
  lib/                    github, diff, dedup, review, security-paths,
                          escalation, post-review, env
```

Workflows and channels are discovered by flat filename in their dirs; everything else is `lib/`.

## Development

```bash
bun run dev | build | typecheck | test | lint | format
```

Tests run under `node --test` (matching the Node runtime, where `node:sqlite` is available).

## Design notes

- **Node runtime, not Bun.** Flue's CLI needs `node:module.registerHooks`, which Bun lacks;
  Bun is only the package manager (flue runs under Node via its bin shebang). Deploy is Node.
- **OpenRouter is a built-in Flue provider** — no registration code, just `OPENROUTER_API_KEY`;
  specifiers look like `openrouter/<vendor>/<model>`.
- **Dual-model.** Every PR gets the cheap pass; escalation re-reviews the whole diff on the
  stronger model and replaces the result (also double-checking critical claims).
- **Idempotency.** Webhook deliveries are claimed in SQLite (replays skipped); the summary
  comment id is stored so a re-push updates one comment instead of stacking new ones.

## Non-goals

No auto-fix, no auto-merge, no auto-approve — comments only.
