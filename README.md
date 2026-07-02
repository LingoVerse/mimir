# Mimir

Self-hosted GitHub **pull-request reviewer** with persistent project memory and an
auto-learning feedback loop. On each PR, Mimir fetches the diff, reviews it against a
markdown rubric (with a deeper security pass on sensitive changes), escalates hard diffs
to a stronger model, and posts a **summary comment + inline comments**. Read-only on code —
it comments, humans decide. Model-agnostic via **OpenRouter**.

> _Mimir_ — in Norse myth, the wise severed head Odin consults before every decision. A
> reviewer is the counsel you consult before merging; and a head with no body is _headless_,
> which is how Flue describes itself. The name is the architecture.

## How it works

```
GitHub webhook                                           (channels/github.ts)
  → verify signature + dedup delivery
  → fetch and chunk diff, skip generated/vendored + `.mimirignore`
                                                         (lib/diff.ts, lib/ignore.ts)
  → load project context: conventions, memory, project tree from the base branch
     + read-only repo tools (head-ref search, file read, ls)
                                                         (lib/project-context.ts, lib/repo-tools.ts)
  → primary review on a cheap model                       (workflows/review-pr.ts + skills/)
     rubric always; security-check on sensitive paths
  → escalate to a stronger model when:                    (lib/escalation.ts)
     • diff is large (>400 lines)
     • security-sensitive paths changed
     • primary model confidence is low
     • critical finding found
     (escalation receives primary findings + scope files; retries on 429/503)
  → post summary + inline comments, idempotently           (lib/post-review.ts)
  → log review stats to SQLite for the admin endpoint      (lib/dedup.ts)
```

Built on **Flue**, **OpenRouter** (LLM gateway), **octokit** (GitHub API), and a small
app store for delivery dedup + summary-comment tracking + review stats — **SQLite**
(`node:sqlite`) on the Node/Docker target, **Cloudflare D1** on the Workers target. Deploys
to Docker/Node (recommended) or Cloudflare Workers; see **[DEPLOY.md](DEPLOY.md)**.

### Memory & feedback loop

Mimir maintains **durable project memory** in `.mimir/memory/*.md` on the base branch,
injected into every review as context. Three triggers write to it:

| Trigger                | How                                                                     | Source     |
| ---------------------- | ----------------------------------------------------------------------- | ---------- |
| **`/remember <fact>`** | Explicit command in a PR comment                                        | `command`  |
| **`/feedback <fact>`** | Alias for `/remember`                                                   | `command`  |
| **Auto-detect**        | Any substantive (>40 chars) maintainer PR comment — the curator decides | `observed` |

The memory-curator skill (AI-driven) extracts the decision, convention, or gotcha and commits
it as a well-scoped markdown file. Future reviews see it through `fetchProjectContext()`.

### Admin endpoint

Open `GET /admin` in your browser to see recent review runs: models used, token
cost, file counts, escalation reasons. Data lives in the app store (SQLite on Node,
D1 on Cloudflare). Set `ADMIN_TOKEN` to require a bearer token on this endpoint.

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

| Var                         | Required | Default                                    | Purpose                                                                                                 |
| --------------------------- | :------: | ------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `OPENROUTER_API_KEY`        |    ✅    | —                                          | LLM access (all models via OpenRouter)                                                                  |
| `GITHUB_WEBHOOK_SECRET`     |    ✅    | —                                          | verify inbound webhook signatures                                                                       |
| `GITHUB_TOKEN`              |    ✅    | —                                          | read the diff + post comments                                                                           |
| `MODEL_PRIMARY`             |          | `openrouter/google/gemini-3-flash-preview` | cheap pass, runs on every PR                                                                            |
| `MODEL_ESCALATION`          |          | `openrouter/z-ai/glm-5.2`                  | stronger pass on hard diffs                                                                             |
| `ESCALATION_DIFF_THRESHOLD` |          | `400`                                      | changed-lines trigger for escalation                                                                    |
| `ESCALATE_SECURITY_ALWAYS`  |          | `true`                                     | always escalate on security-sensitive paths (vs only when findings exist)                               |
| `DIFF_MAX_TOKENS`           |          | `60000`                                    | diff token budget (largest-change files kept)                                                           |
| `REPO_TOOL_CALL_BUDGET`     |          | auto                                       | pin per-pass repo-tool calls (else scales ~1/reviewed file)                                             |
| `REPO_TOOL_CALL_BUDGET_MAX` |          | `40`                                       | cap when the tool-call budget auto-scales with PR size                                                  |
| `POST_NITS`                 |          | `false`                                    | also post `nit`-severity comments                                                                       |
| `SKIP_LABELS`               |          | `mimir:skip`                               | comma-separated PR labels that exclude the whole PR from review                                         |
| `ALLOWED_OWNERS`            |          | all                                        | comma-separated allowlist of repo owners (logins/orgs) the bot serves — **set for a public GitHub App** |
| `MIMIR_HANDLE`              |          | `mimir`                                    | GitHub handle for `@handle remember` / `@handle review` commands                                        |
| `ADMIN_TOKEN`               |          | —                                          | if set, `GET /admin` requires `Authorization: Bearer <token>` (else open)                               |
| `DATABASE_URL`              |          | `./data/mimir.db`                          | sqlite path (`sqlite:<path>` or bare path) — **Node/Docker only**; Cloudflare uses the D1 binding `DB`  |

