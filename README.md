# Mimir — PR Review Agent

A standalone [Flue](https://flueframework.com) agent that reviews GitHub pull requests:
fetch the diff, review it against a markdown rubric, post a summary comment + inline line
comments. Read-only on code — it comments; humans decide. Model-agnostic via OpenRouter,
dual-model (cheap primary pass → escalate to a stronger model on hard diffs).

Replacement for the consumer Gemini Code Assist GitHub reviewer (shutdown 2026-07-17).

## Toolchain

- **Bun is the package manager + script runner; the runtime is Node.** Flue's minimum is
  Node `>=22.19.0`. We use `bun install` / `bun run`, but `flue` itself runs under **Node**:
  the `flue` bin is `#!/usr/bin/env node`, so `bun run dev/build` dispatches it to Node.
  **Deploy target is `node`** (`flue.config.ts` → `target: 'node'`).
- **Bun cannot run Flue as a runtime (verified empirically).** A Bun-only Docker image
  (`oven/bun`, no real Node) fails `flue build --target node` with
  `SyntaxError: Export named 'registerHooks' not found in module 'node:module'` — `@flue/cli`
  needs Node's `node:module.registerHooks`, which Bun 1.3.14 lacks. So building/serving under
  Bun-only is not possible today; this is why dedup uses `node:sqlite` (not `bun:sqlite`).
- **Native postinstalls:** Bun blocks lifecycle scripts of three native transitive deps of
  `@flue/runtime` (`node-liblzma`, `@mongodb-js/zstd`, `protobufjs`). They never bit through
  Phase 2 (`flue build`/`dev` run the server under Node, which ships prebuilt binaries).

## Project layout

Flue resolves its source-discovery root as `.flue/` → `src/` → project root (Configuration
ref). We use `src/`, so the build-spec layout holds:

```
src/
  channels/
    github.ts     # verified webhook ingress + octokit client       (Phase 1 ✓)
  workflows/
    review-pr.ts  # admission target + skeleton (Phase 1 ✓);
                  #   deterministic pipeline body                    (Phase 3)
  lib/
    diff.ts  dedup.ts  escalation.ts  post-review.ts                (Phase 2/4/5)
flue.config.ts    # target: 'node'
```

No `src/app.ts`: `openrouter` is a **built-in** Flue provider (no `registerProvider`
needed — just `OPENROUTER_API_KEY`), and without `app.ts` Flue auto-mounts its routes at
`/` and discovers `channels/github.ts` → `POST /channels/github/webhook`. Add `app.ts`
only later if a custom route is needed (e.g. `/health` for deploy).

Workflows and channels are discovered by flat filename inside their dirs; keep those dirs
flat (nested files are not discovered). Everything else goes under `src/lib/`.

## Setup

```bash
bun install
cp .env.example .env   # fill in OpenRouter + GitHub secrets
```

Scripts: `bun run dev` (flue watch server), `bun run build`, `bun run typecheck`,
`bun run test` (node --test), `bun run lint`, `bun run format`.

## Status

- **Phase 0 — scaffold: done.** Flue project initialized (`@flue/runtime@1.0.0-beta.2`,
  `@flue/cli@1.0.0-beta.1`), Bun toolchain, TS (`tsc --noEmit`) + oxlint/oxfmt, `.env.example`.
- **Phase 1 — provider + channel: done.** `openrouter` confirmed built-in (no provider code);
  `@flue/github` + `@octokit/rest@22.0.1` installed; `channels/github.ts` verifies webhooks and
  admits PR events fast; `review-pr` workflow skeleton added so the app boots. Live-tested
  against `flue dev`: valid ping → **200 in ~17ms**, bad signature → **401**, `pull_request`
  opened → **200 in ~3ms** (hits the review seam), form-encoded → **415** (JSON-only).
- **Phase 2 — dedup + diff: done.** `lib/dedup.ts` claims `deliveryId` in SQLite (`node:sqlite`,
  zero native deps) and is wired into the channel before any work; `lib/diff.ts` fetches the
  per-file diff via octokit, drops generated/vendored paths, and caps to a token budget
  (largest-change files first, truncation reported). Unit tests via `node --test` (5 pass) and a
  live replay check: same `deliveryId` twice → second skipped; distinct id → reviewed.
- Phases 3–6 (review workflow body, dual-model, posting, deploy) not yet started.

### Verified against live docs (build-spec §0 gates)

- `flue init --target node` is the real init command; CLI surface confirmed via `flue --help`.
- Model layer is **Pi** (`pi.dev`); model specifier is `provider-id/model-id`. `openrouter` is a
  **built-in provider** (env `OPENROUTER_API_KEY`) — the spec's §4 `registerProvider` + Hono
  `app.ts` is unnecessary.
- Provider ID splits on the **first** slash: `openrouter/z-ai/glm-5.2` → provider `openrouter`,
  model `z-ai/glm-5.2` (models-doc table) — no alias map needed (resolves build-spec §4 gate).
- Source-discovery root rule (`.flue/` → `src/` → root) confirms the `src/` layout.
- GitHub channel API confirmed via `flue add channel github` blueprint: `createGitHubChannel`,
  path `/channels/github/webhook`, `delivery.{name,payload,deliveryId}`, outbound auth via
  `GITHUB_TOKEN` (renamed from the spec's `GITHUB_APP_TOKEN`).
- Workflows export `run(ctx)` + optional `route`; admit via `flue run` or `POST /workflows/<name>`
  → `202 { runId }`. A channel must **not** call `run()` directly — it admits through the route.

### Still to verify (Phase 3)

- Exact skills discovery path (`.agents/skills/<name>/SKILL.md` vs `skills/<name>/SKILL.md`).
  Provided skills live in `specs/SKILL.review-rubric.md` and `specs/SKILL.security-check.md`.
- Channel → `review-pr` workflow admission wiring (durable handoff from the webhook).
