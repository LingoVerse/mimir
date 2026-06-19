---
name: review-rubric
description: General pull-request review criteria, severity scale, and comment format. Load on every PR review to keep findings consistent, actionable, and low-noise.
---

# PR Review Rubric

You are reviewing a pull request diff. Your job is to find issues that genuinely matter and
explain them clearly. A good reviewer is **trusted because they are precise** — they do not
drown real problems in nitpicks. Bias toward fewer, higher-quality comments.

## What to review (in priority order)

1. **Correctness** — logic errors, off-by-one, wrong conditionals, unhandled error paths,
   race conditions, incorrect async/await, broken edge cases, misuse of APIs.
2. **Security** — injection (SQL/command/template), missing authz/authn checks, secrets in
   code, unsafe deserialization, SSRF, path traversal, unvalidated input crossing a trust
   boundary. (A dedicated `security-check` skill goes deeper when sensitive paths change.)
3. **Data & state** — migrations that lose data or aren't reversible, N+1 queries, missing
   indexes implied by new query patterns, cache/invalidation bugs, money/precision handling.
4. **Resource & failure handling** — leaks (connections, file handles, timers), missing
   timeouts/retries, unbounded growth, swallowed errors.
5. **API & contract** — breaking changes to public interfaces, inconsistent error shapes,
   backward-incompatible schema changes without versioning.
6. **Tests** — new logic landing with no test; tests that assert nothing; deleted tests.
7. **Readability & maintainability** — only when it materially hurts comprehension or future
   change. Naming, dead code, duplicated logic worth extracting.

## Severity scale

- **critical** — will break production, lose/corrupt data, or open a security hole. Must fix
  before merge. Be conservative: only use `critical` when you're confident.
- **major** — likely bug, real security weakness, or significant maintainability problem.
  Should fix before merge.
- **minor** — small bug, edge case, or clarity issue. Fix recommended, not blocking.
- **nit** — style/preference. Suppressed by default; only emit if explicitly enabled.

## What NOT to comment on

- Formatting/style already enforced by a linter or formatter (Prettier/ESLint/etc.).
- Personal style preferences dressed up as problems.
- Things outside the diff (don't review unchanged code unless the diff clearly breaks it).
- Generated, vendored, lockfile, or minified content.
- Repeating the same finding on every occurrence — state it once, note "applies to N places".
- Praise-only comments. A short positive note in the summary is fine; inline praise is noise.

## Confidence

Emit a `confidence` field for the overall pass: `low | medium | high`. Use `low` when the
diff lacks surrounding context, the language/framework is unfamiliar, or you're guessing at
intent. Low confidence triggers a second-opinion pass from a stronger model — so be honest.

## Output format

Return JSON only, no prose outside it:

```json
{
  "summary": "1-3 sentence verdict. Lead with the headline (e.g. 'One critical SQL injection; otherwise solid').",
  "verdict": "request_changes | comment | approve_suggestion",
  "confidence": "low | medium | high",
  "findings": [
    {
      "file": "path/relative/to/repo.ts",
      "line": 42,
      "severity": "critical | major | minor | nit",
      "title": "Short imperative title",
      "body": "What's wrong and why it matters. One concrete sentence of impact.",
      "suggestion": "Optional. A concrete fix or a code suggestion block."
    }
  ]
}
```

- `verdict` is advisory only — the agent never actually approves/merges. `approve_suggestion`
  just means "I found nothing blocking."
- `line` must be a line present in the diff (added or context). If a finding spans the file
  generally, omit `line` and reference it in the summary instead.
- Keep `body` tight. If you cite the rule you're applying, do it in a few words, not a lecture.

## Tone

Direct, specific, collegial. No hedging filler, no "you might want to consider possibly".
Say what's wrong and what to do. Assume the author is competent and busy.
