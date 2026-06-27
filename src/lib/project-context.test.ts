import assert from "node:assert/strict";
import { test } from "node:test";
import { buildContextBlock } from "./project-context.ts";

test("empty input yields empty block", () => {
  assert.equal(buildContextBlock([]), "");
});

test("concatenates files with path headers", () => {
  const out = buildContextBlock([
    { path: "CLAUDE.md", text: "use repos" },
    { path: "AGENTS.md", text: "no any" },
  ]);
  assert.match(out, /### CLAUDE\.md\nuse repos/);
  assert.match(out, /### AGENTS\.md\nno any/);
});

test("stops adding files once the total budget is exceeded", () => {
  const big = "x".repeat(5000);
  const out = buildContextBlock(
    [
      { path: "a.md", text: big },
      { path: "b.md", text: big },
      { path: "c.md", text: big },
    ],
    8000,
  );
  assert.match(out, /### a\.md/);
  assert.doesNotMatch(out, /### c\.md/); // dropped once over budget
});
