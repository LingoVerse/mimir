import assert from "node:assert/strict";
import { test } from "node:test";
import {
  existingFindingFingerprints,
  fetchExistingReviewDiscussion,
  findingFingerprint,
  findingMarker,
  renderExistingReviewDiscussion,
} from "./pr-discussion.ts";

test("findingFingerprint normalizes title whitespace and case", () => {
  assert.equal(
    findingFingerprint({ file: "src/a.ts", line: 12, title: "  Leaks   Secret " }),
    "src/a.ts:12:leaks secret",
  );
});

test("fetchExistingReviewDiscussion parses findings, summaries, and replies", async () => {
  const finding = { file: "src/a.ts", line: 12, title: "Leaks secret" };
  const fakeClient = {
    rest: {
      pulls: {
        listReviewComments: async () => ({
          data: [
            {
              id: 1,
              path: "src/a.ts",
              line: 12,
              body: `${findingMarker(finding)}\n**[major] Leaks secret**\n\nbody`,
              user: { login: "mimir[bot]", type: "Bot" },
            },
            {
              id: 2,
              in_reply_to_id: 1,
              body: "not doing this now",
              user: { login: "maintainer", type: "User" },
            },
          ],
        }),
      },
      issues: {
        listComments: async () => ({
          data: [{ body: "<!-- mimir-summary -->\n## Mimir review" }, { body: "other" }],
        }),
      },
    },
  } as never;

  const context = await fetchExistingReviewDiscussion(fakeClient, {
    owner: "o",
    repo: "r",
    number: 1,
  });
  assert.equal(context.summaries.length, 1);
  assert.equal(context.findings.length, 1);
  assert.equal(context.findings[0]!.fingerprint, findingFingerprint(finding));
  assert.equal(context.findings[0]!.answered, true);
  assert.deepEqual([...existingFindingFingerprints(context)], [findingFingerprint(finding)]);

  const rendered = renderExistingReviewDiscussion(context);
  assert.match(rendered ?? "", /already discussed/);
  assert.match(rendered ?? "", /UNTRUSTED user-supplied data/);
  assert.match(rendered ?? "", /UNTRUSTED EXISTING PR DISCUSSION START/);
  assert.match(rendered ?? "", /END UNTRUSTED EXISTING PR DISCUSSION/);
  assert.match(rendered ?? "", /answered\/context/);
  assert.match(rendered ?? "", /not doing this now/);
});

test("fetchExistingReviewDiscussion ignores unmarked comments from humans and other bots", async () => {
  const fakeClient = {
    rest: {
      pulls: {
        listReviewComments: async () => ({
          data: [
            {
              id: 1,
              path: "src/a.ts",
              line: 12,
              body: "**[major] Looks like Mimir**\n\nbody",
              user: { login: "maintainer", type: "User" },
            },
            {
              id: 2,
              path: "src/b.ts",
              line: 3,
              body: "**[major] Other bot finding**\n\nbody",
              user: { login: "other[bot]", type: "Bot" },
            },
            {
              id: 3,
              path: "src/c.ts",
              line: 4,
              body: "**[major] Legacy Mimir finding**\n\nbody",
              user: { login: "mimir[bot]", type: "Bot" },
            },
          ],
        }),
      },
      issues: { listComments: async () => ({ data: [] }) },
    },
  } as never;

  const context = await fetchExistingReviewDiscussion(fakeClient, {
    owner: "o",
    repo: "r",
    number: 1,
  });

  assert.deepEqual(
    context.findings.map((finding) => finding.title),
    ["Legacy Mimir finding"],
  );
});
