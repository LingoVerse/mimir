# Mimir — PR Review Agent · Build Spec (for Claude Code)

> **Mimir** — in Norse myth, the wise severed head Odin consults before every decision.
> A reviewer is exactly "the source of counsel you consult before merging." And a head
> with no body = _headless_, which is precisely how Flue describes itself. The name is the
> architecture.
>
> Standalone Flue agent that reviews GitHub pull requests. Self-hosted, model-agnostic
> via OpenRouter, dual-model (cheap first pass → escalate on hard diffs). Replacement for
> the consumer Gemini Code Assist GitHub reviewer (full shutdown 2026-07-17).

## 0. Read this first

Flue is **1.0 beta** and moving fast. Before implementing any API below, verify the exact
current signatures against the live docs — do NOT assume this spec is byte-accurate:

- Models / providers: https://flueframework.com/docs/guide/models/
- GitHub channel: https://flueframework.com/docs/ecosystem/channels/github/
- Workflows: https://flueframework.com/docs/guide/workflows/
- Project layout: https://flueframework.com/docs/guide/project-layout/
- Routing: https://flueframework.com/docs/guide/routing/

Use `flue add channel github` to generate the official GitHub blueprint, then adapt it to
this spec rather than hand-writing ingress from scratch.

## 1. Goal & constraints

- **What it does:** on a new/updated PR, fetch the diff, review it against a markdown
  rubric, post a summary comment + inline line comments. Read-only on code (no auto-fix,
  no auto-merge, no auto-approve). It comments; humans decide.
- **Models:** NO Anthropic / no lab lock-in. Everything through **OpenRouter**.
  Dual-model is mandatory: a cheap model reviews every PR, a stronger model is only
  invoked for diffs flagged as hard. Exact model slugs are config, not code.
- **Hosting:** self-host (Hetzner/Dokploy) on Node, or deploy to Cloudflare Workers /
  GitHub Actions later. No managed-runtime dependency.
- **Repo:** **standalone repo**, NOT inside the Lingoverse monorepo. Keep CI tooling
  separate from the product. (Decision already made — do not add it to the monorepo.)

## 2. Stack

- Flue 1.0 beta (`@flue/runtime`, `@flue/github`)
- `@octokit/rest` for outbound GitHub API calls
- OpenRouter as the single LLM gateway (OpenAI-compatible endpoint)
- TypeScript
- **Runtime caveat:** Flue's documented minimum is Node `>=22.19.0`. Try Bun first
  (preferred toolchain), but if the Flue runtime or `@flue/github` misbehaves under Bun,
  fall back to Node 22 LTS without spending more than ~30 min debugging. Record which one
  you settled on in the README.

## 3. Directory layout

```
mimir/
  src/
    app.ts                          # provider registration + Flue mount
    channels/
      github.ts                     # verified webhook ingress + octokit client
    workflows/
      review-pr.ts                  # the deterministic review pipeline
    lib/
      diff.ts                       # fetch + chunk PR diff
      escalation.ts                 # decide cheap vs strong model
      post-review.ts                # assemble + post summary & line comments
      dedup.ts                      # claim delivery IDs (idempotency)
  .agents/skills/
    review-rubric/SKILL.md          # general review criteria (provided)
    security-check/SKILL.md         # security-focused pass (provided)
  .env.example
  README.md
  package.json
```

> Note: Flue discovers workflows by flat filename in `workflows/` and channels by file in
> `channels/`. Keep those dirs flat; everything else goes under `lib/`. Confirm the exact
> skills discovery path against current docs — it has been referenced as both
> `.agents/skills/<name>/SKILL.md` and `skills/<name>/SKILL.md`. Use whatever the live
> docs say; adjust the layout above accordingly.

## 4. OpenRouter provider registration

OpenRouter is not a built-in Flue provider, so register it as an OpenAI-compatible
provider in `app.ts`. Then model specifiers take the form `openrouter/<openrouter-model-slug>`.

