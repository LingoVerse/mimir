import assert from "node:assert/strict";
import { test } from "node:test";
import { validateEnv } from "./env.ts";

const base = { OPENROUTER_API_KEY: "k", GITHUB_WEBHOOK_SECRET: "s", GITHUB_TOKEN: "t" };

test("passes with the three required vars", () => {
  assert.doesNotThrow(() => validateEnv(base));
});

test("throws naming each missing required var", () => {
  assert.throws(
    () => validateEnv({ GITHUB_WEBHOOK_SECRET: "s", GITHUB_TOKEN: "t" }),
    /OPENROUTER_API_KEY/,
  );
  assert.throws(
    () => validateEnv({ OPENROUTER_API_KEY: "k", GITHUB_TOKEN: "t" }),
    /GITHUB_WEBHOOK_SECRET/,
  );
  assert.throws(
    () => validateEnv({ OPENROUTER_API_KEY: "k", GITHUB_WEBHOOK_SECRET: "s" }),
    /GITHUB_TOKEN/,
  );
});

test("rejects malformed optional vars", () => {
  assert.throws(() => validateEnv({ ...base, ESCALATION_DIFF_THRESHOLD: "abc" }), /whole number/);
  assert.throws(() => validateEnv({ ...base, POST_NITS: "yes" }), /POST_NITS/);
  assert.throws(
    () => validateEnv({ ...base, INTERNAL_BASE_URL: "not-a-url" }),
    /INTERNAL_BASE_URL/,
  );
});

test("accepts valid optional vars", () => {
  assert.doesNotThrow(() =>
    validateEnv({
      ...base,
      ESCALATION_DIFF_THRESHOLD: "400",
      POST_NITS: "true",
      INTERNAL_BASE_URL: "http://127.0.0.1:3000",
    }),
  );
});
