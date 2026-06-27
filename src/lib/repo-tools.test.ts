import assert from "node:assert/strict";
import { test } from "node:test";
import { isSafeRepoPath, repoContextTools } from "./repo-tools.ts";

test("isSafeRepoPath rejects absolute paths and traversal", () => {
  for (const ok of ["src/index.ts", "a/b/c.ts", "README.md", ""]) {
    assert.equal(isSafeRepoPath(ok), true, ok);
  }
  for (const bad of ["/etc/passwd", "../secret", "a/../../b", "../../x"]) {
    assert.equal(isSafeRepoPath(bad), false, bad);
  }
});

test("repoContextTools returns the three read-only tools", () => {
  // octokit client is unused until a tool executes; identity is enough here.
  const tools = repoContextTools({} as never, { owner: "o", repo: "r", ref: "sha" });
  assert.deepEqual(
    tools.map((t) => t.name),
    ["read_repo_file", "list_repo_dir", "search_repo"],
  );
});

function makeClient(handler: () => unknown) {
  return {
    rest: {
      repos: { getContent: async () => handler() },
      search: { code: async () => handler() },
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
  await listDir.execute({ path: "" });
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
    await listDir.execute({ path: "" });
    await listDir.execute({ path: "" });
    const result = await listDir.execute({ path: "" });
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
    await listDir.execute({ path: "" });
    const result = await searchTool.execute({ query: "foo" });
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
    await primaryListDir.execute({ path: "" });
    const primaryBlocked = await primaryListDir.execute({ path: "" });
    assert.match(primaryBlocked, /budget exhausted/);
    // Escalation still has its full budget — not affected by the primary pass.
    const escalationResult = await escalationListDir.execute({ path: "" });
    assert.doesNotMatch(escalationResult, /budget exhausted/);
    assert.equal(hits, 2);
  } finally {
    if (originalBudget === undefined) delete process.env.REPO_TOOL_CALL_BUDGET;
    else process.env.REPO_TOOL_CALL_BUDGET = originalBudget;
  }
});
