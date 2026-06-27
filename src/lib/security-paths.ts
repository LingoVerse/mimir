// Security-sensitive path detection (build-spec §5.2). Used by Phase 3 to load
// the `security-check` skill, and by Phase 4 to force escalation. Heuristic and
// deliberately conservative: a false positive only adds a deeper security pass.

const SENSITIVE_BASENAMES = new Set([
  // dependency manifests
  "package.json",
  "requirements.txt",
  "pyproject.toml",
  "go.mod",
  "cargo.toml",
  "gemfile",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "composer.json",
  // container / CI
  "dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  ".gitlab-ci.yml",
  ".travis.yml",
]);

const SENSITIVE_SUBSTRINGS = [
  "auth",
  "crypto",
  "payment",
  "password",
  "secret",
  "oauth",
  ".github/workflows/",
  ".circleci/",
  "terraform",
  "kubernetes",
];

export function isSecuritySensitivePath(path: string): boolean {
  const p = path.toLowerCase();
  const base = p.slice(p.lastIndexOf("/") + 1);

  if (SENSITIVE_BASENAMES.has(base)) return true;
  if (p.endsWith(".sql") || p.endsWith(".tf") || p.endsWith(".tfvars")) return true;
  if (base === "dockerfile" || base.endsWith(".dockerfile") || base.startsWith("dockerfile.")) {
    return true;
  }
  if (p.includes("/migrations/") || p.startsWith("migrations/")) return true;
  return SENSITIVE_SUBSTRINGS.some((s) => p.includes(s));
}

export function touchesSensitivePath(paths: Iterable<string>): boolean {
  for (const path of paths) {
    if (isSecuritySensitivePath(path)) return true;
  }
  return false;
}
