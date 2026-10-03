import assert from "node:assert/strict";
import test from "node:test";
import {
  assertReleaseTag,
  classifyPath,
  PROTECTED_PATH_SET,
  renderPullRequestBody,
  shouldOpenPullRequest,
  summarizeDecisions,
} from "./take-upstream-files.mjs";

test("protects auth, reset tests, deploy workflow, and README files", () => {
  assert.equal(PROTECTED_PATH_SET.has("apps/worker/src/auth.ts"), true);
  assert.equal(
    PROTECTED_PATH_SET.has("apps/worker/src/api/registration-email.test.ts"),
    true,
  );
  assert.equal(
    PROTECTED_PATH_SET.has(".github/workflows/deploy-cloudflare.yml"),
    true,
  );
  assert.equal(PROTECTED_PATH_SET.has("README.md"), true);
  assert.equal(
    PROTECTED_PATH_SET.has(".github/workflows/flaremo-update.yml"),
    true,
  );
  assert.equal(
    PROTECTED_PATH_SET.has("scripts/run-weekly-upstream-take.mjs"),
    true,
  );
});

test("takes an upstream file the fork never changed", () => {
  const decision = classifyPath({
    path: "apps/web/src/components/image-lightbox.tsx",
    ours: "old",
    base: "old",
    theirs: "new",
  });
  assert.equal(decision.action, "take");
});

test("takes a file that exists only on upstream", () => {
  const decision = classifyPath({
    path: "tests/e2e/workspace-helpers.ts",
    ours: null,
    base: null,
    theirs: "helpers",
  });
  assert.equal(decision.action, "take");
});

test("deletes a file upstream removed when the fork never touched it", () => {
  const decision = classifyPath({
    path: "obsolete.ts",
    ours: "same",
    base: "same",
    theirs: null,
  });
  assert.equal(decision.action, "take-delete");
});

test("leaves protected diffs untouched even when upstream differs", () => {
  const decision = classifyPath({
    path: "apps/worker/src/auth.ts",
    ours: "resend hook",
    base: "no hook",
    theirs: "upstream auth",
  });
  assert.equal(decision.action, "protected");
});

test("lists a 3-way conflict and does not take the file", () => {
  const decision = classifyPath({
    path: "apps/web/src/foo.ts",
    ours: "fork",
    base: "base",
    theirs: "upstream",
    threeWay: { clean: false, result: null },
  });
  assert.equal(decision.action, "conflict");
});

test("does not take a clean 3-way that would drop fork-only hunks", () => {
  const decision = classifyPath({
    path: "docs/deploy.md",
    ours: "fork+base",
    base: "base",
    theirs: "upstream+base",
    threeWay: { clean: true, result: "merged hybrid" },
  });
  assert.equal(decision.action, "fork-only");
});

test("takes when a clean 3-way equals the upstream file", () => {
  const decision = classifyPath({
    path: "apps/web/src/lib/time-horizon.ts",
    ours: "base plus already-upstream",
    base: "base",
    theirs: "upstream",
    threeWay: { clean: true, result: "upstream" },
  });
  assert.equal(decision.action, "take");
});

test("opens a PR only when at least one file can be taken", () => {
  const empty = summarizeDecisions([
    {
      path: "apps/worker/src/auth.ts",
      action: "protected",
      reason: "protected",
    },
    { path: "conflict.ts", action: "conflict", reason: "conflict" },
  ]);
  assert.equal(shouldOpenPullRequest(empty), false);

  const ready = summarizeDecisions([
    { path: "a.ts", action: "take", reason: "take" },
  ]);
  assert.equal(shouldOpenPullRequest(ready), true);
});

test("PR body lists skipped sets and never claims a merge", () => {
  const body = renderPullRequestBody({
    targetVersion: "v0.22.0",
    currentVersion: "0.20.1",
    summary: {
      taken: ["apps/web/src/components/image-lightbox.tsx"],
      deleted: [],
      protectedDiffs: ["apps/worker/src/auth.ts"],
      conflicts: ["README.md"],
      forkOnly: ["docs/deploy.md"],
    },
  });
  assert.match(body, /does \*\*not\*\* merge this pull request/);
  assert.match(body, /image-lightbox/);
  assert.match(body, /apps\/worker\/src\/auth\.ts/);
  assert.doesNotMatch(body, /three-way apply/);
});

test("rejects a non-release tag", () => {
  assert.throws(() => assertReleaseTag("main"), /Invalid FlareMo release tag/);
  assert.equal(assertReleaseTag("v0.22.0"), "v0.22.0");
});
