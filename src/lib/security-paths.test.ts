import assert from "node:assert/strict";
import { test } from "node:test";
import { isSecuritySensitivePath, touchesSensitivePath } from "./security-paths.ts";

test("isSecuritySensitivePath flags sensitive surfaces", () => {
  for (const p of [
    "src/auth/login.ts",
    "services/payments/charge.go",
    "lib/crypto/hash.ts",
    "db/migrations/001_init.sql",
    "schema.sql",
    "package.json",
    ".github/workflows/ci.yml",
    "infra/main.tf",
    "Dockerfile",
    "ops/app.dockerfile",
  ]) {
    assert.equal(isSecuritySensitivePath(p), true, p);
  }

  for (const p of ["src/index.ts", "README.md", "components/Button.tsx", "docs/guide.md"]) {
    assert.equal(isSecuritySensitivePath(p), false, p);
  }
});

test("touchesSensitivePath scans a file list", () => {
  assert.equal(touchesSensitivePath(["src/a.ts", "src/b.ts"]), false);
  assert.equal(touchesSensitivePath(["src/a.ts", "src/auth.ts"]), true);
});
