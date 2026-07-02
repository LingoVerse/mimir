import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type MemoryEntry,
  commitMemoryEntry,
  hasSkipLabel,
  hasSkipMarker,
  isMaintainer,
  isOwnerAllowed,
  memoryPath,
  parseRememberCommand,
  parseReviewCommand,
  renderEntry,
} from "./memory.ts";

test("isOwnerAllowed: unset allows all; set gates case-insensitively", () => {
  assert.equal(isOwnerAllowed("anyone", undefined), true); // unset → allow all
  assert.equal(isOwnerAllowed("anyone", ""), true); // empty → allow all
  assert.equal(isOwnerAllowed("Acme", "acme, lapa2112"), true);
  assert.equal(isOwnerAllowed("LAPA2112", " acme , lapa2112 "), true); // trims + case-insensitive
  assert.equal(isOwnerAllowed("intruder", "acme,lapa2112"), false);
});

const sampleEntry: MemoryEntry = {
  action: "create",
  slug: "legacy-data-layer",
  title: "legacy stays on the old data layer",
  scope: "src/legacy/**",
  source: "pr#42 by alice",
  confidence: "high",
  body: "Intentional until the Q3 migration.",
  reason: "cross-cutting decision",
};

test("parseRememberCommand matches both trigger forms", () => {
  assert.equal(
    parseRememberCommand("/remember legacy dir is intentional"),
    "legacy dir is intentional",
  );
  assert.equal(parseRememberCommand("@mimir remember use repos here", "mimir"), "use repos here");
  assert.equal(parseRememberCommand("please /remember X", "mimir"), "X");
  assert.equal(parseRememberCommand("hey @bot remember Y", "bot"), "Y");
});

test("parseRememberCommand ignores non-commands", () => {
  assert.equal(parseRememberCommand("I remember when this broke"), null);
  assert.equal(parseRememberCommand("/remember"), null); // no fact
  assert.equal(parseRememberCommand("just a normal comment"), null);
});

test("isMaintainer gates on association", () => {
  for (const a of ["OWNER", "MEMBER", "COLLABORATOR"]) assert.equal(isMaintainer(a), true, a);
  for (const a of ["CONTRIBUTOR", "NONE", "FIRST_TIME_CONTRIBUTOR", undefined]) {
    assert.equal(isMaintainer(a), false, String(a));
  }
});

test("hasSkipMarker detects the loop-guard markers", () => {
  assert.equal(hasSkipMarker("chore(mimir): remember X [skip review]"), true);
  assert.equal(hasSkipMarker("whatever [mimir skip]"), true);
  assert.equal(hasSkipMarker("fix: a real change"), false);
});

test("hasSkipLabel matches the default label case-insensitively", () => {
  const original = process.env.SKIP_LABELS;
  delete process.env.SKIP_LABELS;
  try {
    assert.equal(hasSkipLabel(["Mimir:Skip"]), true);
    assert.equal(hasSkipLabel(["bug", "enhancement"]), false);
    assert.equal(hasSkipLabel([]), false);
  } finally {
    if (original === undefined) delete process.env.SKIP_LABELS;
    else process.env.SKIP_LABELS = original;
  }
});

test("hasSkipLabel honors a custom SKIP_LABELS list", () => {
  const original = process.env.SKIP_LABELS;
  process.env.SKIP_LABELS = "no-review, wip";
  try {
    assert.equal(hasSkipLabel(["WIP"]), true);
    assert.equal(hasSkipLabel(["no-review"]), true);
    assert.equal(hasSkipLabel(["mimir:skip"]), false); // replaced, not appended
  } finally {
    if (original === undefined) delete process.env.SKIP_LABELS;
    else process.env.SKIP_LABELS = original;
  }
});

