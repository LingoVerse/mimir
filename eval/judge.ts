// LLM-as-judge scorer. Rates all findings for a fixture in a single API call
// to minimize cost. Uses the same OpenRouter API as the eval runner.

import type { ReviewResult } from "../src/lib/review.ts";
import type { EvalFixture, JudgeScore } from "./types.ts";

function stripModelPrefix(model: string): string {
  return model.replace(/^openrouter\//, "");
}

interface JudgeResponseItem {
  index: number;
  score: number;
  reason: string;
}

function buildJudgePrompt(fixture: EvalFixture, review: ReviewResult): string {
  if (review.findings.length === 0) return "";
  const diffSnippet = fixture.files
    .map((f) => `${f.filename}:\n${f.patch}`)
    .join("\n\n");
  const findingsList = review.findings
    .map(
      (f, i) =>
        `[${i + 1}] ${f.file}${f.line != null ? `:${f.line}` : ""} [${f.severity}]\nTitle: ${f.title}\nBody: ${f.body}`,
    )
    .join("\n\n");

  return [
    "You are a code review quality judge. Rate each finding on a scale of 1-5:",
    "1 = Hallucinated or completely wrong",
    "2 = Real issue but very vague or misidentified location",
    "3 = Correct issue, reasonably specific",
    "4 = Correct, specific, and actionable",
    "5 = Excellent: correct, specific, actionable, with a concrete fix",
    "",
    "The diff being reviewed:",
    "---",
    diffSnippet,
    "---",
    "",
    "Findings to rate:",
    findingsList,
    "",
    'Output a JSON array only, no prose: [{ "index": 1, "score": N, "reason": "one sentence" }, ...]',
  ].join("\n");
}

interface OpenRouterResponse {
  choices: Array<{ message: { content: string } }>;
}

export async function judgeFindings(
  fixture: EvalFixture,
  review: ReviewResult,
  judgeModel: string,
  apiKey: string,
): Promise<JudgeScore[]> {
  if (review.findings.length === 0) return [];

  const prompt = buildJudgePrompt(fixture, review);
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: stripModelPrefix(judgeModel),
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Judge OpenRouter ${res.status}: ${body}`);
  }
  const data = (await res.json()) as OpenRouterResponse;
  const content = data.choices[0]?.message.content ?? "[]";

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`Judge returned invalid JSON: ${content.slice(0, 200)}`);
  }

  // The judge might return { scores: [...] } or directly an array.
  const arr: unknown = Array.isArray(parsed)
    ? parsed
    : (parsed as Record<string, unknown>).scores ?? (parsed as Record<string, unknown>).findings ?? [];

  if (!Array.isArray(arr)) {
    throw new Error(`Judge response is not an array: ${JSON.stringify(parsed).slice(0, 200)}`);
  }

  return (arr as JudgeResponseItem[]).map((item) => ({
    findingIndex: Number(item.index) - 1, // convert 1-based to 0-based
    score: Math.min(5, Math.max(1, Number(item.score))),
    reason: String(item.reason ?? ""),
  }));
}

// Precision: fraction of findings the judge rated >= 3 (i.e., real issues).
export function computePrecision(scores: JudgeScore[]): number {
  if (scores.length === 0) return 1; // no findings = no false positives
  const approved = scores.filter((s) => s.score >= 3).length;
  return approved / scores.length;
}
