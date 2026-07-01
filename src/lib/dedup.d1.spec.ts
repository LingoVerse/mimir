import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import { createStore } from "./dedup.d1.ts";

// Runs inside workerd against a local miniflare D1 (see vitest.config.ts). The
// store resolves its binding via DI, so we pass env.DB directly (no Flue context).
const DB = env.DB;

// Same schema as migrations/0001_init.sql (single-line for a simple setup loop).
const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, claimed_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS pr_summaries (pr_key TEXT PRIMARY KEY, comment_id INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS review_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, pr_key TEXT NOT NULL, primary_model TEXT NOT NULL, primary_tokens INTEGER NOT NULL, primary_cost_usd REAL NOT NULL, escalation_model TEXT, escalation_tokens INTEGER, escalation_cost_usd REAL, file_count INTEGER NOT NULL, changed_lines INTEGER NOT NULL, truncated INTEGER NOT NULL DEFAULT 0, security_sensitive INTEGER NOT NULL DEFAULT 0, escalated INTEGER NOT NULL DEFAULT 0, escalation_reasons TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS review_findings (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, file TEXT NOT NULL, line INTEGER, severity TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, suggestion TEXT, created_at INTEGER NOT NULL)",
];

beforeEach(async () => {
  for (const stmt of SCHEMA) await DB.prepare(stmt).run();
  for (const t of ["deliveries", "pr_summaries", "review_findings", "review_runs"]) {
    await DB.prepare(`DELETE FROM ${t}`).run();
  }
});

const store = () => createStore(DB);

test("claim is idempotent: first wins, replay rejected, distinct id ok", async () => {
  const s = store();
  expect(await s.claim("d1")).toBe(true);
  expect(await s.claim("d1")).toBe(false);
  expect(await s.claim("d2")).toBe(true);
});

test("release makes a claimed id re-claimable", async () => {
  const s = store();
  expect(await s.claim("r1")).toBe(true);
  await s.release("r1");
  expect(await s.claim("r1")).toBe(true);
});

test("summary comment id: absent → set → update", async () => {
  const s = store();
  expect(await s.getSummaryCommentId("o/r#1")).toBeUndefined();
  await s.setSummaryCommentId("o/r#1", 111);
  expect(await s.getSummaryCommentId("o/r#1")).toBe(111);
  await s.setSummaryCommentId("o/r#1", 222);
  expect(await s.getSummaryCommentId("o/r#1")).toBe(222);
});

test("logReviewRun returns an id, stores findings; getStats aggregates", async () => {
  const s = store();
  const runId = await s.logReviewRun(
    {
      prKey: "o/r#1",
      primaryModel: "m",
      primaryTokens: 10,
      primaryCostUsd: 0.5,
      escalationModel: null,
      escalationTokens: null,
      escalationCostUsd: null,
      fileCount: 1,
      changedLines: 5,
      truncated: 0,
      securitySensitive: 0,
      escalated: 0,
      escalationReasons: "",
    },
    [
      { file: "a.ts", line: 3, severity: "critical", title: "t", body: "b", suggestion: "s" },
      {
        file: "b.ts",
        line: undefined,
        severity: "minor",
        title: "t2",
        body: "b2",
        suggestion: undefined,
      },
    ],
  );
  expect(runId).toBeGreaterThan(0);

  const findings = await s.getRunFindings(runId);
  expect(findings.length).toBe(2);
  expect(findings[0]?.line).toBe(3);
  expect(findings[1]?.line).toBeNull();
  expect(findings[1]?.suggestion).toBeNull();

  const stats = await s.getStats();
  expect(stats.totalRuns).toBe(1);
  expect(stats.totalCost).toBeCloseTo(0.5);
});

test("logReviewRun without findings stores the run only", async () => {
  const s = store();
  const runId = await s.logReviewRun({
    prKey: "o/r#2",
    primaryModel: "m",
    primaryTokens: 5,
    primaryCostUsd: 0.1,
    escalationModel: null,
    escalationTokens: null,
    escalationCostUsd: null,
    fileCount: 1,
    changedLines: 2,
    truncated: 0,
    securitySensitive: 0,
    escalated: 0,
    escalationReasons: "",
  });
  expect(runId).toBeGreaterThan(0);
  expect(await s.getRunFindings(runId)).toEqual([]);
});
