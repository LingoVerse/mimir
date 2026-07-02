import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isSafeRepoPath,
  isSafeSandboxCommand,
  repoContextTools,
  resolveToolBudget,
} from "./repo-tools.ts";

test("resolveToolBudget scales with file count, floored and capped", () => {
  const fixed = process.env.REPO_TOOL_CALL_BUDGET;
  const max = process.env.REPO_TOOL_CALL_BUDGET_MAX;
  delete process.env.REPO_TOOL_CALL_BUDGET;
  delete process.env.REPO_TOOL_CALL_BUDGET_MAX;
  try {
    assert.equal(resolveToolBudget(3), 8); // floor
    assert.equal(resolveToolBudget(20), 20); // ~one read per file
    assert.equal(resolveToolBudget(100), 40); // cap
    process.env.REPO_TOOL_CALL_BUDGET_MAX = "25";
    assert.equal(resolveToolBudget(100), 25); // configurable cap
    process.env.REPO_TOOL_CALL_BUDGET = "5";
    assert.equal(resolveToolBudget(100), 5); // explicit pin overrides scaling
  } finally {
    if (fixed === undefined) delete process.env.REPO_TOOL_CALL_BUDGET;
    else process.env.REPO_TOOL_CALL_BUDGET = fixed;
    if (max === undefined) delete process.env.REPO_TOOL_CALL_BUDGET_MAX;
    else process.env.REPO_TOOL_CALL_BUDGET_MAX = max;
  }
});

test("isSafeRepoPath rejects absolute paths and traversal", () => {
  for (const ok of ["src/index.ts", "a/b/c.ts", "README.md", ""]) {
    assert.equal(isSafeRepoPath(ok), true, ok);
  }
  for (const bad of ["/etc/passwd", "../secret", "a/../../b", "../../x"]) {
    assert.equal(isSafeRepoPath(bad), false, bad);
  }
});

test("repoContextTools returns the repo context tools", () => {
  // octokit client is unused until a tool executes; identity is enough here.
  const tools = repoContextTools({} as never, { owner: "o", repo: "r", ref: "sha" });
  assert.deepEqual(
    tools.map((t) => t.name),
    ["read_repo_file", "list_repo_dir", "search_repo", "run_repo_command"],
  );
});

test("repoContextTools adds dependency_review when base ref is available", () => {
  const tools = repoContextTools({} as never, { owner: "o", repo: "r", ref: "sha" }, 0, {
    baseRef: "main",
  });
  assert.deepEqual(
    tools.map((t) => t.name),
    ["read_repo_file", "list_repo_dir", "search_repo", "run_repo_command", "dependency_review"],
  );
});

test("isSafeSandboxCommand allows simple read-only commands", () => {
  assert.equal(isSafeSandboxCommand('rg "createUser" src'), true);
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

function makeClient(handler: () => unknown, getTreeHandler?: () => unknown) {
  return {
    rest: {
      repos: { getContent: async () => handler() },
      search: { code: async () => handler() },
      git: {
        getTree: async () =>
          getTreeHandler?.() ?? { data: { tree: [{ path: "src/index.ts", type: "blob" }] } },
      },
    },
  } as never;
}

test("repoContextTools executes within budget", async () => {
  let hits = 0;
  const client = makeClient(() => {
    hits += 1;
    return { data: [] };
  });
  const [, listDir] = repoContextTools(client, { owner: "o", repo: "r", ref: "sha" });
  assert.ok(listDir);
  await listDir.run({ input: { path: "" } });
  assert.equal(hits, 1);
});

test("repoContextTools blocks calls over budget", async () => {
  let hits = 0;
  const client = makeClient(() => {
    hits += 1;
    return { data: [] };
  });
  const originalBudget = process.env.REPO_TOOL_CALL_BUDGET;
  process.env.REPO_TOOL_CALL_BUDGET = "2";
  try {
    const [, listDir] = repoContextTools(client, { owner: "o", repo: "r", ref: "sha" });
    assert.ok(listDir);
    await listDir.run({ input: { path: "" } });
    await listDir.run({ input: { path: "" } });
    const result = await listDir.run({ input: { path: "" } });
    assert.match(result, /budget exhausted/);
    assert.equal(hits, 2);
  } finally {
    if (originalBudget === undefined) delete process.env.REPO_TOOL_CALL_BUDGET;
    else process.env.REPO_TOOL_CALL_BUDGET = originalBudget;
  }
});

test("repoContextTools budget is shared across tools", async () => {
  let hits = 0;
  const client = makeClient(() => {
    hits += 1;
    return { data: [] };
  });
  const originalBudget = process.env.REPO_TOOL_CALL_BUDGET;
  process.env.REPO_TOOL_CALL_BUDGET = "1";
  try {
    const [, listDir, searchTool] = repoContextTools(client, { owner: "o", repo: "r", ref: "sha" });
    assert.ok(listDir);
    assert.ok(searchTool);
    await listDir.run({ input: { path: "" } });
    const result = await searchTool.run({ input: { query: "foo" } });
    assert.match(result, /budget exhausted/);
    assert.equal(hits, 1);
  } finally {
    if (originalBudget === undefined) delete process.env.REPO_TOOL_CALL_BUDGET;
    else process.env.REPO_TOOL_CALL_BUDGET = originalBudget;
  }
});

test("repoContextTools budget is independent per instance", async () => {
  // The escalation pass builds its own tool instance so the primary pass cannot
  // starve it of context reads (review-pr.ts). Each instance owns its budget.
  let hits = 0;
  const client = makeClient(() => {
    hits += 1;
    return { data: [] };
  });
  const originalBudget = process.env.REPO_TOOL_CALL_BUDGET;
  process.env.REPO_TOOL_CALL_BUDGET = "1";
  try {
    const [, primaryListDir] = repoContextTools(client, { owner: "o", repo: "r", ref: "sha" });
    const [, escalationListDir] = repoContextTools(client, { owner: "o", repo: "r", ref: "sha" });
    assert.ok(primaryListDir);
    assert.ok(escalationListDir);
    // Primary exhausts its own budget.
    await primaryListDir.run({ input: { path: "" } });
    const primaryBlocked = await primaryListDir.run({ input: { path: "" } });
    assert.match(primaryBlocked, /budget exhausted/);
    // Escalation still has its full budget — not affected by the primary pass.
    const escalationResult = await escalationListDir.run({ input: { path: "" } });
    assert.doesNotMatch(escalationResult, /budget exhausted/);
    assert.equal(hits, 2);
  } finally {
    if (originalBudget === undefined) delete process.env.REPO_TOOL_CALL_BUDGET;
    else process.env.REPO_TOOL_CALL_BUDGET = originalBudget;
  }
});
