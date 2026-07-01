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
app.get("/admin", (c) => {
  const store = getReviewRunStore();
  const stats = store.getStats();
  const runs = store.getRecentRuns(20);
  return c.html(renderAdminHtml(stats, runs));
});

export default app;
