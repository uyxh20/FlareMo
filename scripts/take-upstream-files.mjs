#!/usr/bin/env node

// Deterministic weekly upstream file take.
//
// This is not a 1:1 merge and it never writes a hybrid hunk. A path is taken
// only when the entire upstream file can replace the fork file without
// dropping unique fork content:
//   - fork file equals the merge-base (upstream moved, fork did not), or
//   - a 3-way merge is clean AND the result equals the upstream file.
// Protected paths, 3-way conflicts, and fork-only diffs stay untouched.

export const UPSTREAM_REPOSITORY = "realchendahuang/FlareMo";

/** Exact paths the weekly job must never overwrite. */
export const PROTECTED_PATHS = Object.freeze([
  "apps/worker/src/auth.ts",
  "apps/worker/src/routes/auth-api.ts",
  "apps/worker/src/api/registration-email.test.ts",
  "apps/worker/src/email-templates.test.ts",
  "apps/worker/src/email.ts",
  "apps/web/src/pages/forgot-password-page.tsx",
  "apps/web/src/pages/reset-page.tsx",
  "apps/web/src/api/auth.ts",
  ".github/workflows/deploy-cloudflare.yml",
  ".github/workflows/flaremo-update.yml",
  "scripts/take-upstream-files.mjs",
  "scripts/take-upstream-files.test.mjs",
  "scripts/run-weekly-upstream-take.mjs",
  "README.md",
  "README.en.md",
  "README.zh-CN.md",
  "docs/update.md",
  "docs/en/update.md",
]);

export const PROTECTED_PATH_SET = new Set(PROTECTED_PATHS);

/**
 * Decide what to do with one path.
 *
 * `ours` / `base` / `theirs` are file contents or `null` when the path is
 * absent on that side. `threeWay` is only consulted when both sides changed.
 *
 * @param {{
 *   path: string,
 *   ours: string | null,
 *   base: string | null,
 *   theirs: string | null,
 *   threeWay?: { clean: boolean, result: string | null },
 * }} input
 * @returns {{
 *   path: string,
 *   action: "identical" | "protected" | "take" | "take-delete" | "fork-only" | "conflict",
 *   reason: string,
 * }}
 */
export function classifyPath(input) {
  const { path, ours, base, theirs, threeWay } = input;
  if (PROTECTED_PATH_SET.has(path)) {
    if (ours === theirs) {
      return { path, action: "identical", reason: "protected and identical" };
    }
    return {
      path,
      action: "protected",
      reason: "protected set; left untouched",
    };
  }
  if (ours === theirs) {
    return {
      path,
      action: "identical",
      reason: "fork already matches upstream",
    };
  }
  if (ours === base && theirs !== null) {
    return {
      path,
      action: "take",
      reason: "fork matches merge-base; taking upstream file",
    };
  }
  if (ours === base && theirs === null) {
    return {
      path,
      action: "take-delete",
      reason: "upstream deleted a file the fork never changed",
    };
  }
  if (theirs === base) {
    return {
      path,
      action: "fork-only",
      reason: "only the fork changed this path",
    };
  }
  // Both sides changed relative to the merge-base.
  if (!threeWay) {
    return {
      path,
      action: "conflict",
      reason: "both sides changed; 3-way result unavailable",
    };
  }
  if (!threeWay.clean) {
    return {
      path,
      action: "conflict",
      reason: "both sides changed and the 3-way merge conflicts",
    };
  }
  if (threeWay.result === theirs) {
    return {
      path,
      action: "take",
      reason: "3-way is clean and equals the upstream file",
    };
  }
  return {
    path,
    action: "fork-only",
    reason: "3-way is clean but taking upstream would drop fork-only hunks",
  };
}

export function summarizeDecisions(decisions) {
  const taken = [];
  const deleted = [];
  const protectedDiffs = [];
  const conflicts = [];
  const forkOnly = [];
  for (const decision of decisions) {
    if (decision.action === "take") taken.push(decision.path);
    else if (decision.action === "take-delete") deleted.push(decision.path);
    else if (decision.action === "protected")
      protectedDiffs.push(decision.path);
    else if (decision.action === "conflict") conflicts.push(decision.path);
    else if (decision.action === "fork-only") forkOnly.push(decision.path);
  }
  return { taken, deleted, protectedDiffs, conflicts, forkOnly };
}

export function shouldOpenPullRequest(summary) {
  return summary.taken.length > 0 || summary.deleted.length > 0;
}

export function renderPullRequestBody({
  upstreamRepository = UPSTREAM_REPOSITORY,
  targetVersion,
  currentVersion,
  summary,
}) {
  const list = (paths) =>
    paths.length === 0
      ? "_None._"
      : paths.map((path) => `- \`${path}\``).join("\n");

  return `A deterministic weekly file take from \`${upstreamRepository}\` \`${targetVersion}\` (fork reports v${currentVersion}).

This job does **not** apply a 1:1 patch from the previous release onto \`main\`, and it does **not** merge this pull request.

## Taken from upstream

Whole-file replacements (or deletions) where the fork had no unique content.

${list(summary.taken)}

## Deleted to match upstream

${list(summary.deleted)}

## Protected diffs (left untouched)

${list(summary.protectedDiffs)}

## Conflicts (left untouched)

${list(summary.conflicts)}

## Fork-only diffs (left untouched)

${list(summary.forkOnly)}

Review the taken files, then merge only if you want them. Pushing the merge to \`main\` publishes the Worker.
`;
}

export function assertReleaseTag(tag) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
    throw new Error(`Invalid FlareMo release tag: ${tag}`);
  }
  return tag;
}
