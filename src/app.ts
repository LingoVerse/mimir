import { flue } from "@flue/runtime/routing";
import { renderAdminHtml } from "./lib/admin-html.ts";
import { getReviewRunStore } from "./lib/dedup.ts";

// Extend Flue's composed app with our own routes. We add to the Hono instance
// that flue() returns (rather than mounting flue() under a fresh `new Hono()`)
// so there is a single Hono instance — a fresh one would come from a different
// resolved copy of `hono` than @flue/runtime's and clash on types.
const app = flue();

// Admin dashboard: review-run history + stats. Previously a route-only file
// under workflows/ — which on Cloudflare spuriously generated a Durable Object
// class (FlueAdminWorkflow) for what is a plain read-and-render endpoint. It is
// an application route, not a workflow, so it lives here.
app.get("/admin", async (c) => {
  // Optional gate: when ADMIN_TOKEN is set, require it (the Worker URL is public
  // on Cloudflare). Unset → open, preserving the Docker/Node default.
  const token = process.env.ADMIN_TOKEN;
  if (token && c.req.header("authorization") !== `Bearer ${token}`) {
    return c.text("Unauthorized", 401);
  }
  // On Cloudflare this route runs in the main worker (outside Flue's context), so
  // the D1 binding comes from Hono's c.env, not getCloudflareContext(). On Node
  // c.env has no DB and the store falls back to node:sqlite.
  const store = getReviewRunStore((c.env as { DB?: unknown } | undefined)?.DB);
  const stats = await store.getStats();
  const runs = await store.getRecentRuns(20);
  return c.html(renderAdminHtml(stats, runs));
});

export default app;
