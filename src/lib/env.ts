import * as v from "valibot";

// Startup env validation. Required secrets must be present; optional knobs are
// format-checked when set. Call once at boot (from the channel module, which
// Flue loads at server start) so the app fails fast with a clear message rather
// than crashing later on an undefined secret.

const required = (name: string) =>
  v.pipe(v.string(`${name} is required`), v.minLength(1, `${name} must not be empty`));

const wholeNumber = (name: string) =>
  v.optional(v.pipe(v.string(), v.regex(/^\d+$/, `${name} must be a whole number`)));

const EnvSchema = v.object({
  // Required
  OPENROUTER_API_KEY: required("OPENROUTER_API_KEY"),
  GITHUB_WEBHOOK_SECRET: required("GITHUB_WEBHOOK_SECRET"),
  GITHUB_TOKEN: required("GITHUB_TOKEN"),
  // Optional (have in-code defaults) — validated only when present
  MODEL_PRIMARY: v.optional(v.string()),
  MODEL_ESCALATION: v.optional(v.string()),
  ESCALATION_DIFF_THRESHOLD: wholeNumber("ESCALATION_DIFF_THRESHOLD"),
  DIFF_MAX_TOKENS: wholeNumber("DIFF_MAX_TOKENS"),
  REPO_TOOL_CALL_BUDGET: wholeNumber("REPO_TOOL_CALL_BUDGET"),
  POST_NITS: v.optional(v.picklist(["true", "false"], 'POST_NITS must be "true" or "false"')),
  ESCALATE_SECURITY_ALWAYS: v.optional(
    v.picklist(["true", "false"], 'ESCALATE_SECURITY_ALWAYS must be "true" or "false"'),
  ),
  SKIP_LABELS: v.optional(v.string()),
  DATABASE_URL: v.optional(v.string()),
  INTERNAL_BASE_URL: v.optional(v.pipe(v.string(), v.url("INTERNAL_BASE_URL must be a URL"))),
  OPENROUTER_REFERER: v.optional(v.string()),
  MIMIR_HANDLE: v.optional(v.string()),
});

export type Env = v.InferOutput<typeof EnvSchema>;

export function validateEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = v.safeParse(EnvSchema, source, { abortPipeEarly: true });
  if (result.success) return result.output;

  const lines = result.issues.map((issue) => {
    const key = issue.path?.[0]?.key ?? "(env)";
    return `  - ${String(key)}: ${issue.message}`;
  });
  throw new Error(
    `Invalid environment — fix these before starting Mimir:\n${lines.join("\n")}\n\nSee .env.example and DEPLOY.md.`,
  );
}