## Project layout

```
src/
  app.ts                      Hono entrypoint: GET /admin dashboard + mounts flue()
  channels/github.ts          verified webhook ingress; dedup + invoke() runs
  workflows/review-pr.ts      primary → escalate → post
  workflows/remember-pr.ts    /remember command → curator → commit memory
  workflows/feedback-pr.ts    auto-detect maintainer feedback → curator → commit
  skills/                     review-rubric, security-check, memory-curator
  lib/                        admin-html, diff, dedup, escalation, env, github,
                              handle-delivery, ignore, instruction, log, memory,
                              post-review, project-context, repo-tools, retry,
                              review, security-paths
```

Workflows and channels are discovered by flat filename in their dirs; everything else is `lib/`.

## Development

```bash
bun run dev | build | typecheck | test | lint | format
```

Tests run under `node --test` (matching the Node runtime, where `node:sqlite` is available).
The Cloudflare **D1** backend is tested in workerd via `bun run test:cf`
(`@cloudflare/vitest-pool-workers`, `*.spec.ts`).

## Design notes

- **Node runtime, not Bun.** Flue's CLI needs `node:module.registerHooks`, which Bun lacks;
  Bun is only the package manager (flue runs under Node via its bin shebang).
- **Two deploy targets, one codebase.** `flue build --target node` (Docker, recommended) and
  `--target cloudflare` (Workers) share everything. The app store is the only
  runtime-specific piece — `node:sqlite` on Node, Cloudflare D1 on Workers — selected by a
  `#app-store` subpath import (`workerd` condition), so the channel, workflows, and octokit
  paths are byte-for-byte the same on both.
- **OpenRouter is a built-in Flue provider** — no registration code, just `OPENROUTER_API_KEY`;
  specifiers look like `openrouter/<vendor>/<model>`.
- **Dual-model + scoped escalation.** Every PR gets the cheap pass; escalation re-reviews on the
  stronger model and replaces the result. When triggered by specific findings (critical severity,
  security-sensitive paths), only the relevant files are scoped — the model gets the full diff
  for context but a "focus" directive to concentrate its effort.
- **Idempotency.** Webhook deliveries are claimed in the app store (replays skipped); the
  summary comment id is stored so a re-push updates one comment instead of stacking new ones.
- **`.mimirignore`.** A repo can drop generated artefacts from review (e.g. a 3k-line Drizzle
  `migrations/meta/*_snapshot.json`) by committing a `.mimirignore` to the **base branch** —
  gitignore-style globs, one per line, `#` comments allowed. Matching files are filtered out of
  the diff before review, so the model never reads them and they don't burn the token budget.
  Read from the base (not the PR head) so a PR cannot exclude its own files from review; it
  takes effect once merged. Built-in skips (`node_modules`, `dist`, `*.min.*`, lockfiles) apply
  regardless. Example `.mimirignore`:
  ```
  # generated Drizzle migration snapshots
  **/migrations/meta/
  *_snapshot.json
  ```
- **Context beyond the diff.** The reviewer reads the project's own agent-guidance
  (`CLAUDE.md`, `AGENTS.md`, `.github/copilot-instructions.md`, `.mimir/memory/*`) from the
  base branch, plus the **full project tree** (directory structure of the head ref), and has
  read-only, repo-scoped tools (`read_repo_file`, `list_repo_dir`, `search_repo`) to pull
  related code. `search_repo` searches the **PR head ref** (not the default branch) — new code
  in the PR is findable. Memory is writeable via `/remember` and `/feedback` commands (maintainer-
  gated). Read-only; untrusted PR code is never executed.

## Non-goals

No auto-fix, no auto-merge, no auto-approve — comments only.