```ts
// src/app.ts
import { registerProvider } from "@flue/runtime";
import { flue } from "@flue/runtime/routing";
import { Hono } from "hono";

registerProvider("openrouter", {
  api: "openai-completions",
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
  // OpenRouter ranking headers are optional but recommended:
  headers: {
    "HTTP-Referer": process.env.OPENROUTER_REFERER ?? "https://github.com",
    "X-Title": "mimir",
  },
});

const app = new Hono();
app.route("/", flue());
export default app;
```

**Verify:** the exact field names (`api` vs `transport`, `baseUrl` vs `baseURL`,
`apiKey` placement) against the live models doc — beta APIs drift. The Ollama example in
the docs is the canonical reference for the `registerProvider` shape.

**Model specifier format:** OpenRouter slugs already contain a slash
(e.g. `z-ai/glm-...`, `google/gemini-...`), so the full Flue specifier is
`openrouter/z-ai/glm-...`. Confirm Flue splits the provider ID on the _first_ slash only.
If it doesn't, fall back to `configureProvider('openrouter', ...)` or a thin alias map.

## 5. Dual-model pattern

Two env-configured tiers. Do not hardcode slugs — OpenRouter renames/deprecates models.

| Tier       | Env var            | Role               | Example slug (VERIFY on OpenRouter)                      |
| ---------- | ------------------ | ------------------ | -------------------------------------------------------- |
| Primary    | `MODEL_PRIMARY`    | reviews every PR   | `openrouter/z-ai/glm-5.2`                                |
| Escalation | `MODEL_ESCALATION` | only on hard diffs | `openrouter/google/gemini-flash-3` (or a stronger model) |

> The user's note: GLM 5.2 and Gemini Flash 3 both performed well on review. Treat both as
> swappable. The point is the _pattern_, not the specific models. Look up exact current
> slugs in the OpenRouter model catalog at build time.

**Escalation heuristic** (`lib/escalation.ts`) — escalate to `MODEL_ESCALATION` when ANY:

1. Total changed lines > `ESCALATION_DIFF_THRESHOLD` (default 400).
2. Diff touches a security-sensitive path (auth, crypto, payments, `**/migrations/**`,
   `**/*.sql`, dependency manifests, CI config, Dockerfiles, IaC).
3. Primary pass self-reports low confidence (ask the primary model to emit a
   `confidence: low|medium|high` field; escalate on `low`).
4. Primary pass flags a `critical` severity finding (double-check critical claims with the
   stronger model before posting, to cut false positives).

Otherwise the primary pass result is final. Log every escalation decision + reason so cost
and escalation rate are observable.

## 6. GitHub channel (`channels/github.ts`)

Generate via `flue add channel github`, then wire to this spec.

**Subscribe to the minimum event set:**

- `pull_request` (`opened`, `synchronize`, `reopened`) — triggers a review
- `pull_request_review_comment` and `issue_comment` — optional, for `/review` re-trigger commands

**Hard requirements from the docs — do not skip:**

- **10-second / 202 rule:** GitHub expects a 2xx within ~10s and does NOT auto-retry. The
  webhook handler must admit the review as durable work and return fast — never block the
  HTTP response on the LLM calls. Run the actual review inside the `review-pr` workflow.
- **Idempotency:** the channel is stateless and does NOT dedupe delivery IDs. Claim
  `delivery.deliveryId` in storage (a small KV/SQLite table or Redis) BEFORE dispatch; skip
  if already claimed. Implement in `lib/dedup.ts`.
- **PR comments:** PRs use their issue number for issue-level comments. Inline line comments
  use the PR review comments API (needs commit SHA + file path + line/position). Keep these
  two paths distinct in `post-review.ts`.
- **Webhook secret:** set a webhook secret, content type `application/json` only
  (form-encoded is rejected). Keep secrets in env, never committed.

## 7. Review workflow (`workflows/review-pr.ts`)

Deterministic pipeline (Flue Workflow, not a free agent loop). Steps:

1. **Resolve PR** — owner/repo/number/head SHA from the channel event payload (passed by
   the webhook handler, not re-fetched blindly).
2. **Fetch diff** (`lib/diff.ts`) — via octokit. Chunk by file; skip generated/vendored
   paths (`**/dist/**`, lockfiles, `**/*.min.*`, `**/node_modules/**`). Cap total tokens;
   if the diff is enormous, review top-N most significant files and note truncation.