test("renderEntry emits frontmatter + body", () => {
  const entry: MemoryEntry = {
    action: "create",
    slug: "legacy-data-layer",
    title: "legacy/ stays on the old data layer",
    scope: "src/legacy/**",
    source: "pr#42 by alice",
    confidence: "high",
    body: "Intentional until the Q3 migration.",
    reason: "cross-cutting decision",
  };
  const md = renderEntry(entry, new Date("2026-06-20T00:00:00Z"));
  assert.match(md, /title: legacy\/ stays on the old data layer/);
  assert.match(md, /scope: src\/legacy\/\*\*/);
  assert.match(md, /created: 2026-06-20/);
  assert.match(md, /Intentional until the Q3 migration\./);
  assert.equal(memoryPath("legacy-data-layer"), ".mimir/memory/legacy-data-layer.md");
});

// Plain-object Octokit stub (see repo-tools.test.ts pattern). Captures the args
// passed to createOrUpdateFileContents for assertions.
function makeCommitClient(getContent: () => unknown): {
  client: never;
  calls: { create: Array<Record<string, unknown>> };
} {
  const calls = { create: [] as Array<Record<string, unknown>> };
  const client = {
    rest: {
      repos: {
        getContent: async () => getContent(),
        createOrUpdateFileContents: async (args: Record<string, unknown>) => {
          calls.create.push(args);
          return { data: { commit: { html_url: "https://example.test/commit/abc" } } };
        },
      },
    },
  } as never;
  return { client, calls };
}

test("commitMemoryEntry create path: new file, skip marker in message", async () => {
  const { client, calls } = makeCommitClient(() => {
    throw new Error("404 not found"); // getContent throws → treated as new file
  });
  const r = await commitMemoryEntry(
    client,
    { owner: "o", repo: "r", headRef: "feat" },
    sampleEntry,
  );
  assert.equal(r.path, ".mimir/memory/legacy-data-layer.md");
  assert.equal(r.commitUrl, "https://example.test/commit/abc");
  assert.equal(calls.create.length, 1);
  const [args] = calls.create;
  assert.equal(args?.sha, undefined);
  assert.equal(args?.branch, "feat");
  assert.match(String(args?.message), /\[skip review\]/);
});

test("commitMemoryEntry update path: forwards existing file sha", async () => {
  const { client, calls } = makeCommitClient(() => ({ data: { type: "file", sha: "abc123" } }));
  await commitMemoryEntry(client, { owner: "o", repo: "r", headRef: "feat" }, sampleEntry);
  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0]?.sha, "abc123");
});

test("maintainer gate + parseRememberCommand on a valid command", () => {
  assert.equal(isMaintainer("CONTRIBUTOR"), false);
  assert.equal(isMaintainer("OWNER"), true);
  // A maintainer issuing a valid command yields the fact.
  assert.equal(
    parseRememberCommand("/remember legacy dir is intentional"),
    "legacy dir is intentional",
  );
});

// Fork-guard predicate, tested as a unit (the channel handler can't be imported
// without loading @flue/github and process.exit-on-missing-env at module load).
function isSameRepoHead(headFullName: string | undefined, owner: string, repo: string): boolean {
  return headFullName === `${owner}/${repo}`;
}

test("fork-guard: same-repo head allowed, fork head blocked", () => {
  assert.equal(isSameRepoHead("o/r", "o", "r"), true);
  assert.equal(isSameRepoHead("forker/r", "o", "r"), false);
  assert.equal(isSameRepoHead(undefined, "o", "r"), false);
});

test("parseRememberCommand returns fact for command, null otherwise", () => {
  assert.equal(parseRememberCommand("/remember use repos here"), "use repos here");
  assert.equal(parseRememberCommand("an unrelated comment"), null);
});

test("parseReviewCommand matches both trigger forms", () => {
  assert.equal(parseReviewCommand("/review"), true);
  assert.equal(parseReviewCommand("@mimir review", "mimir"), true);
  assert.equal(parseReviewCommand("please /review this"), true);
  assert.equal(parseReviewCommand("hey @bot review", "bot"), true);
  assert.equal(parseReviewCommand("/review\nsome context"), true);
});

test("parseReviewCommand ignores non-commands", () => {
  assert.equal(parseReviewCommand("I reviewed the code"), false);
  assert.equal(parseReviewCommand("/reviewing"), false);
  assert.equal(parseReviewCommand("just a normal comment"), false);
  assert.equal(parseReviewCommand("@mimir remember something", "mimir"), false);
});
