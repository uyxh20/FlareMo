import assert from "node:assert/strict";
import test from "node:test";
import {
  conflictReportMarkdown,
  updateApplyOutcome,
  updatePullRequest,
} from "./prepare-flaremo-update.mjs";

test("clean apply does not fail the daily job", () => {
  assert.deepEqual(
    updateApplyOutcome({ applyExitCode: 0, unmergedFiles: [] }),
    { kind: "clean", failJob: false, files: [] },
  );
});

test("known three-way conflicts stay a review PR, not a red job", () => {
  const outcome = updateApplyOutcome({
    applyExitCode: 1,
    unmergedFiles: [
      "tests/e2e/space-flow.spec.ts",
      "tests/e2e/memo-flow.spec.ts",
      "apps/worker/src/auth.ts",
    ],
  });
  assert.equal(outcome.kind, "conflicts");
  assert.equal(outcome.failJob, false);
  assert.deepEqual(outcome.files, [
    "apps/worker/src/auth.ts",
    "tests/e2e/memo-flow.spec.ts",
    "tests/e2e/space-flow.spec.ts",
  ]);
});

test("apply failure with no unmerged files still fails the job", () => {
  assert.deepEqual(
    updateApplyOutcome({ applyExitCode: 1, unmergedFiles: [] }),
    {
      kind: "failed",
      failJob: true,
      files: [],
    },
  );
});

test("conflict report keeps fork changes visible", () => {
  const markdown = conflictReportMarkdown({
    currentVersion: "0.20.1",
    targetVersion: "v0.22.0",
    files: ["tests/e2e/memo-flow.spec.ts", "tests/e2e/space-flow.spec.ts"],
  });
  assert.match(markdown, /v0\.20\.1/);
  assert.match(markdown, /v0\.22\.0/);
  assert.match(markdown, /tests\/e2e\/memo-flow\.spec\.ts/);
  assert.match(markdown, /Both sides are kept/);
});

test("conflict PR title tells reviewers not to merge yet", () => {
  const pr = updatePullRequest({
    currentVersion: "0.20.1",
    targetVersion: "v0.22.0",
    files: ["tests/e2e/memo-flow.spec.ts"],
  });
  assert.match(pr.title, /do not merge yet/);
  assert.match(pr.body, /tests\/e2e\/memo-flow\.spec\.ts/);
  const clean = updatePullRequest({
    currentVersion: "0.20.1",
    targetVersion: "v0.22.0",
    files: [],
  });
  assert.equal(clean.title, "Update FlareMo to v0.22.0");
  assert.match(clean.body, /pnpm deploy:ci/);
  assert.match(clean.body, /RESEND_API_KEY/);
});
