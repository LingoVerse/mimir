import type { ReviewRunRecord } from "./dedup.ts";

export interface AdminStats {
  totalRuns: number;
  totalCost: number;
  avgCost: number;
}

// Pure render of the admin dashboard: review-run history + aggregate stats.
// Kept separate from the route handler (app.ts) so it is trivially unit-testable.
export function renderAdminHtml(stats: AdminStats, runs: ReviewRunRecord[]): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Mimir admin</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{font-family:-apple-system,sans-serif;max-width:960px;margin:2em auto;padding:0 1em}
  table{border-collapse:collapse;width:100%}
  th,td{text-align:left;padding:6px 12px;border-bottom:1px solid #ddd}
  th{background:#f5f5f5}
  .badge{display:inline-block;padding:1px 6px;border-radius:3px;font-size:.8em}
  .badge-yes{background:#ffe0e0}
  .badge-no{background:#e0ffe0}
</style></head>
<body>
<h1>Mimir review runs</h1>
<p><strong>${stats.totalRuns}</strong> total runs · <strong>$${stats.totalCost.toFixed(4)}</strong> total cost · <strong>$${stats.avgCost.toFixed(4)}</strong> avg/run</p>
<table>
<thead><tr>
<th>PR</th><th>Primary</th><th>Escalation</th><th>Files</th><th>Lines</th><th>Cost</th><th>Esc</th><th>Reasons</th><th>Time</th>
</tr></thead>
<tbody>
${runs
  .map(
    (r) => `<tr>
  <td>${r.prKey}</td>
  <td>${r.primaryModel.split("/").pop()}</td>
  <td>${r.escalationModel?.split("/").pop() ?? "—"}</td>
  <td>${r.fileCount}</td>
  <td>${r.changedLines}</td>
  <td>$${(r.primaryCostUsd + (r.escalationCostUsd ?? 0)).toFixed(4)}</td>
  <td><span class="badge ${r.escalated ? "badge-yes" : "badge-no"}">${r.escalated ? "yes" : "no"}</span></td>
  <td>${r.escalationReasons || "—"}</td>
  <td>${new Date(r.createdAt).toLocaleString()}</td>
</tr>`,
  )
  .join("\n")}
</tbody></table>
</body></html>`;
}
