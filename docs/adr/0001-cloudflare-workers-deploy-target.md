# ADR 0001 — Cloudflare Workers as a second deploy target

- **Status:** Accepted (2026-07-02)
- **Commits:** `2cf6590` (cleanup+security), `c939364` (CF target), `899611f` (c.env binding fix)

## Context

Mimir shipped as a Node/Docker service using `node:sqlite` for its app store
(delivery dedup, summary-comment ids, review stats). We want it on Cloudflare
Workers (each workflow → Durable Object) **without dropping Docker** — all current
users are on Docker; Cloudflare is additive and proposed upstream, so zero Docker
regression is a hard requirement.

## Decisions

1. **Two targets, one codebase.** Docker/Node stays recommended; Cloudflare is a
   first-class additive option (`flue build --target {node|cloudflare}`).

2. **App store = Cloudflare D1** (not a dedicated Durable Object or KV). D1 is
   SQLite too, so the SQL + 3-table schema mirror the Node backend near-verbatim →
   minimal divergence, easy review. Dedup stays atomic via `INSERT OR IGNORE` +
   `meta.changes`. KV rejected (eventually consistent, no aggregates); dedicated DO
   rejected (structurally different second impl + RPC boilerplate).

3. **Backend chosen at runtime via `#app-store` subpath import** (package.json
   `imports`, `workerd` condition): `dedup.node.ts` (node:sqlite) on Node,
   `dedup.d1.ts` (D1) on Cloudflare. Keeps `node:sqlite` out of the CF bundle and
   D1 out of the Node bundle (verified on both). The store interface is `async` so
   one contract fits both.

4. **Admission via ambient `invoke()`** instead of a loopback HTTP self-POST.
   Removed `INTERNAL_BASE_URL` + loopback guard and dropped the `route` export from
   workflows — closing the previously **unauthenticated `POST /workflows/*`**
   endpoints (could trigger reviews / burn tokens). Target-agnostic.

5. **Admin dashboard → `app.ts` route** (`GET /admin`), out of `workflows/` (where
   it spuriously generated a `FlueAdminWorkflow` DO). Optional `ADMIN_TOKEN` bearer
   gate — the Worker URL is public.

## Consequences

- **`getCloudflareContext()` only works inside Flue-dispatched work (Durable
  Objects), not main-worker Hono routes.** So main-worker code (GitHub channel +
  `app.ts` routes) resolves the D1 binding from Hono `c.env.DB`; workflow code (in a
  DO) uses `getCloudflareContext()`. The store factory takes an optional binding to
  serve both.
- **Deps:** `agents` as `optionalDependency` (Docker users don't pull it);
  `wrangler`, `@cloudflare/workers-types`, `@cloudflare/vitest-pool-workers` as dev.
- **Tests:** node backend under `node --test`; D1 backend in workerd via
  `bun run test:cf` (miniflare + D1).
- **Cloudflare specifics:** Workers Paid plan (DOs); D1 schema in `migrations/`;
  DO migrations in `wrangler.jsonc` (append-only; one class per workflow +
  `FlueRegistry`); secrets via `wrangler secret put`. `DATABASE_URL` is Node-only;
  Cloudflare uses the `DB` binding. oxfmt ignores `wrangler.jsonc`.

## Verification

typecheck/lint clean; **node 88/88 + CF 5/5** (workerd); both builds isolate the
backends; deployed Worker: `GET /admin` 200, webhook (no sig) 401, removed
`POST /workflows/*` 404.
