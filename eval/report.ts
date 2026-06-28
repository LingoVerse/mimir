// Formats eval results as a markdown table.

import type { EvalResult } from "./types.ts";

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

function fmt(n: number, decimals = 2): string {
  return n.toFixed(decimals);
}

export function renderReport(results: EvalResult[]): string {
  if (results.length === 0) return "No results.";

  const header = [
    "| Fixture | Model | Precision | Recall | Relevance | Findings | Escalated | ms |",
    "| ------- | ----- | --------- | ------ | --------- | -------- | --------- | -- |",
  ];

  const rows = results.map((r) => {
    const modelShort = r.model.replace(/^openrouter\//, "").replace(/^.*\//, "");
    return `| ${r.fixtureId} ${r.fixtureName.slice(0, 30)} | ${modelShort} | ${pct(r.precision)} | ${pct(r.recall)} | ${fmt(r.avgRelevance, 1)} | ${r.findingCount} | ${r.escalated ? "yes" : "no"} | ${r.durationMs} |`;
  });

  const avg = {
    precision: results.reduce((a, r) => a + r.precision, 0) / results.length,
    recall: results.reduce((a, r) => a + r.recall, 0) / results.length,
    relevance: results.reduce((a, r) => a + r.avgRelevance, 0) / results.length,
  };

  const summary = [
    "",
    `**Averages across ${results.length} fixtures:** precision ${pct(avg.precision)} · recall ${pct(avg.recall)} · relevance ${fmt(avg.relevance, 1)}/5`,
  ];

  return [...header, ...rows, ...summary].join("\n");
}
