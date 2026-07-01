// Formats eval results as a markdown table.

import type { EvalResult } from "./types.ts";

function pct(n: number): string {
  if (isNaN(n)) return "—";
  return `${(n * 100).toFixed(0)}%`;
}

function fmt(n: number, decimals = 2): string {
  if (isNaN(n)) return "—";
  return n.toFixed(decimals);
}

export function renderReport(results: EvalResult[]): string {
  if (results.length === 0) return "No results.";

  const header = [
    "| Fixture | Model | Precision | Recall | Relevance | Findings | Escalated | ms |",
    "| ------- | ----- | --------- | ------ | --------- | -------- | --------- | -- |",
  ];

  const rows = results.map((r) => {
    const modelShort = r.model.replace(/^openrouter\//, "").replace(/^[^/]+\//, "");
    return `| ${r.fixtureId} ${r.fixtureName.slice(0, 30)} | ${modelShort} | ${pct(r.precision)} | ${pct(r.recall)} | ${fmt(r.avgRelevance, 1)} | ${r.findingCount} | ${r.escalated ? "yes" : "no"} | ${r.durationMs} |`;
  });

  // Exclude NaN values (--no-judge runs) from averages.
  function avg(vals: number[]): number {
    const finite = vals.filter((v) => !isNaN(v));
    return finite.length > 0 ? finite.reduce((a, b) => a + b, 0) / finite.length : NaN;
  }

  const avgPrecision = avg(results.map((r) => r.precision));
  const avgRecall = avg(results.map((r) => r.recall));
  const avgRelevance = avg(results.map((r) => r.avgRelevance));

  const summary = [
    "",
    `**Averages across ${results.length} fixtures:** precision ${pct(avgPrecision)} · recall ${pct(avgRecall)} · relevance ${fmt(avgRelevance, 1)}/5`,
  ];

  return [...header, ...rows, ...summary].join("\n");
}
