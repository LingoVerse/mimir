#!/usr/bin/env node
// Eval pipeline entry point.
//
// Usage:
//   node eval/index.ts                        # run all fixtures, primary model
//   node eval/index.ts --model openrouter/z-ai/glm-5.2  # specific model
//   node eval/index.ts --fixture 001          # single fixture
//   node eval/index.ts --no-judge             # skip judge scoring (faster/cheaper)
//
// Required env: OPENROUTER_API_KEY
// Optional env: MODEL_PRIMARY, MODEL_ESCALATION, EVAL_JUDGE_MODEL

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runFixture, loadSkills, computeRecall } from "./runner.ts";
import { judgeFindings, computePrecision } from "./judge.ts";
import { renderReport } from "./report.ts";
import type { EvalFixture, EvalResult } from "./types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs(): { model: string; fixtureId?: string; noJudge: boolean } {
  const args = process.argv.slice(2);
  let model =
    process.env.MODEL_PRIMARY ?? "openrouter/google/gemini-3-flash-preview";
  let fixtureId: string | undefined;
  let noJudge = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--model" && args[i + 1]) {
      model = args[++i] as string;
    } else if (args[i] === "--fixture" && args[i + 1]) {
      fixtureId = args[++i];
    } else if (args[i] === "--no-judge") {
      noJudge = true;
    }
  }
  return { model, fixtureId, noJudge };
}

function loadFixtures(fixtureId?: string): EvalFixture[] {
  const dir = join(__dirname, "fixtures");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const selected = fixtureId
    ? files.filter((f) => f.startsWith(fixtureId))
    : files;
  return selected.map((f) =>
    JSON.parse(readFileSync(join(dir, f), "utf8")) as EvalFixture,
  );
}

async function main(): Promise<void> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error("OPENROUTER_API_KEY is required");
    process.exit(1);
  }

  const { model, fixtureId, noJudge } = parseArgs();
  const judgeModel =
    process.env.EVAL_JUDGE_MODEL ??
    process.env.MODEL_PRIMARY ??
    "openrouter/google/gemini-3-flash-preview";

  const fixtures = loadFixtures(fixtureId);
  if (fixtures.length === 0) {
    console.error("No fixtures found");
    process.exit(1);
  }

  console.log(`Running ${fixtures.length} fixture(s) with model: ${model}`);
  if (!noJudge) console.log(`Judge model: ${judgeModel}`);
  console.log("");

  // Load SKILL.md files once — reused for every fixture.
  const skills = loadSkills();

  const results: EvalResult[] = [];
  let errorCount = 0;

  for (const fixture of fixtures) {
    process.stdout.write(`  [${fixture.id}] ${fixture.name} ... `);
    try {
      const { review, durationMs } = await runFixture(fixture, model, apiKey, skills);
      const recall = computeRecall(fixture, review);

      const judgeScores = noJudge
        ? []
        : await judgeFindings(fixture, review, judgeModel, apiKey);

      // NaN signals "not measured" to the report formatter.
      const precision = noJudge ? NaN : computePrecision(judgeScores, review.findings.length);
      const avgRelevance =
        judgeScores.length > 0
          ? judgeScores.reduce((a, s) => a + s.score, 0) / judgeScores.length
          : NaN;

      results.push({
        fixtureId: fixture.id,
        fixtureName: fixture.name,
        model,
        escalated: false, // direct eval doesn't trigger escalation logic
        precision,
        recall,
        avgRelevance,
        findingCount: review.findings.length,
        durationMs,
        judgeScores,
      });
      console.log(
        `done (${review.findings.length} findings, recall ${(recall * 100).toFixed(0)}%, ${durationMs}ms)`,
      );
    } catch (err) {
      errorCount++;
      console.log(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log("\n" + renderReport(results));

  if (results.length === 0) {
    process.exit(1);
  }
}

await main();
