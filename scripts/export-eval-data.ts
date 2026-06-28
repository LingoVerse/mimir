#!/usr/bin/env node
// Exports stored review runs and their findings from SQLite to JSON.
// Useful for offline analysis once the agent has accumulated real PR data.
//
// Usage:
//   node scripts/export-eval-data.ts > data/reviews.json
//   node scripts/export-eval-data.ts --limit 50 > data/reviews.json

import { writeFileSync } from "node:fs";
import { SqliteDedupStore } from "../src/lib/dedup.ts";

function parseArgs(): { limit: number; outFile?: string } {
  const args = process.argv.slice(2);
  let limit = 100;
  let outFile: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--limit" && args[i + 1]) {
      limit = parseInt(args[++i] as string, 10);
    } else if (args[i] === "--out" && args[i + 1]) {
      outFile = args[++i];
    }
  }
  return { limit, outFile };
}

const { limit, outFile } = parseArgs();
const store = new SqliteDedupStore();
const data = store.exportRunsWithFindings(limit);
const stats = store.getStats();

const output = {
  exportedAt: new Date().toISOString(),
  stats,
  runs: data,
};

const json = JSON.stringify(output, null, 2);
if (outFile) {
  writeFileSync(outFile, json, "utf8");
  console.log(`Exported ${data.length} runs to ${outFile}`);
} else {
  process.stdout.write(json + "\n");
}
