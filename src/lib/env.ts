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
  // GitHub auth: EITHER a personal access token (GITHUB_TOKEN) OR a GitHub App
  // (GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY + GITHUB_APP_INSTALLATION_ID). The
  // App path authors comments as "<AppName>[bot]". Enforced in validateEnv below.
  GITHUB_TOKEN: v.optional(v.string()),
  GITHUB_APP_ID: wholeNumber("GITHUB_APP_ID"),
  GITHUB_APP_PRIVATE_KEY: v.optional(v.string()),
  GITHUB_APP_INSTALLATION_ID: wholeNumber("GITHUB_APP_INSTALLATION_ID"),
  // Optional (have in-code defaults) — validated only when present
  MODEL_PRIMARY: v.optional(v.string()),
  MODEL_ESCALATION: v.optional(v.string()),
  ESCALATION_DIFF_THRESHOLD: wholeNumber("ESCALATION_DIFF_THRESHOLD"),
  DIFF_MAX_TOKENS: wholeNumber("DIFF_MAX_TOKENS"),
  REPO_TOOL_CALL_BUDGET: wholeNumber("REPO_TOOL_CALL_BUDGET"),
  REPO_TOOL_CALL_BUDGET_MAX: wholeNumber("REPO_TOOL_CALL_BUDGET_MAX"),
  POST_NITS: v.optional(v.picklist(["true", "false"], 'POST_NITS must be "true" or "false"')),
  ESCALATE_SECURITY_ALWAYS: v.optional(
    v.picklist(["true", "false"], 'ESCALATE_SECURITY_ALWAYS must be "true" or "false"'),
  ),
  SKIP_LABELS: v.optional(v.string()),
  DATABASE_URL: v.optional(v.string()),
  OPENROUTER_REFERER: v.optional(v.string()),
  MIMIR_HANDLE: v.optional(v.string()),
  // Optional gate for GET /admin. When set, the endpoint requires
  // `Authorization: Bearer <token>`; unset leaves it open (Docker default).
  ADMIN_TOKEN: v.optional(v.string()),
});

export type Env = v.InferOutput<typeof EnvSchema>;

export function validateEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = v.safeParse(EnvSchema, source, { abortPipeEarly: true });
  if (!result.success) {
    const lines = result.issues.map((issue) => {
      const key = issue.path?.[0]?.key ?? "(env)";
      return `  - ${String(key)}: ${issue.message}`;
    });
    throw new Error(
      `Invalid environment — fix these before starting Mimir:\n${lines.join("\n")}\n\nSee .env.example and DEPLOY.md.`,
    );
  }

  // GitHub auth must be exactly one of: a PAT, or the full GitHub App trio.
  const env = result.output;
  const hasPat = Boolean(env.GITHUB_TOKEN);
  const hasApp = Boolean(
    env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY && env.GITHUB_APP_INSTALLATION_ID,
  );
  if (!hasPat && !hasApp) {
    throw new Error(
      "Invalid environment — GitHub auth not configured: set GITHUB_TOKEN (personal access " +
        "token), or all of GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY + GITHUB_APP_INSTALLATION_ID " +
        "(GitHub App).\n\nSee DEPLOY.md.",
    );
  }
  return env;
}
