# Mimir — PR Review Agent

A standalone [Flue](https://flueframework.com) agent that reviews GitHub pull requests:
fetch the diff, review it against a markdown rubric, post a summary comment + inline line
comments. Read-only on code — it comments; humans decide. Model-agnostic via OpenRouter,
dual-model (cheap primary pass → escalate to a stronger model on hard diffs).

Replacement for the consumer Gemini Code Assist GitHub reviewer (shutdown 2026-07-17).

## Toolchain

- **Runtime / package manager:** Bun `1.3.14`. Flue's documented minimum is Node `>=22.19.0`;
  per the build spec we tried Bun first. `bun add` of `@flue/runtime` + `@flue/cli` and
  `flue init` / `flue docs` / typecheck / lint all work under Bun. **Deploy target is `node`**
  (`flue.config.ts` → `target: 'node'`); Bun is only the local dev toolchain.
- **Open watch-item:** Bun blocked the lifecycle scripts of three native transitive deps of
  `@flue/runtime` — `node-liblzma`, `@mongodb-js/zstd`, `protobufjs`. They are not exercised
  yet (Phase 0 does not run the runtime). If `flue dev` / `@flue/github` misbehave under Bun
  in Phase 1, either `bun pm trust` those packages or fall back to Node 22 LTS — do not spend
  more than ~30 min before falling back (build spec §2).

## Project layout

Flue resolves its source-discovery root as `.flue/` → `src/` → project root (Configuration
ref). We use `src/`, so the build-spec layout holds:

```
src/
  app.ts          # OpenRouter provider registration + Flue mount   (Phase 1)
  channels/
    github.ts     # verified webhook ingress + octokit client       (Phase 1)
  workflows/
    review-pr.ts  # deterministic review pipeline                   (Phase 3)
  lib/
    diff.ts  dedup.ts  escalation.ts  post-review.ts                (Phase 2/4/5)
flue.config.ts    # target: 'node'
```

Workflows and channels are discovered by flat filename inside their dirs; keep those dirs
flat (nested files are not discovered). Everything else goes under `src/lib/`.

## Setup

```bash
bun install
cp .env.example .env   # fill in OpenRouter + GitHub secrets
```

Scripts: `bun run dev` (flue watch server), `bun run build`, `bun run typecheck`, `bun run lint`,
`bun run format`.

## Status

- **Phase 0 — scaffold: done.** Flue project initialized (`@flue/runtime@1.0.0-beta.2`,
  `@flue/cli@1.0.0-beta.1`), Bun toolchain, TS (`tsc --noEmit`) + Biome lint, `.env.example`.
- Phases 1–6 (provider + channel, dedup + diff, review workflow, dual-model, posting, deploy)
  not yet started.

### Verified against live docs (build-spec §0 gates)

- `flue init --target node` is the real init command; CLI surface confirmed via `flue --help`.
- `registerProvider` shape (`api: 'openai-completions'`, `baseUrl`, `apiKey`, `headers`) matches
  the spec — confirmed against the Ollama example in the models doc.
- Model specifier format is `provider-id/model-id`. Flue's model layer is **Pi** (`pi.dev`).
- Source-discovery root rule (`.flue/` → `src/` → root) confirms the `src/` layout.

### Still to verify before/in Phase 1 (do not assume)

- Whether Flue splits the provider ID on the **first** slash only, so `openrouter/z-ai/glm-...`
  routes to provider `openrouter` with model `z-ai/glm-...` (build-spec §4).
- The GitHub channel API — generate with `flue add channel github` and adapt (build-spec §6).
- Exact skills discovery path (`.agents/skills/<name>/SKILL.md` vs `skills/<name>/SKILL.md`).
  Provided skills live in `specs/SKILL.review-rubric.md` and `specs/SKILL.security-check.md`.
