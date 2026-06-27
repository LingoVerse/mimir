import assert from "node:assert/strict";
import { test } from "node:test";
import { type FileDiff, chunkFiles, isSkippablePath } from "./diff.ts";

test("isSkippablePath filters generated/vendored paths", () => {
  for (const p of [
    "node_modules/foo/index.js",
    "packages/app/node_modules/x.js",
    "dist/bundle.js",
    "packages/app/dist/main.js",
    "app.min.js",
    "styles.min.css",
    "package-lock.json",
    "pnpm-lock.yaml",
    "sub/dir/yarn.lock",
    "go.sum",
  ]) {
    assert.equal(isSkippablePath(p), true, p);
  }

  for (const p of [
    "src/index.ts",
    "src/distance.ts", // not a dist/ dir
    "README.md",
    "src/min.ts", // not *.min.*
    "migrations/001.sql",
  ]) {
    assert.equal(isSkippablePath(p), false, p);
  }
});

function file(filename: string, changes: number, patchLen: number): FileDiff {
  return {
    filename,
    status: "modified",
    additions: changes,
    deletions: 0,
    changes,
    patch: "x".repeat(patchLen),
  };
}

test("chunkFiles keeps everything under budget", () => {
  const files = [file("a.ts", 10, 40), file("b.ts", 5, 40)];
  const out = chunkFiles(files, 10_000);
  assert.equal(out.truncated, null);
  assert.deepEqual(
    out.files.map((f) => f.filename),
    ["a.ts", "b.ts"],
  );
});

test("chunkFiles drops least-significant files over budget, preserves order", () => {
  // ~25 tokens each (100 chars / 4). Budget 60 keeps 2 of 3.
  const files = [file("small.ts", 1, 100), file("big.ts", 99, 100), file("mid.ts", 50, 100)];
  const out = chunkFiles(files, 60);
  assert.ok(out.truncated);
  assert.equal(out.truncated?.reviewedFiles, 2);
  // Largest-change files (big, mid) are kept; returned in original order.
  assert.deepEqual(
    out.files.map((f) => f.filename),
    ["big.ts", "mid.ts"],
  );
  assert.deepEqual(out.truncated?.omitted, ["small.ts"]);
});
