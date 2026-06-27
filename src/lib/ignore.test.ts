import assert from "node:assert/strict";
import { test } from "node:test";
import { makeIgnoreMatcher, parseIgnore } from "./ignore.ts";

test("parseIgnore drops blanks, comments, and negations", () => {
  const text = ["# comment", "", "  ", "*_snapshot.json", "!keep.json", "  dist/  "].join("\n");
  assert.deepEqual(parseIgnore(text), ["*_snapshot.json", "dist/"]);
});

test("basename glob matches at any depth", () => {
  const match = makeIgnoreMatcher(["*_snapshot.json"]);
  assert.equal(match("packages/database/migrations/meta/0015_snapshot.json"), true);
  assert.equal(match("0015_snapshot.json"), true);
  assert.equal(match("src/snapshot.ts"), false);
});

test("directory pattern matches everything under it", () => {
  const match = makeIgnoreMatcher(["**/migrations/meta/"]);
  assert.equal(match("packages/database/migrations/meta/0015_snapshot.json"), true);
  assert.equal(match("packages/database/migrations/meta/_journal.json"), true);
  assert.equal(match("packages/database/migrations/0001.sql"), false);
});

test("rooted path anchors to repo root", () => {
  const match = makeIgnoreMatcher(["packages/database/migrations/meta/"]);
  assert.equal(match("packages/database/migrations/meta/0015_snapshot.json"), true);
  assert.equal(match("other/packages/database/migrations/meta/x.json"), false);
});

test("single star stays within a segment", () => {
  const match = makeIgnoreMatcher(["meta/*.json"]);
  assert.equal(match("meta/0015.json"), true);
  assert.equal(match("meta/nested/0015.json"), false);
});

test("empty pattern set never matches", () => {
  const match = makeIgnoreMatcher([]);
  assert.equal(match("anything.json"), false);
});
