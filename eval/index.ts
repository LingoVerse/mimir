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
import * as v from "valibot";
import { runFixture, loadSkills, computeRecall } from "./runner.ts";
import { judgeFindings, computePrecision } from "./judge.ts";
import { renderReport } from "./report.ts";
import { EvalFixtureSchema, type EvalResult } from "./types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

function printHelp(): void {
  console.log(`
Usage: node eval/index.ts [options]

Options:
  --model <slug>        Model to evaluate (default: MODEL_PRIMARY env or gemini-3-flash-preview)
  --fixture <id>        Run single fixture by id prefix (e.g. "001")
  --no-judge            Skip LLM judge scoring (faster/cheaper)

Environment:
  OPENROUTER_API_KEY    Required
  MODEL_PRIMARY         Primary model slug
  MODEL_ESCALATION      Escalation model slug
  EVAL_JUDGE_MODEL      Judge model (default: MODEL_PRIMARY or gemini-3-flash-preview)
`);
}

function parseArgs(): { model: string; fixtureId?: string; noJudge: boolean; help: boolean } {
  const args = process.argv.slice(2);
  let model = process.env.MODEL_PRIMARY ?? "openrouter/google/gemini-3-flash-preview";
  let fixtureId: string | undefined;
  let noJudge = false;
  let help = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--model" && args[i + 1]) {
      model = args[++i] as string;
    } else if (args[i] === "--fixture" && args[i + 1]) {
      fixtureId = args[++i];
    } else if (args[i] === "--no-judge") {
      noJudge = true;
    } else if (args[i] === "--help" || args[i] === "-h") {
      help = true;
    }
  }
  return { model, fixtureId, noJudge, help };
}

function loadFixture(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function validateFixture(raw: unknown, fileName: string): v.InferOutput<typeof EvalFixtureSchema> {
  const result = v.safeParse(EvalFixtureSchema, raw);
  if (!result.success) {
    const flat = v.flatten(result.issues);
    const errors = [
      ...(flat.root ?? []),
      ...Object.entries(flat.nested ?? {}).map(
        ([path, msgs]) => `${path}: ${(msgs ?? []).join(", ")}`,
      ),
    ].join("; ");
    throw new Error(`Fixture validation failed for ${fileName}: ${errors}`);
  }
  return result.output;
}

function loadFixtures(fixtureId?: string): v.InferOutput<typeof EvalFixtureSchema>[] {
  const dir = join(__dirname, "fixtures");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const selected = fixtureId ? files.filter((f) => f.startsWith(fixtureId)) : files;
  return selected.map((f) => validateFixture(loadFixture(join(dir, f)), f));
}

async function main(): Promise<void> {
  const { model, fixtureId, noJudge, help } = parseArgs();

  if (help) {
    printHelp();
    return;
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error("OPENROUTER_API_KEY is required");
    process.exit(1);
  }

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

      const judgeScores = noJudge ? [] : await judgeFindings(fixture, review, judgeModel, apiKey);

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
        escalated: false,
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

  // Aggregate errors: still report partial results, exit 1 only if zero successes.
  if (results.length === 0) {
    process.exit(1);
  }
}

await main();
