import assert from "node:assert/strict";
import { test } from "node:test";
import { isSafeSandboxCommand, repoContextTools } from "./repo-tools.ts";

test("repoContextTools exposes only the sandbox for general repo context", () => {
  // octokit client is unused until a tool executes; identity is enough here.
  const tools = repoContextTools({} as never, { owner: "o", repo: "r", ref: "sha" });
  assert.deepEqual(
    tools.map((t) => t.name),
    ["run_repo_command"],
  );
});

test("repoContextTools adds dependency_review when base ref is available", () => {
  const tools = repoContextTools(
    {} as never,
    { owner: "o", repo: "r", ref: "sha" },
    {
      baseRef: "main",
    },
  );
  assert.deepEqual(
    tools.map((t) => t.name),
    ["run_repo_command", "dependency_review"],
  );
});

test("isSafeSandboxCommand allows simple read-only commands", () => {
  assert.equal(isSafeSandboxCommand('rg "createUser" src'), true);
  assert.equal(isSafeSandboxCommand("head -n 120 packages/design-system/index.tsx"), true);
  assert.equal(isSafeSandboxCommand("tail -n 80 packages/design-system/index.tsx"), true);
  assert.equal(isSafeSandboxCommand("jq . package.json"), true);
});

test("isSafeSandboxCommand rejects shell control operators", () => {
  assert.equal(isSafeSandboxCommand("rg foo; rm -rf /"), false);
  assert.equal(isSafeSandboxCommand("rg foo | wc -l"), false);
});

test("isSafeSandboxCommand rejects rg's pre-processor flags", () => {
  assert.equal(isSafeSandboxCommand("rg --pre sh foo"), false);
  assert.equal(isSafeSandboxCommand("rg --pre=sh foo"), false);
  assert.equal(isSafeSandboxCommand("rg --pre-glob='*.ts' foo"), false);
  assert.equal(isSafeSandboxCommand('rg "createUser" src'), true);
});

test("isSafeSandboxCommand rejects absolute and parent paths", () => {
  assert.equal(isSafeSandboxCommand("grep token /proc/self/environ"), false);
  assert.equal(isSafeSandboxCommand("rg token ../secrets"), false);
  assert.equal(isSafeSandboxCommand("rg token src/../secrets"), false);
  assert.equal(isSafeSandboxCommand("rg token ./src"), true);
});

test("isSafeSandboxCommand rejects find's exec/write primaries", () => {
  assert.equal(isSafeSandboxCommand("find . -exec id +"), false);
  assert.equal(isSafeSandboxCommand("find . -execdir id {} +"), false);
  assert.equal(isSafeSandboxCommand("find . -ok rm {} +"), false);
  assert.equal(isSafeSandboxCommand("find . -delete"), false);
  assert.equal(isSafeSandboxCommand("find . -fprint /tmp/out"), false);
  assert.equal(isSafeSandboxCommand("find . -fprint0 out"), false);
  assert.equal(isSafeSandboxCommand("find . -name '*.ts'"), true);
});

test("isSafeSandboxCommand treats sed as an exec-gated command, not read-only", () => {
  assert.equal(isSafeSandboxCommand("sed 's/foo/bar/' file"), false);
  const original = process.env.REPO_SANDBOX_ALLOW_EXEC;
  process.env.REPO_SANDBOX_ALLOW_EXEC = "1";
  try {
    assert.equal(isSafeSandboxCommand("sed 's/foo/bar/' file"), true);
  } finally {
    if (original === undefined) delete process.env.REPO_SANDBOX_ALLOW_EXEC;
    else process.env.REPO_SANDBOX_ALLOW_EXEC = original;
  }
});