3. **Load skills** — `review-rubric` always; `security-check` when security-sensitive paths
   are touched.
4. **Primary pass** — `MODEL_PRIMARY` over the (chunked) diff + rubric. Structured output:
   `{ summary, confidence, findings: [{ file, line, severity, title, body, suggestion? }] }`.
   Severity ∈ `critical|major|minor|nit`.
5. **Escalation decision** (`lib/escalation.ts`) — per §5. If escalating, re-run the
   relevant chunks (or whole diff) on `MODEL_ESCALATION` and merge/replace findings.
6. **Post review** (`lib/post-review.ts`) — one summary comment (verdict + counts), inline
   comments for `critical`/`major`/`minor`. Suppress `nit` by default behind a
   `POST_NITS=false` flag to avoid noise. Idempotent: if re-running on `synchronize`,
   prefer updating the prior summary comment over stacking new ones (store its comment ID).

Durable execution means a runtime restart mid-review resumes rather than double-posting —
but still rely on the dedup claim (§6) as the primary guard.

## 8. Environment variables (`.env.example`)

```
# LLM
OPENROUTER_API_KEY=
OPENROUTER_REFERER=https://github.com
MODEL_PRIMARY=openrouter/z-ai/glm-5.2          # VERIFY slug on OpenRouter
MODEL_ESCALATION=openrouter/google/gemini-flash-3  # VERIFY slug on OpenRouter
ESCALATION_DIFF_THRESHOLD=400

# GitHub
GITHUB_WEBHOOK_SECRET=
GITHUB_APP_TOKEN=        # or App ID + private key if using a GitHub App (preferred for orgs)

# Behavior
POST_NITS=false

# Storage (for dedup + comment-ID tracking)
DATABASE_URL=           # sqlite/postgres/redis — your call; keep it tiny
```

> Note the seven-ish env vars mirror the Lingoverse env-var convention deliberately — keep
> all model selection in env so swapping GLM ↔ Gemini ↔ anything is a config change.

## 9. Phased task plan

Tiered so cheap models can do the mechanical phases and a stronger one handles design.

- **Phase 0 — scaffold (mechanical):** `npx eve@latest`?? NO — `npx flue` / `flue init`.
  Init the Flue project, add deps, set up TS + lint, commit `.env.example`. Decide Bun vs Node.
  Package name in `package.json` is exactly `mimir` (unscoped, lowercase) — do not invent a scope.
- **Phase 1 — provider + channel (mechanical→design):** OpenRouter `registerProvider`;
  `flue add channel github`; webhook secret; verify a ping event returns 202 fast.
- **Phase 2 — dedup + diff (mechanical):** `lib/dedup.ts`, `lib/diff.ts` with octokit,
  path filtering, chunking.
- **Phase 3 — review workflow (design):** `workflows/review-pr.ts` primary pass with
  structured output; load skills.
- **Phase 4 — dual-model (design):** `lib/escalation.ts` heuristics + escalation pass;
  log decisions.
- **Phase 5 — posting (mechanical→design):** `lib/post-review.ts` summary + inline comments,
  nit suppression, comment-ID update on `synchronize`.
- **Phase 6 — deploy:** Dockerfile + Dokploy on Hetzner (Node), or Cloudflare Workers target.
  Smoke-test against a throwaway repo PR.

## 10. Non-goals (explicit)

- No auto-fix / no pushing commits (that's the Daytona bug-fix variant — different agent).
- No auto-approve / no auto-merge. Comments only.
- No running the repo's test suite in Phase 1 (would require a sandbox — add later as an
  opt-in escalation step if desired).
- Do not add this to the Lingoverse monorepo.

## 11. Acceptance check

- Open a PR on a test repo → agent posts a summary + at least the correct inline comments
  within ~1–2 min.
- Push a second commit (`synchronize`) → agent updates rather than duplicates.
- Re-deliver the same webhook (replay) → no duplicate review (dedup works).
- A >400-line or auth-touching diff → logs show escalation to `MODEL_ESCALATION`.
- Swapping `MODEL_PRIMARY` to a different OpenRouter slug → works with zero code change.
