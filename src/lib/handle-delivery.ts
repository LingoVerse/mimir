import type { ReviewPayload } from "./instruction.ts";

// Orchestrates one pull_request delivery end-to-end: claim → admit → release on
// failure. Pure (the admit step is injected), so it is unit-tested without
// importing the channel — and therefore without loading the workflow/skill graph
// (skill `.md` imports need Flue's loader, absent under plain `node --test`).
export async function handlePullRequestDelivery(
  deps: {
    claim: (id: string) => Promise<boolean>;
    release: (id: string) => Promise<void>;
    admit: (pr: ReviewPayload) => Promise<void>;
  },
  deliveryId: string,
  pr: ReviewPayload,
): Promise<boolean> {
  if (!(await deps.claim(deliveryId))) {
    console.log("[mimir] duplicate delivery skipped", deliveryId);
    return false;
  }
  try {
    await deps.admit(pr);
    return true;
  } catch (err) {
    await deps.release(deliveryId);
    console.log("[mimir] admit failed; released claim for retry", deliveryId);
    throw err;
  }
}
