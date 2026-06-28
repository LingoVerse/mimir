// LLM-as-judge scorer. Rates all findings for a fixture in a single API call
// to minimize cost. Uses the same OpenRouter API as the eval runner.

import type { ReviewResult } from "../src/lib/review.ts";
import type { EvalFixture, JudgeScore } from "./types.ts";

function stripModelPrefix(model: string): string {
  return model.replace(/^openrouter\//, "");
}

function fetchWithTimeout(url: string, options: RequestInit, timeoutMs = 120_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
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
    'Output JSON only: { "scores": [{ "index": 1, "score": N, "reason": "one sentence" }, ...] }',
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
  const res = await fetchWithTimeout("https://openrouter.ai/api/v1/chat/completions", {
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
  const content = data.choices?.[0]?.message.content ?? "{}";

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`Judge returned invalid JSON: ${content.slice(0, 200)}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Judge response is not an object: ${JSON.stringify(parsed).slice(0, 200)}`);
  }
  const arr = (parsed as Record<string, unknown>).scores;
  if (!Array.isArray(arr)) {
    throw new Error(`Judge response missing "scores" array: ${JSON.stringify(parsed).slice(0, 200)}`);
  }

  return (arr as unknown[])
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item))
    .map((item) => {
      const idx = Number(item["index"]);
      const sc = Number(item["score"]);
      return {
        findingIndex: Number.isNaN(idx) ? -1 : idx - 1, // convert 1-based to 0-based
        score: Number.isNaN(sc) ? 1 : Math.min(5, Math.max(1, sc)),
        reason: String(item["reason"] ?? ""),
      };
    })
    .filter((item) => item.findingIndex >= 0);
}

// Precision: judge-approved findings (score >= 3) divided by TOTAL findings
// generated — not just those the judge returned scores for. LLMs sometimes omit
// items silently; using the actual finding count prevents that from inflating precision.
export function computePrecision(scores: JudgeScore[], totalFindings: number): number {
  if (totalFindings === 0) return 1; // no findings = no false positives
  const approved = scores.filter((s) => s.score >= 3).length;
  return approved / totalFindings;
}
